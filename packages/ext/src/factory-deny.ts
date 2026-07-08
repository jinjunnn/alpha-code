// factory-deny — REQ-067(用户拍板 2026-07-08,与 REQ-065 修订同一口径):上游默认禁项**零明文**。
//
// customize-opencode 这类「上游自带、alpha 出厂即禁」的技能,禁用是产品内置行为,不该以
// `permission.skill.<n>: "deny"` 明文出现在用户配置(`~/.alpha/alpha.jsonc`)里 —— 用户配置只放
// 用户自己的东西。机制与出厂技能路径(factory-paths.ts)同构:main 算好 effective 名单
// (出厂清单 − 用户在治理面的解禁)→ `ALPHA_FACTORY_DENY_SKILLS`(JSON 数组)→ 本模块在
// config hook 里内存注入:
//   - `permission.skill.<n> = "deny"`(set-if-absent:用户任何层显式配了该键 → 让位);
//   - 同名占位 command(键入兜底,诚实说明 + 指路 /customize-alpha;set-if-absent)。
// 斜杠菜单的隐藏由 renderer 读 gov-read 的 factoryDenied 完成(REQ-066 过滤同源)。

export function applyFactoryDeny(cfg: Record<string, unknown>, deniedJson: string | undefined): string[] {
  if (!deniedJson) return []
  let names: unknown
  try {
    names = JSON.parse(deniedJson)
  } catch {
    return []
  }
  if (!Array.isArray(names) || names.length === 0) return []

  const permission =
    cfg.permission && typeof cfg.permission === "object" && !Array.isArray(cfg.permission)
      ? (cfg.permission as Record<string, unknown>)
      : ((cfg.permission = {}) as Record<string, unknown>)
  const skill =
    permission.skill && typeof permission.skill === "object" && !Array.isArray(permission.skill)
      ? (permission.skill as Record<string, unknown>)
      : ((permission.skill = {}) as Record<string, unknown>)
  const command =
    cfg.command && typeof cfg.command === "object" && !Array.isArray(cfg.command)
      ? (cfg.command as Record<string, unknown>)
      : ((cfg.command = {}) as Record<string, unknown>)

  const applied: string[] = []
  for (const n of names) {
    if (typeof n !== "string" || !n) continue
    if (!(n in skill)) {
      skill[n] = "deny"
      applied.push(n)
    }
    if (!(n in command)) {
      command[n] = {
        description: "(已禁用)该技能已由 alpha 出厂默认禁用",
        template: `该技能(${n})已由 alpha 出厂默认禁用。请告知用户:此技能不可用;定制 alpha-code 请改用 /customize-alpha;如需恢复,到 定制中心 → 已安装 → 内置(上游) 解除禁用。不要尝试其它方式执行该技能。`,
      }
    }
  }
  return applied
}
