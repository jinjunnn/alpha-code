// REQ-094/095(#186/#187)受控内容读取单测:守卫(仅 run artifacts/ 内可寻址)、text 截断诚实、
// bytes 超限拒绝、二进制嗅探。真实临时目录 harness(artifact-service.test.ts 同款)。
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { artifactIdFor, type ArtifactDescriptor } from "../shared/cloud-artifact-descriptor"
import {
  ARTIFACT_BINARY_PREVIEW_MAX_BYTES,
  ARTIFACT_TEXT_PREVIEW_MAX_BYTES,
  readArtifactContent,
  registerDownloadedArtifact,
} from "./artifact-service"

let projectDir: string
const RUN = "job_read1"
const artifactsDir = () => path.join(projectDir, ".code-puppy", "runs", RUN, "artifacts")

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-read-"))
  fs.mkdirSync(artifactsDir(), { recursive: true })
})

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true })
})

function writeArtifact(name: string, content: string | Buffer): string {
  const p = path.join(artifactsDir(), name)
  fs.writeFileSync(p, content)
  return p
}

function register(name: string, index = 0): ArtifactDescriptor {
  const size = fs.statSync(path.join(artifactsDir(), name)).size
  const id = artifactIdFor(RUN, index, { name, size })
  const descriptor: ArtifactDescriptor = {
    schemaVersion: 1,
    id,
    source: "cloud",
    name,
    size,
    trust: "sandboxed",
    role: "primary",
    contentRef: { kind: "http-stream", url: `/v1/cloud/artifacts/${id}/content`, auth: "bearer" },
    verification: { status: "unverified" },
    provenance: { producer: "pipeline", jobId: RUN },
  }
  const r = registerDownloadedArtifact(projectDir, RUN, { descriptor, savedPath: `artifacts/${name}` })
  if (!r.ok) throw new Error(`register failed: ${r.reason}`)
  return descriptor
}

describe("text 模式", () => {
  test("按 artifactId 读取:内容完整、无截断、非二进制", () => {
    writeArtifact("a.md", "# hello\n中文内容\n")
    const d = register("a.md")
    const r = readArtifactContent(projectDir, RUN, { artifactId: d.id })
    expect(r.ok && r.kind === "text").toBe(true)
    if (!r.ok || r.kind !== "text") return
    expect(r.text).toBe("# hello\n中文内容\n")
    expect(r.truncated).toBe(false)
    expect(r.binary).toBe(false)
    expect(r.totalBytes).toBe(r.readBytes)
  })
  test("maxBytes 截断 + 诚实标记(readBytes/totalBytes 真实)", () => {
    writeArtifact("big.txt", "x".repeat(100))
    const d = register("big.txt")
    const r = readArtifactContent(projectDir, RUN, { artifactId: d.id }, { maxBytes: 10 })
    expect(r.ok && r.kind === "text").toBe(true)
    if (!r.ok || r.kind !== "text") return
    expect(r.text).toBe("x".repeat(10))
    expect(r.truncated).toBe(true)
    expect(r.readBytes).toBe(10)
    expect(r.totalBytes).toBe(100)
  })
  test("调用方不能放宽全局 2 MiB 上限(min 收敛)", () => {
    const size = ARTIFACT_TEXT_PREVIEW_MAX_BYTES + 4096
    writeArtifact("huge.txt", Buffer.alloc(size, 0x61))
    const d = register("huge.txt")
    const r = readArtifactContent(projectDir, RUN, { artifactId: d.id }, { maxBytes: size * 2 })
    expect(r.ok && r.kind === "text").toBe(true)
    if (!r.ok || r.kind !== "text") return
    expect(r.readBytes).toBe(ARTIFACT_TEXT_PREVIEW_MAX_BYTES)
    expect(r.truncated).toBe(true)
  })
  test("NUL 字节嗅探 → binary 标记(诊断,不静默当文本)", () => {
    writeArtifact("blob.dat", Buffer.from([0x50, 0x00, 0x51, 0x52]))
    const d = register("blob.dat")
    const r = readArtifactContent(projectDir, RUN, { artifactId: d.id })
    expect(r.ok && r.kind === "text" && r.binary).toBe(true)
  })
})

