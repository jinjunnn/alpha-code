// REQ-100 #311:事务引擎 action-union —— config(alpha.jsonc)与 generation 混在同一原子事务;
// receipt-only(cloud)。验证:异构 commit、config 回滚(receipt 失败)、config 崩溃恢复原子性。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  readCurrentGeneration,
  readTransactionJournal,
  recoverExtensionTransactions,
  runExtensionTransaction,
  type TxCommitRecord,
  type TxHooks,
  type TxPlan,
} from "./ext-transaction"
import { restoreConfigImage } from "./ext-config-tx"

let root: string
let cfg: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ext-tx-cfg-"))
  cfg = path.join(root, "alpha.jsonc")
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex")
const noop = () => {}
const readCfg = () => JSON.parse(fs.readFileSync(cfg, "utf8"))
const writeCfg = (o: unknown) => fs.writeFileSync(cfg, JSON.stringify(o, null, 2))

const configItem = (key: string, name: string, value: unknown) => ({
  key,
  action: "config" as const,
  config: { target: cfg, edits: [{ keyPath: ["mcp", name], value }] },
  manifestDigest: `sha256:${sha(key)}`,
})
const genItem = (key: string, body: string) => ({
  key,
  files: [{ path: "SKILL.md", sha256: sha(body), size: Buffer.byteLength(body) }],
  manifestDigest: `sha256:${sha(key)}`,
})
const genHooks = (body: string, extra: Partial<TxHooks> = {}): TxHooks => ({
  populate: (_item, dir) => fs.writeFileSync(path.join(dir, "SKILL.md"), body),
  log: noop,
  ...extra,
})

