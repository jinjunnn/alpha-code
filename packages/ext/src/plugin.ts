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
  return {
    // tool map: key === final tool id verbatim (no namespace prefix).
    tool: {
      // REQ-036 生效闭环:会话内创建/编辑 skill·agent·command 后,引擎实例不会自动重扫(无文件
      // 监听)。本工具调上游公开 POST /instance/dispose(ADR-014 v3 的 dispose 语义)使实例惰性
      // 重建 —— 新建物从「下一条消息」起可用,无需重启 app。对本条流式回复的影响在 S18 X9 实测。
      alpha_reload: tool({
        description:
          "Reload the opencode engine's extension registry (skills / agents / commands / plugins) without restarting the app. Call this after creating or editing a skill or agent on disk so it becomes available from the NEXT message in this session. Returns whether the reload was accepted.",
        args: {
          reason: tool.schema.string().describe("What was created/changed (for the tool log)").default(""),
        },
        async execute(args, ctx) {
          try {
            const res = await input.client.instance.dispose()
            if ((res as { error?: unknown })?.error) throw new Error(JSON.stringify((res as { error?: unknown }).error))
            return {
              title: "alpha_reload",
              output:
                "reload accepted — the engine instance rebuilds lazily; newly created skills/agents/commands are available from the next message in this session." +
                (args.reason ? `\nreason: ${args.reason}` : ""),
              metadata: { ok: true, directory: ctx.directory },
            }
          } catch (error) {
            // honest degradation: creation still succeeded on disk; only the hot-reload failed
            return {
              title: "alpha_reload",
              output:
                "reload FAILED — the engine did not accept the dispose request; newly created skills/agents will only appear after the app restarts. " +
                `(${error instanceof Error ? error.message : String(error)})`,
              metadata: { ok: false, directory: ctx.directory },
            }
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
    // event hook: liveness proof. Gated behind ALPHA_EXT_VERBOSE so it is silent by default.
    async event({ event }) {
      if (process.env.ALPHA_EXT_VERBOSE) console.log(`[@alpha-code/ext] event: ${event.type}`)
    },
  }
}

export default AlphaExt
