// REQ-100 #347(review #376 Blocker1/Major3)—— 生产写通道的**唯一注册真源**:
// 权威范围 = 所有会写 installs.json / 事务拥有的 config/store 的 renderer 通道,都在
// GATED_WRITE_CHANNELS 登记,经 gatedWriteHandler(恢复准入 gate + root 解析)构造。
// ext-ipc 只按注册表注册,不得在表外直接 ipcMain.handle 一个写通道 —— 新写通道必须来此
// 登记,行为测试(ext-write-channels.test.ts)按真实表逐通道断言「先恢复、拒绝短路、root
// 正确」。**journal 管理面(#375)是刻意的表外例外**:见下方 JOURNAL_ADMIN_CHANNELS ——
// 它不写 ledger/config/store,且恢复 gate 拒非终态 journal 是其本职,与 retire 的对象
// (恰是非终态件)语义相反,不得走 gatedWriteHandler;互斥由通道自身持 root Bundle 锁保证。
//
// 注:ext-import-skill-folder 的目录选择对话框在 gate 之外(ext-ipc 的 IPC 回调先弹窗拿
// srcDir,再调本表的 gated 持久化阶段)—— mutex 决不能横跨用户交互。
import type { InstallTarget } from "../preload/types"
import { gatedWriteHandler, type GateRefusal, type RecoveryGate } from "./ext-recovery-gate"
import {
  decodeJournalListIntent,
  decodeJournalRetireIntent,
  type JournalAdminEntry,
  type JournalRootRef,
  type RetireJournalRequest,
} from "./ext-journal-retire"
import type { JournalRetireResult } from "../shared/ext-journal-admin"

export type RootResolution = { ok: true; root: string } | { ok: false; reason: string }

export const GATED_WRITE_CHANNELS = {
  installCatalog: "ext-install-catalog",
  uninstallV2: "ext-uninstall-v2",
  /** `#698`:整包卸载。与 `uninstallV2` 分开是因为**意图形状不同** —— 这里传的是 packageId,
   *  而 main 要删什么完全由它自己的账本图算出;把它塞进 key-based 卸载会让 renderer 的一次
   *  点击可以指名某个 child 而实际删掉一整个包。 */
  uninstallPackage: "ext-uninstall-package",
  rollback: "ext-rollback",
  setInstallState: "ext-set-install-state",
  projectResidualsClean: "ext-project-residuals-clean",
  removeMcpLegacy: "ext-remove-mcp",
  persistMcp: "ext-persist-mcp",
  importAgentConfirm: "ext-import-agent-confirm",
  /** REQ-128 Phase 3 `#782`:本地 Claude 插件包的**确认**。两段式里**只有它**会写盘,
   *  所以两段式里**只有它**在这张表里 —— preview / cancel / 列表三条纯读通道在下面的
   *  `LOCAL_PACKAGE_READ_CHANNELS`,与本表**必须互斥**(`ext-write-channels.test.ts` 断言)。
   *  入参只有 previewId:写入内容取自 main 侧留存的 preview 产物,renderer 全程给不出。 */
  importClaudePluginConfirm: "ext-import-claude-plugin-confirm",
  importSkillFolder: "ext-import-skill-folder",
  importSkillGit: "ext-import-skill-git",
} as const

/**
 * REQ-128 Phase 3 `#782`:本地插件包两段式里的**纯读**通道。
 *
 * 它们**不进** `GATED_WRITE_CHANNELS`,理由与 `ext-import-agent-preview` 不在表里逐字一致:
 * 它们不写 `installs.json`、不写事务拥有的 config/store,一个字节都不落盘。把纯读通道塞进写表
 * 不是「更安全」,是让恢复 gate 在读面上生效 —— 账本待恢复时用户连「这个包能不能装」都看不到。
 *
 * 立成具名表(而不是散在 `ext-ipc` 里的字面量)的唯一目的:让「preview 有没有被人挪进写表」
 * 这个问题**可被一条断言回答**。两表互斥由 `ext-write-channels.test.ts` 钉死。
 */
export const LOCAL_PACKAGE_READ_CHANNELS = {
  /** 按 previewId 取回已签发预览的安全投影(无绝对路径、无字节)。 */
  importClaudePluginPreview: "ext-import-claude-plugin-preview",
  /** 显式取消:释放 main 侧留存的字节。**必须不过 gate** —— 账本待恢复时也得放得掉。 */
  importClaudePluginCancel: "ext-import-claude-plugin-cancel",
  /** 列出本机已装的 V3 包图(安全投影)。 */
  listInstalledPackages: "ext-installed-packages",
} as const

export type WriteChannelRoots = {
  /** 恒全局根(catalog 安装/回滚/未策展 mcp/plugin/agent 导入 —— 全部只写全局面)。 */
  global: (...args: unknown[]) => RootResolution
  /** 严格卸载意图解码定根(project identity fail-closed)。 */
  uninstallIntent: (intent: unknown) => RootResolution
  /** 严格 set-state 意图解码定根。 */
  setStateIntent: (intent: unknown) => RootResolution
  /** 导入目标(InstallTarget)定根:缺省/global → 全局;project → identity fail-closed。 */
  importTarget: (target: InstallTarget | undefined) => RootResolution
  /** 项目目录定根(residuals clean)。 */
  projectDir: (projectDir: unknown) => RootResolution
}

