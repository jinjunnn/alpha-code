import * as fs from "node:fs"
import { registerHooks } from "node:module"
import * as http from "node:http"
import * as path from "node:path"
import * as tls from "node:tls"
import { ALPHA_BEHAVIOR_MD } from "./alpha-behavior"
import { buildAlphaIdentity } from "./alpha-identity"
import { buildAlphaModelConfig } from "./alpha-models"
import { hasSecretFile, secretFileRef } from "./alpha-secret-files"

// ADR-006 bridge ("two runtime worlds"). opencode's ToolRegistry dynamically imports a project's
// raw-TS tools (.opencode/tool/*.ts), and packages whose TS entry does `import "./x.js"` (e.g.
// @opencode-ai/plugin → src/index.ts → import "./tool.js") expect that to resolve to the sibling .ts.
// bun rewrites `.js`→`.ts`; the packaged Electron-Node sidecar does NOT, so those imports throw
// ERR_MODULE_NOT_FOUND → prompt_async crashes → the model never replies (looks like "no response").
// This in-thread resolve hook restores bun's behavior: when a `.js` specifier fails to resolve but the
// sibling `.ts` exists on disk, use the `.ts`. Alpha-only, zero opencode edits; registered at module
// load (before the server import) so it covers every runtime tool load.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (!specifier.endsWith(".js")) throw error
      let resolved: ReturnType<typeof nextResolve>
      try {
        resolved = nextResolve(`${specifier.slice(0, -3)}.ts`, context)
      } catch {
        throw error // sibling .ts also unresolvable → surface the original .js error
      }
      if (!resolved.url.startsWith("file:") || !fs.existsSync(new URL(resolved.url))) throw error
      return { ...resolved, shortCircuit: true }
    }
  },
})

type NodeHttpWithEnvProxy = typeof http & {
  setGlobalProxyFromEnv: () => void
}

type NodeTlsWithSystemCertificates = typeof tls & {
  getCACertificates: (type: "default" | "system") => string[]
  setDefaultCACertificates: (certificates: string[]) => void
}

type StartCommand = {
  type: "start"
  hostname: string
  port: number
  password: string
  userDataPath: string
  /** B6(=G1):@alpha-code/ext 自包含 bundle 的绝对路径(main 解析,见 alpha-ext-plugin.ts);缺省不装载。 */
  extPluginPath?: string
}

type StopCommand = { type: "stop" }
type SidecarCommand = StartCommand | StopCommand

type SidecarMessage =
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "error"; error: { message: string; stack?: string } }

type ParentPort = {
  postMessage(message: SidecarMessage): void
  on(event: "message", listener: (event: { data: unknown }) => void): void
}

type Listener = {
  stop(close?: boolean): void | Promise<void>
}

const parentPort = getParentPort()
let listener: Listener | undefined

parentPort.on("message", (event) => {
  const command = parseCommand(event.data)
  if (!command) return
  if (command.type === "stop") {
    void stop()
    return
  }
  void start(command)
})

async function start(command: StartCommand) {
  try {
    prepareSidecarEnv(command.password, command.userDataPath, command.extPluginPath)
    ensureLoopbackNoProxy()
    useSystemCertificates()
    useEnvProxy()
    const { Server } = await import("virtual:opencode-server")

    listener = await Server.listen({
      port: command.port,
      hostname: command.hostname,
      username: "opencode",
      password: command.password,
      cors: ["oc://renderer"],
    })
    parentPort.postMessage({ type: "ready" })
  } catch (error) {
    parentPort.postMessage({ type: "error", error: serializeError(error) })
    setImmediate(() => process.exit(1))
  }
}

async function stop() {
  try {
    await listener?.stop()
  } finally {
    listener = undefined
    parentPort.postMessage({ type: "stopped" })
    setImmediate(() => process.exit(0))
  }
}

function prepareSidecarEnv(password: string, userDataPath: string, extPluginPath?: string) {
  Object.assign(process.env, {
    OPENCODE_SERVER_USERNAME: "opencode",
    OPENCODE_SERVER_PASSWORD: password,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? userDataPath,
  })
  injectAlphaConfig(userDataPath, extPluginPath)
}

