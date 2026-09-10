import * as fs from "node:fs"
import { registerHooks } from "node:module"
import * as http from "node:http"
import * as tls from "node:tls"
// #607:注入组合体住在自己的模块里 —— 本文件的第一个 import(registerHooks)与顶层
// getParentPort() 让 sidecar.ts 无法被测试 import,注入因此长期零覆盖。见 alpha-config-injection.ts。
import { injectAlphaConfig, type AlphaConfigInjectionResult } from "./alpha-config-injection"
// #613 R1:ready 消息构造抽成 bun 可真执行的单元 —— 文本锚锁不住「值真的上车」,运行时闸门
// 在 sidecar-ready-message.test.ts;本文件不得字面量构造 ready 消息(接线锚断言其不存在)。
import { buildReadyMessage, type SidecarReadyMessage } from "./sidecar-ready-message"
// #858:停止命令的形状与「关不关活动连接」的决定住在 sidecar-stop.ts —— 本文件顶层的
// registerHooks / getParentPort() 让它无法被测试 import(与 #607 同因),真判据必须在可 import
// 的模块里跑(见 sidecar-stop.test.ts)。
import {
  parseSidecarStopCommand,
  stopSidecarListener,
  type SidecarStopCommand,
  type StoppableListener,
} from "./sidecar-stop"
import type { ChannelName } from "./catalog-channels"
import { prewarmInitialLocation } from "./sidecar-location-prewarm"
// REQ-159 `#1321`:进程围栏。本进程在 import 引擎之前把自己关进 seatbelt,之后派生的一切继承。
// profile 由 main 渲染 + 试编译(process-fence-plan.ts),这里原样 apply;装不上 = 本进程不起
// (fail-closed,原因经 error IPC 报给 main)。判据在 process-fence-apply.test.ts(真 .node / 真 seatbelt /
// Electron 的 node);本文件顶层的 registerHooks / getParentPort() 让它无法被 import,接线只能锚源码。
import { applyProcessFence, type ProcessFenceStartInput } from "./process-fence-apply"

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
  /** #397 override 注入用的 catalog 通道。必须由 main 从冻结环境快照取好传入 —— 本进程从不跑
   *  initAlphaEnvironment,在这里调 catalogRegistryChannel() 会抛,且曾把整个 injectAlphaConfig
   *  连同 provider 注入一起炸掉(2026-07-23 打包端「全模型当前不可用」事故)。缺省 = loud 跳过
   *  override 注入(fail-closed 权威在 boot reconcile,见 ext-disabled-injection.ts)。 */
  registryChannel?: ChannelName
  /** #857:the renderer home model contract's exact initial location (`~/Alpha`). */
  initialDirectory: string
  /**
   * REQ-159 `#1321`:进程围栏 —— main 已试编译通过的 profile 全文 + 原生模块绝对路径。
   * darwin 上**必须**在场:缺席即拒绝启动(没有围栏的引擎不许起)。非 darwin 没有 seatbelt,不带。
   */
  fence?: ProcessFenceStartInput
}

type StopCommand = SidecarStopCommand
type SidecarCommand = StartCommand | StopCommand

// #613:注入失败随 ready 上报(server.ts 持有同构镜像)——引擎照常起,但 main 必须知情。
// ready 变体的形状与构造住在 sidecar-ready-message.ts(那里有真运行时闸门)。
type SidecarMessage =
  | SidecarReadyMessage
  | { type: "stopped" }
  | { type: "error"; error: { message: string; stack?: string } }

type ParentPort = {
  postMessage(message: SidecarMessage): void
  on(event: "message", listener: (event: { data: unknown }) => void): void
}

type Listener = StoppableListener

const parentPort = getParentPort()
let listener: Listener | undefined

parentPort.on("message", (event) => {
  const command = parseCommand(event.data)
  if (!command) return
  if (command.type === "stop") {
    void stop(command)
    return
  }
  void start(command)
})

