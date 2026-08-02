// REQ-128 Phase 3 `[T3-channel]`(#782)—— **生产 handler** 上的两段式通道闸:G6 + G19。
//
// 为什么必须在这里、不能写成纯函数测(基线 §6 G19 原文「用生产 handler 测,不是纯函数」;
// 本仓「闸门失效形态⑧:没测生产接线」):`local-package-preview.ts` 的 store 单独测一遍
// 只证明**那个类**自洽。把 `ext-ipc` 里的签发调用整行删掉,纯函数测照样全绿 —— 而用户
// 那一刻拿到的是「预览已失效」。所以这里跑的是:真 `registerExtIpcHandlers`、真写通道表、
// 真恢复 gate、真 `collectImportSkillPayload`、真 `claude-plugin-intake`。
//
// **唯一被替身的东西**是安装端口(`local-package-install-port`)—— 它通往 `[T2-install]`(#781),
// 那张票还没落地。替它的是一个可切换成功/失败的 spy:G6 的「写成功才消费」没有成功路径就
// 立不起来,而假装成功的那一半必须可控。除此之外一行生产代码都没被换掉。

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, mock, test } from "bun:test"

type IpcSender = { id: number; once?: (name: string, listener: () => void) => void }
type IpcHandler = (event: { sender: IpcSender }, ...args: unknown[]) => unknown

const handlers = new Map<string, IpcHandler>()
const tmp = mkdtempSync(join(tmpdir(), "local-package-channel-"))
const tmpReal = realpathSync(tmp)
const userData = join(tmp, "user-data")

// ── 安装端口的替身。**函数值在 mock.module 之前就存进独立 const**(本仓 `mock.module`
//    就地改写命名空间对象的教训:`{...m, f: wrap(m.f)}` 里的 `m.f` 注册后指向 wrapper 自己)。
let installOutcome: { ok: true; packageId: string; installed: Array<{ kind: string; name: string }> } | { ok: false; reason: string } = {
  ok: false,
  reason: "spy default",
}
const installCalls: Array<{ previewId: string; srcDir: string; dirs: string[]; byteCount: number }> = []
const installSpy = async (issued: { previewId: string; srcDir: string; payloads: ReadonlyArray<{ dir: string }>; byteCount: number }) => {
  installCalls.push({
    previewId: issued.previewId,
    srcDir: issued.srcDir,
    dirs: issued.payloads.map((p) => p.dir),
    byteCount: issued.byteCount,
  })
  return installOutcome
}

mock.module("../src/main/local-package-install-port", () => ({ installLocalClaudePlugin: installSpy }))

mock.module("electron", () => ({
  BrowserWindow: class {
    static fromWebContents() {
      return undefined
    }
  },
  dialog: {
    showMessageBox: async () => ({ response: 1, checkboxChecked: false }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  },
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler),
  },
}))

mock.module("../src/main/ipc", () => ({
  pickedFiles: {
    read: async () => {
      throw new Error("unexpected picked-file read")
    },
  },
}))

mock.module("../src/main/logging", () => ({
  getLogger: () => ({ error: () => {}, log: () => {}, warn: () => {} }),
}))

mock.module("../src/main/ext-advisory-gate", () => ({
  listAdvisoryBlockedFacts: () => ({ ids: [], fresh: true }),
  makeAdvisoryGate: () => () => ({ allowed: true }),
}))

mock.module("../src/main/remote-catalog", () => ({
  downloadRemoteAsset: async () => ({ ok: false, reason: "unexpected remote asset download" }),
  readCachedCatalog: () => null,
  registerPackageCatalogReadIpcHandlers: () => {},
  refreshRemoteCatalog: async () => ({ source: "none", error: "offline in this case file" }),
}))

// ── 夹具:真目录树(被测的是读文件系统的生产代码,喂内存对象等于换成一条自拼的等价链)──