// Inject alpha-code's customizations into opencode via OPENCODE_CONFIG_CONTENT. This env var is
// MERGED with the user's global/project config — it does NOT replace it (opencode config.ts
// loads global config unconditionally and merges this as a "local" source), so untouched fields
// (auth, other instructions) are preserved. We layer two independent, separately-gated pieces:
//
//   1. Brand identity (ALPHA_IDENTITY_DISABLE): a global instruction file written to
//      userDataPath (stable absolute path in both dev and the packaged .app) added to
//      `instructions`, so the agent calls itself "alpha-code". Now also carries per-session
//      capability facts (websearch / cloud dispatch) — see buildAlphaIdentity(caps). Behavior-neutral.
//   1b. Response guidance (ALPHA_BEHAVIOR_DISABLE): a SEPARATE instruction file (alpha-behavior.ts)
//      that deliberately tunes agent behavior (Tier-3, ADR-015). Gated independently of identity and
//      carries a drift caveat — re-validate after every upstream prompt bump.
//   2. Curated model menu (ALPHA_MODELS_DISABLE): provider allowlist + per-provider model
//      whitelist + custom/ALPHA gateways + default model. See alpha-models.ts for the shape and
//      the {env:VAR} key story.
//
//   4. B6(=G1):@alpha-code/ext 装载 —— main 解析好的自包含 bundle 绝对路径合并进 V1 `plugin`
//      (单数键,见 opencode-config-v1-schema)数组,保留用户自己的 plugin 列表。zod 跨实例路径
//      (ADR-006 caveat)的运行时证明 = alpha_ping 出现在工具表且能执行(真机批核验)。
function injectAlphaConfig(userDataPath: string, extPluginPath?: string) {
  try {
    const existing = process.env.OPENCODE_CONFIG_CONTENT
    const config = existing ? JSON.parse(existing) : { $schema: "https://opencode.ai/config.json" }

    if (extPluginPath) {
      const plugins: string[] = Array.isArray(config.plugin) ? config.plugin : []
      if (!plugins.includes(extPluginPath)) plugins.push(extPluginPath)
      config.plugin = plugins
    }

    const wantIdentity = !process.env.ALPHA_IDENTITY_DISABLE
    const wantBehavior = !process.env.ALPHA_BEHAVIOR_DISABLE
    if (wantIdentity || wantBehavior) {
      fs.mkdirSync(userDataPath, { recursive: true })
      const instructions: string[] = Array.isArray(config.instructions) ? config.instructions : []
      const addInstruction = (name: string, body: string) => {
        const file = path.join(userDataPath, name)
        fs.writeFileSync(file, body)
        if (!instructions.includes(file)) instructions.push(file)
      }

      if (wantIdentity) {
        // Capability facts the base prompt can't know — purely informational (ADR-009 / ADR-002).
        // The cloud token lives in the {file:} channel, never in this process's env (A6).
        const caps = {
          websearch:
            process.env.ALPHA_WEBSEARCH_DISABLE !== "1" && process.env.OPENCODE_ENABLE_EXA !== "0",
          cloudDispatch: Boolean(
            process.env.ALPHA_CLOUD_MCP_URL && hasSecretFile(userDataPath, "ALPHA_CLOUD_TOKEN"),
          ),
        }
        addInstruction("alpha-identity.md", buildAlphaIdentity(caps))
      }

      // Tier-3 behavioral tuning (ADR-015), independently gated. See alpha-behavior.ts for the drift caveat.
      if (wantBehavior) addInstruction("alpha-behavior.md", ALPHA_BEHAVIOR_MD)

      config.instructions = instructions
    }

    const models = buildAlphaModelConfig(userDataPath)
    if (models) {
      config.enabled_providers = models.enabled_providers
      if (models.model) config.model = models.model
      config.provider = { ...(config.provider ?? {}), ...models.provider }
    }

    //   5. 自动化 readonly agent(REQ-021 A1.5 / ADR-022)。无人值守执行的硬前提 = 零 ask:
    //      permission 静态配死(V1 schema:pattern→action 对象,agent 级合并),不依赖运行时弹窗。
    //      read 全放但 *.env* 保持 deny(密钥文件不进上下文);edit/bash/外部目录一律 deny;
    //      question deny(无人在场没人答);doom_loop deny(异常循环直接断)。逃生:ALPHA_AUTOMATION_DISABLE。
    if (!process.env.ALPHA_AUTOMATION_DISABLE) {
      config.agent = {
        ...(config.agent ?? {}),
        "alpha-automation": {
          description: "alpha 自动化定时任务专用只读 agent(无人值守;不能改文件、不能跑命令)",
          // REQ-055:对选择器隐藏(上游 agent.ts 原生 hidden 字段,仅影响可见列表;调度器按名 prompt 不受影响)
          hidden: true,
          mode: "primary",
          prompt:
            "你是 alpha-code 的自动化任务执行器,在无人值守的定时任务里运行。" +
            "只读环境:你不能修改文件、不能执行 shell 命令;需要变更时,把建议写进最终答复。" +
            "没有人会回答追问——绝不提问,基于可得信息直接完成任务。" +
            "最终答复即任务报告:用 Markdown,先一行结论,再列依据与建议;如实标注做不到的部分。",
          permission: {
            read: { "*": "allow", "*.env*": "deny" },
            glob: "allow",
            grep: "allow",
            list: "allow",
            webfetch: "allow",
            websearch: "allow",
            skill: "allow",
            edit: "deny",
            bash: "deny",
            external_directory: "deny",
            doom_loop: "deny",
            question: "deny",
            task: "deny",
          },
        },
      }
    }

    //   2b. REQ-028:交互只读 agent(composer「只读」档的真载体)。与 alpha-automation 的差异:
    //       交互场景有人在场 → question/task 允许(追问/委托子任务不破只读:子 agent 权限独立,
    //       且 plan 类子任务本身只读);写/执行仍静态 deny —— 「真被 deny」而非 UI 文案。
    //       逃生:ALPHA_READONLY_DISABLE。治理保护名单同 alpha-automation(X2,alpha-governance.ts)。
    if (!process.env.ALPHA_READONLY_DISABLE) {
      config.agent = {
        ...(config.agent ?? {}),
        "alpha-readonly": {
          description: "只读模式:可读取/检索/联网,不能修改文件、不能执行命令(composer 权限档「只读」)",
          // REQ-055:对选择器隐藏;AlphaComposer 只读档改为提交时 agent 参数,不再依赖可见列表轮转
          hidden: true,
          mode: "primary",
          prompt:
            "当前处于用户选择的只读模式:你不能修改文件、不能执行 shell 命令。" +
            "可以读取、检索、联网调研与分析;需要变更时,给出明确的修改建议(含文件与位置),由用户切回可写模式执行。" +
            "不要尝试绕过限制;做不到的部分如实说明。",
          permission: {
            read: { "*": "allow", "*.env*": "deny" },
            glob: "allow",
            grep: "allow",
            list: "allow",
            webfetch: "allow",
            websearch: "allow",
            skill: "allow",
            edit: "deny",
            bash: "deny",
            external_directory: "deny",
          },
        },
      }
    }

    //   2c. REQ-024(自动化 A2):standard 可写档 agent。无人值守语义同 alpha-automation
    //       (question/task/doom_loop deny,零 ask 硬前提);差异 = edit allow + bash 受限 allow
    //       (破坏类命令模式 deny —— 模式黑名单**非穷尽**,UI 启用时有显式风险确认,不谎称安全)。
    if (!process.env.ALPHA_AUTOMATION_DISABLE) {
      config.agent = {
        ...(config.agent ?? {}),
        "alpha-automation-standard": {
          description: "alpha 自动化 standard 档(可写:能改文件、能执行常规命令;破坏类命令仍被拦)",
          // REQ-055:对选择器隐藏(同 alpha-automation)
          hidden: true,
          mode: "primary",
          prompt:
            "你是 alpha-code 的自动化任务执行器,在无人值守的定时任务里运行(可写档)。" +
            "可以修改文件与执行常规命令;破坏性操作(删除大量文件、系统级变更、对外发布)被权限拦截,也不要尝试。" +
            "没有人会回答追问——绝不提问,基于可得信息直接完成任务。" +
            "最终答复即任务报告:用 Markdown,先一行结论,再列所做变更与依据;如实标注做不到的部分。",
          permission: {
            read: { "*": "allow", "*.env*": "deny" },
            glob: "allow",
            grep: "allow",
            list: "allow",
            webfetch: "allow",
            websearch: "allow",
            skill: "allow",
            edit: "allow",
            bash: {
              "*": "allow",
              // 破坏类直呼(codex 审计加固:绝对路径/包装器/嵌套 shell/find -delete/git clean 常见绕法补拦;
              // 黑名单仍非穷尽 —— UI 风险确认与 agent prompt 如实声明,根治=沙箱化(后续)):
              "rm *": "deny",
              "*/rm *": "deny",
              "command *": "deny",
              "exec *": "deny",
              "env *": "deny",
              "xargs *": "deny",
              "sh *": "deny",
              "bash *": "deny",
              "zsh *": "deny",
              "eval *": "deny",
              "find * -delete*": "deny",
              "find * -exec *": "deny",
              "git clean*": "deny",
              "git reset --hard*": "deny",
              "sudo *": "deny",
              "chmod *": "deny",
              "chown *": "deny",
              "dd *": "deny",
              "mkfs*": "deny",
              "shutdown*": "deny",
              "reboot*": "deny",
              "kill *": "deny",
              "killall *": "deny",
              "git push*": "deny",
              "npm publish*": "deny",
              "curl * | *": "deny",
              "wget * | *": "deny",
            },
            external_directory: "deny",
            doom_loop: "deny",
            question: "deny",
            task: "deny",
          },
        },
      }
    }

    //   3. Cloud tool gateway (alpha-platform B). Registered only when platform-pays is active —
    //      main derives the login state (alpha-auth.ts §③) and materializes the bearer into the
    //      {file:} channel at fork (A6), so logged-out / BYOK leaves it dark. The same bearer fronts
    //      the model proxy (ALPHA_API_KEY) and this MCP tool gateway (see docs/platform-integration.md).
    //      The header carries a {file:} ref — resolved by opencode at config load, so neither this
    //      process's env nor OPENCODE_CONFIG_CONTENT ever contains the token value. oauth:false
    //      because we attach our own capability token and must skip OAuth auto-detection.
    const mcpUrl = process.env.ALPHA_CLOUD_MCP_URL
    if (mcpUrl && hasSecretFile(userDataPath, "ALPHA_CLOUD_TOKEN")) {
      config.mcp = {
        ...(config.mcp ?? {}),
        cloud: {
          type: "remote",
          url: mcpUrl,
          enabled: true,
          headers: { Authorization: `Bearer ${secretFileRef(userDataPath, "ALPHA_CLOUD_TOKEN")}` },
          oauth: false,
        },
      }
    }

    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config)
  } catch (error) {
    console.warn("failed to inject alpha config", error)
  }
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

