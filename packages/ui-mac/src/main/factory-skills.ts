// factory-skills — 出厂技能(REQ-036):随 app 打包、零安装即在每个会话可用的技能。
//
// 通道演进:
//   REQ-036 初版:`~/.opencode/skill/<name>` 直链 app 资源(违反 .alpha 中转不变量,已迁移);
//   REQ-052:两跳桥 `~/.alpha/skills/<name>` → app 资源 + `~/.opencode/skills` 桥;
//   REQ-059 T3:桥退役,引擎经 alpha.jsonc `skills.paths:[~/.alpha/skills]`(文件通道)发现;
//   **REQ-065(现行)**:`.alpha` 纯度反向收口 —— `.alpha` 只承载**用户自有**内容(有用户动作、
//   receipts 可溯);出厂件(零用户动作预置)不落 `.alpha`,由 `skills.paths` **直指 app 资源目录**
//   (boot reconcile 每启动重写该组条目,跟随 app 路径/版本变化,见 engine-config-truth 的
//   rewriteFactorySkillPaths)。本模块职责收敛为:存量清理(拆我方旧链)+ 注入组计算(eligibility)。
//
// 实测约束不变:`OPENCODE_CONFIG_CONTENT.skills.paths` 对引擎不生效(env 内容源忽略 skills.paths),
// 文件 config 生效 —— 故走 alpha.jsonc 文件通道,不走 env。
//
// 所有权纪律(codex 审计 High×2,继续有效):只动**可证明是 alpha 自有**的 symlink —— 判定 =
// 链目标以 `…/(resources|Resources)/(skills|factory-skills)/<同名>` 结尾。用户自建的真实目录、
// 异源 symlink(哪怕同名)一律跳过 + 如实上报(ADR-019 §4);同名被用户内容占位时**不注入**该出厂
// 路径(避免引擎同名双源)。
//
// 资产两处(S18 冲突矩阵 X1:skill-creator 的 catalog 条目保持可安装,供关掉出厂注入的用户手动装):
//   resources/skills/skill-creator(Anthropic,Apache-2.0,catalog 资产原位复用)
//   resources/factory-skills/agent-creator(alpha 自写)

import * as fs from "node:fs"
import { join, sep } from "node:path"
import { opencodeHomeDir } from "./alpha-bridge"
import { alphaGlobalRoot } from "./alpha-installs"

export const FACTORY_SKILL_IDS = [
  "skill-creator",
  "agent-creator",
  "customize-alpha",
  "integrate-project",
  "alpha-workspace",
  "cloud-dispatch",
  "office-docs",
] as const

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
    // REQ-062 T4:接替已禁的上游 customize-opencode(教 .alpha/治理/定制中心约定)
    "customize-alpha": join(root, "factory-skills", "customize-alpha"),
    // REQ-063 T6:外部生态内容的对话式导入/重导入载体(default-deny 的补充入口,ADR-024)
    "integrate-project": join(root, "factory-skills", "integrate-project"),
    // REQ-071/ADR-025:~/Alpha 目录契约(Journal/Memory/Outputs)的写入约定载体
    "alpha-workspace": join(root, "factory-skills", "alpha-workspace"),
    // REQ-082:云派发教学(ADR-021 契约模板兑现;工具面/预算帽按 B 侧 cloud-mcp 实况,登出态文案如实)
    "cloud-dispatch": join(root, "factory-skills", "cloud-dispatch"),
    // REQ-080:办公文档引导(连接器选型 + xlsx 惯例自写重表达 + PDF 缺口 pypdf/reportlab 补位)
    "office-docs": join(root, "factory-skills", "office-docs"),
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