/** 一个最小合法技能目录。SKILL.md 刻意不含任何路径形 token —— 那会触发自包含启发式。 */
function writeSkill(pluginRoot: string, name: string, extraFiles: Array<{ path: string; bytes: number }> = []): void {
  const dir = join(pluginRoot, "skills", name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: fixture skill ${name}\n---\n\nbody of ${name}\n`, "utf8")
  for (const file of extraFiles) {
    const abs = join(dir, file.path)
    mkdirSync(join(abs, ".."), { recursive: true })
    writeFileSync(abs, Buffer.alloc(file.bytes, 0x61))
  }
}

function writePlugin(slug: string, build: (root: string) => void): string {
  const root = join(tmp, "plugins", slug)
  mkdirSync(join(root, ".claude-plugin"), { recursive: true })
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: slug, version: "1.0.0", description: `${slug} fixture` }), "utf8")
  build(root)
  return realpathSync(root)
}

const okPlugin = writePlugin("ok-plugin", (root) => {
  writeSkill(root, "alpha", [{ path: "notes.md", bytes: 32 }])
  writeSkill(root, "beta")
})
// 包级字节帽夹具:4 × 9MB = 36MB > 32MB,而**每一个**技能都在单技能 10MB 帽之内 ——
// 这正是 G19 要拦的形状(逐个合法、合起来 640MB 级)。
const fatPlugin = writePlugin("fat-plugin", (root) => {
  for (const name of ["s1", "s2", "s3", "s4"]) writeSkill(root, name, [{ path: "blob.bin", bytes: 9 * 1024 * 1024 }])
})
// 包级文件帽夹具:5 × 450 = 2250 > 2000,而每个技能都在单技能 500 条帽之内。
const manyFilesPlugin = writePlugin("many-files-plugin", (root) => {
  for (const name of ["m1", "m2", "m3", "m4", "m5"])
    writeSkill(
      root,
      name,
      Array.from({ length: 449 }, (_unused, index) => ({ path: `f${index}.txt`, bytes: 4 })),
    )
})

const { initAlphaEnvironment } = await import("../src/main/alpha-environment")
const { localPackagePreviews } = await import("../src/main/local-package-preview")
const { LOCAL_PACKAGE_PREVIEW_MAX_BYTES, LOCAL_PACKAGE_PREVIEW_MAX_FILES } = await import("../src/main/local-package-preview")
const { GATED_WRITE_CHANNELS, LOCAL_PACKAGE_READ_CHANNELS } = await import("../src/main/ext-write-channels")
const { registerExtIpcHandlers } = await import("../src/main/ext-ipc")

delete process.env.ALPHA_GLOBAL_DIR
initAlphaEnvironment({
  isPackaged: false,
  channel: "dev",
  appDataDir: tmp,
  baseRoot: join(tmp, "alpha-code-state"),
  homeDir: join(tmp, "home"),
})
registerExtIpcHandlers(
  userData,
  "dev",
  async () => ({ url: "http://127.0.0.1:39117", username: "opencode", password: "route-password" }),
  join(tmp, "home"),
)

afterAll(() => {
  delete process.env.ALPHA_OPEN_DIR
  rmSync(tmp, { recursive: true, force: true })
})

const call = (channel: string, sender: IpcSender, ...args: unknown[]) => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`handler not registered: ${channel}`)
  return handler({ sender }, ...args)
}

/** 走**生产**入口签发一次预览:真 picker 短路 env → 真分流 → 真清点 → 真留字节。 */
async function importFolder(dir: string, sender: IpcSender): Promise<Record<string, unknown>> {
  process.env.ALPHA_OPEN_DIR = dir
  try {
    return (await call(GATED_WRITE_CHANNELS.importSkillFolder, sender)) as Record<string, unknown>
  } finally {
    delete process.env.ALPHA_OPEN_DIR
  }
}

function destroyableSender(id: number): { sender: IpcSender; destroy: () => void } {
  const listeners: Array<() => void> = []
  return {
    sender: { id, once: (name, listener) => { if (name === "destroyed") listeners.push(listener) } },
    destroy: () => listeners.splice(0).forEach((listener) => listener()),
  }
}

test("G6:签发走生产分流点,返回一次性 previewId,且**任何绝对路径都不过 wire**", async () => {
  const issued = await importFolder(okPlugin, { id: 1 })
  expect(issued.route).toBe("local-claude-plugin")
  expect(typeof issued.previewId).toBe("string")
  // 安全投影:整个响应里不许出现源目录(两种写法都查 —— macOS 的 tmpdir 是 /var → /private/var 软链)。
  const wire = JSON.stringify(issued)
  expect(wire).not.toContain(tmp)
  expect(wire).not.toContain(tmpReal)
  expect(wire).not.toContain(okPlugin)
  // 字节确实留在了 main(不是「预览完就扔」)。
  expect(localPackagePreviews.retainedBytes()).toBeGreaterThan(0)
  expect(localPackagePreviews.size()).toBe(1)
  localPackagePreviews.releaseSender(1)
})

test("G6:认不出 sender 身份 ⇒ 不签发、不留字节(留存的生命周期全挂在这个 id 上)", async () => {
  const result = (await importFolder(okPlugin, undefined as unknown as IpcSender)) as Record<string, unknown>
  expect(result.route).toBe("local-claude-plugin")
  expect(result.previewId).toBeUndefined()
  expect(result.reasonCode).toBe("preview-no-sender-identity")
  expect(localPackagePreviews.retainedBytes()).toBe(0)
  expect(localPackagePreviews.size()).toBe(0)
})

test("G6:preview 只读通道回安全投影;绑 sender —— 别的 renderer 拿不走", async () => {
  const issued = await importFolder(okPlugin, { id: 1 })
  const previewId = issued.previewId as string
  const read = (await call(LOCAL_PACKAGE_READ_CHANNELS.importClaudePluginPreview, { id: 1 }, previewId)) as Record<string, unknown>
  expect(read.ok).toBe(true)
  expect(read.previewId).toBe(previewId)
  expect((read.retained as { fileCount: number }).fileCount).toBe(3) // alpha: SKILL.md + notes.md;beta: SKILL.md
  const wire = JSON.stringify(read)
  expect(wire).not.toContain(tmp)
  expect(wire).not.toContain(tmpReal)
  expect(wire).not.toContain("srcDir")
  // 同一个 previewId,另一个 renderer ⇒ 拿不到。
  const other = (await call(LOCAL_PACKAGE_READ_CHANNELS.importClaudePluginPreview, { id: 2 }, previewId)) as Record<string, unknown>
  expect(other.ok).toBe(false)
  localPackagePreviews.releaseSender(1)
})

test("G6:未经 preview 直接 confirm ⇒ 拒,且安装端口零调用", async () => {
  installCalls.length = 0
  const result = (await call(GATED_WRITE_CHANNELS.importClaudePluginConfirm, { id: 1 }, "00000000-0000-4000-8000-000000000000")) as Record<string, unknown>
  expect(result.ok).toBe(false)
  expect(installCalls).toHaveLength(0)
  // 空 / 非字符串同样拒(不是「undefined 也算一条预览」)。
  expect(((await call(GATED_WRITE_CHANNELS.importClaudePluginConfirm, { id: 1 })) as Record<string, unknown>).ok).toBe(false)
  expect(((await call(GATED_WRITE_CHANNELS.importClaudePluginConfirm, { id: 1 }, { previewId: "x" })) as Record<string, unknown>).ok).toBe(false)
  expect(installCalls).toHaveLength(0)
})

test("G6:confirm **只收 previewId** —— renderer 多塞的目录/内容不进任何写入决策", async () => {
  installCalls.length = 0
  installOutcome = { ok: false, reason: "spy: refuse" }
  const issued = await importFolder(okPlugin, { id: 1 })
  const previewId = issued.previewId as string
  const attackerDir = join(tmp, "attacker-dir")
  mkdirSync(attackerDir, { recursive: true })
  // 绕过配方:让 confirm 认 renderer 传来的第二个实参。今天它一个字都不看。
  await call(GATED_WRITE_CHANNELS.importClaudePluginConfirm, { id: 1 }, previewId, attackerDir, "attacker payload")
  expect(installCalls).toHaveLength(1)
  expect(installCalls[0]!.srcDir).toBe(okPlugin)
  expect(installCalls[0]!.srcDir).not.toBe(attackerDir)
  expect(installCalls[0]!.dirs).toEqual(["skills/alpha", "skills/beta"])
  localPackagePreviews.releaseSender(1)
})

test("G6:**写成功才消费**(`#351`)—— 失败后 previewId 仍在,成功后一次性作废", async () => {
  installCalls.length = 0
  installOutcome = { ok: false, reason: "配置写锁被占用,请稍后重试" }
  const issued = await importFolder(okPlugin, { id: 1 })
  const previewId = issued.previewId as string

  const first = (await call(GATED_WRITE_CHANNELS.importClaudePluginConfirm, { id: 1 }, previewId)) as Record<string, unknown>
  expect(first).toMatchObject({ ok: false, reason: "配置写锁被占用,请稍后重试" })
  expect(installCalls).toHaveLength(1)
  // 「取出即消费」会让这一步拿到「预览已失效」—— 用户重点确认得不到任何正确动作。
  expect(localPackagePreviews.get(previewId)).toBeDefined()

  installOutcome = { ok: true, packageId: "local:ok-plugin", installed: [{ kind: "skill", name: "alpha" }] }
  const second = (await call(GATED_WRITE_CHANNELS.importClaudePluginConfirm, { id: 1 }, previewId)) as Record<string, unknown>
  expect(second).toMatchObject({ ok: true, packageId: "local:ok-plugin" })
  expect(installCalls).toHaveLength(2)

  // 一次性:成功之后同一个 previewId 作废,且留存字节归零。
  const replay = (await call(GATED_WRITE_CHANNELS.importClaudePluginConfirm, { id: 1 }, previewId)) as Record<string, unknown>
  expect(replay.ok).toBe(false)
  expect(installCalls).toHaveLength(2)
  expect(localPackagePreviews.retainedBytes()).toBe(0)
  expect(localPackagePreviews.size()).toBe(0)
})

