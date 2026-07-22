// Generic project prefs parsing retained for alpha-workdir. Upload consent is deliberately absent:
// consent is one-shot, manifest-bound main-process state and is never persisted in project prefs.

export type ProjectPrefs = Record<string, unknown>

/** 安全解析 .alpha/prefs.json 文本;缺失/损坏/非对象 → {}(不抛,不误判为已同意)。 */
export function parsePrefs(json: string | null | undefined): ProjectPrefs {
  if (!json) return {}
  try {
    const p: unknown = JSON.parse(json)
    return p && typeof p === "object" && !Array.isArray(p) ? Object.fromEntries(Object.entries(p)) : {}
  } catch {
    return {}
  }
}