describe("config action", () => {
  test("#378:config target 圈禁事务根 —— root 外绝对路径在 validate 期拒绝(与恢复侧对称)", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ext-tx-out-"))
    try {
      const r = await runExtensionTransaction(
        root,
        {
          items: [
            {
              key: "mcp--x",
              action: "config" as const,
              config: { target: path.join(outside, "alpha.jsonc"), edits: [{ keyPath: ["mcp", "x"], value: { type: "local" } }] },
              manifestDigest: `sha256:${sha("x")}`,
            },
          ],
        },
        { populate: noop, commitReceipt: noop, log: noop },
      )
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain("escapes the transaction root")
      expect(fs.existsSync(path.join(outside, "alpha.jsonc"))).toBe(false) // 零写盘
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  test("#378 r2:restore preimage 写失败(目录只读)走结果通道,不抛 —— 引擎按 blocked 保留而非 reject 悬锁", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return // root 下 0o555 仍可写
    const sub = path.join(root, "ro")
    fs.mkdirSync(sub, { recursive: true })
    const target = path.join(sub, "alpha.jsonc")
    const pre = "{}"
    const next = JSON.stringify({ mcp: { a: { type: "local" } } })
    fs.writeFileSync(target, next)
    fs.chmodSync(sub, 0o555)
    try {
      const r = restoreConfigImage({ target, preImage: pre, nextImage: next, preDigest: sha(pre), nextDigest: sha(next) })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain("preimage write failed")
    } finally {
      fs.chmodSync(sub, 0o755)
    }
  })

  test("#378 r10:同 target 双 config item(链式 image)—— switching 后零 apply 崩溃,恢复干净回滚", async () => {
    writeCfg({ mcp: { seed: { type: "local" } } })
    const before = fs.readFileSync(cfg, "utf8")
    const plan: TxPlan = { items: [configItem("mcp--a", "a", { type: "local" }), configItem("mcp--b", "b", { type: "remote", url: "https://x/sse" })] }
    let crashed = false
    try {
      await runExtensionTransaction(root, plan, { populate: noop, commitReceipt: noop, log: noop, crashAt: "after-switching-journal" })
    } catch {
      crashed = true
    }
    expect(crashed).toBe(true)
    expect(fs.readFileSync(cfg, "utf8")).toBe(before) // 尚未 apply,live=链首前像
    const rec = await recoverExtensionTransactions(root, { commitReceipt: noop, pidAlive: () => false, log: noop })
    expect(rec.ok).toBe(true)
    // r10 前:item_b 期望中间前像 → divergence 永久保留;现在按链判 live=pre_0 → 干净回滚
    expect(rec.reports[0]?.action).toBe("rolled-back")
    expect(fs.readFileSync(cfg, "utf8")).toBe(before)
  })

  test("#378 r11:同 target 双 config 链完整提交(after-switched 崩溃)→ 恢复前滚 committed(不整体回滚)", async () => {
    writeCfg({ mcp: { seed: { type: "local" } } })
    const plan: TxPlan = { items: [configItem("mcp--a", "a", { type: "local" }), configItem("mcp--b", "b", { type: "remote", url: "https://x/sse" })] }
    let crashed = false
    try {
      await runExtensionTransaction(root, plan, { populate: noop, commitReceipt: noop, log: noop, crashAt: "after-switched" })
    } catch {
      crashed = true
    }
    expect(crashed).toBe(true)
    expect(readCfg().mcp.a).toEqual({ type: "local" })
    expect(readCfg().mcp.b).toEqual({ type: "remote", url: "https://x/sse" }) // 链已完整生效
    const received: TxCommitRecord[][] = []
    const rec = await recoverExtensionTransactions(root, {
      probe: () => ({ healthy: true }),
      commitReceipt: (r) => void received.push(r),
      pidAlive: () => false,
      log: noop,
    })
    expect(rec.ok).toBe(true)
    // r11 前:链首 item 用中间 nextDigest 判翻转恒 false → 完整提交的事务被整体回滚
    expect(rec.reports[0]?.action).toBe("resumed-committed")
    expect(readCfg().mcp.a).toEqual({ type: "local" })
    expect(readCfg().mcp.b).toEqual({ type: "remote", url: "https://x/sse" })
    expect(received.flat().map((r) => r.key).sort()).toEqual(["mcp--a", "mcp--b"])
  })

  test("#378 r10:同 target 链中途 apply 停摆(live=中间 next)→ 恢复写回链首前像", async () => {
    writeCfg({ mcp: { seed: { type: "local" } } })
    const before = fs.readFileSync(cfg, "utf8")
    const plan: TxPlan = { items: [configItem("mcp--a", "a", { type: "local" }), configItem("mcp--b", "b", { type: "remote", url: "https://x/sse" })] }
    let crashed = false
    try {
      await runExtensionTransaction(root, plan, { populate: noop, commitReceipt: noop, log: noop, crashAt: "mid-switch" })
    } catch {
      crashed = true
    }
    expect(crashed).toBe(true)
    expect(readCfg().mcp.a).toEqual({ type: "local" }) // item_a 已 apply(中间态)
    expect(readCfg().mcp.b).toBeUndefined()
    const rec = await recoverExtensionTransactions(root, { commitReceipt: noop, pidAlive: () => false, log: noop })
    expect(rec.ok).toBe(true)
    expect(rec.reports[0]?.action).toBe("rolled-back")
    expect(fs.readFileSync(cfg, "utf8")).toBe(before) // 写回链首前像
  })

  test("#378 r1:config 恢复被旁路改写挡住 → journal 保留非终态(不终态化为 rolled-back)", async () => {
    writeCfg({ mcp: { a: { type: "old" } } })
    const r = await runExtensionTransaction(root, { items: [configItem("mcp--a", "a", { type: "new" })] }, {
      populate: noop,
      log: noop,
      commitReceipt: () => {
        // receipt 失败前旁路改写 target → 回滚时 live 与 next/pre 均不符 → restore 拒
        fs.writeFileSync(cfg, JSON.stringify({ mcp: { a: { type: "bypass" } } }))
        throw new Error("receipt sink failed")
      },
    })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.reason).toContain("retained non-terminal")
    const journal = readTransactionJournal(root, r.txId!)
    expect(journal).not.toBeNull()
    expect(journal!.state).not.toBe("rolled-back")
    expect(journal!.state).not.toBe("committed")
    expect(readCfg().mcp.a.type).toBe("bypass") // 留证:不复原、不覆盖
  })

  test("config 装进 live alpha.jsonc + 提交 config receipt", async () => {
    const received: TxCommitRecord[][] = []
    const r = await runExtensionTransaction(root, { items: [configItem("mcp--a", "a", { type: "local" })] }, {
      populate: noop,
      commitReceipt: (recs) => void received.push(recs),
      log: noop,
    })
    expect(r.ok).toBe(true)
    expect(readCfg().mcp.a).toEqual({ type: "local" })
    expect(received[0]![0]!.action).toBe("config")
    expect(received[0]![0]!.configTarget).toBe(cfg)
  })

  test("同一 alpha.jsonc 两条 config edit 累积落地(不互相覆盖)", async () => {
    writeCfg({ mcp: { existing: 1 } })
    const r = await runExtensionTransaction(
      root,
      { items: [configItem("mcp--a", "a", { type: "local" }), configItem("mcp--b", "b", { type: "local" })] },
      { populate: noop, log: noop },
    )
    expect(r.ok).toBe(true)
    const c = readCfg()
    expect(c.mcp.a).toEqual({ type: "local" })
    expect(c.mcp.b).toEqual({ type: "local" })
    expect(c.mcp.existing).toBe(1) // 旧内容保留
  })
})

