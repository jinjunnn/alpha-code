// REQ-155 `#1244`:随包 Office 连接器的安装记录跟随运行中的实例(alpha-office-instance.ts)。
//
// 夹具照抄 owner 本机 2026-09-04 的地面真相:prod 根四条 committed 记录 + alpha.jsonc 指着
// `/Applications/alpha-code.app/...`(已不存在),dev 根空账本 + 171 字节无 `mcp` 键的 alpha.jsonc。
// 「当前 bundle」= 本仓 `resources/office-mcp/server.py` 的 realpath(bun 下 resourcesRoot() 的真值,
// 与 applyMcpWritePolicy 解析到的同一个文件 —— 不注入假路径,判的就是生产那条 canonical 化)。
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parse } from "jsonc-parser"
import { ALPHA_OFFICE_CONNECTORS, WORKSPACE_MARKER, alphaOfficeInstallCommand, type AlphaOfficeFormat } from "../shared/office-advisories"
import { siblingEnvironmentRoots } from "./alpha-environment"
import { reanchorOfficeCommand, reconcileAlphaOfficeInstalls } from "./alpha-office-instance"
import { readCapabilityGrant, writeCapabilityGrantSync } from "./ext-capability-grants"
import { collectInventory } from "./ext-inventory"
import { bundledOfficeServerDigest } from "./ext-mcp-policy"
import { readLedgerV2, upsertRecordV2 } from "./ext-receipt-v2"

const STALE_SERVER = "/Applications/alpha-code.app/Contents/Resources/office-mcp/server.py"
const CURRENT_SERVER = realpathSync(resolve(import.meta.dir, "../../resources/office-mcp/server.py"))
const DEV_CONFIG = `{
  "$schema": "https://opencode.ai/config.json",
  "skills": {
    "paths": [
      "/Users/example/Library/Application Support/alpha-code-state/env/dev/skills"
    ]
  }
}
`

const roots: string[] = []
const restoreModes: Array<() => void> = []
let prevGlobal: string | undefined

beforeEach(() => {
  prevGlobal = process.env.ALPHA_GLOBAL_DIR
})

afterEach(() => {
  restoreModes.splice(0).forEach((restore) => restore())
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
  if (prevGlobal === undefined) delete process.env.ALPHA_GLOBAL_DIR
  else process.env.ALPHA_GLOBAL_DIR = prevGlobal
})

function base() {
  const dir = mkdtempSync(join(tmpdir(), "alpha-office-instance-"))
  roots.push(dir)
  const envRoot = join(dir, "alpha-code-state", "env")
  const prod = join(envRoot, "prod")
  const beta = join(envRoot, "beta")
  const dev = join(envRoot, "dev")
  for (const root of [prod, beta, dev]) mkdirSync(root, { recursive: true })
  return { dir, prod, beta, dev }
}

function officeCommand(format: AlphaOfficeFormat, server: string, workspace: string = WORKSPACE_MARKER) {
  return alphaOfficeInstallCommand(format).map((argument) => {
    if (argument === "{alphaResources}/office-mcp/server.py") return server
    if (argument === WORKSPACE_MARKER) return workspace
    return argument
  })
}

function leaf(format: AlphaOfficeFormat, server: string, workspace?: string) {
  return { type: "local", command: officeCommand(format, server, workspace), timeout: 5000 }
}

