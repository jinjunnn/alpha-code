// REQ-100 #310 (+#336):skill 生产安装走不可变 generation;账本写失败即事务失败(不谎报成功)。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as crypto from "node:crypto"
import { findRecordV2, readLedgerV2, removeRecordV2, upsertRecordsV2 } from "./ext-receipt-v2"
import {
  readGenerationReceiptSnapshot,
  recoverExtensionTransactions,
  resolveLiveGenerationDir,
  runExtensionTransaction,
  uninstallExtensionTransaction,
  type TxCommitRecord,
  type TxFileSpec,
  type TxPlan,
} from "./ext-transaction"
import { putCasBlobFromBuffer } from "./ext-cas"
import {
  collectSkillPayloadFromDir,
  commitInputFromRecord,
  installSkillGeneration,
  listSkillGenerations,
  rollbackSkillGeneration,
  skillGenerationKey,
  skillGenerationLiveDirs,
  skillGenerationProbe,
  skillStorePaths,
  hasSkillGeneration,
  type SkillPayloadFile,
} from "./ext-skill-generations"

let root: string
let casBase: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-skillgen-"))
  casBase = path.join(root, "cas-base")
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const payload = (files: Record<string, string>): SkillPayloadFile[] =>
  Object.entries(files).map(([p, data]) => ({ path: p, data: Buffer.from(data) }))

/** REQ-098 #303 CAS-only:测试载荷 = 先提升进临时共享 CAS,再交 casFiles。 */
const casFilesFor = (files: Record<string, string>): { specs: TxFileSpec[]; casBaseRoot: string } => {
  const specs = Object.entries(files).map(([p, content]) => {
    const data = Buffer.from(content)
    const digest = crypto.createHash("sha256").update(data).digest("hex")
    const put = putCasBlobFromBuffer(casBase, data, digest)
    if (!put.ok) throw new Error(put.reason)
    return { path: p, sha256: digest, size: data.length }
  })
  return { specs, casBaseRoot: casBase }
}

// 有效 SKILL.md(frontmatter name/description)= 类型化 probe(#312)通过的前提。
const skillMd = (name: string) => `---\nname: ${name}\ndescription: test skill ${name}\n---\nbody`

const install = (name: string, extraFiles: Record<string, string> = {}, extra?: Record<string, unknown>) =>
  installSkillGeneration(root, {
    name,
    id: `skill:${name}`,
    environment: "prod",
    scope: { kind: "global" },
    origin: "catalog",
    casFiles: casFilesFor({ "SKILL.md": skillMd(name), ...extraFiles }),
    ...extra,
  })

