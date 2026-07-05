import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

/**
 * alpha-code backend isolation extension.
 *
 * A zero-edit opencode server plugin. In the fork model this package is a NATIVE
 * workspace member, so `@opencode-ai/plugin` resolves via `workspace:*` with no
 * symlink hacks. It is loaded into the embedded server through
 * OPENCODE_CONFIG_CONTENT injected by ui-mac's sidecar — opencode's own files are
 * never touched.
 *
 * Contract (packages/plugin/src/index.ts):
 *   Plugin = (input: PluginInput, options?) => Promise<Hooks>
 */
export const AlphaExt: Plugin = async (input) => {
  // REQ-036 生效闭环,两段式(S18 X9 实测拍板):/instance/dispose 会**打断进行中的流式回复**
  // (实测:流中 dispose → assistant 消息 err 终止、0 字)。因此 alpha_reload 不立即 dispose,
  // 而是登记「待重载」,由 event 钩子在**本会话 session.idle(回复完成)后**执行 —— 新建的
  // skill/agent/command 从下一条消息起可用,且不牺牲当前这条回复。
  let pendingReload: { sessionID?: string; reason: string } | null = null

  return {
    // tool map: key === final tool id verbatim (no namespace prefix).
    tool: {
      alpha_reload: tool({
        description:
          "Schedule a reload of the opencode engine's extension registry (skills / agents / commands / plugins) without restarting the app. Call this after creating or editing a skill or agent on disk. The reload runs right after the current reply finishes (an immediate reload would cut this reply off), so the new skill/agent is available from the NEXT message in this session.",
        args: {
          reason: tool.schema.string().describe("What was created/changed (for the tool log)").default(""),
        },
        async execute(args, ctx) {
          pendingReload = { sessionID: ctx.sessionID, reason: args.reason }
          return {
            title: "alpha_reload",
            output:
              "reload scheduled — it runs as soon as this reply completes; newly created skills/agents/commands are available from the NEXT message in this session." +
              (args.reason ? `\nreason: ${args.reason}` : ""),
            metadata: { ok: true, scheduled: true, directory: ctx.directory, sessionID: ctx.sessionID },
          }
        },
      }),
      alpha_echo: tool({
        description:
          "Echo back the provided text. Proof that an alpha-code plugin-registered tool is available with zero opencode source edits.",
        args: {
          text: tool.schema.string().describe("The text to echo back"),
          shout: tool.schema.boolean().describe("Uppercase the echoed text").default(false),
        },
        async execute(args, ctx) {
          const echoed = args.shout ? args.text.toUpperCase() : args.text
          return {
            title: "alpha_echo",
            output: `alpha_echo: ${echoed}`,
            metadata: { sessionID: ctx.sessionID, directory: ctx.directory, shout: args.shout },
          }
        },
      }),
      alpha_ping: tool({
        description:
          "Health-check tool: returns 'pong' plus the session directory. Proof that the alpha-code extension is loaded.",
        args: {
          note: tool.schema.string().describe("Optional note echoed back with the pong").default(""),
        },
        async execute(args, ctx) {
          const suffix = args.note ? ` (${args.note})` : ""
          return {
            title: "alpha_ping",
            output: `pong${suffix}\ndirectory: ${ctx.directory}\nworktree: ${ctx.worktree}`,
            metadata: { directory: ctx.directory, worktree: ctx.worktree },
          }
        },
      }),
    },
    // event hook: ① alpha_reload 两段式的执行端 —— 本会话回复完成(session.idle)后才 dispose,
    // 防止打断自己的流(X9);sessionID 不匹配的 idle 不触发(别的会话仍在跑时先不重载)。
    // ② liveness proof(ALPHA_EXT_VERBOSE 时打印事件)。
    async event({ event }) {
      if (process.env.ALPHA_EXT_VERBOSE) console.log(`[@alpha-code/ext] event: ${event.type}`)
      if (pendingReload && event.type === "session.idle") {
        const sid = (event as { properties?: { sessionID?: string } }).properties?.sessionID
        if (pendingReload.sessionID && sid && sid !== pendingReload.sessionID) return
        const reason = pendingReload.reason
        pendingReload = null
        try {
          await input.client.instance.dispose()
          console.log(`[@alpha-code/ext] alpha_reload executed after idle${reason ? ` (${reason})` : ""}`)
        } catch (error) {
          // honest degradation: creation still succeeded on disk; only the hot-reload failed.
          console.error(
            `[@alpha-code/ext] alpha_reload dispose FAILED — new skills/agents appear after app restart: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    },
  }
}

export default AlphaExt
