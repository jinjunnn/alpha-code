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
import type { InstallMeta, InstallReceipt, InstallTarget } from "../preload/types"
import { addReceipt, alphaGlobalRoot, listInstalls, removeReceipt } from "./alpha-installs"
import { fileifyMcpSecrets, removeMcpServerSecrets } from "./alpha-mcp-secrets"
import { isMigrationEnabled, removeLegacy, scanLegacy, verifyLegacyProvenance, type ProvenanceRequest } from "./alpha-migrate"
import { configHealth, persistMcp, persistPlugin, removeMcp, removePlugin, removePluginPath } from "./ext-config"
import { importSkillFolder, importSkillGit, installBuiltinAgent, installBuiltinSkill, installRemoteAgent, installRemoteSkill, installVendoredPlugin, readBuiltinSkill, removeFsInstall, resourcesRoot, writeAgent } from "./ext-fs-installer"
import { parseAgentImport } from "./ext-import-validate"
import { randomUUID } from "node:crypto"
import { pickedFiles } from "./ipc"
import { factorySkillIds } from "./factory-skills"
import { downloadRemoteAsset, refreshRemoteCatalog, type RemoteAssetFile } from "./remote-catalog"
import { applyGovernance, effectiveFactoryDenied, normalizeGovernance, protectionInfo, readGovernance, resetGovernance } from "./alpha-governance"
import {
  detectExternal,
  ecosystemInheritEnabled,
  hasExternalImportDecision,
  importExternalSkills,
  importProjectClaudeMd,
  withExternalImportDecision,
} from "./ecosystem-import"
import { checkExcelMcpSafety } from "../shared/office-advisories"
// REQ-099(ADR-028):main-only 安装计划 + v2 账本。随包 catalog 快照 = 验签远端/缓存不可用时的
// 兜底真源(ADR-023 两级真源;与 renderer 的 B20 兜底同一字节)。
import bundledCatalogJson from "../renderer/extensions/alpha-catalog.json"
import type { Catalog } from "../renderer/extensions/catalog-types"
import { getAlphaEnvironment } from "./alpha-environment"
import { installCatalog, setInstallStateByKey, uninstallByKey, type PlannerDeps } from "./ext-install-planner"
import { readLedgerV2 } from "./ext-receipt-v2"
import { recoverExtensionTransactions } from "./ext-transaction"
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
    (_event: IpcMainInvokeEvent, name: string, server: Record<string, unknown>, meta?: InstallMeta, secretVars?: string[]) => {
      // REQ-105(#197)Excel sandbox 闸口:excel-mcp-server 只放行 local stdio + 审计钉版
      // (0.1.8)+ 零网络绑定 + workspace 内路径。写盘前拒绝 → renderer 的 live mcp.add 也
      // 不会发生(persistAndConnectMcp 先持久化后 live);catalog / 自定义添加同闸(校验不放宽)。
      if (server && typeof server === "object") {
        const safety = checkExcelMcpSafety(name, server)
        if (!safety.ok) return safety
      }
      // T5:把 requiredEnvVars 的真值(renderer 刚采集,经 IPC 结构化克隆到达此处)搬进
      // {file:} 密钥通道 → durable config 只落引用,绝不明文。renderer 的 live mcp.add 仍用
      // 真值(内存态),下次启动引擎按 {file:} 解析。
      if (secretVars && secretVars.length && server && typeof server === "object") {
        fileifyMcpSecrets(userDataPath, name, server, secretVars)
      }
      const r = persistMcp(name, server, meta)
      // codex L(REQ-033):persistMcp 拒绝(如 DANGEROUS_ENV)时,fileify 已先落的 secret 文件要撤 ——
      // 否则残留孤儿密钥文件(无 config 引用但内容在盘)。
      if (!r.ok && secretVars && secretVars.length) removeMcpServerSecrets(userDataPath, name)
      return r
    },
  )
  ipcMain.handle("ext-remove-mcp", (_event: IpcMainInvokeEvent, name: string) => {
    removeMcpServerSecrets(userDataPath, name) // revoke the connector's stored secrets on uninstall
    return removeMcp(name)
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
    issuedAgentImports.delete(previewId)
    return writeAgent(issued.name, issued.composed, undefined, undefined, "imported")
  })

  ipcMain.handle("ext-remote-catalog", () => refreshRemoteCatalog(userDataPath))
  ipcMain.handle(
    "ext-install-remote-skill",
    // codex H1:renderer 只传 catalogId —— name/files/meta 全部由 main 从**已验签** catalog 重新派生
    // (refreshRemoteCatalog 的 remote 与 cache 路径均过 ed25519;renderer/被篡改缓存无法自带 URL+hash 绕签名)。
    async (_event: IpcMainInvokeEvent, catalogId: string) => {
      if (typeof catalogId !== "string" || !catalogId) return { ok: false, reason: "invalid catalog id" }
      const rc = await refreshRemoteCatalog(userDataPath)
      if (rc.source === "none") return { ok: false, reason: `remote catalog unavailable: ${rc.error}` }
      const entries = (rc.catalog as { entries?: Array<Record<string, unknown>> }).entries ?? []
      const entry = entries.find((e) => e.id === catalogId)
      if (!entry) return { ok: false, reason: `entry not in verified catalog: ${catalogId}` }
      if (entry.type !== "skill") return { ok: false, reason: `entry is not a skill: ${catalogId}` }
      const asset = entry.remoteAsset as { version?: string; files?: RemoteAssetFile[] } | undefined
      if (!asset?.files?.length) return { ok: false, reason: `entry has no remote asset: ${catalogId}` }
      const name = String(entry.name ?? "")
      const dl = await downloadRemoteAsset(asset.files)
      if (!dl.ok) return dl
      const meta: InstallMeta = { catalogId, version: String(entry.version ?? rc.version) }
      return installRemoteSkill(name, dl.contents, undefined, meta)
    },
  )
  ipcMain.handle(
    "ext-install-remote-agent",
    // REQ-046(与 ext-install-remote-skill 同信任边界,codex H1):renderer 只传 catalogId,
    // name/清单/版本由 main 从已验签 catalog 重新派生;资产约定 = 单 .md(installRemoteAgent 复核)。
    async (_event: IpcMainInvokeEvent, catalogId: string) => {
      if (typeof catalogId !== "string" || !catalogId) return { ok: false, reason: "invalid catalog id" }
      const rc = await refreshRemoteCatalog(userDataPath)
      if (rc.source === "none") return { ok: false, reason: `remote catalog unavailable: ${rc.error}` }
      const entries = (rc.catalog as { entries?: Array<Record<string, unknown>> }).entries ?? []
      const entry = entries.find((e) => e.id === catalogId)
      if (!entry) return { ok: false, reason: `entry not in verified catalog: ${catalogId}` }
      if (entry.type !== "agent") return { ok: false, reason: `entry is not an agent: ${catalogId}` }
      const asset = entry.remoteAsset as { version?: string; files?: RemoteAssetFile[] } | undefined
      if (!asset?.files?.length) return { ok: false, reason: `entry has no remote asset: ${catalogId}` }
      const name = String(entry.name ?? "")
      const dl = await downloadRemoteAsset(asset.files)
      if (!dl.ok) return dl
      const meta: InstallMeta = { catalogId, version: String(entry.version ?? rc.version) }
      return installRemoteAgent(name, dl.contents, undefined, meta)
    },
  )
  ipcMain.handle("ext-install-plugin", (_event: IpcMainInvokeEvent, pkg: string, meta?: InstallMeta) =>
    persistPlugin(pkg, meta),
  )
  ipcMain.handle(
    "ext-install-builtin-skill",
    (_event: IpcMainInvokeEvent, builtinAssetKey: string, name: string, target?: InstallTarget, meta?: InstallMeta) =>
      installBuiltinSkill(builtinAssetKey, name, target, meta),
  )
  // REQ-019 T3:详情页 SKILL.md 预览(只读,资产键校验 + 体积帽)
  ipcMain.handle("ext-read-builtin-skill", (_event: IpcMainInvokeEvent, builtinAssetKey: string) =>
    readBuiltinSkill(builtinAssetKey),
  )
  // REQ-023 T2:vendored 供给链(官方 agent md 资产 + 零网络插件)
  ipcMain.handle(
    "ext-install-builtin-agent",
    (_event: IpcMainInvokeEvent, builtinAssetKey: string, name: string, target?: InstallTarget, meta?: InstallMeta) =>
      installBuiltinAgent(builtinAssetKey, name, target, meta),
  )
  ipcMain.handle(
    "ext-install-vendored-plugin",
    (_event: IpcMainInvokeEvent, vendoredAssetKey: string, name: string, meta?: InstallMeta) =>
      installVendoredPlugin(vendoredAssetKey, name, meta),
  )
  // REQ-019 T6:导入(folder 校验 frontmatter 复制入 .alpha;git https-only 浅克隆临时目录同校验)
  ipcMain.handle("ext-import-skill-folder", (_event: IpcMainInvokeEvent, srcDir: string, target?: InstallTarget) =>
    importSkillFolder(srcDir, target),
  )
  ipcMain.handle("ext-import-skill-git", (_event: IpcMainInvokeEvent, url: string, target?: InstallTarget) =>
    importSkillGit(url, target),
  )
  // REQ-018 安装账本:合并只读视图(global ~/.alpha + 可选 project .alpha)
  ipcMain.handle("ext-list-installs", (_event: IpcMainInvokeEvent, projectDir?: string) => listInstalls(projectDir))
  // REQ-018 T6:按 receipt 精确卸载(fs 类删文件+拆桥+去账;plugin 从 config[] 删;mcp 走 removeMcp)。
  ipcMain.handle("ext-uninstall", (_event: IpcMainInvokeEvent, receipt: InstallReceipt) => {
    const target: InstallTarget | undefined = receipt.scope === "project" && typeof receipt.configKey !== "string"
      ? undefined // project fs installs pass projectDir via receipt.files[0]'s root — global default otherwise
      : { scope: "global" }
    if (receipt.type === "skill" || receipt.type === "agent") return removeFsInstall(receipt.type, receipt.name, target)
    if (receipt.type === "plugin") {
      // REQ-023:vendored 插件(plugin-path receipt)= 删配置里的绝对路径 + 删 ~/.alpha/plugins 落盘物
      if (receipt.configKey?.startsWith("plugin-path:")) {
        const abs = receipt.configKey.slice("plugin-path:".length)
        const removed = removePluginPath(receipt.name, abs)
        if (!removed.ok) return removed
        for (const f of receipt.files ?? []) {
          try {
            if (f.startsWith(path.join(alphaGlobalRoot(), "plugins") + path.sep)) fs.rmSync(f, { recursive: true, force: true })
          } catch {
            /* best-effort */
          }
        }
        return { ok: true, files: receipt.files }
      }
      const pkg = receipt.configKey?.startsWith("plugin:") ? receipt.configKey.slice("plugin:".length) : receipt.name
      return removePlugin(pkg)
    }
    if (receipt.type === "mcp") {
      removeMcpServerSecrets(userDataPath, receipt.name)
      return removeMcp(receipt.name)
    }
    // REQ-020 T4:cloud pipeline「启用」只存在于账本(不落文件、不写引擎 config)→ 停用 = 去账。
    if (receipt.type === "cloud") return removeReceipt(alphaGlobalRoot(), "cloud", receipt.name)
    return { ok: false, reason: `cannot uninstall type: ${receipt.type}` }
  })
  // REQ-020 T4:启用云 pipeline = 写 receipts 可用列表(receipts-only 语义,ADR-014 v3 账本真相;
  // 不写引擎 config —— 云工具本身由 sidecar 的 mcp.cloud 注入,与逐条 pipeline 启用无关)。
  ipcMain.handle("ext-enable-cloud", (_event: IpcMainInvokeEvent, id: string, name: string, meta?: InstallMeta) => {
    if (typeof id !== "string" || !id.startsWith("cloud:")) return { ok: false, reason: "invalid cloud entry id" }
    return addReceipt(alphaGlobalRoot(), {
      id,
      name,
      type: "cloud",
      scope: "global",
      installedAt: new Date().toISOString(),
      origin: "catalog",
      ...(meta?.version ? { version: meta.version } : {}),
    })
  })
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
  // generation 误移隔离区)。未注入 probe/commitReceipt → 引擎 fail-closed 全回滚,账本零漂移;
  // 前滚注入随 planner→事务引擎改线一并收口(ADR-028 residual)。journal 目录不存在时为 no-op。
  const txRecovery = recoverExtensionTransactions(alphaGlobalRoot(), {
    log: (event, detail) => getLogger().log(`[req100-tx-recovery] ${event} ${JSON.stringify(detail)}`),
  }).then(
    (r) => {
      if (!r.ok) getLogger().log(`[req100-tx-recovery] not clean: ${r.reason}`)
      else if (r.reports.length) getLogger().log(`[req100-tx-recovery] converged ${r.reports.length} journal(s)`)
    },
    (err) => getLogger().log(`[req100-tx-recovery] failed: ${String(err)}`),
  )
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
        persistMcp,
        fileifyMcpSecrets: (name, server, secretVars) => void fileifyMcpSecrets(userDataPath, name, server, secretVars),
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
      },
    }
  }
  ipcMain.handle("ext-install-catalog", async (_event: IpcMainInvokeEvent, intent: unknown) => {
    await txRecovery
    return installCatalog(intent, plannerDeps())
  })
  ipcMain.handle("ext-uninstall-v2", async (_event: IpcMainInvokeEvent, intent: unknown) => {
    await txRecovery
    return uninstallByKey(intent, plannerDeps())
  })
  ipcMain.handle("ext-set-install-state", (_event: IpcMainInvokeEvent, intent: unknown) => setInstallStateByKey(intent, { globalRoot: alphaGlobalRoot }))
  // REQ-099(ADR-028 §5):Hub 项目上下文读通道 —— global 与当前项目的 v2 账本分读(物理分域),
  // records 带 environment/scope identity/desiredState/generation;v1Only 为只读兼容面。
  ipcMain.handle("ext-list-installs-v2", (_event: IpcMainInvokeEvent, projectDir?: unknown) => {
    const global = readLedgerV2(alphaGlobalRoot())
    const projectRoot = typeof projectDir === "string" && projectDir ? alphaRoot(projectDir) : null
    return { global, project: projectRoot ? readLedgerV2(projectRoot) : null }
  })
}
