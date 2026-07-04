// Unit tests for the install receipts ledger (REQ-018 T1). The module is electron-free and
// root-parameterized, so we exercise REAL writes against temp dirs: round-trip, upsert semantics,
// removal, corrupt-file quarantine (loud self-heal, never silent clobber) and input validation.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  addReceipt,
  findReceipt,
  readLedger,
  removeReceipt,
  validateReceipt,
} from "./alpha-installs"
import type { InstallReceipt } from "../preload/types"

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-installs-"))
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function receipt(overrides: Partial<InstallReceipt> = {}): InstallReceipt {
  return {
    id: "mcp:markitdown",
    name: "markitdown",
    type: "mcp",
    scope: "global",
    version: "0.0.1a4",
    installedAt: new Date("2026-07-04T10:00:00Z").toISOString(),
    origin: "catalog",
    configKey: "mcp.markitdown",
    ...overrides,
  }
}

const ledgerFile = () => path.join(root, "installs.json")

describe("readLedger", () => {
  test("missing file → empty, no warning", () => {
    const read = readLedger(root)
    expect(read.receipts).toEqual([])
    expect(read.warning).toBeUndefined()
  })

  test("corrupt file → empty + warning, file untouched", () => {
    fs.writeFileSync(ledgerFile(), "{ not json", "utf8")
    const read = readLedger(root)
    expect(read.receipts).toEqual([])
    expect(read.warning).toContain("unreadable")
    expect(fs.readFileSync(ledgerFile(), "utf8")).toBe("{ not json")
  })

  test("invalid entries are dropped with a warning, valid ones survive", () => {
    const good = receipt()
    fs.writeFileSync(
      ledgerFile(),
      JSON.stringify({ v: 1, receipts: [good, { id: "junk" }, { ...good, name: "../evil" }] }),
      "utf8",
    )
    const read = readLedger(root)
    expect(read.receipts).toEqual([good])
    expect(read.warning).toContain("2 invalid receipt(s)")
  })
})

describe("addReceipt / findReceipt", () => {
  test("add creates the ledger and round-trips fields", () => {
    const r = receipt()
    const result = addReceipt(root, r)
    expect(result.ok).toBe(true)
    expect(findReceipt(root, "mcp", "markitdown")).toEqual(r)
    const parsed = JSON.parse(fs.readFileSync(ledgerFile(), "utf8"))
    expect(parsed.v).toBe(1)
    expect(parsed.receipts).toHaveLength(1)
  })

  test("upsert by (type, name): reinstall replaces, other entries survive", () => {
    expect(addReceipt(root, receipt()).ok).toBe(true)
    expect(addReceipt(root, receipt({ id: "skill:safe-refactor", name: "safe-refactor", type: "skill", configKey: undefined, files: [path.join(root, "skills", "safe-refactor")] })).ok).toBe(true)
    expect(addReceipt(root, receipt({ version: "0.0.2" })).ok).toBe(true)
    const { receipts } = readLedger(root)
    expect(receipts).toHaveLength(2)
    expect(findReceipt(root, "mcp", "markitdown")?.version).toBe("0.0.2")
    expect(findReceipt(root, "skill", "safe-refactor")).not.toBeNull()
  })

  test("same name under different types are distinct entries", () => {
    expect(addReceipt(root, receipt()).ok).toBe(true)
    expect(addReceipt(root, receipt({ id: "skill:markitdown", type: "skill", configKey: undefined })).ok).toBe(true)
    expect(readLedger(root).receipts).toHaveLength(2)
  })

  test("corrupt ledger is quarantined (not clobbered) before the write", () => {
    fs.writeFileSync(ledgerFile(), "{ not json", "utf8")
    const result = addReceipt(root, receipt())
    expect(result.ok).toBe(true)
    expect(result.warning).toContain("quarantined")
    const quarantined = fs.readdirSync(root).filter((f) => f.startsWith("installs.json.corrupt-"))
    expect(quarantined).toHaveLength(1)
    expect(fs.readFileSync(path.join(root, quarantined[0]!), "utf8")).toBe("{ not json")
    expect(readLedger(root).receipts).toHaveLength(1)
  })
})

describe("removeReceipt", () => {
  test("remove returns the receipt and updates the file", () => {
    addReceipt(root, receipt())
    const result = removeReceipt(root, "mcp", "markitdown")
    expect(result.ok).toBe(true)
    expect(result.ok && result.removed?.id).toBe("mcp:markitdown")
    expect(readLedger(root).receipts).toEqual([])
  })

  test("removing a missing entry is a no-op success with removed:null", () => {
    addReceipt(root, receipt())
    const result = removeReceipt(root, "skill", "nope")
    expect(result.ok).toBe(true)
    expect(result.ok && result.removed).toBeNull()
    expect(readLedger(root).receipts).toHaveLength(1)
  })
})

describe("validateReceipt", () => {
  test("rejects hostile / malformed input", () => {
    expect(validateReceipt(receipt({ name: "../evil" }))).toContain("name")
    expect(validateReceipt(receipt({ name: ".hidden" }))).toContain("name")
    expect(validateReceipt(receipt({ type: "virus" as InstallReceipt["type"] }))).toContain("type")
    expect(validateReceipt(receipt({ scope: "system" as InstallReceipt["scope"] }))).toContain("scope")
    expect(validateReceipt(receipt({ origin: "web" as InstallReceipt["origin"] }))).toContain("origin")
    expect(validateReceipt(receipt({ installedAt: "yesterday" }))).toContain("installedAt")
    expect(validateReceipt(receipt({ files: ["relative/path"] }))).toContain("absolute")
    expect(validateReceipt(receipt({ id: "" }))).toContain("id")
    expect(addReceipt(root, receipt({ name: "../evil" })).ok).toBe(false)
  })

  test("accepts a fully-specified valid receipt", () => {
    expect(validateReceipt(receipt({ files: [path.join(root, "a.md")] }))).toBeNull()
  })
})
