// REQ-053 AC1 `#966`:**清除时剥离 alpha 悬空配置引用** 的行为判据(生产接线闸)。
//
// 它替代的是 `src/main/engine-config-dangling.test.ts` 里那条读 `data-clear-boot.ts` 源码比下标的
// 断言。这里驱动的是**生产入口** `createDataClearAction().clearData()`,断言点刻意选在两个
// 用户可观察的时刻:
//   · 凭证级 —— 生产 `await logout()` **被调用的那一刻**(logout 会 respawn sidecar,引擎在那一刻
//     就要读 config;晚一步剥离 = 循环当场开始);
//   · data 级 —— 生产 `app.exit(0)` **被调用的那一刻**(应用退出后没有第二次机会;legacy
//     `~/.opencode/opencode.jsonc` 不在删除清单里,漏剥会一直留到下次启动)。
// 这两个快照各自同时钉死三件事:sweep 存在、排在 executeClear **之后**(否则目标还在、缺席不可证)、
// 排在 logout/exit **之前**。
//
// ⚠️ 安全前置(对抗审计 Major):本文件驱动的是**生产的递归删除路径**(`rmSync(p,{recursive,force})`),
// 而它的四个根全部由运行时 env/homedir 推导,且身份闸 `assertAlphaEnvironmentIdentity` 在这里被
// mock 掉了。所以每次调 `clearData()` 之前必须先跑 `assertBlastRadiusIsScratch()`:用**生产解析器**
// 各取一次四个根、再用**生产 planClear** 把这一级真正会删的每一条路径枚举出来,逐条断言落在本次
// mkdtemp 的根内,不满足直接 throw(不是 skip)。「以后有人加第五个根」会自动进枚举 ⇒ 默认拒。
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { parse } from "jsonc-parser"

import type { ClearRoots, FsDeps } from "../src/main/data-clear"
import { createElectronStub } from "./req053-electron-stub"

// HOME 必须在任何 homedir() 消费者之前钉住:守卫根之一是 `join(homedir(), ".alpha")`,
// 而 engineDataDir / opencodeHomeDir 的兜底也走 homedir()。不钉 = 真实用户目录进爆炸半径。
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), "req053-clear-")))
process.env.HOME = SCRATCH

type DialogCall = Record<string, unknown>

let userDataPath = ""
let packaged = false
const dialogCalls: DialogCall[] = []
const exitCalls: number[] = []
let dialogRouter: (options: DialogCall) => Record<string, unknown> = () => ({ response: 1 })

mock.module("electron", () =>
  createElectronStub({
    userDataPath: () => userDataPath,
    isPackaged: () => packaged,
    showMessageBox: async (options) => {
      dialogCalls.push(options)
      return dialogRouter(options)
    },
    exit: (code) => {
      exitCalls.push(code ?? 0)
      onExitSnapshot()
    },
  }),
)

// mock.module 会**就地改写**已捕获的命名空间对象 ⇒ 真值必须在注册**之前**拷进普通对象。
const realLogging = { ...(await import("../src/main/logging")) }
const realAlphaEnvironment = { ...(await import("../src/main/alpha-environment")) }

const logged: Array<{ level: string; line: string }> = []
const recorder = {
  log: (line: unknown) => logged.push({ level: "log", line: String(line) }),
  warn: (line: unknown) => logged.push({ level: "warn", line: String(line) }),
  error: (line: unknown) => logged.push({ level: "error", line: String(line) }),
}
mock.module("../src/main/logging", () => ({ ...realLogging, getLogger: () => recorder }))
// 只导出 assertAlphaEnvironmentIdentity 会让 `resolveAlphaGlobalRoot` 变成 undefined —— 那会抛在
// `tryAcquireBundleLock(alphaGlobalRoot(), …)` 上,被 clearData 的外层 catch 吞成一行日志,
// 现场与本闸毫无关系。整份命名空间照抄,只顶替身份闸。
mock.module("../src/main/alpha-environment", () => ({
  ...realAlphaEnvironment,
  assertAlphaEnvironmentIdentity: () => {},
}))

