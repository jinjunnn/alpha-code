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
    prepareSidecarEnv(command.password, command.userDataPath)
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

function prepareSidecarEnv(password: string, userDataPath: string) {
  Object.assign(process.env, {
    OPENCODE_SERVER_USERNAME: "opencode",
    OPENCODE_SERVER_PASSWORD: password,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? userDataPath,
  })
  injectAlphaConfig(userDataPath)
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
// This is also the seam for loading @alpha-code/ext once it ships inside the .app: add
// `plugin: [<abs path to ext dist>]` to the same config object. Left out until G1 ships the
// ext bundle into resources and validates the zod cross-instance path (see ADR-006).
function injectAlphaConfig(userDataPath: string) {
  try {
    const existing = process.env.OPENCODE_CONFIG_CONTENT
    const config = existing ? JSON.parse(existing) : { $schema: "https://opencode.ai/config.json" }

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
