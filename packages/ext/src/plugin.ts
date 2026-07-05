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
  // 而是登记「待重载」,由 event 钩子在**登记会话 session.idle(回复完成)后**执行 —— 新建的
  // skill/agent/command 从下一条消息起可用,且不牺牲当前这条回复。
  //
  // codex 审计修复:① per-session Map(并发会话各自的承诺不被覆盖;任一登记会话 idle 即全局
  // dispose 一次、清空全表 —— dispose 本就是全局重扫);② 陈旧兜底:登记超 5 分钟后,任何会话的
  // idle 都可触发(登记会话 error/中断后承诺仍能兑现);③ dispose 失败保留待重试(下一次 idle),
  // 连败 3 次 loud 放弃(server log)。
  const pendingReloads = new Map<string, { reason: string; at: number }>()
  let reloadAttempts = 0
  const STALE_MS = 5 * 60 * 1000

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
          pendingReloads.set(ctx.sessionID ?? "", { reason: args.reason, at: Date.now() })
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
    // event hook: ① alpha_reload 两段式的执行端 —— 登记会话 idle(或存在陈旧登记时任意 idle)才
    // dispose,防止打断进行中的流(X9);② liveness proof(ALPHA_EXT_VERBOSE 时打印事件)。
    async event({ event }) {
      if (process.env.ALPHA_EXT_VERBOSE) console.log(`[@alpha-code/ext] event: ${event.type}`)
      if (pendingReloads.size === 0 || event.type !== "session.idle") return
      const sid = (event as { properties?: { sessionID?: string } }).properties?.sessionID
      const now = Date.now()
      const hasStale = [...pendingReloads.values()].some((p) => now - p.at > STALE_MS)
      // 触发条件:idle 的正是某个登记会话(其回复已完成,dispose 不再伤及它),或存在陈旧登记
      // (登记会话可能已 error/被弃,由任意会话的安全 idle 点兜底兑现)。
      if (!(sid && pendingReloads.has(sid)) && !hasStale) return
      const reasons = [...pendingReloads.values()].map((p) => p.reason).filter(Boolean)
      try {
        await input.client.instance.dispose()
        pendingReloads.clear()
        reloadAttempts = 0
        console.log(`[@alpha-code/ext] alpha_reload executed after idle${reasons.length ? ` (${reasons.join("; ")})` : ""}`)
      } catch (error) {
        // 保留登记,下一次 idle 重试;连败 3 次 loud 放弃(诚实降级:重启后生效)。
        reloadAttempts += 1
        const msg = error instanceof Error ? error.message : String(error)
        if (reloadAttempts >= 3) {
          pendingReloads.clear()
          reloadAttempts = 0
          console.error(`[@alpha-code/ext] alpha_reload dispose FAILED 3x — giving up; new skills/agents appear after app restart: ${msg}`)
        } else {
          console.error(`[@alpha-code/ext] alpha_reload dispose failed (attempt ${reloadAttempts}/3, will retry on next idle): ${msg}`)
        }
      }
    },
  }
}

export default AlphaExt