export type WriteChannelBodies = {
  installCatalog: (intent: unknown) => Promise<unknown>
  uninstallV2: (intent: unknown) => Promise<unknown>
  uninstallPackage: (packageId: unknown) => Promise<unknown>
  rollback: (intent: unknown, genId: unknown) => Promise<unknown>
  setInstallState: (intent: unknown) => Promise<unknown>
  projectResidualsClean: (projectDir: unknown) => Promise<unknown>
  removeMcpLegacy: (name: unknown) => Promise<unknown>
  persistMcp: (name: unknown, server: unknown, secretVars?: unknown) => Promise<unknown>
  importAgentConfirm: (previewId: unknown) => Promise<unknown>
  /** `#782`:**只收 previewId**。多一个入参就是多一条 renderer 可控的写入内容通道。 */
  importClaudePluginConfirm: (previewId: unknown) => Promise<unknown>
  /** 持久化阶段(srcDir 已由 main 弹窗取得)。 */
  importSkillFolder: (srcDir: string, target?: InstallTarget) => Promise<unknown>
  importSkillGit: (url: unknown, target?: InstallTarget) => Promise<unknown>
}

export type GatedWriteHandlers = {
  [K in keyof WriteChannelBodies]: (...args: Parameters<WriteChannelBodies[K]>) => Promise<Awaited<ReturnType<WriteChannelBodies[K]>> | GateRefusal>
}

export function buildGatedWriteChannels(deps: { gate: RecoveryGate; roots: WriteChannelRoots; bodies: WriteChannelBodies }): GatedWriteHandlers {
  const { gate, roots, bodies } = deps
  return {
    installCatalog: gatedWriteHandler(gate, roots.global, bodies.installCatalog),
    uninstallV2: gatedWriteHandler(gate, roots.uninstallIntent, bodies.uninstallV2),
    // package 恒全局面(admission 只接受 global scope),定根与 catalog 安装同一个。
    uninstallPackage: gatedWriteHandler(gate, roots.global, bodies.uninstallPackage),
    rollback: gatedWriteHandler(gate, roots.global, bodies.rollback),
    setInstallState: gatedWriteHandler(gate, roots.setStateIntent, bodies.setInstallState),
    projectResidualsClean: gatedWriteHandler(gate, roots.projectDir, bodies.projectResidualsClean),
    removeMcpLegacy: gatedWriteHandler(gate, roots.global, bodies.removeMcpLegacy),
    persistMcp: gatedWriteHandler(gate, roots.global, bodies.persistMcp),
    importAgentConfirm: gatedWriteHandler(gate, roots.global, bodies.importAgentConfirm),
    // 本地包恒全局面(project scope 显式不支持,ADR-030);定根与 catalog 安装同一个。
    importClaudePluginConfirm: gatedWriteHandler(gate, roots.global, bodies.importClaudePluginConfirm),
    importSkillFolder: gatedWriteHandler(gate, (_srcDir: string, target?: InstallTarget) => roots.importTarget(target), bodies.importSkillFolder),
    importSkillGit: gatedWriteHandler(gate, (_url: unknown, target?: InstallTarget) => roots.importTarget(target), bodies.importSkillGit),
  }
}

// ── #375:journal 管理通道(独立注册表 + 构造器;不进 GATED_WRITE_CHANNELS,理由见文件头)──────

export const JOURNAL_ADMIN_CHANNELS = {
  retainedList: "ext-journal-retained-list",
  retire: "ext-journal-retire",
} as const

export type JournalAdminListResult = { entries: JournalAdminEntry[] } | { ok: false; reason: string }

export type JournalAdminHandlers = {
  /** 只读诊断:global 三环境根恒聚合;intent.projectDir(可选)经严格解析后追加。 */
  retainedList: (intent: unknown) => JournalAdminListResult
  /** 显式 retire:scope 严格解码(global env selector / projectDir),renderer 无任意 root 通道。 */
  retire: (intent: unknown) => Promise<JournalRetireResult>
}

export function buildJournalAdminChannels(deps: {
  /** main 派生的全局环境根(dev/prod/beta 固定序;与 GC 同一派生真源)。 */
  globalRoots: () => JournalRootRef[]
  /** projectDir 严格解析(realpath identity fail-closed;与 uninstallIntent 同口径)。 */
  projectRoot: (projectDir: string) => RootResolution
  list: (roots: JournalRootRef[]) => { entries: JournalAdminEntry[] }
  retire: (ref: JournalRootRef, req: RetireJournalRequest) => Promise<JournalRetireResult>
}): JournalAdminHandlers {
  return {
    retainedList: (intent: unknown) => {
      const decoded = decodeJournalListIntent(intent)
      if (!decoded.ok) return decoded
      const roots = [...deps.globalRoots()]
      if (decoded.projectDir !== undefined) {
        const resolved = deps.projectRoot(decoded.projectDir)
        if (!resolved.ok) return resolved // 解析失败原样返回,零副作用(不静默降级为「只看全局」)
        roots.push({ identity: `project:${decoded.projectDir}`, root: resolved.root })
      }
      return deps.list(roots)
    },
    retire: async (intent: unknown) => {
      const decoded = decodeJournalRetireIntent(intent)
      if (!decoded.ok) return decoded
      const { scope } = decoded.intent
      let ref: JournalRootRef
      if (scope.kind === "global") {
        const match = deps.globalRoots().find((r) => r.identity === scope.environment)
        if (!match) return { ok: false, reason: `unknown global environment "${scope.environment}"` }
        ref = match
      } else {
        const resolved = deps.projectRoot(scope.projectDir)
        if (!resolved.ok) return resolved
        ref = { identity: `project:${scope.projectDir}`, root: resolved.root }
      }
      return deps.retire(ref, {
        entryId: decoded.intent.entryId,
        txId: decoded.intent.txId,
        journalSha256: decoded.intent.journalSha256,
        note: decoded.intent.note,
        liveStateChecked: decoded.intent.liveStateChecked,
        casMarkRemovalAcknowledged: decoded.intent.casMarkRemovalAcknowledged,
      })
    },
  }
}
