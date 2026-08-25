// Unit tests for the main-owned ArtifactService (REQ-093 A 侧,#185):register/list/reconcile
// (missing / size drift / sha mismatch)、verify(离线篡改检测)、path-escape 拒绝、GC 原子性、
// 字节核算、legacy 只读发现、未来版本只读。真实临时目录 harness(alpha-workdir.test.ts 同款)。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { artifactIdFor, type ArtifactDescriptor } from "../shared/cloud-artifact-descriptor"
import { ARTIFACT_MANIFEST_FILE, readArtifactManifest } from "./artifact-manifest"
import {
  MAX_ARTIFACTS_PER_RUN,
  listRunArtifacts,
  projectArtifactUsage,
  registerDownloadedArtifact,
  registeredArtifactNameOwner,
  removeArtifact,
  resolveArtifact,
  runArtifactUsage,
  verifyArtifact,
} from "./artifact-service"

let projectDir: string
const RUN = "job_1234"
const runDir = () => path.join(projectDir, ".alpha", "runs", RUN)
const artifactsDir = () => path.join(runDir(), "artifacts")
const manifestPath = () => path.join(runDir(), ARTIFACT_MANIFEST_FILE)

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-service-"))
  fs.mkdirSync(artifactsDir(), { recursive: true })
})
afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true })
})

const sha256 = (data: string) => crypto.createHash("sha256").update(data).digest("hex")

/** 落一个真实文件 + 与其内容一致的 descriptor(sha/size 都真),返回 register 所需输入。 */
function seedArtifact(name: string, content: string, index = 0) {
  fs.writeFileSync(path.join(artifactsDir(), name), content)
  const digest = sha256(content)
  const meta = { name, size: Buffer.byteLength(content), sha256: digest }
  const id = artifactIdFor(RUN, index, meta)
  const descriptor: ArtifactDescriptor = {
    schemaVersion: 1,
    id,
    source: "cloud",
    name,
    size: meta.size,
    sha256: digest,
    claimedMime: "text/markdown",
    trust: "sandboxed",
    role: "primary",
    contentRef: { kind: "http-stream", url: `/v1/cloud/artifacts/${id}/content`, auth: "bearer" },
    verification: { status: "verified" },
    provenance: { producer: "pipeline", jobId: RUN },
  }
  return { descriptor, savedPath: `artifacts/${name}`, digest }
}

