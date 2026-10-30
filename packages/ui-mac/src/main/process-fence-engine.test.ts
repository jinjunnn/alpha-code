// REQ-159 (`#1321`) · AC1 + AC2 —— **真引擎 + 真 ext + 生产计划器 + 生产 .node**,四类真消费方越界写 0 落盘。
//
// 与 process-fence-apply.test.ts 的分工:那边跑的是四类**创建原语**(Electron 的 node 里 dlopen);这边跑的是
// 四类**真消费方** —— 引擎的 shell 工具端点、`POST /pty`(缺省 + 带 command)、`POST /mcp` 经 MCP SDK 起真
// stdio server、装了 `@alpha-code/ext` 的引擎本身 —— 与勘破 §8.3 F2 臂同一条工作负载,差别是围栏不再靠外部
// `sandbox-exec`,而是**生产的原生模块在引擎进程装载任何模块之前 `sandbox_init`**(bun --preload,与出货
// sidecar「import 引擎前自打 seatbelt」同一顺序、同一 SPI);profile 由**生产的 planProcessFence** 渲染 +
// 真 sandbox-exec 试编译。
//
// AC2 在这里的形状:shell 工具在围栏下**照常执行**(输出是 zsh 自己的 `operation not permitted`,
// 不是 `sandbox_apply: Operation not permitted` 那种零执行的 exit 71),且 `GET /config` 里 cfg.shell
// 不指向 REQ-138 的 wrapper —— 两层并存的形态(§8.4 F1 臂)在这里必红。
//
// 正样本臂:同一驱动、同一工作负载、同一探针,只去掉 preload ⇒ 全部落盘。先证明探针测得出「写得进」。
//
// 口径(如实):引擎跑在 **bun**(dev 树),不是出货的 node sidecar;出货形态(node + 打包产物 + 围栏)是
// U3 那张 VERIFY 票的事,本文件不闭合它。隔离家目录里没有凭据,shell 端点靠显式 `model` 绕开 provider 解析
// (§8.3 同一条);**没有发过一次真的模型请求**。
// 布局:整个隔离树放在**真 HOME** 之下(不放 /private/tmp 或 $TMPDIR —— 那两处在可写集里,勘破 §7.4 括注的坑)。
//
// darwin-only(真 seatbelt),CI(ubuntu)上自报 skip;每臂一次引擎冷启动,约 10–20 s。

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { buildFenceAddon } from "../../scripts/build-fence-addon"
import { trialCompileProfile } from "./process-fence-compile"
import { planProcessFence } from "./process-fence-plan"
// `#1337`:真引擎在围栏下的出网只剩策略代理那一扇门 —— 这里起**生产的**代理并按生产 sidecarEgressProxyEnv 给引擎 env,
// 与出货形态同一条路;判据仍只看文件轴(网络轴在 network-egress-fence.test.ts)。
// `#1454`:代理的授权在这里**注入为全拒**(authorize=false、requestGrant=not-asked),不接注册表。这不丢覆盖面:
// registry.npmjs.org 作为已登记目的地登记在 network-egress-registry.ts(`https("registry.npmjs.org", …)` 那行),判据在
// network-egress-registry.test.ts(`isEgressAuthorized("registry.npmjs.org", 443)`);「默认 authorize 就是注册表」的判据在
// network-egress-proxy.test.ts(以 github.com:443 为样本)。本文件失去的只是「引擎那次 npm 安装真的穿过代理打到真 registry」
// 这个**从来不是断言**的副作用 —— 而它正是让这道闸又慢又依赖本机网络的东西;全拒不是放宽。引擎一起来就会为 config 里
// 声明的 plugin 跑一次 `@opencode-ai/plugin` 的 npm 安装(opencode config.ts 里 forkDetach 的 Npm.install,Plugin.waitForDependencies
// 让**第一个请求**等它);注册表接线把它放行到真 registry.npmjs.org(单跑实测:health 之后 30 条 CONNECT),于是 GET /project/current
// 在本机网络上一挂就挂满 api() 的 AbortSignal.timeout(60_000) —— 全量门里 8 个红样本全落 60–62 s,红的是这条,不是 bun 的 --timeout。
// 全拒让那次安装当场 403 收场(make-fetch-happen 对 EINVALIDRESPONSE 不重试),同一文件 25–68 s → ~8 s,且不再依赖本机能不能出网。
// api() 超时时把「哪条调用、等了多久、代理记录、引擎日志尾」一起抛出 —— 一句裸 TimeoutError 会让下一个人再去查一遍不存在的缺陷。
import { startEgressPolicyProxy, type EgressLogRecord, type EgressProxyHandle } from "./network-egress-proxy"
import { sidecarEgressProxyEnv } from "./sidecar-env"
import { buildReloadRequest } from "./alpha-sidecar-messages"
import { attachmentAbsolutePath } from "../shared/attachment-path"
import { explainAttachmentBlock } from "../../../ext/src/context-injection"

