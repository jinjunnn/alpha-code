import * as Tool from "./tool"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { Cause, Effect, Schema } from "effect"
import { CodeMode, Tool as SandboxTool, toolError } from "@opencode-ai/codemode"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { AlphaToolPolicy, mcpBindingDigest } from "@/permission/alpha-tool-policy"
import { AlphaToolPolicyGate } from "@/permission/alpha-tool-policy-gate"

export const CODE_MODE_TOOL = "execute"

const DESCRIPTION = "Run a confined orchestration script with access to connected MCP tools."

export const Parameters = Schema.Struct({
  code: Schema.String.annotate({
    description: "Script body executed by the confined interpreter.",
  }),
})

type CallEntry = { tool: string; status: "running" | "completed" | "error"; input?: Record<string, unknown> }

type Metadata = {
  toolCalls: CallEntry[]
  error?: boolean
}

type Attachment = NonNullable<Tool.ExecuteResult["attachments"]>[number]

type CatalogEntry = {
  path: string
  key: string
  server: string
  local: string
  tool: MCP.McpTool
}

function groupByServer(mcpTools: Record<string, MCP.McpTool>): Map<string, CatalogEntry[]> {
  const groups = new Map<string, CatalogEntry[]>()
  for (const key of Object.keys(mcpTools).sort((a, b) => a.localeCompare(b))) {
    const tool = mcpTools[key]!
    if (!tool.identity || tool.identity.source !== "mcp")
      throw new Error(`MCP tool ${key} is missing its source identity`)
    const server = McpCatalog.sanitize(tool.identity.origin)
    const local = McpCatalog.sanitize(tool.identity.name)
    const entry: CatalogEntry = {
      path: `${server}.${local}`,
      key,
      server,
      local,
      tool,
    }
    groups.set(server, [...(groups.get(server) ?? []), entry])
  }
  return groups
}

export function describeCatalog(mcpTools: Record<string, MCP.McpTool>, _servers: readonly string[] = []): string {
  return CodeMode.make({
    tools: toolTree(
      [...groupByServer(mcpTools).values()].flat(),
      () => () => Effect.fail(toolError("Tool preview is not executable.")),
    ),
  }).instructions()
}