describe("installSkillGeneration", () => {
  test("装进不可变 generation + current.json 指针 + 提交 V2 receipt", async () => {
    const r = await install("demo")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const live = resolveLiveGenerationDir(root, skillGenerationKey("demo"))
    expect(live).toBe(r.generationDir)
    expect(fs.readFileSync(path.join(live!, "SKILL.md"), "utf8")).toContain("name: demo")
    const ledger = readLedgerV2(root)
    const rec = ledger.records.find((x) => x.kind === "skill" && x.name === "demo")
    expect(rec).toBeTruthy()
    expect(rec!.transaction?.state).toBe("committed")
  })

  test("更新走新 generation:上一版删掉的文件不残留(live 只含新载荷)", async () => {
    await install("demo", { "extra.txt": "old file" })
    const r2 = await install("demo") // 去掉 extra.txt
    expect(r2.ok).toBe(true)
    const live = resolveLiveGenerationDir(root, skillGenerationKey("demo"))!
    expect(fs.existsSync(path.join(live, "extra.txt"))).toBe(false) // 旧文件不残留
  })

  test("#336:commitReceipt(账本写)失败 → 事务回滚,generation 不切换(不谎报成功)", async () => {
    // 让 installs.json 变成目录 → upsertRecordV2 的原子写 rename 失败 → commitReceipt 抛错 → rollbackAll。
    fs.mkdirSync(path.join(root, "installs.json"), { recursive: true })
    const r = await install("demo")
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.stage).toBe("receipt-commit")
    // 回滚后无 live generation(current 未切换)。
    expect(resolveLiveGenerationDir(root, skillGenerationKey("demo"))).toBeNull()
  })

  test("#312:generation 里 SKILL.md 无效(probe 失败)→ pre-switch abort,不切换", async () => {
    const r = await installSkillGeneration(root, {
      name: "bad",
      id: "skill:bad",
      environment: "prod",
      scope: { kind: "global" },
      origin: "catalog",
      casFiles: casFilesFor({ "SKILL.md": "no frontmatter here" }), // probe 拒绝
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.stage).toBe("pre-switch-probe")
    expect(resolveLiveGenerationDir(root, skillGenerationKey("bad"))).toBeNull()
  })

  test("#312:frontmatter name 与 key 不符(shadowing)→ probe 失败拒绝", async () => {
    const r = await installSkillGeneration(root, {
      name: "realname",
      id: "skill:realname",
      environment: "prod",
      scope: { kind: "global" },
      origin: "catalog",
      casFiles: casFilesFor({ "SKILL.md": skillMd("otherskill") }), // name 冒充
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.stage).toBe("pre-switch-probe")
  })

  test("supersede:成功安装后清除同名旧 flat 目录(防双真源)", async () => {
    const flat = path.join(root, "skills", "demo")
    fs.mkdirSync(flat, { recursive: true })
    fs.writeFileSync(path.join(flat, "SKILL.md"), "old flat install")
    const r = await install("demo")
    expect(r.ok).toBe(true)
    expect(fs.existsSync(flat)).toBe(false) // 旧 flat 被 supersede
  })

  test("失败安装不 supersede 旧 flat 目录", async () => {
    const flat = path.join(root, "skills", "demo")
    fs.mkdirSync(flat, { recursive: true })
    fs.writeFileSync(path.join(flat, "SKILL.md"), "keep me")
    fs.mkdirSync(path.join(root, "installs.json"), { recursive: true }) // 逼 receipt 失败
    const r = await install("demo")
    expect(r.ok).toBe(false)
    expect(fs.existsSync(path.join(flat, "SKILL.md"))).toBe(true) // 失败不动旧 flat
  })
})

describe("发现层投影", () => {
  test("skillGenerationLiveDirs 列出所有 skill 的 live generation 目录", async () => {
    await install("alpha")
    await install("beta")
    const dirs = skillGenerationLiveDirs(root)
    expect(dirs).toHaveLength(2)
    expect(hasSkillGeneration(root, "alpha")).toBe(true)
    expect(hasSkillGeneration(root, "missing")).toBe(false)
    for (const d of dirs) expect(fs.existsSync(path.join(d, "SKILL.md"))).toBe(true)
  })

  test("无 ext-store → 空投影(不抛)", () => {
    expect(skillGenerationLiveDirs(root)).toEqual([])
  })
})

describe("#312 崩溃恢复:probe + receipt 模板前滚", () => {
  const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex")
  const recoverHooks = {
    probe: skillGenerationProbe,
    commitReceipt: (recs: TxCommitRecord[]) => {
      const w = upsertRecordsV2(root, recs.map((rec) => commitInputFromRecord(rec)))
      if (!w.ok) throw new Error(w.reason)
    },
    log: () => {},
    pidAlive: () => false,
  }
  const planFor = (name: string, body: string): TxPlan => ({
    items: [
      {
        key: skillGenerationKey(name),
        files: [{ path: "SKILL.md", sha256: sha(body), size: Buffer.byteLength(body) }],
        receipt: { id: `skill:${name}`, name, kind: "skill", environment: "prod", scope: { kind: "global" }, desiredState: "enabled", origin: "catalog", installedAt: new Date("2026-07-14T00:00:00Z").toISOString() },
      },
    ],
  })
  const hooksFor = (body: string, crashAt: "after-switched"): Parameters<typeof runExtensionTransaction>[2] => ({
    populate: (_i, dir) => fs.writeFileSync(path.join(dir, "SKILL.md"), body),
    probe: skillGenerationProbe,
    log: () => {},
    crashAt,
  })

  test("switch 后崩溃 + 健康 → 恢复用 probe 重验并前滚落账", async () => {
    const body = skillMd("demo")
    await expect(runExtensionTransaction(root, planFor("demo", body), hooksFor(body, "after-switched"))).rejects.toThrow()
    expect(findRecordV2(root, "skill", "demo")).toBeNull() // receipt 未提交
    const rec = await recoverExtensionTransactions(root, recoverHooks)
    expect(rec.ok).toBe(true)
    expect(resolveLiveGenerationDir(root, skillGenerationKey("demo"))).not.toBeNull() // 前滚保留
    expect(findRecordV2(root, "skill", "demo")).not.toBeNull() // receipt 前滚落账
  })

  test("switch 后崩溃 + 不健康(SKILL.md 无效)→ 恢复回滚,不落账", async () => {
    const body = "no frontmatter" // probe 会拒绝
    // 用 crashAt 绕过 forward probe(populate 后直接崩),让不健康 generation 进入 switched 态。
    await expect(runExtensionTransaction(root, planFor("bad", body), { populate: (_i, dir) => fs.writeFileSync(path.join(dir, "SKILL.md"), body), log: () => {}, crashAt: "after-switched" })).rejects.toThrow()
    const rec = await recoverExtensionTransactions(root, recoverHooks)
    expect(rec.ok).toBe(true)
    expect(resolveLiveGenerationDir(root, skillGenerationKey("bad"))).toBeNull() // 不健康 → 回滚
    expect(findRecordV2(root, "skill", "bad")).toBeNull()
  })
})

describe("#313 卸载:锁内 journaled store+ledger teardown + 恢复补偿", () => {
  test("卸载删 generation store + 账本(不留孤儿)", async () => {
    await install("demo")
    expect(fs.existsSync(skillStorePaths(root, "demo").store)).toBe(true)
    expect(findRecordV2(root, "skill", "demo")).not.toBeNull()
    const r = await uninstallExtensionTransaction(root, skillGenerationKey("demo"), {
      commitLedger: () => {
        const rm = removeRecordV2(root, "skill", "demo")
        if (!rm.ok) throw new Error(rm.reason)
      },
    })
    expect(r.ok).toBe(true)
    expect(fs.existsSync(skillStorePaths(root, "demo").store)).toBe(false) // store 删净(无孤儿)
    expect(findRecordV2(root, "skill", "demo")).toBeNull() // 账本删净
    expect(resolveLiveGenerationDir(root, skillGenerationKey("demo"))).toBeNull()
  })

  test("幂等:卸载已不在的 skill → ok,零副作用", async () => {
    const r = await uninstallExtensionTransaction(root, skillGenerationKey("ghost"), {})
    expect(r.ok).toBe(true)
  })

  test("commitLedger 失败 → 卸载 fail-closed(不谎报);store 已删,恢复前滚补删账", async () => {
    await install("demo")
    // commitLedger 抛错 = 账本删除失败(store-first 已删 store)。
    const r = await uninstallExtensionTransaction(root, skillGenerationKey("demo"), {
      commitLedger: () => {
        throw new Error("simulated ledger failure")
      },
    })
    expect(r.ok).toBe(false) // 不谎报成功
    expect(fs.existsSync(skillStorePaths(root, "demo").store)).toBe(false) // store-first:已删
    expect(findRecordV2(root, "skill", "demo")).not.toBeNull() // 账本还在(ghost)
    // 恢复前滚:补删账本 → 终态。
    const rec = await recoverExtensionTransactions(root, {
      pidAlive: () => false,
      log: () => {},
      commitUninstall: (key) => {
        const name = key.slice("skill--".length)
        const rm = removeRecordV2(root, "skill", name)
        if (!rm.ok) throw new Error(rm.reason)
      },
    })
    expect(rec.ok).toBe(true)
    expect(findRecordV2(root, "skill", "demo")).toBeNull() // ghost 账本被恢复补删
  })
})

describe("#313 快照 + 两版离线回滚", () => {
  const installV = (name: string, version: string) =>
    installSkillGeneration(root, {
      name,
      id: `skill:${name}`,
      environment: "prod",
      scope: { kind: "global" },
      origin: "catalog",
      version,
      manifestDigest: `sha256:${crypto.createHash("sha256").update(name + version).digest("hex")}`,
      casFiles: casFilesFor({ "SKILL.md": skillMd(name) }),
    })

  test("install 写 generation receipt 快照(receipts/<genId>.json)", async () => {
    await install("demo")
    const genId = listSkillGenerations(root, "demo")[0]!.genId
    const snap = readGenerationReceiptSnapshot(root, skillGenerationKey("demo"), genId)
    expect(snap).not.toBeNull()
    expect((snap!.receipt as { name: string }).name).toBe("demo")
  })

  test("回滚到上一版:pointer + receipt 都回到目标版本;逻辑 generation 递增不倒退", async () => {
    await installV("demo", "1.0.0")
    const gen1 = listSkillGenerations(root, "demo")[0]!.genId
    await installV("demo", "2.0.0")
    expect(findRecordV2(root, "skill", "demo")!.version).toBe("2.0.0")
    const gens = listSkillGenerations(root, "demo")
    expect(gens).toHaveLength(2)
    expect(gens.every((g) => g.eligible)).toBe(true) // 两版均有快照 = 可回滚

    const r = await rollbackSkillGeneration(root, "demo", gen1)
    expect(r.ok).toBe(true)
    expect(resolveLiveGenerationDir(root, skillGenerationKey("demo"))).toContain(gen1) // pointer 回 gen1
    const rec = findRecordV2(root, "skill", "demo")!
    expect(rec.version).toBe("1.0.0") // receipt 元数据回到目标版本(不分叉)
    expect(rec.generation).toBe(3) // 逻辑号递增:装2 + 回滚1(不倒退)
  })

  test("回滚目标 probe 不健康 → 零变更", async () => {
    await installV("demo", "1.0.0")
    const gen1 = listSkillGenerations(root, "demo")[0]!.genId
    await installV("demo", "2.0.0")
    // 破坏目标 gen 的 SKILL.md → probe 失败
    const gen1Dir = path.join(skillStorePaths(root, "demo").generations, gen1)
    fs.writeFileSync(path.join(gen1Dir, "SKILL.md"), "corrupted no frontmatter")
    const beforeVer = findRecordV2(root, "skill", "demo")!.version
    const r = await rollbackSkillGeneration(root, "demo", gen1)
    expect(r.ok).toBe(false)
    expect(findRecordV2(root, "skill", "demo")!.version).toBe(beforeVer) // 零变更
    expect(resolveLiveGenerationDir(root, skillGenerationKey("demo"))).not.toContain(gen1) // 指针未翻
  })

  test("回滚崩溃在翻指针与落账之间 → 恢复从 journal receipt 前滚补账", async () => {
    await installV("demo", "1.0.0")
    const gen1 = listSkillGenerations(root, "demo")[0]!.genId
    await installV("demo", "2.0.0")
    // 逼 commitReceipt 失败(installs.json 变目录)→ 指针已翻,账未落,journal=switched。
    const ledger = path.join(root, "installs.json")
    const saved = fs.readFileSync(ledger, "utf8")
    fs.rmSync(ledger)
    fs.mkdirSync(ledger)
    const r = await rollbackSkillGeneration(root, "demo", gen1)
    expect(r.ok).toBe(false)
    expect(resolveLiveGenerationDir(root, skillGenerationKey("demo"))).toContain(gen1) // 指针已翻(live=目标)
    // 修复账本后恢复前滚补账。
    fs.rmdirSync(ledger)
    fs.writeFileSync(ledger, saved)
    const rec = await recoverExtensionTransactions(root, {
      pidAlive: () => false,
      log: () => {},
      commitReceipt: (recs) => {
        const w = upsertRecordsV2(root, recs.map((x) => commitInputFromRecord(x)))
        if (!w.ok) throw new Error(w.reason)
      },
    })
    expect(rec.ok).toBe(true)
    expect(findRecordV2(root, "skill", "demo")!.version).toBe("1.0.0") // 前滚补账 → receipt 与 live 一致
  })

  test("卸载删 receipts/ 快照目录(owned path)", async () => {
    await install("demo")
    const snapDir = path.join(skillStorePaths(root, "demo").store, "receipts")
    expect(fs.existsSync(snapDir)).toBe(true)
    const un = await uninstallExtensionTransaction(root, skillGenerationKey("demo"), {})
    expect(un.ok).toBe(true)
    expect(fs.existsSync(snapDir)).toBe(false) // receipts/ 随 store 删净
    expect(fs.existsSync(skillStorePaths(root, "demo").store)).toBe(false)
  })
})

describe("collectSkillPayloadFromDir", () => {
  test("递归枚举目录为载荷(POSIX 相对路径)", () => {
    const src = path.join(root, "src-skill")
    fs.mkdirSync(path.join(src, "nested"), { recursive: true })
    fs.writeFileSync(path.join(src, "SKILL.md"), "top")
    fs.writeFileSync(path.join(src, "nested", "ref.md"), "nested")
    const r = collectSkillPayloadFromDir(src)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const paths = r.files.map((f) => f.path).sort()
    expect(paths).toEqual(["SKILL.md", "nested/ref.md"])
  })

  test("空目录拒绝", () => {
    const src = path.join(root, "empty")
    fs.mkdirSync(src, { recursive: true })
    const r = collectSkillPayloadFromDir(src)
    expect(r.ok).toBe(false)
  })
})

// ── #348:capabilities/authorization 直连事务引擎的适配层契约 ─────────────────────────────────────
describe("capability threading (REQ-100 #348)", () => {
  test("capabilities 非空 + 无 authorization → 判别分支带 diff;确认重驱落 grants", async () => {
    const first = await install("capdemo", {}, { capabilities: ["prompt:context"] })
    expect(first.ok).toBe(false)
    if (first.ok) throw new Error("unreachable")
    expect(first.stage).toBe("authorize")
    if (first.stage !== "authorize") throw new Error("unreachable")
    expect(first.authorization).toHaveLength(1)
    expect(first.authorization[0]!.key).toBe(skillGenerationKey("capdemo"))
    expect(first.authorization[0]!.requested).toEqual(["prompt:context"])
    expect(resolveLiveGenerationDir(root, skillGenerationKey("capdemo"))).toBeNull() // 零权威副作用
    const second = await install("capdemo", {}, {
      capabilities: ["prompt:context"],
      authorization: { confirmed: { [skillGenerationKey("capdemo")]: ["prompt:context"] }, decidedAt: new Date().toISOString() },
    })
    expect(second.ok).toBe(true)
    expect(resolveLiveGenerationDir(root, skillGenerationKey("capdemo"))).not.toBeNull()
  })

  test("capabilities 空集 → 闸静默通过(显式空集是合法选择,非遗漏)", async () => {
    const r = await install("nocap", {}, { capabilities: [] })
    expect(r.ok).toBe(true)
  })
})
