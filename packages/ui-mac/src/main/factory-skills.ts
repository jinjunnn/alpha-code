// factory-skills — 出厂技能(REQ-036):随 app 打包、零安装即在每个会话可用的技能。
//
// 通道拍板(2026-07-05 实测二分):`OPENCODE_CONFIG_CONTENT.skills.paths` 对引擎**不生效**
// (裸引擎同 env 复现:文件 config 的 skills.paths 生效、env 内容源被忽略 —— 上游行为,只读不修);
// 改走 ADR-019 已实证的 **symlink 桥**:`~/.opencode/skill/<name>` → app 资源目录(零拷贝、
// 引擎原生扫描 `{skill,skills}/**/SKILL.md` 且 follow symlink)。main 每次启动幂等 reconcile。
//
// 所有权纪律(codex 审计 High×2 修复):只动**可证明是 alpha 自有**的 symlink —— 判定 =
// 链目标以 `…/(resources|Resources)/(skills|factory-skills)/<同名>` 结尾(同名硬校验 + alpha
// 资源布局段校验;历史 app 路径变化时仍可重指)。用户自建的真实目录、异源 symlink(哪怕同名)
// 一律跳过 + 如实上报(ADR-019 §4);开关关闭时的清理同判定,绝不按宽泛正则误删。
//
// 资产两处(S18 冲突矩阵 X1:skill-creator 的 catalog 条目保持可安装,供关掉出厂注入的用户手动装):
//   resources/skills/skill-creator(Anthropic,Apache-2.0,catalog 资产原位复用)
//   resources/factory-skills/agent-creator(alpha 自写)

import * as fs from "node:fs"
import * as os from "node:os"
import { join, sep } from "node:path"

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

/** alpha 自有链判定:目标 = 任一 alpha 资源布局下的**同名**技能目录(容忍 app 路径迁移)。
 *  用户链哪怕同名、只要不在 (resources|Resources)/(skills|factory-skills)/ 布局下就不是我们的。 */
export function isAlphaFactoryLink(linkTo: string, name: string): boolean {
  const norm = linkTo.split(sep).join("/").replace(/\/+$/, "")
  return (
    norm.endsWith(`/resources/skills/${name}`) ||
    norm.endsWith(`/resources/factory-skills/${name}`) ||
    norm.endsWith(`/Resources/skills/${name}`) ||
    norm.endsWith(`/Resources/factory-skills/${name}`)
  )
}

export type FactoryLinkResult = {
  linked: string[]
  removed: string[]
  skipped: Array<{ name: string; reason: string }>
  /** 最终处于「我们的链就位」状态的技能名(徽标真相,codex M4:不能只看开关) */
  active: string[]
}

// renderer 徽标真相:上次 reconcile 后真正就位的出厂技能(开关关/失败/被用户内容占位 → 不在列)。
let lastActive: string[] = []

/**
 * 幂等 reconcile `~/.opencode/skill/<name>` 链。每次启动(fork 前)调用:
 * - 开:目标不存在 → 建链;是 alpha 自有链但指向旧路径 → 重指;真实目录/**异源链** → 跳过;
 * - 关:仅 alpha 自有链(isAlphaFactoryLink 同名+布局校验)才移除。
 */
export function reconcileFactorySkillLinks(
  sources: Record<string, string>,
  homeDir: string = os.homedir(),
): FactoryLinkResult {
  const result: FactoryLinkResult = { linked: [], removed: [], skipped: [], active: [] }
  const skillRoot = join(homeDir, ".opencode", "skill")
  const enabled = factorySkillsEnabled()

  for (const name of FACTORY_SKILL_IDS) {
    const src = sources[name]
    const target = join(skillRoot, name)
    const readLink = (): string | null => {
      try {
        return fs.readlinkSync(target)
      } catch {
        return null // not a symlink (missing or a real dir/file)
      }
    }
    const linkTo = readLink()
    const exists = fs.existsSync(target) || linkTo !== null
    const ours = linkTo !== null && (linkTo === src || isAlphaFactoryLink(linkTo, name))

    if (!enabled) {
      if (ours) {
        try {
          // TOCTOU 收窄(codex Low):删除前重读确认仍是同一目标的 symlink
          if (readLink() === linkTo) {
            fs.rmSync(target)
            result.removed.push(name)
          }
        } catch (e) {
          result.skipped.push({ name, reason: `remove failed: ${e instanceof Error ? e.message : e}` })
        }
      } else if (linkTo !== null) {
        result.skipped.push({ name, reason: "foreign symlink left alone (not alpha-owned)" })
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
    if (linkTo !== null && !ours && linkTo !== src) {
      // 异源 symlink:用户自己的链,哪怕同名也不接管(codex High-1)
      result.skipped.push({ name, reason: `foreign symlink left alone: → ${linkTo}` })
      continue
    }
    if (linkTo === src) {
      result.active.push(name)
      continue // already correct
    }
    try {
      fs.mkdirSync(skillRoot, { recursive: true })
      if (linkTo !== null && readLink() === linkTo) fs.rmSync(target) // our stale link → re-point(TOCTOU 收窄)
      fs.symlinkSync(src, target, "dir")
      result.linked.push(name)
      result.active.push(name)
    } catch (e) {
      result.skipped.push({ name, reason: `link failed: ${e instanceof Error ? e.message : e}` })
    }
  }
  lastActive = result.active
  return result
}

/** renderer 侧「出厂内置」徽标真相:上次 reconcile 真正就位的名单(非常量、非纯开关;codex M4)。 */
export function factorySkillIds(): string[] {
  return factorySkillsEnabled() ? [...lastActive] : []
}
