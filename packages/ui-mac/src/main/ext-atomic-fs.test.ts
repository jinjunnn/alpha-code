// REQ-100 —— fs 原语层单测:路径守卫(ADR-019 态度)+ 原子写。全部真盘临时目录,零 mock。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  confinedExistingPath,
  isSafeRelPath,
  resolveUnder,
  sha256FileSync,
  writeFileAtomicSync,
} from "./ext-atomic-fs"

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ext-atomic-"))
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe("isSafeRelPath", () => {
  test("accepts normal nested relative paths", () => {
    expect(isSafeRelPath("SKILL.md")).toBe(true)
    expect(isSafeRelPath("assets/img/logo.png")).toBe(true)
    expect(isSafeRelPath("a.b-c_d/e f.txt")).toBe(true)
  })

  test("rejects traversal, absolute, backslash, empty segments, control chars", () => {
    expect(isSafeRelPath("..")).toBe(false)
    expect(isSafeRelPath("a/../b")).toBe(false)
    expect(isSafeRelPath("./a")).toBe(false)
    expect(isSafeRelPath("/etc/passwd")).toBe(false)
    expect(isSafeRelPath("a\\b")).toBe(false)
    expect(isSafeRelPath("a//b")).toBe(false)
    expect(isSafeRelPath("")).toBe(false)
    expect(isSafeRelPath("a/\x00b")).toBe(false)
    expect(isSafeRelPath("a/\x1fb")).toBe(false)
  })

  test("rejects over-deep and over-long paths", () => {
    expect(isSafeRelPath(Array(33).fill("d").join("/"))).toBe(false)
    expect(isSafeRelPath("x".repeat(256))).toBe(false)
    expect(isSafeRelPath("a/".repeat(30) + "leaf")).toBe(true)
  })
})

describe("resolveUnder", () => {
  test("resolves inside the root", () => {
    expect(resolveUnder(root, "a/b.txt")).toBe(path.join(root, "a", "b.txt"))
  })

  test("rejects escapes and relative roots", () => {
    expect(resolveUnder(root, "../outside")).toBeNull()
    expect(resolveUnder("relative-root", "a")).toBeNull()
  })
})

describe("confinedExistingPath", () => {
  test("true for paths inside root, false outside / missing", () => {
    const inside = path.join(root, "child")
    fs.mkdirSync(inside)
    expect(confinedExistingPath(root, inside)).toBe(true)
    expect(confinedExistingPath(root, os.tmpdir())).toBe(false)
    expect(confinedExistingPath(root, path.join(root, "missing"))).toBe(false)
  })

  test("symlink escaping the root is refused (realpath guard)", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ext-atomic-outside-"))
    try {
      const link = path.join(root, "escape")
      fs.symlinkSync(outside, link)
      expect(confinedExistingPath(root, link)).toBe(false)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe("writeFileAtomicSync", () => {
  test("writes content, replaces atomically, leaves no tmp files", () => {
    const file = path.join(root, "nested", "state.json")
    writeFileAtomicSync(file, "one")
    writeFileAtomicSync(file, "two")
    expect(fs.readFileSync(file, "utf8")).toBe("two")
    const leftovers = fs.readdirSync(path.dirname(file)).filter((n) => n.includes(".tmp-"))
    expect(leftovers).toEqual([])
  })

  test("opts.mode applies to the final file (rename preserves tmp permissions)", () => {
    if (process.platform === "win32") return
    const file = path.join(root, "private.json")
    writeFileAtomicSync(file, "secret", { mode: 0o600 })
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })
})

describe("sha256FileSync", () => {
  test("matches known digest", () => {
    const file = path.join(root, "x.txt")
    fs.writeFileSync(file, "hello")
    expect(sha256FileSync(file)).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")
  })
})
