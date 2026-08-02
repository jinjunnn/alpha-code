// REQ-128 Phase 3 `[T1-intake]`(#780):**生产接线闸** —— 跑的是 `ext-ipc.ts` 里
// 已注册的那个 `ext-import-skill-folder` handler,不是直接调 `previewLocalClaudePlugin`。
//
// 为什么必须有这一层(R1 Blocker):只测纯函数时,**删掉 `ext-ipc.ts` 的分流点、甚至在生产
// 依赖里写 `installs.json`,现有测试仍可全绿** —— 「执行前后磁盘逐字节不变」根本没被证明。
// 那是本仓假闸形态⑧:自己拼一条等价链,删掉生产调用照样绿。
//
// 「零写盘」为什么不能靠 spy:collector 用的是 **namespace import**(`ext-fs-installer.ts`
// 的 `import * as fs from "node:fs"`),而 ESM 命名空间对象**不可写** —— 替换
// `require("node:fs")` 只改得动 default 那一份,实测 `{defaultUpdated:true, namespaceUpdated:false}`。
// 所以判据换成**可观察结果**:对「输入语料树 + 隔离的 alpha 根(installs.json 就在里面)+
// userData」三处做前后逐字节指纹。任何写(含恢复/迁移/事务)都会被它抓到,没有盲区。
//
// 指纹的**起点取在 `ledgerReady` 之后** —— 启动期恢复/v1→v2 迁移本来就允许写盘,
// 把它算进来会让这道闸对着一个与本票无关的原因恒红。要证的是「**这一次导入**没写盘」。

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { materializeCorpus, treeFingerprint } from "./claude-plugin-corpus.fixture"

// electron 必须在**任何**会牵出主进程模块的 import 之前 mock 掉(否则真 electron 被拉起来)。
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()
const electronStub: Record<string, unknown> = {
  app: { isPackaged: true, getVersion: () => "0.0.0", getAppPath: () => "/tmp", getPath: () => "/tmp", on: () => {} },
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => ipcHandlers.set(ch, fn), removeHandler: () => {} },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showMessageBox: async () => ({ response: 0 }) },
  BrowserWindow: Object.assign(class {}, { getAllWindows: () => [], getFocusedWindow: () => null, fromWebContents: () => null }),
  crashReporter: { start: () => {}, addExtraParameter: () => {} },
  shell: { openExternal: () => {}, openPath: () => {} },
  net: { fetch: async () => new Response("{}") },
  session: { defaultSession: { webRequest: { onHeadersReceived: () => {} } } },
  Menu: { buildFromTemplate: () => ({ popup: () => {} }), setApplicationMenu: () => {} },
  utilityProcess: { fork: () => { throw new Error("unexpected utilityProcess.fork") } },
  safeStorage: { isEncryptionAvailable: () => false },
  nativeTheme: { on: () => {} },
  powerMonitor: { on: () => {} },
  netLog: { startLogging: () => {}, stopLogging: async () => {} },
  contentTracing: {},
  globalShortcut: { register: () => {}, unregisterAll: () => {} },
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1, height: 1 } }) },
  clipboard: { writeText: () => {} },
  nativeImage: { createFromPath: () => ({}) },
  Notification: class {},
  Tray: class {},
  MenuItem: class {},
  webContents: { getAllWebContents: () => [] },
  inAppPurchase: {},
  powerSaveBlocker: {},
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  desktopCapturer: {},
  autoUpdater: { on: () => {} },
  ShareMenu: class {},
  TouchBar: class {},
  BrowserView: class {},
  WebContentsView: class {},
  BaseWindow: class {},
  View: class {},
  IncomingMessage: class {},
  ClientRequest: class {},
  Session: class {},
  Cookies: class {},
  Debugger: class {},
  Dock: class {},
  NavigationHistory: class {},
  ServiceWorkers: class {},
  WebFrameMain: class {},
  WebRequest: class {},
  parseContentType: () => ({}),
  pushNotifications: {},
  utilityProcessImmediate: {},
}
electronStub.default = electronStub
mock.module("electron", () => electronStub)

const IMPORT_CHANNEL = "ext-import-skill-folder"

type ImportResult = {
  ok: boolean
  reason?: string
  canceled?: true
  localPluginPreview?: {
    name: string
    packageId: string | null
    installableCount: number
    duplicateImportNotice: string | null
    limits: { skillCandidates: number; maxComponents: number }
    components: Array<{ name: string; dir: string; disposition: string; reasonCodes: string[] }>
    unsupportedLayouts: Array<{ code: string }>
  }
}

let sandbox: string
let alphaBase: string
let userData: string
let corpus: ReturnType<typeof materializeCorpus>
let invokeImport: (srcDir: string) => Promise<ImportResult>