describe("异构 bundle 原子性", () => {
  test("skill generation + config 同事务全提交", async () => {
    const r = await runExtensionTransaction(
      root,
      { items: [genItem("skill--s", "body"), configItem("mcp--a", "a", { type: "local" })] },
      genHooks("body"),
    )
    expect(r.ok).toBe(true)
    expect(readCurrentGeneration(root, "skill--s")).not.toBeNull() // generation live
    expect(readCfg().mcp.a).toEqual({ type: "local" }) // config live
  })

  test("receipt commit 失败 → config 回滚(live alpha.jsonc 复原)+ generation 不切换", async () => {
    writeCfg({ mcp: { existing: 1 } })
    const before = fs.readFileSync(cfg, "utf8")
    const r = await runExtensionTransaction(
      root,
      { items: [genItem("skill--s", "body"), configItem("mcp--a", "a", { type: "local" })] },
      genHooks("body", {
        commitReceipt: () => {
          throw new Error("simulated receipt failure")
        },
      }),
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.stage).toBe("receipt-commit")
    expect(fs.readFileSync(cfg, "utf8")).toBe(before) // config 已回滚到 preimage
    expect(readCfg().mcp.a).toBeUndefined()
    expect(readCurrentGeneration(root, "skill--s")).toBeNull() // generation 回滚
  })
})

describe("config 崩溃恢复", () => {
  test("switch 后崩溃(config 已应用)+ 无 probe → 恢复回滚,alpha.jsonc 复原(原子性)", async () => {
    writeCfg({ mcp: { existing: 1 } })
    const before = fs.readFileSync(cfg, "utf8")
    // 在 after-switched 崩溃:config next-image 已写入 live,journal=switched,receipt 未提交。
    const crashed = runExtensionTransaction(
      root,
      { items: [genItem("skill--s", "body"), configItem("mcp--a", "a", { type: "local" })] },
      genHooks("body", { crashAt: "after-switched" }),
    )
    await expect(crashed).rejects.toThrow()
    // 崩溃时 config 已翻转
    expect(readCfg().mcp.a).toEqual({ type: "local" })
    // 恢复:无 probe/receipt → health 未知 → 安全回滚(全旧)
    const rec = await recoverExtensionTransactions(root, { pidAlive: () => false, log: noop })
    expect(rec.ok).toBe(true)
    expect(fs.readFileSync(cfg, "utf8")).toBe(before) // config 复原
    expect(readCurrentGeneration(root, "skill--s")).toBeNull() // generation 复原
  })

  test("switch 前崩溃(config 未应用)→ 恢复 abort,live 从未改动", async () => {
    writeCfg({ mcp: { existing: 1 } })
    const before = fs.readFileSync(cfg, "utf8")
    const crashed = runExtensionTransaction(
      root,
      { items: [genItem("skill--s", "body"), configItem("mcp--a", "a", { type: "local" })] },
      genHooks("body", { crashAt: "after-staged" }),
    )
    await expect(crashed).rejects.toThrow()
    expect(fs.readFileSync(cfg, "utf8")).toBe(before) // switch 前 live 未动
    const rec = await recoverExtensionTransactions(root, { pidAlive: () => false, log: noop })
    expect(rec.ok).toBe(true)
    expect(fs.readFileSync(cfg, "utf8")).toBe(before) // 仍未动
  })
})

// REQ-102 #358 review Major 5:jsonc modify 对形状异常父节点抛异常 —— 适配器必须转结构化失败
// (prepareConfigTx 在引擎 bundle 锁内运行,异常逃逸 = 锁不释放)。
describe("prepareConfigTx 形状异常 fail-closed(#358 review)", () => {
  test("非对象父节点(agent 为字符串/数字)返回 ok:false 而非抛异常", async () => {
    const { prepareConfigTx } = await import("./ext-config-tx")
    const r1 = prepareConfigTx("/nonexistent/alpha.jsonc", [{ keyPath: ["agent", "demo"], value: { a: 1 } }], '{"agent": "mine"}')
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.reason).toContain("config edit failed")
    const r2 = prepareConfigTx("/nonexistent/alpha.jsonc", [{ keyPath: ["mcp", "x"], value: {} }], '{"mcp": 3}')
    expect(r2.ok).toBe(false)
  })
})
