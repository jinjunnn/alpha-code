// REQ-100 —— capability 授权账单测:diff 语义(扩张/收缩/首装)、覆盖式确认、fail-closed 读、
// 原子写、Bundle 聚合。全部真盘临时目录,零 mock.module(仓规)。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  capabilityGrantPath,
  confirmationCovers,
  diffCapabilities,
  evaluateBundleAuthorization,
  evaluateCapabilityDiff,
  isSafeCapability,
  readCapabilityGrant,
  removeCapabilityGrantSync,
  writeCapabilityGrantSync,
  type CapabilityGrant,
} from "./ext-capability-grants"

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ext-grants-"))
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const grantOf = (key: string, capabilities: string[]): CapabilityGrant => ({
  v: 1,
  key,
  capabilities,
  txId: "tx-a-00000001",
  grantedAt: new Date().toISOString(),
})

describe("isSafeCapability", () => {
  test("accepts manifest-style capabilities, rejects structural junk", () => {
    expect(isSafeCapability("prompt:context")).toBe(true)
    expect(isSafeCapability("process:spawn")).toBe(true)
    expect(isSafeCapability("engine.plugin_v2")).toBe(true)
    expect(isSafeCapability("")).toBe(false)
    expect(isSafeCapability("1leading-digit")).toBe(false)
    expect(isSafeCapability("has space")).toBe(false)
    expect(isSafeCapability("x".repeat(66))).toBe(false)
    expect(isSafeCapability(42)).toBe(false)
  })
})

describe("diffCapabilities", () => {
  test("no previous grant: any non-empty request requires confirmation (initial grant)", () => {
    const d = diffCapabilities("k", null, ["prompt:context"])
    expect(d.previous).toBeNull()
    expect(d.added).toEqual(["prompt:context"])
    expect(d.requiresConfirmation).toBe(true)
  })

  test("no previous grant + empty request: nothing to confirm", () => {
    expect(diffCapabilities("k", null, []).requiresConfirmation).toBe(false)
  })

  test("expansion requires confirmation; unchanged and shrink do not", () => {
    const grow = diffCapabilities("k", ["prompt:context"], ["prompt:context", "process:spawn"])
    expect(grow.added).toEqual(["process:spawn"])
    expect(grow.requiresConfirmation).toBe(true)

    const same = diffCapabilities("k", ["prompt:context"], ["prompt:context"])
    expect(same.added).toEqual([])
    expect(same.requiresConfirmation).toBe(false)

    const shrink = diffCapabilities("k", ["prompt:context", "process:spawn"], ["prompt:context"])
    expect(shrink.removed).toEqual(["process:spawn"])
    expect(shrink.requiresConfirmation).toBe(false)
  })

  test("output sets are sorted and de-duplicated", () => {
    const d = diffCapabilities("k", ["b", "a"], ["c", "a", "c"])
    expect(d.previous).toEqual(["a", "b"])
    expect(d.requested).toEqual(["a", "c"])
    expect(d.added).toEqual(["c"])
    expect(d.removed).toEqual(["b"])
  })
})

describe("confirmationCovers", () => {
  test("requested ⊆ confirmed passes; partial confirmation fails; missing fails", () => {
    expect(confirmationCovers(["a", "b"], ["a", "b"])).toBe(true)
    expect(confirmationCovers(["a", "b", "extra"], ["a", "b"])).toBe(true)
    expect(confirmationCovers(["a"], ["a", "b"])).toBe(false)
    expect(confirmationCovers(undefined, ["a"])).toBe(false)
    expect(confirmationCovers(undefined, [])).toBe(false)
    expect(confirmationCovers([], [])).toBe(true)
  })
})

describe("grant ledger (read/write/remove)", () => {
  test("roundtrip: atomic write, normalized (sorted, deduped), no tmp leftovers", () => {
    writeCapabilityGrantSync(root, grantOf("skill--demo", ["process:spawn", "prompt:context", "process:spawn"]))
    const read = readCapabilityGrant(root, "skill--demo")
    expect(read?.capabilities).toEqual(["process:spawn", "prompt:context"])
    const dir = path.dirname(capabilityGrantPath(root, "skill--demo"))
    expect(fs.readdirSync(dir).filter((n) => n.includes(".tmp-"))).toEqual([])
  })

  test("missing / corrupt / wrong-shape grant reads as null (fail closed)", () => {
    expect(readCapabilityGrant(root, "skill--none")).toBeNull()
    const file = capabilityGrantPath(root, "skill--demo")
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, "{ corrupt")
    expect(readCapabilityGrant(root, "skill--demo")).toBeNull()
    fs.writeFileSync(file, JSON.stringify({ v: 1, key: "skill--demo", capabilities: ["ok", 42], txId: "t" }))
    expect(readCapabilityGrant(root, "skill--demo")).toBeNull()
  })

  test("unsafe key is refused on read/write/remove", () => {
    expect(readCapabilityGrant(root, "../escape")).toBeNull()
    expect(() => writeCapabilityGrantSync(root, grantOf("../escape", []))).toThrow()
    expect(removeCapabilityGrantSync(root, "../escape")).toBe(false)
  })

  test("remove is idempotent", () => {
    writeCapabilityGrantSync(root, grantOf("skill--demo", ["prompt:context"]))
    expect(removeCapabilityGrantSync(root, "skill--demo")).toBe(true)
    expect(removeCapabilityGrantSync(root, "skill--demo")).toBe(false)
    expect(readCapabilityGrant(root, "skill--demo")).toBeNull()
  })
})

describe("evaluate against disk", () => {
  test("evaluateCapabilityDiff uses the persisted grant as baseline", () => {
    writeCapabilityGrantSync(root, grantOf("skill--demo", ["prompt:context"]))
    const d = evaluateCapabilityDiff(root, "skill--demo", ["prompt:context", "network:remote"])
    expect(d.previous).toEqual(["prompt:context"])
    expect(d.added).toEqual(["network:remote"])
    expect(d.requiresConfirmation).toBe(true)
  })

  test("bundle aggregation: any expanding item flips requiresConfirmation", () => {
    writeCapabilityGrantSync(root, grantOf("skill--a", ["prompt:context"]))
    writeCapabilityGrantSync(root, grantOf("skill--b", ["prompt:context"]))
    const quiet = evaluateBundleAuthorization(root, [
      { key: "skill--a", capabilities: ["prompt:context"] },
      { key: "skill--b", capabilities: ["prompt:context"] },
    ])
    expect(quiet.requiresConfirmation).toBe(false)
    const noisy = evaluateBundleAuthorization(root, [
      { key: "skill--a", capabilities: ["prompt:context"] },
      { key: "skill--b", capabilities: ["prompt:context", "process:spawn"] },
    ])
    expect(noisy.requiresConfirmation).toBe(true)
    expect(noisy.items.find((d) => d.key === "skill--b")?.added).toEqual(["process:spawn"])
  })
})
