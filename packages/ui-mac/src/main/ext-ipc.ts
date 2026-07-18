// Extension Hub IPC handlers (main process). Mirrors ipc.ts's ipcMain.handle pattern. Three thin
// privileged operations the renderer can't do itself: persist/remove an MCP server in the user
// config (ext-config.ts), and a runtime which-check so the UI can warn before adding a local MCP
// whose binary (uv/node/…) is missing. All validation lives in ext-config / here — see ADR-014 §8.

import { makeAdvisoryGate } from "./ext-advisory-gate"
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron"
import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { toolProbe } from "./platform"
import { extensionsGranted, hasExtensionsDecision, listProjectExecutables, withExtensionsConsent } from "./alpha-ext-trust"
import { alphaRoot, readProjectPrefs, writeProjectPrefs } from "./alpha-workdir"
import type { InstallTarget } from "../preload/types"
import { alphaGlobalRoot, listInstalls } from "./alpha-installs"
import { claimMcpSecretVersionDir, mcpSecretVersionedRef, removeMcpSecretVersionDir, removeMcpServerSecrets, removeMcpServerSecretsStrict, writeMcpSecretVersioned } from "./alpha-mcp-secrets"
import { isMigrationEnabled, removeLegacy, scanLegacy, verifyLegacyProvenance, type ProvenanceRequest } from "./alpha-migrate"
import { collectLegacyMcpRefPathsStrict, configHealth, findPluginBaseConflictStrict, gcMcpSecretsAgainstConfig, listConfiguredMcpServerNamesStrict, mcpConfigTruthPath, readLegacyPluginArrayStrict, readMcpLeafStrict, readPluginArrayStrict, removeMcp, removeMcpConfigInLock, removePlugin, removePluginPath } from "./ext-config"
import { makeUncuratedInstallBodies } from "./ext-uncurated-bodies"
import { applyMcpWritePolicy } from "./ext-mcp-policy"
import { ensureUserWorkspaceDir } from "./alpha-user-workspace"
import { agentInstallPresent, cloneSkillGitToTmp, collectBuiltinAgentPayload, collectVendoredPluginPayload, stageVendoredPluginVersioned, importSkillFolder, installBuiltinSkill, installRemoteSkill, readBuiltinSkill, removeFsInstall, resourcesRoot } from "./ext-fs-installer"
import { parseAgentImport } from "./ext-import-validate"
import { cleanProjectCatalogResiduals, detectProjectCatalogResiduals } from "./ext-project-residuals"
import { listRetainedJournals, retireTransactionJournal, type JournalRootRef } from "./ext-journal-retire"
import { collectSkillPayloadFromDir, skillGenerationProbe } from "./ext-skill-generations"
import { agentFileProbe, recoveryReceiptInputs } from "./ext-agent-install"
import { randomUUID } from "node:crypto"
import { pickedFiles } from "./ipc"
import { factorySkillIds } from "./factory-skills"
import { downloadRemoteAsset, refreshRemoteCatalog } from "./remote-catalog"
import { applyBuiltinPolicy, effectiveFactoryDenied, normalizeBuiltinPolicy, protectionInfo, readBuiltinPolicy, resetBuiltinPolicy } from "./alpha-builtin-policy"
import {
  detectExternal,
  ecosystemInheritEnabled,
  hasExternalImportDecision,
  importExternalSkills,
  importProjectClaudeMd,
  withExternalImportDecision,
} from "./ecosystem-import"
// REQ-099(ADR-028):main-only 安装计划 + v2 账本。随包 catalog 快照 = 验签远端/缓存不可用时的
// 兜底真源(ADR-023 两级真源;与 renderer 的 B20 兜底同一字节)。
import bundledCatalogJson from "../renderer/extensions/alpha-catalog.json"
import type { Catalog } from "../renderer/extensions/catalog-types"
import { environmentMutableRoot, getAlphaEnvironment } from "./alpha-environment"
import { createInventoryQuery } from "./ext-inventory"
import { decodeSetStateIntent, decodeUninstallIntent, installCatalog, installUncuratedAgentImport, installUncuratedSkillImport, listGenerationsByKey, removeInstallGrants, rollbackGenerationByKey, seedPluginFileProbe, setInstallStateByKey, uninstallByKey, type PlannerDeps } from "./ext-install-planner"
import { fetchCurationBlob } from "./curation-blobs"
import { makeRecoveryGate } from "./ext-recovery-gate"
import { adoptProjectLedger } from "./ext-project-adopt"
import { buildGatedWriteChannels, buildJournalAdminChannels, GATED_WRITE_CHANNELS, JOURNAL_ADMIN_CHANNELS } from "./ext-write-channels"
import { tryAcquireBundleLock } from "./ext-bundle-lock"
import { lookupForUninstall, migrateV1Ledger, parseUninstallLedgerKey, projectScopeIdentity, readLedgerV2, removeRecordV2, upsertRecordsV2 } from "./ext-receipt-v2"
import { packagedSeedBrowseView, readPackagedSeed } from "./ext-seed"
import { recoverExtensionTransactions, recoverExtensionTransactionsInHeldLock, recoveryClean, type RecoverOptions } from "./ext-transaction"
import { getLogger } from "./logging"

// REQ-076 T2(阻断②):原实现硬编码 `which` + `:` 拼接的 unix PATH,Windows 上恒报「未安装」
// (MCP 安装预检全线误报)。改经 platform seam:posix = which + 补包管理器目录(原 mac 行为
// 逐字保留,GUI 启动 PATH 不全);win32 = where + 原样 PATH(ADR-026)。
function checkRuntime(tool: string): Promise<{ ok: boolean }> {
  return new Promise((resolve) => {
    if (!/^[a-zA-Z0-9._-]+$/.test(tool)) {
      resolve({ ok: false })
      return
    }
    const probe = toolProbe()
    execFile(probe.cmd, [tool], { env: { ...process.env, PATH: probe.probePath } }, (err, stdout) => {
      resolve({ ok: !err && Boolean(stdout && stdout.trim()) })
    })
  })
}

/** registryChannel:冻结环境快照的 registry 通道(REQ-098 #302),由 composition root(index.ts)
 *  注入 —— IPC handler 与 planner 的 catalog 拉取共用同一份,类型必填(无缺省可静默回落 stable)。 */