const lastSegment = (uri: string) => {
  const trimmed = uri.split(/[?#]/, 1)[0]!.replace(/\/+$/, "")
  const segment = trimmed.slice(trimmed.lastIndexOf("/") + 1)
  return segment.length > 0 ? segment : undefined
}

const dataUrl = (mime: string, base64: string) => `data:${mime};base64,${base64}`

function projectMcpResult(result: CallToolResult, collect: (attachment: Attachment) => void): unknown {
  const text: string[] = []
  let files = 0
  let images = 0
  const push = (attachment: Attachment) => {
    files += 1
    if (attachment.mime.startsWith("image/")) images += 1
    collect(attachment)
  }
  for (const block of result.content) {
    switch (block.type) {
      case "text":
        text.push(block.text)
        break
      case "image":
      case "audio":
        push({ type: "file", mime: block.mimeType, url: dataUrl(block.mimeType, block.data) })
        break
      case "resource": {
        if ("text" in block.resource) {
          text.push(block.resource.text)
          break
        }
        const mime = block.resource.mimeType ?? "application/octet-stream"
        push({ type: "file", mime, url: dataUrl(mime, block.resource.blob), filename: lastSegment(block.resource.uri) })
        break
      }
      case "resource_link":
        // A link is a reference, not fetchable media; hand it to the program instead of the attachment channel.
        text.push(`${block.name}: ${block.uri}`)
        break
    }
  }

  if (result.structuredContent !== undefined && result.structuredContent !== null) return result.structuredContent
  if (text.length > 0) return text.join("\n")
  if (files > 0) {
    const noun = files === images ? "image" : "file"
    return `[${files} ${noun}${files === 1 ? "" : "s"} attached to the result]`
  }
  return null
}

type Run = (input: unknown) => Effect.Effect<unknown, unknown>

function toolTree(catalog: readonly CatalogEntry[], run: (entry: CatalogEntry) => Run) {
  const tree: Record<string, Record<string, SandboxTool.Definition>> = {}
  for (const entry of catalog) {
    const namespace = (tree[entry.server] ??= {})
    namespace[entry.local] = SandboxTool.make({
      description: entry.tool.def.description ?? "",
      input: entry.tool.def.inputSchema as SandboxTool.JsonSchema,
      output: entry.tool.def.outputSchema as SandboxTool.JsonSchema | undefined,
      run: run(entry),
    })
  }
  return tree
}

const invokeChildTool = Effect.fn("CodeMode.invokeChildTool")(function* (input: {
  plugin: Plugin.Interface
  policy: AlphaToolPolicy.Interface
  permission: Permission.Interface
  mcp: MCP.Interface
  ruleset: PermissionV1.Ruleset
  entry: CatalogEntry
  args: Record<string, unknown>
  callID: string
  ctx: Tool.Context
}) {
  // #1129 / #724 §6 E4:子工具不走 register wrapper,这里是它唯一的 identity 闸,与 E1-E3 同一 gate、
  // 同一次序(REQ-236 C2 / #1574):decide(文档轴 deny ⇒ 具名拒绝,插件钩子看不到这次调用)→
  // `tool.execute.before` 钩子 → confirm(按钩子之后的 args 问,批准后复核停用与重绑)→ 传输。
  // 主权 kill-switch 钩子仍无条件先于传输执行,任何 ask 放行都跳不过它(ext 的
  // cloud-websearch-kill.test.ts 钉住这半边)。策略文档轴在**每次子调用时重读**,当前 binding
  // 也重新派生 —— 子工具全是 MCP,rebind 后旧的 service/tool enabled 回 ask。
  const identity = input.entry.tool.identity
  if (!identity) throw new Error(`MCP tool ${input.entry.key} is missing its source identity`)
  const gate = {
    policy: input.policy,
    subject: Effect.gen(function* () {
      const facts = input.mcp.bindingFacts ? yield* input.mcp.bindingFacts(identity.origin) : undefined
      return {
        identity,
        authority: facts?.authority ?? ({ kind: "not-asserted" } as const),
        bindingDigest: facts?.entry ? mcpBindingDigest(identity.origin, facts.entry) : undefined,
        // #1285:子工具全是 MCP —— 目的地(transport)随身份轴那一问供数。
        transport: AlphaToolPolicyGate.mcpTransportFact(facts?.entry),
        // #1617:执行位置(与时间线同一份派生)随那一问送到审批卡。
        location: AlphaToolPolicyGate.mcpLocation(facts?.entry),
      }
    }),
    ruleset: input.ruleset,
  }
  const decision = yield* AlphaToolPolicyGate.decide(gate).pipe(Effect.orDie)
  yield* input.plugin.trigger(
    "tool.execute.before",
    { tool: input.entry.key, sessionID: input.ctx.sessionID, callID: input.callID },
    { args: input.args },
  )
  yield* AlphaToolPolicyGate.confirm(decision, {
    ...gate,
    permission: input.permission,
    sessionID: input.ctx.sessionID,
    tool: { messageID: input.ctx.messageID, callID: input.callID },
    metadata: {},
    // #1285:载荷供数(与 E1-E3 同一口径;钩子之后的那一份)。
    args: input.args,
  }).pipe(Effect.orDie)
  const result: CallToolResult = yield* Effect.gen(function* () {
    // #1563 AC6: the MCP service's entry picks the server's *current* connection (the catalog's captured client is not
    // used to call); the isError projection deliberately mirrors McpCatalog.convertTool, keeping the service free of
    // tool-loop concerns.
    if (!input.mcp.callTool) return yield* Effect.die(new Error(`MCP tool ${input.entry.key} has no execution entry`))
    const raw = yield* input.mcp
      .callTool(identity.origin, input.entry.tool.def.name, input.args, {
        generation: input.entry.tool.generation,
        defDigest: input.entry.tool.defDigest,
        timeout: input.entry.tool.timeout,
        signal: input.ctx.abort,
      })
      .pipe(Effect.orDie)
    if (raw.isError)
      return yield* Effect.die(
        new Error(
          raw.content
            .flatMap((item) => (item.type === "text" ? [item.text] : []))
            .filter((text) => text.trim())
            .join("\n\n") || "MCP tool returned an error",
        ),
      )
    return raw
  }).pipe(
    Effect.withSpan("Tool.execute", {
      attributes: {
        "tool.name": input.entry.key,
        "tool.call_id": input.callID,
        "session.id": input.ctx.sessionID,
        "message.id": input.ctx.messageID,
      },
    }),
  )
  yield* input.plugin.trigger(
    "tool.execute.after",
    { tool: input.entry.key, sessionID: input.ctx.sessionID, callID: input.callID, args: input.args },
    result,
  )
  return result
})

export const CodeModeTool = Tool.define(
  CODE_MODE_TOOL,
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const agents = yield* Agent.Service
    const sessions = yield* Session.Service
    const plugin = yield* Plugin.Service
    const permission = yield* Permission.Service
    const toolPolicy = yield* AlphaToolPolicy.Service

    const init: Tool.DefWithoutID<typeof Parameters, Metadata> = {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: Effect.fn("CodeMode.execute")(function* (params, ctx) {
        if (ctx.abort.aborted) {
          return {
            title: CODE_MODE_TOOL,
            metadata: { toolCalls: [], error: true },
            output: "Execution cancelled.",
          } satisfies Tool.ExecuteResult<Metadata>
        }
        const agent = yield* agents.get(ctx.agent)
        const session = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
        const ruleset = Permission.merge(agent.permission, session.permission ?? [])
        const rulesetVisible = Permission.visibleTools(yield* mcp.tools(), ruleset)
        // #1129 / #724 §6 E4:「disabled child 也不进 child catalog」的第二条轴 ——
        // 策略文档轴按当轮 snapshot 判 deny(ask 照旧进目录,由上面的执行闸负责问)。
        const childPolicyDenied = yield* AlphaToolPolicyGate.snapshotCatalogDenied(
          toolPolicy,
          Object.entries(rulesetVisible).map(([technicalId, item]) => ({
            technicalId,
            identity: item.identity!,
            authority: item.authority ?? ({ kind: "not-asserted" } as const),
          })),
          ruleset,
        )
        const mcpTools = Object.fromEntries(
          Object.entries(rulesetVisible).filter(([technicalId]) => !childPolicyDenied.has(technicalId)),
        )
        const catalog = [...groupByServer(mcpTools).values()].flat()

        const calls: CallEntry[] = []
        const attachments: Attachment[] = []
        const publish = () =>
          ctx.metadata({ title: CODE_MODE_TOOL, metadata: { toolCalls: calls.map((c) => ({ ...c })) } })

        let childCalls = 0
        const callTool = (entry: CatalogEntry) => (input: unknown) =>
          Effect.gen(function* () {
            childCalls += 1
            const result = yield* invokeChildTool({
              plugin,
              policy: toolPolicy,
              permission,
              mcp,
              ruleset,
              entry,
              args: (input ?? {}) as Record<string, unknown>,
              callID: `${ctx.callID ?? entry.key}/${childCalls}`,
              ctx,
            })
            return projectMcpResult(result, (attachment: Attachment) => void attachments.push(attachment))
          }).pipe(
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
              const error = Cause.squash(cause)
              return Effect.fail(toolError(error instanceof Error ? error.message : String(error), error))
            }),
          )

        const runtime = CodeMode.make({
          tools: toolTree(catalog, callTool),
          onToolCallStart: ({ index, name, input }) =>
            Effect.suspend(() => {
              const shown = (() => {
                if (input === null || input === undefined) return
                if (typeof input === "object" && !Array.isArray(input)) {
                  const value = input as Record<string, unknown>
                  return Object.keys(value).length > 0 ? value : undefined
                }
                return { input }
              })()
              calls[index] = { tool: name, status: "running", ...(shown ? { input: shown } : {}) }
              return publish()
            }),
          onToolCallEnd: ({ index, outcome }) =>
            Effect.suspend(() => {
              const current = calls[index]
              if (current) calls[index] = { ...current, status: outcome === "success" ? "completed" : "error" }
              return publish()
            }),
        })

        const abort = Effect.callback<void>((resume) => {
          if (ctx.abort.aborted) return resume(Effect.void)
          const handler = () => resume(Effect.void)
          ctx.abort.addEventListener("abort", handler, { once: true })
          return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
        })
        const cancelled = (): CodeMode.Result => ({
          ok: false,
          error: { kind: "ExecutionFailure", message: "Execution cancelled." },
          toolCalls: calls.map((call) => ({ name: call.tool })),
        })

        const result = yield* Effect.raceFirst(runtime.execute(params.code), abort.pipe(Effect.map(cancelled)))
        const logs = result.logs ?? []
        const withLogs = (text: string) => {
          if (logs.length === 0) return text
          return text.length > 0 ? `${text}\n\nLogs:\n${logs.join("\n")}` : `Logs:\n${logs.join("\n")}`
        }

        if (!result.ok) {
          if (ctx.abort.aborted) {
            return {
              title: CODE_MODE_TOOL,
              metadata: { toolCalls: calls, error: true },
              output: "Execution cancelled.",
            } satisfies Tool.ExecuteResult<Metadata>
          }
          const hints = (result.error.suggestions ?? []).filter((hint) => !result.error.message.includes(hint))
          return yield* Effect.fail(new Error(withLogs([result.error.message, ...hints].join("\n"))))
        }

        // The interpreter validates returned values as plain JSON, so stringify cannot throw;
        // it yields undefined only for a program that returns undefined.
        const output =
          typeof result.value === "string"
            ? result.value
            : (JSON.stringify(result.value, null, 2) ?? String(result.value))

        return {
          title: CODE_MODE_TOOL,
          metadata: { toolCalls: calls },
          output: withLogs(output),
          ...(attachments.length > 0 ? { attachments } : {}),
        } satisfies Tool.ExecuteResult<Metadata>
      }, Effect.orDie),
    }
    return init
  }),
)
