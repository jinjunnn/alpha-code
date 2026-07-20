// Unit tests for the `.alpha/` project workdir writer (ADR-019 / B3 artifact 回流). The module is
// electron-free and root-parameterized, so unlike ext-fs-installer we exercise REAL writes against a
// temp dir: scaffold seeding, run persistence, hostile artifact names, escape refusal, size caps.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  alphaRoot,
  assertProjectAlphaRootIdentity,
  ensureAlphaScaffold,
  isSafeRunId,
  resolveProjectAlphaRoot,
  sanitizeArtifactName,
  safeResolveInAlpha,
  saveCloudRun,
  type SaveRunDeps,
} from "./alpha-workdir"
import type { CloudJobStatus } from "../preload/types"

let projectDir: string
beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-workdir-"))
})
afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true })
})

const STATUS: CloudJobStatus = {
  api_version: "1",
  job_id: "job-1",
  status: "completed",
  autonomy: "pipeline",
  progress: { phase: "done" },
  artifact_ids: ["a1"],
  result: { ok: 1 },
  error: null,
}

// REQ-092:saveCloudRun 不再见到字节 —— download dep = 流式写入器(alpha-artifact-download),
// 这里以「把内容写到给定 target」的 mock 模拟其成功落盘副作用。
const okDownload =
  (content: string): SaveRunDeps["download"] =>
  async (_artifact, targetPath) => {
    fs.writeFileSync(targetPath, content)
    return {
      ok: true,
      path: targetPath,
      bytes: Buffer.byteLength(content),
      sha256: "0".repeat(64),
      verification: "unverified",
      via: "stream",
    }
  }

function deps(overrides: Partial<SaveRunDeps> = {}): SaveRunDeps {
  return {
    status: async () => STATUS,
    artifacts: async () => ({ job_id: "job-1", status: "completed", artifacts: [{ id: "a1", name: "report.md" }], artifact_ids: ["a1"] }),
    download: okDownload("# hi"),
    ...overrides,
  }
}

describe("isSafeRunId", () => {
  test.each([["job-1"], ["A1_b.2-c"]])("accepts %p", (id) => expect(isSafeRunId(id)).toBe(true))
  test.each([[""], ["../x"], ["a/b"], [".hidden"], ["a".repeat(200)], ["."], [".."]])("rejects %p", (id) =>
    expect(isSafeRunId(id)).toBe(false))
})

describe("sanitizeArtifactName", () => {
  test("strips path structure", () => expect(sanitizeArtifactName("../../etc/passwd", "fb")).toBe("passwd"))
  test("windows separators too", () => expect(sanitizeArtifactName("..\\..\\evil.exe", "fb")).toBe("evil.exe"))
  test("dotfile → fallback", () => expect(sanitizeArtifactName(".env", "fb")).toBe("fb"))
  test("empty/undefined → fallback", () => {
    expect(sanitizeArtifactName("", "fb")).toBe("fb")
    expect(sanitizeArtifactName(undefined, "fb")).toBe("fb")
  })
  test("control chars removed, length capped", () => {
    expect(sanitizeArtifactName("a\x00b\x1fc.txt", "fb")).toBe("abc.txt")
    expect(sanitizeArtifactName("x".repeat(300), "fb")).toHaveLength(128)
  })
})

