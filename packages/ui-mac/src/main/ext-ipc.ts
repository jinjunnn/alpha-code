// Extension Hub IPC handlers (main process). Mirrors ipc.ts's ipcMain.handle pattern. Three thin
// privileged operations the renderer can't do itself: persist/remove an MCP server in the user
// config (ext-config.ts), and a runtime which-check so the UI can warn before adding a local MCP
// whose binary (uv/node/…) is missing. All validation lives in ext-config / here — see ADR-014 §8.

import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron"
import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { toolProbe } from "./platform"
import { extensionsGranted, hasExtensionsDecision, listProjectExecutables, withExtensionsConsent } from "./alpha-ext-trust"
import { alphaRoot, readProjectPrefs, writeProjectPrefs } from "./alpha-workdir"
import type { InstallTarget } from "../preload/types"
import { alphaGlobalRoot, listInstalls } from "./alpha-installs"
import { fileifyMcpSecrets, fileifyMcpSecretsDeep, removeMcpServerSecrets, snapshotMcpServerSecrets } from "./alpha-mcp-secrets"
import { isMigrationEnabled, removeLegacy, scanLegacy, verifyLegacyProvenance, type ProvenanceRequest } from "./alpha-migrate"
import { configHealth, persistPlugin, pluginRecordName, readMcpLeaf, removeMcp, removePlugin, removePluginEntryExact, removePluginPath, restoreMcpLeaf } from "./ext-config"
import { recordUncuratedInstall } from "./ext-uncurated-record"
import { persistMcpWithPolicy } from "./ext-mcp-policy"
import { ensureUserWorkspaceDir } from "./alpha-user-workspace"
import { importSkillFolder, importSkillGit, installBuiltinAgent, installBuiltinSkill, installRemoteAgent, installRemoteSkill, installVendoredPlugin, readBuiltinSkill, removeFsInstall, resourcesRoot, writeAgent } from "./ext-fs-installer"
import { parseAgentImport } from "./ext-import-validate"
import { collectSkillPayloadFromDir, commitInputFromRecord, skillGenerationProbe } from "./ext-skill-generations"
import { randomUUID } from "node:crypto"
import { pickedFiles } from "./ipc"
import { factorySkillIds } from "./factory-skills"
import { downloadRemoteAsset, refreshRemoteCatalog } from "./remote-catalog"
import { applyGovernance, effectiveFactoryDenied, normalizeGovernance, protectionInfo, readGovernance, resetGovernance } from "./alpha-governance"
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
import { getAlphaEnvironment } from "./alpha-environment"
import { installCatalog, listGenerationsByKey, rollbackGenerationByKey, setInstallStateByKey, uninstallByKey, type PlannerDeps } from "./ext-install-planner"
import { migrateV1Ledger, readLedgerV2, removeRecordV2, upsertRecordsV2 } from "./ext-receipt-v2"
import { readPackagedSeed } from "./ext-seed"
import { recoverExtensionTransactions, recoveryClean } from "./ext-transaction"
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

