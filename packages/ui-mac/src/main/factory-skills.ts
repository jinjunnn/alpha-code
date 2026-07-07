// factory-skills — 出厂技能(REQ-036):随 app 打包、零安装即在每个会话可用的技能。
//
// 通道拍板(2026-07-05 实测二分):`OPENCODE_CONFIG_CONTENT.skills.paths` 对引擎**不生效**
// (裸引擎同 env 复现:文件 config 的 skills.paths 生效、env 内容源被忽略 —— 上游行为,只读不修);
// 走 ADR-019 已实证的 symlink 桥,且(REQ-052)与目录安装**同构的两跳**形态:
//   `~/.alpha/skills/<name>`  → app 资源目录(真源,零拷贝)
//   `~/.opencode/skills/…`    → `~/.alpha/skills`(复用 alpha-bridge;dir-link 或逐条 item-link)
// 不变量(用户 2026-07-07 点名,ADR-019 修订):`.opencode` 内 alpha 自有条目**只允许指向 `.alpha`**;
// 内容(哪怕只是指向 app 资源的链)一律先落 `.alpha`。旧形态(`~/.opencode/skill/<name>` 直链 app
// 资源,REQ-036 初版)启动 reconcile 时自动迁移:仅 isAlphaFactoryLink 判定为我方的链才拆。
//
// 所有权纪律(codex 审计 High×2 修复,继续有效):只动**可证明是 alpha 自有**的 symlink —— 判定 =
// 链目标以 `…/(resources|Resources)/(skills|factory-skills)/<同名>` 结尾(同名硬校验 + alpha
// 资源布局段校验;历史 app 路径变化时仍可重指)。用户自建的真实目录、异源 symlink(哪怕同名)
// 一律跳过 + 如实上报(ADR-019 §4);开关关闭时的清理同判定,绝不按宽泛正则误删。
//
// 资产两处(S18 冲突矩阵 X1:skill-creator 的 catalog 条目保持可安装,供关掉出厂注入的用户手动装):
//   resources/skills/skill-creator(Anthropic,Apache-2.0,catalog 资产原位复用)
//   resources/factory-skills/agent-creator(alpha 自写)

import * as fs from "node:fs"
import { join, sep } from "node:path"
import { opencodeHomeDir, unbridgeItem } from "./alpha-bridge"
import { alphaGlobalRoot } from "./alpha-installs"

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
  /** REQ-052:旧形态 `~/.opencode/skill/<name>` 直链被迁移拆除的技能名 */
  migrated: string[]
  skipped: Array<{ name: string; reason: string }>
  /** 最终处于「我们的链就位」状态的技能名(徽标真相,codex M4:不能只看开关) */
  active: string[]
}

// renderer 徽标真相:上次 reconcile 后真正就位的出厂技能(开关关/失败/被用户内容占位 → 不在列)。
let lastActive: string[] = []