/** 按生产写器写一条 committed catalog 记录(形状 = owner 本机 prod installs.json 的那四条)。 */
function installRecord(
  root: string,
  connector: (typeof ALPHA_OFFICE_CONNECTORS)[number],
  environment: "prod" | "beta" | "dev",
  overrides: Partial<{ desiredState: "enabled" | "disabled"; installedAt: string; updatedAt: string; txId: string }> = {},
) {
  const txId = overrides.txId ?? `tx-msx1-${connector.name}`
  const written = upsertRecordV2(root, {
    id: connector.catalogId,
    name: connector.name,
    kind: "mcp",
    environment,
    scope: { kind: "global" },
    version: "1.0.0",
    manifestDigest: `sha256:${"b9".repeat(32)}`,
    grantDigest: `sha256:${"ef".repeat(32)}`,
    desiredState: overrides.desiredState ?? "enabled",
    origin: "catalog",
    configKey: `mcp.${connector.name}`,
    transaction: { id: txId, state: "committed" },
    installedAt: overrides.installedAt ?? "2026-08-17T09:43:50.836Z",
    updatedAt: overrides.updatedAt ?? "2026-08-17T09:43:52.755Z",
  })
  if (!written.ok) throw new Error(written.reason)
  writeCapabilityGrantSync(root, {
    v: 1,
    key: `mcp--${connector.name}`,
    capabilities: ["engine:config", "process:spawn"],
    manifestDigest: `sha256:${"b9".repeat(32)}`,
    txId,
    grantedAt: "2026-08-17T09:43:50.970Z",
  })
  return written.record
}

function writeConfig(root: string, mcp: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  writeFileSync(join(root, "alpha.jsonc"), `// retained comment\n${JSON.stringify({ ...extra, mcp }, null, 2)}\n`)
}

function readConfig(root: string) {
  return parse(readFileSync(join(root, "alpha.jsonc"), "utf8")) as Record<string, unknown> & {
    mcp?: Record<string, { type: string; command: string[]; timeout?: number; enabled?: boolean }>
  }
}

function snapshot(root: string, files = ["installs.json", "alpha.jsonc"]) {
  return Object.fromEntries(
    files.map((file) => {
      try {
        return [file, readFileSync(join(root, file), "utf8")]
      } catch {
        return [file, null]
      }
    }),
  )
}

/** owner 本机的 prod 根:四条记录 + 指着已消失 bundle 的配置 + 授权账。 */
function seedProdLikeRoot(
  root: string,
  environment: "prod" | "beta" = "prod",
  server = STALE_SERVER,
  overrides: Record<string, Parameters<typeof installRecord>[3]> = {},
) {
  // desiredState 只能在**首写**给定:upsertRecordV2 对更新沿用 prev.desiredState(启停只走 set-state 通道),
  // 对同 txId 的重写按 exact-replay 原样返回 —— 这是生产写器的语义,夹具照它来。
  for (const connector of ALPHA_OFFICE_CONNECTORS) installRecord(root, connector, environment, overrides[connector.name])
  writeConfig(
    root,
    Object.fromEntries(ALPHA_OFFICE_CONNECTORS.map((connector) => [connector.name, leaf(connector.format, server)])),
    { skills: { paths: [join(root, "skills")] } },
  )
}

function seedEmptyDevRoot(root: string) {
  writeFileSync(join(root, "installs.json"), JSON.stringify({ v: 2, receipts: [], records: [] }))
  writeFileSync(join(root, "alpha.jsonc"), DEV_CONFIG)
}

function run(current: string, environment: "prod" | "beta" | "dev", siblings: Array<{ environment: "prod" | "beta" | "dev"; root: string }>, extra: Record<string, unknown> = {}) {
  const logged: string[] = []
  const outcome = reconcileAlphaOfficeInstalls({
    environment,
    currentRoot: current,
    siblings,
    configPath: join(current, "alpha.jsonc"),
    now: () => "2026-09-06T00:00:00.000Z",
    transactionId: (name) => `tx-office-adopt-test-${name}`,
    logError: (message) => logged.push(message),
    ...extra,
  })
  return { outcome, logged }
}

describe("siblingEnvironmentRoots", () => {
  test("yields the other two sibling roots in fixed prod → beta → dev order", () => {
    const roots = siblingEnvironmentRoots("dev", "/base")
    expect(roots).toEqual([
      { environment: "prod", root: join("/base", "env", "prod") },
      { environment: "beta", root: join("/base", "env", "beta") },
    ])
    expect(siblingEnvironmentRoots("prod", "/base").map((entry) => entry.environment)).toEqual(["beta", "dev"])
  })
})

