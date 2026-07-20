import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projectIpcHandler } from "./ext-project-entry"

describe("main project IPC identity boundary", () => {
  test("real home、home alias、unknown、retired `.alpha` link 均在 adoption/read/write body 前拒绝", async () => {
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
    symlinkSync(retired, join(project, ".alpha"), "dir")
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
})