let logoutSnapshot: Snapshot | null = null
let exitSnapshot: Snapshot | null = null
mock.module("../src/main/alpha-auth", () => ({
  logout: async () => {
    logoutSnapshot = takeSnapshot()
  },
}))
mock.module("../src/main/alpha-byok-keys", () => ({ clearByokKeys: () => {} }))

const { createDataClearAction } = await import("../src/main/data-clear-boot")
const { engineDataDir, planClear } = await import("../src/main/data-clear")
const { alphaGlobalRoot } = await import("../src/main/alpha-installs")
const { opencodeHomeDir } = await import("../src/main/alpha-bridge")
const { tryAcquireBundleLock } = await import("../src/main/ext-bundle-lock")

const realFs: FsDeps = {
  exists: existsSync,
  lstat: (p) => {
    try {
      const s = lstatSync(p)
      return { isSymlink: s.isSymbolicLink(), isDir: s.isDirectory(), size: s.size }
    } catch {
      return null
    }
  },
  readdir: readdirSync,
  readlink: (p) => {
    try {
      return readlinkSync(p)
    } catch {
      return null
    }
  },
  realpath: (p) => {
    try {
      return realpathSync(p)
    } catch {
      return null
    }
  },
  remove: () => {
    throw new Error("the blast-radius guard never removes anything")
  },
}

// ── 夹具锚点:全部是独立字面量,不从被测模块 import ────────────────────────────────
const COMMENT = "req053 fixture comment — must survive every leaf edit"
const NPM_PLUGIN = "npm-plugin"
const MCP_NAME = "demo"
const DANGLING_ENV_KEY = "TOKEN"
const LIVE_ENV_KEY = "KEEP"

let caseDir = ""
let roots: ClearRoots
let xdgConfigDir = ""
let alphaConfig = ""
let legacyConfig = ""
let xdgConfig = ""
let danglingPlugin = ""
let foreignPlugin = ""
let secretFile = ""
let liveRefTarget = ""
let seededAlphaText = ""
let seededLegacyText = ""
let xdgIdentity = { ino: 0, mtimeMs: 0, text: "" }

const ENV_KEYS = [
  "ALPHA_GLOBAL_DIR",
  "ALPHA_OPENCODE_HOME",
  "OPENCODE_CONFIG_DIR",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "ALPHA_JSONC_TRUTH_DISABLE",
  "ALPHA_LEGACY_INSTALL_ROOT",
] as const
const savedEnv: Record<string, string | undefined> = {}

type Snapshot = {
  alpha: string | null
  legacy: string | null
  xdg: { text: string; ino: number; mtimeMs: number } | null
  secretExists: boolean
}

function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return null
  }
}

function takeSnapshot(): Snapshot {
  const xdgStat = existsSync(xdgConfig) ? statSync(xdgConfig) : null
  return {
    alpha: readOrNull(alphaConfig),
    legacy: readOrNull(legacyConfig),
    xdg: xdgStat ? { text: readFileSync(xdgConfig, "utf8"), ino: xdgStat.ino, mtimeMs: xdgStat.mtimeMs } : null,
    secretExists: existsSync(secretFile),
  }
}

function onExitSnapshot() {
  exitSnapshot = takeSnapshot()
}

/** 「事故原形的那两条引用还在不在」—— drill 的指纹就是这个数组从 [] 变成非空。 */
function incidentRefsStillIn(text: string | null): string[] {
  if (text === null) return ["<file missing>"]
  const still: string[] = []
  if (text.includes(`"${DANGLING_ENV_KEY}"`)) still.push(`mcp.${MCP_NAME}.environment.${DANGLING_ENV_KEY}`)
  if (text.includes(danglingPlugin)) still.push(`plugin[gone.js]`)
  return still
}

function configText(kind: "alpha" | "legacy") {
  const configDir = kind === "alpha" ? roots.alphaGlobal : roots.opencodeHome
  return `{
  // ${COMMENT} (${kind}, dir=${configDir})
  "plugin": [
    ${JSON.stringify(danglingPlugin)},
    ${JSON.stringify(NPM_PLUGIN)},
    ${JSON.stringify(foreignPlugin)}
  ],
  "mcp": {
    ${JSON.stringify(MCP_NAME)}: {
      "type": "local",
      "environment": {
        ${JSON.stringify(DANGLING_ENV_KEY)}: ${JSON.stringify(`{file:${secretFile}}`)},
        ${JSON.stringify(LIVE_ENV_KEY)}: ${JSON.stringify(`{file:${liveRefTarget}}`)}
      }
    }
  }
}
`
}

