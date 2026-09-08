// factory-deny — REQ-067(用户拍板 2026-07-08,与 REQ-065 修订同一口径):上游默认禁项**零明文**。
//
// customize-opencode 这类「上游自带、alpha 出厂即禁」的技能,禁用是产品内置行为,不该以
// `permission.skill.<n>: "deny"` 明文出现在用户配置(`<current-environment-root>/alpha.jsonc`)里 —— 用户配置只放
// 用户自己的东西。机制与出厂技能路径(factory-paths.ts)同构:main 算好 effective 名单
// (出厂清单 − 用户在治理面的解禁)→ `ALPHA_FACTORY_DENY_SKILLS`(JSON 数组)→ 本模块在
// config hook 里内存注入:
//   - `permission.skill.<n> = "deny"`(set-if-absent:用户任何层显式配了该键 → 让位);
//   - 同名占位 command(键入兜底,诚实说明 + 指路 /customize-alpha;set-if-absent)。
// 斜杠菜单的隐藏由 renderer 读 gov-read 的 factoryDenied 完成(REQ-066 过滤同源)。
//
// REQ-157 `#1284`:占位 command 的 description / template 是 alpha 的字、会进模型上下文(template 在用户
// 敲到该 command 时成为用户回合),所以文字本体与上限住在 context-injection.ts;这里只取用。渲染结果
// 超限由 renderTemplate 抛出(不裁剪),plugin.ts 的 config hook 外层 catch 会 loud 记录并 fail-closed。

import { contextText, renderTemplate } from "./context-injection"

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
        description: contextText("command.factory-denied.description"),
        template: renderTemplate("command.factory-denied.template", { name: n }),
      }
    }
  }
  return applied
}
