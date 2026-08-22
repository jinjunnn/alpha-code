import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse } from "jsonc-parser"
import type { InstallReceipt } from "../preload/types"
import { addReceipt } from "./alpha-installs"
import { retireCommunityExcelAfterRecovery } from "./community-excel-retirement"
import { tryAcquireBundleLock } from "./ext-bundle-lock"
import { bundleOwner, computeInstalledGraphDigest, LEGACY_PROTECTED_OWNER } from "./ext-package-ledger-v3"
import {
  applyPackageMutation,
  findRecordV2,
  packageClaimOwners,
  readLedgerV2,
  readPackageGraphs,
  readPackageLedgerStateV1,
  upsertRecordV2,
} from "./ext-receipt-v2"

// `#773`:两个只读器不再用空值冒充「没有」—— 读不出来是 `ok:false`。测试要的是值,
// 所以这里当场炸而不是静默降级;想断言失败本身的用例直接调原函数。
const graphsOf = (r: string) => {
  const read = readPackageGraphs(r)
  if (!read.ok) throw new Error(read.reason)
  return read.packageGraphs
}
const claimOwnersOf = (r: string, kind: string, name: string) => {
  const read = packageClaimOwners(r, kind, name)
  if (!read.ok) throw new Error(read.reason)
  return read.owners
}

let base = ""
let root = ""
let opencodeHome = ""
let xdgConfig = ""
const previousRoot = process.env.ALPHA_GLOBAL_DIR
const previousOpencodeHome = process.env.ALPHA_OPENCODE_HOME
const previousXdg = process.env.OPENCODE_CONFIG_DIR
const previousTruthDisable = process.env.ALPHA_JSONC_TRUTH_DISABLE
const previousLegacyRoot = process.env.ALPHA_LEGACY_INSTALL_ROOT
const installedAt = "2026-08-17T00:00:00.000Z"

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "alpha-community-excel-retirement-"))
  root = join(base, "alpha-state")
  opencodeHome = join(base, "opencode-home")
  xdgConfig = join(base, "xdg-opencode")
  mkdirSync(root, { recursive: true })
  mkdirSync(opencodeHome, { recursive: true })
  mkdirSync(xdgConfig, { recursive: true })
  process.env.ALPHA_GLOBAL_DIR = root
  process.env.ALPHA_OPENCODE_HOME = opencodeHome
  process.env.OPENCODE_CONFIG_DIR = xdgConfig
  delete process.env.ALPHA_JSONC_TRUTH_DISABLE
  delete process.env.ALPHA_LEGACY_INSTALL_ROOT
})

