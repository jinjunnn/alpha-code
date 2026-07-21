import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, parse, resolve } from "node:path"
import {
  ENGINE_SCRATCH_CWD_NAME,
  ensureEngineScratchCwd,
  resolveEngineScratchCwd,
} from "./engine-scratch-cwd"

let root = ""

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "engine-scratch-cwd-"))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("engine scratch cwd", () => {
  test("creates an empty absolute directory under userData", () => {
    const userDataPath = join(root, "user-data")
    const directory = ensureEngineScratchCwd(userDataPath)

    expect(directory).toBe(join(userDataPath, ENGINE_SCRATCH_CWD_NAME))
    expect(existsSync(directory)).toBe(true)
    expect(readdirSync(directory)).toEqual([])

    mkdirSync(join(directory, ".git"))
    writeFileSync(join(directory, "stale"), "stale")
    expect(ensureEngineScratchCwd(userDataPath)).toBe(directory)
    expect(readdirSync(directory)).toEqual([])
  })

  test("never resolves to HOME or a filesystem root, even for unsafe base inputs", () => {
    const filesystemRoot = parse(resolve(root)).root
    const fromHome = resolveEngineScratchCwd(homedir())
    const fromRoot = resolveEngineScratchCwd(filesystemRoot)

    expect(fromHome).toBe(join(resolve(homedir()), ENGINE_SCRATCH_CWD_NAME))
    expect(fromRoot).toBe(join(filesystemRoot, ENGINE_SCRATCH_CWD_NAME))
    ;[fromHome, fromRoot].forEach((directory) => {
      expect(directory).not.toBe(resolve(homedir()))
      expect(directory).not.toBe(filesystemRoot)
    })
  })
})
