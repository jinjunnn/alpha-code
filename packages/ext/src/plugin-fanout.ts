// REQ-060 plugin host fan-out:项目级 plugin(`<dir>/.alpha/plugins/*.js`)不能经 config.plugin[] 加载
// —— config hook 是引擎「插件已加载完」后的 Notify,改 plugin[] 太晚(鸡生蛋)。故由 host 插件
// (@alpha-code/ext)在 per-instance init 时动态 import 项目插件、拿到它们的 Hooks,与自身 Hooks **合并**
// 后一并 return,引擎照常派发 —— 项目插件的 hook 得以生效,项目零 `.opencode`、零 config.plugin[]。
//
// 信任门(安全红线):项目 plugin = 可执行 JS,只在项目已 consent 时加载(loadProjectPlugins 门控)。
// ADR-006:项目 plugins 必须是**自包含 ESM JS**(生 TS 桌面必崩)—— 只收 .js,加载失败 loud 不阻断。

/** Hooks 合并(纯逻辑,单测覆盖):tool = map 浅并(own 优先,保护 alpha 工具不被项目覆盖);其余 hook
 *  = 函数,转发为「依次调用 own 再各项目插件」(event/config/chat.* 等都是通知或变异 output/cfg,
 *  串行调用语义正确)。own 的 hook 永远先跑。 */
export function mergeHooks(
  own: Record<string, unknown>,
  others: Record<string, unknown>[],
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...own }

  // tool:map 浅并,own 键优先(项目插件不得覆盖 alpha_reload/echo/ping)
  const toolMap: Record<string, unknown> = { ...((own.tool as Record<string, unknown>) ?? {}) }
  for (const h of others) {
    const t = h.tool as Record<string, unknown> | undefined
    if (t) for (const [k, v] of Object.entries(t)) if (!(k in toolMap)) toolMap[k] = v
  }
  if (Object.keys(toolMap).length > 0) merged.tool = toolMap

  // 其余 hook:收集所有函数型 key,转发为串行调用(own 先)。
  const keys = new Set<string>()
  for (const h of [own, ...others]) for (const k of Object.keys(h)) if (k !== "tool") keys.add(k)
  for (const k of keys) {
    const fns = [own[k], ...others.map((h) => h[k])].filter((f): f is (...a: unknown[]) => unknown => typeof f === "function")
    if (fns.length === 0) continue
    merged[k] = async (...args: unknown[]) => {
      for (const fn of fns) await fn(...args)
    }
  }
  return merged
}

export type FanoutDeps = {
  existsSync: (p: string) => boolean
  readdirSync: (p: string) => string[]
  /** dynamic import of a self-contained ESM plugin file → module (default/AlphaExt = Plugin fn). */
  importModule: (fileUrl: string) => Promise<Record<string, unknown>>
  pathToFileURL: (p: string) => string
  join: (...parts: string[]) => string
  log?: (m: string) => void
  error?: (m: string) => void
}

/**
 * 加载项目 `.alpha/plugins/*.js` 并调用得到 Hooks[]。信任门:trusted=false → 直接返回 []
 * (可执行物未 consent 不加载)。逐个 import + 调用 Plugin(input);失败 loud 跳过(不阻断整体)。
 */
export async function loadProjectPlugins(
  alphaRoot: string,
  pluginInput: unknown,
  trusted: boolean,
  deps: FanoutDeps,
): Promise<Record<string, unknown>[]> {
  if (!trusted) return []
  const dir = deps.join(alphaRoot, "plugins")
  if (!deps.existsSync(dir)) return []
  const hooks: Record<string, unknown>[] = []
  let files: string[]
  try {
    const all = deps.readdirSync(dir)
    // ADR-006 生 TS 雷拒收 loud:桌面运行时(Electron-Node)加载生 TS 必崩,只认自包含 ESM .js。
    for (const f of all)
      if (f.endsWith(".ts"))
        deps.error?.(
          `[@alpha-code/ext] project plugin ${f} is raw TypeScript — NOT loaded (desktop runtime can't run raw TS, ADR-006). Bundle it to a self-contained ESM .js first.`,
        )
    files = all.filter((f) => f.endsWith(".js"))
  } catch {
    return []
  }
  for (const f of files) {
    const abs = deps.join(dir, f)
    try {
      const mod = await deps.importModule(deps.pathToFileURL(abs))
      const plugin = (mod.default ?? mod.AlphaExt ?? mod.plugin) as ((i: unknown) => Promise<unknown>) | undefined
      if (typeof plugin !== "function") {
        deps.error?.(`[@alpha-code/ext] project plugin ${f} has no default export function — skipped`)
        continue
      }
      const h = await plugin(pluginInput)
      if (h && typeof h === "object") hooks.push(h as Record<string, unknown>)
      deps.log?.(`[@alpha-code/ext] project plugin loaded (fan-out): ${abs}`)
    } catch (error) {
      deps.error?.(`[@alpha-code/ext] project plugin ${f} failed to load: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return hooks
}