afterEach(() => {
  if (previousRoot === undefined) delete process.env.ALPHA_GLOBAL_DIR
  else process.env.ALPHA_GLOBAL_DIR = previousRoot
  if (previousOpencodeHome === undefined) delete process.env.ALPHA_OPENCODE_HOME
  else process.env.ALPHA_OPENCODE_HOME = previousOpencodeHome
  if (previousXdg === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = previousXdg
  if (previousTruthDisable === undefined) delete process.env.ALPHA_JSONC_TRUTH_DISABLE
  else process.env.ALPHA_JSONC_TRUTH_DISABLE = previousTruthDisable
  if (previousLegacyRoot === undefined) delete process.env.ALPHA_LEGACY_INSTALL_ROOT
  else process.env.ALPHA_LEGACY_INSTALL_ROOT = previousLegacyRoot
  rmSync(base, { recursive: true, force: true })
})

const configPath = () => join(root, "alpha.jsonc")
const homeConfigPath = () => join(opencodeHome, "opencode.jsonc")
const xdgConfigPath = () => join(xdgConfig, "opencode.jsonc")
const ledgerPath = () => join(root, "installs.json")
const receipt = (name: string, id = `mcp:${name}`): InstallReceipt => ({
  id,
  name,
  type: "mcp",
  scope: "global",
  installedAt,
  origin: "catalog",
  configKey: `mcp.${name}`,
})
const record = (name: string, id = `mcp:${name}`) => ({
  id,
  name,
  kind: "mcp" as const,
  environment: "dev" as const,
  scope: { kind: "global" as const },
  desiredState: "enabled" as const,
  origin: "catalog" as const,
  installedAt,
  configKey: `mcp.${name}`,
})

function writeConfig(text: string): void {
  writeFileSync(configPath(), text)
}

describe("retireCommunityExcelAfterRecovery", () => {
  test("removes the exact JSONC leaf and both v2 receipt views while preserving siblings", async () => {
    writeConfig(`{
  // user-owned sibling must survive
  "mcp": {
    "excel-mcp-server": { "type": "local", "command": ["uvx", "excel-mcp-server@0.1.8", "stdio"] },
    "markitdown": { "type": "local", "command": ["uvx", "markitdown-mcp"] }
  },
  "provider": { "custom": { "name": "Custom" } }
}\n`)
    expect(upsertRecordV2(root, record("excel-mcp-server", "mcp:excel")).ok).toBe(true)
    expect(upsertRecordV2(root, record("markitdown")).ok).toBe(true)

    expect(await retireCommunityExcelAfterRecovery(Promise.resolve())).toEqual({
      ok: true,
      configRemoved: true,
      receiptRemoved: true,
    })

    const text = readFileSync(configPath(), "utf8")
    const config = parse(text) as Record<string, Record<string, unknown>>
    expect(text).toContain("user-owned sibling must survive")
    expect(config.mcp["excel-mcp-server"]).toBeUndefined()
    expect(config.mcp.markitdown).toEqual({ type: "local", command: ["uvx", "markitdown-mcp"] })
    expect(config.provider.custom).toEqual({ name: "Custom" })
    const ledger = readLedgerV2(root, { sideEffectFree: true })
    expect(ledger.records.map((entry) => entry.name)).toEqual(["markitdown"])
    expect(ledger.v1Only).toHaveLength(0)
    const raw = JSON.parse(readFileSync(ledgerPath(), "utf8")) as { receipts: InstallReceipt[] }
    expect(raw.receipts.map((entry) => entry.name)).toEqual(["markitdown"])
  })

  test("removes a v1-only global receipt", async () => {
    writeConfig('{ "mcp": { "excel-mcp-server": { "type": "local" } } }\n')
    expect(addReceipt(root, receipt("excel-mcp-server", "mcp:excel")).ok).toBe(true)

    expect(await retireCommunityExcelAfterRecovery(Promise.resolve())).toEqual({
      ok: true,
      configRemoved: true,
      receiptRemoved: true,
    })
    expect(readLedgerV2(root, { sideEffectFree: true }).v1Only).toHaveLength(0)
  })

  test("missing alpha.jsonc removes the receipt without creating a config file", async () => {
    expect(upsertRecordV2(root, record("excel-mcp-server", "mcp:excel")).ok).toBe(true)

    expect(await retireCommunityExcelAfterRecovery(Promise.resolve())).toEqual({
      ok: true,
      configRemoved: false,
      receiptRemoved: true,
    })
    expect(existsSync(configPath())).toBe(false)
    expect(readLedgerV2(root, { sideEffectFree: true }).records).toHaveLength(0)
  })

  test("waits for startup transaction recovery before touching config or receipt", async () => {
    writeConfig('{ "mcp": { "excel-mcp-server": { "type": "local" } } }\n')
    expect(upsertRecordV2(root, record("excel-mcp-server", "mcp:excel")).ok).toBe(true)
    let finishRecovery: (() => void) | undefined
    const recoveryReady = new Promise<void>((resolve) => {
      finishRecovery = resolve
    })

    const retirement = retireCommunityExcelAfterRecovery(recoveryReady)
    await Promise.resolve()
    expect(readFileSync(configPath(), "utf8")).toContain("excel-mcp-server")
    expect(findRecordV2(root, "mcp", "excel-mcp-server")).not.toBeNull()

    finishRecovery?.()
    expect(await retirement).toEqual({ ok: true, configRemoved: true, receiptRemoved: true })
  })

  test("refuses retirement while the global extension lock is held", async () => {
    writeConfig('{ "mcp": { "excel-mcp-server": { "type": "local" } } }\n')
    expect(upsertRecordV2(root, record("excel-mcp-server", "mcp:excel")).ok).toBe(true)
    const acquired = tryAcquireBundleLock(root, { txId: "tx-live-owner" })
    expect(acquired.ok).toBe(true)
    if (!acquired.ok) return

    const result = await retireCommunityExcelAfterRecovery(Promise.resolve())

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("extension transaction lock unavailable")
    expect(readFileSync(configPath(), "utf8")).toContain("excel-mcp-server")
    expect(findRecordV2(root, "mcp", "excel-mcp-server")).not.toBeNull()
    acquired.lock.release()
  })

  test("refuses retirement when recovery leaves a non-terminal journal", async () => {
    writeConfig('{ "mcp": { "excel-mcp-server": { "type": "local" } } }\n')
    expect(upsertRecordV2(root, record("excel-mcp-server", "mcp:excel")).ok).toBe(true)
    mkdirSync(join(root, "ext-tx", "journal"), { recursive: true })
    writeFileSync(join(root, "ext-tx", "journal", "tx-open.json"), "{}\n")

    const result = await retireCommunityExcelAfterRecovery(Promise.resolve())

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("non-terminal extension transaction")
    expect(readFileSync(configPath(), "utf8")).toContain("excel-mcp-server")
    expect(findRecordV2(root, "mcp", "excel-mcp-server")).not.toBeNull()
  })

  test("a second run is byte-identical and reports that nothing remained to remove", async () => {
    writeConfig('{ "mcp": { "excel-mcp-server": { "type": "local" }, "keep": { "type": "remote" } } }\n')
    expect(upsertRecordV2(root, record("excel-mcp-server", "mcp:excel")).ok).toBe(true)
    expect((await retireCommunityExcelAfterRecovery(Promise.resolve())).ok).toBe(true)
    const configAfterFirst = readFileSync(configPath(), "utf8")
    const ledgerAfterFirst = readFileSync(ledgerPath(), "utf8")

    expect(await retireCommunityExcelAfterRecovery(Promise.resolve())).toEqual({
      ok: true,
      configRemoved: false,
      receiptRemoved: false,
    })
    expect(readFileSync(configPath(), "utf8")).toBe(configAfterFirst)
    expect(readFileSync(ledgerPath(), "utf8")).toBe(ledgerAfterFirst)
  })

  test("malformed alpha.jsonc is retained with its receipt and returns an explicit failure", async () => {
    const malformed = '{ "mcp": { "excel-mcp-server":'
    writeConfig(malformed)
    expect(upsertRecordV2(root, record("excel-mcp-server", "mcp:excel")).ok).toBe(true)

    const result = await retireCommunityExcelAfterRecovery(Promise.resolve())

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("config unparsable (fail closed)")
    expect(readFileSync(configPath(), "utf8")).toBe(malformed)
    expect(readLedgerV2(root, { sideEffectFree: true }).records.map((entry) => entry.name)).toEqual([
      "excel-mcp-server",
    ])
  })

  test("receipt teardown failure is explicit after the config leaf has been made unreachable", async () => {
    writeConfig('{ "mcp": { "excel-mcp-server": { "type": "local" }, "keep": { "type": "remote" } } }\n')
    const futureLedger = JSON.stringify({
      v: 999,
      receipts: [receipt("excel-mcp-server", "mcp:excel")],
      records: [],
    })
    writeFileSync(ledgerPath(), futureLedger)

    const result = await retireCommunityExcelAfterRecovery(Promise.resolve())

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("global receipt teardown failed")
    const config = parse(readFileSync(configPath(), "utf8")) as Record<string, Record<string, unknown>>
    expect(config.mcp["excel-mcp-server"]).toBeUndefined()
    expect(config.mcp.keep).toEqual({ type: "remote" })
    expect(readFileSync(ledgerPath(), "utf8")).toBe(futureLedger)
  })

  test("production V3 package graph is narrowed atomically while unrelated records and claims survive", async () => {
    writeConfig(`{
  "mcp": {
    "excel-mcp-server": { "type": "local" },
    "keep-mcp": { "type": "local", "command": ["uvx", "keep-mcp"] }
  }
}\n`)
    const rootDigest = `sha256:${"a".repeat(64)}`
    const excelDigest = `sha256:${"b".repeat(64)}`
    const keepDigest = `sha256:${"c".repeat(64)}`
    const graphCore = {
      packageId: "bundle:office",
      envelopeDigest: `sha256:${"d".repeat(64)}`,
      root: {
        componentId: "agent:office-root",
        kind: "agent" as const,
        name: "office-root",
        required: true,
        manifestDigest: rootDigest,
      },
      children: [
        {
          componentId: "mcp:excel",
          kind: "mcp" as const,
          name: "excel-mcp-server",
          required: true,
          manifestDigest: excelDigest,
        },
        {
          componentId: "mcp:keep",
          kind: "mcp" as const,
          name: "keep-mcp",
          required: false,
          manifestDigest: keepDigest,
        },
      ],
    }
    const graph = { ...graphCore, installedGraphDigest: computeInstalledGraphDigest(graphCore) }
    const owner = bundleOwner(graph.packageId, graph.root.manifestDigest)
    const applied = applyPackageMutation(root, {
      transactionId: "tx-office-production",
      operation: "install",
      graphBeforeDigest: null,
      graphAfter: graph,
      childRecordMutations: [
        {
          op: "upsert",
          input: {
            ...record("office-root", "agent:office-root"),
            kind: "agent",
            manifestDigest: rootDigest,
            configKey: undefined,
          },
        },
        { op: "upsert", input: { ...record("excel-mcp-server", "mcp:excel"), manifestDigest: excelDigest } },
        { op: "upsert", input: { ...record("keep-mcp", "mcp:keep"), manifestDigest: keepDigest } },
      ],
      claimMutations: [
        { op: "acquire", kind: "agent", name: "office-root", owner },
        { op: "acquire", kind: "mcp", name: "excel-mcp-server", owner },
        { op: "acquire", kind: "mcp", name: "keep-mcp", owner },
      ],
    })
    expect(applied.ok).toBe(true)

    expect(await retireCommunityExcelAfterRecovery(Promise.resolve())).toEqual({
      ok: true,
      configRemoved: true,
      receiptRemoved: true,
    })

    expect(findRecordV2(root, "mcp", "excel-mcp-server")).toBeNull()
    expect(findRecordV2(root, "agent", "office-root")).toBeDefined()
    expect(findRecordV2(root, "mcp", "keep-mcp")).toBeDefined()
    expect(claimOwnersOf(root, "mcp", "excel-mcp-server")).toEqual([])
    expect(claimOwnersOf(root, "agent", "office-root")).toEqual([owner])
    expect(claimOwnersOf(root, "mcp", "keep-mcp")).toEqual([owner])
    const graphs = graphsOf(root)
    expect(graphs).toHaveLength(1)
    expect(graphs[0].children.map((child) => child.name)).toEqual(["keep-mcp"])
    expect(computeInstalledGraphDigest(graphs[0])).toBe(graphs[0].installedGraphDigest)
    expect(readPackageLedgerStateV1(root, { sideEffectFree: true }).ok).toBe(true)
    const config = parse(readFileSync(configPath(), "utf8")) as Record<string, Record<string, unknown>>
    expect(config.mcp["excel-mcp-server"]).toBeUndefined()
    expect(config.mcp["keep-mcp"]).toEqual({ type: "local", command: ["uvx", "keep-mcp"] })
  })

  test("removes the live leaf from a retained ~/.opencode copy without creating alpha.jsonc", async () => {
    writeFileSync(
      homeConfigPath(),
      '{ "mcp": { "excel-mcp-server": { "type": "local" }, "keep": { "type": "remote" } } }\n',
    )
    expect(upsertRecordV2(root, record("excel-mcp-server", "mcp:excel")).ok).toBe(true)

    expect(await retireCommunityExcelAfterRecovery(Promise.resolve())).toEqual({
      ok: true,
      configRemoved: true,
      receiptRemoved: true,
    })

    expect(existsSync(configPath())).toBe(false)
    const home = parse(readFileSync(homeConfigPath(), "utf8")) as Record<string, Record<string, unknown>>
    expect(home.mcp["excel-mcp-server"]).toBeUndefined()
    expect(home.mcp.keep).toEqual({ type: "remote" })
  })

  test("removes the same leaf from both the live alpha.jsonc and a retained home copy", async () => {
    writeConfig('{ "mcp": { "excel-mcp-server": { "type": "local" }, "alpha-keep": { "type": "remote" } } }\n')
    writeFileSync(
      homeConfigPath(),
      '{ "mcp": { "excel-mcp-server": { "type": "local" }, "home-keep": { "type": "remote" } } }\n',
    )
    expect(upsertRecordV2(root, record("excel-mcp-server", "mcp:excel")).ok).toBe(true)

    expect(await retireCommunityExcelAfterRecovery(Promise.resolve())).toEqual({
      ok: true,
      configRemoved: true,
      receiptRemoved: true,
    })

    const live = parse(readFileSync(configPath(), "utf8")) as Record<string, Record<string, unknown>>
    const home = parse(readFileSync(homeConfigPath(), "utf8")) as Record<string, Record<string, unknown>>
    expect(live.mcp["excel-mcp-server"]).toBeUndefined()
    expect(live.mcp["alpha-keep"]).toEqual({ type: "remote" })
    expect(home.mcp["excel-mcp-server"]).toBeUndefined()
    expect(home.mcp["home-keep"]).toEqual({ type: "remote" })
  })

  test("ALPHA_JSONC_TRUTH_DISABLE tears down the home file the escape hatch actually consumes", async () => {
    process.env.ALPHA_JSONC_TRUTH_DISABLE = "1"
    writeFileSync(homeConfigPath(), '{ "mcp": { "excel-mcp-server": { "type": "local" } } }\n')
    expect(upsertRecordV2(root, record("excel-mcp-server", "mcp:excel")).ok).toBe(true)

    expect(await retireCommunityExcelAfterRecovery(Promise.resolve())).toEqual({
      ok: true,
      configRemoved: true,
      receiptRemoved: true,
    })
    expect(existsSync(configPath())).toBe(false)
    expect(parse(readFileSync(homeConfigPath(), "utf8")).mcp?.["excel-mcp-server"]).toBeUndefined()
  })

  test("an unparseable retained home copy fails closed and does not report success", async () => {
    writeConfig('{ "mcp": { "excel-mcp-server": { "type": "local" } } }\n')
    writeFileSync(homeConfigPath(), '{ "mcp": { "excel-mcp-server":')
    expect(upsertRecordV2(root, record("excel-mcp-server", "mcp:excel")).ok).toBe(true)

    const result = await retireCommunityExcelAfterRecovery(Promise.resolve())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("config unparsable (fail closed)")
    expect(readFileSync(homeConfigPath(), "utf8")).toBe('{ "mcp": { "excel-mcp-server":')
  })

  test("a package graph rooted at the retired connector is dropped and sibling claims stay owned", async () => {
    writeConfig('{ "mcp": { "excel-mcp-server": { "type": "local" }, "keep-mcp": { "type": "local" } } }\n')
    const excelDigest = `sha256:${"9".repeat(64)}`
    const keepDigest = `sha256:${"8".repeat(64)}`
    const graphCore = {
      packageId: "package:excel-root",
      envelopeDigest: `sha256:${"7".repeat(64)}`,
      root: {
        componentId: "mcp:excel",
        kind: "mcp" as const,
        name: "excel-mcp-server",
        required: true,
        manifestDigest: excelDigest,
      },
      children: [
        {
          componentId: "mcp:keep",
          kind: "mcp" as const,
          name: "keep-mcp",
          required: false,
          manifestDigest: keepDigest,
        },
      ],
    }
    const graph = { ...graphCore, installedGraphDigest: computeInstalledGraphDigest(graphCore) }
    const owner = bundleOwner(graph.packageId, graph.root.manifestDigest)
    const applied = applyPackageMutation(root, {
      transactionId: "tx-excel-rooted",
      operation: "install",
      graphBeforeDigest: null,
      graphAfter: graph,
      childRecordMutations: [
        { op: "upsert", input: { ...record("excel-mcp-server", "mcp:excel"), manifestDigest: excelDigest } },
        { op: "upsert", input: { ...record("keep-mcp", "mcp:keep"), manifestDigest: keepDigest } },
      ],
      claimMutations: [
        { op: "acquire", kind: "mcp", name: "excel-mcp-server", owner },
        { op: "acquire", kind: "mcp", name: "keep-mcp", owner },
      ],
    })
    expect(applied.ok).toBe(true)

    expect(await retireCommunityExcelAfterRecovery(Promise.resolve())).toEqual({
      ok: true,
      configRemoved: true,
      receiptRemoved: true,
    })

    expect(findRecordV2(root, "mcp", "excel-mcp-server")).toBeNull()
    expect(findRecordV2(root, "mcp", "keep-mcp")).toBeDefined()
    expect(claimOwnersOf(root, "mcp", "keep-mcp")).toEqual([LEGACY_PROTECTED_OWNER])
    expect(graphsOf(root)).toEqual([])
    expect(readPackageLedgerStateV1(root, { sideEffectFree: true }).ok).toBe(true)
  })
})
