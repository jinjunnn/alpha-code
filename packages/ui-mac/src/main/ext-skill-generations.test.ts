// REQ-100 #310 (+#336):skill 生产安装走不可变 generation;账本写失败即事务失败(不谎报成功)。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { readLedgerV2 } from "./ext-receipt-v2"
import { resolveLiveGenerationDir } from "./ext-transaction"
import {
  collectSkillPayloadFromDir,
  installSkillGeneration,
  skillGenerationKey,
  skillGenerationLiveDirs,
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

const install = (name: string, files: Record<string, string>, extra?: Record<string, unknown>) =>
  installSkillGeneration(root, {
    name,
    id: `catalog:${name}`,
    environment: "prod",
    scope: { kind: "global" },
    origin: "catalog",
    files: payload(files),
    ...extra,
  })

describe("installSkillGeneration", () => {
  test("装进不可变 generation + current.json 指针 + 提交 V2 receipt", async () => {
    const r = await install("demo", { "SKILL.md": "---\nname: demo\n---\nbody" })
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
    await install("demo", { "SKILL.md": "v1", "extra.txt": "old file" })
    const r2 = await install("demo", { "SKILL.md": "v2" }) // 去掉 extra.txt
    expect(r2.ok).toBe(true)
    const live = resolveLiveGenerationDir(root, skillGenerationKey("demo"))!
    expect(fs.readFileSync(path.join(live, "SKILL.md"), "utf8")).toBe("v2")
    expect(fs.existsSync(path.join(live, "extra.txt"))).toBe(false) // 旧文件不残留
  })

  test("#336:commitReceipt(账本写)失败 → 事务回滚,generation 不切换(不谎报成功)", async () => {
    // 让 installs.json 变成目录 → upsertRecordV2 的原子写 rename 失败 → commitReceipt 抛错 → rollbackAll。
    fs.mkdirSync(path.join(root, "installs.json"), { recursive: true })
    const r = await install("demo", { "SKILL.md": "body" })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.stage).toBe("receipt-commit")
    // 回滚后无 live generation(current 未切换)。
    expect(resolveLiveGenerationDir(root, skillGenerationKey("demo"))).toBeNull()
  })

  test("supersede:成功安装后清除同名旧 flat 目录(防双真源)", async () => {
    const flat = path.join(root, "skills", "demo")
    fs.mkdirSync(flat, { recursive: true })
    fs.writeFileSync(path.join(flat, "SKILL.md"), "old flat install")
    const r = await install("demo", { "SKILL.md": "gen body" })
    expect(r.ok).toBe(true)
    expect(fs.existsSync(flat)).toBe(false) // 旧 flat 被 supersede
  })

  test("失败安装不 supersede 旧 flat 目录", async () => {
    const flat = path.join(root, "skills", "demo")
    fs.mkdirSync(flat, { recursive: true })
    fs.writeFileSync(path.join(flat, "SKILL.md"), "keep me")
    fs.mkdirSync(path.join(root, "installs.json"), { recursive: true }) // 逼 receipt 失败
    const r = await install("demo", { "SKILL.md": "body" })
    expect(r.ok).toBe(false)
    expect(fs.existsSync(path.join(flat, "SKILL.md"))).toBe(true) // 失败不动旧 flat
  })
})

describe("发现层投影", () => {
  test("skillGenerationLiveDirs 列出所有 skill 的 live generation 目录", async () => {
    await install("alpha", { "SKILL.md": "a" })
    await install("beta", { "SKILL.md": "b" })
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
