// REQ-137 (`#1337`) —— AC1 的**强制半场** + AC4:真 .node(生产构建脚本现编)、真 seatbelt、真策略代理
// (生产 startEgressPolicyProxy)、**Electron 内嵌 node**(= utilityProcess 的运行时),profile 由生产渲染器渲染
// (`#1334` Q1.2 的四行网络规则 + 可写集),env 由生产 sidecarEgressProxyEnv 给出。
// darwin-only;CI(ubuntu)上自报 skip,由 gate-files.tsv 按 [平台:darwin] 登记。
//
// 三臂:
//   bare        不套围栏(控制臂):探针必须读得到「通」—— 直连靶站连得上、UDP 发得出、DNS 解得开。
//               同一个判据函数对这一臂**必须判红**并点名(否则它不是闸门)。
//   fenced/up   围栏 + 代理在场:引擎形态的进程**能 listen 且外面连得进**(票面硬要求一);经 env-proxy 的 fetch
//               与裸 CONNECT 都经代理到达靶站(唯一那扇门);逃逸语料(绕代理直连 / raw-IP:443 / UDP / [::1] 其它端口
//               / DNS)逐条 EPERM 或解析失败 —— 每条自带本进程 pid 与耗时(空输出 ≠ 拦住)。
//   fenced/down 代理**关掉**之后(AC4):同一 profile 下 fetch 与 CONNECT 立刻 ECONNREFUSED 且消息点名代理地址,
//               不是挂到超时;绕代理直连仍 EPERM(不回退直连)。耗时只打印不断言(`#1300`:不许断言机器有多闲)——
//               「快」由 errno 结构上给出:ECONNREFUSED 是内核对 loopback 上没人听的端口的即时 RST,ETIMEDOUT / 探针超时才是「挂住」。
//
// 靶站是 loopback 上一个只有代理那一侧解得开的**名字**(fixture dial 把它映到 127.0.0.1:<port>):围栏里 DNS 不通,
// 名字能到达 ⇒ 流量一定是经代理汇出去的,这比「有没有报错」硬。授权函数是测试注入(只放行这一个名字),
// 生产接线(authorize = 注册表)的判据在 network-egress-proxy.test.ts。

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import * as http from "node:http"
import { createRequire } from "node:module"
import * as net from "node:net"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { buildFenceAddon } from "../../scripts/build-fence-addon"
import { startEgressPolicyProxy, type EgressLogRecord, type EgressProxyHandle } from "./network-egress-proxy"
import { renderProcessFenceProfile, resolveEngineRoots } from "./process-fence-profile"
import { sidecarEgressProxyEnv } from "./sidecar-env"

const describeDarwin = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec") ? describe : describe.skip
const require = createRequire(import.meta.url)
const fixtures = resolve(import.meta.dir, "../../test-fixtures/process-fence")
const TARGET_NAME = "ac1337-target.test"

type Step = { ok: boolean; code?: string | null; message?: string; ms: number; status?: number; body?: string; connected?: boolean; accepted?: number; sent?: boolean; address?: string; head?: string }
type DriverOut = { runtime: string; mode: string; pid: number; buildId?: string; apply?: { rc: number; error: string }; fatal?: string; listenPort?: number; steps: Record<string, Step> }
type DriverRun = { out: DriverOut; served: string; status: number | null }