let caseIndex = 0

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  caseIndex += 1
  caseDir = join(SCRATCH, `case-${caseIndex}`)
  roots = {
    userData: join(caseDir, "user-data"),
    alphaGlobal: join(caseDir, "alpha-global"),
    opencodeHome: join(caseDir, "opencode-home"),
    engineData: join(caseDir, "xdg-data", "opencode"),
  }
  xdgConfigDir = join(caseDir, "xdg-config")
  userDataPath = roots.userData
  packaged = false
  dialogCalls.length = 0
  exitCalls.length = 0
  logged.length = 0
  logoutSnapshot = null
  exitSnapshot = null

  process.env.ALPHA_GLOBAL_DIR = roots.alphaGlobal
  process.env.ALPHA_OPENCODE_HOME = roots.opencodeHome
  process.env.OPENCODE_CONFIG_DIR = xdgConfigDir
  process.env.XDG_DATA_HOME = join(caseDir, "xdg-data")
  delete process.env.XDG_CONFIG_HOME
  delete process.env.ALPHA_JSONC_TRUTH_DISABLE
  delete process.env.ALPHA_LEGACY_INSTALL_ROOT

  danglingPlugin = join(roots.userData, "plugins", "gone.js") // 从来不存在 ⇒ 确证缺席
  foreignPlugin = join(caseDir, "user-project", "plugin.js") // 守卫根**之外**,同样缺席 ⇒ 必须保留
  secretFile = join(roots.userData, "alpha-mcp-secrets", MCP_NAME, DANGLING_ENV_KEY)
  liveRefTarget = join(roots.engineData, "live", LIVE_ENV_KEY)
  alphaConfig = join(roots.alphaGlobal, "alpha.jsonc")
  legacyConfig = join(roots.opencodeHome, "opencode.jsonc")
  xdgConfig = join(xdgConfigDir, "opencode.jsonc")

  for (const dir of [roots.userData, roots.alphaGlobal, roots.opencodeHome, roots.engineData, xdgConfigDir]) {
    mkdirSync(dir, { recursive: true })
  }
  mkdirSync(join(roots.userData, "plugins"), { recursive: true })
  mkdirSync(join(roots.userData, "alpha-mcp-secrets", MCP_NAME), { recursive: true })
  mkdirSync(join(roots.engineData, "live"), { recursive: true })
  writeFileSync(secretFile, "s3cret")
  writeFileSync(liveRefTarget, "still here")

  writeFileSync(alphaConfig, configText("alpha"))
  writeFileSync(legacyConfig, configText("legacy"))
  seededAlphaText = readFileSync(alphaConfig, "utf8")
  seededLegacyText = readFileSync(legacyConfig, "utf8")
  // XDG 用户配置:同形悬空引用,目标就在守卫根里 —— 产品仍然一个字节都不许写(I1)。
  writeFileSync(xdgConfig, configText("legacy"))
  const stat = statSync(xdgConfig)
  xdgIdentity = { ino: stat.ino, mtimeMs: stat.mtimeMs, text: readFileSync(xdgConfig, "utf8") }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(caseDir, { recursive: true, force: true })
})

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true })
})

/**
 * fail-closed 前置:用**生产解析器**取四个根,再用**生产 planClear** 枚举这一级真正会被
 * `rmSync -rf` 的每一条路径,逐条断言落在本次 mkdtemp 的根内。任一条越界 ⇒ throw(不是 skip)。
 */