export function registerExtIpcHandlers(userDataPath: string) {
  ipcMain.handle(
    "ext-persist-mcp",
    // REQ-099 #305:未策展自定义 MCP 专用通道(catalog MCP 走 ext-install-catalog);不收 renderer
    // meta —— 未策展安装拿不到 catalog 身份,防伪造 catalog 来源/版本(ADR-028 §5)。
    (_event: IpcMainInvokeEvent, name: string, server: Record<string, unknown>, secretVars?: string[]) => {
      // T5:把 requiredEnvVars 的真值(renderer 刚采集,经 IPC 结构化克隆到达此处)搬进
      // {file:} 密钥通道 → durable config 只落引用,绝不明文。renderer 的 live mcp.add 仍用
      // 真值(内存态),下次启动引擎按 {file:} 解析。
      // Codex review #351:失败(含配置写锁 busy)按快照复原 —— 更新场景不得毁掉既有安装仍被
      // config 引用的密钥;原本无密钥则等价于撤掉新写入(不留孤儿,REQ-033 codex L 语义保留)。
      const hasSecrets = !!(secretVars && secretVars.length && server && typeof server === "object")
      const snap = hasSecrets ? snapshotMcpServerSecrets(userDataPath, name) : null
      // Codex review #355:补偿必须是精确叶子 before-image —— removeMcp 全量卸载会连既有配置/
      // legacy/receipt 一起误删(更新场景毁掉本次写入前就存在的安装)。
      const before = typeof name === "string" ? readMcpLeaf(name) : undefined
      if (hasSecrets) fileifyMcpSecrets(userDataPath, name, server, secretVars!)
      // REQ-105 #254:MCP 写盘唯一策略入口。Excel sandbox 闸口(local stdio + 审计钉版 + 零网络
      // 绑定 + 受管 workspace 强制)由 persistMcpWithPolicy 统一执行 —— main 注入固定 EXCEL_FILES_PATH,
      // 结构上消除「调用点忘传 workspace」的 fail-open;planner 的 installers.persistMcp 同走此闸。
      const r = persistMcpWithPolicy(name, server, undefined)
      if (!r.ok) {
        snap?.restore()
        return r
      }
      // REQ-099 #306:未策展落账走 coordinator(v2+派生 v1 单次写);失败补偿 = 撤配置 + 复原密钥,
      // 不谎报成功(#336 语义)。
      const led = recordUncuratedInstall(alphaGlobalRoot(), {
        kind: "mcp",
        name,
        origin: "created",
        environment: getAlphaEnvironment().environment,
        scope: { kind: "global" },
        configKey: `mcp.${name}`,
      })
      if (!led.ok) {
        restoreMcpLeaf(name, before) // 只复原本次目标叶子(before=undefined 即删本次写入)
        snap?.restore()
        return { ok: false, reason: `install ledger write failed: ${led.reason}` }
      }
      snap?.discard()
      return r
    },
  )
  // Codex review #351:先删配置(锁内)、成功才吊销密钥 —— busy 时不得留下「配置还在、密钥已毁」。
  ipcMain.handle("ext-remove-mcp", (_event: IpcMainInvokeEvent, name: string) => {
    const r = removeMcp(name)
    if (r.ok) removeMcpServerSecrets(userDataPath, name)
    return r
  })
  // B11/B23:全局配置健康探测(语法错/未知顶键 → 引擎会整份清零)
  ipcMain.handle("ext-config-health", () => configHealth())
  ipcMain.handle("ext-check-runtime", (_event: IpcMainInvokeEvent, tool: string) => checkRuntime(tool))
  // REQ-036:创建表单已移除(创建走技能:skill-creator/agent-creator 出厂注入),原
  // ext-write-skill / ext-write-agent 渲染层通道随之下线;main 的 writeSkill/writeAgent 保留
  // (installBuiltinAgent 等 vendored 安装管线内部复用)。
  ipcMain.handle("ext-factory-skill-ids", () => factorySkillIds())

  // REQ-037 上游能力治理:真源 ~/.alpha/governance.json,物化 home jsonc 受控叶子(见 alpha-governance.ts)。
  // apply 后由 renderer 调 refreshEngine()(dispose)热生效 —— 与安装链路同节奏。
  // REQ-067:factoryDenied = 出厂默认禁的有效名单(出厂清单 − 用户解禁)—— 菜单过滤与治理面板共用
  ipcMain.handle("gov-read", () => {
    const gov = readGovernance()
    return { gov, protection: protectionInfo(), factoryDenied: effectiveFactoryDenied(gov) }
  })
  ipcMain.handle("gov-apply", (_event: IpcMainInvokeEvent, gov: unknown, visibleAgents: unknown, confirmBuildDisable?: boolean) => {
    const agents = Array.isArray(visibleAgents) ? visibleAgents.filter((a): a is string => typeof a === "string") : []
    return applyGovernance(normalizeGovernance(gov), agents, confirmBuildDisable === true)
  })
  ipcMain.handle("gov-reset", () => resetGovernance())

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
  ipcMain.handle("ext-import-agent-confirm", (_event: IpcMainInvokeEvent, previewId: string) => {
    const issued = typeof previewId === "string" ? issuedAgentImports.get(previewId) : undefined
    if (!issued) return { ok: false, reason: "预览已失效,请重新选择文件" }
    // Codex review #351:写成功才消费 preview —— 配置写锁 busy 等可重试失败后,用户重点确认
    // 不该只能得到「预览已失效」(单次消费语义只对成功写入成立)。
    const r = writeAgent(issued.name, issued.composed, undefined, undefined, "imported")
    if (r.ok) issuedAgentImports.delete(previewId)
    return r
  })

  ipcMain.handle("ext-remote-catalog", () => refreshRemoteCatalog(userDataPath))
  // REQ-100 #313:旧 ext-install-remote-skill / ext-install-builtin-skill 通道已下线 —— catalog skill
  // 安装只走 ext-install-catalog(planner 从已验签 catalog 派生事实,落 generation 事务);保留
  // renderer 可伪造 assetKey/name/meta 的旧面就是保留技能身份伪装通道(Codex review #345)。
  // REQ-099 #305:旧 catalog 事实通道全部下线 —— ext-install-remote-agent / ext-install-builtin-agent /
  // ext-install-vendored-plugin / ext-enable-cloud 均并入 ext-install-catalog(planner 从已验签 catalog
  // 派生全部事实);ext-install-plugin 仅保留给未策展 npm 导入,且不再收 renderer meta(未策展安装
  // 无 catalog 身份,防伪造 catalog 来源,ADR-028 §5)。
  ipcMain.handle("ext-install-plugin", (_event: IpcMainInvokeEvent, pkg: string) => {
    const r = persistPlugin(pkg, undefined)
    if (!r.ok) return r
    // Codex review #355:恰同钉版重装 = 真幂等 → 跳过落账(不虚增 generation);
    // 同 base 不同钉版已在 persistPlugin 内显式拒绝(不许「配置不变、账本记新版」)。
    if (!r.changed) return { ok: true }
    // REQ-099 #306:未策展 npm 导入落账(coordinator);失败只撤本次新增的数组元素(精确补偿,
    // 不碰 legacy/receipt/同 base 其他条目)。
    const led = recordUncuratedInstall(alphaGlobalRoot(), {
      kind: "plugin",
      name: pluginRecordName(pkg),
      origin: "created",
      environment: getAlphaEnvironment().environment,
      scope: { kind: "global" },
      configKey: `plugin:${pkg}`,
    })
    if (!led.ok) {
      removePluginEntryExact(pkg)
      return { ok: false, reason: `install ledger write failed: ${led.reason}` }
    }
    return { ok: true }
  })
  // REQ-019 T3:详情页 SKILL.md 预览(只读,资产键校验 + 体积帽)
  ipcMain.handle("ext-read-builtin-skill", (_event: IpcMainInvokeEvent, builtinAssetKey: string) =>
    readBuiltinSkill(builtinAssetKey),
  )
  // REQ-019 T6 / REQ-098 #255:folder 导入 = main 自弹目录选择器,用户实选目录即来源 —— renderer
  // 不再传入任意绝对 srcDir(此前被攻陷 renderer 可直接调 bridge 读任意目录并复制入当前根,picker
  // 非安全边界)。合并「弹窗+导入」为一个 IPC,renderer 全程拿不到可回传的授权路径。
  ipcMain.handle("ext-import-skill-folder", async (_event: IpcMainInvokeEvent, target?: InstallTarget) => {
    let srcDir: string | undefined
    if (process.env.ALPHA_OPEN_DIR) {
      srcDir = process.env.ALPHA_OPEN_DIR // headless/测试短路(main 控制的 env,非 renderer 输入)
    } else {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory"],
        title: "选择要导入的技能文件夹",
        defaultPath: ensureUserWorkspaceDir() ?? undefined,
      })
      if (result.canceled || result.filePaths.length === 0) return { ok: false as const, canceled: true, reason: "已取消" }
      srcDir = result.filePaths[0]
    }
    return importSkillFolder(srcDir!, target)
  })
  ipcMain.handle("ext-import-skill-git", (_event: IpcMainInvokeEvent, url: string, target?: InstallTarget) =>
    importSkillGit(url, target),
  )
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
      const r = importExternalSkills(detected.skills, { scope: "project", projectDir: directory })
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
  const txRecovery = recoverExtensionTransactions(alphaGlobalRoot(), {
    probe: skillGenerationProbe,
    commitReceipt: (recs) => {
      const written = upsertRecordsV2(alphaGlobalRoot(), recs.map((rec) => commitInputFromRecord(rec)))
      if (!written.ok) throw new Error(`recovery receipt commit failed: ${written.reason}`)
    },
    // REQ-100 #313:卸载恢复的账本删除(key="skill--<name>" → 幂等去账;去账失败抛错 → 保持
    // uninstalling 供下次前滚,绝不谎报卸载完成)。
    commitUninstall: (key) => {
      const sep = key.indexOf("--")
      if (sep <= 0) return // 非法 key = 无可去账
      const kind = key.slice(0, sep)
      const name = key.slice(sep + 2)
      if (kind !== "skill" && kind !== "agent" && kind !== "mcp" && kind !== "plugin" && kind !== "cloud") return
      const rm = removeRecordV2(alphaGlobalRoot(), kind, name)
      if (!rm.ok) throw new Error(`recovery uninstall ledger removal failed: ${rm.reason}`)
    },
    log: (event, detail) => getLogger().log(`[req100-tx-recovery] ${event} ${JSON.stringify(detail)}`),
  })
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
  // 浏览面 IPC 与安装编排(planner/事务 + populateFromCas)随 REQ-103(#195)接 Hub UI。
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
  const plannerDeps = (): PlannerDeps => {
    // 每次调用解析一次 effective catalog(bundle 会对逐子条目调 resolveEntry —— 不重复打网络)。
    let effective: Promise<{ entries: Catalog["entries"]; channel: "remote" | "cache" | "bundled"; version: string }> | null = null
    const effectiveCatalog = () =>
      (effective ??= (async () => {
        const rc = await refreshRemoteCatalog(userDataPath)
        if (rc.source !== "none") {
          const cat = rc.catalog as Catalog
          return { entries: cat.entries ?? [], channel: rc.source, version: String(cat.version ?? rc.version) }
        }
        const bundled = bundledCatalogJson as unknown as Catalog
        return { entries: bundled.entries, channel: "bundled" as const, version: bundled.version }
      })())
    return {
      resolveEntry: async (catalogId) => {
        const cat = await effectiveCatalog()
        const entry = cat.entries.find((e) => e.id === catalogId)
        return entry ? { entry, channel: cat.channel, catalogVersion: cat.version } : null
      },
      environment: () => getAlphaEnvironment().environment,
      platform: () => process.platform,
      globalRoot: alphaGlobalRoot,
      installers: {
        persistMcp: persistMcpWithPolicy, // REQ-105 #254:planner 生产安装同走 Excel workspace 闸口
        fileifyMcpSecrets: (name, server, secrets) => fileifyMcpSecretsDeep(userDataPath, name, server, secrets),
        removeMcpSecrets: (name) => removeMcpServerSecrets(userDataPath, name),
        removeMcp,
        persistPlugin,
        removePlugin,
        installVendoredPlugin,
        removePluginPath,
        installBuiltinSkill,
        installBuiltinAgent,
        installRemoteSkill,
        installRemoteAgent,
        removeFsInstall,
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
    }
  }
  ipcMain.handle("ext-install-catalog", async (_event: IpcMainInvokeEvent, intent: unknown) => {
    await ledgerReady
    return installCatalog(intent, plannerDeps())
  })
  ipcMain.handle("ext-uninstall-v2", async (_event: IpcMainInvokeEvent, intent: unknown) => {
    await ledgerReady
    return uninstallByKey(intent, plannerDeps())
  })
  // REQ-100 #313:generation 历史读 + 两版离线回滚(key-based,同卸载信任边界;先等崩溃恢复收敛)。
  ipcMain.handle("ext-list-generations", async (_event: IpcMainInvokeEvent, intent: unknown) => {
    await ledgerReady
    return listGenerationsByKey(intent, { globalRoot: alphaGlobalRoot })
  })
  ipcMain.handle("ext-rollback", async (_event: IpcMainInvokeEvent, intent: unknown, genId: unknown) => {
    await ledgerReady
    return rollbackGenerationByKey(intent, genId, { globalRoot: alphaGlobalRoot })
  })
  ipcMain.handle("ext-set-install-state", async (_event: IpcMainInvokeEvent, intent: unknown) => {
    await ledgerReady // #309:账本写方等 recovery+迁移收敛
    return setInstallStateByKey(intent, { globalRoot: alphaGlobalRoot })
  })
  // REQ-099(ADR-028 §5):Hub 项目上下文读通道 —— global 与当前项目的 v2 账本分读(物理分域),
  // records 带 environment/scope identity/desiredState/generation;v1Only 为只读兼容面。
  ipcMain.handle("ext-list-installs-v2", async (_event: IpcMainInvokeEvent, projectDir?: unknown) => {
    await ledgerReady // #309:读方同 barrier(迁移中途的半程视图不外泄)
    const global = readLedgerV2(alphaGlobalRoot())
    const projectRoot = typeof projectDir === "string" && projectDir ? alphaRoot(projectDir) : null
    return { global, project: projectRoot ? readLedgerV2(projectRoot) : null }
  })
  // #309:启动期账本消费方(index.ts 的 global ecosystem gate)await 此 barrier 后再写账本。
  return ledgerReady
}
