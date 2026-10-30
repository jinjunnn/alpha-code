import path from "node:path"
import { readFile, stat } from "node:fs/promises"
import { createHash } from "node:crypto"
import { pathToFileURL } from "node:url"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Client, type ClientOptions } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport, SseError } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import {
  CallToolResultSchema,
  type CallToolResult,
  ListRootsRequestSchema,
  type LoggingMessageNotification,
  LoggingMessageNotificationSchema,
  type Tool as MCPToolDef,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { Config } from "@/config/config"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { NamedError } from "@opencode-ai/core/util/error"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { withTimeout } from "@/util/timeout"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { McpOAuthPendingProvider, McpOAuthProvider, OAUTH_CALLBACK_PATH } from "./oauth-provider"
import { McpOAuthCallback } from "./oauth-callback"
import { McpAuth } from "./auth"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TuiEvent } from "@/server/tui-event"
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  Layer,
  Context,
  Option,
  Schema,
  ScopedCache,
  Scope,
  Semaphore,
  Stream,
} from "effect"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { McpCatalog } from "./catalog"
import { McpEvent } from "@opencode-ai/schema/mcp-event"
import { McpBrowser } from "./browser"
import {
  governedCredentialFetch,
  governedMcpEvidence,
  isGovernedMcpEntry,
} from "@opencode-ai/plugin/alpha-cloud-authority"
import { ToolAliasLedger, type ToolAuthority, type ToolIdentity } from "@opencode-ai/schema/tool-identity"

