// Unit tests for the artifacts.json manifest (REQ-093 A 侧,#185):round-trip、原子写(崩溃遗留 tmp)、
// 未知未来版本只读、篡改=corrupt、savedPath 相对路径不变量、manifest 内容无绝对路径。
// alpha-workdir.test.ts 同款 harness:electron-free 模块 + 真实临时目录写读。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { artifactIdFor, type ArtifactDescriptor } from "../shared/cloud-artifact-descriptor"
import {
  ARTIFACT_MANIFEST_FILE,
  isSafeSavedPath,
  readArtifactManifest,
  validateArtifactManifest,
  writeArtifactManifest,
  type ArtifactManifestV1,
  type ManifestArtifactEntry,
} from "./artifact-manifest"

let projectDir: string
const RUN = "job_1234"
beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-manifest-"))
  fs.mkdirSync(path.join(projectDir, ".code-puppy", "runs", RUN, "artifacts"), { recursive: true })
})
afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true })
})

const SHA = "a".repeat(64)

function descriptor(overrides: Partial<ArtifactDescriptor> = {}): ArtifactDescriptor {
  const meta = { name: overrides.name ?? "report.md", size: overrides.size ?? 4, sha256: overrides.sha256 ?? SHA }
  const id = overrides.id ?? artifactIdFor(RUN, 0, meta)
  return {
    schemaVersion: 1,
    id,
    source: "cloud",
    name: meta.name,
    size: meta.size,
    sha256: meta.sha256,
    trust: "sandboxed",
    role: "primary",
    contentRef: { kind: "http-stream", url: `/v1/cloud/artifacts/${id}/content`, auth: "bearer" },
    verification: { status: "verified" },
    provenance: { producer: "pipeline", jobId: RUN },
    ...overrides,
  }
}

function entry(overrides: Partial<ManifestArtifactEntry["local"]> = {}, d: ArtifactDescriptor = descriptor()): ManifestArtifactEntry {
  return {
    descriptor: d,
    local: {
      savedPath: "artifacts/report.md",
      downloadedAt: "2026-07-12T00:00:00.000Z",
      bytesOnDisk: 4,
      state: "verified",
      verifiedSha256: SHA,
      warnings: [],
      ...overrides,
    },
  }
}

function manifest(entries: ManifestArtifactEntry[]): ArtifactManifestV1 {
  return { schemaVersion: 1, runId: RUN, updatedAt: "2026-07-12T00:00:00.000Z", artifacts: entries }
}

const manifestPath = () => path.join(projectDir, ".code-puppy", "runs", RUN, ARTIFACT_MANIFEST_FILE)

describe("isSafeSavedPath", () => {
  test.each([["artifacts/report.md"], ["artifacts/sub/data.csv"], ["artifacts/中文 名.pdf"]])("accepts %p", (p) =>
    expect(isSafeSavedPath(p)).toBe(true))
  test.each([
    [""],
    ["report.md"], // 必须落在 artifacts/ 内(保护 run 元数据文件)
    ["artifacts"], // 目录本身不是产物
    ["status.json"],
    ["artifacts/../status.json"],
    ["artifacts/./x"],
    ["artifacts//x"],
    ["/etc/passwd"],
    ["/tmp/artifacts/x"],
    ["artifacts\\evil.exe"],
    ["C:/artifacts/evil.exe"],
    ["artifacts/.hidden"],
    ["artifacts/a\x00b"],
    ["artifacts/" + "x".repeat(600)],
  ])("rejects %p", (p) => expect(isSafeSavedPath(p)).toBe(false))
})

describe("round-trip", () => {
  test("write → read returns the identical manifest", () => {
    const m = manifest([entry()])
    const written = writeArtifactManifest(projectDir, RUN, m)
    expect(written.ok).toBe(true)
    const read = readArtifactManifest(projectDir, RUN)
    expect(read).toEqual({ ok: true, manifest: m })
  })

  test("no manifest yet → ok with null (writable empty)", () => {
    expect(readArtifactManifest(projectDir, RUN)).toEqual({ ok: true, manifest: null })
  })

  test("serialized manifest contains no absolute paths (relative-path invariant)", () => {
    writeArtifactManifest(projectDir, RUN, manifest([entry()]))
    const raw = fs.readFileSync(manifestPath(), "utf8")
    expect(raw.includes(projectDir)).toBe(false)
    expect(raw.includes(os.tmpdir())).toBe(false)
    for (const e of (JSON.parse(raw) as ArtifactManifestV1).artifacts) {
      expect(path.isAbsolute(e.local.savedPath)).toBe(false)
    }
  })
})

