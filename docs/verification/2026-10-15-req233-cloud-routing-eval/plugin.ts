import { AlphaExt } from "../../../packages/ext/src/plugin"
import type { Plugin } from "../../../packages/plugin/src"
import type { PermissionV1 } from "../../../packages/core/src/v1/permission"
import { realpath } from "node:fs/promises"
import { relative, resolve, sep } from "node:path"

// Load the real ext; replace its execution boundary before it can inspect tool arguments/files.
export default (async (input) => {
  const hooks = await AlphaExt(input)
  const roots = JSON.parse(process.env.ALPHA_FACTORY_SKILL_DIRS!) as string[]
  const files = await Array.fromAsync(new Bun.Glob("**/SKILL.md").scan({ cwd: roots[0], absolute: true }))
  const skills = new Map(await Promise.all(files.map(async (file) => [/^name:\s*(.+)$/m.exec(await Bun.file(file).text())![1], file] as const)))
  // Only archived skill instructions may reach the native read/skill implementations.
  async function instruction(tool: string, args: { name?: string; filePath?: string }) {
    if (tool === "skill") return { tool, name: args.name, path: skills.get(args.name ?? "") }
    if (tool !== "read" || !args.filePath) return
    const file = await realpath(resolve(input.directory, args.filePath)).catch(() => undefined)
    if (!file || !/\.(md|txt|json|ya?ml)$/i.test(file)) return
    const inside = relative(roots[0], file)
    if (inside.startsWith(`..${sep}`) || inside === ".." || inside.startsWith(sep)) return
    return { tool, path: file }
  }
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
      if (identity.source === "builtin" && await instruction(identity.name, request.metadata.args as { name?: string; filePath?: string } ?? {})) {
        await fetch(new URL(`/permission/${request.id}/reply`, input.serverUrl), { method: "POST", headers: { "content-type": "application/json", "x-opencode-directory": input.directory }, body: JSON.stringify({ reply: "once" }) })
        return
      }
      // Identity permission can precede tool.execute.before. Record the chosen tool, then abort;
      // Non-instruction permissions are never approved or allowed to reach a tool body.
      await fetch(`${process.env.EVAL_CONTROL_URL}/decision`, {
        method: "POST",
        body: JSON.stringify({ tool: identity.source === "mcp" ? `${identity.origin}_${identity.name}` : identity.name, sessionID: request.sessionID }),
      })
    },
    "tool.execute.before": async (info, output) => {
      const loading = await instruction(info.tool, output.args)
      if (loading) {
        await fetch(`${process.env.EVAL_CONTROL_URL}/instruction`, { method: "POST", body: JSON.stringify({ ...loading, sessionID: info.sessionID }) })
        if (!loading.path) throw new Error("EVAL_STUB: skill not in archived factory directory")
        return
      }
      await fetch(`${process.env.EVAL_CONTROL_URL}/decision`, {
        method: "POST",
        body: JSON.stringify({ tool: info.tool, sessionID: info.sessionID }),
      })
      // Every non-instruction tool still returns a fixed result without executing its body.
      throw new Error("EVAL_STUB: first action recorded; no tool side effects")
    },
  }
}) satisfies Plugin