const DEFAULT_TIMEOUT = 30_000
const TRANSPORT_ERROR_CODES = new Set(["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "ECONNRESET"])

/**
 * #1547: a connection-level failure — undici's `fetch failed` with a connect-timeout / socket / reset
 * cause, or this module's own connect timeout. An HTTP status from the server is an answer, not one of these.
 */
function isTransportError(error: Error, timeout: number) {
  if (error.message === `Operation timed out after ${timeout}ms`) return true
  const code = (error.cause as { code?: unknown } | undefined)?.code
  return (
    error instanceof TypeError &&
    error.message === "fetch failed" &&
    typeof code === "string" &&
    TRANSPORT_ERROR_CODES.has(code)
  )
}

// undici's `fetch failed` says nothing on its own; the reason is in `cause`.
function describeError(error: Error) {
  return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message
}

// #1563 AC3: background reconnect waits 30 s, doubling per consecutive failure up to 10 min; a success resets it.
const RECONNECT_BASE = 30_000
const RECONNECT_CAP = 600_000
// Remote failure codes that reconnect (`http` only on 5xx, see remoteFailure); every other failure stays failed.
const RECONNECT_CODES = new Set([
  "transport",
  "dns",
  "tcp",
  "connect-timeout",
  "tls-silent",
  "tls-failed",
  "timeout",
  "handshake_timeout",
])

type NetFailureLayer =
  | "policy"
  | "dns"
  | "tcp"
  | "connect-timeout"
  | "tls-silent"
  | "tls-failed"
  | "tls-cert"
  | "http"
  | "timeout"
type NetFailurePath = { via: "egress-proxy"; proxyOrigin: string } | { via: "other" }

/**
 * #1563 interface point. The layered network classifier belongs to the REQ-236 network baseline
 * (`classifyNetFailure(error, path)` in `@opencode-ai/plugin/alpha-net-failure`) and is not merged yet. Until it is,
 * nothing is recognised, so a remote network failure reports `transport` and reconnects; replace this body with
 * that import when it lands.
 */
function classifyNetFailure(
  _error: unknown,
  _path: NetFailurePath,
): { layer: NetFailureLayer; code: string } | undefined {
  return undefined
}

// The engine's proxy variables always name the egress proxy (sidecar-env.ts); loopback targets bypass it (NO_PROXY).
function netPath(url: URL): NetFailurePath {
  const proxy =
    url.protocol === "https:"
      ? (process.env.HTTPS_PROXY ?? process.env.https_proxy)
      : (process.env.HTTP_PROXY ?? process.env.http_proxy)
  if (!proxy || !URL.canParse(proxy) || ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    return { via: "other" }
  return { via: "egress-proxy", proxyOrigin: new URL(proxy).origin }
}
const CLIENT_OPTIONS = {
  capabilities: {
    // https://github.com/anomalyco/opencode/issues/11948
    // sampling: {},
    // https://github.com/anomalyco/opencode/issues/23066
    // elicitation: {},
    // https://github.com/anomalyco/opencode/issues/2308
    roots: {},
    // https://github.com/anomalyco/opencode/issues/28567
    // tasks: {},
  },
} satisfies ClientOptions

export const Resource = Schema.Struct({
  name: Schema.String,
  uri: Schema.String,
  description: Schema.optional(Schema.String),
  mimeType: Schema.optional(Schema.String),
  client: Schema.String,
}).annotate({ identifier: "McpResource" })
export type Resource = Schema.Schema.Type<typeof Resource>

export const ToolsChanged = McpEvent.ToolsChanged

export const BrowserOpenFailed = McpEvent.BrowserOpenFailed

export const Failed = NamedError.create("MCPFailed", {
  name: Schema.String,
})

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("MCP.NotFoundError", {
  name: Schema.String,
}) {}

type MCPClient = Client

function createClient(directory: string) {
  const client = new Client({ name: "opencode", version: InstallationVersion }, CLIENT_OPTIONS)
  client.setRequestHandler(ListRootsRequestSchema, () =>
    Promise.resolve({ roots: [{ uri: pathToFileURL(directory).href }] }),
  )
  return client
}

const StatusConnected = Schema.Struct({ status: Schema.Literal("connected") }).annotate({
  identifier: "MCPStatusConnected",
})
// #1563: a server still starting (the upstream v2 API names this phase `pending` too). `error` is the previous
// attempt's failure, present only while a background reconnect (AC3) is in flight.
const StatusPending = Schema.Struct({
  status: Schema.Literal("pending"),
  error: Schema.optional(Schema.String),
}).annotate({
  identifier: "MCPStatusPending",
})
const StatusDisabled = Schema.Struct({ status: Schema.Literal("disabled") }).annotate({
  identifier: "MCPStatusDisabled",
})
// #1563 AC2: `code` names the cause — workspace_missing / dependency_missing / spawn_failed, handshake_timeout /
// tools_list_failed / auth, or a remote network layer (`transport` when it is not recognised).
const StatusFailed = Schema.Struct({
  status: Schema.Literal("failed"),
  error: Schema.String,
  code: Schema.optional(Schema.String),
}).annotate({
  identifier: "MCPStatusFailed",
})
const StatusNeedsAuth = Schema.Struct({ status: Schema.Literal("needs_auth") }).annotate({
  identifier: "MCPStatusNeedsAuth",
})
const StatusNeedsClientRegistration = Schema.Struct({
  status: Schema.Literal("needs_client_registration"),
  error: Schema.String,
}).annotate({ identifier: "MCPStatusNeedsClientRegistration" })

export const Status = Schema.Union([
  StatusConnected,
  StatusPending,
  StatusDisabled,
  StatusFailed,
  StatusNeedsAuth,
  StatusNeedsClientRegistration,
]).annotate({ identifier: "MCPStatus", discriminator: "status" })
export type Status = Schema.Schema.Type<typeof Status>

// Store transports for OAuth servers to allow finishing auth
type TransportWithAuth = StreamableHTTPClientTransport | SSEClientTransport
const pendingOAuthTransports = new Map<string, { transport: TransportWithAuth; provider?: McpOAuthPendingProvider }>()

// Prompt cache types
type PromptInfo = Awaited<ReturnType<MCPClient["listPrompts"]>>["prompts"][number]
type ResourceInfo = Awaited<ReturnType<MCPClient["listResources"]>>["resources"][number]
type ResourceTemplateInfo = Awaited<ReturnType<MCPClient["listResourceTemplates"]>>["resourceTemplates"][number]
type McpEntry = NonNullable<ConfigV1.Info["mcp"]>[string]

function isMcpConfigured(entry: McpEntry): entry is ConfigMCPV1.Info {
  return typeof entry === "object" && entry !== null && "type" in entry
}

function remoteURL(value: string) {
  if (URL.canParse(value)) return new URL(value)
}

/** Why one startup attempt ended without a connection; `reconnect` = the AC3 background retry applies. */
class ConnectFailure extends Schema.TaggedErrorClass<ConnectFailure>()("MCP.ConnectFailure", {
  status: Status,
  reconnect: Schema.Boolean,
}) {}

const cacheKey = (name: string, generation: number) => `${name}#${generation}`

const failed = (code: string, error: string): Status => ({ status: "failed", error, code })

const digest = (def: MCPToolDef) => createHash("sha256").update(JSON.stringify(def)).digest("hex")

function localFailure(error: Error, timeout: number): Status {
  if (error.message === `Operation timed out after ${timeout}ms`) return failed("handshake_timeout", error.message)
  // Preparing already proved the cwd exists, so a spawn ENOENT means the command itself is missing.
  const spawn = error as NodeJS.ErrnoException
  if (spawn.syscall?.startsWith("spawn") && spawn.code === "ENOENT") return failed("dependency_missing", error.message)
  return failed("spawn_failed", error.message)
}

function remoteFailure(error: Error, url: URL, timeout: number) {
  const message = describeError(error)
  if (error.message === `Operation timed out after ${timeout}ms`)
    return new ConnectFailure({ status: failed("handshake_timeout", message), reconnect: true })
  if ((error instanceof StreamableHTTPError || error instanceof SseError) && (error.code === 401 || error.code === 403))
    return new ConnectFailure({ status: failed("auth", message), reconnect: false })
  const net = classifyNetFailure(error, netPath(url))
  if (!net) return new ConnectFailure({ status: failed("transport", message), reconnect: true })
  return new ConnectFailure({
    status: failed(net.layer, message),
    reconnect: RECONNECT_CODES.has(net.layer) || (net.layer === "http" && Number(net.code) >= 500),
  })
}

interface AuthResult {
  authorizationUrl: string
  oauthState: string
  client?: MCPClient
}

// --- Effect Service ---

/** A live connection: the value under one `name#generation` key of the instance's connection cache. */
interface Connection {
  readonly client: MCPClient
  /** Refreshed in place by `notifications/tools/list_changed`. */
  defs: MCPToolDef[]
  readonly instructions?: string
  readonly authority: ToolAuthority
}

interface Server {
  /** The definition this generation connects with. */
  entry: ConfigMCPV1.Info
  /** Bumped by add / connect / disconnect / reconnect; the cache key is `name#generation`. */
  generation: number
  /** `configured` = this generation has not started yet; reported as `pending` (with the reconnect's last error). */
  status: Status | { status: "configured"; error?: string }
  /** Consecutive background reconnects since the last success (AC3 backoff). */
  retries: number
  /** A client that already finished OAuth: the next lookup adopts it instead of connecting. */
  handoff?: MCPClient
}

interface State {
  config: Record<string, ConfigMCPV1.Info>
  servers: Record<string, Server>
  connections: ScopedCache.ScopedCache<string, Connection, ConnectFailure>
  scope: Scope.Scope
  /** Set by the instance's first-running finalizer: nothing is written back or published after it. */
  disposed: boolean
  bridge: EffectBridge.Shape
}

const isCurrent = (s: State, name: string, generation: number) =>
  !s.disposed && s.servers[name]?.generation === generation

export interface ServerInstructions {
  name: string
  instructions: string
  tools: string[]
}

/** An MCP tool in its native shape; consumers adapt it to their own tool format. */
export interface McpTool {
  /** Shared cached definition; consumers must copy rather than mutate it. */
  readonly def: MCPToolDef
  readonly client: MCPClient
  readonly timeout?: number
  readonly identity?: ToolIdentity
  readonly authority?: ToolAuthority
  /** #1563: the server generation and definition digest this tool was offered with; `callTool` checks both. */
  readonly generation?: number
  readonly defDigest?: string
}

export interface CallToolOptions {
  readonly generation?: number
  readonly defDigest?: string
  readonly timeout?: number
  readonly signal?: AbortSignal
}

export function authorityForMcp(
  name: string,
  entry: ConfigMCPV1.Info,
  env: Record<string, string | undefined> = process.env,
): ToolAuthority {
  const evidence = governedMcpEvidence(name, entry, env)
  if (!evidence) return { kind: "not-asserted" }
  return {
    kind: "alpha-cloud",
    bindingId: `mcp:${encodeURIComponent(name)}`,
    evidenceDigest: `sha256:${createHash("sha256").update(evidence).digest("hex")}`,
  }
}

export interface Interface {
  readonly status: () => Effect.Effect<Record<string, Status>>
  readonly clients: () => Effect.Effect<Record<string, MCPClient>>
  readonly instructions: () => Effect.Effect<ServerInstructions[]>
  readonly tools: () => Effect.Effect<Record<string, McpTool>>
  /**
   * #1129(REQ-131)—— 某个 MCP 配置键(= `ToolIdentity.origin`)的**当前** binding 事实:
   * 生效的配置 entry(动态 `add` 的覆盖静态 config)与当前 authority。执行咽喉在每次调用时
   * 由此重新派生 binding digest(§5:rebind 后旧的 service/tool enabled 必须失效回 ask),
   * inventory 由此给 Settings 发放写 enabled 记录所需的 digest。entry 完全未知返回 undefined
   * (⇒ 调用方派生不出 digest ⇒ 依赖 digest 的放宽按 binding-changed 回 ask,fail-closed)。
   *
   * 方法**可选**是刻意的:上游测试里存量的 `MCP.Service.of` 全量 stub(north-star 不许改)
   * 不必逐个补桩 —— 方法缺席与「facts 未知」同义,方向只会更严(派生不出当前 digest ⇒
   * enabled 记录按 binding-changed 回 ask),永远不会更松。生产 layer 恒有实现。
   */
  readonly bindingFacts?: (
    origin: string,
  ) => Effect.Effect<{ entry?: ConfigMCPV1.Info; authority: ToolAuthority } | undefined>
  /**
   * #1563 AC6 —— 执行入口:按 `origin` 取**当前**连接调用工具,只等这一台服务。服务换代后该工具的定义摘要
   * 与 offer 时不同 ⇒ 响亮失败;相同 ⇒ 用新连接。可选的理由与 `bindingFacts` 相同(上游存量全量 stub
   * 不必逐个补桩);生产 layer 恒有实现。
   */
  readonly callTool?: (
    origin: string,
    name: string,
    args: Record<string, unknown>,
    options: CallToolOptions,
  ) => Effect.Effect<CallToolResult, Error>
  readonly prompts: () => Effect.Effect<Record<string, PromptInfo & { client: string }>>
  readonly resources: (clientName?: string) => Effect.Effect<Record<string, ResourceInfo & { client: string }>>
  readonly resourceTemplates: (
    clientName?: string,
  ) => Effect.Effect<Record<string, ResourceTemplateInfo & { client: string }>>
  readonly add: (name: string, mcp: ConfigMCPV1.Info) => Effect.Effect<{ status: Record<string, Status> | Status }>
  readonly connect: (name: string) => Effect.Effect<void, NotFoundError>
  readonly disconnect: (name: string) => Effect.Effect<void, NotFoundError>
  readonly getPrompt: (
    clientName: string,
    name: string,
    args?: Record<string, string>,
  ) => Effect.Effect<Awaited<ReturnType<MCPClient["getPrompt"]>> | undefined>
  readonly readResource: (
    clientName: string,
    resourceUri: string,
  ) => Effect.Effect<Awaited<ReturnType<MCPClient["readResource"]>> | undefined>
  readonly startAuth: (
    mcpName: string,
  ) => Effect.Effect<{ authorizationUrl: string; oauthState: string }, NotFoundError>
  readonly authenticate: (
    mcpName: string,
    onAuthorization?: (authorizationUrl: string) => void,
  ) => Effect.Effect<Status, NotFoundError>
  readonly finishAuth: (mcpName: string, authorizationCode: string) => Effect.Effect<Status, NotFoundError>
  readonly removeAuth: (mcpName: string) => Effect.Effect<void>
  readonly supportsOAuth: (mcpName: string) => Effect.Effect<boolean, NotFoundError>
  readonly hasStoredTokens: (mcpName: string) => Effect.Effect<boolean>
  readonly getAuthStatus: (mcpName: string) => Effect.Effect<AuthStatus>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MCP") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const auth = yield* McpAuth.Service
    const events = yield* EventV2Bridge.Service
    const browser = yield* McpBrowser.Service
    const cfgSvc = yield* Config.Service
    // #1563 AC5: at most four servers start (spawn + handshake + tools/list) at once, across every instance.
    const startups = yield* Semaphore.make(4)

    type Transport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport

    const descendants = Effect.fnUntraced(
      function* (pid: number) {
        if (process.platform === "win32") return [] as number[]
        const pids: number[] = []
        const queue = [pid]
        for (let index = 0; index < queue.length; index++) {
          const current = queue[index]
          const handle = yield* spawner.spawn(ChildProcess.make("pgrep", ["-P", String(current)], { stdin: "ignore" }))
          const text = yield* Stream.mkString(Stream.decodeText(handle.stdout))
          yield* handle.exitCode
          for (const tok of text.split("\n")) {
            const cpid = parseInt(tok, 10)
            if (!isNaN(cpid) && !pids.includes(cpid)) {
              pids.push(cpid)
              queue.push(cpid)
            }
          }
        }
        return pids
      },
      Effect.scoped,
      Effect.catch(() => Effect.succeed([] as number[])),
    )

    /** Kill a stdio server's descendants (the SDK's close only ends the direct child), then close. Idempotent. */
    const release = (transport: { close(): Promise<void> } | undefined) =>
      Effect.gen(function* () {
        const pid = transport instanceof StdioClientTransport ? transport.pid : null
        if (typeof pid === "number") {
          for (const dpid of yield* descendants(pid)) {
            try {
              process.kill(dpid, "SIGTERM")
            } catch {}
          }
        }
        if (transport) yield* Effect.tryPromise(() => transport.close()).pipe(Effect.ignore)
      })

    /**
     * Connect a client via the given transport. The attempt's scope owns the transport — and a stdio server's whole
     * process tree — from before the spawn: invalidating the key or disposing the instance mid-handshake reaps it,
     * and a failed or interrupted handshake reaps it at once (#1563 AC4).
     */
    const connectTransport = Effect.fn("MCP.connectTransport")(function* (transport: Transport, timeout: number) {
      const directory = yield* InstanceState.directory
      yield* Effect.addFinalizer(() => release(transport))
      return yield* Effect.tryPromise({
        try: () => {
          const client = createClient(directory)
          return withTimeout(client.connect(transport), timeout).then(() => client)
        },
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }).pipe(Effect.onError(() => release(transport)))
    })

    const connectRemote = Effect.fn("MCP.connectRemote")(function* (
      key: string,
      mcp: ConfigMCPV1.Info & { type: "remote" },
    ) {
      const oauthDisabled = mcp.oauth === false
      const oauthConfig = typeof mcp.oauth === "object" ? mcp.oauth : undefined
      const url = remoteURL(mcp.url)
      // An unparseable URL never reaches the network; retrying it cannot help.
      if (!url)
        return yield* new ConnectFailure({
          status: failed("transport", `Invalid MCP URL for "${key}"`),
          reconnect: false,
        })
      let authProvider: McpOAuthProvider | undefined

      if (!oauthDisabled) {
        authProvider = new McpOAuthProvider(
          key,
          mcp.url,
          {
            clientId: oauthConfig?.clientId,
            clientSecret: oauthConfig?.clientSecret,
            scope: oauthConfig?.scope,
            callbackPort: oauthConfig?.callbackPort,
            redirectUri: oauthConfig?.redirectUri,
          },
          {
            onRedirect: async () => {},
          },
          auth,
        )
      }

      const requestInit = mcp.headers ? { headers: mcp.headers } : undefined
      // REQ-236 `#1562`:alpha 治理的云连接器每次请求现读 ALPHA_CLOUD_MCP_DEF 里引用的凭据文件(续期热应用,
      // 引擎不重启);读不到就以认证错误失败,不用已装载条目里的旧字面量。其它条目不传 fetch,行为不变。
      const fetch = isGovernedMcpEntry(key, mcp, process.env)
        ? governedCredentialFetch(process.env, (file) => readFile(file, "utf8"), (input, init) => globalThis.fetch(input, init))
        : undefined
      const streamableHTTP = () => new StreamableHTTPClientTransport(url, { authProvider, requestInit, fetch })
      // A transport serves a single connect(), so every attempt builds a fresh one. #1547: an attempt
      // with `retryAfter` runs only when the previous StreamableHTTP attempt died on the wire.
      const transports: Array<{ name: string; create: () => TransportWithAuth; retryAfter?: number }> = [
        { name: "StreamableHTTP", create: streamableHTTP },
        { name: "StreamableHTTP", create: streamableHTTP, retryAfter: 500 },
        { name: "StreamableHTTP", create: streamableHTTP, retryAfter: 1000 },
        { name: "SSE", create: () => new SSEClientTransport(url, { authProvider, requestInit, fetch }) },
      ]

      const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
      let lastFailure: ConnectFailure | undefined
      let retryable = false
      // StreamableHTTP's transport failure is the real cause; the SSE 405 that follows must not hide it.
      let transportFailure: ConnectFailure | undefined

      for (const { name, create, retryAfter } of transports) {
        if (retryAfter !== undefined) {
          if (!retryable) continue
          yield* Effect.sleep(retryAfter)
        } else if (retryable) transportFailure = lastFailure
        retryable = false
        const transport = create()
        const client = yield* connectTransport(transport, connectTimeout).pipe(
          Effect.catch((error) => {
            const lastError = error instanceof Error ? error : new Error(String(error))
            const isAuthError =
              error instanceof UnauthorizedError || (authProvider && lastError.message.includes("OAuth"))

            if (isAuthError) {
              if (lastError.message.includes("registration") || lastError.message.includes("client_id")) {
                lastFailure = new ConnectFailure({
                  status: {
                    status: "needs_client_registration" as const,
                    error: "Server does not support dynamic client registration. Please provide clientId in config.",
                  },
                  reconnect: false,
                })
                return events
                  .publish(TuiEvent.ToastShow, {
                    title: "MCP Authentication Required",
                    message: `Server "${key}" requires a pre-registered client ID. Add clientId to your config.`,
                    variant: "warning",
                    duration: 8000,
                  })
                  .pipe(Effect.ignore, Effect.as(undefined))
              } else {
                pendingOAuthTransports.set(key, { transport })
                lastFailure = new ConnectFailure({ status: { status: "needs_auth" as const }, reconnect: false })
                return events
                  .publish(TuiEvent.ToastShow, {
                    title: "MCP Authentication Required",
                    message: `Server "${key}" requires authentication. Run: opencode mcp auth ${key}`,
                    variant: "warning",
                    duration: 8000,
                  })
                  .pipe(Effect.ignore, Effect.as(undefined))
              }
            }

            retryable = name === "StreamableHTTP" && isTransportError(lastError, connectTimeout)
            lastFailure = remoteFailure(lastError, url, connectTimeout)
            return Effect.void
          }),
        )
        if (client) return client
        // An auth answer will not change on another transport: stop here and keep it as the cause.
        const answer = lastFailure?.status
        if (
          answer?.status === "needs_auth" ||
          answer?.status === "needs_client_registration" ||
          (answer?.status === "failed" && answer.code === "auth")
        )
          break
      }

      const failure = lastFailure?.status.status === "failed" && transportFailure ? transportFailure : lastFailure
      return yield* failure ?? new ConnectFailure({ status: failed("transport", "Unknown error"), reconnect: true })
    })

    const connectLocal = Effect.fn("MCP.connectLocal")(function* (
      key: string,
      mcp: ConfigMCPV1.Info & { type: "local" },
    ) {
      const [cmd, ...args] = mcp.command
      const baseDir = yield* InstanceState.directory
      const cwd = mcp.cwd ? path.resolve(baseDir, mcp.cwd) : baseDir
      // Preparing is one stat: spawning into a missing cwd fails as `spawn <cmd> ENOENT`, exactly like a missing command.
      const workspace = yield* Effect.promise(() =>
        stat(cwd).then(
          (info) => info.isDirectory(),
          () => false,
        ),
      )
      if (!workspace)
        return yield* new ConnectFailure({
          status: failed("workspace_missing", `MCP working directory does not exist: ${cwd}`),
          reconnect: false,
        })
      const transport = new StdioClientTransport({
        stderr: "pipe",
        command: cmd,
        args: args.map((arg) => (arg === "{workspace}" ? baseDir : arg)),
        cwd,
        env: {
          ...process.env,
          ...(cmd === "opencode" ? { BUN_BE_BUN: "1" } : {}),
          ...mcp.environment,
        },
      })

      const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
      return yield* connectTransport(transport, connectTimeout).pipe(
        Effect.mapError(
          (error) => new ConnectFailure({ status: localFailure(error, connectTimeout), reconnect: false }),
        ),
      )
    })

    /** One startup attempt of one generation: spawn or connect, initialize, then `tools/list` on its own budget (AC7). */
    const attempt = Effect.fnUntraced(function* (name: string, mcp: ConfigMCPV1.Info, handoff: MCPClient | undefined) {
      const client =
        handoff ??
        (mcp.type === "remote"
          ? yield* connectRemote(name, mcp as ConfigMCPV1.Info & { type: "remote" })
          : yield* connectLocal(name, mcp as ConfigMCPV1.Info & { type: "local" }))
      return yield* Effect.gen(function* () {
        const listed = client.getServerCapabilities()?.tools ? yield* McpCatalog.defs(client) : []
        if (!listed)
          return yield* new ConnectFailure({
            status: failed("tools_list_failed", "Failed to get tools"),
            reconnect: false,
          })
        const connection: Connection = {
          client,
          defs: listed,
          instructions: client.getInstructions()?.trim(),
          authority: authorityForMcp(name, mcp),
        }
        return connection
      }).pipe(Effect.onError(() => release(client.transport)))
    })

    function watch(s: State, name: string, generation: number, connection: Connection) {
      const { client } = connection
      client.onclose = () => {
        if (!isCurrent(s, name, generation)) return
        const server = s.servers[name]!
        server.status = failed(server.entry.type === "remote" ? "transport" : "spawn_failed", "Connection closed")
        s.bridge.fork(
          Effect.logWarning("MCP connection closed", { server: name }).pipe(
            Effect.andThen(events.publish(ToolsChanged, { server: name })),
            Effect.andThen(ScopedCache.invalidate(s.connections, cacheKey(name, generation))),
            Effect.ignore,
          ),
        )
      }

      client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) =>
        s.bridge.promise(serverLog(name, notification.params)),
      )

      if (!client.getServerCapabilities()?.tools) return
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        const live = () => isCurrent(s, name, generation) && s.servers[name]?.status.status === "connected"
        if (!live()) return

        const listed = await s.bridge.promise(McpCatalog.defs(client))
        if (!listed || !live()) return

        connection.defs = listed
        await s.bridge.promise(events.publish(ToolsChanged, { server: name }).pipe(Effect.ignore))
      })
    }

    function serverLog(name: string, params: LoggingMessageNotification["params"]) {
      const fields = { server: name, logger: params.logger, level: params.level, data: params.data }
      switch (params.level) {
        case "debug":
          return Effect.logDebug("MCP server log", fields)
        case "info":
        case "notice":
          return Effect.logInfo("MCP server log", fields)
        case "warning":
          return Effect.logWarning("MCP server log", fields)
        case "error":
        case "critical":
        case "alert":
        case "emergency":
          return Effect.logError("MCP server log", fields)
      }
    }

    /**
     * Move `name` to its next generation: the previous key leaves the cache and its process tree is reaped.
     * `error` = the failure a background reconnect is retrying, reported on the new attempt's `pending`.
     */
    const replace = Effect.fnUntraced(function* (
      s: State,
      name: string,
      entry: ConfigMCPV1.Info,
      next: { handoff?: MCPClient; error?: string } = {},
    ) {
      const { handoff, error } = next
      const status: Server["status"] =
        entry.enabled === false
          ? { status: "disabled" }
          : error === undefined
            ? { status: "configured" }
            : { status: "configured", error }
      const server = s.servers[name]
      if (!server) {
        s.servers[name] = { entry, generation: 0, status, retries: 0, handoff }
        return
      }
      const previous = cacheKey(name, server.generation)
      Object.assign(server, { entry, generation: server.generation + 1, status, handoff })
      yield* ScopedCache.invalidate(s.connections, previous)
    })

    /** Start this generation once, in a fiber the instance owns: no reader waits for it (AGENTS.md:107). */
    const start = (s: State, name: string) =>
      Effect.suspend(() => {
        const server = s.servers[name]
        if (s.disposed || server?.status.status !== "configured") return Effect.void
        server.status = { ...server.status, status: "pending" }
        return Effect.forkIn(
          ScopedCache.get(s.connections, cacheKey(name, server.generation)).pipe(Effect.ignore),
          s.scope,
          { startImmediately: true },
        ).pipe(Effect.asVoid)
      })

    /** AC3: retry `name` in the background — 30 s, doubling per consecutive failure, capped at 10 min. */
    const reconnect = (s: State, name: string, generation: number, error: string) => {
      const server = s.servers[name]!
      const delay = Math.min(RECONNECT_BASE * 2 ** server.retries, RECONNECT_CAP)
      server.retries++
      return Effect.sleep(delay).pipe(
        Effect.andThen(
          Effect.suspend(() =>
            isCurrent(s, name, generation)
              ? replace(s, name, server.entry, { error }).pipe(Effect.andThen(start(s, name)))
              : Effect.void,
          ),
        ),
        Effect.forkIn(s.scope),
        Effect.asVoid,
      )
    }

    /** The lookup of one `name#generation` key: one attempt, its outcome written back only while still current. */
    const lookup = (s: State) => (key: string) =>
      Effect.gen(function* () {
        const at = key.lastIndexOf("#")
        const name = key.slice(0, at)
        const generation = Number(key.slice(at + 1))
        const server = s.servers[name]
        if (!server) return yield* Effect.die(new Error(`MCP server ${name} is not configured`))
        const handoff = server.handoff
        server.handoff = undefined
        // Owned by this key's scope from the start, so a replacement before adoption still closes it.
        if (handoff) yield* Effect.addFinalizer(() => release(handoff.transport))

        // A replacement closes this key's scope but does not interrupt the lookup. Queued for a slot (or in the cwd
        // stat) a replaced key must not spawn at all; past that point its late success is closed here (audit F1).
        const exit = yield* startups
          .withPermit(
            Effect.suspend(() =>
              isCurrent(s, name, generation)
                ? attempt(name, server.entry, handoff)
                : Effect.fail(
                    new ConnectFailure({
                      status: { status: "failed", error: "replaced before it started" },
                      reconnect: false,
                    }),
                  ),
            ),
          )
          .pipe(Effect.exit)
        if (Exit.isSuccess(exit)) {
          if (!isCurrent(s, name, generation)) {
            yield* release(exit.value.client.transport)
            return exit.value
          }
          server.status = { status: "connected" }
          server.retries = 0
          watch(s, name, generation, exit.value)
          yield* events.publish(ToolsChanged, { server: name }).pipe(Effect.ignore)
          return exit.value
        }
        if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.failCause(exit.cause)
        const failure = Option.getOrElse(Cause.findErrorOption(exit.cause), () => {
          const error = Cause.squash(exit.cause)
          return new ConnectFailure({
            status: failed(
              server.entry.type === "remote" ? "transport" : "spawn_failed",
              error instanceof Error ? error.message : String(error),
            ),
            reconnect: false,
          })
        })
        if (isCurrent(s, name, generation)) {
          server.status = failure.status
          yield* Effect.logWarning("server unavailable", {
            key: name,
            type: server.entry.type,
            status: failure.status.status,
            error: "error" in failure.status ? failure.status.error : undefined,
          })
          // Readers re-read status on this event; without it a failed background start stays "pending" (audit F3).
          yield* events.publish(ToolsChanged, { server: name }).pipe(Effect.ignore)
          if (failure.reconnect && failure.status.status === "failed")
            yield* reconnect(s, name, generation, failure.status.error)
        }
        return yield* failure
      })

    const state = yield* InstanceState.make<State>(
      Effect.fn("MCP.state")(function* () {
        const cfg = yield* cfgSvc.get()
        const s = {
          config: {},
          servers: {},
          scope: yield* Effect.scope,
          disposed: false,
          bridge: yield* EffectBridge.make(),
        } as Omit<State, "connections"> as State

        for (const [key, mcp] of Object.entries(cfg.mcp ?? {})) {
          if (!isMcpConfigured(mcp)) {
            yield* Effect.logError("Ignoring MCP config entry without type", { key })
            continue
          }
          s.servers[key] = {
            entry: mcp,
            generation: 0,
            status: mcp.enabled === false ? { status: "disabled" } : { status: "configured" },
            retries: 0,
          }
        }

        // Synchronous work only (AGENTS.md:104-107): readers start servers at their call sites. Finalizers run in
        // reverse, so `disposed` below runs before this cache closes (closing it reaps every key's process tree).
        s.connections = yield* ScopedCache.make({ capacity: Number.POSITIVE_INFINITY, lookup: lookup(s) })
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            s.disposed = true
            pendingOAuthTransports.clear()
          }),
        )
        return s
      }),
    )

    /** The instance with every server that has not started yet kicked off; never waits for one (AC1). */
    const read = Effect.fnUntraced(function* () {
      const s = yield* InstanceState.get(state)
      for (const name of Object.keys(s.servers)) yield* start(s, name)
      return s
    })

    /** Servers that are up right now: `getSuccess` neither waits nor starts a lookup. */
    const connected = Effect.fnUntraced(function* (s: State) {
      const result: Array<{ name: string; generation: number; connection: Connection }> = []
      if (s.disposed) return result
      for (const [name, server] of Object.entries(s.servers)) {
        if (server.status.status !== "connected") continue
        const live = yield* ScopedCache.getSuccess(s.connections, cacheKey(name, server.generation))
        if (Option.isSome(live)) result.push({ name, generation: server.generation, connection: live.value })
      }
      return result
    })

    /** The current connection of `name`, waiting only for that server's own attempt (AC1). */
    const connection = Effect.fnUntraced(function* (s: State, name: string) {
      yield* start(s, name)
      const server = s.servers[name]!
      const status = server.status
      if (status.status !== "connected" && status.status !== "pending")
        return yield* new ConnectFailure({ status: status as Status, reconnect: false })
      const generation = server.generation
      // Awaited in a fiber the instance owns: an aborted caller never interrupts (and so never poisons) the attempt.
      const fiber = yield* Effect.forkIn(ScopedCache.get(s.connections, cacheKey(name, generation)), s.scope, {
        startImmediately: true,
      })
      return { connection: yield* Fiber.join(fiber), generation }
    })

    const report = (status: Server["status"]): Status =>
      status.status === "configured" ? { ...status, status: "pending" } : status

    const statuses = (s: State) =>
      Object.fromEntries(Object.entries(s.servers).map(([name, server]) => [name, report(server.status)]))

    /** Replace `name`'s definition and wait for that one server's outcome: explicit actions still answer with it. */
    const settle = Effect.fnUntraced(function* (s: State, name: string, entry: ConfigMCPV1.Info, handoff?: MCPClient) {
      yield* replace(s, name, entry, { handoff })
      yield* connection(s, name).pipe(Effect.ignore)
      return report(s.servers[name]!.status)
    })

    const status = Effect.fn("MCP.status")(function* () {
      return statuses(yield* read())
    })

    const clients = Effect.fn("MCP.clients")(function* () {
      const live = yield* connected(yield* read())
      return Object.fromEntries(live.map((item) => [item.name, item.connection.client]))
    })

    const instructions = Effect.fn("MCP.instructions")(function* () {
      const live = yield* connected(yield* read())
      return live
        .filter((item) => item.connection.instructions)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((item) => ({
          name: item.name,
          instructions: item.connection.instructions!,
          tools: item.connection.defs.map((tool) => McpCatalog.toolName(item.name, tool.name)),
        }))
    })

    const add = Effect.fn("MCP.add")(function* (name: string, mcp: ConfigMCPV1.Info) {
      const s = yield* InstanceState.get(state)
      s.config[name] = mcp
      yield* settle(s, name, mcp)
      return { status: statuses(s) }
    })

    const connect = Effect.fn("MCP.connect")(function* (name: string) {
      const mcp = yield* requireMcpConfig(name)
      yield* settle(yield* InstanceState.get(state), name, { ...mcp, enabled: true })
    })

    const disconnect = Effect.fn("MCP.disconnect")(function* (name: string) {
      const mcp = yield* requireMcpConfig(name)
      yield* replace(yield* InstanceState.get(state), name, { ...mcp, enabled: false })
    })

    function requestTimeout(s: State, name: string, configured: McpEntry | undefined, fallback?: number) {
      const staticTimeout = configured && isMcpConfigured(configured) ? configured.timeout : undefined
      return s.config[name]?.timeout ?? staticTimeout ?? fallback
    }

    const tools = Effect.fn("MCP.tools")(function* () {
      const result: Record<string, McpTool> = {}
      const aliases = new ToolAliasLedger()
      const s = yield* read()

      const cfg = yield* cfgSvc.get()
      const config = cfg.mcp ?? {}
      const defaultTimeout = cfg.experimental?.mcp_timeout

      for (const { name: clientName, generation, connection } of yield* connected(s)) {
        const timeout = requestTimeout(s, clientName, config[clientName], defaultTimeout)
        for (const def of connection.defs) {
          const alias = McpCatalog.toolName(clientName, def.name)
          const identity = { source: "mcp", origin: clientName, name: def.name } as const
          aliases.add(alias, identity)
          result[alias] = {
            def,
            client: connection.client,
            timeout,
            identity,
            authority: connection.authority,
            generation,
            defDigest: digest(def),
          }
        }
      }
      return result
    })

    const callTool = Effect.fn("MCP.callTool")(function* (
      origin: string,
      name: string,
      args: Record<string, unknown>,
      options: CallToolOptions,
    ) {
      const s = yield* InstanceState.get(state)
      if (!s.servers[origin]) return yield* Effect.fail(new Error(`MCP server "${origin}" is not configured`))
      const live = yield* connection(s, origin).pipe(
        Effect.mapError(
          (failure) =>
            new Error(
              `MCP server "${origin}" is not available: ${"error" in failure.status ? failure.status.error : failure.status.status}`,
            ),
        ),
      )
      // A reconnect may have changed what this name means: a call planned against the old definition must not run.
      if (live.generation !== options.generation) {
        const def = live.connection.defs.find((item) => item.name === name)
        if (!def || digest(def) !== options.defDigest)
          return yield* Effect.fail(
            new Error(`MCP tool "${name}" on "${origin}" changed after this request was prepared; retry it`),
          )
      }
      return yield* Effect.tryPromise({
        try: () =>
          live.connection.client.callTool({ name, arguments: args }, CallToolResultSchema, {
            resetTimeoutOnProgress: true,
            signal: options.signal,
            timeout: options.timeout,
            // The MCP SDK only sends a progress token when this hook is present, enabling timeout resets.
            onprogress: () => {},
          }),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      })
    })

    const bindingFacts = Effect.fn("MCP.bindingFacts")(function* (origin: string) {
      const s = yield* InstanceState.get(state)
      const cfg = yield* cfgSvc.get()
      const configured = (cfg.mcp ?? {})[origin]
      const raw = s.config[origin] ?? configured
      const entry = raw !== undefined && isMcpConfigured(raw) ? raw : undefined
      const authority = (yield* connected(s)).find((item) => item.name === origin)?.connection.authority
      if (entry === undefined && authority === undefined) return undefined
      return { entry, authority: authority ?? ({ kind: "not-asserted" } as const) }
    })

    function collectFromConnected<T extends { name: string }>(
      s: State,
      listFn: (c: Client, timeout?: number) => Promise<T[]>,
      label: string,
      key?: (item: T) => string,
      targetClientName?: string,
    ) {
      return Effect.gen(function* () {
        const cfg = yield* cfgSvc.get()
        const live = (yield* connected(s)).filter((item) => !targetClientName || item.name === targetClientName)
        return yield* Effect.forEach(
          live,
          ({ name: clientName, connection }) =>
            McpCatalog.fetch(
              clientName,
              connection.client,
              (c) => listFn(c, requestTimeout(s, clientName, cfg.mcp?.[clientName], cfg.experimental?.mcp_timeout)),
              label,
              key,
            ).pipe(Effect.map((items) => Object.entries(items ?? {}))),
          { concurrency: "unbounded" },
        ).pipe(Effect.map((results) => Object.fromEntries<T & { client: string }>(results.flat())))
      })
    }

    const prompts = Effect.fn("MCP.prompts")(function* () {
      return yield* collectFromConnected(yield* read(), McpCatalog.prompts, "prompts")
    })

    const resources = Effect.fn("MCP.resources")(function* (clientName?: string) {
      return yield* collectFromConnected(
        yield* read(),
        McpCatalog.resources,
        "resources",
        (resource) => resource.uri,
        clientName,
      )
    })

    const resourceTemplates = Effect.fn("MCP.resourceTemplates")(function* (clientName?: string) {
      return yield* collectFromConnected(
        yield* read(),
        McpCatalog.resourceTemplates,
        "resource templates",
        (template) => template.uriTemplate,
        clientName,
      )
    })

    const withClient = Effect.fnUntraced(function* <A>(
      clientName: string,
      fn: (client: MCPClient, timeout?: number) => Promise<A>,
      label: string,
      meta?: Record<string, unknown>,
    ) {
      const s = yield* InstanceState.get(state)
      const live = s.servers[clientName] ? yield* connection(s, clientName).pipe(Effect.option) : Option.none()
      if (Option.isNone(live)) {
        yield* Effect.logWarning(`client not found for ${label}`, { clientName })
        return undefined
      }
      const client = live.value.connection.client
      const cfg = yield* cfgSvc.get()
      return yield* Effect.tryPromise({
        try: () => fn(client, requestTimeout(s, clientName, cfg.mcp?.[clientName], cfg.experimental?.mcp_timeout)),
        catch: (error) => error,
      }).pipe(
        Effect.tapError((error) =>
          Effect.logError(`failed to ${label}`, {
            clientName,
            ...meta,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
        Effect.orElseSucceed(() => undefined),
      )
    })

    const getPrompt = Effect.fn("MCP.getPrompt")(function* (
      clientName: string,
      name: string,
      args?: Record<string, string>,
    ) {
      return yield* withClient(
        clientName,
        (client, timeout) => client.getPrompt({ name, arguments: args }, { timeout }),
        "getPrompt",
        { promptName: name },
      )
    })

    const readResource = Effect.fn("MCP.readResource")(function* (clientName: string, resourceUri: string) {
      return yield* withClient(
        clientName,
        (client, timeout) => client.readResource({ uri: resourceUri }, { timeout }),
        "readResource",
        { resourceUri },
      )
    })

    const getMcpConfig = Effect.fnUntraced(function* (mcpName: string) {
      const s = yield* InstanceState.get(state)
      if (s.config[mcpName]) return s.config[mcpName]

      const cfg = yield* cfgSvc.get()
      const mcpConfig = cfg.mcp?.[mcpName]
      if (!mcpConfig || !isMcpConfigured(mcpConfig)) return undefined
      return mcpConfig
    })

    const requireMcpConfig = Effect.fnUntraced(function* (mcpName: string) {
      const mcpConfig = yield* getMcpConfig(mcpName)
      if (!mcpConfig) return yield* new NotFoundError({ name: mcpName })
      return mcpConfig
    })

    const startAuth = Effect.fn("MCP.startAuth")(function* (mcpName: string) {
      const mcpConfig = yield* requireMcpConfig(mcpName)
      if (mcpConfig.type !== "remote") throw new Error(`MCP server ${mcpName} is not a remote server`)
      if (mcpConfig.oauth === false) throw new Error(`MCP server ${mcpName} has OAuth explicitly disabled`)
      const url = remoteURL(mcpConfig.url)
      if (!url) throw new Error(`Invalid MCP URL for "${mcpName}"`)

      // OAuth config is optional - if not provided, we'll use auto-discovery
      const oauthConfig = typeof mcpConfig.oauth === "object" ? mcpConfig.oauth : undefined

      // Resolve effective redirect URI: explicit redirectUri > callbackPort shorthand > default
      const effectiveRedirectUri =
        oauthConfig?.redirectUri ??
        (oauthConfig?.callbackPort ? `http://127.0.0.1:${oauthConfig.callbackPort}${OAUTH_CALLBACK_PATH}` : undefined)

      // Start the callback server with custom redirectUri if configured
      yield* Effect.promise(() => McpOAuthCallback.ensureRunning(effectiveRedirectUri))

      const oauthState = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
      yield* auth.updateOAuthState(mcpName, oauthState)
      let capturedUrl: URL | undefined
      const authProvider = new McpOAuthPendingProvider(
        mcpName,
        mcpConfig.url,
        {
          clientId: oauthConfig?.clientId,
          clientSecret: oauthConfig?.clientSecret,
          scope: oauthConfig?.scope,
          redirectUri: effectiveRedirectUri,
        },
        {
          onRedirect: async (url) => {
            capturedUrl = url
          },
        },
        auth,
      )

      const transport = new StreamableHTTPClientTransport(url, {
        authProvider,
        requestInit: mcpConfig.headers ? { headers: mcpConfig.headers } : undefined,
      })
      const directory = yield* InstanceState.directory

      return yield* Effect.tryPromise({
        try: () => {
          const client = createClient(directory)
          return client.connect(transport).then(async () => {
            await authProvider.commit()
            return { authorizationUrl: "", oauthState, client } satisfies AuthResult
          })
        },
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) => {
          if (error instanceof UnauthorizedError && capturedUrl) {
            pendingOAuthTransports.set(mcpName, { transport, provider: authProvider })
            return Effect.succeed({ authorizationUrl: capturedUrl.toString(), oauthState } satisfies AuthResult)
          }
          return Effect.die(error)
        }),
      )
    })

    const authenticate = Effect.fn("MCP.authenticate")(function* (
      mcpName: string,
      onAuthorization?: (authorizationUrl: string) => void,
    ) {
      const result = yield* startAuth(mcpName)
      if (!result.authorizationUrl) {
        const client = "client" in result ? result.client : undefined
        const mcpConfig = yield* requireMcpConfig(mcpName).pipe(
          Effect.tapError(() => Effect.tryPromise(() => client?.close() ?? Promise.resolve()).pipe(Effect.ignore)),
        )
        if (!client) return { status: "failed", error: "Failed to get tools" } satisfies Status

        yield* auth.clearOAuthState(mcpName)
        // Already connected and authorized: the next generation adopts this client instead of reconnecting.
        return yield* settle(yield* InstanceState.get(state), mcpName, { ...mcpConfig, enabled: true }, client)
      }

      const callbackPromise = McpOAuthCallback.waitForCallback(result.oauthState, mcpName)
      onAuthorization?.(result.authorizationUrl)

      yield* browser.open(result.authorizationUrl).pipe(
        Effect.catch(() => {
          return events.publish(BrowserOpenFailed, { mcpName, url: result.authorizationUrl }).pipe(Effect.ignore)
        }),
      )

      const code = yield* Effect.promise(() => callbackPromise)

      const storedState = yield* auth.getOAuthState(mcpName)
      if (storedState !== result.oauthState) {
        yield* auth.clearOAuthState(mcpName)
        throw new Error("OAuth state mismatch - potential CSRF attack")
      }
      yield* auth.clearOAuthState(mcpName)
      return yield* finishAuth(mcpName, code)
    })

    const finishAuth = Effect.fn("MCP.finishAuth")(function* (mcpName: string, authorizationCode: string) {
      yield* requireMcpConfig(mcpName)
      const pending = pendingOAuthTransports.get(mcpName)
      if (!pending) throw new Error(`No pending OAuth flow for MCP server: ${mcpName}`)

      const error = yield* Effect.tryPromise({
        try: () => pending.transport.finishAuth(authorizationCode),
        catch: (error) => error,
      }).pipe(
        Effect.match({
          onFailure: (error) => (error instanceof Error ? error.message : String(error)),
          onSuccess: () => undefined,
        }),
      )

      if (error) return { status: "failed", error: `OAuth completion failed: ${error}` } satisfies Status

      yield* Effect.promise(() => pending.provider?.commit() ?? Promise.resolve())
      yield* auth.clearCodeVerifier(mcpName)
      pendingOAuthTransports.delete(mcpName)

      const mcpConfig = yield* requireMcpConfig(mcpName)

      return yield* settle(yield* InstanceState.get(state), mcpName, { ...mcpConfig, enabled: true })
    })

    const removeAuth = Effect.fn("MCP.removeAuth")(function* (mcpName: string) {
      yield* auth.remove(mcpName)
      McpOAuthCallback.cancelPending(mcpName)
      pendingOAuthTransports.delete(mcpName)
    })

    const supportsOAuth = Effect.fn("MCP.supportsOAuth")(function* (mcpName: string) {
      const mcpConfig = yield* requireMcpConfig(mcpName)
      return mcpConfig.type === "remote" && mcpConfig.oauth !== false
    })

    const hasStoredTokens = Effect.fn("MCP.hasStoredTokens")(function* (mcpName: string) {
      const entry = yield* auth.get(mcpName)
      return !!entry?.tokens
    })

    const getAuthStatus = Effect.fn("MCP.getAuthStatus")(function* (mcpName: string) {
      const runtimeConfig = (yield* InstanceState.has(state))
        ? (yield* InstanceState.get(state)).config[mcpName]
        : undefined
      const mcpConfig = runtimeConfig ?? (yield* cfgSvc.get()).mcp?.[mcpName]
      if (!mcpConfig || !isMcpConfigured(mcpConfig) || mcpConfig.type !== "remote") return "not_authenticated"
      const entry = yield* auth.getForUrl(mcpName, mcpConfig.url)
      if (!entry?.tokens) return "not_authenticated"
      if (entry.tokens.expiresAt && entry.tokens.expiresAt < Date.now() / 1000) return "expired"
      return "authenticated"
    })

    return Service.of({
      status,
      clients,
      instructions,
      tools,
      callTool,
      bindingFacts,
      prompts,
      resources,
      resourceTemplates,
      add,
      connect,
      disconnect,
      getPrompt,
      readResource,
      startAuth,
      authenticate,
      finishAuth,
      removeAuth,
      supportsOAuth,
      hasStoredTokens,
      getAuthStatus,
    })
  }),
)

export type AuthStatus = "authenticated" | "expired" | "not_authenticated"

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [CrossSpawnSpawner.node, McpAuth.node, EventV2Bridge.node, Config.node, McpBrowser.node],
})

export * as MCP from "."