export type FactoryReconcileResult = {
  /** REQ-065 T1:本次应注入 alpha.jsonc skills.paths 的出厂资源目录(enabled 且未被用户内容遮蔽)。 */
  paths: string[]
  /** REQ-065 T2:拆除的 `~/.alpha/skills/<name>` 存量出厂链(REQ-052 两跳桥遗留)。 */
  removed: string[]
  /** REQ-036 初版 `~/.opencode/skill/<name>` 直链拆除。 */
  migrated: string[]
  skipped: Array<{ name: string; reason: string }>
  /** 最终「出厂通道就位」的技能名(徽标真相,codex M4:不能只看开关)。 */
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
 * 幂等 reconcile(REQ-065 形态)。boot 时(首个 fork 前)调用一次,产出注入组交给
 * reconcileEngineConfigTruth 写入 alpha.jsonc:
 * - 迁移:旧位 `<opencodeHome>/skill/<name>` 是我方直链 → 拆;用户内容占位 → 整项跳过且**不注入**
 *   (引擎单双数目录都扫,同名会双源);
 * - T2 拆链:`<alphaRoot>/skills/<name>` 是我方出厂链(REQ-052 遗留)→ 拆;真实目录(catalog 装的
 *   /用户自建)→ 不接管、不注入(它已是用户内容真源);异源链 → 不碰、不注入;
 * - 注入组:enabled 且 src 存在且未被遮蔽 → 出厂资源目录进 paths;
 * - REQ-059 逃生(ALPHA_JSONC_TRUTH_DISABLE / ALPHA_LEGACY_INSTALL_ROOT)→ 全程不拆不改
 *   (回退 = 保留现两跳态,REQ-065 §风险)。
 */
export function reconcileFactorySkills(
  sources: Record<string, string>,
  roots: { alphaRoot?: string; opencodeHome?: string } = {},
): FactoryReconcileResult {
  const alphaRoot = roots.alphaRoot ?? alphaGlobalRoot()
  const opencodeHome = roots.opencodeHome ?? opencodeHomeDir()
  const result: FactoryReconcileResult = { paths: [], removed: [], migrated: [], skipped: [], active: [] }
  const truthRoot = join(alphaRoot, "skills")
  const legacyRoot = join(opencodeHome, "skill") // REQ-036 初版直链落点(迁移源)
  const enabled = factorySkillsEnabled()

  if (process.env.ALPHA_JSONC_TRUTH_DISABLE === "1" || process.env.ALPHA_LEGACY_INSTALL_ROOT === "1") {
    // 真源通道关闭 = legacy 世界:注入无处落(boot 不写 alpha.jsonc),拆链会让出厂技能变暗 → 不拆不改。
    for (const name of FACTORY_SKILL_IDS) result.skipped.push({ name, reason: "REQ-059 escape hatch set — factory state left as-is" })
    lastActive = []
    return result
  }

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
      // 旧位是用户真实目录:不接管(ADR-019 §4),也不注入同名出厂路径(避免引擎双见重名)
      result.skipped.push({ name, reason: "legacy path holds user content (real dir), left alone" })
      continue
    }

    // ── 1. T2 拆存量 `.alpha` 出厂链(REQ-052 遗留;用户自装真实目录/异源链不碰)
    const t = readlinkOrNull(truth)
    if (t !== null) {
      if (t === src || isAlphaFactoryLink(t, name)) {
        try {
          if (readlinkOrNull(truth) === t) {
            fs.rmSync(truth)
            result.removed.push(name)
          }
        } catch (e) {
          result.skipped.push({ name, reason: `stale .alpha link remove failed: ${msg(e)}` })
          continue
        }
      } else {
        // 异源链占位:不碰、不注入(目标未知,注入可能与其解析出的同名技能双源)
        result.skipped.push({ name, reason: `foreign symlink at ~/.alpha/skills left alone: → ${t}` })
        continue
      }
    } else if (fs.existsSync(truth)) {
      // 真实目录:catalog 安装/用户自建 —— 它是用户内容真源(receipts 可溯),出厂路径让位不注入
      result.skipped.push({ name, reason: "~/.alpha/skills holds installed/user content (real dir), factory path yields" })
      continue
    }

    // ── 2. 注入组:enabled 且资源在位 → skills.paths 直指 app 资源(写入由 boot reconcile 落盘)
    if (!enabled) continue
    if (!src || !fs.existsSync(src)) {
      result.skipped.push({ name, reason: `source missing: ${src}` })
      continue
    }
    result.paths.push(src)
    result.active.push(name)
  }

  // 拆链后空目录顺手清(best-effort,只清空目录绝不动内容;legacy 侧同 REQ-052 先例)
  for (const dir of [result.migrated.length > 0 ? legacyRoot : null, result.removed.length > 0 ? truthRoot : null]) {
    if (!dir) continue
    try {
      const stat = fs.lstatSync(dir)
      if (stat.isDirectory() && !stat.isSymbolicLink() && fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir)
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