describe("reanchorOfficeCommand", () => {
  test("rewrites only the server slot of an exact template whose server names another bundle", () => {
    for (const connector of ALPHA_OFFICE_CONNECTORS) {
      const stale = officeCommand(connector.format, STALE_SERVER)
      expect(reanchorOfficeCommand(connector.format, stale, CURRENT_SERVER)).toEqual(officeCommand(connector.format, CURRENT_SERVER))
      // 遗留具体 workspace 路径也放行 —— 只改 server 槽,workspace 槽留给 marker reconcile。
      const legacyWorkspace = officeCommand(connector.format, STALE_SERVER, "/Users/example/project")
      expect(reanchorOfficeCommand(connector.format, legacyWorkspace, CURRENT_SERVER)).toEqual(
        officeCommand(connector.format, CURRENT_SERVER, "/Users/example/project"),
      )
    }
  })

  test("leaves already-anchored, drifted, relative and non-server commands untouched", () => {
    const anchored = officeCommand("word", CURRENT_SERVER)
    expect(reanchorOfficeCommand("word", anchored, CURRENT_SERVER)).toBeNull()
    expect(reanchorOfficeCommand("word", [...officeCommand("word", STALE_SERVER), "--extra"], CURRENT_SERVER)).toBeNull()
    expect(reanchorOfficeCommand("word", officeCommand("word", "relative/office-mcp/server.py"), CURRENT_SERVER)).toBeNull()
    expect(reanchorOfficeCommand("word", officeCommand("word", "/somewhere/else/not-the-server.py"), CURRENT_SERVER)).toBeNull()
    expect(reanchorOfficeCommand("word", officeCommand("excel", STALE_SERVER), CURRENT_SERVER)).toBeNull()
    expect(reanchorOfficeCommand("word", officeCommand("word", STALE_SERVER, "relative/workspace"), CURRENT_SERVER)).toBeNull()
    expect(reanchorOfficeCommand("word", "not-an-array", CURRENT_SERVER)).toBeNull()
  })
})

