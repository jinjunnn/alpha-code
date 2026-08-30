import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projectIpcHandler, withProjectIpcEntryIdentity } from "./ext-project-entry"

describe("main project IPC identity boundary", () => {
  test("real home、home alias、unknown、retired `.code-puppy` link 均在 adoption/read/write body 前拒绝", async () => {
    const root = mkdtempSync(join(tmpdir(), "alpha-project-entry-"))
    const home = join(root, "home")
    const retired = join(home, ".alpha")
    const alias = join(root, "home-alias")
    const missing = join(root, "missing")
    const project = join(root, "project")
    mkdirSync(retired, { recursive: true })
    mkdirSync(project)
    writeFileSync(join(retired, "sentinel"), "untouched")
    writeFileSync(join(retired, "installs.json"), JSON.stringify({ version: 1, receipts: [] }))
    symlinkSync(home, alias, "dir")
    symlinkSync(retired, join(project, ".code-puppy"), "dir")
    let bodies = 0
    const handler = projectIpcHandler(
      home,
      (reason) => ({ prompted: false as const, granted: false as const, reason }),
      async () => {
        bodies++
        return { prompted: true as const, granted: true as const, reason: "admitted" }
      },
    )
    try {
      for (const directory of [home, alias, missing, project])
        expect(await handler({}, directory)).toMatchObject({ prompted: false, granted: false })
      expect(bodies).toBe(0)
      expect(readFileSync(join(retired, "sentinel"), "utf8")).toBe("untouched")
      expect(JSON.parse(readFileSync(join(retired, "installs.json"), "utf8"))).toEqual({ version: 1, receipts: [] })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("adoption 异步边界后 `.code-puppy` 换链 → trust 读取零执行并 fail-closed", async () => {
    const root = mkdtempSync(join(tmpdir(), "alpha-project-entry-race-"))
    const home = join(root, "home")
    const retired = join(home, ".alpha")
    const project = join(root, "project")
    const admittedRoot = join(project, ".code-puppy")
    const moved = join(project, ".alpha-before-race")
    mkdirSync(retired, { recursive: true })
    mkdirSync(admittedRoot, { recursive: true })
    writeFileSync(join(retired, "alpha.jsonc"), "retired sentinel")
    let releaseAdoption = () => {}
    let adoptionReached = () => {}
    const adoption = new Promise<void>((resolve) => (releaseAdoption = resolve))
    const reached = new Promise<void>((resolve) => (adoptionReached = resolve))
    let reads = 0
    const handler = projectIpcHandler(
      home,
      (reason) => ({ prompted: false as const, granted: false as const, reason }),
      async (_event, expected) => {
        adoptionReached()
        await adoption
        const read = withProjectIpcEntryIdentity(expected, home, (current) => {
          reads++
          return readFileSync(join(current.root, "alpha.jsonc"), "utf8")
        })
        return read.ok
          ? { prompted: true as const, granted: true as const, value: read.value }
          : { prompted: false as const, granted: false as const, reason: read.reason }
      },
    )
    try {
      const pending = handler({}, project)
      await reached
      renameSync(admittedRoot, moved)
      symlinkSync(retired, admittedRoot, "dir")
      releaseAdoption()

      expect(await pending).toMatchObject({ prompted: false, granted: false })
      expect(reads).toBe(0)
      expect(readFileSync(join(retired, "alpha.jsonc"), "utf8")).toBe("retired sentinel")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