async function start(command: StartCommand) {
  try {
    // REQ-159:第一步就是把本进程关进围栏 —— 在写任何文件、import 引擎之前。装不上直接抛,
    // 走下面的 catch:error IPC + exit(1),main 据此宣告这一代失败(响亮,不静默降级成无围栏服务)。
    installProcessFence(command)
    // #613:注入结果必须捕获并随 ready 上报 —— 注入失败 = 引擎起来了但整份 alpha 配置丢失
    // (模型全灰),不上报则 main/renderer 无从与「引擎未就绪」区分。
    const injection = prepareSidecarEnv(
      command.password,
      command.userDataPath,
      command.extPluginPath,
      command.registryChannel,
    )
    ensureLoopbackNoProxy()
    useSystemCertificates()
    useEnvProxy()
    const { Server } = await import("virtual:opencode-server")

    // Start the real per-location graph through the embedded server's authenticated in-process app
    // before socket-listen finishes. Alpha's strict generated-output patch pins the fixed Electron
    // listener to this app's routes and memo map, so the marker and real model handler settle before
    // the renderer's first V2 model call. Start the request before
    // listen so both builds progress in parallel, but do not publish ready until the local prewarm
    // settles:starting the renderer earlier starves the graph build enough to miss #857's 2 s gate.
    const prewarm = prewarmInitialLocation(Server.Default().app, command.initialDirectory, {
      password: command.password,
    })

    listener = await Server.listen({
      port: command.port,
      hostname: command.hostname,
      username: "opencode",
      password: command.password,
      cors: ["oc://renderer"],
    })
    const prewarmResult = await prewarm
    if (prewarmResult.outcome === "ready") console.log("initial governed catalog location prewarmed")
    else console.warn("initial governed catalog location prewarm did not become ready", prewarmResult)
    parentPort.postMessage(buildReadyMessage(injection, prewarmResult))
  } catch (error) {
    parentPort.postMessage({ type: "error", error: serializeError(error) })
    setImmediate(() => process.exit(1))
  }
}

async function stop(command: StopCommand) {
  try {
    await stopSidecarListener(listener, command)
  } finally {
    listener = undefined
    parentPort.postMessage({ type: "stopped" })
    setImmediate(() => process.exit(0))
  }
}

/**
 * REQ-159 `#1321`:darwin 上没有 fence 计划 = 拒绝启动;有则原样 apply(process-fence-apply.ts 会双向
 * 自证:集合外写不进、cwd 写得进)。非 darwin 没有 seatbelt,如实不装(基线:「如实声明」,不是等价围栏)。
 */
function installProcessFence(command: StartCommand) {
  if (process.platform !== "darwin") {
    console.warn(`process fence: not available on ${process.platform} — engine-derived processes run unfenced on this platform`)
    return
  }
  if (!command.fence)
    throw new Error("process fence missing from the start command on darwin — refusing to start the engine unfenced (REQ-159)")
  const applied = applyProcessFence(command.fence)
  console.log(
    `process fence applied: addon=${applied.buildId} libsandbox=${applied.libsandbox} profile=${applied.profileBytes}B — every process this engine spawns inherits it`,
  )
}

function prepareSidecarEnv(
  password: string,
  userDataPath: string,
  extPluginPath?: string,
  registryChannel?: ChannelName,
): AlphaConfigInjectionResult {
  Object.assign(process.env, {
    OPENCODE_SERVER_USERNAME: "opencode",
    OPENCODE_SERVER_PASSWORD: password,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? userDataPath,
  })
  return injectAlphaConfig(userDataPath, extPluginPath, registryChannel)
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
  if (command.type === "stop") return parseSidecarStopCommand(value)
  if (command.type !== "start") return
  if (typeof command.hostname !== "string") return
  if (typeof command.port !== "number") return
  if (typeof command.password !== "string") return
  if (typeof command.userDataPath !== "string") return
  if (typeof command.initialDirectory !== "string") return
  const fence = parseFence(command.fence)
  return {
    type: "start",
    hostname: command.hostname,
    port: command.port,
    password: command.password,
    userDataPath: command.userDataPath,
    initialDirectory: command.initialDirectory,
    ...(fence ? { fence } : {}),
    ...(typeof command.extPluginPath === "string" ? { extPluginPath: command.extPluginPath } : {}),
    ...(command.registryChannel === "stable" ||
    command.registryChannel === "preview" ||
    command.registryChannel === "dev"
      ? { registryChannel: command.registryChannel }
      : {}),
  }
}

/** 形状不对就当没有(darwin 上随后被 installProcessFence 拒掉,而不是带着半个计划去 apply)。 */
function parseFence(value: unknown): ProcessFenceStartInput | undefined {
  if (!value || typeof value !== "object") return
  const fence = value as Partial<ProcessFenceStartInput>
  if (typeof fence.profile !== "string" || typeof fence.addonPath !== "string") return
  return { profile: fence.profile, addonPath: fence.addonPath }
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