export function registerExtIpcHandlers(userDataPath: string, registryChannel: "stable" | "preview" | "dev") {
  // REQ-099 #305:未策展自定义 MCP 专用通道(catalog MCP 走 ext-install-catalog)与未策展 npm
  // plugin 导入的 body —— #336(残留4)抽至 electron-free 的 ext-uncurated-bodies(账本写失败的
  // fail-closed 返回 + 精确补偿可注入测试);此处只接线,注册仍经写通道表(文件尾),过恢复
  // gate + ledgerReady(#347,review #376 B1)。
  const { persistMcpBody, installPluginBody } = makeUncuratedInstallBodies({
    userDataPath,
    globalRoot: alphaGlobalRoot,
    environment: () => getAlphaEnvironment().environment,
  })
  // Codex review #351:先删配置(锁内)、成功才吊销密钥 —— busy 时不得留下「配置还在、密钥已毁」。
  // #346(Codex 裁决旁路封堵):本通道只服务**无账 live MCP**;有账(v2/v1/损坏)一律拒 ——
  // ledger-backed 卸载必须走 journaled 的 ext-uninstall-v2,否则这里就是绕开 journal 的活旁路。
  const removeMcpLegacyBody = async (name: unknown) => {
    const nm = typeof name === "string" ? name : ""
    const lk = lookupForUninstall(alphaGlobalRoot(), "mcp", nm)
    if (lk.status !== "absent")
      return { ok: false, reason: `ledger-backed MCP (${lk.status}) — use the journaled uninstall channel (ext-uninstall-v2)` }
    const r = removeMcp(nm)
    if (r.ok) {
      // r8:best-effort 面 —— 在册名读不出时把全部候选当活体(跳过备份删除),绝不误删。
      const live = listConfiguredMcpServerNamesStrict()
      const names = live.ok ? new Set(live.names) : null
      removeMcpServerSecrets(userDataPath, nm, (cand) => (names ? names.has(cand) : true))
    }
    return r
  }
  // B11/B23:全局配置健康探测(语法错/未知顶键 → 引擎会整份清零)
  ipcMain.handle("ext-config-health", () => configHealth())
  ipcMain.handle("ext-check-runtime", (_event: IpcMainInvokeEvent, tool: string) => checkRuntime(tool))
  // REQ-036:创建表单已移除(创建走技能:skill-creator/agent-creator 出厂注入),原
  // ext-write-skill / ext-write-agent 渲染层通道随之下线。#390 起未策展导入(folder/git 技能 +
  // imported agent)也改走 planner 的 CAS 事务(installUncuratedSkillImport/installUncuratedAgentImport);
  // main 的 flat writeSkill/writeAgent 已无生产调用方,仅作既有测试覆盖的 flat 原语保留。
  ipcMain.handle("ext-factory-skill-ids", () => factorySkillIds())

  // REQ-037 上游能力治理:真源 ~/.alpha/governance.json,物化 home jsonc 受控叶子(见 alpha-governance.ts)。
  // apply 后由 renderer 调 refreshEngine()(dispose)热生效 —— 与安装链路同节奏。
  // REQ-067:factoryDenied = 出厂默认禁的有效名单(出厂清单 − 用户解禁)—— 菜单过滤与治理面板共用
  ipcMain.handle("builtin-read", () => {
    const gov = readBuiltinPolicy()
    return { gov, protection: protectionInfo(), factoryDenied: effectiveFactoryDenied(gov) }
  })
  ipcMain.handle("builtin-apply", (_event: IpcMainInvokeEvent, gov: unknown, visibleAgents: unknown, confirmBuildDisable?: boolean) => {
    const agents = Array.isArray(visibleAgents) ? visibleAgents.filter((a): a is string => typeof a === "string") : []
    return applyBuiltinPolicy(normalizeBuiltinPolicy(gov), agents, confirmBuildDisable === true)
  })
  ipcMain.handle("builtin-reset", () => resetBuiltinPolicy())

  // REQ-032:远程 catalog(ETag+验签+缓存,回退链 远端→缓存→内置由 renderer 兜底)与远程技能安装
  // (下载+sha256 校验在 main,写盘走 builtin 同管线:~/.alpha + 桥 + 账本)。
  // REQ-033:agent 导入两段式,codex 审计后收紧两条信任边界:
  //  H1 — preview 读文件必须经 openFilePicker 的授权 token(pickedFiles 注册表:sender 绑定 + 单次
  //       消费),renderer 无法拿任意路径当读 oracle;
  //  M1 — confirm 只收 previewId,写入内容取自 main 侧留存的 preview 产物 —— renderer 全程不能
  //       提供写入内容(任意 agent md/permission 直写面关死)。
  const issuedAgentImports = new Map<string, { name: string; composed: string }>()
  ipcMain.handle("ext-import-agent-preview", async (event: IpcMainInvokeEvent, token: string, filePath: string) => {
    try {
      if (typeof token !== "string" || typeof filePath !== "string" || !filePath.endsWith(".md"))
        return { ok: false, reason: "请选择 .md agent 文件" }
      const bytes = await pickedFiles.read(event.sender.id, token, filePath) // 授权校验 + 单次消费(codex H1)
      if (bytes.byteLength > 256 * 1024) return { ok: false, reason: "文件过大(>256KB)" }
      const parsed = parseAgentImport(Buffer.from(bytes).toString("utf8"))
      if (!parsed.ok) return parsed
      const previewId = randomUUID()
      issuedAgentImports.set(previewId, { name: parsed.name, composed: parsed.composed })
      if (issuedAgentImports.size > 16) issuedAgentImports.delete(issuedAgentImports.keys().next().value!)
      return { ...parsed, previewId }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "读取失败" }
    }
  })
  const importAgentConfirmBody = async (previewId: unknown) => {
    const issued = typeof previewId === "string" ? issuedAgentImports.get(previewId) : undefined
    if (!issued) return { ok: false, reason: "预览已失效,请重新选择文件" }
    // Codex review #351:写成功才消费 preview —— 配置写锁 busy 等可重试失败后,用户重点确认
    // 不该只能得到「预览已失效」(单次消费语义只对成功写入成立)。
    // #390:imported agent 走 CAS + file/config 单事务(取代 flat writeAgent 的 active-无账本 fail-open)。
    const r = await installUncuratedAgentImport(issued.name, issued.composed, plannerDeps(), { origin: "imported" })
    if (r.ok) issuedAgentImports.delete(previewId as string)
    return r
  }

  ipcMain.handle("ext-remote-catalog", () => refreshRemoteCatalog(userDataPath, registryChannel))
  // REQ-102 #316:packaged seed 浏览面 —— 纯读安全投影(零绝对路径/blob 布局/url;seedDir 由
  // main 派生,renderer 无输入)。选装走 ext-install-catalog 的 seed 意图(#317);UI 归 REQ-103。
  ipcMain.handle("ext-seed-browse", () => {
    const dir = path.join(resourcesRoot(), "extension-seed")
    return packagedSeedBrowseView(fs.existsSync(dir) ? dir : null)
  })
  // REQ-100 #313:旧 ext-install-remote-skill / ext-install-builtin-skill 通道已下线 —— catalog skill
  // 安装只走 ext-install-catalog(planner 从已验签 catalog 派生事实,落 generation 事务);保留
  // renderer 可伪造 assetKey/name/meta 的旧面就是保留技能身份伪装通道(Codex review #345)。
  // REQ-099 #305:旧 catalog 事实通道全部下线 —— ext-install-remote-agent / ext-install-builtin-agent /
  // ext-install-vendored-plugin / ext-enable-cloud 均并入 ext-install-catalog(planner 从已验签 catalog
  // 派生全部事实);ext-install-plugin 仅保留给未策展 npm 导入,且不再收 renderer meta(未策展安装
  // 无 catalog 身份,防伪造 catalog 来源,ADR-028 §5)。
  // REQ-019 T3:详情页 SKILL.md 预览(只读,资产键校验 + 体积帽)
  ipcMain.handle("ext-read-builtin-skill", (_event: IpcMainInvokeEvent, builtinAssetKey: string) =>
    readBuiltinSkill(builtinAssetKey),
  )
  // REQ-019 T6 / REQ-098 #255:folder 导入 = main 自弹目录选择器,用户实选目录即来源 —— renderer
  // 不再传入任意绝对 srcDir(此前被攻陷 renderer 可直接调 bridge 读任意目录并复制入当前根,picker
  // 非安全边界)。合并「弹窗+导入」为一个 IPC,renderer 全程拿不到可回传的授权路径。
  // #347:目录选择对话框在 gate 之外(mutex 决不能横跨用户交互);持久化阶段经写通道表过 gate。
  const pickImportSkillDir = async (): Promise<{ ok: true; srcDir: string } | { ok: false; canceled: true; reason: string }> => {
    if (process.env.ALPHA_OPEN_DIR) return { ok: true, srcDir: process.env.ALPHA_OPEN_DIR } // headless/测试短路(main 控制的 env)
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      title: "选择要导入的技能文件夹",
      defaultPath: ensureUserWorkspaceDir() ?? undefined,
    })
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true, reason: "已取消" }
    return { ok: true, srcDir: result.filePaths[0]! }
  }
  // REQ-018 安装账本:合并只读视图(global ~/.alpha + 可选 project .alpha)
  ipcMain.handle("ext-list-installs", (_event: IpcMainInvokeEvent, projectDir?: string) => listInstalls(projectDir))
  // REQ-100 #313:旧 receipt-based ext-uninstall 通道已下线 —— renderer 提供的 receipt.files/configKey
  // 直达 rmSync/removePluginPath 是任意路径删除通道(startsWith 前缀挡不住 `..`,Codex review #345
  // critical);卸载只走 ext-uninstall-v2(key-based,receipt 事实由 main 账本自查,ADR-028 §1)。
  // REQ-018 T3:存量迁移(旧 XDG 根 → .alpha)。scan 报告 + removeLegacy 删旧位;新位由 renderer
  // 复用既有 installer 重装(顺带 A2 钉版 + secret file 化)。用户面触发受 ALPHA_MIGRATE_ENABLE 门控
  // (A6 真机验证后开,S12 T8)。
  // REQ-060 信任门 UI:renderer 打开项目时调用。项目 `.alpha` 含可执行扩展(mcp/plugins)且无当前
  // 版本决策 → 弹 per-project 原生确认(B16/ADR-021 同款);granted/denied 都写 `.alpha/prefs.json`
  // 的 extensionsConsent(@alpha-code/ext 信任门读同一字段)。granted 后由 renderer 调 dispose 免重启
  // 生效(链路已真机证通,audits/2026-07-07-req060-fanout-realmachine)。写盘失败不静默放行(反 placebo):
  // 不落决策 + 返回 denied,下次仍会弹。
  ipcMain.handle("ext-trust-check", async (event: IpcMainInvokeEvent, directory: string) => {
    if (typeof directory !== "string" || !directory) return { prompted: false, granted: false }
    // #356:project 账本 v1→v2 adoption —— 必须在下面两个早退(无 executable / 已有信任决策)
    // **之前**执行:纯文本 skill/agent 项目与已决策项目同样收编。等 ledgerReady(全局恢复收敛)
    // 后进行;拒绝 loud log 零改动 —— busy/transient 在下一次项目打开的 trust-check 自然重试
    // (adoption 幂等,renderer 的一次性 checked 吞不掉);gate/锁只罩迁移,不横跨原生确认框。
    try {
      await ledgerReady
      const adopted = await adoptProjectLedger(directory, { environment: getAlphaEnvironment().environment, gate: recoveryGate })
      if (!adopted.ok)
        getLogger().log(`[req099-adopt] project ledger adoption refused (${adopted.transient ? "transient — will retry" : "final"}): ${adopted.reason}`)
      else if (adopted.migrated > 0 || adopted.warnings.length > 0)
        getLogger().log(`[req099-adopt] project ledger adopted: ${adopted.migrated} migrated, ${adopted.retained} retained${adopted.warnings.length ? `; ${adopted.warnings.join("; ")}` : ""}`)
    } catch (error) {
      getLogger().log(`[req099-adopt] adoption error (ledger untouched): ${error instanceof Error ? error.message : String(error)}`)
    }
    const alphaDir = path.join(directory, ".alpha")
    let jsoncText: string | null = null
    try {
      jsoncText = fs.readFileSync(path.join(alphaDir, "alpha.jsonc"), "utf8")
    } catch {
      /* 无项目配置 */
    }
    let pluginFiles: string[] = []
    try {
      pluginFiles = fs.readdirSync(path.join(alphaDir, "plugins"))
    } catch {
      /* 无 plugins 目录 */
    }
    const exec = listProjectExecutables(jsoncText, pluginFiles)
    if (exec.mcp.length === 0 && exec.plugins.length === 0) return { prompted: false, granted: false }
    const prefs = readProjectPrefs(directory)
    if (hasExtensionsDecision(prefs)) return { prompted: false, granted: extensionsGranted(prefs) }

    const items = [
      ...exec.mcp.map((n) => `· 连接器(MCP):${n}`),
      ...exec.plugins.map((f) => `· 插件:.alpha/plugins/${f}`),
    ].join("\n")
    const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const opts = {
      type: "warning" as const,
      title: "项目自带扩展加载确认(首次)",
      message: "此项目自带可执行扩展,是否允许加载?",
      detail:
        `发现以下可执行扩展:\n${items}\n\n` +
        "允许加载 = 在本机运行该项目提供的程序代码。若这不是你信任的项目,请选择「仅文本扩展」——\n" +
        "技能 / Agent / 命令等文本类扩展不受影响,仍正常生效。\n\n" +
        "本决定按项目记录一次(存于本项目 .alpha/prefs.json),之后不再重复询问。",
      buttons: ["允许加载", "仅文本扩展(不加载)"],
      defaultId: 1,
      cancelId: 1,
      checkboxLabel: "我了解这会在本机运行该项目提供的代码",
      checkboxChecked: false,
    }
    const res = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts)
    const granted = res.response === 0 && res.checkboxChecked
    // 「允许」但未勾知情确认 = 未决(不落盘,下次再弹)——落 denied 会把手滑变成永久拒绝。
    if (res.response === 0 && !res.checkboxChecked) {
      getLogger().log(`[req060-trust] allow clicked without acknowledgement — treated as undecided: ${directory}`)
      return { prompted: true, granted: false }
    }
    const written = writeProjectPrefs(directory, withExtensionsConsent(readProjectPrefs(directory), granted, new Date().toISOString()))
    if (!written.ok) {
      getLogger().error(`[req060-trust] failed to persist decision: ${written.reason}`)
      return { prompted: true, granted: false, persistError: written.reason }
    }
    getLogger().log(`[req060-trust] ${granted ? "granted" : "denied"} for project: ${directory}`)
    return { prompted: true, granted }
  })

  // REQ-063(ADR-024):外部生态 consent 导入门(项目级)。default-deny 后引擎不再读项目自带的
  // `.claude`/`.agents` skills 与 CLAUDE.md;首次进入检测到外来内容 → 原生确认 → 「导入」= 安装期
  // 转换为本项目 `.alpha` 原生扩展(快照、脱钩,ADR-023);两种决策都记 `.alpha/prefs.json` 不再弹。
  // 逃生 ALPHA_ECOSYSTEM_INHERIT=1 → 全程静默(上游继承已恢复,alpha 不检测不弹窗,ADR-024 §5)。
  ipcMain.handle("ext-external-check", async (event: IpcMainInvokeEvent, directory: string) => {
    const none = { prompted: false, imported: false, importedSkills: [] as string[], skipped: [] as Array<{ name: string; reason: string }>, claudeMd: "none" as const }
    // ADR-030(#372):项目打开位点的残留报告 —— 只读、best-effort、loud;清理只走显式通道
    // (ext-project-residuals-clean),这里零写入零弹窗。
    if (typeof directory === "string" && directory) {
      try {
        const res = detectProjectCatalogResiduals(directory)
        if (
          res.ok &&
          (res.catalogRecords.length > 0 || res.ghostStoreKeys.length > 0 || res.openJournals.length > 0 ||
            res.unknownStoreEntries.length > 0 || res.orphanAgentFiles.length > 0 ||
            res.orphanAgentConfigEntries.length > 0 || res.cleanBlockers.length > 0)
        )
          getLogger().warn(
            `[req098-372] recalled project-managed install residuals in ${directory}: ` +
              `${res.catalogRecords.length} catalog record(s), ${res.ghostStoreKeys.length} ghost store(s), ` +
              `${res.openJournals.length} open journal(s), ${res.unknownStoreEntries.length} unknown store entr(ies), ` +
              `${res.orphanAgentFiles.length + res.orphanAgentConfigEntries.length} orphan agent surface(s), ` +
              `${res.cleanBlockers.length} clean blocker(s) — inspect via ext-project-residuals-check`,
          )
      } catch {
        /* 报告面绝不影响项目打开 */
      }
    }
    if (typeof directory !== "string" || !directory || ecosystemInheritEnabled()) return none
    const detected = detectExternal(directory, "project")
    if (detected.skills.length === 0 && !detected.claudeMd) return none
    const prefs = readProjectPrefs(directory)
    if (hasExternalImportDecision(prefs)) return none
    const items = [
      ...detected.skills.map((s) => `· 技能:${s.source === "claude" ? ".claude" : ".agents"}/skills/${s.name}`),
      ...(detected.claudeMd ? [`· 指令文件:${path.relative(directory, detected.claudeMd)}`] : []),
    ].join("\n")
    const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const opts = {
      type: "info" as const,
      title: "检测到其它工具的扩展内容(首次)",
      message: "此项目自带 Claude Code / .agents 生态内容,导入为本项目的 alpha 扩展?",
      detail:
        `alpha-code 默认不读取其它工具的目录(防止陌生项目的自带内容未经确认进入模型上下文)。\n发现:\n${items}\n\n` +
        "「导入」= 转换为本项目 .alpha 下的原生扩展(快照,与原目录脱钩,原文件不动):技能进 .alpha/skills;" +
        "CLAUDE.md 转为 AGENTS.md(引擎原生约定;已存在 AGENTS.md 时不覆盖、提示手动合并)。\n" +
        "「忽略」= 保持不可见。本决定按项目记录一次(存于本项目 .alpha/prefs.json),之后不再询问;" +
        "以后想导入/更新快照,在会话里说「导入这个项目的外部扩展」即可(integrate-project 技能)。",
      buttons: ["导入", "忽略(保持不可见)"],
      defaultId: 1,
      cancelId: 1,
    }
    const res = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts)
    const doImport = res.response === 0
    let importedSkills: string[] = []
    let skipped: Array<{ name: string; reason: string }> = []
    let claudeMd: "agents-md-created" | "agents-md-exists" | "none" = "none"
    if (doImport) {
      // #390:project scope 未策展技能维持 sanctioned flat 路径(ADR-030;不注入 global 安装器)。
      const r = await importExternalSkills(detected.skills, { scope: "project", projectDir: directory })
      importedSkills = r.importedSkills
      skipped = r.skipped
      if (detected.claudeMd) {
        try {
          claudeMd = importProjectClaudeMd(directory, detected.claudeMd)
        } catch (error) {
          skipped.push({ name: "CLAUDE.md", reason: error instanceof Error ? error.message : String(error) })
        }
      }
      for (const s of skipped) getLogger().warn(`[req063] project import skipped ${s.name}: ${s.reason}`)
    }
    const written = writeProjectPrefs(
      directory,
      withExternalImportDecision(readProjectPrefs(directory), doImport ? "imported" : "declined", new Date().toISOString()),
    )
    if (!written.ok) {
      // 写盘失败不静默放行(反 placebo,trust-check 同款):导入产物已落地的照常生效,但决策未留痕 → 下次仍弹
      getLogger().error(`[req063] failed to persist decision: ${written.reason}`)
      return { prompted: true, imported: doImport, importedSkills, skipped, claudeMd, persistError: written.reason }
    }
    getLogger().log(`[req063] ${doImport ? "imported" : "declined"} external content for project: ${directory}`, {
      importedSkills,
      skipped: skipped.length,
      claudeMd,
    })
    return { prompted: true, imported: doImport, importedSkills, skipped, claudeMd }
  })

  ipcMain.handle("ext-migrate-scan", () => ({ enabled: isMigrationEnabled(), inventory: scanLegacy() }))
  // REQ-044:名字匹配只定位候选;这里做 provenance 终审(打包资产逐字节 / catalog 形状)——
  // 只放行 alpha 自装,同名用户自建被排除并留痕(fail-closed,ADR-019 §4)。
  ipcMain.handle("ext-migrate-verify", (_event: IpcMainInvokeEvent, requests: unknown) => {
    if (!Array.isArray(requests) || requests.length === 0 || requests.length > 100) return []
    const verdicts = verifyLegacyProvenance(requests as ProvenanceRequest[], resourcesRoot())
    for (const v of verdicts) {
      if (!v.verified) getLogger().log(`[req044-provenance] excluded ${v.type} "${v.name}" from migration: ${v.reason}`)
    }
    return verdicts
  })
  ipcMain.handle(
    "ext-migrate-remove-legacy",
    (_event: IpcMainInvokeEvent, type: "skill" | "agent" | "mcp" | "plugin", name: string) => removeLegacy(type, name),
  )

  // REQ-099(ADR-028 §1):catalog 安装唯一通道。renderer 意图收窄为 { catalogId, scope, grants },
  // 全部安装事实(name/config/包名/资产键/owned paths)由 main 从已验 catalog 重新派生
  // (ext-install-planner);未知意图键 loud 拒绝 —— 伪造 renderer 事实没有通道。卸载/禁用同构:
  // 只收 { type, name, scope(, projectDir) },receipt 从 main 自己的账本读,项目 identity fail-closed。
  // 既有 renderer 事实通道(ext-persist-mcp / ext-install-builtin-* / …)的下线随 renderer 切换到
  // 本通道时收口(同包发布,无跨版本兼容窗口)。
  // REQ-100:启动期事务恢复,且严格先于任何新事务(旧 switched journal 后到会把替代它的
  // generation 误移隔离区)。REQ-100 #312:注入类型化 probe + commitReceipt —— switched-未提交的
  // 事务在恢复期用同一 probe 重验健康(而非 health-by-assumption),健康则从 journal 的 receipt 模板
  // 前滚落账,不健康/账本写失败则 fail-closed 全回滚(账本零漂移)。journal 目录不存在时为 no-op。
  // #347:恢复参数按 root 构造 —— startup 与写方 gate 三处共用;commitReceipt/commitUninstall
  // 全部写**传入的 root**(此前硬编码全局根,Codex 裁决点名);MCP artifact seam 只允许全局根
  // (mcp 不进 project scope,项目根 journal 里出现 mcp-- key = 异常,保持非终态待诊断)。
  // REQ-102 #358(review Blocker 1):恢复接线必须支持 file(agent)事务 —— 探针 = skill
  // generation + agent file 组合(未知 file item 由 agentFileProbe fail-closed 拒),receipt
  // 前滚经 recoveryReceiptInputs 过滤无 receipt 的副 item(与安装路径同一过滤;裸 map 会让
  // config 副 item 缺 kind/name 导致重放永久失败 → 回滚却留下已写 receipt 的双真源分叉)。
  const recoveryOpts = (root: string): RecoverOptions => {
    const agentProbe = agentFileProbe(root)
    const pluginProbe = seedPluginFileProbe()
    return {
    // file item 按 key 路由到各自类型化探针(#358 agent / #359 plugin payload);两者对
    // 各自方案外的 key 均 fail-closed —— 未知 file item 绝不静默放行。
    probe: async (input) => {
      const gen = await skillGenerationProbe(input)
      if (!gen.healthy) return gen
      if (input.action !== "file") return { healthy: true }
      return input.key.startsWith("agent--") ? agentProbe(input) : pluginProbe(input)
    },
    commitReceipt: (recs) => {
      const written = upsertRecordsV2(root, recoveryReceiptInputs(recs))
      if (!written.ok) throw new Error(`recovery receipt commit failed: ${written.reason}`)
    },
    // #336 r3(r2 Major 1):receipt durable 证伪 —— 恢复进入任何回滚分支前读账本判定。
    // valid + 同 txId = durable(**任一** item 在账即禁回滚,防半批分叉);absent/v1/异 txId =
    // 确证未落(允许回滚);corrupt/ledger-corrupt = 无法证伪 → 抛错(引擎 fail-closed 保留
    // 非终态,绝不在失据账本上回滚)。与 commitReceipt 同一 record→input 映射,同一真源。
    receiptCommitted: (recs) => {
      const inputs = recoveryReceiptInputs(recs)
      let anyDurable = false
      for (const input of inputs) {
        const lk = lookupForUninstall(root, input.kind, input.name)
        if (lk.status === "corrupt-match" || lk.status === "ledger-corrupt")
          throw new Error(`ledger state for ${input.kind}:${input.name} is corrupt — receipt durability unverifiable`)
        if (lk.status === "valid" && lk.record.transaction?.id === input.transaction?.id) anyDurable = true
      }
      return anyDurable
    },
    // REQ-100 #313:卸载恢复的账本删除(幂等去账;去账失败抛错 → 保持 uninstalling 供下次前滚)。
    // review #374 Major:非法/未知 key 必须抛错(journal 保持非终态待诊断),绝不静默假终态。
    commitUninstall: (key) => {
      const parsed = parseUninstallLedgerKey(key)
      if (!parsed) throw new Error(`unrecognized uninstall ledger key "${key}" — retained for diagnosis`)
      const rm = removeRecordV2(root, parsed.kind, parsed.name)
      if (!rm.ok) throw new Error(`recovery uninstall ledger removal failed: ${rm.reason}`)
    },
    // #346:config 卸载恢复的 artifact seam(恢复锁内 —— 只用 in-lock/strict 原语,绝不重取锁)。
    uninstallArtifacts: (key) => {
      if (!key.startsWith("mcp--")) throw new Error(`no artifact seam for uninstall key: ${key}`)
      if (root !== alphaGlobalRoot()) throw new Error(`mcp artifact seam is global-only — refused for root: ${root}`)
      const name = key.slice("mcp--".length)
      const cfg = removeMcpConfigInLock(name)
      if (!cfg.ok) throw new Error(cfg.reason)
      // r8 Major:恢复 seam 同款活体排除 —— 在册名读不出 = 吊销失败(journal 保持非终态前滚)。
      const live = listConfiguredMcpServerNamesStrict()
      if (!live.ok) throw new Error(`secret revocation blocked: ${live.reason}`)
      const liveNames = new Set(live.names)
      const sec = removeMcpServerSecretsStrict(userDataPath, name, (cand) => liveNames.has(cand))
      if (!sec.ok) throw new Error(sec.reason)
      // #359:与主卸载路径同语义 —— 授权账随 artifact 清,失败保持非终态前滚。
      const grants = removeInstallGrants(root, [key])
      if (!grants.ok) throw new Error(grants.reason)
    },
    log: (event, detail) => getLogger().log(`[req100-tx-recovery] ${event} ${JSON.stringify(detail)}`),
    }
  }
  const txRecovery = recoverExtensionTransactions(alphaGlobalRoot(), recoveryOpts(alphaGlobalRoot()))
  // #347:写方事务准入 gate —— 每次写操作前恢复收敛 + 终态探测放行(进程内 per-root mutex
  // 把恢复→探测→操作链成一条所有权链;拒绝语义与 busy 一致,如实返回 reason)。
  const recoveryGate = makeRecoveryGate(recoveryOpts, (m) => getLogger().log(m))
  // #390(review r1 Blocker):启动期全局生态导入必须过恢复 gate,不能只靠 ledgerReady barrier ——
  // 启动恢复失败/仍有非终态 journal 时 barrier 只 loud 记录后正常 resolve,若直接 installUncurated…
  // 就会在未收敛 journal 的 root 上创建新事务写同一本账。经 withRecoveredWrite 包装:恢复→终态探测→
  // 操作成一条 per-root 所有权链,拒则返回 GateRefusal({ok:false})不写盘。gate refusal 与安装失败
  // 对 ecosystem 调用方同形(both {ok:false;reason}),as-skipped 处置。
  const ecosystemGlobalSkillInstaller = (dir: string, origin: "imported-claude" | "imported-agents") =>
    recoveryGate.withRecoveredWrite(alphaGlobalRoot(), () => installUncuratedSkillImport(dir, plannerDeps(), { origin }))
  // REQ-099 #309:统一账本就绪 barrier —— recovery(结果不吞)→ 仅在恢复干净时跑 v1→v2 迁移。
  // recovery 不干净(锁被占/journal 未收敛)或迁移被拒:loud 记录但 barrier 正常结束,不阻断启动
  // (v2 消费面对结构有效的 v1-only 有 fallback;文件级损坏本就被 lookup fail-closed)。
  // 所有读写全局账本的 v2 IPC 与启动期 ecosystem 导入(index.ts)都 await 本 barrier。
  const ledgerReady: Promise<void> = txRecovery
    .then((r) => {
      if (!r.ok) {
        getLogger().log(`[req100-tx-recovery] not clean: ${r.reason} — skipping v1→v2 migration this launch`)
        return
      }
      if (r.reports.length) getLogger().log(`[req100-tx-recovery] converged ${r.reports.length} journal(s)`)
      // Codex review #357 major:ok:true ≠ 干净(aborted/rolled-back/待重试非终态也 ok)——
      // 账本本次启动动过手术或仍有在途 journal 就不迁,下次干净的启动再迁。
      if (!recoveryClean(r)) {
        getLogger().log(`[req099-migrate] recovery not clean (${r.reports.map((x) => `${x.txId}:${x.state}/${x.action}`).join(", ")}) — skipping migration this launch`)
        return
      }
      const env = getAlphaEnvironment()
      const m = migrateV1Ledger(env.mutableRoot, env.environment)
      if (!m.ok) {
        getLogger().log(`[req099-migrate] refused: ${m.reason}`)
        return
      }
      if (m.migrated || m.retained) getLogger().log(`[req099-migrate] adopted ${m.migrated}, retained ${m.retained} v1-only`)
      for (const w of m.warnings) getLogger().log(`[req099-migrate] ${w}`)
    })
    .catch((err) => getLogger().log(`[req100-tx-recovery] failed: ${String(err)} — skipping v1→v2 migration this launch`))
  // REQ-102(#194):packaged seed 启动期消费 = **纯读** —— 严格解码 + 平台门 + 摘要日志。
  // 不安装、不启用、零配置写入、零进程、零网络(可获得性 bundled 与激活态正交,parent AC1/AC3);
  // 浏览面 IPC(#316 ext-seed-browse)与安装编排(#317 installCatalog seed 意图)已落;Hub UI 归 REQ-103(#195)。
  try {
    const seedDir = path.join(resourcesRoot(), "extension-seed")
    if (fs.existsSync(seedDir)) {
      const seed = readPackagedSeed(seedDir)
      if (seed.ok)
        getLogger().log(
          `[req102-seed] bundled seed ${seed.seed.lock.catalogVersion}: ${seed.seed.assets.length} assets, ${seed.seed.lock.totalBytes}B (browse-only, not installed)`,
        )
      else getLogger().log(`[req102-seed] bundled seed REJECTED (fail closed): ${seed.error}`)
    }
  } catch (err) {
    getLogger().log(`[req102-seed] seed probe failed: ${String(err)}`)
  }
  // effective catalog 解析(remote/cache 验签 → bundled 快照兜底)—— 只读 inventory 面专用;
  // 激活面用 plannerDeps 内带 #314/#315 security browse-only 语义的 effectiveCatalog(浏览允许
  // bundled 兜底,激活不允许 —— 两面职责不同,不合流)。#302:channel 必填。
  const resolveEffectiveCatalog = async (): Promise<{ entries: Catalog["entries"]; channel: "remote" | "cache" | "bundled"; version: string }> => {
    const rc = await refreshRemoteCatalog(userDataPath, registryChannel)
    if (rc.source !== "none") {
      const cat = rc.catalog as Catalog
      return { entries: cat.entries ?? [], channel: rc.source, version: String(cat.version ?? rc.version) }
    }
    const bundled = bundledCatalogJson as unknown as Catalog
    return { entries: bundled.entries, channel: "bundled" as const, version: bundled.version }
  }
  const plannerDeps = (): PlannerDeps => {
    // 每次调用解析一次 effective catalog(bundle 会对逐子条目调 resolveEntry —— 不重复打网络)。
    let effective: Promise<{ entries: Catalog["entries"]; channel: "remote" | "cache" | "bundled"; version: string }> | null = null
    const effectiveCatalog = () =>
      (effective ??= (async () => {
        const rc = await refreshRemoteCatalog(userDataPath, registryChannel)
        if (rc.source !== "none") {
          const cat = rc.catalog as Catalog
          return { entries: cat.entries ?? [], channel: rc.source, version: String(cat.version ?? rc.version) }
        }
        // #314/#315:security 类失败落到 bundled 只用于**浏览**;激活解析拒绝(review B2)。
        if (rc.reasonClass === "security") {
          securityBlocked = true
          console.error(`[ext-ipc] catalog SECURITY failure (${rc.error}) — bundled catalog is browse-only; activation resolution REFUSED`)
        }
        const bundled = bundledCatalogJson as unknown as Catalog
        return { entries: bundled.entries, channel: "bundled" as const, version: bundled.version }
      })())
    // #315(review B1):advisory 视图**懒冻结** —— 首次取用发生在 resolveEntry 的 await
    // 刷新(可能持久化更新公示)之后,保证本操作用的是刷新后的视图;冻结后 bundle fan-out
    // 与后续位点共享同一份(操作内不再变)。
    let gateMemo: ReturnType<typeof makeAdvisoryGate> | null = null
    const advisoryGate: ReturnType<typeof makeAdvisoryGate> = (input) => (gateMemo ??= makeAdvisoryGate(userDataPath))(input)
    // #315(review B2):security 类失败下 bundled 只许浏览 —— 激活面的条目解析直接拒绝,
    // 不得借道随包 catalog 完成安装(合同「browse-only」不是修辞)。
    let securityBlocked = false
    return {
      advisoryGate,
      resolveEntry: async (catalogId) => {
        const cat = await effectiveCatalog()
        if (securityBlocked) {
          console.error(`[ext-ipc] resolveEntry(${catalogId}) refused: catalog in security-failure state (browse-only)`)
          return null
        }
        const entry = cat.entries.find((e) => e.id === catalogId)
        return entry ? { entry, channel: cat.channel, catalogVersion: cat.version } : null
      },
      environment: () => getAlphaEnvironment().environment,
      platform: () => process.platform,
      globalRoot: alphaGlobalRoot,
      installers: {
        // #378:MCP 策略闸口(Excel workspace;非权威 provisioning,引擎 config action 落盘)
        // + 版本化密钥原语(裁决 Q1:只增不覆盖;引用纯推导与落盘同参)。
        applyMcpWritePolicy,
        mcpSecretRefFor: (name, verId, varName) => mcpSecretVersionedRef(userDataPath, name, verId, varName),
        claimMcpSecretVersionDir: (name, verId) => claimMcpSecretVersionDir(userDataPath, name, verId),
        writeMcpSecretVersioned: (name, verId, varName, value) => writeMcpSecretVersioned(userDataPath, name, verId, varName, value),
        removeMcpSecretVersionDir: (name, verId) => removeMcpSecretVersionDir(userDataPath, name, verId),
        gcMcpSecrets: (name) => gcMcpSecretsAgainstConfig(userDataPath, name),
        legacyMcpRefPaths: (name) => collectLegacyMcpRefPathsStrict(name),
        // #346:journaled MCP 卸载的两个 in-lock/strict 原语(引擎事务锁内调用)。
        removeMcpConfigInLock,
        removeMcpSecretsStrict: (name) => {
          // r8 Major:兄弟备份删除的活体排除种子 —— 在册名集合读不出 = 吊销失败(可观察),
          // 绝不冒险把可能是另一在册 server 的目录当备份删。
          const live = listConfiguredMcpServerNamesStrict()
          if (!live.ok) return { ok: false as const, reason: `secret revocation blocked: ${live.reason}` }
          const names = new Set(live.names)
          return removeMcpServerSecretsStrict(userDataPath, name, (cand) => names.has(cand))
        },
        // #354:写前 strict 前像读(产品早拒 + 锁内 precondition 重验)。
        readMcpLeafStrict,
        // #378(裁决 Q5):npm plugin 跨源(主 + legacy XDG)同 base 严格检查。
        findPluginBaseConflictStrict,
        readPluginArrayStrict,
        // #378 r6/r7:全部 legacy 配置源 plugin[] strict 读(同名路径冲突/旧目录 GC 覆盖合并视图)。
        readLegacyPluginArrayStrict,
        // #378 r7:引擎配置真源路径(escape-hatch 路由门)。
        mcpConfigTruthPath,
        stageVendoredPluginVersioned,
        agentPresent: (name, target) => agentInstallPresent(name, target),
        removePlugin,
        // #378:vendored plugin 载荷采集(CAS 摄取源;flat 写入器 installVendoredPlugin 已删)。
        collectVendoredPluginPayload,
        removePluginPath,
        installBuiltinSkill,
        installRemoteSkill,
        removeFsInstall,
        // #361:builtin agent 原始载荷收集(随包 md → CAS 摄取 → 事务安装;不再有 flat 写通道)。
        collectBuiltinAgentPayload,
        downloadRemoteAsset,
        // REQ-100 #310:builtin skill 载荷收集(随包目录 → generation 事务 populate;不落 flat 目录)。
        collectBuiltinSkillPayload: (builtinAssetKey: string, name: string) => {
          if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) return { ok: false as const, reason: "invalid skill name" }
          if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(builtinAssetKey)) return { ok: false as const, reason: "invalid asset key" }
          const srcDir = path.join(resourcesRoot(), builtinAssetKey)
          if (!fs.existsSync(path.join(srcDir, "SKILL.md"))) return { ok: false as const, reason: "技能内容未随此版本打包" }
          return collectSkillPayloadFromDir(srcDir)
        },
      },
      // REQ-098 #303:共享 CAS 基根 = main 冻结环境快照(renderer 无路径通道);skill 内容一律
      // 先提升进验证 CAS 再由事务物化。
      casBaseRoot: () => getAlphaEnvironment().casBaseRoot,
      // REQ-102 #317:seed 安装通道 —— seedDir/回表 catalog 全部 main-owned。回表只用随包
      // bundled catalog 快照(绝不 effective remote/cache:远端更新会让 seed 字节配错安装语义)。
      seed: {
        seedDir: () => {
          const dir = path.join(resourcesRoot(), "extension-seed")
          return fs.existsSync(dir) ? dir : null
        },
        resolveBundledEntry: (catalogId) => {
          const bundled = bundledCatalogJson as unknown as Catalog
          const entry = (bundled.entries ?? []).find((e) => e.id === catalogId)
          return entry ? { entry, channel: "bundled" as const, catalogVersion: String(bundled.version) } : null
        },
      },
    }
  }
  // #347 root 解析:global 写方恒全局根;uninstall/set-state 由严格 intent 解码定根(project
  // identity fail-closed,与 planner 同口径);解析失败原样返回、零副作用、不进 gate。
  const globalWriteRoot = (..._args: unknown[]) => ({ ok: true as const, root: alphaGlobalRoot() })
  const projectRootOf = (projectDir: string): { ok: true; root: string } | { ok: false; reason: string } => {
    const identity = projectScopeIdentity(projectDir)
    if (!identity.ok) return { ok: false, reason: `fail closed: ${identity.reason}` }
    const root = alphaRoot(identity.scope.projectPath)
    if (!root) return { ok: false, reason: `fail closed: invalid project root: ${projectDir}` }
    return { ok: true, root }
  }
  const uninstallIntentRoot = (rawIntent: unknown): { ok: true; root: string } | { ok: false; reason: string } => {
    const d = decodeUninstallIntent(rawIntent)
    if (!d.ok) return d
    return d.intent.scope === "project" ? projectRootOf(d.intent.projectDir) : globalWriteRoot()
  }
  const setStateIntentRoot = (rawIntent: unknown): { ok: true; root: string } | { ok: false; reason: string } => {
    const d = decodeSetStateIntent(rawIntent)
    if (!d.ok) return d
    return d.intent.scope === "project" ? projectRootOf(d.intent.projectDir) : globalWriteRoot()
  }

  const importTargetRoot = (target: InstallTarget | undefined): { ok: true; root: string } | { ok: false; reason: string } => {
    if (target === undefined) return globalWriteRoot()
    if (!target || typeof target !== "object" || (target.scope !== "global" && target.scope !== "project"))
      return { ok: false, reason: "target: invalid install target" }
    return target.scope === "project" ? projectRootOf(target.projectDir) : globalWriteRoot()
  }
  // REQ-100 #313:generation 历史读 + 两版离线回滚(key-based,同卸载信任边界;先等崩溃恢复收敛)。
  ipcMain.handle("ext-list-generations", async (_event: IpcMainInvokeEvent, intent: unknown) => {
    await ledgerReady
    return listGenerationsByKey(intent, { globalRoot: alphaGlobalRoot })
  })
  // #397:SBOM / 来源溯源 blob 按需拉取(合同 §7.3 采信前置全在 main;renderer 只给
  // (catalogId, kind),entry/BlobRef/URL 全由 main 从已验 catalog 派生 —— 只读通道,零写面。
  // 失败不影响货架/启用判定(摘要已内联),详情面如实报错 + 重试即重拉。
  ipcMain.handle("ext-curation-blob", async (_event: IpcMainInvokeEvent, catalogId: unknown, kind: unknown) =>
    fetchCurationBlob({ resolveEntry: plannerDeps().resolveEntry }, catalogId, kind),
  )
  // #347(Codex 裁决 d)+ #395:set-state 过 gate;锁由 planner 内部管理(自持 Bundle 锁)——
  // mcp/agent/plugin 在锁内做**持久化 config 投影普通原子写 + 账本翻转**(非事务;disable config 先、
  // enable 账本先,失败回滚,见 setInstallStateByKey),skill 纯账本翻转(投影经引擎注入门)。
  // 此处不得预持锁(会与 planner 内锁互斥死锁)。
  const setInstallStateBody = async (intent: unknown) => {
    // #397:enable 方向的 curation 闸需要 resolveEntry(已验 effective catalog)—— 直接用
    // plannerDeps(自带 #314/#315 security browse-only 语义与懒冻结 advisory 视图)。
    return setInstallStateByKey(intent, plannerDeps())
  }
  // ADR-030(#372):收回路径的残留检测(只读)与显式清理(journal 在场 fail-closed;
  // generation-aware —— 删受控 ext-store + 对应账本,绝不落 flat 删除)。
  ipcMain.handle("ext-project-residuals-check", async (_event: IpcMainInvokeEvent, projectDir: unknown) => {
    await ledgerReady
    return detectProjectCatalogResiduals(projectDir)
  })
  // ── #375:journal 管理面(诊断只读 + 显式 retire)。**刻意不进 GATED_WRITE_CHANNELS**
  // (恢复 gate 拒非终态 journal 是其本职,与 retire 对象语义相反;不写 ledger/config/store),
  // 经 JOURNAL_ADMIN_CHANNELS 独立注册表 + 构造器接入;互斥 = retire 自持 root Bundle 锁。
  const journalGlobalRoots = (): JournalRootRef[] => {
    const base = getAlphaEnvironment().casBaseRoot
    return [
      { identity: "dev", root: environmentMutableRoot("dev", base) },
      { identity: "prod", root: environmentMutableRoot("prod", base) },
      { identity: "beta", root: environmentMutableRoot("beta", base) },
    ]
  }
  const journalAdmin = buildJournalAdminChannels({
    globalRoots: journalGlobalRoots,
    projectRoot: (projectDir) => projectRootOf(projectDir),
    list: (roots) => listRetainedJournals(roots),
    retire: (ref, req) =>
      retireTransactionJournal(ref, req, {
        // 裁决 Q1:锁内最后收敛必须用 InHeldLock 核心(文件锁非重入,公共入口必然 busy-skip)。
        recoverInHeldLock: (root, onProgress) => recoverExtensionTransactionsInHeldLock(root, { ...recoveryOpts(root), onProgress }),
      }),
  })
  ipcMain.handle(JOURNAL_ADMIN_CHANNELS.retainedList, async (_event: IpcMainInvokeEvent, intent: unknown) => {
    await ledgerReady // 诊断读也等启动收敛(避免把启动期正在收敛的 journal 误报为保留态)
    return journalAdmin.retainedList(intent)
  })
  ipcMain.handle(JOURNAL_ADMIN_CHANNELS.retire, async (_event: IpcMainInvokeEvent, intent: unknown) => {
    await ledgerReady
    return journalAdmin.retire(intent)
  })
  // ── #347(review #376 B1/M3):**全部生产写通道**经写通道表(ext-write-channels.ts 唯一真源)
  // 统一构造:恢复准入 gate + 按操作 root 解析;此处只做 ledgerReady barrier + ipc 注册。
  // 新写通道必须先进表登记,不得直接 ipcMain.handle。
  // #390:target 是否 project scope —— global 未策展导入走事务,project 维持 sanctioned flat 路径。
  const isProjectTarget = (t: InstallTarget | undefined): boolean =>
    !!t && typeof t === "object" && (t as { scope?: string }).scope === "project"
  const gatedWrite = buildGatedWriteChannels({
    gate: recoveryGate,
    roots: {
      global: globalWriteRoot,
      uninstallIntent: uninstallIntentRoot,
      setStateIntent: setStateIntentRoot,
      importTarget: importTargetRoot,
      projectDir: (projectDir: unknown) =>
        typeof projectDir === "string" && path.isAbsolute(projectDir)
          ? projectRootOf(projectDir)
          : { ok: false as const, reason: "projectDir: required absolute path" },
    },
    bodies: {
      installCatalog: (intent) => installCatalog(intent, plannerDeps()),
      uninstallV2: (intent) => uninstallByKey(intent, plannerDeps()),
      rollback: async (intent, genId) => rollbackGenerationByKey(intent, genId, { globalRoot: alphaGlobalRoot, advisoryGate: makeAdvisoryGate(userDataPath) }),
      setInstallState: setInstallStateBody,
      // #347:清理前先经 gate 对项目根做显式恢复收敛(ADR-030「先显式恢复再清理」);clean 自身
      // 的 openJournals fail-closed 仍在(纵深)。
      projectResidualsClean: (projectDir) => cleanProjectCatalogResiduals(projectDir, plannerDeps()),
      removeMcpLegacy: removeMcpLegacyBody,
      persistMcp: (name, server, secretVars) => persistMcpBody(name as string, server as Record<string, unknown>, secretVars as string[] | undefined),
      installPlugin: (pkg) => installPluginBody(pkg as string),
      importAgentConfirm: importAgentConfirmBody,
      // #390:global 未策展技能导入走 planner 的 CAS + generation 事务(取代 flat copy 的崩溃半成品窗);
      // project scope 维持 `<project>/.alpha/skills` sanctioned flat 路径(ADR-030,不 reopen project generation)。
      // 生产 renderer 从 hub 导入恒 global(不传 target);project 仅经 ecosystem-import 通道,不走本 body。
      importSkillFolder: async (srcDir, target) =>
        isProjectTarget(target)
          ? importSkillFolder(srcDir, target)
          : installUncuratedSkillImport(srcDir, plannerDeps(), { origin: "imported" }),
      importSkillGit: async (url, target) => {
        const cloned = await cloneSkillGitToTmp(url as string)
        if (!cloned.ok) return cloned
        try {
          return isProjectTarget(target)
            ? importSkillFolder(cloned.srcDir, target)
            : await installUncuratedSkillImport(cloned.srcDir, plannerDeps(), { origin: "imported" })
        } finally {
          cloned.cleanup()
        }
      },
    },
  })
  const barrier = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    async (_event: IpcMainInvokeEvent, ...a: A): Promise<R> => {
      await ledgerReady // #309:账本写方等 recovery+迁移收敛
      return fn(...a)
    }
  ipcMain.handle(GATED_WRITE_CHANNELS.installCatalog, barrier(gatedWrite.installCatalog))
  ipcMain.handle(GATED_WRITE_CHANNELS.uninstallV2, barrier(gatedWrite.uninstallV2))
  ipcMain.handle(GATED_WRITE_CHANNELS.rollback, barrier(gatedWrite.rollback))
  ipcMain.handle(GATED_WRITE_CHANNELS.setInstallState, barrier(gatedWrite.setInstallState))
  ipcMain.handle(GATED_WRITE_CHANNELS.projectResidualsClean, barrier(gatedWrite.projectResidualsClean))
  ipcMain.handle(GATED_WRITE_CHANNELS.removeMcpLegacy, barrier(gatedWrite.removeMcpLegacy))
  ipcMain.handle(GATED_WRITE_CHANNELS.persistMcp, barrier(gatedWrite.persistMcp))
  ipcMain.handle(GATED_WRITE_CHANNELS.installPlugin, barrier(gatedWrite.installPlugin))
  ipcMain.handle(GATED_WRITE_CHANNELS.importAgentConfirm, barrier(gatedWrite.importAgentConfirm))
  // 目录选择在 gate 外(mutex 不横跨用户交互);持久化阶段过表。
  ipcMain.handle(GATED_WRITE_CHANNELS.importSkillFolder, async (_event: IpcMainInvokeEvent, target?: InstallTarget) => {
    await ledgerReady
    const picked = await pickImportSkillDir()
    if (!picked.ok) return picked
    return gatedWrite.importSkillFolder(picked.srcDir, target)
  })
  ipcMain.handle(GATED_WRITE_CHANNELS.importSkillGit, barrier(gatedWrite.importSkillGit))
  // REQ-099(ADR-028 §5):Hub 项目上下文读通道 —— global 与当前项目的 v2 账本分读(物理分域),
  // records 带 environment/scope identity/desiredState/generation;v1Only 为只读兼容面。
  ipcMain.handle("ext-list-installs-v2", async (_event: IpcMainInvokeEvent, projectDir?: unknown) => {
    await ledgerReady // #309:读方同 barrier(迁移中途的半程视图不外泄)
    const global = readLedgerV2(alphaGlobalRoot())
    const projectRoot = typeof projectDir === "string" && projectDir ? alphaRoot(projectDir) : null
    return { global, project: projectRoot ? readLedgerV2(projectRoot) : null }
  })
  // REQ-103 slice 2a(#195):governance 只读查询 —— 逐扩展五维所有权 + 三态(slice 1 聚合面)。
  // 唯一的 governance 通道,零写面:核心是 electron-free 的 createInventoryQuery(纯读契约与
  // 负向面在 ext-inventory(-boundaries).test 钉死);catalog 输入复用上面的已验 resolve 面。
  const inventorySeedDir = path.join(resourcesRoot(), "extension-seed")
  const inventoryQuery = createInventoryQuery({
    resolveCatalog: resolveEffectiveCatalog,
    seedDir: fs.existsSync(inventorySeedDir) ? inventorySeedDir : null,
    globalRoot: alphaGlobalRoot,
  })
  ipcMain.handle("ext-inventory-view", (_event: IpcMainInvokeEvent, projectDir?: unknown) => inventoryQuery(projectDir))
  // #309:启动期账本消费方(index.ts 的 global ecosystem gate)await 此 barrier 后再写账本。
  // #390:同时交出恢复-gate 包装的 global 技能安装器,供 ecosystem gate 走事务安装(不绕恢复准入)。
  return { ledgerReady, ecosystemGlobalSkillInstaller }
}
