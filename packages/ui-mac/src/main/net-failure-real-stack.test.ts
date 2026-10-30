// `#1572` AC4 —— 引擎在错误被压成顶层消息之前取层,对着**真运行时**钉住:
//   · Electron 内嵌 node(= 出货 sidecar 的 utilityProcess 运行时,undici 由 http.setGlobalProxyFromEnv 接上代理);
//   · 真引擎:packages/opencode/script/build-node.ts 同一配方现打的 node bundle(出货 sidecar 的 virtual:opencode-server);
//   · 真出网代理(生产 startEgressPolicyProxy;授权 / 拨号为测试注入,只认本文件的几个名字),env 由生产 sidecarEgressProxyEnv 给出;
//   · 真 webfetch 入口:一个本机 OpenAI 兼容替身让模型一次调用五个 webfetch,引擎照常执行、照常结算、照常落库,
//     本文件再经引擎 HTTP API 读回**持久化的工具记录**。
// 五种靶 ⇒ metadata.alphaNetFailure.layer:代理 403 ⇒ policy、`.invalid` ⇒ dns(503)、拒连 ⇒ tcp(502)、拨号黑洞 ⇒ tcp(504)、
// 隧道开了上游只收不回 ⇒ tls-silent(undici 目标 TLS connector 10 s 先到,代理的 15 s 兜底还没到)。
// main 臂:同一 Electron node 不设代理直连只收不回的监听 ⇒ 生产分类模块按 main 路径说 connect-timeout(不是 tls-silent)。
//
// 删掉 processor.ts failToolCall 里的取层 ⇒ 五条记录都没有 alphaNetFailure;把出网代理的 503/504 改回 502 ⇒ dns 那条变 tcp;
// 把分类模块里「经出网代理」的握手判定去掉 ⇒ silent 那条变 connect-timeout。
// darwin-only(Electron 运行时与 node_modules 里那份 Electron 的 RunAsNode fuse);darwin 上缺运行时即 throw「本次测量作废」,
// 非 darwin 自报 skip,由 scripts/gate-files.tsv 按 [平台:darwin] 登记。

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import * as http from "node:http"
import { createRequire } from "node:module"
import * as net from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { __resetEgressGrantsForTests } from "./network-egress-grants"
import { startEgressPolicyProxy, type EgressLogRecord, type EgressProxyHandle } from "./network-egress-proxy"
import { sidecarEgressProxyEnv } from "./sidecar-env"

const describeDarwin = process.platform === "darwin" ? describe : describe.skip
const require = createRequire(import.meta.url)
const REPO = resolve(import.meta.dir, "../../../..")
const FIXTURES = resolve(import.meta.dir, "../../test-fixtures/net-failure")
const PASSWORD = "ac1572-real-stack"

const TARGETS = {
  policy: "ac1572-policy.test",
  dns: "ac1572-nx.invalid",
  refused: "ac1572-refused.test",
  blackhole: "ac1572-blackhole.test",
  silent: "ac1572-silent.test",
} as const

type ToolRecord = { tool: string; state: { status: string; input: { url?: string }; error?: string; metadata?: Record<string, unknown> } }