describe("reconcileAlphaOfficeInstalls — adopt from a sibling channel root", () => {
  test("empty dev root adopts the four committed prod records and inventory shows them enabled", () => {
    const { prod, dev } = base()
    seedProdLikeRoot(prod)
    seedEmptyDevRoot(dev)
    const prodBefore = snapshot(prod, ["installs.json", "alpha.jsonc", "ext-store/mcp--alpha-word/grants.json"])
    const before = collectInventory({ catalog: null, globalRoot: dev })
    expect(before.rows).toEqual([])

    const { outcome } = run(dev, "dev", [{ environment: "prod", root: prod }])
    expect(outcome.warnings).toEqual([])
    expect(outcome.reanchored).toEqual([])
    expect(outcome.adopted).toEqual(ALPHA_OFFICE_CONNECTORS.map((connector) => connector.name))

    // inventory 对照(票面判据):四张卡 activation: enabled。
    const after = collectInventory({ catalog: null, globalRoot: dev })
    expect(after.warnings).toEqual([])
    // aggregateInventory 按 id 升序输出。
    expect(after.rows.map((row) => [row.id, row.scope, row.activation, row.origin])).toEqual(
      [...ALPHA_OFFICE_CONNECTORS]
        .sort((a, b) => (a.catalogId < b.catalogId ? -1 : 1))
        .map((connector) => [connector.catalogId, "global", "enabled", "catalog"]),
    )
    for (const row of after.rows) expect(row.granted?.capabilities).toEqual(["engine:config", "process:spawn"])

    // 配置叶子:当前 bundle 的 canonical server + {workspace} 标记 + 照抄的 timeout;其它键保留。
    const config = readConfig(dev)
    expect(config.$schema).toBe("https://opencode.ai/config.json")
    expect(config.skills).toEqual({ paths: ["/Users/example/Library/Application Support/alpha-code-state/env/dev/skills"] })
    for (const connector of ALPHA_OFFICE_CONNECTORS) {
      const entry = config.mcp![connector.name]!
      expect(entry.type).toBe("local")
      expect(entry.command).toEqual(officeCommand(connector.format, CURRENT_SERVER))
      expect(entry.timeout).toBe(5000)
      expect(entry.enabled).toBeUndefined()
    }

    // 账本:环境 = dev、fresh transaction、digest = 当前 bundle 内容地址、安装时间照抄、身份照抄。
    const ledger = readLedgerV2(dev)
    expect(ledger.warnings).toEqual([])
    expect(ledger.records).toHaveLength(4)
    for (const record of ledger.records) {
      expect(record.environment).toBe("dev")
      expect(record.generation).toBe(1)
      expect(record.transaction).toEqual({ id: `tx-office-adopt-test-${record.name}`, state: "committed" })
      expect(record.payloadDigest).toBe(bundledOfficeServerDigest(CURRENT_SERVER))
      expect(record.manifestDigest).toBe(`sha256:${"b9".repeat(32)}`)
      expect(record.grantDigest).toBe(`sha256:${"ef".repeat(32)}`)
      expect(record.installedAt).toBe("2026-08-17T09:43:50.836Z")
      expect(record.updatedAt).toBe("2026-09-06T00:00:00.000Z")
      expect(record.version).toBe("1.0.0")
      expect(record.configKey).toBe(`mcp.${record.name}`)
    }
    const grant = readCapabilityGrant(dev, "mcp--alpha-word")
    expect(grant?.txId).toBe("tx-office-adopt-test-alpha-word")
    expect(grant?.grantedAt).toBe("2026-09-06T00:00:00.000Z")

    // 兄弟根只读:逐字节不动。
    expect(snapshot(prod, ["installs.json", "alpha.jsonc", "ext-store/mcp--alpha-word/grants.json"])).toEqual(prodBefore)
  })

  test("a second run is a no-op (idempotent)", () => {
    const { prod, dev } = base()
    seedProdLikeRoot(prod)
    seedEmptyDevRoot(dev)
    run(dev, "dev", [{ environment: "prod", root: prod }])
    const afterFirst = snapshot(dev)
    const { outcome } = run(dev, "dev", [{ environment: "prod", root: prod }])
    expect(outcome).toEqual({ reanchored: [], adopted: [], warnings: [] })
    expect(snapshot(dev)).toEqual(afterFirst)
  })

  test("a disabled sibling record is adopted as disabled and projected as enabled:false", () => {
    const { prod, dev } = base()
    seedProdLikeRoot(prod, "prod", STALE_SERVER, { "alpha-word": { desiredState: "disabled" } })
    seedEmptyDevRoot(dev)
    const { outcome } = run(dev, "dev", [{ environment: "prod", root: prod }])
    expect(outcome.adopted).toHaveLength(4)
    expect(readConfig(dev).mcp!["alpha-word"]!.enabled).toBe(false)
    expect(readConfig(dev).mcp!["alpha-excel"]!.enabled).toBeUndefined()
    const rows = collectInventory({ catalog: null, globalRoot: dev }).rows
    expect(rows.find((row) => row.name === "alpha-word")?.activation).toBe("disabled")
    expect(rows.find((row) => row.name === "alpha-excel")?.activation).toBe("enabled")
  })

  test("a connector already recorded in the current root is never overwritten by a sibling", () => {
    const { prod, dev } = base()
    seedProdLikeRoot(prod)
    seedEmptyDevRoot(dev)
    const own = installRecord(dev, ALPHA_OFFICE_CONNECTORS[0], "dev", { txId: "tx-dev-own", desiredState: "disabled" })
    writeConfig(dev, { "alpha-word": { ...leaf("word", CURRENT_SERVER), enabled: false } })
    const { outcome } = run(dev, "dev", [{ environment: "prod", root: prod }])
    expect(outcome.adopted).toEqual(["alpha-excel", "alpha-powerpoint", "alpha-pdf"])
    const record = readLedgerV2(dev).records.find((entry) => entry.name === "alpha-word")
    expect(record).toEqual(own)
    expect(readConfig(dev).mcp!["alpha-word"]!.enabled).toBe(false)
  })

  test("a connector absent everywhere (uninstalled) stays absent", () => {
    const { prod, dev } = base()
    seedProdLikeRoot(prod)
    seedEmptyDevRoot(dev)
    // prod 里没有 alpha-pdf:用户卸载过。
    const prodLedger = JSON.parse(readFileSync(join(prod, "installs.json"), "utf8")) as { records: Array<{ name: string }>; receipts: Array<{ name: string }> }
    prodLedger.records = prodLedger.records.filter((record) => record.name !== "alpha-pdf")
    prodLedger.receipts = prodLedger.receipts.filter((receipt) => receipt.name !== "alpha-pdf")
    writeFileSync(join(prod, "installs.json"), JSON.stringify(prodLedger, null, 2))
    const { outcome } = run(dev, "dev", [{ environment: "prod", root: prod }])
    expect(outcome.adopted).toEqual(["alpha-word", "alpha-excel", "alpha-powerpoint"])
    expect(readConfig(dev).mcp!["alpha-pdf"]).toBeUndefined()
    expect(readLedgerV2(dev).records.map((record) => record.name)).not.toContain("alpha-pdf")
  })

  test("when two siblings hold the connector, the most recently updated record wins", () => {
    const { prod, beta, dev } = base()
    seedProdLikeRoot(prod, "prod")
    seedProdLikeRoot(beta, "beta", STALE_SERVER, { "alpha-word": { desiredState: "disabled", updatedAt: "2026-09-01T00:00:00.000Z" } })
    seedEmptyDevRoot(dev)
    const { outcome } = run(dev, "dev", [
      { environment: "prod", root: prod },
      { environment: "beta", root: beta },
    ])
    expect(outcome.adopted).toHaveLength(4)
    const rows = collectInventory({ catalog: null, globalRoot: dev }).rows
    expect(rows.find((row) => row.name === "alpha-word")?.activation).toBe("disabled")
    expect(rows.find((row) => row.name === "alpha-excel")?.activation).toBe("enabled")
  })

  test("a sibling leaf with a legacy concrete workspace path is adopted with the {workspace} marker", () => {
    const { prod, dev } = base()
    for (const connector of ALPHA_OFFICE_CONNECTORS) installRecord(prod, connector, "prod")
    writeConfig(
      prod,
      Object.fromEntries(ALPHA_OFFICE_CONNECTORS.map((connector) => [connector.name, leaf(connector.format, STALE_SERVER, "/Users/example/project")])),
    )
    seedEmptyDevRoot(dev)
    const { outcome } = run(dev, "dev", [{ environment: "prod", root: prod }])
    expect(outcome.warnings).toEqual([])
    expect(outcome.adopted).toHaveLength(4)
    for (const connector of ALPHA_OFFICE_CONNECTORS)
      expect(readConfig(dev).mcp![connector.name]!.command).toEqual(officeCommand(connector.format, CURRENT_SERVER))
  })

  test("a sibling leaf that drifted from the pinned template is refused with no half-state", () => {
    const { prod, dev } = base()
    seedProdLikeRoot(prod)
    const config = readConfig(prod)
    config.mcp!["alpha-word"]!.command = [...config.mcp!["alpha-word"]!.command, "--extra"]
    config.mcp!["alpha-excel"] = { type: "local", command: ["uv", "run", "--no-project", "--with", "openpyxl==9.9.9", STALE_SERVER, "excel", WORKSPACE_MARKER] }
    writeFileSync(join(prod, "alpha.jsonc"), JSON.stringify(config, null, 2))
    seedEmptyDevRoot(dev)
    const { outcome } = run(dev, "dev", [{ environment: "prod", root: prod }])
    expect(outcome.adopted).toEqual(["alpha-powerpoint", "alpha-pdf"])
    expect(outcome.warnings).toHaveLength(2)
    expect(outcome.warnings[0]).toContain("alpha-word")
    expect(outcome.warnings[0]).toContain("REQ-133")
    expect(outcome.warnings[1]).toContain("alpha-excel")
    expect(readConfig(dev).mcp!["alpha-word"]).toBeUndefined()
    expect(readConfig(dev).mcp!["alpha-excel"]).toBeUndefined()
    expect(readLedgerV2(dev).records.map((record) => record.name)).toEqual(["alpha-powerpoint", "alpha-pdf"])
  })

  test("a sibling record without a config leaf, or a non-committed one, is not adopted", () => {
    const { prod, dev } = base()
    for (const connector of ALPHA_OFFICE_CONNECTORS) installRecord(prod, connector, "prod")
    writeConfig(prod, { "alpha-word": leaf("word", STALE_SERVER) })
    const ledger = JSON.parse(readFileSync(join(prod, "installs.json"), "utf8")) as { records: Array<{ name: string; transaction: { state: string } }> }
    ledger.records.find((record) => record.name === "alpha-word")!.transaction.state = "pending"
    writeFileSync(join(prod, "installs.json"), JSON.stringify(ledger, null, 2))
    seedEmptyDevRoot(dev)
    const { outcome } = run(dev, "dev", [{ environment: "prod", root: prod }])
    expect(outcome.adopted).toEqual([])
    expect(outcome.warnings.filter((warning) => warning.includes("no local config leaf"))).toHaveLength(3)
    expect(readLedgerV2(dev).records).toEqual([])
    expect(readConfig(dev).mcp).toBeUndefined()
  })

  test("does nothing when the bundled server cannot be resolved in this instance", () => {
    const { prod, dev } = base()
    seedProdLikeRoot(prod)
    seedEmptyDevRoot(dev)
    const before = snapshot(dev)
    const { outcome } = run(dev, "dev", [{ environment: "prod", root: prod }], { alphaOfficeServerPath: null })
    expect(outcome.adopted).toEqual([])
    expect(outcome.warnings).toHaveLength(1)
    expect(outcome.warnings[0]).toContain("fail-closed")
    expect(snapshot(dev)).toEqual(before)
  })

  test("a corrupt current ledger is neither written nor quarantined; a corrupt sibling ledger is skipped read-only", () => {
    const { prod, beta, dev } = base()
    seedProdLikeRoot(prod)
    writeFileSync(join(beta, "installs.json"), "{ not json")
    writeConfig(beta, { "alpha-word": leaf("word", STALE_SERVER) })
    writeFileSync(join(dev, "installs.json"), "{ not json either")
    writeFileSync(join(dev, "alpha.jsonc"), DEV_CONFIG)
    const devBefore = snapshot(dev)
    const betaBefore = snapshot(beta)
    const { outcome } = run(dev, "dev", [
      { environment: "prod", root: prod },
      { environment: "beta", root: beta },
    ])
    expect(outcome.adopted).toEqual([])
    expect(outcome.warnings.some((warning) => warning.includes("current ledger not writable"))).toBe(true)
    expect(snapshot(dev)).toEqual(devBefore)
    expect(snapshot(beta)).toEqual(betaBefore)
    expect(readFileSync(join(dev, "installs.json"), "utf8")).toBe("{ not json either")
  })

  test("a failed config leaf write rolls the adopted record back", () => {
    const { prod, dev } = base()
    seedProdLikeRoot(prod)
    seedEmptyDevRoot(dev)
    const lockedDir = join(dev, "locked")
    mkdirSync(lockedDir)
    writeFileSync(join(lockedDir, "alpha.jsonc"), DEV_CONFIG)
    chmodSync(lockedDir, 0o555)
    restoreModes.push(() => chmodSync(lockedDir, 0o755))
    const { outcome } = run(dev, "dev", [{ environment: "prod", root: prod }], { configPath: join(lockedDir, "alpha.jsonc") })
    expect(outcome.adopted).toEqual([])
    expect(outcome.warnings).toHaveLength(4)
    for (const warning of outcome.warnings) expect(warning).toContain("record rolled back")
    expect(readLedgerV2(dev).records).toEqual([])
    expect(readFileSync(join(lockedDir, "alpha.jsonc"), "utf8")).toBe(DEV_CONFIG)
  })
})

