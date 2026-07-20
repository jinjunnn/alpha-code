// ecosystem-gate — REQ-063 T4:全局存量一次性迁移门(**发布闸**,ADR-024 §3)。
//
// default-deny 上线后,存量用户 `~/.claude/skills`、`~/.agents/skills`、`~/.claude/CLAUDE.md`
// 一夜之间对引擎不可见 —— 不弹这个门就会重演「技能丢了」误会。首启检测非空 → 一次性询问:
// 「导入」= 转换为当前环境全局原生资产(skills 走既有导入管线 + receipts 溯源;CLAUDE.md 落
// `<current-environment-root>/instructions/`,sidecar 注入通道);「不导入」= loud 明示从此不可见。
// 两种决策都写当前环境 marker,不再重复弹。逃生 ALPHA_ECOSYSTEM_INHERIT=1 → 静默。
//
// 时机:窗口就绪后 fire-and-forget(不阻塞启动;导入生效走下一次 fork/dispose —— 首启导入的技能
// 在引擎侧的可见时机 = 下一条消息触发的实例装配,与定制中心安装同节奏)。

import { dialog, type BrowserWindow } from "electron"
import * as os from "node:os"
import {
  detectExternal,
  ecosystemInheritEnabled,
  EXTERNAL_IMPORT_VERSION,
  importExternalSkills,
  importGlobalClaudeMd,
  readGlobalGateMarker,
  writeGlobalGateMarker,
  type EcosystemGlobalSkillInstaller,
} from "./ecosystem-import"

type Logger = { log: (m: string, meta?: unknown) => void; warn: (m: string, meta?: unknown) => void }

export async function runGlobalEcosystemGate(
  parent: BrowserWindow | undefined,
  logger: Logger,
  // #390:恢复-gate 包装的 global 技能安装器(main 注入;走事务安装,不绕恢复准入)。
  installGlobal: EcosystemGlobalSkillInstaller,
): Promise<void> {
  if (ecosystemInheritEnabled()) return
  if (readGlobalGateMarker()) return // 已决策(任一方向),不再弹
  const detected = detectExternal(os.homedir(), "global")
  if (detected.skills.length === 0 && !detected.claudeMd) return // 无存量,无需打扰(也不写 marker:将来出现再弹)

  const items = [
    ...detected.skills.map((s) => `· 技能:~/${s.source === "claude" ? ".claude" : ".agents"}/skills/${s.name}`),
    ...(detected.claudeMd ? ["· 全局指令:~/.claude/CLAUDE.md"] : []),
  ].join("\n")
  const opts = {
    type: "info" as const,
    title: "外部技能/指令处理(本版本起,一次性)",
    message: `检测到 ${detected.skills.length + (detected.claudeMd ? 1 : 0)} 项其它工具的全局内容,导入为 alpha 原生?`,
    detail:
      "本版本起,alpha-code 默认不再读取其它工具的目录(~/.claude、~/.agents)——防止未经确认的内容进入模型上下文。\n" +
      `发现:\n${items}\n\n` +
      "「导入」= 转换到当前 alpha 环境的原生资产(快照,原文件不动;技能进定制中心「已安装」,可卸载可更新)。\n" +
      "「不导入」= 这些内容从此在 alpha-code 中不可见(原文件仍在,之后可在会话里说「导入外部技能」补做)。",
    buttons: ["导入为 alpha 原生", "不导入(从此不可见)"],
    defaultId: 0,
    cancelId: 1,
  }
  const res = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts)
  const doImport = res.response === 0

  if (!doImport) {
    writeGlobalGateMarker({ version: EXTERNAL_IMPORT_VERSION, decision: "declined", at: new Date().toISOString() })
    logger.log("[req063] global ecosystem content declined — external dirs stay invisible (files untouched)")
    return
  }
  // #390:首启全局生态导入走注入的恢复-gate 事务安装器(崩溃可恢复 + 恢复准入;取代 flat copy 半成品窗)。
  const r = await importExternalSkills(detected.skills, { scope: "global" }, installGlobal)
  const imported = [...r.importedSkills]
  const skipped = [...r.skipped]
  if (detected.claudeMd) {
    try {
      importGlobalClaudeMd(detected.claudeMd)
      imported.push("CLAUDE.md → 当前环境 instructions")
    } catch (error) {
      skipped.push({ name: "CLAUDE.md", reason: error instanceof Error ? error.message : String(error) })
    }
  }
  writeGlobalGateMarker({ version: EXTERNAL_IMPORT_VERSION, decision: "imported", at: new Date().toISOString(), imported, skipped })
  logger.log("[req063] global ecosystem content imported", { imported, skipped })
  if (skipped.length) {
    // 部分失败 loud(C28):导入成功的已生效,失败项列明原因,不装全成
    const detail = skipped.map((s) => `· ${s.name}:${s.reason}`).join("\n")
    const failOpts = {
      type: "warning" as const,
      title: "部分外部内容未能导入",
      message: `${skipped.length} 项未导入(其余 ${imported.length} 项已成功):`,
      detail: `${detail}\n\n未导入项保持不可见;处理后可在会话里说「导入外部技能」重试。`,
      buttons: ["知道了"],
    }
    void (parent ? dialog.showMessageBox(parent, failOpts) : dialog.showMessageBox(failOpts))
  }
}