const describeDarwin = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec") ? describe : describe.skip
const repoRoot = resolve(import.meta.dir, "../../../..")
const fixtures = resolve(import.meta.dir, "../../test-fixtures/process-fence")
const engineEntry = join(repoRoot, "packages", "opencode", "src", "index.ts")
const extBundle = join(repoRoot, "packages", "ext", "dist", "plugin.js")
const PASSWORD = "ac1321"

type Arm = "bare" | "fenced"
type Engine = { proc: ChildProcess; port: number; log: string[]; bootedAt: number }

describeDarwin("REQ-159 真引擎 + 真 ext 在进程围栏下:四类真消费方越界 0 落盘;shell 工具照常执行", () => {
  let iso = ""
  let home = ""
  let ws = ""
  let esc = ""
  let userData = ""
  let globalRoot = ""
  let addon = ""
  let profileFile = ""
  let planLog: string[] = []
  let egressProxy: EgressProxyHandle | undefined
  const proxyLog: EgressLogRecord[] = []
  const engines: Engine[] = []
  const landed = (dir: string) => readdirSync(dir).sort()

  beforeAll(async () => {
    egressProxy = await startEgressPolicyProxy({
      log: (r) => void proxyLog.push(r),
      authorize: () => false,
      requestGrant: async () => "not-asked",
    })
    // ① ext bundle:本树的 ext(不是别的 worktree 的),现编。
    const ext = spawnSync(process.execPath, ["run", "build"], { cwd: join(repoRoot, "packages", "ext"), encoding: "utf8", timeout: 120_000 })
    if (ext.status !== 0 || !existsSync(extBundle)) throw new Error(`ext build failed (本次测量作废): ${ext.stderr}`)
    // ② 隔离树(真 HOME 之下)。
    iso = realpathSync(mkdtempSync(join(homedir(), ".ac1321-engine-")))
    home = join(iso, "home")
    ws = join(iso, "ws")
    esc = join(iso, "esc")
    userData = join(iso, "userData")
    globalRoot = join(iso, "alpha-code-state", "env", "dev")
    for (const d of [home, ws, esc, userData, globalRoot, join(userData, "engine-scratch-cwd")]) mkdirSync(d, { recursive: true })
    spawnSync("git", ["init", "-q"], { cwd: ws })
    // ③ 生产 .node(现编,烤 buildId)与生产计划器(真试编译)。
    addon = buildFenceAddon({ out: join(iso, "resources", "alpha-fence", "alpha_fence.node"), buildId: `ac1321-engine-${Date.now()}` }).out
    const plan = planProcessFence(
      {
        userDataPath: userData,
        sidecarEnv: { HOME: home, XDG_DATA_HOME: join(home, ".local", "share"), XDG_CACHE_HOME: join(home, ".cache"), XDG_CONFIG_HOME: join(home, ".config"), XDG_STATE_HOME: userData },
        addon: { packaged: true, resourcesPath: join(iso, "resources"), moduleDir: "/unused", exists: existsSync },
        egressProxyPort: egressProxy.port,
      },
      {
        homeDir: () => home,
        alphaGlobalRoot: () => globalRoot,
        // `#1390`:状态根 = globalRoot 的父目录的父目录;realpath 用生产同一个(realpathSync.native)
        appStateRoot: () => join(iso, "alpha-code-state"),
        realpath: (p) => realpathSync.native(p),
        defaultWorkspace: () => ws,
        readWorkspaces: () => [],
        isDirectory: (p) => {
          try {
            return statSync(p).isDirectory()
          } catch {
            return false
          }
        },
        mkdirp: (p) => void mkdirSync(p, { recursive: true }),
        compile: trialCompileProfile,
        log: (l) => void planLog.push(l),
      },
    )
    profileFile = join(iso, "fence.sb")
    writeFileSync(profileFile, plan.profile)
    expect(plan.workspaces).toEqual([ws])
    expect(plan.addonPath).toBe(addon)
  })

  afterAll(async () => {
    await egressProxy?.close()
    for (const e of engines) {
      try {
        e.proc.kill("SIGTERM")
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 500))
    for (const e of engines) {
      try {
        e.proc.kill("SIGKILL")
      } catch {}
    }
    try {
      rmSync(iso, { recursive: true, force: true })
    } catch {}
  })

  /** `#1531`:额外的 preload(在围栏 preload 之后)与 node IPC(经它接成引擎的 process.parentPort)。`#1553`:额外的 config 键。 */
  async function bootEngine(arm: Arm, extra: { preloads?: string[]; ipc?: boolean; config?: Record<string, unknown> } = {}): Promise<Engine> {
    const port = 43000 + Math.floor(Math.random() * 2000)
    const configPath = join(iso, `config-${arm}-${engines.length}.json`)
    writeFileSync(configPath, JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: [extBundle], ...extra.config }))
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_STATE_HOME: userData,
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      // `#1337`:与出货 sidecar 同一份代理栈(HTTP(S)_PROXY → 策略代理;NO_PROXY = loopback)。
      ...sidecarEgressProxyEnv(egressProxy!.port),
      NO_COLOR: "1",
      OPENCODE_SERVER_USERNAME: "opencode",
      OPENCODE_SERVER_PASSWORD: PASSWORD,
      OPENCODE_CONFIG: configPath,
      OPENCODE_CONFIG_DIR: join(userData, "alpha-engine-config"),
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      ALPHA_GLOBAL_DIR: globalRoot,
      ALPHA_SECRETS_DISABLE: "1",
      ...(arm === "fenced" ? { ALPHA1321_FENCE_ADDON: addon, ALPHA1321_FENCE_PROFILE: profileFile } : {}),
    }
    // flag 必须在 `run` 之后 —— `bun --preload X run Y` 在 bun 1.3.x 打印 usage 后静默退出 0(仓内 CLAUDE.md 记的坑,本文件第一版就踩了)。
    const preloads = [...(arm === "fenced" ? [join(fixtures, "engine-fence-preload.ts")] : []), ...(extra.preloads ?? [])]
    const args = ["run", ...preloads.flatMap((p) => ["--preload", p]), engineEntry, "serve", "--port", String(port), "--hostname", "127.0.0.1"]
    const { spawn } = await import("node:child_process")
    const log: string[] = []
    const proc = spawn(process.execPath, args, { cwd: join(userData, "engine-scratch-cwd"), env, stdio: extra.ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"] })
    proc.stdout?.on("data", (c: Buffer) => log.push(c.toString("utf8")))
    proc.stderr?.on("data", (c: Buffer) => log.push(c.toString("utf8")))
    const engine = { proc, port, log, bootedAt: 0 }
    engines.push(engine)
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) throw new Error(`engine(${arm}) exited ${proc.exitCode} before health:\n${log.join("").slice(-2000)}`)
      const ok = await fetch(`http://127.0.0.1:${port}/global/health`, { headers: auth(), signal: AbortSignal.timeout(2000) })
        .then((r) => r.ok)
        .catch(() => false)
      if (ok) {
        engine.bootedAt = Date.now()
        return engine
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error(`engine(${arm}) never became healthy:\n${log.join("").slice(-2000)}`)
  }

  const auth = () => ({ authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`, "content-type": "application/json" })
  const api = async (engine: Engine, method: string, path: string, body?: unknown) => {
    const url = new URL(`http://127.0.0.1:${engine.port}${path}`)
    url.searchParams.set("directory", ws)
    const started = Date.now()
    let res: Response
    try {
      res = await fetch(url, { method, headers: { ...auth(), "x-opencode-directory": ws }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) })
    } catch (err) {
      const e = err as Error
      throw new Error(
        `${method} ${path} failed after ${Date.now() - started}ms (${e.name}: ${e.message}); engine healthy ${started - engine.bootedAt}ms before this call\n` +
          `--- proxy log (${proxyLog.length}) ---\n${proxyLog.map((r) => JSON.stringify(r)).join("\n")}\n--- engine log tail ---\n${engine.log.join("").slice(-3000)}`,
      )
    }
    const text = await res.text()
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      json = text
    }
    return { status: res.status, json }
  }

  type Workload = { shellOutput: string; ptyDefaultStatus: number; ptyCommandStatus: number; mcpStatus: unknown; configShell: unknown }

  async function workload(engine: Engine, arm: Arm): Promise<Workload> {
    const project = await api(engine, "GET", "/project/current")
    expect(project.status, `project/current ${JSON.stringify(project.json).slice(0, 300)}`).toBe(200)
    const session = await api(engine, "POST", "/session", {})
    expect(session.status, `session ${JSON.stringify(session.json).slice(0, 300)}`).toBe(200)
    const sessionID = (session.json as { id: string }).id

    // shell 工具:一条命令写界内 + 界外。model 显式给出以绕开 provider 解析(隔离家目录无凭据;shellImpl 不发 LLM 请求)。
    const shell = await api(engine, "POST", `/session/${sessionID}/shell`, {
      agent: "build",
      model: { providerID: "opencode", modelID: "big-pickle" },
      command: `echo x > "${join(ws, `shelltool-${arm}.txt`)}"; echo x > "${join(esc, `shelltool-${arm}.txt`)}"; echo done`,
    })
    expect(shell.status, `shell ${JSON.stringify(shell.json).slice(0, 500)}`).toBe(200)
    const parts = (shell.json as { parts?: Array<{ type: string; state?: { output?: string; metadata?: { output?: string } } }> }).parts ?? []
    const tool = parts.find((p) => p.type === "tool")
    const shellOutput = tool?.state?.output ?? tool?.state?.metadata?.output ?? ""

    // PTY 带 command:真 node-pty 起 /bin/sh -c 写两处。
    const ptyCommand = await api(engine, "POST", "/pty", {
      command: "/bin/sh",
      args: ["-c", `echo x > "${join(ws, `pty-${arm}.txt`)}"; echo x > "${join(esc, `pty-${arm}.txt`)}"; exit 0`],
      cwd: ws,
    })
    // PTY 缺省:登录 shell 开得出来(W15)。
    const ptyDefault = await api(engine, "POST", "/pty", { cwd: ws })

    // MCP stdio:引擎经 MCP SDK(cross-spawn)起真 server,server 起来第一件事写两处。
    const mcp = await api(engine, "POST", "/mcp", {
      name: "alpha1321probe",
      config: { type: "local", command: ["node", join(fixtures, "mcp-probe.mjs"), ws, esc, arm], enabled: true },
    })
    const config = await api(engine, "GET", "/config")
    // 让 PTY / MCP 子进程把写盘做完
    await new Promise((r) => setTimeout(r, 1500))
    return {
      shellOutput,
      ptyDefaultStatus: ptyDefault.status,
      ptyCommandStatus: ptyCommand.status,
      mcpStatus: mcp.json,
      configShell: (config.json as { shell?: unknown })?.shell,
    }
  }

  let bare: Workload | undefined
  let fenced: Workload | undefined

  test("正样本臂(不套围栏):shell / PTY / MCP 三条真消费方在界内与界外**全部**落盘 —— 探针测得出「写得进」", async () => {
    const engine = await bootEngine("bare")
    bare = await workload(engine, "bare")
    expect(bare.ptyCommandStatus).toBe(200)
    expect(bare.ptyDefaultStatus).toBe(200)
    expect(JSON.stringify(bare.mcpStatus)).toContain("connected")
    expect(landed(esc)).toEqual(["mcp-bare.txt", "pty-bare.txt", "shelltool-bare.txt"])
    expect(landed(ws).filter((f) => f.endsWith("-bare.txt"))).toEqual(["mcp-bare.txt", "pty-bare.txt", "shelltool-bare.txt"])
    expect(bare.shellOutput).not.toMatch(/not permitted/i)
    engine.proc.kill("SIGTERM")
  }, 180_000)

  test("围栏臂(生产 .node + 生产计划器的 profile):三条真消费方界内落盘、界外**零**新增;PTY 开得出;MCP 连得上", async () => {
    const before = landed(esc)
    const engine = await bootEngine("fenced")
    expect(engine.log.join("")).toContain("engine-fence-preload: fence applied")
    fenced = await workload(engine, "fenced")
    expect(fenced.ptyCommandStatus).toBe(200)
    expect(fenced.ptyDefaultStatus, "PTY 缺省 shell 在围栏下必须开得出来(W15 /dev/ptmx)").toBe(200)
    expect(JSON.stringify(fenced.mcpStatus)).toContain("connected")
    expect(landed(esc)).toEqual(before) // 一条 *-fenced.txt 都没有
    expect(landed(ws).filter((f) => f.endsWith("-fenced.txt"))).toEqual(["mcp-fenced.txt", "pty-fenced.txt", "shelltool-fenced.txt"])
    engine.proc.kill("SIGTERM")
  }, 180_000)

  test("AC2:围栏下 shell 工具**照常执行**(zsh 自己报 operation not permitted,不是 sandbox_apply 的零执行),cfg.shell 不指向 REQ-138 wrapper", () => {
    expect(fenced, "围栏臂没跑成,本格作废").toBeDefined()
    expect(fenced!.shellOutput).toMatch(/operation not permitted/i)
    expect(fenced!.shellOutput).toContain("done") // 命令跑到了最后一句 ⇒ 不是 exit 71 零执行
    expect(fenced!.shellOutput).not.toContain("sandbox_apply")
    // REQ-138 那层若还在,GET /config 的 shell 会指向 <alphaGlobalRoot>/bin/<shell>
    expect(String(fenced!.configShell ?? "")).not.toContain(join(globalRoot, "bin"))
    expect(String(bare!.configShell ?? "")).not.toContain(join(globalRoot, "bin"))
  })

  test("计划器在真 sandbox-exec 上一次编过;围栏下引擎的 provider 缓存根(W4/W5/W6/W7)都被预建", () => {
    expect(planLog.some((l) => /process fence planned: workspaces=1 .*compile attempts=1/.test(l))).toBe(true)
    for (const d of [join(home, ".local", "share", "opencode"), join(home, ".cache", "opencode"), join(home, ".config", "opencode"), join(home, ".npm")])
      expect(existsSync(d), d).toBe(true)
  })

  // ── REQ-234 `#1531`(审计 R1 Major 1):ext 重载调度器在**围栏 + 引擎已监听**下能不能问到引擎 ───────────────────────────
  // 引擎一监听,递给插件的 input.client 就改走 TCP 连 Server.url;围栏的网络行只放行出网代理端口(N4)。两臂同一条驱动:
  // 经 node IPC 接成的 parentPort 发一条 main 形状的 alpha.reload.request(与出货 sidecar 收到的同一族消息),读 ext 回的 report。
  //   对照臂:没有进程内交接 ⇒ 调度器只能用 input.client(TCP)⇒ 围栏拒掉 ⇒ 查不到 ⇒ 零 dispose、报 waiting —— 先证明这条红真的存在;
  //   被测臂:按出货 sidecar 的做法挂上进程内 app.fetch(in-process-engine.ts 交接点)⇒ 调度器问得到 ⇒ dispose ⇒ 报 reloaded。
  async function reloadViaParentPort(engine: Engine, generation: number) {
    const project = await api(engine, "GET", "/project/current")
    expect(project.status, `project/current ${JSON.stringify(project.json).slice(0, 300)}`).toBe(200)
    const reports: Array<{ generation?: number; outcome?: string; error?: string; directories?: string[] }> = []
    engine.proc.on("message", (message) => {
      if ((message as { type?: string }).type === "alpha.reload.report") reports.push(message as (typeof reports)[number])
    })
    engine.proc.send!(buildReloadRequest({ generation, scope: "global", items: [], reason: "#1531 fenced reload probe" }))
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline && !reports.some((r) => r.generation === generation)) await new Promise((r) => setTimeout(r, 100))
    return reports.filter((r) => r.generation === generation)
  }

  test("#1531 正样本臂:不套围栏 + 已监听 + 没有进程内交接 ⇒ input.client(TCP)问得到 ⇒ reloaded —— 下一臂的红只能归因于围栏", async () => {
    const engine = await bootEngine("bare", { preloads: [join(fixtures, "engine-parent-port-preload.ts")], ipc: true })
    const reports = await reloadViaParentPort(engine, 3)
    expect(reports[0], engine.log.join("").slice(-2000)).toMatchObject({ outcome: "reloaded", directories: [ws] })
    engine.proc.kill("SIGTERM")
  }, 180_000)

  test("#1531 对照臂:围栏 + 已监听 + 没有进程内交接 ⇒ ext 调度器经 input.client(TCP)问不到引擎 ⇒ 零 dispose、报 waiting", async () => {
    const engine = await bootEngine("fenced", { preloads: [join(fixtures, "engine-parent-port-preload.ts")], ipc: true })
    expect(engine.log.join("")).toContain("engine-fence-preload: fence applied")
    const reports = await reloadViaParentPort(engine, 1)
    expect(reports[0], engine.log.join("").slice(-2000)).toMatchObject({ outcome: "waiting", error: "engine status unavailable — restart the app if this persists" })
    expect(engine.log.join("")).toContain(`session status of ${ws} unknown`)
    engine.proc.kill("SIGTERM")
  }, 180_000)

  test("#1531 被测臂:围栏 + 已监听 + 出货的进程内交接 ⇒ ext 调度器问得到引擎 ⇒ dispose ⇒ 报 reloaded", async () => {
    const engine = await bootEngine("fenced", {
      preloads: [join(fixtures, "engine-parent-port-preload.ts"), join(fixtures, "engine-in-process-preload.ts")],
      ipc: true,
    })
    expect(engine.log.join("")).toContain("engine-fence-preload: fence applied")
    const reports = await reloadViaParentPort(engine, 2)
    expect(reports[0], engine.log.join("").slice(-2000)).toEqual({ type: "alpha.reload.report", generation: 2, scope: "global", outcome: "reloaded", directories: [ws] })
    engine.proc.kill("SIGTERM")
  }, 180_000)

  // ── REQ-236 `#1553`(审计 r1 第 5、6 条):ext 在**围栏 + 引擎已监听**下读引擎的三处 —— 附件读取指令的逐服务状态(GET /mcp)、
  // 云识图的模型能力(GET /provider)与会话历史(GET /session/<id>/message)。驱动 = 真 POST /session/<id>/message(noReply:只建
  // 用户消息、不发模型请求),带一张图 + Word / PDF 两条暂存附件记录;读回持久化的用户消息里 ext 追加的 part,并看 ext 的错误日志。
  // 两臂同一份 config:一个**声明能看图**的本地 provider(隔离引擎没有凭据、不拉目录,`/provider` 否则是空表;只列出来、不发请求),
  // 外加一个名叫 alpha-word 的 MCP(探针 server);alpha-pdf 不配置。
  //   对照臂:没有进程内交接 ⇒ 三处都只能走 input.client(TCP)⇒ 围栏拒掉 ⇒ 两条指令都按「状态未知」叫模型去读,日志点名三处都读不到,
  //           能看图的模型被当成看不了、原图旁多出一个识图块 —— 修之前的出货形态;
  //   被测臂:出货的进程内交接 ⇒ 三处都读得到 ⇒ Word 指令带 alpha-word_read_docx 与绝对路径(服务在表里),PDF 指令改为如实告知
  //           (alpha-pdf 不在表里)—— 证明读到的就是 GET /mcp 那张按服务名索引、带 status 的表;能看图 ⇒ 不追加识图块。
  // 口径(如实):进程内交接的是 Server.Default() 那张服务图,TCP 监听另建一张(Server.listen 用新的 memoMap);运行期状态
  // (connected / failed)各记各的 —— 本臂只证明配置决定的那一半(在不在、停没停用),见交回的「发现」。
  const STAGED_DOCX = { v: 1, name: "复盘.docx", mime: "application/x", size: 3, path: "attachments/0b8c7f9e-1d2a-4c3b-9e8f-7a6b5c4d3e2f/复盘.docx", reader: "word" }
  const STAGED_PDF = { v: 1, name: "合同.pdf", mime: "application/pdf", size: 3, path: "attachments/1c9d8a0f-2e3b-4d4c-8f9a-8b7c6d5e4f30/合同.pdf", reader: "pdf" }
  const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
  const READ_FAILURES = ["attachment reader: MCP status unavailable", "cloud vision: provider list unavailable", "cloud vision: session history unavailable"]
  const PROBE_CONFIG = () => ({
    provider: {
      vprobe: {
        npm: "@ai-sdk/openai-compatible",
        name: "vprobe",
        options: { baseURL: "http://127.0.0.1:9/v1", apiKey: "not-a-key" },
        models: { see: { name: "see", modalities: { input: ["text", "image"], output: ["text"] } } },
      },
    },
    mcp: { "alpha-word": { type: "local", command: ["node", join(fixtures, "mcp-probe.mjs"), ws, esc, "word1553"], enabled: true } },
  })

  async function attachmentProbe(engine: Engine) {
    const project = await api(engine, "GET", "/project/current")
    expect(project.status, `project/current ${JSON.stringify(project.json).slice(0, 300)}`).toBe(200)
    const session = await api(engine, "POST", "/session", {})
    expect(session.status).toBe(200)
    const sessionID = (session.json as { id: string }).id
    const sent = await api(engine, "POST", `/session/${sessionID}/message`, {
      noReply: true,
      agent: "build",
      model: { providerID: "vprobe", modelID: "see" },
      parts: [
        { type: "text", text: "看看这两份" },
        { type: "file", mime: "image/png", filename: "shot.png", url: `data:image/png;base64,${PNG_1X1}` },
        { type: "text", text: "", synthetic: true, metadata: { "codepuppy.attachment": STAGED_DOCX } },
        { type: "text", text: "", synthetic: true, metadata: { "codepuppy.attachment": STAGED_PDF } },
      ],
    })
    expect(sent.status, `message ${JSON.stringify(sent.json).slice(0, 500)}\n${engine.log.join("").slice(-2000)}`).toBe(200)
    const messages = await api(engine, "GET", `/session/${sessionID}/message`)
    const user = (messages.json as Array<{ info: { role: string }; parts: Array<{ id: string; type: string; text?: string; synthetic?: boolean }> }>).find(
      (m) => m.info.role === "user",
    )
    const instructions = user?.parts.filter((p) => p.type === "text" && p.synthetic === true && p.id.endsWith("-read")).map((p) => p.text ?? "") ?? []
    // 云识图追加的块(id 接在图片 part 后面 `-vision`):模型能看图时一个都不该有。
    const visionBlocks = user?.parts.filter((p) => p.id.endsWith("-vision")).length ?? -1
    return { instructions, visionBlocks, log: engine.log.join("") }
  }

  test("#1553 对照臂:围栏 + 已监听 + 没有进程内交接 ⇒ ext 经 input.client 读不到 MCP 状态 / 模型能力 / 会话历史", async () => {
    const engine = await bootEngine("fenced", { config: PROBE_CONFIG() })
    expect(engine.log.join("")).toContain("engine-fence-preload: fence applied")
    const probe = await attachmentProbe(engine)
    expect(probe.instructions.map((text) => explainAttachmentBlock(text)), probe.log.slice(-2000)).toEqual([
      { ok: true, id: "attachment.read", kind: "wrapper" },
      { ok: true, id: "attachment.read", kind: "wrapper" },
    ])
    for (const failure of READ_FAILURES) expect(probe.log, failure).toContain(failure)
    expect(probe.visionBlocks).toBe(1)
    engine.proc.kill("SIGTERM")
  }, 180_000)

  test("#1553 被测臂:围栏 + 已监听 + 出货的进程内交接 ⇒ GET /mcp、/provider、/session/<id>/message 都读得到", async () => {
    const engine = await bootEngine("fenced", { preloads: [join(fixtures, "engine-in-process-preload.ts")], config: PROBE_CONFIG() })
    expect(engine.log.join("")).toContain("engine-fence-preload: fence applied")
    const probe = await attachmentProbe(engine)
    for (const failure of READ_FAILURES) expect(probe.log, failure).not.toContain(failure)
    const [word, pdf] = probe.instructions
    expect([word, pdf].map((text) => explainAttachmentBlock(text ?? "")), probe.log.slice(-2000)).toEqual([
      { ok: true, id: "attachment.read", kind: "wrapper" },
      { ok: true, id: "attachment.unavailable.missing", kind: "template" },
    ])
    expect(word).toContain("alpha-word_read_docx")
    // 插件实例目录与引擎实例目录逐字相同:指令里的绝对路径 = attachmentAbsolutePath(工作区, 记录路径)。
    expect(word).toContain(attachmentAbsolutePath(ws, STAGED_DOCX.path))
    expect(pdf).toContain("合同.pdf")
    // 云识图拿到了引擎对这个模型的 capabilities.input.image = true:不判未知,也不追加识图块。
    expect(probe.log).not.toContain("capabilities.input.image unknown")
    expect(probe.visionBlocks).toBe(0)
    engine.proc.kill("SIGTERM")
  }, 180_000)
})