describe("reconcileAlphaOfficeInstalls — re-anchor a stale bundle path in the current root", () => {
  test("rewrites the four stale server slots to the current bundle and leaves everything else byte-for-byte", () => {
    const { prod, dev } = base()
    seedProdLikeRoot(prod)
    const custom = { type: "local", command: ["node", "/Users/example/custom/server.js", "/Applications/alpha-code.app/Contents/Resources/office-mcp/server.py"] }
    const filesystem = { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-filesystem@2026.1.14", "/Users/example/project"] }
    const config = readConfig(prod)
    config.mcp!.custom = custom as never
    config.mcp!.filesystem = filesystem as never
    writeFileSync(join(prod, "alpha.jsonc"), `// retained comment\n${JSON.stringify(config, null, 2)}\n`)
    const ledgerBefore = readFileSync(join(prod, "installs.json"), "utf8")

    const { outcome } = run(prod, "prod", [{ environment: "dev", root: dev }])
    expect(outcome.warnings).toEqual([])
    expect(outcome.adopted).toEqual([])
    expect(outcome.reanchored).toEqual(ALPHA_OFFICE_CONNECTORS.map((connector) => connector.name))

    const after = readConfig(prod)
    for (const connector of ALPHA_OFFICE_CONNECTORS) {
      expect(after.mcp![connector.name]!.command).toEqual(officeCommand(connector.format, CURRENT_SERVER))
      expect(after.mcp![connector.name]!.timeout).toBe(5000)
    }
    expect(after.mcp!.custom).toEqual(custom as never)
    expect(after.mcp!.filesystem).toEqual(filesystem as never)
    expect(readFileSync(join(prod, "alpha.jsonc"), "utf8").startsWith("// retained comment\n")).toBe(true)
    expect(readFileSync(join(prod, "installs.json"), "utf8")).toBe(ledgerBefore)
    expect(collectInventory({ catalog: null, globalRoot: prod }).rows.map((row) => row.activation)).toEqual(["enabled", "enabled", "enabled", "enabled"])

    const again = run(prod, "prod", [{ environment: "dev", root: dev }])
    expect(again.outcome).toEqual({ reanchored: [], adopted: [], warnings: [] })
  })

  test("a leaf without a record in the current root is not re-anchored (ownership is the ledger's)", () => {
    const { prod, dev } = base()
    seedEmptyDevRoot(dev)
    writeConfig(dev, { "alpha-word": leaf("word", STALE_SERVER) })
    const before = snapshot(dev)
    const { outcome } = run(dev, "dev", [{ environment: "prod", root: prod }])
    expect(outcome.reanchored).toEqual([])
    expect(outcome.adopted).toEqual([])
    expect(snapshot(dev)).toEqual(before)
  })
})

describe("boot wiring", () => {
  // 分类与「这处锚守不住什么」登记在 ./source-text-anchors.ts(`#968` 第 ⑤ 层机械校验)。
  test("ANCHOR (not a gate): main runs the Office instance reconcile before the timeout/marker reconciles and the first sidecar fork", () => {
    const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8")
    const officeReconcile = source.indexOf("  reconcileAlphaOfficeInstalls()")
    const timeoutReconcile = source.indexOf("  ensureGovernedMcpConnectTimeouts()")
    const markerReconcile = source.indexOf("  reconcileMcpWorkspaceMarkers()")
    const firstFork = source.indexOf("spawnLocalServer(hostname, port, password")

    expect(officeReconcile).toBeGreaterThan(-1)
    expect(timeoutReconcile).toBeGreaterThan(officeReconcile)
    expect(markerReconcile).toBeGreaterThan(timeoutReconcile)
    expect(firstFork).toBeGreaterThan(markerReconcile)
  })
})