function assertBlastRadiusIsScratch(level: "credentials" | "data") {
  const resolved = {
    userData: userDataPath,
    alphaGlobal: alphaGlobalRoot(),
    opencodeHome: opencodeHomeDir(),
    engineData: engineDataDir(process.env, homedir()),
  }
  const inside = (p: string) => resolve(p) === SCRATCH || resolve(p).startsWith(SCRATCH + sep)
  for (const [name, value] of Object.entries(resolved)) {
    if (!inside(value)) throw new Error(`REFUSING to run clearData(): root ${name}=${value} escapes ${SCRATCH}`)
  }
  const plan = planClear(realFs, level, resolved)
  for (const item of plan.items) {
    if (!inside(item.path)) throw new Error(`REFUSING to run clearData(): plan item ${item.id}=${item.path} escapes ${SCRATCH}`)
  }
  for (const link of plan.bridgeLinks) {
    if (!inside(link)) throw new Error(`REFUSING to run clearData(): bridge link ${link} escapes ${SCRATCH}`)
  }
}

async function waitFor(what: string, predicate: () => boolean, timeoutMs = 20_000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`${what} never happened. logged=${JSON.stringify(logged, null, 2)}`)
    }
    await new Promise((r) => setTimeout(r, 5))
  }
}

function action() {
  return createDataClearAction({ userDataPath, stopSidecars: async () => {} })
}

function routeByTitle(script: Record<string, Record<string, unknown>>) {
  dialogRouter = (options) => {
    const title = String(options.title ?? "")
    const reply = script[title]
    if (!reply) return { response: 1 } // 未脚本化的对话框 = 取消,流程会卡住并被 waitFor 报出来
    return reply
  }
}

function expectNoUnexpectedErrors() {
  const errors = logged.filter((entry) => entry.level === "error")
  expect(errors.map((entry) => entry.line)).toEqual([])
}

test("credential clear strips both incident-shaped refs before logout() is called", async () => {
  routeByTitle({ 清除数据: { response: 0 }, 清除凭证: { response: 0 }, 已清除凭证: { response: 0 } })
  assertBlastRadiusIsScratch("credentials")

  action().clearData()
  await waitFor("logout()", () => logoutSnapshot !== null)
  await waitFor("the credential flow to finish", () => dialogCalls.some((c) => c.title === "已清除凭证"))
  const endSnapshot = takeSnapshot()

  const snapshot = logoutSnapshot!
  console.log(
    `[req053-drill] at-logout still-present=${JSON.stringify([
      ...incidentRefsStillIn(snapshot.alpha),
      ...incidentRefsStillIn(snapshot.legacy),
    ])} at-end=${JSON.stringify([
      ...incidentRefsStillIn(endSnapshot.alpha),
      ...incidentRefsStillIn(endSnapshot.legacy),
    ])}`,
  )
  expectNoUnexpectedErrors()

  // ① 目标真的被删了(否则「缺席」不可证,sweep 结构上什么都不会剥)
  expect(snapshot.secretExists).toBe(false)
  // ② 在 logout 那一刻,两份 alpha 自有 config 里的事故原形都已经不在
  expect(incidentRefsStillIn(snapshot.alpha)).toEqual([])
  expect(incidentRefsStillIn(snapshot.legacy)).toEqual([])
  // 第二条检索轴:结构化解析,不只看文本
  for (const text of [snapshot.alpha!, snapshot.legacy!]) {
    const config = parse(text) as { plugin: string[]; mcp: Record<string, { environment: Record<string, string> }> }
    expect(config.plugin).not.toContain(danglingPlugin)
    expect(Object.keys(config.mcp[MCP_NAME]!.environment)).not.toContain(DANGLING_ENV_KEY)
  }
})

test("credential clear does not over-strip: npm entry, live ref, user-foreign path, comment, mcp leaf and the XDG file all survive", async () => {
  routeByTitle({ 清除数据: { response: 0 }, 清除凭证: { response: 0 }, 已清除凭证: { response: 0 } })
  assertBlastRadiusIsScratch("credentials")

  action().clearData()
  await waitFor("logout()", () => logoutSnapshot !== null)
  const snapshot = logoutSnapshot!
  expectNoUnexpectedErrors()

  for (const text of [snapshot.alpha!, snapshot.legacy!]) {
    expect(text).toContain(COMMENT)
    const config = parse(text) as {
      plugin: string[]
      mcp: Record<string, { type: string; environment: Record<string, string> }>
    }
    expect(config.plugin).toEqual([NPM_PLUGIN, foreignPlugin])
    // mcp 叶本身是用户可见的安装事实,只许少掉那一个悬空 env 键
    expect(config.mcp[MCP_NAME]!.type).toBe("local")
    expect(Object.keys(config.mcp[MCP_NAME]!.environment)).toEqual([LIVE_ENV_KEY])
    expect(config.mcp[MCP_NAME]!.environment[LIVE_ENV_KEY]).toBe(`{file:${liveRefTarget}}`)
  }
  // I1:XDG 用户配置里有同形悬空引用(目标就在守卫根内),产品仍然零写入
  expect(snapshot.xdg).toEqual(xdgIdentity)
})

