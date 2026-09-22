// `#1391` —— 自定义节点真源(写端)的判据:落盘字节固定字面量、原子性(写到一半失败 ⇒ 盘上仍是旧内容)、坏记录不落盘;
// 以及基线 §四 子票 1 的实现约束 —— **写模块不进 sidecar 的 import 闭包**,对着生产的闭包工具(process-fence-write-sites.ts
// sidecarSourceFiles / relativeImportClosure)实测,并用合成三文件臂证明那台仪器看得见 value import、看不见 type import。
// 全平台、electron-free、真文件系统(临时目录)。期望值手写字面量。

import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { readCustomProviderTruth, type CustomProviderRecord } from "./custom-provider-truth"
import { writeCustomProviderTruth } from "./custom-provider-truth-write"
import { relativeImportClosure, sidecarSourceFiles } from "./process-fence-write-sites"

const repoRoot = resolve(import.meta.dir, "../../../..")

function withTemp<T>(run: (dir: string) => T): T {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "custom-providers-write-")))
  try {
    return run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const openai: CustomProviderRecord = { id: "my-openai", name: "My OpenAI", compat: "openai", baseURL: "https://api.openai.com/v1", models: ["gpt-5.4"] }
const OPENAI_BYTES = '{"v":1,"providers":[{"id":"my-openai","name":"My OpenAI","compat":"openai","baseURL":"https://api.openai.com/v1","models":["gpt-5.4"]}]}\n'

describe("原子写:字节固定、无残留、失败不留半截", () => {
  test("写 → 落盘文本是固定字面量(输入键序乱也一样);目录里没有临时文件;覆盖写整份换;读端读得回", () => {
    withTemp((dir) => {
      const path = join(dir, "custom-providers", "prod.json")
      const shuffled = { models: ["gpt-5.4"], baseURL: "https://api.openai.com/v1", compat: "openai" as const, name: "My OpenAI", id: "my-openai" }
      writeCustomProviderTruth(path, [shuffled], fs)
      expect(readFileSync(path, "utf8")).toBe(OPENAI_BYTES)
      expect(readdirSync(join(dir, "custom-providers"))).toEqual(["prod.json"])
      expect(readCustomProviderTruth(path, { ...fs, log: () => {} })).toEqual({ ok: true, absent: false, providers: [openai] })
      writeCustomProviderTruth(path, [], fs)
      expect(readFileSync(path, "utf8")).toBe('{"v":1,"providers":[]}\n')
      expect(readdirSync(join(dir, "custom-providers"))).toEqual(["prod.json"])
    })
  })

  test("判据 2 · rename 中途抛 ⇒ 盘上仍是旧内容、临时文件收走、错误原样抛;writeFileSync 中途抛同样", () => {
    withTemp((dir) => {
      const path = join(dir, "prod.json")
      writeCustomProviderTruth(path, [openai], fs)
      const renameFails = {
        ...fs,
        renameSync: () => {
          throw new Error("EROFS: read-only file system")
        },
      }
      expect(() => writeCustomProviderTruth(path, [], renameFails)).toThrow("EROFS")
      expect(readFileSync(path, "utf8")).toBe(OPENAI_BYTES)
      expect(readdirSync(dir)).toEqual(["prod.json"])
      const writeFails = {
        ...fs,
        writeFileSync: () => {
          throw new Error("ENOSPC: no space left on device")
        },
      }
      expect(() => writeCustomProviderTruth(path, [], writeFails)).toThrow("ENOSPC")
      expect(readFileSync(path, "utf8")).toBe(OPENAI_BYTES)
      expect(readdirSync(dir)).toEqual(["prod.json"])
      // 对照臂:同一路径、正常 fs ⇒ 会写(手段不是对什么都答「没变」)
      writeCustomProviderTruth(path, [], fs)
      expect(readFileSync(path, "utf8")).toBe('{"v":1,"providers":[]}\n')
    })
  })

  test("坏记录不落盘:读端同一份判据在写之前把关,连目录都不建;已有的旧内容一个字节不动", () => {
    withTemp((dir) => {
      const path = join(dir, "custom-providers", "prod.json")
      const bad = [{ ...openai, apiKey: "sk-live-…" } as unknown as CustomProviderRecord]
      expect(() => writeCustomProviderTruth(path, bad, fs)).toThrow(`custom providers: refusing to write ${path} — providers[0] has unexpected key(s): apiKey (secrets never live here)`)
      expect(existsSync(join(dir, "custom-providers"))).toBe(false)
      writeCustomProviderTruth(path, [openai], fs)
      expect(() => writeCustomProviderTruth(path, [openai, { ...openai, name: "again" }], fs)).toThrow('providers[1].id duplicates an earlier record: "my-openai"')
      expect(readFileSync(path, "utf8")).toBe(OPENAI_BYTES)
      expect(readdirSync(join(dir, "custom-providers"))).toEqual(["prod.json"])
    })
  })
})

describe("判据 4 · 写模块不在 sidecar 的 import 闭包里(生产的闭包工具实测)", () => {
  test("sidecarSourceFiles 含基线点名的三个读侧模块(集合是活的),不含 custom-provider-truth-write.ts", () => {
    const files = sidecarSourceFiles(repoRoot)
    expect(files).toContain("packages/ui-mac/src/main/alpha-models.ts")
    expect(files).toContain("packages/ui-mac/src/main/ext-config.ts")
    expect(files).toContain("packages/ui-mac/src/main/alpha-environment.ts")
    expect(files).not.toContain("packages/ui-mac/src/main/custom-provider-truth-write.ts")
  })

  test("读模块自己的相对 import 闭包只有它自己:将来(#1392)把它接进 ext-config / alpha-models 时,写模块不会跟着进闭包", () => {
    const closure = relativeImportClosure(join(repoRoot, "packages/ui-mac/src/main/custom-provider-truth.ts")).map((p) => relative(repoRoot, p))
    expect(closure).toEqual(["packages/ui-mac/src/main/custom-provider-truth.ts"])
  })

  test("控制臂:闭包工具看得见 value import、看不见 type-only import(合成三文件)", () => {
    withTemp((dir) => {
      writeFileSync(join(dir, "writer.ts"), "export function write() {}\nexport type W = 1\n")
      writeFileSync(join(dir, "reader.ts"), 'import type { W } from "./writer"\nexport const r: W = 1\n')
      writeFileSync(join(dir, "entry.ts"), 'import { r } from "./reader"\nexport const e = r\n')
      const rel = (files: string[]) => files.map((p) => relative(dir, p)).sort()
      expect(rel(relativeImportClosure(join(dir, "entry.ts")))).toEqual(["entry.ts", "reader.ts"])
      writeFileSync(join(dir, "reader.ts"), 'import { write } from "./writer"\nexport const r = write\n')
      expect(rel(relativeImportClosure(join(dir, "entry.ts")))).toEqual(["entry.ts", "reader.ts", "writer.ts"])
    })
  })
})