describe("registerDownloadedArtifact (#184 集成点)", () => {
  test("happy path: sha 复核一致 → verified,manifest 原子落盘,字节取自 stat", () => {
    const a = seedArtifact("report.md", "# hi")
    const res = registerDownloadedArtifact(projectDir, RUN, {
      descriptor: a.descriptor,
      savedPath: a.savedPath,
      verifiedSha256: a.digest,
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.entry.local.state).toBe("verified")
    expect(res.entry.local.bytesOnDisk).toBe(4)
    const read = readArtifactManifest(projectDir, RUN)
    expect(read.ok && read.manifest?.artifacts.length).toBe(1)
  })

  test("sha mismatch at register → state=mismatch with warning (不假报 verified)", () => {
    const a = seedArtifact("report.md", "# hi")
    const res = registerDownloadedArtifact(projectDir, RUN, {
      descriptor: a.descriptor,
      savedPath: a.savedPath,
      verifiedSha256: sha256("tampered"),
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.entry.local.state).toBe("mismatch")
    expect(res.entry.local.warnings.join()).toContain("sha256 mismatch")
  })

  test("no digest anywhere → honest unverified", () => {
    const a = seedArtifact("blob.bin", "data")
    const d = { ...a.descriptor }
    delete d.sha256
    d.verification = { status: "unverified" }
    const res = registerDownloadedArtifact(projectDir, RUN, { descriptor: d, savedPath: a.savedPath })
    expect(res.ok && res.entry.local.state).toBe("unverified")
  })

  test("descriptor size drift vs disk (no digest) → mismatch", () => {
    const a = seedArtifact("blob.bin", "data")
    const d = { ...a.descriptor, size: 9999 }
    delete d.sha256
    const res = registerDownloadedArtifact(projectDir, RUN, { descriptor: d, savedPath: a.savedPath })
    expect(res.ok && res.entry.local.state).toBe("mismatch")
  })

  test("claimedMime vs detectedMime conflict → warning(诚实并列,不改 trust)", () => {
    const a = seedArtifact("report.md", "# hi")
    const res = registerDownloadedArtifact(projectDir, RUN, {
      descriptor: a.descriptor,
      savedPath: a.savedPath,
      verifiedSha256: a.digest,
      detectedMime: "application/zip",
      detector: "alpha-magic/1",
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.entry.local.warnings.join()).toContain("mime conflict")
    expect(res.entry.descriptor.trust).toBe("sandboxed") // trust 不被本地重推导
  })

  test.each([
    ["../outside.md"],
    ["artifacts/../../escape.md"],
    ["/etc/passwd"],
    ["artifacts\\evil.exe"],
    ["status.json"], // run 元数据不可被登记为产物
    ["artifacts.json"],
  ])("path-escape / reserved savedPath %p is rejected", (savedPath) => {
    const a = seedArtifact("report.md", "# hi")
    const res = registerDownloadedArtifact(projectDir, RUN, { descriptor: a.descriptor, savedPath })
    expect(res.ok).toBe(false)
  })

  test("symlinked artifact escaping .alpha is rejected by the realpath guard", () => {
    const outside = path.join(projectDir, "outside.txt") // 项目内但 .alpha 外
    fs.writeFileSync(outside, "secret")
    fs.symlinkSync(outside, path.join(artifactsDir(), "link.txt"))
    const a = seedArtifact("report.md", "# hi")
    const res = registerDownloadedArtifact(projectDir, RUN, { descriptor: a.descriptor, savedPath: "artifacts/link.txt" })
    expect(res.ok).toBe(false)
  })

  test("file not on disk yet → refused (register 只在原子 rename 之后)", () => {
    const a = seedArtifact("report.md", "# hi")
    const res = registerDownloadedArtifact(projectDir, RUN, { descriptor: a.descriptor, savedPath: "artifacts/nope.md" })
    expect(res).toEqual({ ok: false, reason: "file not found on disk (register after atomic rename)" })
  })

  test("upsert by id;同一 savedPath 被其他 id 占用 → 拒绝(同名不覆盖)", () => {
    const a = seedArtifact("report.md", "# hi")
    expect(registerDownloadedArtifact(projectDir, RUN, { descriptor: a.descriptor, savedPath: a.savedPath, verifiedSha256: a.digest }).ok).toBe(true)
    // 同 id 重登记 = upsert,不产生第二条
    expect(registerDownloadedArtifact(projectDir, RUN, { descriptor: a.descriptor, savedPath: a.savedPath, verifiedSha256: a.digest }).ok).toBe(true)
    const list = listRunArtifacts(projectDir, RUN)
    expect(list.ok && list.entries.length).toBe(1)
    // 不同 id 抢同一 savedPath → 拒绝
    const b = seedArtifact("other.md", "# other", 1)
    const res = registerDownloadedArtifact(projectDir, RUN, { descriptor: b.descriptor, savedPath: a.savedPath })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain("already registered")
  })

  // #901: 大小写不敏感文件系统(APFS 默认)上 "artifacts/Report.pdf" 与 "artifacts/report.pdf" 是
  // 同一份磁盘字节——manifest 的同名守卫必须用折叠键(NFC + toLowerCase)比较,不是精确字符串,
  // 否则两个不同 id 的记录会各自"合法"地共享一份文件而互不知情。
  test("同一 savedPath 折叠键相同、精确字符串不同 → 仍拒绝(#901)", () => {
    const a = seedArtifact("Report.pdf", "AAA", 0)
    expect(registerDownloadedArtifact(projectDir, RUN, { descriptor: a.descriptor, savedPath: a.savedPath, verifiedSha256: a.digest }).ok).toBe(true)
    const b = seedArtifact("report.pdf", "BBB", 1)
    const res = registerDownloadedArtifact(projectDir, RUN, { descriptor: b.descriptor, savedPath: b.savedPath, verifiedSha256: b.digest })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain("already registered")
    const list = listRunArtifacts(projectDir, RUN)
    expect(list.ok && list.entries.length).toBe(1)
  })

  test("future-version manifest → register refused (read-only)", () => {
    fs.writeFileSync(manifestPath(), JSON.stringify({ schemaVersion: 99, runId: RUN, artifacts: [] }))
    const a = seedArtifact("report.md", "# hi")
    const res = registerDownloadedArtifact(projectDir, RUN, { descriptor: a.descriptor, savedPath: a.savedPath })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain("unsupported schemaVersion 99")
    // 只读:文件原样
    expect(JSON.parse(fs.readFileSync(manifestPath(), "utf8")).schemaVersion).toBe(99)
  })

  test("配额基线从 registry 单点导出;admission 警告不污染已登记 entry", () => {
    const a = seedArtifact("report.md", "# hi")
    expect(MAX_ARTIFACTS_PER_RUN).toBe(256)
    const res = registerDownloadedArtifact(projectDir, RUN, { descriptor: a.descriptor, savedPath: a.savedPath, verifiedSha256: a.digest })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.entry.local.warnings).toEqual([])
  })
})

// #1112:预约端(reserveArtifactSavedName)靠这个查询区分「同一件重下」与「同名的另一件」。
// 判据与 register 的 pathOwner 检查同一比较(折叠键、含盘上文件已消失的条目),两端不一致
// 就会重现 C5.5:字节先覆盖、登记后拒绝、manifest 与盘面分叉。
describe("registeredArtifactNameOwner (#1112)", () => {
  test("registered exact name → owning artifactId;case-folded variant hits the same owner (#901 折叠键)", () => {
    const a = seedArtifact("report.bin", "AAA")
    expect(registerDownloadedArtifact(projectDir, RUN, { descriptor: a.descriptor, savedPath: a.savedPath, verifiedSha256: a.digest }).ok).toBe(true)
    expect(registeredArtifactNameOwner(projectDir, RUN, "report.bin")).toBe(a.descriptor.id)
    expect(registeredArtifactNameOwner(projectDir, RUN, "REPORT.BIN")).toBe(a.descriptor.id)
  })

  test("unregistered name / no manifest yet → undefined", () => {
    expect(registeredArtifactNameOwner(projectDir, RUN, "nothing.bin")).toBeUndefined()
    const a = seedArtifact("report.bin", "AAA")
    registerDownloadedArtifact(projectDir, RUN, { descriptor: a.descriptor, savedPath: a.savedPath, verifiedSha256: a.digest })
    expect(registeredArtifactNameOwner(projectDir, RUN, "other.bin")).toBeUndefined()
  })

  test("ledger claim outlives the on-disk file — the name stays owned after deletion", () => {
    // register 对账本占用的名字一律拒写,与文件在不在无关;预约端读到的归属必须一致,
    // 否则「文件被手动删掉后,同名的另一件」会走回覆盖-后拒绝那条路。
    const a = seedArtifact("report.bin", "AAA")
    registerDownloadedArtifact(projectDir, RUN, { descriptor: a.descriptor, savedPath: a.savedPath, verifiedSha256: a.digest })
    fs.rmSync(path.join(artifactsDir(), "report.bin"))
    expect(registeredArtifactNameOwner(projectDir, RUN, "report.bin")).toBe(a.descriptor.id)
  })

  test("corrupt / future-version manifest → undefined(register 同态整体拒写,预约退回纯磁盘判断)", () => {
    fs.writeFileSync(manifestPath(), "{ not json")
    expect(registeredArtifactNameOwner(projectDir, RUN, "report.bin")).toBeUndefined()
    fs.writeFileSync(manifestPath(), JSON.stringify({ schemaVersion: 99, runId: RUN, artifacts: [] }))
    expect(registeredArtifactNameOwner(projectDir, RUN, "report.bin")).toBeUndefined()
  })
})

describe("listRunArtifacts + reconcile", () => {
  test("missing file ⇒ state=missing,降级持久化(重启不回显旧 verified)", () => {
    const a = seedArtifact("report.md", "# hi")
    registerDownloadedArtifact(projectDir, RUN, { descriptor: a.descriptor, savedPath: a.savedPath, verifiedSha256: a.digest })
    fs.unlinkSync(path.join(artifactsDir(), "report.md"))
    const list = listRunArtifacts(projectDir, RUN)
    expect(list.ok && list.entries[0].local.state).toBe("missing")
    // 持久化:直接读盘上 manifest
    const read = readArtifactManifest(projectDir, RUN)
    expect(read.ok && read.manifest?.artifacts[0].local.state).toBe("missing")
  })

  test("size drift ⇒ state=mismatch,降级持久化", () => {
    const a = seedArtifact("report.md", "# hi")
    registerDownloadedArtifact(projectDir, RUN, { descriptor: a.descriptor, savedPath: a.savedPath, verifiedSha256: a.digest })
    fs.appendFileSync(path.join(artifactsDir(), "report.md"), " EXTRA BYTES")
    const list = listRunArtifacts(projectDir, RUN)
    expect(list.ok && list.entries[0].local.state).toBe("mismatch")
    const read = readArtifactManifest(projectDir, RUN)
    expect(read.ok && read.manifest?.artifacts[0].local.state).toBe("mismatch")
  })

  test("file reappears after missing → unverified (不自动回 verified)", () => {
    const a = seedArtifact("report.md", "# hi")
    registerDownloadedArtifact(projectDir, RUN, { descriptor: a.descriptor, savedPath: a.savedPath, verifiedSha256: a.digest })
    const file = path.join(artifactsDir(), "report.md")
    fs.unlinkSync(file)
    listRunArtifacts(projectDir, RUN) // 持久化 missing
    fs.writeFileSync(file, "# hi") // 同尺寸回归
    const list = listRunArtifacts(projectDir, RUN)
    expect(list.ok && list.entries[0].local.state).toBe("unverified")
  })

  test("legacy run(无 artifacts.json)→ 只读发现,不持久化、不假报 verified", () => {
    fs.writeFileSync(path.join(artifactsDir(), "old-output.txt"), "legacy bytes")
    const list = listRunArtifacts(projectDir, RUN)
    expect(list.ok).toBe(true)
    if (!list.ok) return
    expect(list.entries).toEqual([])
    expect(list.legacyFiles).toEqual([{ name: "old-output.txt", savedPath: "artifacts/old-output.txt", bytesOnDisk: 12 }])
    expect(list.warnings.join()).toContain("legacy run")
    expect(fs.existsSync(manifestPath())).toBe(false) // 绝不因发现而写 manifest
  })

  test("manifest 之外的盘上残留文件 → legacyFiles(审计未登记 final 文件)", () => {
    const a = seedArtifact("report.md", "# hi")
    registerDownloadedArtifact(projectDir, RUN, { descriptor: a.descriptor, savedPath: a.savedPath, verifiedSha256: a.digest })
    fs.writeFileSync(path.join(artifactsDir(), "stray.bin"), "stray")
    const list = listRunArtifacts(projectDir, RUN)
    expect(list.ok && list.legacyFiles.map((f) => f.name)).toEqual(["stray.bin"])
  })

  test("future-version manifest → list 只读报错(不猜测解释)", () => {
    fs.writeFileSync(manifestPath(), JSON.stringify({ schemaVersion: 99 }))
    const list = listRunArtifacts(projectDir, RUN)
    expect(list.ok).toBe(false)
    if (!list.ok) expect(list.reason).toContain("unsupported schemaVersion 99")
  })

  test("bad run id → refused before any I/O", () => {
    expect(listRunArtifacts(projectDir, "../evil")).toEqual({ ok: false, reason: "invalid run id" })
  })
})

describe("resolveArtifact / verifyArtifact", () => {
  test("resolve by id returns descriptor + reconciled local state", () => {
    const a = seedArtifact("report.md", "# hi")
    registerDownloadedArtifact(projectDir, RUN, { descriptor: a.descriptor, savedPath: a.savedPath, verifiedSha256: a.digest })
    const res = resolveArtifact(projectDir, RUN, a.descriptor.id)
    expect(res.ok && res.entry.descriptor.id).toBe(a.descriptor.id)
    expect(resolveArtifact(projectDir, RUN, "art_job_1_9_deadbeef")).toEqual({ ok: false, reason: "artifact not found" })
  })

  test("offline tamper (同尺寸改内容) → verify 检出 digest 不符,降级持久化", async () => {
    const a = seedArtifact("report.md", "# hi")
    registerDownloadedArtifact(projectDir, RUN, { descriptor: a.descriptor, savedPath: a.savedPath, verifiedSha256: a.digest })
    fs.writeFileSync(path.join(artifactsDir(), "report.md"), "# HI") // 同 4 字节,stat 级 reconcile 看不出
    const list = listRunArtifacts(projectDir, RUN)
    expect(list.ok && list.entries[0].local.state).toBe("verified") // stat 级确实看不出 —— 这正是 verify 存在的理由
    const res = await verifyArtifact(projectDir, RUN, a.descriptor.id)
    expect(res.ok && res.entry.local.state).toBe("mismatch")
    const read = readArtifactManifest(projectDir, RUN)
    expect(read.ok && read.manifest?.artifacts[0].local.state).toBe("mismatch")
    // pin(期望值)不被"治愈",算得的 digest 进 warning
    expect(read.ok && read.manifest?.artifacts[0].local.verifiedSha256).toBe(a.digest)
  })

  test("verify with intact content keeps/upgrades to verified", async () => {
    const a = seedArtifact("report.md", "# hi")
    const d = { ...a.descriptor }
    registerDownloadedArtifact(projectDir, RUN, { descriptor: d, savedPath: a.savedPath }) // 没给本地 digest → unverified
    const res = await verifyArtifact(projectDir, RUN, d.id)
    expect(res.ok && res.entry.local.state).toBe("verified") // descriptor.sha256 吻合 → 升级
  })

  test("no producer digest: verify pins local digest but stays unverified", async () => {
    const a = seedArtifact("blob.bin", "data")
    const d = { ...a.descriptor }
    delete d.sha256
    d.verification = { status: "unverified" }
    registerDownloadedArtifact(projectDir, RUN, { descriptor: d, savedPath: a.savedPath })
    const res = await verifyArtifact(projectDir, RUN, d.id)
    expect(res.ok && res.entry.local.state).toBe("unverified")
    expect(res.ok && res.entry.local.verifiedSha256).toBe(sha256("data"))
    // 之后离线篡改 → 依据 pin 检出漂移
    fs.writeFileSync(path.join(artifactsDir(), "blob.bin"), "DATA")
    const res2 = await verifyArtifact(projectDir, RUN, d.id)
    expect(res2.ok && res2.entry.local.state).toBe("mismatch")
  })
})

describe("removeArtifact (GC 钩子)", () => {
  test("removes file + updates manifest atomically (无悬挂引用)", () => {
    const a = seedArtifact("report.md", "# hi")
    registerDownloadedArtifact(projectDir, RUN, { descriptor: a.descriptor, savedPath: a.savedPath, verifiedSha256: a.digest })
    const res = removeArtifact(projectDir, RUN, a.descriptor.id)
    expect(res).toEqual({ ok: true, removedFile: true })
    expect(fs.existsSync(path.join(artifactsDir(), "report.md"))).toBe(false)
    const read = readArtifactManifest(projectDir, RUN)
    expect(read.ok && read.manifest?.artifacts).toEqual([])
    // manifest 本体仍是合法 v1(原子更新,不是删文件)
    expect(JSON.parse(fs.readFileSync(manifestPath(), "utf8")).schemaVersion).toBe(1)
  })

  test("file already gone → entry still removed (幂等)", () => {
    const a = seedArtifact("report.md", "# hi")
    registerDownloadedArtifact(projectDir, RUN, { descriptor: a.descriptor, savedPath: a.savedPath, verifiedSha256: a.digest })
    fs.unlinkSync(path.join(artifactsDir(), "report.md"))
    expect(removeArtifact(projectDir, RUN, a.descriptor.id)).toEqual({ ok: true, removedFile: false })
  })

  test("unknown artifact / future-version manifest → refused", () => {
    expect(removeArtifact(projectDir, RUN, "art_job_1_0_deadbeef").ok).toBe(false)
    fs.writeFileSync(manifestPath(), JSON.stringify({ schemaVersion: 99 }))
    const res = removeArtifact(projectDir, RUN, "art_job_1_0_deadbeef")
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain("read-only")
  })
})

describe("byte accounting", () => {
  test("run usage: 账面 + 盘上 + legacy + missing 分列", () => {
    const a = seedArtifact("report.md", "# hi") // 4 bytes,登记
    registerDownloadedArtifact(projectDir, RUN, { descriptor: a.descriptor, savedPath: a.savedPath, verifiedSha256: a.digest })
    fs.writeFileSync(path.join(artifactsDir(), "stray.bin"), "12345678") // 8 bytes,未登记
    const manifest = readArtifactManifest(projectDir, RUN)
    const writtenAt = manifest.ok ? manifest.manifest!.updatedAt : "unreadable"
    const res = runArtifactUsage(projectDir, RUN)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.usage).toEqual({
      runId: RUN,
      artifactCount: 1,
      recordedBytes: 4,
      diskBytes: 12,
      legacyBytes: 8,
      missingCount: 0,
      readOnly: false,
      updatedAt: writtenAt,
    })
  })

  test("missing file counts in missingCount, disk truth drops", () => {
    const a = seedArtifact("report.md", "# hi")
    registerDownloadedArtifact(projectDir, RUN, { descriptor: a.descriptor, savedPath: a.savedPath, verifiedSha256: a.digest })
    fs.unlinkSync(path.join(artifactsDir(), "report.md"))
    const res = runArtifactUsage(projectDir, RUN)
    expect(res.ok && res.usage.missingCount).toBe(1)
    expect(res.ok && res.usage.diskBytes).toBe(0)
    expect(res.ok && res.usage.recordedBytes).toBe(4) // 账面保留,供 retention 审计
  })

  test("project usage aggregates runs + exposes centralized limits", () => {
    const a = seedArtifact("report.md", "# hi")
    registerDownloadedArtifact(projectDir, RUN, { descriptor: a.descriptor, savedPath: a.savedPath, verifiedSha256: a.digest })
    // 第二个 run(legacy,无 manifest)
    const run2 = path.join(projectDir, ".alpha", "runs", "job_2", "artifacts")
    fs.mkdirSync(run2, { recursive: true })
    fs.writeFileSync(path.join(run2, "x.bin"), "12345")
    const res = projectArtifactUsage(projectDir)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.usage.totalArtifacts).toBe(1)
    expect(res.usage.totalRecordedBytes).toBe(4)
    expect(res.usage.totalDiskBytes).toBe(9)
    expect(res.usage.runs).toHaveLength(2)
    expect(res.usage.limits).toEqual({
      artifactMaxBytes: 100 * 1024 * 1024,
      runMaxBytes: 512 * 1024 * 1024,
      runMaxCount: 256,
      projectMaxBytes: 5 * 1024 * 1024 * 1024,
    })
  })

  test("future-version manifest → usage from disk truth only, readOnly flagged", () => {
    fs.writeFileSync(path.join(artifactsDir(), "x.bin"), "12345")
    fs.writeFileSync(manifestPath(), JSON.stringify({ schemaVersion: 99 }))
    const res = runArtifactUsage(projectDir, RUN)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.usage.readOnly).toBe(true)
    expect(res.usage.diskBytes).toBe(5)
    expect(res.usage.recordedBytes).toBe(0)
  })

  // #660 裁决 B1:manifest 的 updatedAt 原样透出,而且必须穿过 projectArtifactUsage 的
  // 转存(将来有人在那里做投影,静默丢字段就在这里变红)。
  test("updatedAt surfaces the manifest value verbatim through run AND project usage", () => {
    const a = seedArtifact("report.md", "# hi")
    registerDownloadedArtifact(projectDir, RUN, { descriptor: a.descriptor, savedPath: a.savedPath, verifiedSha256: a.digest })
    const manifest = readArtifactManifest(projectDir, RUN)
    expect(manifest.ok).toBe(true)
    const writtenAt = manifest.ok ? manifest.manifest!.updatedAt : "unreadable"
    expect(typeof writtenAt).toBe("string")

    const run = runArtifactUsage(projectDir, RUN)
    expect(run.ok && run.usage.updatedAt).toBe(writtenAt)

    const project = projectArtifactUsage(projectDir)
    expect(project.ok).toBe(true)
    if (!project.ok) return
    expect(project.usage.runs.find((r) => r.runId === RUN)?.updatedAt).toBe(writtenAt)
  })

  // #660 裁决 B1 的失败关闭面:读不出 manifest 就没有时刻 —— null,绝不回落目录 mtime
  // 冒充「这次任务的时刻」。corrupt 与未来版本两条路径都要如此。
  test("corrupt / future-version manifest → updatedAt is null (never an invented time)", () => {
    fs.writeFileSync(path.join(artifactsDir(), "x.bin"), "12345")

    fs.writeFileSync(manifestPath(), JSON.stringify({ schemaVersion: 99 }))
    const future = runArtifactUsage(projectDir, RUN)
    expect(future.ok).toBe(true)
    if (!future.ok) return
    expect(future.usage.updatedAt).toBeNull()
    expect(future.usage.readOnly).toBe(true)

    fs.writeFileSync(manifestPath(), "{not json")
    const corrupt = runArtifactUsage(projectDir, RUN)
    expect(corrupt.ok).toBe(true)
    if (!corrupt.ok) return
    expect(corrupt.usage.updatedAt).toBeNull()
    expect(corrupt.usage.readOnly).toBe(true)
  })

  test("no runs dir yet → zero usage, not an error", () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-empty-"))
    try {
      fs.mkdirSync(path.join(fresh, ".alpha"), { recursive: true })
      const res = projectArtifactUsage(fresh)
      expect(res.ok && res.usage.totalDiskBytes).toBe(0)
      expect(res.ok && res.usage.runs).toEqual([])
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true })
    }
  })
})

describe("IPC read-only shape (renderer 可见面不含绝对路径/凭据)", () => {
  test("list result serializes with relative savedPath + server-relative contentRef only", () => {
    const a = seedArtifact("report.md", "# hi")
    registerDownloadedArtifact(projectDir, RUN, { descriptor: a.descriptor, savedPath: a.savedPath, verifiedSha256: a.digest })
    const list = listRunArtifacts(projectDir, RUN)
    const json = JSON.stringify(list)
    expect(json.includes(projectDir)).toBe(false) // 无绝对路径
    expect(json.toLowerCase().includes("bearer ")).toBe(false) // 无凭据字面量
    expect(json.includes("base64")).toBe(false) // 无内容字段
    if (list.ok) expect(list.entries[0].descriptor.contentRef.url.startsWith("/")).toBe(true)
  })
})