function useSystemCertificates() {
  try {
    const nodeTls = tls as NodeTlsWithSystemCertificates
    nodeTls.setDefaultCACertificates([
      ...new Set([...nodeTls.getCACertificates("default"), ...nodeTls.getCACertificates("system")]),
    ])
  } catch (error) {
    console.warn("failed to load system certificates", error)
  }
}

function useEnvProxy() {
  try {
    ;(http as NodeHttpWithEnvProxy).setGlobalProxyFromEnv()
  } catch (error) {
    console.warn("failed to load proxy environment", error)
  }
}

function parseCommand(value: unknown): SidecarCommand | undefined {
  if (!value || typeof value !== "object") return
  const command = value as Partial<StartCommand | StopCommand>
  if (command.type === "stop") return { type: "stop" }
  if (command.type !== "start") return
  if (typeof command.hostname !== "string") return
  if (typeof command.port !== "number") return
  if (typeof command.password !== "string") return
  if (typeof command.userDataPath !== "string") return
  return {
    type: "start",
    hostname: command.hostname,
    port: command.port,
    password: command.password,
    userDataPath: command.userDataPath,
    ...(typeof command.extPluginPath === "string" ? { extPluginPath: command.extPluginPath } : {}),
  }
}

function serializeError(error: unknown) {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

function getParentPort() {
  const port = process.parentPort as ParentPort | undefined
  if (!port) throw new Error("Sidecar parent port unavailable")
  return port
}