beforeAll(async () => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-t1-ipc-"))
  alphaBase = path.join(sandbox, "appdata")
  userData = path.join(sandbox, "userData")
  fs.mkdirSync(alphaBase, { recursive: true })
  fs.mkdirSync(userData, { recursive: true })
  fs.mkdirSync(path.join(sandbox, "home"), { recursive: true })
  corpus = materializeCorpus()

  const { __resetAlphaEnvironmentForTests, initAlphaEnvironment } = await import("../src/main/alpha-environment")
  __resetAlphaEnvironmentForTests()
  initAlphaEnvironment({ isPackaged: true, channel: "prod", appDataDir: alphaBase, homeDir: path.join(sandbox, "home") })
  const { initLogging } = await import("../src/main/logging")
  initLogging()
  // 生产 composition root 本体 —— 这里注册的就是用户点「从文件夹导入」打到的那个 handler。
  const { registerExtIpcHandlers } = await import("../src/main/ext-ipc")
  const registered = registerExtIpcHandlers(userData, "stable", async () => ({}) as never, path.join(sandbox, "home"))
  await registered.ledgerReady

  const handler = ipcHandlers.get(IMPORT_CHANNEL)
  if (!handler) throw new Error(`生产 handler 未注册:${IMPORT_CHANNEL}`)
  invokeImport = async (srcDir: string) => {
    // main 自弹 picker 的 headless 短路(`ext-ipc.ts` 里 main 控制的 env)——
    // renderer 全程给不出路径,这条正是生产里 picker 返回值的位置。
    process.env.ALPHA_OPEN_DIR = srcDir
    try {
      return (await handler({} as never, undefined)) as ImportResult
    } finally {
      delete process.env.ALPHA_OPEN_DIR
    }
  }
})

afterAll(() => {
  corpus?.cleanup()
  fs.rmSync(sandbox, { recursive: true, force: true })
})

/** 写面的合并指纹:输入语料树 + 隔离 alpha 根(`installs.json` 在其中)+ userData + 隔离 home。
 *
 *  ⚠️ **这道闸的射程有边界,写在这里而不是让它看起来无所不能**:
 *  它覆盖的是**传给生产 handler 的那几个根**。写到这四棵树之外(真实 `$HOME`、`/tmp`、
 *  系统路径),或者写完把 mtime 恢复回去,它**看不见**。要堵住那一类得在进程边界上拦
 *  (seccomp / 沙箱),不在本票射程内 —— **明写而不做**。 */
function writeSurfaceFingerprint(): string {
  return [corpus.root, alphaBase, userData, path.join(sandbox, "home")].map(treeFingerprint).join("|")
}

const pluginDir = (rel: string): string => path.join(corpus.root, rel)
const TIDE = "tide-plugin"
const CODEX = "openai-codex/plugins/codex"

describe("生产 IPC handler:分流点真的在生产路径上", () => {
  test("插件目录 ⇒ 生产 handler 返回具名结果 + 真预览(不是「文件夹内没有 SKILL.md」)", async () => {
    const res = await invokeImport(pluginDir(TIDE))
    expect(res.ok).toBe(false)
    expect(res.localPluginPreview).toBeDefined()
    expect(res.localPluginPreview!.name).toBe("tide")
    expect(res.localPluginPreview!.packageId).toBe("local:tide")
    expect(res.reason ?? "").toContain("Claude 插件目录")
    expect(res.reason ?? "").not.toContain("没有 SKILL.md")
  })

  test("非插件目录 ⇒ 走既有单技能路径,行为逐字不变(错误信息仍是老那句)", async () => {
    const plain = fs.mkdtempSync(path.join(sandbox, "plain-"))
    const res = await invokeImport(plain)
    expect(res.ok).toBe(false)
    expect(res.localPluginPreview).toBeUndefined()
    expect(res.reason ?? "").toContain("没有 SKILL.md")
  })

  test("manifestless 插件(receipts 真实结构)在生产路径上也拿到具名布局原因", async () => {
    const res = await invokeImport(pluginDir("claude-plugins-official/plugins/receipts"))
    expect(res.localPluginPreview).toBeDefined()
    expect(res.localPluginPreview!.unsupportedLayouts.map((l) => l.code)).toContain("manifestless-plugin-dir")
  })
})