test("G19:取消 ⇒ confirm 被拒**且** retained bytes 归零", async () => {
  installCalls.length = 0
  const issued = await importFolder(okPlugin, { id: 7 })
  const previewId = issued.previewId as string
  expect(localPackagePreviews.retainedBytes()).toBeGreaterThan(0)

  const cancelled = (await call(LOCAL_PACKAGE_READ_CHANNELS.importClaudePluginCancel, { id: 7 }, previewId)) as Record<string, unknown>
  expect(cancelled).toEqual({ ok: true, released: true })
  // 这两条一起断言才算数:只断言「confirm 被拒」抓不住「等下次预览再覆盖」那种假释放。
  expect(localPackagePreviews.retainedBytes()).toBe(0)
  expect(localPackagePreviews.size()).toBe(0)
  const afterCancel = (await call(GATED_WRITE_CHANNELS.importClaudePluginConfirm, { id: 7 }, previewId)) as Record<string, unknown>
  expect(afterCancel.ok).toBe(false)
  expect(installCalls).toHaveLength(0)
  // 别人的预览取消不掉(取消也是身份操作)。
  expect(await call(LOCAL_PACKAGE_READ_CHANNELS.importClaudePluginCancel, { id: 8 }, previewId)).toEqual({ ok: true, released: false })
})

