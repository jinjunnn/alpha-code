import { AlphaExt } from "../../../packages/ext/src/plugin"
import type { Plugin } from "../../../packages/plugin/src"
import type { PermissionV1 } from "../../../packages/core/src/v1/permission"

// Load the real ext; replace its execution boundary before it can inspect tool arguments/files.
export default (async (input) => {
  const hooks = await AlphaExt(input)
  await fetch(`${process.env.EVAL_CONTROL_URL}/loaded`, { method: "POST" })
  return {
    ...hooks,
    event: async (info) => {
      // The V1 plugin SDK's event union predates this engine event; use the engine's request type.
      const event: { type: string; properties: unknown } = info.event
      if (event.type !== "permission.asked") return hooks.event?.(info)
      const request = event.properties as PermissionV1.Request
      const identity = request.metadata.identity as { source: string; origin: string; name: string } | undefined
      if (!identity) return
      // Identity permission can precede tool.execute.before. Record the chosen tool, then abort;
      // this harness never approves permissions or waits for a human/tool body.
      await fetch(`${process.env.EVAL_CONTROL_URL}/decision`, {
        method: "POST",
        body: JSON.stringify({ tool: identity.source === "mcp" ? `${identity.origin}_${identity.name}` : identity.name, sessionID: request.sessionID }),
      })
    },
    "tool.execute.before": async (info) => {
      await fetch(`${process.env.EVAL_CONTROL_URL}/decision`, {
        method: "POST",
        body: JSON.stringify({ tool: info.tool, sessionID: info.sessionID }),
      })
      // Fixed tool result, including for builtins (read/bash/question/skill). No real body runs.
      throw new Error("EVAL_STUB: first action recorded; no tool side effects")
    },
  }
}) satisfies Plugin
