// REQ-100 #310 (+#336):skill 生产安装走不可变 generation;账本写失败即事务失败(不谎报成功)。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as crypto from "node:crypto"
import { findRecordV2, readLedgerV2, upsertRecordsV2 } from "./ext-receipt-v2"
import { recoverExtensionTransactions, resolveLiveGenerationDir, runExtensionTransaction, type TxCommitRecord, type TxPlan } from "./ext-transaction"
import {
  collectSkillPayloadFromDir,
  commitInputFromRecord,
  installSkillGeneration,
  skillGenerationKey,
  skillGenerationLiveDirs,
  skillGenerationProbe,
  hasSkillGeneration,
  type SkillPayloadFile,
} from "./ext-skill-generations"

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-skillgen-"))
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const payload = (files: Record<string, string>): SkillPayloadFile[] =>
  Object.entries(files).map(([p, data]) => ({ path: p, data: Buffer.from(data) }))

// 有效 SKILL.md(frontmatter name/description)= 类型化 probe(#312)通过的前提。
const skillMd = (name: string) => `---\nname: ${name}\ndescription: test skill ${name}\n---\nbody`

const install = (name: string, extraFiles: Record<string, string> = {}, extra?: Record<string, unknown>) =>
  installSkillGeneration(root, {
    name,
    id: `catalog:${name}`,
    environment: "prod",
    scope: { kind: "global" },
    origin: "catalog",
    files: payload({ "SKILL.md": skillMd(name), ...extraFiles }),
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
      id: "catalog:bad",
      environment: "prod",
      scope: { kind: "global" },
      origin: "catalog",
      files: payload({ "SKILL.md": "no frontmatter here" }), // probe 拒绝
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.stage).toBe("pre-switch-probe")
    expect(resolveLiveGenerationDir(root, skillGenerationKey("bad"))).toBeNull()
  })

  test("#312:frontmatter name 与 key 不符(shadowing)→ probe 失败拒绝", async () => {
    const r = await installSkillGeneration(root, {
      name: "realname",
      id: "catalog:realname",
      environment: "prod",
      scope: { kind: "global" },
      origin: "catalog",
      files: payload({ "SKILL.md": skillMd("otherskill") }), // name 冒充
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
        receipt: { id: `catalog:${name}`, name, kind: "skill", environment: "prod", scope: { kind: "global" }, desiredState: "enabled", origin: "catalog", installedAt: new Date("2026-07-14T00:00:00Z").toISOString() },
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