test("G19:窗口销毁 ⇒ 立即释放", async () => {
  const { sender, destroy } = destroyableSender(11)
  const issued = await importFolder(okPlugin, sender)
  const previewId = issued.previewId as string
  expect(localPackagePreviews.retainedBytes()).toBeGreaterThan(0)
  destroy()
  expect(localPackagePreviews.retainedBytes()).toBe(0)
  expect(((await call(GATED_WRITE_CHANNELS.importClaudePluginConfirm, { id: 11 }, previewId)) as Record<string, unknown>).ok).toBe(false)
})

test("G19:新预览替换旧预览 ⇒ 旧 previewId 当场作废,留存只算一份", async () => {
  const first = await importFolder(okPlugin, { id: 21 })
  const firstBytes = localPackagePreviews.retainedBytes()
  const second = await importFolder(okPlugin, { id: 21 })
  expect(second.previewId).not.toBe(first.previewId)
  expect(localPackagePreviews.size()).toBe(1)
  // 「每 renderer 只允许一个 active preview」的可观察判据:留存没有翻倍。
  expect(localPackagePreviews.retainedBytes()).toBe(firstBytes)
  expect(localPackagePreviews.get(first.previewId as string)).toBeUndefined()
  localPackagePreviews.releaseSender(21)
  expect(localPackagePreviews.retainedBytes()).toBe(0)
})

