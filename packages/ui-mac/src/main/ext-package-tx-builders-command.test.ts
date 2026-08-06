// `#840`:`buildCommandTxItems` 的构造期判据 —— 单 config item 的形状、fresh 闸(未登记 live 叶
// 不认领不覆盖)、R4-1(disabled receipt 具名拒绝)、以及 departing 分支的 keyPath 同源。
//
// 行为半场(装上之后引擎真的读到、卸载之后引擎真的读不到)不在本文件:
// 它在 `package-command-engine-visibility.test.ts`(真引擎 `GET /command`)。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { buildCommandTxItems, buildDepartingChildConfigItemsV1 } from "./ext-package-tx-builders"
import { upsertRecordV2, type UpsertInput } from "./ext-receipt-v2"

let tmp = ""
let root = ""
const previousRoot = process.env.ALPHA_GLOBAL_DIR

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "req840-cmd-builder-"))
  root = path.join(tmp, "global")
  fs.mkdirSync(root, { recursive: true })
  process.env.ALPHA_GLOBAL_DIR = root
})

afterEach(() => {
  if (previousRoot === undefined) delete process.env.ALPHA_GLOBAL_DIR
  else process.env.ALPHA_GLOBAL_DIR = previousRoot
  fs.rmSync(tmp, { recursive: true, force: true })
})

const receipt = (over: Partial<UpsertInput> = {}): UpsertInput => ({
  id: "command:probe",
  name: "probe",
  kind: "command",
  environment: "dev",
  scope: { kind: "global" },
  desiredState: "enabled",
  origin: "catalog",
  manifestDigest: `sha256:${"a".repeat(64)}`,
  installedAt: "2026-08-05T00:00:00.000Z",
  ...over,
})

const input = (over: Partial<Parameters<typeof buildCommandTxItems>[0]> = {}) => ({
  root,
  key: "command--probe",
  name: "probe",
  capabilities: [] as string[],
  manifestDigest: `sha256:${"a".repeat(64)}`,
  receipt: receipt(),
  commandEntry: { template: "PKG $ARGUMENTS", description: "d", subtask: true },
  ...over,
})

describe("buildCommandTxItems (#840)", () => {
  test("fresh:单 config item,keyPath = [command, <name>],receipt.configKey 同源", () => {
    const built = buildCommandTxItems(input())
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.build.items).toHaveLength(1)
    const item = built.build.items[0]!
    expect(item.action).toBe("config")
    expect(item.config?.target).toBe(path.join(root, "alpha.jsonc"))
    expect(item.config?.edits).toEqual([
      { keyPath: ["command", "probe"], value: { template: "PKG $ARGUMENTS", description: "d", subtask: true } },
    ])
    expect(built.build.receipt.configKey).toBe("command.probe")
    expect(built.build.precondition().ok).toBe(true)
  })

  test("缺 commandEntry ⇒ NO_PLAN 同款具名拒绝", () => {
    const built = buildCommandTxItems(input({ commandEntry: undefined }))
    expect(built).toMatchObject({ ok: false, reason: expect.stringContaining("could not produce a transaction plan") })
  })

  test("R4-1:disabled receipt ⇒ 具名拒绝(command 无启停面,不装假态)", () => {
    const built = buildCommandTxItems(input({ receipt: receipt({ desiredState: "disabled" }) }))
    expect(built.ok).toBe(false)
    if (!built.ok) {
      expect(built.reason).toContain("no enable/disable surface")
      expect(built.reason).toContain("R4-1")
    }
  })

  test("fresh 闸:未登记的 live command 叶不认领不覆盖(治理路 builtin 覆盖叶是真实保护对象)", () => {
    fs.writeFileSync(
      path.join(root, "alpha.jsonc"),
      JSON.stringify({ command: { probe: { template: "governance-owned", description: "(已禁用)某占位" } } }),
    )
    const built = buildCommandTxItems(input())
    expect(built).toMatchObject({ ok: false, reason: expect.stringContaining("unregistered command config is not adopted or overwritten") })
  })

  test("在册即可覆盖(update/重装同位置换内容)", () => {
    fs.writeFileSync(path.join(root, "alpha.jsonc"), JSON.stringify({ command: { probe: { template: "old" } } }))
    const w = upsertRecordV2(root, receipt())
    expect(w.ok).toBe(true)
    const built = buildCommandTxItems(input())
    expect(built.ok).toBe(true)
  })

  test("锁内 precondition:计划构造后叶被旁路占用 ⇒ 拒(TOCTOU 闸)", () => {
    const built = buildCommandTxItems(input())
    expect(built.ok).toBe(true)
    if (!built.ok) return
    fs.writeFileSync(path.join(root, "alpha.jsonc"), JSON.stringify({ command: { probe: { template: "sneaked" } } }))
    const pre = built.build.precondition()
    expect(pre).toMatchObject({ ok: false, reason: expect.stringContaining("appeared before commit") })
  })
})

describe("buildDepartingChildConfigItemsV1 command 分支 (#840)", () => {
  test("离场 command ⇒ 事务 config item 删同一 keyPath(与安装侧逐字同源)", () => {
    const items = buildDepartingChildConfigItemsV1({ root, children: [{ kind: "command", name: "probe" }] })
    expect(items).toHaveLength(1)
    expect(items[0]!.key).toBe("command--probe--departing")
    expect(items[0]!.config?.edits).toEqual([{ keyPath: ["command", "probe"], value: undefined }])
  })
})