test("a busy config lock deletes the files but leaves both configs byte-identical and says so out loud", async () => {
  routeByTitle({ 清除数据: { response: 0 }, 清除凭证: { response: 0 }, 已清除凭证: { response: 0 } })
  assertBlastRadiusIsScratch("credentials")

  const held = tryAcquireBundleLock(alphaGlobalRoot(), { txId: "held-by-req053-test" })
  expect(held.ok).toBe(true)
  if (!held.ok) return
  try {
    action().clearData()
    await waitFor("logout()", () => logoutSnapshot !== null)
    const snapshot = logoutSnapshot!

    expect(snapshot.secretExists).toBe(false)
    expect(snapshot.alpha).toBe(seededAlphaText)
    expect(snapshot.legacy).toBe(seededLegacyText)
    expect(logged.some((entry) => entry.line.startsWith("[req053-dangling-sweep] level=credentials skipped:"))).toBe(true)
  } finally {
    held.lock.release()
  }
})

test("full data clear sweeps the legacy config before app.exit(0)", async () => {
  packaged = true
  routeByTitle({
    清除数据: { response: 1 },
    建议先导出会话数据库: { response: 0 },
    "永久删除全部数据?": { response: 0, checkboxChecked: false },
  })
  assertBlastRadiusIsScratch("data")

  action().clearData()
  await waitFor("app.exit(0)", () => exitCalls.length > 0)
  const snapshot = exitSnapshot!
  console.log(
    `[req053-drill] at-exit still-present=${JSON.stringify(incidentRefsStillIn(snapshot.legacy))} exitCalls=${JSON.stringify(exitCalls)}`,
  )
  expectNoUnexpectedErrors()

  expect(exitCalls).toEqual([0])
  // data 级把 alphaGlobal 整根删掉 ⇒ alpha.jsonc 随根消失,唯一还在盘上的 alpha 自有配置是 legacy。
  expect(snapshot.alpha).toBeNull()
  expect(snapshot.secretExists).toBe(false)
  expect(incidentRefsStillIn(snapshot.legacy)).toEqual([])

  const config = parse(snapshot.legacy!) as {
    plugin: string[]
    mcp: Record<string, { type: string; environment: Record<string, string> }>
  }
  expect(config.plugin).toEqual([NPM_PLUGIN, foreignPlugin])
  expect(config.mcp[MCP_NAME]!.type).toBe("local")
  // 未勾选「同时删除引擎数据」⇒ 活引用的目标还在 ⇒ 它必须原样留着
  expect(Object.keys(config.mcp[MCP_NAME]!.environment)).toEqual([LIVE_ENV_KEY])
  expect(snapshot.legacy).toContain(COMMENT)
  expect(snapshot.xdg).toEqual(xdgIdentity)
})

test("the final data-clear confirmation tells the user the truth about dangling refs", async () => {
  packaged = true
  routeByTitle({
    清除数据: { response: 1 },
    建议先导出会话数据库: { response: 0 },
    "永久删除全部数据?": { response: 1 }, // 取消:本格只判用户真会读到的那一串字
  })

  action().clearData()
  await waitFor("the destructive confirmation", () => dialogCalls.some((c) => c.title === "永久删除全部数据?"))
  const confirm = dialogCalls.find((c) => c.title === "永久删除全部数据?")!
  const detail = String(confirm.detail ?? "")

  expect(detail).toContain("Alpha 自有配置中指向已清除数据的悬空连接器/插件引用会一并清理")
  expect(detail).not.toContain("事后手动清理其条目")
  expect(exitCalls).toEqual([])
})