test("G19:**包级字节帽** —— 逐个技能都合法、合起来超预算 ⇒ 整包拒,且一个字节都不留", async () => {
  installCalls.length = 0
  const result = await importFolder(fatPlugin, { id: 31 })
  expect(result.route).toBe("local-claude-plugin")
  expect(result.previewId).toBeUndefined()
  expect(result.reasonCode).toBe("preview-budget-bytes")
  // 这一包**不是**被单技能帽拦下的 —— preview 判定里 4 个技能全是 install。
  const preview = result.localPluginPreview as { installableCount: number }
  expect(preview.installableCount).toBe(4)
  expect(4 * 9 * 1024 * 1024).toBeGreaterThan(LOCAL_PACKAGE_PREVIEW_MAX_BYTES)
  expect(9 * 1024 * 1024).toBeLessThan(10 * 1024 * 1024) // 每一个都在单技能 10MB 帽之内
  expect(localPackagePreviews.retainedBytes()).toBe(0)
  expect(localPackagePreviews.size()).toBe(0)
  expect(installCalls).toHaveLength(0)
})

test("G19:**包级文件帽** —— 同理,逐个技能都在 500 条之内,合起来越界即整包拒", async () => {
  const result = await importFolder(manyFilesPlugin, { id: 32 })
  expect(result.reasonCode).toBe("preview-budget-files")
  expect((result.localPluginPreview as { installableCount: number }).installableCount).toBe(5)
  expect(5 * 450).toBeGreaterThan(LOCAL_PACKAGE_PREVIEW_MAX_FILES)
  expect(450).toBeLessThan(500) // 每一个都在单技能 500 条帽之内
  expect(localPackagePreviews.retainedBytes()).toBe(0)
  expect(localPackagePreviews.size()).toBe(0)
})

test("只读列表通道:空账本 ⇒ 空清单;**账本读不出来 ⇒ 说「读不出」,不许折叠成「没装」**", async () => {
  const empty = (await call(LOCAL_PACKAGE_READ_CHANNELS.listInstalledPackages, { id: 1 })) as Record<string, unknown>
  expect(empty).toEqual({ ok: true, packages: [] })

  const { getAlphaEnvironment } = await import("../src/main/alpha-environment")
  const ledgerPath = join(getAlphaEnvironment().mutableRoot, "installs.json")
  mkdirSync(join(ledgerPath, ".."), { recursive: true })
  writeFileSync(ledgerPath, "{ this is not json", "utf8")
  const broken = (await call(LOCAL_PACKAGE_READ_CHANNELS.listInstalledPackages, { id: 1 })) as Record<string, unknown>
  // 折叠成 `{ok:true, packages:[]}` 会让用户在一本损坏的账本上看到「什么都没装」,
  // 而「移除」入口随之消失 —— 这正是 `#773` 那一类。
  expect(broken.ok).toBe(false)
  expect(typeof broken.reason).toBe("string")
  expect(broken.packages).toBeUndefined()
  rmSync(ledgerPath, { force: true })
})