describe("atomic write", () => {
  test("crash-sim: leftover tmp file is ignored by read and does not block the next write", () => {
    // 模拟上次写到一半崩溃:目录里躺着一个残缺 tmp
    fs.writeFileSync(manifestPath() + ".tmp-9999-dead", "{ half written")
    expect(readArtifactManifest(projectDir, RUN)).toEqual({ ok: true, manifest: null })
    const m = manifest([entry()])
    expect(writeArtifactManifest(projectDir, RUN, m).ok).toBe(true)
    expect(readArtifactManifest(projectDir, RUN)).toEqual({ ok: true, manifest: m })
    // 残留 tmp 不会被误当 manifest,最终文件是完整 JSON
    expect(JSON.parse(fs.readFileSync(manifestPath(), "utf8")).schemaVersion).toBe(1)
  })

  test("invalid manifest is refused loudly — nothing lands on disk", () => {
    const bad = manifest([entry({ savedPath: "../escape.md" })])
    const res = writeArtifactManifest(projectDir, RUN, bad)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain("relative-path invariant")
    expect(fs.existsSync(manifestPath())).toBe(false)
  })

  test("absolute savedPath is refused", () => {
    const bad = manifest([entry({ savedPath: path.join(projectDir, ".code-puppy", "runs", RUN, "artifacts", "x") })])
    expect(writeArtifactManifest(projectDir, RUN, bad).ok).toBe(false)
  })

  test("runId mismatch between manifest and target run is refused", () => {
    const m = { ...manifest([entry()]), runId: "job_other" }
    expect(writeArtifactManifest(projectDir, RUN, m).ok).toBe(false)
  })

  test("unsafe run id / escaping run id is refused", () => {
    expect(writeArtifactManifest(projectDir, "../evil", manifest([]))).toEqual({ ok: false, reason: "invalid run id" })
  })
})

describe("versioning + tamper detection", () => {
  test("unknown future version → read-only error, file untouched", () => {
    const future = JSON.stringify({ schemaVersion: 2, runId: RUN, updatedAt: "x", artifacts: [], newField: true })
    fs.writeFileSync(manifestPath(), future)
    const read = readArtifactManifest(projectDir, RUN)
    expect(read).toEqual({ ok: false, reason: "unsupported-version", version: "2" })
    // 绝不静默重写(REQ-093 AC#8)
    expect(fs.readFileSync(manifestPath(), "utf8")).toBe(future)
  })

  test("writing a future-version manifest is refused", () => {
    const m = { ...manifest([]), schemaVersion: 2 } as unknown as ArtifactManifestV1
    expect(writeArtifactManifest(projectDir, RUN, m).ok).toBe(false)
  })

  test("corrupt JSON → corrupt (read-only), not silently replaced", () => {
    fs.writeFileSync(manifestPath(), "{ not json")
    const read = readArtifactManifest(projectDir, RUN)
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.reason).toBe("corrupt")
  })

  test("tampered entry (path traversal injected by hand) → corrupt", () => {
    const m = manifest([entry()])
    writeArtifactManifest(projectDir, RUN, m)
    const raw = JSON.parse(fs.readFileSync(manifestPath(), "utf8"))
    raw.artifacts[0].local.savedPath = "../../../etc/passwd"
    fs.writeFileSync(manifestPath(), JSON.stringify(raw))
    const read = readArtifactManifest(projectDir, RUN)
    expect(read.ok).toBe(false)
    if (!read.ok && read.reason === "corrupt") expect(read.detail).toContain("relative-path invariant")
  })

  test("manifest transplanted from another run (runId mismatch) → corrupt", () => {
    const m = { ...manifest([entry()]), runId: "job_5678" }
    fs.writeFileSync(manifestPath(), JSON.stringify(m))
    const read = readArtifactManifest(projectDir, RUN)
    expect(read.ok).toBe(false)
    if (!read.ok && read.reason === "corrupt") expect(read.detail).toContain("runId mismatch")
  })
})

describe("validateArtifactManifest", () => {
  test("duplicate artifact ids are refused", () => {
    const e1 = entry()
    const e2 = entry({ savedPath: "artifacts/other.md" })
    const res = validateArtifactManifest(manifest([e1, e2]))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join()).toContain("duplicate artifact id")
  })

  test("duplicate savedPath is refused (同名不覆盖)", () => {
    const e1 = entry()
    const e2 = entry({}, descriptor({ name: "other.md" }))
    const res = validateArtifactManifest(manifest([e1, e2]))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join()).toContain("duplicate savedPath")
  })

  test("absolute contentRef.url is refused by the pinned descriptor schema", () => {
    const d = descriptor()
    d.contentRef = { kind: "http-stream", url: "https://cloud.example.com/v1/x/content", auth: "bearer" }
    const res = validateArtifactManifest(manifest([entry({}, d)]))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join()).toContain("pinned schema validation")
  })

  test("bad descriptor enums / sha format are refused", () => {
    const d = descriptor({ sha256: "not-a-sha" })
    expect(validateArtifactManifest(manifest([entry({}, d)])).ok).toBe(false)
    const d2 = descriptor()
    ;(d2 as unknown as Record<string, unknown>).trust = "definitely-trust-me"
    expect(validateArtifactManifest(manifest([entry({}, d2)])).ok).toBe(false)
  })
})
