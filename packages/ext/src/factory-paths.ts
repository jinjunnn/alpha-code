// factory-paths — REQ-065 修订(用户拍板 2026-07-08):出厂技能路径**不落用户配置文件**。
//
// 口径:alpha 原生(零用户动作预置)的东西对用户封装 —— `~/.alpha/alpha.jsonc` 只承载用户自己
// 装的 agent / skill / command / mcp(对齐 Claude Code 的 settings.json 心智:内置能力不出现在
// 用户配置里)。出厂技能目录由 main 在启动时算好(factorySkillSources + eligibility)、经
// `ALPHA_FACTORY_SKILL_DIRS`(JSON 数组)传入引擎进程,本模块在 config hook 里**内存注入**
// `cfg.skills.paths` —— 引擎照常发现,磁盘零痕迹。
//
// 通道依据:env 内容源(OPENCODE_CONFIG_CONTENT)的 skills.paths 对引擎不生效(REQ-036 实测);
// ext config hook 的内存变异生效(REQ-060 项目级 skills.paths 同通道,真机验证过)。

export function injectFactorySkillPaths(cfg: Record<string, unknown>, dirsJson: string | undefined): string[] {
  if (!dirsJson) return []
  let dirs: unknown
  try {
    dirs = JSON.parse(dirsJson)
  } catch {
    return []
  }
  if (!Array.isArray(dirs) || dirs.length === 0) return []
  const skills =
    cfg.skills && typeof cfg.skills === "object" && !Array.isArray(cfg.skills)
      ? (cfg.skills as Record<string, unknown>)
      : ((cfg.skills = {}) as Record<string, unknown>)
  const paths = Array.isArray(skills.paths) ? (skills.paths as unknown[]) : ((skills.paths = []) as unknown[])
  const added: string[] = []
  for (const d of dirs) {
    if (typeof d !== "string" || !d) continue
    if (paths.includes(d)) continue
    paths.push(d)
    added.push(d)
  }
  return added
}