function readlinkOrNull(p: string): string | null {
  try {
    return fs.readlinkSync(p)
  } catch {
    return null // not a symlink (missing or a real dir/file)
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 幂等 reconcile 两跳桥。每次启动(fork 前)调用:
 * - 迁移:旧位 `<opencodeHome>/skill/<name>` 是我方直链 → 拆(新形态随后重建);用户内容占位 →
 *   整项跳过(避免引擎单双数目录重名双源);
 * - 开:真源缺失 → 建 `<alphaRoot>/skills/<name>` 链;我方旧路径链 → 重指;真实目录(catalog 装的)
 *   / 异源链 → 跳过;真源就位后经 alpha-bridge 桥进 `<opencodeHome>/skills`(异源 item 链绝不替换);
 * - 关:仅拆我方真源链 + 我方桥内 item 链(共享 dir-link 是桥基础设施,不拆)。
 */
export function reconcileFactorySkillLinks(
  sources: Record<string, string>,
  roots: { alphaRoot?: string; opencodeHome?: string } = {},
): FactoryLinkResult {
  const alphaRoot = roots.alphaRoot ?? alphaGlobalRoot()
  const opencodeHome = roots.opencodeHome ?? opencodeHomeDir()
  const result: FactoryLinkResult = { linked: [], removed: [], migrated: [], skipped: [], active: [] }
  const truthRoot = join(alphaRoot, "skills")
  const legacyRoot = join(opencodeHome, "skill") // REQ-036 初版直链落点(迁移源)
  const enabled = factorySkillsEnabled()

  for (const name of FACTORY_SKILL_IDS) {
    const src = sources[name]
    const truth = join(truthRoot, name)
    const legacy = join(legacyRoot, name)

    // ── 0. legacy 迁移:我方直链 → 拆;用户内容占位 → 整项跳过(引擎单双数目录都扫,重名会双源)
    const legacyLink = readlinkOrNull(legacy)
    if (legacyLink !== null) {
      if (legacyLink === src || isAlphaFactoryLink(legacyLink, name)) {
        try {
          // TOCTOU 收窄(codex Low):删除前重读确认仍是同一目标的 symlink
          if (readlinkOrNull(legacy) === legacyLink) {
            fs.rmSync(legacy)
            result.migrated.push(name)
          }
        } catch (e) {
          result.skipped.push({ name, reason: `legacy migrate failed: ${msg(e)}` })
          continue
        }
      } else {
        result.skipped.push({ name, reason: `legacy foreign symlink left alone: → ${legacyLink}` })
        continue
      }
    } else if (fs.existsSync(legacy)) {
      // 旧位是用户真实目录:不接管(ADR-019 §4),也不再建同名出厂链(避免引擎双见重名)
      result.skipped.push({ name, reason: "legacy path holds user content (real dir), left alone" })
      continue
    }

    // ── 1. 开关关闭:拆我方真源链 + 桥 item 链
    if (!enabled) {
      const t = readlinkOrNull(truth)
      if (t !== null && (t === src || isAlphaFactoryLink(t, name))) {
        try {
          if (readlinkOrNull(truth) === t) {
            fs.rmSync(truth)
            result.removed.push(name)
          }
        } catch (e) {
          result.skipped.push({ name, reason: `remove failed: ${msg(e)}` })
        }
      } else if (t !== null) {
        result.skipped.push({ name, reason: "foreign symlink left alone (not alpha-owned)" })
      }
      unbridgeItem(alphaRoot, opencodeHome, "skills", name)
      continue
    }

    if (!src || !fs.existsSync(src)) {
      result.skipped.push({ name, reason: `source missing: ${src}` })
      continue
    }

    // ── 2. 真源链:`<alphaRoot>/skills/<name>` → app 资源
    const t = readlinkOrNull(truth)
    if (t === null && fs.existsSync(truth)) {
      // 真实目录:catalog 安装/用户自建占据真源位 —— 它已是 .alpha 真源,不接管、不算出厂就位
      result.skipped.push({ name, reason: "truth path exists and is not a symlink (installed/user content, left alone)" })
      continue
    }
    if (t !== null && t !== src && !isAlphaFactoryLink(t, name)) {
      result.skipped.push({ name, reason: `foreign symlink at truth path left alone: → ${t}` })
      continue
    }
    let createdTruth = false
    if (t !== src) {
      try {
        fs.mkdirSync(truthRoot, { recursive: true })
        if (t !== null && readlinkOrNull(truth) === t) fs.rmSync(truth) // our stale link → re-point(TOCTOU 收窄)
        fs.symlinkSync(src, truth, "dir")
        createdTruth = true
      } catch (e) {
        result.skipped.push({ name, reason: `truth link failed: ${msg(e)}` })
        continue
      }
    }

    // ── 3. T3(REQ-059)桥退役:真源 ~/.alpha/skills/<name> 就位即可 —— 引擎经 alpha.jsonc 的
    //    `skills:[~/.alpha/skills]`(文件通道,factory-skills 实测生效)扫描发现,不再建 ~/.opencode/skills
    //    链。存量旧链由 reconcileEngineConfigTruth 的 cleanup 拆除(不变量:.opencode 内零 alpha 痕迹)。
    if (createdTruth) result.linked.push(name)
    result.active.push(name)
  }

  // 迁移后旧目录若已空,顺手拆掉(best-effort;只在本次确有迁移时做,绝不动非空目录)
  if (result.migrated.length > 0) {
    try {
      const stat = fs.lstatSync(legacyRoot)
      if (stat.isDirectory() && !stat.isSymbolicLink() && fs.readdirSync(legacyRoot).length === 0) {
        fs.rmdirSync(legacyRoot)
      }
    } catch {
      // 不存在/非空/权限 —— 均无需处理
    }
  }

  lastActive = result.active
  return result
}

/** renderer 侧「出厂内置」徽标真相:上次 reconcile 真正就位的名单(非常量、非纯开关;codex M4)。 */
export function factorySkillIds(): string[] {
  return factorySkillsEnabled() ? [...lastActive] : []
}
