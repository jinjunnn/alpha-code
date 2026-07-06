// Extension Hub IPC handlers (main process). Mirrors ipc.ts's ipcMain.handle pattern. Three thin
// privileged operations the renderer can't do itself: persist/remove an MCP server in the user
// config (ext-config.ts), and a runtime which-check so the UI can warn before adding a local MCP
// whose binary (uv/node/…) is missing. All validation lives in ext-config / here — see ADR-014 §8.

import { ipcMain, type IpcMainInvokeEvent } from "electron"
import { execFile } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
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
import { applyGovernance, normalizeGovernance, protectionInfo, readGovernance, resetGovernance } from "./alpha-governance"
import { getLogger } from "./logging"

// GUI apps on macOS launch with a minimal PATH (no Homebrew), so augment it before `which` or we'd
// false-negative tools the user actually has installed.
const PROBE_PATH = [
  process.env.PATH ?? "",
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  `${os.homedir()}/.local/bin`,
].join(":")

function checkRuntime(tool: string): Promise<{ ok: boolean }> {
  return new Promise((resolve) => {
    if (!/^[a-zA-Z0-9._-]+$/.test(tool)) {
      resolve({ ok: false })
      return
    }
    execFile("which", [tool], { env: { ...process.env, PATH: PROBE_PATH } }, (err, stdout) => {
      resolve({ ok: !err && Boolean(stdout && stdout.trim()) })
    })
  })
}

export function registerExtIpcHandlers(userDataPath: string) {
  ipcMain.handle(
    "ext-persist-mcp",
    (_event: IpcMainInvokeEvent, name: string, server: Record<string, unknown>, meta?: InstallMeta, secretVars?: string[]) => {
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
  ipcMain.handle("gov-read", () => ({ gov: readGovernance(), protection: protectionInfo() }))
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
}
