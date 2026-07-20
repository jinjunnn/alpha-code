// REQ-098 单测:唯一环境映射(prod→stable / beta→preview / dev→dev)、环境 mutable root 分域、
// updater feed 对齐 loud-fail 判定(AC#2)、跨环境不可见(AC#1)、renderer 不可伪造(AC#6,
// 含 grep 守卫:ALPHA_GLOBAL_DIR 赋值点收敛 + 环境 IPC 零参数只读)。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  __resetAlphaEnvironmentForTests,
  assertAlphaEnvironmentIdentity,
  catalogRegistryChannel,
  defaultAlphaBaseRoot,
  environmentMutableRoot,
  getAlphaEnvironment,
  initAlphaEnvironment,
  parseAppUpdateYml,
  registryChannelFor,
  resolveAlphaGlobalRoot,
  resolveAppEnvironment,
  updaterFeedChannelFor,
  verifyUpdaterFeed,
} from "./alpha-environment"
import { createSidecarEnv } from "./sidecar-env"
import { readLedger, addReceipt, findReceipt, alphaGlobalRoot } from "./alpha-installs"
import { persistMcp } from "./ext-config"
import { writeMcpSecret } from "./alpha-mcp-secrets"

let base = ""
let appData = ""
let home = ""
const prevAlpha = process.env.ALPHA_GLOBAL_DIR
const prevBase = process.env.ALPHA_ENV_BASE_DIR
const prevHome = process.env.ALPHA_OPENCODE_HOME
const prevConfigDir = process.env.OPENCODE_CONFIG_DIR