describe("safeResolveInAlpha", () => {
  test("resolves inside .alpha", () => {
    expect(safeResolveInAlpha(projectDir, "runs", "r1")).toBe(path.join(fs.realpathSync(projectDir), ".alpha", "runs", "r1"))
  })
  test("refuses .. escape", () => {
    expect(safeResolveInAlpha(projectDir, "..", "outside")).toBeNull()
    expect(safeResolveInAlpha(projectDir, "runs", "..", "..", "..", "etc")).toBeNull()
  })
  test("refuses relative / missing / file-root project dirs", () => {
    expect(safeResolveInAlpha("relative/dir", "runs")).toBeNull()
    expect(safeResolveInAlpha(path.join(projectDir, "nope"), "runs")).toBeNull()
    expect(safeResolveInAlpha(path.parse(projectDir).root, "runs")).toBeNull()
  })
  test("refuses symlinked .alpha pointing outside the project", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-outside-"))
    try {
      fs.symlinkSync(outside, path.join(projectDir, ".alpha"))
      expect(safeResolveInAlpha(projectDir, "runs", "r1")).toBeNull()
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe("main project identity 三态", () => {
  test("real home、home alias、unknown 在任何 `.alpha` 读取/写入前拒绝", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-main-project-id-"))
    const home = path.join(root, "home")
    const project = path.join(root, "project")
    const alias = path.join(root, "home-alias")
    fs.mkdirSync(home)
    fs.mkdirSync(project)
    fs.symlinkSync(home, alias, "dir")
    try {
      expect(resolveProjectAlphaRoot(home, home).status).toBe("retired-home")
      expect(resolveProjectAlphaRoot(alias, home).status).toBe("retired-home")
      expect(resolveProjectAlphaRoot(path.join(root, "missing"), home).status).toBe("unknown")
      const admitted = resolveProjectAlphaRoot(project, home)
      expect(admitted.status).toBe("project")
      if (admitted.status === "project") expect(admitted.root).toBe(path.join(fs.realpathSync(project), ".alpha"))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("`.alpha → retired root` 与退休根内项目拒绝，sentinel 原样且无 scaffold", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-main-retired-"))
    const home = path.join(root, "home")
    const retired = path.join(home, ".alpha")
    const project = path.join(root, "project")
    fs.mkdirSync(path.join(retired, "nested"), { recursive: true })
    fs.mkdirSync(project)
    fs.writeFileSync(path.join(retired, "sentinel"), "untouched")
    fs.symlinkSync(retired, path.join(project, ".alpha"), "dir")
    try {
      expect(resolveProjectAlphaRoot(project, home).status).toBe("unknown")
      expect(resolveProjectAlphaRoot(path.join(retired, "nested"), home).status).toBe("retired-home")
      expect(fs.readFileSync(path.join(retired, "sentinel"), "utf8")).toBe("untouched")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("退休 `~/.alpha` realpath 遇 EACCES → unknown，不回退词法放行", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-main-retired-eacces-"))
    const home = path.join(root, "home")
    const project = path.join(root, "project")
    const locked = path.join(root, "locked")
    fs.mkdirSync(path.join(locked, "retired"), { recursive: true })
    fs.mkdirSync(home)
    fs.mkdirSync(project)
    fs.symlinkSync(path.join(locked, "retired"), path.join(home, ".alpha"), "dir")
    fs.chmodSync(locked, 0o000)
    try {
      expect(resolveProjectAlphaRoot(project, home)).toEqual({
        status: "unknown",
        reason: "retired global root identity cannot be confirmed",
      })
    } finally {
      fs.chmodSync(locked, 0o700)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("root-aware recovery 复验拒绝被换成 symlink 的 project root", () => {
    const root = alphaRoot(projectDir)!
    fs.mkdirSync(root)
    expect(() => assertProjectAlphaRootIdentity(root)).not.toThrow()
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-main-drift-"))
    fs.rmSync(root, { recursive: true })
    fs.symlinkSync(elsewhere, root, "dir")
    try {
      expect(() => assertProjectAlphaRootIdentity(root)).toThrow()
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true })
    }
  })
})

describe("ensureAlphaScaffold", () => {
  test("creates .alpha and seeds self-ignoring .gitignore once", () => {
    const root = ensureAlphaScaffold(projectDir)!
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf8")).toBe("*\n")
    fs.writeFileSync(path.join(root, ".gitignore"), "custom\n")
    ensureAlphaScaffold(projectDir) // idempotent — must not clobber user edits
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf8")).toBe("custom\n")
  })
})

describe("saveCloudRun", () => {
  test("happy path: status.json + contract.json + artifact bytes land under runs/<id>/", async () => {
    const res = await saveCloudRun(projectDir, "job-1", deps(), { autonomy: "pipeline", kind: "research" })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.files.sort()).toEqual(["artifacts/report.md", "contract.json", "status.json"].sort())
    expect(res.warnings).toEqual([])
    const runDir = path.join(projectDir, ".alpha", "runs", "job-1")
    expect(JSON.parse(fs.readFileSync(path.join(runDir, "status.json"), "utf8")).status).toBe("completed")
    expect(JSON.parse(fs.readFileSync(path.join(runDir, "contract.json"), "utf8")).kind).toBe("research")
    expect(fs.readFileSync(path.join(runDir, "artifacts", "report.md"), "utf8")).toBe("# hi")
    expect(fs.existsSync(path.join(projectDir, ".alpha", ".gitignore"))).toBe(true)
  })

  test("no contract → only status + artifacts", async () => {
    const res = await saveCloudRun(projectDir, "job-1", deps())
    expect(res.ok && !res.files.includes("contract.json")).toBe(true)
  })

  test("rejects bad run id and bad project dir before any I/O", async () => {
    expect(await saveCloudRun(projectDir, "../evil", deps())).toEqual({ ok: false, reason: "invalid run id" })
    expect(await saveCloudRun("/nope-not-here", "job-1", deps())).toEqual({ ok: false, reason: "invalid project directory" })
  })

  test("status error → ok:false, nothing written", async () => {
    const res = await saveCloudRun(projectDir, "job-1", deps({ status: async () => ({ error: "unauthorized" }) }))
    expect(res).toEqual({ ok: false, reason: "status: unauthorized" })
    expect(fs.existsSync(path.join(projectDir, ".alpha", "runs", "job-1", "status.json"))).toBe(false)
  })

  test("artifact list error degrades to warning; run still ok", async () => {
    const res = await saveCloudRun(projectDir, "job-1", deps({ artifacts: async () => ({ error: "network" }) }))
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.warnings).toEqual(["artifacts: network"])
  })

  test("hostile artifact name is sanitized into the artifacts dir (no escape)", async () => {
    const res = await saveCloudRun(
      projectDir,
      "job-1",
      deps({
        artifacts: async () => ({ job_id: "job-1", status: "completed", artifacts: [{ id: "a1", name: "../../../../pwned" }], artifact_ids: ["a1"] }),
      }),
    )
    expect(res.ok).toBe(true)
    expect(fs.existsSync(path.join(projectDir, ".alpha", "runs", "job-1", "artifacts", "pwned"))).toBe(true)
    expect(fs.existsSync(path.join(projectDir, "pwned"))).toBe(false)
  })

  test("name collision dedups with id prefix", async () => {
    const res = await saveCloudRun(
      projectDir,
      "job-1",
      deps({
        artifacts: async () => ({
          job_id: "job-1",
          status: "completed",
          artifacts: [{ id: "a1", name: "out.txt" }, { id: "a2", name: "out.txt" }],
          artifact_ids: ["a1", "a2"],
        }),
      }),
    )
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.files).toContain(path.join("artifacts", "a2-out.txt"))
  })

  test("download failure (e.g. over-limit at the streaming writer) degrades to warning, no file listed", async () => {
    const res = await saveCloudRun(
      projectDir,
      "job-1",
      deps({ download: async () => ({ ok: false, error: "over-limit", detail: "descriptor size 5 > max 2" }) }),
    )
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.warnings.some((w) => w.includes("over-limit"))).toBe(true)
      expect(res.files).toEqual(["status.json"])
      // REQ-092 AC#4:失败绝不产出看似成功的最终文件
      expect(fs.readdirSync(path.join(projectDir, ".alpha", "runs", "job-1", "artifacts"))).toEqual([])
    }
  })

  test("download dep receives the guarded in-.alpha target path (path-escape guard reuse)", async () => {
    let seenTarget = ""
    const res = await saveCloudRun(
      projectDir,
      "job-1",
      deps({
        download: async (_a, targetPath) => {
          seenTarget = targetPath
          fs.writeFileSync(targetPath, "x")
          return { ok: true, path: targetPath, bytes: 1, sha256: "0".repeat(64), verification: "unverified", via: "stream" }
        },
      }),
    )
    expect(res.ok).toBe(true)
    expect(seenTarget).toBe(path.join(fs.realpathSync(projectDir), ".alpha", "runs", "job-1", "artifacts", "report.md"))
  })
})