describeDarwin("REQ-137 #1337 强制半场 —— 真 .node / 真 seatbelt / 真策略代理 / Electron 的 node", () => {
  let scratch = ""
  let addon = ""
  let buildId = ""
  let ws = ""
  let profileFile = ""
  let electron = ""
  let target: http.Server
  let targetPort = 0
  let proxy: EgressProxyHandle
  let proxyPort = 0
  let closedV6Port = 0
  const proxyLog: EgressLogRecord[] = []

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "ac1337-net-"))
    buildId = `ac1337-test-${Date.now()}`
    addon = buildFenceAddon({ out: join(scratch, "build", "alpha_fence.node"), buildId }).out
    ws = mkdtempSync(join(homedir(), ".ac1337-ws-"))
    const userData = join(scratch, "userData")
    const globalRoot = join(scratch, "alpha-code-state", "env", "dev")
    mkdirSync(userData, { recursive: true })
    mkdirSync(globalRoot, { recursive: true })

    target = http.createServer((req, res) => res.end(`TARGET-OK host=${req.headers.host ?? ""}`))
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r))
    targetPort = (target.address() as net.AddressInfo).port

    // 只有代理这一侧解得开的名字:授权只放行它,拨号把它映到靶站(生产 dial 是 net.connect 按名字解析)。
    proxy = await startEgressPolicyProxy({
      log: (record) => void proxyLog.push(record),
      authorize: (host, port) => host === TARGET_NAME && port === targetPort,
      dial: (host, port) => net.connect({ host: host === TARGET_NAME ? "127.0.0.1" : host, port }),
    })
    proxyPort = proxy.port

    const v6 = net.createServer()
    await new Promise<void>((r) => v6.listen(0, "::1", r))
    closedV6Port = (v6.address() as net.AddressInfo).port
    await new Promise<void>((r) => v6.close(() => r()))

    // 生产渲染的 profile:可写集 = 本测试的 ws + 真 HOME 的 XDG 形状;网络行 = Q1.2 四行,端口 = 上面这个真代理。
    profileFile = join(scratch, "fence.sb")
    writeFileSync(
      profileFile,
      renderProcessFenceProfile({
        workspaces: [ws],
        alphaGlobalRoot: globalRoot,
        userDataPath: userData,
        stateHome: userData,
        roots: resolveEngineRoots({}, homedir()),
        egressProxyPort: proxyPort,
      }),
    )
    // 不经 require("electron")(bun 的 mock.module 是进程级的,全量跑时别的文件 mock 掉的 electron 会漏进来);
    // 照 electron 包自己的做法从文件系统读 path.txt 再 join dist。
    const electronPkg = dirname(require.resolve("electron/package.json"))
    electron = join(electronPkg, "dist", readFileSync(join(electronPkg, "path.txt"), "utf8").trim())
    if (!existsSync(electron)) throw new Error(`electron binary missing at ${electron}(本次测量作废)`)
  })

  afterAll(async () => {
    try {
      await proxy?.close()
    } catch {}
    await new Promise<void>((r) => (target ? target.close(() => r()) : r()))
    for (const d of [scratch, ws]) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {}
    }
  })

  /** 起 driver;看到 `LISTENING <port>` 就从**本进程**(未被围栏)连进去,证明被围栏的监听者外面连得上。 */
  const runDriver = (mode: "bare" | "fenced", proxyPortForEnv: number): Promise<DriverRun> =>
    new Promise((resolve, reject) => {
      const child = spawn(electron, [join(fixtures, "network-driver.mjs"), addon, mode, profileFile, TARGET_NAME, String(targetPort), String(proxyPortForEnv), String(closedV6Port)], {
        cwd: ws,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...sidecarEgressProxyEnv(proxyPortForEnv) },
      })
      let stdout = ""
      let stderr = ""
      let served = ""
      let connected = false
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString()
        const m = /^LISTENING (\d+)$/m.exec(stdout)
        if (m && !connected) {
          connected = true
          const sock = net.connect(Number(m[1]), "127.0.0.1", () => sock.write("ping"))
          sock.on("data", (d: Buffer) => (served += d.toString()))
          sock.on("error", (e) => (served += `ERR ${(e as NodeJS.ErrnoException).code}`))
        }
      })
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
      const timer = setTimeout(() => {
        child.kill("SIGKILL")
        reject(new Error(`driver(${mode}) did not finish within 60s; stdout=${stdout.slice(-800)} stderr=${stderr.slice(-800)}`))
      }, 60_000)
      child.on("exit", (status) => {
        clearTimeout(timer)
        const line = stdout.trim().split("\n").filter((l) => l.startsWith("{")).at(-1)
        if (!line) return reject(new Error(`driver(${mode}) printed no JSON (status ${status}); stdout=${stdout.slice(-800)} stderr=${stderr.slice(-800)}`))
        const out = JSON.parse(line) as DriverOut
        if (out.fatal) return reject(new Error(`driver(${mode}) fatal: ${out.fatal}`))
        // 给外面那条连接一点时间把 SERVED 收完
        setTimeout(() => resolve({ out, served, status }), 100)
      })
    })

  /**
   * 判据本体(AC1 强制半场):唯一那扇门通,其余逃逸语料全部 EPERM / 解析失败。返回 ok + 可读的 detail,
   * 好让控制臂(bare)证明它会红。
   */
  const judgeEnforcement = (run: DriverRun): { ok: boolean; detail: string } => {
    const s = run.out.steps
    const problems: string[] = []
    if (!(run.out.pid > 0)) problems.push("no pid — the probe process did not report starting")
    if (!s.listen?.ok || run.served !== "SERVED:ping") problems.push(`listen/inbound: ${JSON.stringify(s.listen)} served=${JSON.stringify(run.served)}`)
    if (!(s.proxyFetch?.ok && s.proxyFetch.status === 200 && String(s.proxyFetch.body).startsWith("TARGET-OK"))) problems.push(`proxyFetch not 200 via the gate: ${JSON.stringify(s.proxyFetch)}`)
    if (!(s.proxyConnect?.ok && s.proxyConnect.status === 200)) problems.push(`raw CONNECT via the gate not 200: ${JSON.stringify(s.proxyConnect)}`)
    for (const name of ["directTcp", "rawIp443", "udp", "v6OtherPort"]) {
      const step = s[name]
      if (!step || step.ok || step.code !== "EPERM") problems.push(`${name} should be EPERM, got ${JSON.stringify(step)}`)
    }
    if (!s.dns || s.dns.ok || !s.dns.code) problems.push(`dns should fail (mDNSResponder is behind (deny network*)), got ${JSON.stringify(s.dns)}`)
    return { ok: problems.length === 0, detail: problems.join("; ") || "all probes as expected" }
  }

  const runs: Record<string, DriverRun | undefined> = {}

  test("A0 控制臂(bare):不套围栏时探针读得到「通」—— 直连靶站连得上、UDP 发得出、DNS 解得开、外面连得进监听者", async () => {
    runs.bare = await runDriver("bare", proxyPort)
    const s = runs.bare.out.steps
    expect(runs.bare.out.runtime).toMatch(/^node 24\./)
    expect(runs.bare.served).toBe("SERVED:ping")
    expect(s.directTcp).toMatchObject({ ok: true, connected: true })
    expect(s.udp).toMatchObject({ ok: true, sent: true })
    expect(s.proxyFetch).toMatchObject({ ok: true, status: 200 })
    expect(s.v6OtherPort).toMatchObject({ ok: false, code: "ECONNREFUSED" })
    console.log(`[ac1337 A0 bare] dns=${JSON.stringify(s.dns)} rawIp443=${JSON.stringify(s.rawIp443)}(观测,不判:取决于本机是否联网)`)
  })

  test("A1 围栏 + 代理在场:apply rc=0、能 listen 且外面连得进(硬要求一)、fetch 与 CONNECT 都经代理到达靶站、逃逸语料逐条 EPERM、DNS 不通", async () => {
    runs.fencedUp = await runDriver("fenced", proxyPort)
    const run = runs.fencedUp
    expect(run.out.apply).toEqual({ rc: 0, error: "" })
    expect(run.out.buildId).toBe(buildId)
    const verdict = judgeEnforcement(run)
    console.log(
      `[ac1337 A1 fenced/up] pid=${run.out.pid} ` +
        Object.entries(run.out.steps)
          .map(([k, v]) => `${k}=${v.ok ? `ok(${v.status ?? v.connected ?? v.sent ?? v.accepted ?? v.address ?? ""},${v.ms}ms)` : `${v.code}(${v.ms}ms)`}`)
          .join(" "),
    )
    expect(verdict.detail).toBe("all probes as expected")
    expect(verdict.ok).toBe(true)
    // 代理侧留下的结构化记录:两条 allow(fetch 的 CONNECT + 裸 CONNECT),目的地就是那个只有代理解得开的名字
    const allows = proxyLog.filter((r) => r.event === "egress.connect" && r.verdict === "allow" && r.host === TARGET_NAME && r.port === targetPort)
    expect(allows.length).toBeGreaterThanOrEqual(2)
  })

  test("A2 判据测得出已知的坏:同一个判据函数对 bare 臂必须判红,并点名直连连上了", () => {
    const verdict = judgeEnforcement(runs.bare!)
    expect(verdict.ok).toBe(false)
    expect(verdict.detail).toMatch(/directTcp should be EPERM/)
    expect(verdict.detail).toMatch(/udp should be EPERM/)
  })

  test("A3 AC4 代理关掉之后:fetch 与 CONNECT 立刻 ECONNREFUSED 且点名代理地址(不是挂到超时);绕代理直连仍 EPERM(不回退)", async () => {
    const deadPort = proxyPort
    await proxy.close()
    runs.fencedDown = await runDriver("fenced", deadPort)
    const s = runs.fencedDown.out.steps
    console.log(`[ac1337 A3 fenced/down] proxyFetch=${JSON.stringify(s.proxyFetch)} proxyConnect=${JSON.stringify(s.proxyConnect)} directTcp=${JSON.stringify(s.directTcp)}`)
    expect(runs.fencedDown.out.apply).toEqual({ rc: 0, error: "" })
    expect(s.proxyFetch.ok).toBe(false)
    expect(s.proxyFetch.code).toBe("ECONNREFUSED")
    expect(s.proxyFetch.message).toContain(`127.0.0.1:${deadPort}`)
    expect(s.proxyConnect.ok).toBe(false)
    expect(s.proxyConnect.code).toBe("ECONNREFUSED")
    // 「快」的结构性判据:不是探针超时、不是 ETIMEDOUT
    for (const name of ["proxyFetch", "proxyConnect"]) expect(s[name].code, name).not.toMatch(/PROBE_TIMEOUT|ETIMEDOUT/)
    expect(s.directTcp).toMatchObject({ ok: false, code: "EPERM" })
    expect(s.rawIp443).toMatchObject({ ok: false, code: "EPERM" })
    expect(s.dns.ok).toBe(false)
    // 监听不受代理死活影响(引擎照常起得来)
    expect(runs.fencedDown.served).toBe("SERVED:ping")
  })
})