describe("AC9 生产路径零写盘(输入树 + installs.json + userData 三处指纹)", () => {
  test("导入一个可装插件 ⇒ 三处逐字节不变", async () => {
    const before = writeSurfaceFingerprint()
    const res = await invokeImport(pluginDir(TIDE))
    expect(res.localPluginPreview!.installableCount).toBeGreaterThan(0) // 真走到了清点,不是早退
    expect(writeSurfaceFingerprint()).toBe(before)
  })

  test("导入一个「一个都装不上」的插件 ⇒ 三处逐字节不变", async () => {
    const before = writeSurfaceFingerprint()
    const res = await invokeImport(pluginDir(CODEX))
    expect(res.localPluginPreview!.installableCount).toBe(0)
    expect(writeSurfaceFingerprint()).toBe(before)
  })

  test("账本里有坏 receipt ⇒ 预览**不得**落 `installs.json.evidence-*`,账本文件也不得被动", async () => {
    // R2 Blocker:为了闭合「预览要消费已装事实」而加的账本读取,**自己会写盘**。
    // `parseLedger` 看到坏 receipt / 坏 record 时会落一份字节级取证侧写
    // (`ext-receipt-v2.ts` r18)—— 那是一个写,直接违反 AC9。
    // 启动期 recovery 非 clean 而跳过 migration、或账本在 barrier 之后变化,这条就到得了。
    const { alphaGlobalRoot } = await import("../src/main/alpha-installs")
    const root = alphaGlobalRoot()
    fs.mkdirSync(root, { recursive: true })
    const ledgerFile = path.join(root, "installs.json")
    const before = fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, "utf8") : null
    // 一条**坏** receipt(缺 id / 非法 type)⇒ 进 rawInvalidReceipts ⇒ 触发侧写。
    fs.writeFileSync(ledgerFile, JSON.stringify({ v: 1, receipts: [{ name: "broken", type: "not-a-type" }] }))
    const stampBefore = fs.lstatSync(ledgerFile)
    const evidenceBefore = fs.readdirSync(root).filter((f) => f.includes(".evidence-")).sort()
    try {
      const res = await invokeImport(pluginDir(TIDE))
      expect(res.localPluginPreview).toBeDefined() // 真走到了预览,不是提前退出
      const evidenceAfter = fs.readdirSync(root).filter((f) => f.includes(".evidence-")).sort()
      expect(evidenceAfter).toEqual(evidenceBefore) // 零新增
      const stampAfter = fs.lstatSync(ledgerFile)
      expect(stampAfter.mtimeMs).toBe(stampBefore.mtimeMs)
      expect(stampAfter.ino).toBe(stampBefore.ino)
    } finally {
      for (const f of fs.readdirSync(root)) if (f.includes(".evidence-")) fs.rmSync(path.join(root, f), { force: true })
      if (before === null) fs.rmSync(ledgerFile, { force: true })
      else fs.writeFileSync(ledgerFile, before)
    }
  })

  test("对全部 62 个插件连续跑一遍 ⇒ 三处仍逐字节不变", async () => {
    const before = writeSurfaceFingerprint()
    const roots: string[] = []
    const walk = (abs: string, depth: number): void => {
      if (depth > 8) return
      if (fs.existsSync(path.join(abs, ".claude-plugin", "plugin.json"))) roots.push(abs)
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) if (e.isDirectory()) walk(path.join(abs, e.name), depth + 1)
    }
    walk(corpus.root, 0)
    expect(roots.length).toBe(62)
    for (const r of roots) expect((await invokeImport(r)).localPluginPreview).toBeDefined()
    expect(writeSurfaceFingerprint()).toBe(before)
  })
})

