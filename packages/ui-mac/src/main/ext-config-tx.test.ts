// REQ-100 #311:alpha.jsonc 配置事务适配器 —— journaled、可回滚、digest 校验 fail-closed。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  applyConfigImage,
  prepareConfigTx,
  readStagedConfigImage,
  restoreConfigImage,
  stageConfigImage,
} from "./ext-config-tx"

let root: string
let target: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-configtx-"))
  target = path.join(root, "alpha.jsonc")
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const parse = (t: string) => JSON.parse(fs.readFileSync(t, "utf8"))

describe("prepareConfigTx", () => {
  test("从空/缺失文件计算 image;多条 edit 按序累积到 nextImage", () => {
    const r = prepareConfigTx(target, [
      { keyPath: ["mcp", "a"], value: { type: "local" } },
      { keyPath: ["mcp", "b"], value: { type: "local" } },
    ])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const next = JSON.parse(r.image.nextImage)
    expect(next.mcp.a).toEqual({ type: "local" })
    expect(next.mcp.b).toEqual({ type: "local" }) // 第二条基于第一条累积,而非各自从 live
    expect(r.image.preImage).toBe("{}")
  })

  test("越权 top key 拒绝(写盘前 fail-closed)", () => {
    const r = prepareConfigTx(target, [{ keyPath: ["evil"], value: 1 }])
    expect(r.ok).toBe(false)
  })

  test("edit 后非法 jsonc 拒绝", () => {
    fs.writeFileSync(target, "{ not valid")
    const r = prepareConfigTx(target, [{ keyPath: ["mcp", "a"], value: 1 }])
    expect(r.ok).toBe(false)
  })
})

describe("apply / restore 生命周期", () => {
  test("apply 原子替换;restore 在 target==next 时写回 pre", () => {
    fs.writeFileSync(target, JSON.stringify({ mcp: { existing: { type: "local" } } }, null, 2))
    const r = prepareConfigTx(target, [{ keyPath: ["mcp", "new"], value: { type: "local" } }])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    applyConfigImage(r.image)
    expect(parse(target).mcp.new).toEqual({ type: "local" }) // 已切换
    const restored = restoreConfigImage(r.image)
    expect(restored.ok && restored.action).toBe("restored")
    expect(parse(target).mcp.new).toBeUndefined() // 回到旧态
    expect(parse(target).mcp.existing).toEqual({ type: "local" })
  })

  test("restore 在 target 已是旧态时 noop(switch 未应用)", () => {
    fs.writeFileSync(target, JSON.stringify({ mcp: {} }))
    const r = prepareConfigTx(target, [{ keyPath: ["mcp", "x"], value: 1 }])
    if (!r.ok) throw new Error("prep failed")
    const restored = restoreConfigImage(r.image) // 未 apply
    expect(restored.ok && restored.action).toBe("noop")
  })

  test("restore 在 target 被旁路改写(既非 pre 也非 next)时 fail-closed,不盲目覆盖", () => {
    fs.writeFileSync(target, JSON.stringify({ mcp: {} }))
    const r = prepareConfigTx(target, [{ keyPath: ["mcp", "x"], value: 1 }])
    if (!r.ok) throw new Error("prep failed")
    applyConfigImage(r.image)
    fs.writeFileSync(target, JSON.stringify({ mcp: { x: 1, sideband: true } })) // 并发旁路写
    const restored = restoreConfigImage(r.image)
    expect(restored.ok).toBe(false)
    if (!restored.ok) expect(restored.reason).toContain("diverged")
    expect(parse(target).mcp.sideband).toBe(true) // 旁路内容未被覆盖
  })
})

describe("staging + 崩溃恢复重建", () => {
  test("stage 落 0600;readStagedConfigImage 按 digest 校验重建", () => {
    const r = prepareConfigTx(target, [{ keyPath: ["mcp", "a"], value: 1 }])
    if (!r.ok) throw new Error("prep failed")
    const stagingDir = path.join(root, "ext-tx", "staging", "tx-1")
    stageConfigImage(stagingDir, 0, r.image)
    const pre = path.join(stagingDir, "config-0.pre")
    if (process.platform !== "win32") expect(fs.statSync(pre).mode & 0o777).toBe(0o600)
    const rebuilt = readStagedConfigImage(stagingDir, 0, target, r.image.preDigest, r.image.nextDigest)
    expect(rebuilt.ok).toBe(true)
    if (rebuilt.ok) expect(rebuilt.image.nextImage).toBe(r.image.nextImage)
  })

  test("staged image digest 被篡改 → 重建 fail-closed", () => {
    const r = prepareConfigTx(target, [{ keyPath: ["mcp", "a"], value: 1 }])
    if (!r.ok) throw new Error("prep failed")
    const stagingDir = path.join(root, "ext-tx", "staging", "tx-2")
    stageConfigImage(stagingDir, 0, r.image)
    const wrongDigest = crypto.createHash("sha256").update("tampered").digest("hex")
    expect(readStagedConfigImage(stagingDir, 0, target, wrongDigest, r.image.nextDigest).ok).toBe(false)
  })
})
