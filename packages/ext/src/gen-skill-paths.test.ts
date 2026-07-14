// REQ-100 #310 — skill generation live 目录投影进 cfg.skills.paths(current.json = 唯一原子真源)。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { injectSkillGenerationPaths, skillGenerationLiveDirs } from "./gen-skill-paths"

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "alpha-genpaths-"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 造一个 skill generation:ext-store/<key>/generations/<gen> + current.json 指针。 */
function makeGeneration(name: string, genId: string) {
  const store = join(root, "ext-store", `skill--${name}`)
  const genDir = join(store, "generations", genId)
  mkdirSync(genDir, { recursive: true })
  writeFileSync(join(genDir, "SKILL.md"), `---\nname: ${name}\n---\nbody`)
  writeFileSync(join(store, "current.json"), JSON.stringify({ v: 1, generation: genId, txId: "tx-x", switchedAt: "t" }))
  return genDir
}

describe("skillGenerationLiveDirs", () => {
  test("解析 current.json → live generation 目录(升序)", () => {
    const a = makeGeneration("alpha", "gen-000001-aabbcc")
    const b = makeGeneration("beta", "gen-000002-ddeeff")
    expect(skillGenerationLiveDirs(root).sort()).toEqual([a, b].sort())
  })

  test("无 ext-store → 空(不抛)", () => {
    expect(skillGenerationLiveDirs(root)).toEqual([])
  })

  test("current.json 缺失/损坏 → 跳过该 key(不投影半成品)", () => {
    // 有 generations 目录但无 current.json 指针 = 未 live,不投影。
    mkdirSync(join(root, "ext-store", "skill--dangling", "generations", "gen-000001-aaaaaa"), { recursive: true })
    const good = makeGeneration("ok", "gen-000001-bbbbbb")
    expect(skillGenerationLiveDirs(root)).toEqual([good])
  })

  test("指针指向不存在的 generation → 跳过", () => {
    const store = join(root, "ext-store", "skill--gone")
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, "current.json"), JSON.stringify({ v: 1, generation: "gen-000009-ffffff", txId: "t", switchedAt: "t" }))
    expect(skillGenerationLiveDirs(root)).toEqual([])
  })
})

describe("injectSkillGenerationPaths", () => {
  test("注入 live 目录到 cfg.skills.paths(用户条目在前,去重)", () => {
    const dir = makeGeneration("demo", "gen-000001-abcabc")
    const cfg: Record<string, unknown> = { skills: { paths: ["/Users/x/.alpha/skills"] } }
    const added = injectSkillGenerationPaths(cfg, root)
    expect(added).toEqual([dir])
    expect((cfg.skills as { paths: string[] }).paths).toEqual(["/Users/x/.alpha/skills", dir])
    // 幂等
    expect(injectSkillGenerationPaths(cfg, root)).toEqual([])
  })

  test("无 root / 无 generation → 无注入", () => {
    const cfg: Record<string, unknown> = {}
    expect(injectSkillGenerationPaths(cfg, undefined)).toEqual([])
    expect(injectSkillGenerationPaths(cfg, root)).toEqual([])
  })
})