describeDarwin("`#1572` AC4 真栈:Electron 内嵌 node + 真出网代理 + 真 webfetch ⇒ 持久化的工具记录带层", () => {
  let scratch = ""
  let electron = ""
  let bundle = ""
  let bundleDir = ""
  let proxy: EgressProxyHandle | undefined
  const proxyLog: EgressLogRecord[] = []
  const servers: Array<http.Server | net.Server> = []
  let engine: ChildProcess | undefined
  const engineLog: string[] = []
  let silentPort = 0
  let records: ToolRecord[] = []

  beforeAll(async () => {
    const electronPkg = dirname(require.resolve("electron/package.json"))
    electron = join(electronPkg, "dist", readFileSync(join(electronPkg, "path.txt"), "utf8").trim())
    if (!existsSync(electron)) throw new Error(`electron binary missing at ${electron}(本次测量作废)`)
    scratch = mkdtempSync(join(tmpdir(), "ac1572-real-stack-"))
    __resetEgressGrantsForTests()

    // 真引擎:与 build-node.ts 同一配方(target node、同一入口与 external),models.dev 用仓内快照免联网。
    // 产物放进 ui-mac 的 node_modules 底下:external 的 jsonc-parser 要像出货包那样从 ui-mac 的依赖里解析到。
    mkdirSync(join(import.meta.dir, "../../node_modules/.cache"), { recursive: true })
    bundleDir = mkdtempSync(join(import.meta.dir, "../../node_modules/.cache/ac1572-real-stack-"))
    const built = await Bun.build({
      target: "node",
      entrypoints: [join(REPO, "packages/opencode/src/node.ts")],
      outdir: bundleDir,
      format: "esm",
      external: ["jsonc-parser", "@lydell/node-pty"],
      define: {
        OPENCODE_MODELS_DEV: readFileSync(join(REPO, "packages/opencode/test/tool/fixtures/models-api.json"), "utf8"),
        OPENCODE_VERSION: "'0.0.0-ac1572'",
        OPENCODE_CHANNEL: "'test'",
      },
      files: { "opencode-web-ui.gen.ts": "" },
    })
    if (!built.success) throw new Error(`engine bundle failed(本次测量作废):\n${built.logs.map(String).join("\n")}`)
    bundle = join(bundleDir, "node.js")

    // 上游靶:拒连 = 先听再关的端口;只收不回 = 接受连接、一个字节都不写(隧道开了、握手没回应)。
    const closed = net.createServer()
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r))
    const closedPort = (closed.address() as net.AddressInfo).port
    await new Promise<void>((r) => closed.close(() => r()))
    const silent = net.createServer((socket) => socket.on("error", () => {}))
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r))
    silentPort = (silent.address() as net.AddressInfo).port
    servers.push(silent)

    proxy = await startEgressPolicyProxy({
      log: (record) => void proxyLog.push(record),
      authorize: (host) => host !== TARGETS.policy && Object.values(TARGETS).includes(host as never),
      dial: (host, port) => {
        if (host === TARGETS.refused) return net.connect(closedPort, "127.0.0.1")
        if (host === TARGETS.blackhole) return new net.Socket()
        if (host === TARGETS.silent) return net.connect(silentPort, "127.0.0.1")
        return net.connect({ host, port, autoSelectFamily: true }) // .invalid:生产拨号,DNS 在代理进程里真失败
      },
      dialTimeoutMs: 1_000,
    })

    // 模型替身(loopback,经 NO_PROXY 直连,不过出网代理):第一轮一次调用五个 webfetch,收到工具结果后收尾。
    const llm = http.createServer((req, res) => {
      let body = ""
      req.on("data", (c: Buffer) => (body += c.toString()))
      req.on("end", () => {
        const answered = (JSON.parse(body) as { messages?: Array<{ role?: string }> }).messages?.some((m) => m.role === "tool")
        res.writeHead(200, { "content-type": "text/event-stream" })
        const chunk = (delta: unknown, finish: string | null) =>
          res.write(`data: ${JSON.stringify({ id: "ac1572", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
        if (answered) {
          chunk({ role: "assistant", content: "done" }, null)
          chunk({}, "stop")
        } else {
          chunk(
            {
              role: "assistant",
              tool_calls: Object.values(TARGETS).map((host, index) => ({
                index,
                id: `call_${index}`,
                type: "function",
                function: { name: "webfetch", arguments: JSON.stringify({ url: `https://${host}/ac1572?token=SECRET-NEEDLE-1572` }) },
              })),
            },
            null,
          )
          chunk({}, "tool_calls")
        }
        res.end("data: [DONE]\n\n")
      })
    })
    await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r))
    servers.push(llm)
    const llmPort = (llm.address() as net.AddressInfo).port

    const home = join(scratch, "home")
    const ws = join(scratch, "ws")
    for (const dir of [home, ws]) mkdirSync(dir, { recursive: true })
    const config = join(scratch, "opencode.json")
    writeFileSync(
      config,
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        model: "fake/m",
        permission: { webfetch: "allow" },
        provider: {
          fake: {
            name: "Fake",
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: `http://127.0.0.1:${llmPort}/v1`, apiKey: "ac1572" },
            models: { m: { name: "M", tool_call: true, limit: { context: 100000, output: 1000 } } },
          },
        },
      }),
    )
    const port = 44000 + Math.floor(Math.random() * 2000)
    engine = spawn(electron, [join(FIXTURES, "engine-driver.mjs"), bundle, String(port), PASSWORD], {
      cwd: ws,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        XDG_DATA_HOME: join(home, ".local", "share"),
        XDG_CACHE_HOME: join(home, ".cache"),
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_STATE_HOME: join(home, ".state"),
        ELECTRON_RUN_AS_NODE: "1",
        ...sidecarEgressProxyEnv(proxy.port),
        OPENCODE_CONFIG: config,
        OPENCODE_CONFIG_DIR: join(scratch, "engine-config"),
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    engine.stdout?.on("data", (c: Buffer) => engineLog.push(c.toString()))
    engine.stderr?.on("data", (c: Buffer) => engineLog.push(c.toString()))
    const listening = Date.now() + 60_000
    while (!engineLog.join("").includes(`LISTENING ${port}`)) {
      if (Date.now() > listening || engine.exitCode !== null) throw new Error(`engine under Electron node never listened(本次测量作废):\n${engineLog.join("").slice(-3000)}`)
      await Bun.sleep(100)
    }

    const api = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`, "content-type": "application/json", "x-opencode-directory": ws },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      })
      const text = await res.text()
      if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 500)}\n${engineLog.join("").slice(-2000)}`)
      return JSON.parse(text) as unknown
    }
    const session = (await api("POST", "/session", {})) as { id: string }
    await api("POST", `/session/${session.id}/message`, {
      agent: "build",
      model: { providerID: "fake", modelID: "m" },
      parts: [{ type: "text", text: "fetch them" }],
    })
    const messages = (await api("GET", `/session/${session.id}/message`)) as Array<{ parts: Array<{ type: string } & Partial<ToolRecord>> }>
    records = messages.flatMap((m) => m.parts).filter((p): p is { type: string } & ToolRecord => p.type === "tool" && p.tool === "webfetch")
    console.log(`[#1572 真栈] ${records.map((r) => `${r.state.input.url?.split("/")[2]} → ${r.state.status} ${JSON.stringify(r.state.metadata?.alphaNetFailure)}`).join(" | ")}`)
  }, 120_000)

  afterAll(async () => {
    engine?.kill("SIGKILL")
    await proxy?.close()
    for (const server of servers) await new Promise<void>((r) => server.close(() => r()))
    for (const dir of [scratch, bundleDir]) if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const recordFor = (host: string) => {
    const record = records.find((r) => r.state.input.url?.includes(`//${host}/`))
    if (!record) throw new Error(`no persisted webfetch record for ${host} — got ${records.length} record(s)`)
    return record
  }

  test("五个 webfetch 都经出网代理失败,并作为工具记录落库", () => {
    expect(records).toHaveLength(5)
    for (const record of records) expect(record.state.status).toBe("error")
    // 失败确实发生在出网代理上:policy 一条拒绝、三条拨号失败各自的码、silent 一条放行。
    // (引擎启动时自己也会出网,例如 npm registry —— 只看本文件的五个名字。)
    const hosts: readonly string[] = Object.values(TARGETS)
    const connects = proxyLog.flatMap((r) => (r.event === "egress.connect" && hosts.includes(r.host ?? "") ? [`${r.host}:${r.status}`] : []))
    expect(connects.sort()).toEqual(
      [`${TARGETS.blackhole}:504`, `${TARGETS.dns}:503`, `${TARGETS.policy}:403`, `${TARGETS.refused}:502`, `${TARGETS.silent}:200`].sort(),
    )
  })

  test("持久化记录的 metadata.alphaNetFailure:policy / dns / tcp / tcp / tls-silent", () => {
    expect(recordFor(TARGETS.policy).state.metadata?.alphaNetFailure).toEqual({ layer: "policy", code: "403" })
    expect(recordFor(TARGETS.dns).state.metadata?.alphaNetFailure).toEqual({ layer: "dns", code: "503" })
    expect(recordFor(TARGETS.refused).state.metadata?.alphaNetFailure).toEqual({ layer: "tcp", code: "502" })
    expect(recordFor(TARGETS.blackhole).state.metadata?.alphaNetFailure).toEqual({ layer: "tcp", code: "504" })
    expect(recordFor(TARGETS.silent).state.metadata?.alphaNetFailure).toEqual({ layer: "tls-silent", code: "UND_ERR_CONNECT_TIMEOUT" })
    // 握手静默是客户端先超时(undici 10 s),不是代理的 15 s 兜底:隧道零回音地关掉,没有 tunnel-silent。
    expect(proxyLog.some((r) => r.event === "egress.tunnel-silent")).toBe(false)
  })

  test("AC6:落库的层只有层名与错误码,URL 查询里的令牌不进 alphaNetFailure", () => {
    expect(records.some((r) => r.state.input.url?.includes("SECRET-NEEDLE-1572"))).toBe(true) // 针必在
    for (const record of records) {
      const stored = JSON.stringify(record.state.metadata?.alphaNetFailure)
      expect(Object.keys(record.state.metadata?.alphaNetFailure as object).sort()).toEqual(["code", "layer"])
      expect(stored).not.toContain("SECRET-NEEDLE-1572")
    }
  })

  test("main 臂:Electron node 不设代理直连只收不回的监听 ⇒ connect-timeout(不是 tls-silent)", async () => {
    const probe = await Bun.build({ target: "node", entrypoints: [join(FIXTURES, "main-direct-probe.ts")], outdir: join(scratch, "probe"), format: "esm" })
    if (!probe.success) throw new Error(`probe bundle failed(本次测量作废):\n${probe.logs.map(String).join("\n")}`)
    const out = await new Promise<string>((resolveOut, reject) => {
      const child = spawn(electron, [join(scratch, "probe", "main-direct-probe.js"), `https://127.0.0.1:${silentPort}/`], {
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      })
      let text = ""
      child.stdout.on("data", (c: Buffer) => (text += c.toString()))
      child.stderr.on("data", (c: Buffer) => (text += c.toString()))
      child.once("exit", () => resolveOut(text))
      child.once("error", reject)
    })
    const result = JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as { classified?: unknown; shape?: { causeCode?: string } }
    console.log(`[#1572 真栈 · main 直连] ${out.trim()}`)
    expect(result.shape?.causeCode).toBe("UND_ERR_CONNECT_TIMEOUT")
    expect(result.classified).toEqual({ layer: "connect-timeout", code: "UND_ERR_CONNECT_TIMEOUT" })
  }, 30_000)
})
