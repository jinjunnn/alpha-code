// factory-skills — 出厂技能(REQ-036):随 app 打包、零安装即在每个会话可用的技能。
//
// 通道:main 在 fork 前解析目录绝对路径 → 经 StartCommand 传 sidecar(utilityProcess 无 electron
// `app`,与 extPluginPath 同通道、不走 env 免动 A6 白名单)→ injectAlphaConfig 写进
// `config.skills.paths`(上游 skill/index.ts:211-219,绝对路径 + `**/SKILL.md` 扫描,ADR-019 已实证)。
//
// 两个来源目录(S18 冲突矩阵 X1:skill-creator 的 catalog 条目保持可安装,供关掉出厂注入的用户手动装):
//   - resources/skills/skill-creator   —— Anthropic skill-creator(Apache-2.0,catalog 资产原位复用)
//   - resources/factory-skills/        —— alpha 自写出厂技能(agent-creator;后续出厂技能丢这里即生效)
//
// 逃生开关:ALPHA_FACTORY_SKILLS_DISABLE=1(REQ-036 验收⑥)。

import { existsSync } from "node:fs"
import { join } from "node:path"

/** 出厂技能名单(hub「出厂内置」态展示用,与目录内容保持一致)。 */
export const FACTORY_SKILL_IDS = ["skill-creator", "agent-creator"] as const

export function factorySkillsEnabled(): boolean {
  return process.env.ALPHA_FACTORY_SKILLS_DISABLE !== "1"
}

/**
 * skills.paths 条目(main 进程调用;packaged=process.resourcesPath,dev=仓内 resources/)。
 * 目录缺失时如实跳过并由调用方 warn(anti-B11:静默少一条 = 「说好的出厂技能不在」没人知道为什么)。
 */
export function resolveFactorySkillPaths(input: {
  packaged: boolean
  resourcesPath: string
  moduleDir: string
}): { paths: string[]; missing: string[] } {
  if (!factorySkillsEnabled()) return { paths: [], missing: [] }
  const root = input.packaged ? input.resourcesPath : join(input.moduleDir, "../../resources")
  const candidates = [join(root, "skills", "skill-creator"), join(root, "factory-skills")]
  const paths: string[] = []
  const missing: string[] = []
  for (const p of candidates) (existsSync(p) ? paths : missing).push(p)
  return { paths, missing }
}

/** renderer 侧「出厂内置」徽标真相(经 IPC 暴露;关掉出厂注入时返回空)。 */
export function factorySkillIds(): string[] {
  return factorySkillsEnabled() ? [...FACTORY_SKILL_IDS] : []
}
