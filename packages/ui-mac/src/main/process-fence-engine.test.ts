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
// `#1337`:真引擎在围栏下的出网只剩策略代理那一扇门 —— 这里起**生产的**代理(默认接线 = 注册表)并按生产
// sidecarEgressProxyEnv 给引擎 env,与出货形态同一条路;判据仍只看文件轴(网络轴在 network-egress-fence.test.ts)。
import { startEgressPolicyProxy, type EgressProxyHandle } from "./network-egress-proxy"
import { sidecarEgressProxyEnv } from "./sidecar-env"

const describeDarwin = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec") ? describe : describe.skip
const repoRoot = resolve(import.meta.dir, "../../../..")
const fixtures = resolve(import.meta.dir, "../../test-fixtures/process-fence")
const engineEntry = join(repoRoot, "packages", "opencode", "src", "index.ts")
const extBundle = join(repoRoot, "packages", "ext", "dist", "plugin.js")
const PASSWORD = "ac1321"

type Arm = "bare" | "fenced"
type Engine = { proc: ChildProcess; port: number; log: string[] }

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
  const engines: Engine[] = []
  const landed = (dir: string) => readdirSync(dir).sort()

  beforeAll(async () => {
    egressProxy = await startEgressPolicyProxy({ log: () => {} })
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
        defaultWorkspace: () => ws,
        readStore: () => ({ tabs: undefined, recent: undefined, info: undefined }),
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

  async function bootEngine(arm: Arm): Promise<Engine> {
    const port = 43000 + Math.floor(Math.random() * 2000)
    const configPath = join(iso, `config-${arm}.json`)
    writeFileSync(configPath, JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: [extBundle] }))
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
    const args = ["run", ...(arm === "fenced" ? ["--preload", join(fixtures, "engine-fence-preload.ts")] : []), engineEntry, "serve", "--port", String(port), "--hostname", "127.0.0.1"]
    const { spawn } = await import("node:child_process")
    const log: string[] = []
    const proc = spawn(process.execPath, args, { cwd: join(userData, "engine-scratch-cwd"), env, stdio: ["ignore", "pipe", "pipe"] })
    proc.stdout?.on("data", (c: Buffer) => log.push(c.toString("utf8")))
    proc.stderr?.on("data", (c: Buffer) => log.push(c.toString("utf8")))
    const engine = { proc, port, log }
    engines.push(engine)
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) throw new Error(`engine(${arm}) exited ${proc.exitCode} before health:\n${log.join("").slice(-2000)}`)
      const ok = await fetch(`http://127.0.0.1:${port}/global/health`, { headers: auth(), signal: AbortSignal.timeout(2000) })
        .then((r) => r.ok)
        .catch(() => false)
      if (ok) return engine
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error(`engine(${arm}) never became healthy:\n${log.join("").slice(-2000)}`)
  }

  const auth = () => ({ authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`, "content-type": "application/json" })
  const api = async (engine: Engine, method: string, path: string, body?: unknown) => {
    const url = new URL(`http://127.0.0.1:${engine.port}${path}`)
    url.searchParams.set("directory", ws)
    const res = await fetch(url, { method, headers: { ...auth(), "x-opencode-directory": ws }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) })
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
})