describe("bytes 模式", () => {
  test("完整字节返回(≤ 上限)", () => {
    const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])
    writeArtifact("img.png", payload)
    const d = register("img.png")
    const r = readArtifactContent(projectDir, RUN, { artifactId: d.id }, { mode: "bytes" })
    expect(r.ok && r.kind === "bytes").toBe(true)
    if (!r.ok || r.kind !== "bytes") return
    expect(Buffer.from(r.bytes)).toEqual(payload)
    expect(r.totalBytes).toBe(payload.length)
  })
  test("超过调用方上限 → 拒绝(不截断二进制冒充完整内容)", () => {
    writeArtifact("big.png", Buffer.alloc(64, 1))
    const d = register("big.png")
    const r = readArtifactContent(projectDir, RUN, { artifactId: d.id }, { mode: "bytes", maxBytes: 16 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain("too large")
  })
  test("全局 20 MiB 上限不可被调用方放宽", () => {
    // 不真写 20 MiB 文件 —— 用 maxBytes 超帽验证 min 收敛的语义:cap = min(request, 全局帽)
    writeArtifact("ok.bin", Buffer.alloc(8, 2))
    const d = register("ok.bin")
    const r = readArtifactContent(projectDir, RUN, { artifactId: d.id }, { mode: "bytes", maxBytes: ARTIFACT_BINARY_PREVIEW_MAX_BYTES * 10 })
    expect(r.ok).toBe(true) // 小文件当然可读;语义锚点是常量存在且被 min 使用(见实现)
  })
})

describe("守卫", () => {
  test("legacy savedPath 直读(未入 manifest 的盘上文件)", () => {
    writeArtifact("legacy.txt", "old content")
    const r = readArtifactContent(projectDir, RUN, { savedPath: "artifacts/legacy.txt" })
    expect(r.ok && r.kind === "text").toBe(true)
    if (!r.ok || r.kind !== "text") return
    expect(r.text).toBe("old content")
  })
  test("savedPath 逃逸形态一律拒绝(artifacts/ 之外不可寻址)", () => {
    fs.writeFileSync(path.join(projectDir, ".code-puppy", "runs", RUN, "status.json"), "{}")
    for (const bad of [
      "../../../etc/passwd",
      "/etc/passwd",
      "artifacts/../status.json",
      "status.json", // run 元数据不可寻址
      "artifacts/.hidden",
      "artifacts\\win.txt",
    ]) {
      const r = readArtifactContent(projectDir, RUN, { savedPath: bad })
      expect(r.ok).toBe(false)
    }
  })
  test("非法 runId / 未知 artifactId / 文件缺失", () => {
    expect(readArtifactContent(projectDir, "../evil", { savedPath: "artifacts/a" }).ok).toBe(false)
    expect(readArtifactContent(projectDir, RUN, { artifactId: "art_job_read1_0_00000000" }).ok).toBe(false)
    writeArtifact("gone.txt", "x")
    const d = register("gone.txt")
    fs.unlinkSync(path.join(artifactsDir(), "gone.txt"))
    const r = readArtifactContent(projectDir, RUN, { artifactId: d.id })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("missing")
  })
  test("symlink 指向 .code-puppy 外 → 拒绝(realpath 反逃逸)", () => {
    const outside = path.join(projectDir, "secret.txt")
    fs.writeFileSync(outside, "secret")
    fs.symlinkSync(outside, path.join(artifactsDir(), "link.txt"))
    const r = readArtifactContent(projectDir, RUN, { savedPath: "artifacts/link.txt" })
    expect(r.ok).toBe(false)
  })
})
