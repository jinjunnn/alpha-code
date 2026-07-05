// factory-skills — 出厂技能(REQ-036):随 app 打包、零安装即在每个会话可用的技能。
//
// 通道拍板(2026-07-05 实测二分):`OPENCODE_CONFIG_CONTENT.skills.paths` 对引擎**不生效**
// (裸引擎同 env 复现:文件 config 的 skills.paths 生效、env 内容源被忽略 —— 上游行为,只读不修);
// 改走 ADR-019 已实证的 **symlink 桥**:`~/.opencode/skill/<name>` → app 资源目录(零拷贝、
// 引擎原生扫描 `{skill,skills}/**/SKILL.md` 且 follow symlink)。main 每次启动幂等 reconcile:
// 开关开 → 确保链存在且指向本版本资源;开关关(ALPHA_FACTORY_SKILLS_DISABLE=1)→ 只拆自有链。
// 纪律同 alpha-bridge:绝不覆盖用户自建的真实目录/异源链接(诚实跳过 + warn)。
//
// 资产两处(S18 冲突矩阵 X1:skill-creator 的 catalog 条目保持可安装,供关掉出厂注入的用户手动装):
//   resources/skills/skill-creator(Anthropic,Apache-2.0,catalog 资产原位复用)
//   resources/factory-skills/agent-creator(alpha 自写)

import * as fs from "node:fs"
import * as os from "node:os"
import { join } from "node:path"

export const FACTORY_SKILL_IDS = ["skill-creator", "agent-creator"] as const

export function factorySkillsEnabled(): boolean {
  return process.env.ALPHA_FACTORY_SKILLS_DISABLE !== "1"
}

/** name → 打包资源内的技能目录(packaged=process.resourcesPath,dev=仓内 resources/)。 */
export function factorySkillSources(input: {
  packaged: boolean
  resourcesPath: string
  moduleDir: string
}): Record<string, string> {
  const root = input.packaged ? input.resourcesPath : join(input.moduleDir, "../../resources")
  return {
    "skill-creator": join(root, "skills", "skill-creator"),
    "agent-creator": join(root, "factory-skills", "agent-creator"),
  }
}

export type FactoryLinkResult = { linked: string[]; removed: string[]; skipped: Array<{ name: string; reason: string }> }

/**
 * 幂等 reconcile `~/.opencode/skill/<name>` 链。每次启动调用:
 * - 开:目标不存在 → 建链;是自有链但指向旧路径 → 重指;是真实目录/异源链 → 跳过(用户自建,ADR-019 §4);
 * - 关:仅当目标是指向 resources 布局(…/skills/<x> 或 …/factory-skills/<x>)的 symlink 才移除。
 */
export function reconcileFactorySkillLinks(
  sources: Record<string, string>,
  homeDir: string = os.homedir(),
): FactoryLinkResult {
  const result: FactoryLinkResult = { linked: [], removed: [], skipped: [] }
  const skillRoot = join(homeDir, ".opencode", "skill")
  const enabled = factorySkillsEnabled()

  for (const name of FACTORY_SKILL_IDS) {
    const src = sources[name]
    const target = join(skillRoot, name)
    let linkTo: string | null = null
    try {
      linkTo = fs.readlinkSync(target)
    } catch {
      linkTo = null // not a symlink (missing or a real dir/file)
    }
    const exists = fs.existsSync(target) || linkTo !== null

    if (!enabled) {
      // 只拆自有链:指向任一 resources 布局下同名技能目录的 symlink(路径尾部匹配,容忍 app 路径变化)
      if (linkTo && (linkTo === src || /\/(skills|factory-skills)\/[^/]+$/.test(linkTo))) {
        try {
          fs.rmSync(target)
          result.removed.push(name)
        } catch (e) {
          result.skipped.push({ name, reason: `remove failed: ${e instanceof Error ? e.message : e}` })
        }
      }
      continue
    }

    if (!src || !fs.existsSync(src)) {
      result.skipped.push({ name, reason: `source missing: ${src}` })
      continue
    }
    if (exists && linkTo === null) {
      // 真实目录/文件:用户自建同名内容,不接管(ADR-019 §4)
      result.skipped.push({ name, reason: "target exists and is not a symlink (user content, left alone)" })
      continue
    }
    if (linkTo === src) continue // already correct
    try {
      fs.mkdirSync(skillRoot, { recursive: true })
      if (linkTo !== null) fs.rmSync(target) // our (or stale) link pointing elsewhere → re-point
      fs.symlinkSync(src, target, "dir")
      result.linked.push(name)
    } catch (e) {
      result.skipped.push({ name, reason: `link failed: ${e instanceof Error ? e.message : e}` })
    }
  }
  return result
}

/** renderer 侧「出厂内置」徽标真相(经 IPC 暴露;关掉出厂注入时返回空)。 */
export function factorySkillIds(): string[] {
  return factorySkillsEnabled() ? [...FACTORY_SKILL_IDS] : []
}