beforeEach(() => {
  __resetAlphaEnvironmentForTests()
  // 环境根含空格 + Unicode(AC#5):路径逻辑不得对字符集/空格做任何假设
  base = fs.mkdtempSync(path.join(os.tmpdir(), "alpha 环境-"))
  appData = path.join(base, "App Data α")
  home = path.join(base, "home α")
  fs.mkdirSync(appData, { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  delete process.env.ALPHA_GLOBAL_DIR
  delete process.env.ALPHA_ENV_BASE_DIR
  process.env.ALPHA_OPENCODE_HOME = path.join(base, "opencode-home")
  process.env.OPENCODE_CONFIG_DIR = path.join(base, "xdg")
})
afterEach(() => {
  __resetAlphaEnvironmentForTests()
  if (prevAlpha === undefined) delete process.env.ALPHA_GLOBAL_DIR
  else process.env.ALPHA_GLOBAL_DIR = prevAlpha
  if (prevBase === undefined) delete process.env.ALPHA_ENV_BASE_DIR
  else process.env.ALPHA_ENV_BASE_DIR = prevBase
  if (prevHome === undefined) delete process.env.ALPHA_OPENCODE_HOME
  else process.env.ALPHA_OPENCODE_HOME = prevHome
  if (prevConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = prevConfigDir
  fs.rmSync(base, { recursive: true, force: true })
})

describe("环境判定与唯一映射(REQ-098 交付①)", () => {
  test("packaged × channel → 环境;未打包一律 dev", () => {
    expect(resolveAppEnvironment({ isPackaged: true, channel: "prod" })).toBe("prod")
    expect(resolveAppEnvironment({ isPackaged: true, channel: "beta" })).toBe("beta")
    expect(resolveAppEnvironment({ isPackaged: true, channel: "dev" })).toBe("dev")
    expect(resolveAppEnvironment({ isPackaged: false, channel: "prod" })).toBe("dev")
    expect(resolveAppEnvironment({ isPackaged: false, channel: "beta" })).toBe("dev")
  })

  test("registry 通道:prod→stable、beta→preview、dev→dev", () => {
    expect(registryChannelFor("prod")).toBe("stable")
    expect(registryChannelFor("beta")).toBe("preview")
    expect(registryChannelFor("dev")).toBe("dev")
  })

  test("updater feed:prod→latest、beta→beta(preview,休眠)、dev→禁用", () => {
    expect(updaterFeedChannelFor("prod")).toBe("latest")
    expect(updaterFeedChannelFor("beta")).toBe("beta")
    expect(updaterFeedChannelFor("dev")).toBeNull()
  })

  test("mutable roots 恒为 <base>/env/{dev,prod,beta} 三兄弟", () => {
    expect(environmentMutableRoot("prod", "/b/state")).toBe(path.join("/b/state", "env", "prod"))
    expect(environmentMutableRoot("beta", "/b/state")).toBe(path.join("/b/state", "env", "beta"))
    expect(environmentMutableRoot("dev", "/b/state")).toBe(path.join("/b/state", "env", "dev"))
  })
})

describe("initAlphaEnvironment — canonical 新根与 override 权限", () => {
  test("默认拓扑落在 appData/alpha-code-state，创建后端点均为 canonical 实目录", () => {
    const info = initAlphaEnvironment({ isPackaged: true, channel: "prod", appDataDir: appData, homeDir: home })
    const state = fs.realpathSync(defaultAlphaBaseRoot(appData))
    expect(info.mutableRoot).toBe(path.join(state, "env", "prod"))
    expect(process.env.ALPHA_GLOBAL_DIR).toBe(info.mutableRoot)
    expect(info.casBaseRoot).toBe(state)
    expect(info.rootOverridden).toBe(false)
    for (const directory of [state, path.join(state, "cas"), ...["dev", "prod", "beta"].map((name) => path.join(state, "env", name))]) {
      expect(fs.lstatSync(directory).isSymbolicLink()).toBe(false)
      expect(fs.realpathSync(directory)).toBe(directory)
    }
    expect(() => assertAlphaEnvironmentIdentity()).not.toThrow()
  })

  test("默认初始化不创建或访问退休根", () => {
    const retired = path.join(home, ".alpha")
    expect(fs.existsSync(retired)).toBe(false)
    initAlphaEnvironment({ isPackaged: false, channel: "dev", appDataDir: appData, homeDir: home })
    expect(fs.existsSync(retired)).toBe(false)
  })

  test("unpackaged 只接受 base 级 ALPHA_ENV_BASE_DIR，仍派生三兄弟", () => {
    const override = path.join(base, "覆盖 state α")
    process.env.ALPHA_ENV_BASE_DIR = override
    const info = initAlphaEnvironment({ isPackaged: false, channel: "prod", appDataDir: appData, homeDir: home })
    expect(info.mutableRoot).toBe(fs.realpathSync(path.join(override, "env", "dev")))
    expect(info.casBaseRoot).toBe(fs.realpathSync(override))
    expect(info.rootOverridden).toBe(true)
    expect(process.env.ALPHA_GLOBAL_DIR).toBe(info.mutableRoot)
  })

  test("packaged onboarding 只接受显式内部 base 参数", () => {
    const internal = path.join(base, "internal onboarding")
    const info = initAlphaEnvironment({
      isPackaged: true,
      channel: "beta",
      appDataDir: appData,
      homeDir: home,
      baseRoot: internal,
    })
    expect(info.mutableRoot).toBe(fs.realpathSync(path.join(internal, "env", "beta")))
    expect(info.rootOverridden).toBe(true)
  })

  test("packaged 发现任一外部 root override 时派生前拒绝", () => {
    for (const key of ["ALPHA_GLOBAL_DIR", "ALPHA_ENV_BASE_DIR"] as const) {
      __resetAlphaEnvironmentForTests()
      delete process.env.ALPHA_GLOBAL_DIR
      delete process.env.ALPHA_ENV_BASE_DIR
      process.env[key] = path.join(base, key)
      expect(() =>
        initAlphaEnvironment({ isPackaged: true, channel: "prod", appDataDir: appData, homeDir: home }),
      ).toThrow()
      expect(() => getAlphaEnvironment()).toThrow()
      expect(process.env.ALPHA_GLOBAL_DIR).toBe(key === "ALPHA_GLOBAL_DIR" ? path.join(base, key) : undefined)
      expect(fs.existsSync(path.join(base, key))).toBe(false)
    }
  })

  test("catalogRegistryChannel(REQ-098 #302):唯一权威取值点 = 冻结快照映射;未初始化抛(fail-fast)", () => {
    expect(() => catalogRegistryChannel()).toThrow() // 环境未解析前 catalog 拉取不允许发生
    initAlphaEnvironment({ isPackaged: true, channel: "prod", appDataDir: appData, homeDir: home })
    expect(catalogRegistryChannel()).toBe("stable")
    __resetAlphaEnvironmentForTests()
    delete process.env.ALPHA_GLOBAL_DIR
    initAlphaEnvironment({ isPackaged: true, channel: "beta", appDataDir: appData, homeDir: home })
    expect(catalogRegistryChannel()).toBe("preview")
    __resetAlphaEnvironmentForTests()
    delete process.env.ALPHA_GLOBAL_DIR
    initAlphaEnvironment({ isPackaged: false, channel: "dev", appDataDir: appData, homeDir: home })
    expect(catalogRegistryChannel()).toBe("dev")
  })

  test("casBaseRoot(REQ-102 #317):三环境共享新 base", () => {
    const prod = initAlphaEnvironment({ isPackaged: true, channel: "prod", appDataDir: appData, homeDir: home })
    expect(prod.casBaseRoot).toBe(fs.realpathSync(defaultAlphaBaseRoot(appData)))
    expect(prod.casBaseRoot).not.toBe(prod.mutableRoot) // prod 状态分域,CAS 共享基根

    __resetAlphaEnvironmentForTests()
    delete process.env.ALPHA_GLOBAL_DIR
    const beta = initAlphaEnvironment({ isPackaged: true, channel: "beta", appDataDir: appData, homeDir: home })
    expect(beta.casBaseRoot).toBe(prod.casBaseRoot) // prod/beta 共享同一 CAS 基根(blob 去重)

    __resetAlphaEnvironmentForTests()
    delete process.env.ALPHA_GLOBAL_DIR
    const override = path.join(base, "覆盖 cas root")
    process.env.ALPHA_ENV_BASE_DIR = override
    const overridden = initAlphaEnvironment({ isPackaged: false, channel: "prod", appDataDir: appData, homeDir: home })
    expect(overridden.casBaseRoot).toBe(fs.realpathSync(override))
  })

  test("退休根、其祖先和后代作为旧 ALPHA_GLOBAL_DIR 预置都拒绝且不产生快照", () => {
    const retired = path.join(home, ".alpha")
    for (const value of [retired, home, path.join(retired, "child")]) {
      __resetAlphaEnvironmentForTests()
      process.env.ALPHA_GLOBAL_DIR = value
      expect(() =>
        initAlphaEnvironment({ isPackaged: false, channel: "dev", appDataDir: appData, homeDir: home }),
      ).toThrow()
      expect(() => getAlphaEnvironment()).toThrow()
      expect(process.env.ALPHA_GLOBAL_DIR).toBe(value)
    }
  })

  test("unpackaged base override 也拒绝退休根的等值、祖先与后代", () => {
    const retired = path.join(home, ".alpha")
    for (const value of [home, retired, path.join(retired, "child")]) {
      __resetAlphaEnvironmentForTests()
      delete process.env.ALPHA_GLOBAL_DIR
      process.env.ALPHA_ENV_BASE_DIR = value
      expect(() =>
        initAlphaEnvironment({ isPackaged: false, channel: "dev", appDataDir: appData, homeDir: home }),
      ).toThrow()
      expect(process.env.ALPHA_GLOBAL_DIR).toBeUndefined()
    }
  })

  test("base endpoint symlink 指向退休根时拒绝", () => {
    const retired = path.join(home, ".alpha")
    const alias = path.join(base, "retired alias")
    fs.mkdirSync(retired, { recursive: true })
    fs.symlinkSync(retired, alias)
    process.env.ALPHA_ENV_BASE_DIR = alias
    expect(() =>
      initAlphaEnvironment({ isPackaged: false, channel: "dev", appDataDir: appData, homeDir: home }),
    ).toThrow()
    expect(process.env.ALPHA_GLOBAL_DIR).toBeUndefined()
  })

  test("非终段 symlink 让 prospective base 落入退休根时拒绝", () => {
    const retired = path.join(home, ".alpha")
    const alias = path.join(base, "alias parent")
    fs.mkdirSync(retired, { recursive: true })
    fs.symlinkSync(retired, alias)
    process.env.ALPHA_ENV_BASE_DIR = path.join(alias, "state")
    expect(() =>
      initAlphaEnvironment({ isPackaged: false, channel: "dev", appDataDir: appData, homeDir: home }),
    ).toThrow()
  })

  test("空白、相对和无法确认身份的 base fail-closed", () => {
    const blocker = path.join(base, "not-a-directory")
    fs.writeFileSync(blocker, "x")
    for (const value of ["   ", "relative/state", path.join(blocker, "state")]) {
      __resetAlphaEnvironmentForTests()
      delete process.env.ALPHA_GLOBAL_DIR
      process.env.ALPHA_ENV_BASE_DIR = value
      expect(() =>
        initAlphaEnvironment({ isPackaged: false, channel: "dev", appDataDir: appData, homeDir: home }),
      ).toThrow()
      expect(process.env.ALPHA_GLOBAL_DIR).toBeUndefined()
    }
  })

  test("canonical alias 让两环境根等值时整次初始化拒绝", () => {
    const override = path.join(base, "alias matrix")
    fs.mkdirSync(path.join(override, "env", "dev"), { recursive: true })
    fs.symlinkSync(path.join(override, "env", "dev"), path.join(override, "env", "prod"))
    process.env.ALPHA_ENV_BASE_DIR = override
    expect(() =>
      initAlphaEnvironment({ isPackaged: false, channel: "dev", appDataDir: appData, homeDir: home }),
    ).toThrow()
  })

  test("Unicode、空格、.. 与尾分隔符 normalize 后仍派生正确兄弟根", () => {
    const override = path.join(base, "unused", "..", "state 空格 β") + path.sep
    process.env.ALPHA_ENV_BASE_DIR = override
    const info = initAlphaEnvironment({ isPackaged: false, channel: "dev", appDataDir: appData, homeDir: home })
    expect(info.casBaseRoot).toBe(fs.realpathSync(path.normalize(override)))
    expect(info.mutableRoot).toBe(fs.realpathSync(path.join(path.normalize(override), "env", "dev")))
  })

  test("冻结后 root 被换链，批次身份复验整批拒绝", () => {
    const info = initAlphaEnvironment({ isPackaged: true, channel: "prod", appDataDir: appData, homeDir: home })
    const elsewhere = path.join(base, "elsewhere")
    fs.mkdirSync(elsewhere)
    fs.rmSync(info.mutableRoot, { recursive: true })
    fs.symlinkSync(elsewhere, info.mutableRoot)
    expect(() => assertAlphaEnvironmentIdentity()).toThrow()
  })

  test("alphaGlobalRoot 无快照时缺失/相对/退休根均拒绝", () => {
    __resetAlphaEnvironmentForTests()
    delete process.env.ALPHA_GLOBAL_DIR
    expect(() => alphaGlobalRoot()).toThrow()
    process.env.ALPHA_GLOBAL_DIR = "relative/root"
    expect(() => alphaGlobalRoot()).toThrow()
    process.env.ALPHA_GLOBAL_DIR = path.join(os.homedir(), ".alpha")
    expect(() => alphaGlobalRoot()).toThrow()
    process.env.ALPHA_GLOBAL_DIR = path.join(home, ".alpha", "child")
    expect(() => resolveAlphaGlobalRoot(process.env, home)).toThrow()
  })
})

describe("AC#1 跨环境隔离:同 ID 不同版本互不可见(config/receipt/secret)", () => {
  test("prod 与 beta 各自的账本、alpha.jsonc、secret 文件互不可见", () => {
    // ── 环境 A(prod)安装 conn@1.0.0 ──
    const infoA = initAlphaEnvironment({ isPackaged: true, channel: "prod", appDataDir: appData, homeDir: home })
    const userDataA = path.join(base, "userData prod α")
    const r1 = persistMcp(
      "shared-conn",
      { type: "local", command: ["npx", "-y", "shared-conn@1.0.0"] },
      { catalogId: "cat:shared-conn", version: "1.0.0" },
    )
    expect(r1.ok).toBe(true)
    // #354:eager v1 已下线 —— 各环境 receipt 显式落账(隔离断言的意图不变:账本按环境根分治)。
    addReceipt(infoA.mutableRoot, { id: "cat:shared-conn", name: "shared-conn", type: "mcp", scope: "global", version: "1.0.0", installedAt: new Date().toISOString(), origin: "catalog", configKey: "mcp.shared-conn" })
    const s1 = writeMcpSecret(userDataA, "shared-conn", "TOKEN", "secret-of-prod")
    expect(s1.ok).toBe(true)

    // ── 环境 B(beta)安装 conn@2.0.0(进程重启语义:重置单例 + 清 env)──
    __resetAlphaEnvironmentForTests()
    delete process.env.ALPHA_GLOBAL_DIR
    const infoB = initAlphaEnvironment({ isPackaged: true, channel: "beta", appDataDir: appData, homeDir: home })
    const userDataB = path.join(base, "userData beta β")
    const r2 = persistMcp(
      "shared-conn",
      { type: "local", command: ["npx", "-y", "shared-conn@2.0.0"] },
      { catalogId: "cat:shared-conn", version: "2.0.0" },
    )
    expect(r2.ok).toBe(true)
    addReceipt(infoB.mutableRoot, { id: "cat:shared-conn", name: "shared-conn", type: "mcp", scope: "global", version: "2.0.0", installedAt: new Date().toISOString(), origin: "catalog", configKey: "mcp.shared-conn" })
    const s2 = writeMcpSecret(userDataB, "shared-conn", "TOKEN", "secret-of-beta")
    expect(s2.ok).toBe(true)

    // 根彼此独立且互不包含
    expect(infoA.mutableRoot).not.toBe(infoB.mutableRoot)
    expect(infoB.mutableRoot.startsWith(infoA.mutableRoot + path.sep)).toBe(false)
    expect(infoA.mutableRoot.startsWith(infoB.mutableRoot + path.sep)).toBe(false)

    // receipts:各环境只看到自己的版本
    const ledgerA = readLedger(infoA.mutableRoot)
    const ledgerB = readLedger(infoB.mutableRoot)
    expect(ledgerA.receipts).toHaveLength(1)
    expect(ledgerA.receipts[0].version).toBe("1.0.0")
    expect(ledgerB.receipts).toHaveLength(1)
    expect(ledgerB.receipts[0].version).toBe("2.0.0")

    // config:各环境 alpha.jsonc 只含自己的版本
    const jsoncA = fs.readFileSync(path.join(infoA.mutableRoot, "alpha.jsonc"), "utf8")
    const jsoncB = fs.readFileSync(path.join(infoB.mutableRoot, "alpha.jsonc"), "utf8")
    expect(jsoncA).toContain("shared-conn@1.0.0")
    expect(jsoncA).not.toContain("shared-conn@2.0.0")
    expect(jsoncB).toContain("shared-conn@2.0.0")
    expect(jsoncB).not.toContain("shared-conn@1.0.0")

    // secrets:各环境 userData 下各一份,内容互异
    expect(fs.readFileSync(path.join(userDataA, "alpha-mcp-secrets", "shared-conn", "TOKEN"), "utf8")).toBe("secret-of-prod")
    expect(fs.readFileSync(path.join(userDataB, "alpha-mcp-secrets", "shared-conn", "TOKEN"), "utf8")).toBe("secret-of-beta")

    // 交叉查询不可见
    expect(findReceipt(infoA.mutableRoot, "mcp", "shared-conn")?.version).toBe("1.0.0")
    expect(findReceipt(infoB.mutableRoot, "mcp", "shared-conn")?.version).toBe("2.0.0")
  })

  test("坏账本环境不污染另一环境(分域文件各自独立)", () => {
    const rootA = path.join(defaultAlphaBaseRoot(appData), "env", "prod")
    const rootB = path.join(defaultAlphaBaseRoot(appData), "env", "beta")
    fs.mkdirSync(rootA, { recursive: true })
    fs.mkdirSync(rootB, { recursive: true })
    fs.writeFileSync(path.join(rootA, "installs.json"), "corrupt{{{")
    const ok = addReceipt(rootB, {
      id: "cat:x",
      name: "x",
      type: "skill",
      scope: "global",
      origin: "catalog",
      installedAt: new Date().toISOString(),
    })
    expect(ok.ok).toBe(true)
    expect(readLedger(rootA).warning).toBeDefined()
    expect(readLedger(rootB).receipts).toHaveLength(1)
  })
})

describe("AC#2 updater feed 对齐(loud-fail 判定核)", () => {
  test("正确映射:prod+latest / beta+beta(含打包元数据一致)→ ok", () => {
    expect(verifyUpdaterFeed({ environment: "prod", runtimeChannel: "latest", packaged: null }).ok).toBe(true)
    expect(
      verifyUpdaterFeed({
        environment: "prod",
        runtimeChannel: "latest",
        packaged: { provider: "github", owner: "jinjunnn", repo: "alpha-code" },
      }).ok,
    ).toBe(true)
    expect(
      verifyUpdaterFeed({
        environment: "beta",
        runtimeChannel: "beta",
        packaged: { provider: "github", owner: "jinjunnn", repo: "alpha-code", channel: "beta" },
      }).ok,
    ).toBe(true)
  })

  test("错误映射 loud-fail:beta 查 latest / prod 查 beta / dev 查任何 feed", () => {
    expect(verifyUpdaterFeed({ environment: "beta", runtimeChannel: "latest", packaged: null }).ok).toBe(false)
    expect(verifyUpdaterFeed({ environment: "prod", runtimeChannel: "beta", packaged: null }).ok).toBe(false)
    expect(verifyUpdaterFeed({ environment: "dev", runtimeChannel: "latest", packaged: null }).ok).toBe(false)
  })

  test("构建发布 channel 与环境不符 → loud-fail(打包 yml 声明 beta 但运行时是 prod)", () => {
    const v = verifyUpdaterFeed({
      environment: "prod",
      runtimeChannel: "latest",
      packaged: { owner: "jinjunnn", repo: "alpha-code", channel: "beta" },
    })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toContain("beta")
  })

  test("feed 指向非自有仓(B9 wrong-owner)→ loud-fail", () => {
    expect(
      verifyUpdaterFeed({
        environment: "prod",
        runtimeChannel: "latest",
        packaged: { owner: "anomalyco", repo: "opencode" },
      }).ok,
    ).toBe(false)
  })

  test("parseAppUpdateYml:提取 provider/owner/repo/channel,容忍引号与 CRLF", () => {
    const parsed = parseAppUpdateYml("provider: github\r\nowner: 'jinjunnn'\r\nrepo: alpha-code\r\nchannel: \"beta\"\r\n")
    expect(parsed).toEqual({ provider: "github", owner: "jinjunnn", repo: "alpha-code", channel: "beta" })
    expect(parseAppUpdateYml("provider: github\nowner: jinjunnn\nrepo: alpha-code\n").channel).toBeUndefined()
  })
})

describe("AC#6 renderer 不可伪造环境", () => {
  test("快照冻结:init 后不可变;重复 init(哪怕换渠道)返回同一快照", () => {
    const info = initAlphaEnvironment({ isPackaged: true, channel: "prod", appDataDir: appData, homeDir: home })
    expect(Object.isFrozen(info)).toBe(true)
    const again = initAlphaEnvironment({ isPackaged: true, channel: "beta", appDataDir: appData, homeDir: home })
    expect(again).toBe(info)
    expect(getAlphaEnvironment().environment).toBe("prod")
  })

  test("运行期改 env 变量不改变已解析快照(环境解析只发生在启动)", () => {
    const info = initAlphaEnvironment({ isPackaged: true, channel: "prod", appDataDir: appData, homeDir: home })
    process.env.ALPHA_GLOBAL_DIR = "/tmp/spoofed"
    expect(getAlphaEnvironment().mutableRoot).toBe(info.mutableRoot)
  })

  test("REQ-098 #301:消费者(alphaGlobalRoot)读冻结快照,post-init env 漂移不改变其根", () => {
    const info = initAlphaEnvironment({ isPackaged: true, channel: "prod", appDataDir: appData, homeDir: home })
    const before = alphaGlobalRoot()
    expect(before).toBe(info.mutableRoot)
    // 模拟 shell env 后台刷新在冻结后覆盖 process.env —— 消费者必须仍用冻结根,而非漂移值。
    process.env.ALPHA_GLOBAL_DIR = "/tmp/drifted-after-freeze"
    expect(alphaGlobalRoot()).toBe(info.mutableRoot)
  })

  test("sidecar env 白名单透传 ALPHA_GLOBAL_DIR(引擎与 main 同根,路径非密钥)", () => {
    const env = createSidecarEnv({
      PATH: "/usr/bin",
      ALPHA_GLOBAL_DIR: "/tmp/env root",
      ALPHA_ENV_BASE_DIR: "/tmp/must-not-cross-sidecar",
    })
    expect(env.ALPHA_GLOBAL_DIR).toBe("/tmp/env root")
    expect(env.ALPHA_ENV_BASE_DIR).toBeUndefined()
  })

  test("grep 守卫:ALPHA_GLOBAL_DIR 赋值只允许在 alpha-environment.ts 与 index.ts(测试隔离入口)", () => {
    const mainDir = path.join(import.meta.dir)
    const allowed = new Set(["alpha-environment.ts", "index.ts"])
    const offenders: string[] = []
    for (const f of fs.readdirSync(mainDir)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue
      const src = fs.readFileSync(path.join(mainDir, f), "utf8")
      if (/\.ALPHA_GLOBAL_DIR\s*=[^=]/.test(src) && !allowed.has(f)) offenders.push(f)
    }
    expect(offenders).toEqual([])
  })

  test("grep 守卫:环境 IPC 只读 —— main 侧 handler 零参数,preload 侧 invoke 不带参数", () => {
    const ipcSrc = fs.readFileSync(path.join(import.meta.dir, "ipc.ts"), "utf8")
    expect(ipcSrc).toMatch(/ipcMain\.handle\("alpha-environment", \(\) => getAlphaEnvironment\(\)\)/)
    const preloadSrc = fs.readFileSync(path.join(import.meta.dir, "..", "preload", "index.ts"), "utf8")
    expect(preloadSrc).toMatch(/environment: \(\) => ipcRenderer\.invoke\("alpha-environment"\)/)
    // 不存在任何环境写面 IPC
    expect(ipcSrc).not.toMatch(/alpha-environment-set|set-alpha-environment/)
    expect(preloadSrc).not.toMatch(/alpha-environment-set|set-alpha-environment/)
  })
})