describe("owner 裁决 D / K19 在**生产路径**上可达", () => {
  test("本机已装同名技能 ⇒ 生产预览逐组件具名跳过", async () => {
    // 往隔离的 alpha 根写一本真账本:这不是「测试自己注入 options」,而是生产 handler
    // 自己去读它。此前生产调用一个 option 都不传 ⇒ 这条原因在生产上永远到不了。
    const { alphaGlobalRoot } = await import("../src/main/alpha-installs")
    const root = alphaGlobalRoot()
    const first = await invokeImport(pluginDir(TIDE))
    const taken = first.localPluginPreview!.components.find((c) => c.disposition === "install")!
    const takenName = taken.name // frontmatter 的 name 才是落盘的键,目录名只是显示用

    fs.mkdirSync(root, { recursive: true })
    const ledgerFile = path.join(root, "installs.json")
    const before = fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, "utf8") : null
    fs.writeFileSync(
      ledgerFile,
      JSON.stringify({
        v: 1,
        receipts: [
          { id: `skill:${takenName}`, type: "skill", name: takenName, scope: "global", origin: "imported-claude", installedAt: new Date().toISOString(), files: [] },
        ],
      }),
    )
    try {
      const res = await invokeImport(pluginDir(TIDE))
      const comp = res.localPluginPreview!.components.find((c) => c.name === takenName)!
      expect(comp.disposition).toBe("skip")
      expect(comp.reasonCodes).toContain("name-collision-installed")
      expect(res.localPluginPreview!.installableCount).toBe(first.localPluginPreview!.installableCount - 1)
    } finally {
      if (before === null) fs.rmSync(ledgerFile, { force: true })
      else fs.writeFileSync(ledgerFile, before)
    }
  })

  test("账本读不出来 ⇒ 如实说「读不出」,不折叠成「没装」", async () => {
    const { alphaGlobalRoot } = await import("../src/main/alpha-installs")
    const ledgerFile = path.join(alphaGlobalRoot(), "installs.json")
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true })
    const before = fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, "utf8") : null
    fs.writeFileSync(ledgerFile, "{ this is not json")
    try {
      const res = await invokeImport(pluginDir(TIDE))
      expect(res.reason ?? "").toContain("读不出来")
    } finally {
      if (before === null) fs.rmSync(ledgerFile, { force: true })
      else fs.writeFileSync(ledgerFile, before)
    }
  })

  test("包内两个目录同名 ⇒ 生产预览两个都具名跳过", async () => {
    const root = fs.mkdtempSync(path.join(sandbox, "dup-"))
    fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true })
    fs.writeFileSync(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "dup", description: "d" }))
    for (const dir of ["a-dir", "b-dir"]) {
      fs.mkdirSync(path.join(root, "skills", dir), { recursive: true })
      fs.writeFileSync(path.join(root, "skills", dir, "SKILL.md"), "---\nname: twin\ndescription: d\n---\n")
    }
    const res = await invokeImport(root)
    expect(res.localPluginPreview!.installableCount).toBe(0)
    for (const c of res.localPluginPreview!.components) expect(c.reasonCodes).toEqual(["name-collision-in-package"])
  })

  test("K19:同一个包已装过 ⇒ 生产 reason 里就说清「先移除整包」", async () => {
    // ⚠️ 这条用例第一版是**假绿**:夹具写 `v: 2` 却带非空 V3 段、node 还缺 `componentId`,
    // 账本合同必然拒绝它 ⇒ 走的是「读不出来」分支,于是**删掉 K19 的生产接线照样通过**。
    // 现在的夹具是账本合同**真的接受**的形状,而且下面先自证它被接受,再断言 K19 —— 不留退路分支。
    const { alphaGlobalRoot } = await import("../src/main/alpha-installs")
    const { upsertRecordV2, readPackageLedgerStateV1 } = await import("../src/main/ext-receipt-v2")
    const { bundleOwner, computeInstalledGraphDigest } = await import("../src/main/ext-package-ledger-v3")
    const root = alphaGlobalRoot()
    const ledgerFile = path.join(root, "installs.json")
    fs.mkdirSync(root, { recursive: true })
    const before = fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, "utf8") : null
    const probe = await invokeImport(pluginDir(TIDE))
    const packageId = probe.localPluginPreview!.packageId!
    expect(probe.localPluginPreview!.duplicateImportNotice).toBeNull()

    const digest = `sha256:${"a".repeat(64)}`
    const anchor = "pkg-anchor-skill" // 与 tide-plugin 的任何技能都不同名,免得干扰重名断言
    // record 用**生产写入口**造(不手拼 InstallRecordV2 的字节),V3 段再补上去。
    const wrote = upsertRecordV2(root, {
      id: `skill:${anchor}`,
      name: anchor,
      kind: "skill",
      environment: "prod",
      scope: { kind: "global" },
      version: "1.0.0",
      manifestDigest: digest,
      desiredState: "enabled",
      origin: "catalog",
      installedAt: "2026-08-02T00:00:00.000Z",
    })
    expect(wrote.ok).toBe(true)
    const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8")) as Record<string, unknown>
    ledger.v = 3 // V3 段非空时信封版本必须是 3
    const node = { componentId: `local:${anchor}`, kind: "skill", name: anchor, required: true, manifestDigest: digest }
    // installedGraphDigest 用**真的**计算口径算(手填一个常数 = 替别人写文法,合同当场拒)。
    const graphCore = { packageId, envelopeDigest: digest, root: node, children: [] as never[] }
    ledger.packageGraphs = [{ ...graphCore, installedGraphDigest: computeInstalledGraphDigest(graphCore) }]
    // owner token 用**真的** bundleOwner 算,不手拼格式(手拼 = 替别人写文法)。
    ledger.claims = [{ kind: "skill", name: anchor, owners: [bundleOwner(packageId, digest)] }]
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger))
    try {
      // 自证夹具合法 —— 不先证这一步,「读不出来」会把这道闸变回假绿。
      const state = readPackageLedgerStateV1(root, { sideEffectFree: true })
      expect(state.ok).toBe(true)
      expect(state.ok && state.packageGraphs.map((g) => g.packageId)).toContain(packageId)

      const res = await invokeImport(pluginDir(TIDE))
      expect(res.localPluginPreview!.duplicateImportNotice).toContain("先移除整包")
      expect(res.reason ?? "").toContain("先移除整包")
      expect(res.reason ?? "").not.toContain("读不出来")
    } finally {
      if (before === null) fs.rmSync(ledgerFile, { force: true })
      else fs.writeFileSync(ledgerFile, before)
    }
  })
})
