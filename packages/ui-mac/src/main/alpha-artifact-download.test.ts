// REQ-092 A 侧单测 —— 流式 artifact 下载器(alpha-artifact-download.ts)。
// 真实 temp dir + mock fetch(alpha-workdir.test.ts 同款纪律):空文件/正常文件/三道限额闸/
// 长度欺骗/断流/取消/sha256 不符/重试不撞 .part/token 卫生/compat 内联回退等价性。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  downloadArtifactToFile,
  expectedShaFromHeaders,
  inlineDecodedBytes,
  resolveContentUrl,
  sanitizeTransportError,
  uniquePartPath,
  writeChunksChecked,
  type ArtifactDownloadDeps,
  type ArtifactDownloadOutcome,
  type ArtifactFinalizer,
} from "./alpha-artifact-download"
import { ARTIFACT_SCHEMA_VERSION, INLINE_ARTIFACT_COMPAT_FLAG, type ArtifactDescriptor } from "../shared/cloud-artifact-descriptor"

const TOKEN = "TOKEN-MARKER-b0960ee3-SECRET"
const BASE = "https://cloud.test"

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-artifact-dl-"))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const sha = (data: string | Buffer) => crypto.createHash("sha256").update(data).digest("hex")
const target = (name = "out.bin") => path.join(dir, name)
/** 目录里除 expected 之外不得有任何残留(尤其 .part)。 */
function residueIn(d: string, expected: string[] = []): string[] {
  return fs.readdirSync(d).filter((f) => !expected.includes(f))
}

function descriptor(over: Partial<ArtifactDescriptor> = {}): ArtifactDescriptor {
  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    id: "art_job_abc_0_ab12cd34",
    source: "cloud",
    name: "out.bin",
    trust: "sandboxed",
    role: "primary",
    contentRef: { kind: "http-stream", url: "/v1/cloud/artifacts/art_job_abc_0_ab12cd34/content", auth: "bearer" },
    verification: { status: "unverified" },
    provenance: { producer: "pipeline", jobId: "job_abc" },
    ...over,
  }
}

type MockRoute = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Response | Promise<Response>
function mockFetch(route: MockRoute, calls: { url: string; headers: Record<string, string> }[] = []) {
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ url, headers })
    return route(url, { headers, signal: init?.signal ?? undefined })
  }
  return { fetchImpl: impl as typeof fetch, calls }
}

function streamOf(chunks: Uint8Array[], opts: { pulled?: { count: number }; cancelled?: { flag: boolean }; failAfter?: number } = {}) {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      opts.pulled && opts.pulled.count++
      if (opts.failAfter !== undefined && i >= opts.failAfter) {
        controller.error(new Error(`connection reset while streaming (Bearer ${TOKEN})`))
        return
      }
      if (i >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(chunks[i++])
    },
    cancel() {
      if (opts.cancelled) opts.cancelled.flag = true
    },
    // highWaterMark 0:默认 HWM=1 会在构造时预拉一块填充内部队列,污染「读 body 前拒绝」断言。
  }, { highWaterMark: 0 })
}

// 刻意不走 `new Response(stream)`:bun 的 Response 会在构造时预拉一块 chunk,污染
// 「读 body 前拒绝」类断言。downloader 只消费 status/ok/headers/body,普通对象即可精确追踪 pull。
function fakeResponse(status: number, headers: Record<string, string>, body: ReadableStream<Uint8Array> | null): Response {
  return { status, ok: status >= 200 && status < 300, headers: new Headers(headers), body } as unknown as Response
}

function okResponse(body: Uint8Array[] | null, headers: Record<string, string> = {}, streamOpts: Parameters<typeof streamOf>[1] = {}) {
  return fakeResponse(200, headers, body === null ? null : streamOf(body, streamOpts))
}

const utf8 = (s: string) => new TextEncoder().encode(s)

const finalizeWithoutQuota: ArtifactFinalizer = (input) => {
  try {
    fs.renameSync(input.partPath, input.targetPath)
    return { ok: true }
  } catch {
    return { ok: false, error: "disk", detail: "test final rename failed" }
  }
}

const deps = (fetchImpl: typeof fetch, over: Partial<ArtifactDownloadDeps> = {}): ArtifactDownloadDeps => ({
  token: TOKEN,
  base: BASE,
  fetchImpl,
  finalize: finalizeWithoutQuota,
  ...over,
})

describe("streaming download (descriptor path)", () => {
  test("normal file: streams to .part, verifies descriptor sha256 + ETag + Digest, atomic rename", async () => {
    const content = Buffer.from("hello artifact transport")
    const hex = sha(content)
    const { fetchImpl, calls } = mockFetch(() =>
      okResponse([new Uint8Array(content)], {
        "content-length": String(content.length),
        etag: `"sha256:${hex}"`,
        digest: `sha-256=${Buffer.from(hex, "hex").toString("base64")}`, // REQ-092:digest 头构造(测试),非内容字段
      }),
    )
    const progress: { bytes: number; total?: number; percent?: number }[] = []
    const res = await downloadArtifactToFile(
      { artifact: descriptor({ sha256: hex, size: content.length }), targetPath: target(), onProgress: (p) => progress.push(p) },
      deps(fetchImpl),
    )
    expect(res).toEqual({ ok: true, path: target(), bytes: content.length, sha256: hex, verification: "verified", via: "stream" })
    expect(fs.readFileSync(target())).toEqual(content)
    expect(residueIn(dir, ["out.bin"])).toEqual([])
    // bearer 只进请求头,URL 对 cloud origin 解析
    expect(calls[0].url).toBe(`${BASE}/v1/cloud/artifacts/art_job_abc_0_ab12cd34/content`)
    expect(calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`)
    const last = progress.at(-1)!
    expect(last.bytes).toBe(content.length)
    expect(last.total).toBe(content.length)
    expect(last.percent).toBe(100)
  })

  test("empty file (0 bytes) lands as empty final file, unverified without digests", async () => {
    const { fetchImpl } = mockFetch(() => okResponse([], { "content-length": "0" }))
    const res = await downloadArtifactToFile({ artifact: descriptor({ size: 0 }), targetPath: target("empty.bin") }, deps(fetchImpl))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.bytes).toBe(0)
    expect(res.sha256).toBe(sha(Buffer.alloc(0)))
    expect(res.verification).toBe("unverified")
    expect(fs.readFileSync(target("empty.bin")).length).toBe(0)
    expect(residueIn(dir, ["empty.bin"])).toEqual([])
  })

  test("legacy meta {id,name}: URL derived from the artifacts content path", async () => {
    const content = Buffer.from("legacy meta path")
    const { fetchImpl, calls } = mockFetch(() => okResponse([new Uint8Array(content)]))
    const res = await downloadArtifactToFile({ artifact: { id: "art_job_x_0", name: "a.txt" }, targetPath: target() }, deps(fetchImpl))
    expect(res.ok).toBe(true)
    expect(calls[0].url).toBe(`${BASE}/v1/cloud/artifacts/art_job_x_0/content`)
  })

  test("descriptor.size over limit → rejected before any request (quota gate 1)", async () => {
    const { fetchImpl, calls } = mockFetch(() => okResponse([]))
    const res = await downloadArtifactToFile(
      { artifact: descriptor({ size: 101 }), targetPath: target() },
      deps(fetchImpl, { maxBytes: 100 }),
    )
    expect(res).toMatchObject({ ok: false, error: "over-limit" })
    expect(calls.length).toBe(0)
    expect(residueIn(dir)).toEqual([])
  })

  test("Content-Length over limit → rejected pre-read: body never pulled, upstream cancelled, no .part", async () => {
    const pulled = { count: 0 }
    const cancelled = { flag: false }
    const { fetchImpl } = mockFetch(() =>
      okResponse([new Uint8Array(200)], { "content-length": "200" }, { pulled, cancelled }),
    )
    const res = await downloadArtifactToFile({ artifact: descriptor(), targetPath: target() }, deps(fetchImpl, { maxBytes: 100 }))
    expect(res).toMatchObject({ ok: false, error: "over-limit" })
    expect(pulled.count).toBe(0)
    expect(cancelled.flag).toBe(true)
    expect(residueIn(dir)).toEqual([])
  })

  test("unknown length overrun → abort at first excess byte, upstream cancelled, no residue", async () => {
    const cancelled = { flag: false }
    const chunks = [new Uint8Array(40), new Uint8Array(40), new Uint8Array(40), new Uint8Array(40)]
    const { fetchImpl } = mockFetch(() => okResponse(chunks, {}, { cancelled }))
    const res = await downloadArtifactToFile({ artifact: descriptor(), targetPath: target() }, deps(fetchImpl, { maxBytes: 100 }))
    expect(res).toMatchObject({ ok: false, error: "over-limit" })
    expect(cancelled.flag).toBe(true)
    expect(residueIn(dir)).toEqual([])
  })

  test("lying Content-Length (under-declares) → abort at cumulative overrun", async () => {
    const { fetchImpl } = mockFetch(() =>
      okResponse([new Uint8Array(60), new Uint8Array(60), new Uint8Array(60)], { "content-length": "50" }),
    )
    const res = await downloadArtifactToFile({ artifact: descriptor(), targetPath: target() }, deps(fetchImpl, { maxBytes: 100 }))
    expect(res).toMatchObject({ ok: false, error: "over-limit" })
    expect(residueIn(dir)).toEqual([])
  })

  test("lying Content-Length (over-declares, short body) → size-mismatch, no final file", async () => {
    const { fetchImpl } = mockFetch(() => okResponse([new Uint8Array(10)], { "content-length": "50" }))
    const res = await downloadArtifactToFile({ artifact: descriptor(), targetPath: target() }, deps(fetchImpl))
    expect(res).toMatchObject({ ok: false, error: "size-mismatch" })
    expect(fs.existsSync(target())).toBe(false)
    expect(residueIn(dir)).toEqual([])
  })

  test("descriptor.size disagrees with received bytes → size-mismatch", async () => {
    const { fetchImpl } = mockFetch(() => okResponse([new Uint8Array(10)]))
    const res = await downloadArtifactToFile({ artifact: descriptor({ size: 11 }), targetPath: target() }, deps(fetchImpl))
    expect(res).toMatchObject({ ok: false, error: "size-mismatch" })
    expect(residueIn(dir)).toEqual([])
  })

  test("disconnect mid-stream → classified network error, no residue, token scrubbed from detail", async () => {
    const { fetchImpl } = mockFetch(() => okResponse([new Uint8Array(10)], {}, { failAfter: 1 }))
    const res = await downloadArtifactToFile({ artifact: descriptor(), targetPath: target() }, deps(fetchImpl))
    expect(res).toMatchObject({ ok: false, error: "network" })
    expect(JSON.stringify(res)).not.toContain(TOKEN)
    expect(fs.existsSync(target())).toBe(false)
    expect(residueIn(dir)).toEqual([])
  })

  test("cancel mid-stream via AbortSignal → cancelled, no residue", async () => {
    const ctrl = new AbortController()
    const { fetchImpl } = mockFetch(() =>
      okResponse([new Uint8Array(300 * 1024), new Uint8Array(300 * 1024), new Uint8Array(300 * 1024)]),
    )
    const res = await downloadArtifactToFile(
      {
        artifact: descriptor(),
        targetPath: target(),
        signal: ctrl.signal,
        onProgress: () => ctrl.abort(), // 第一笔进度后取消
      },
      deps(fetchImpl),
    )
    expect(res).toEqual({ ok: false, error: "cancelled" })
    expect(fs.existsSync(target())).toBe(false)
    expect(residueIn(dir)).toEqual([])
  })

  test("sha256 mismatch (descriptor digest wrong) → no final file, .part deleted", async () => {
    const content = Buffer.from("actual bytes")
    const { fetchImpl } = mockFetch(() => okResponse([new Uint8Array(content)]))
    const res = await downloadArtifactToFile(
      { artifact: descriptor({ sha256: "a".repeat(64) }), targetPath: target() },
      deps(fetchImpl),
    )
    expect(res).toMatchObject({ ok: false, error: "sha256-mismatch" })
    expect(fs.existsSync(target())).toBe(false)
    expect(residueIn(dir)).toEqual([])
  })

  test("descriptor sha vs ETag disagree → rejected before reading body", async () => {
    const pulled = { count: 0 }
    const { fetchImpl } = mockFetch(() =>
      okResponse([new Uint8Array(4)], { etag: `"sha256:${"b".repeat(64)}"` }, { pulled }),
    )
    const res = await downloadArtifactToFile(
      { artifact: descriptor({ sha256: "a".repeat(64) }), targetPath: target() },
      deps(fetchImpl),
    )
    expect(res).toMatchObject({ ok: false, error: "sha256-mismatch" })
    expect(pulled.count).toBe(0)
  })

  test("HTTP statuses classify: 401/403/413/500", async () => {
    const cases: [number, string][] = [
      [401, "unauthorized"],
      [403, "forbidden"],
      [413, "over-limit"],
      [500, "http-500"],
    ]
    for (const [status, error] of cases) {
      const { fetchImpl } = mockFetch(() => fakeResponse(status, {}, null))
      const res = await downloadArtifactToFile({ artifact: descriptor(), targetPath: target() }, deps(fetchImpl))
      expect(res).toMatchObject({ ok: false, error })
    }
  })

  test("unknown schemaVersion → unsupported-schema, no request (read-only/error rule)", async () => {
    const { fetchImpl, calls } = mockFetch(() => okResponse([]))
    const res = await downloadArtifactToFile(
      { artifact: { ...descriptor(), schemaVersion: 2 }, targetPath: target() },
      deps(fetchImpl),
    )
    expect(res).toMatchObject({ ok: false, error: "unsupported-schema" })
    expect(calls.length).toBe(0)
  })

  test("hostile contentRef.url on a foreign origin → unsafe-url, bearer never sent", async () => {
    const { fetchImpl, calls } = mockFetch(() => okResponse([]))
    const res = await downloadArtifactToFile(
      { artifact: descriptor({ contentRef: { kind: "http-stream", url: "https://evil.example/steal", auth: "bearer" } }), targetPath: target() },
      deps(fetchImpl),
    )
    expect(res).toMatchObject({ ok: false, error: "unsafe-url" })
    expect(calls.length).toBe(0)
  })

  test("relative target path refused (callers must pre-resolve through the .alpha guard)", async () => {
    const { fetchImpl, calls } = mockFetch(() => okResponse([]))
    const res = await downloadArtifactToFile({ artifact: descriptor(), targetPath: "relative/out.bin" }, deps(fetchImpl))
    expect(res).toMatchObject({ ok: false, error: "unsafe-path" })
    expect(calls.length).toBe(0)
  })

  test("fetch-level failure: token never appears in outcome (marker assertion)", async () => {
    const impl = (async () => {
      throw new Error(`getaddrinfo ENOTFOUND (authorization: Bearer ${TOKEN})`)
    }) as typeof fetch
    const res = await downloadArtifactToFile({ artifact: descriptor(), targetPath: target() }, deps(impl))
    expect(res).toMatchObject({ ok: false, error: "network" })
    expect(JSON.stringify(res)).not.toContain(TOKEN)
  })

  test("retries never collide with stale .part files; unique suffixes differ per attempt", async () => {
    const t = target()
    fs.writeFileSync(`${t}.stale.part`, "leftover from a crashed attempt")
    const content = Buffer.from("fresh")
    const { fetchImpl } = mockFetch(() => okResponse([new Uint8Array(content)]))
    const res = await downloadArtifactToFile({ artifact: descriptor(), targetPath: t }, deps(fetchImpl))
    expect(res.ok).toBe(true)
    expect(fs.readFileSync(t)).toEqual(content)
    // 旧 .part 不被碰;本次尝试的 .part 已 rename 掉
    expect(residueIn(dir, ["out.bin", "out.bin.stale.part"])).toEqual([])
    expect(fs.readFileSync(`${t}.stale.part`, "utf8")).toContain("leftover")
    const a = uniquePartPath(t)
    const b = uniquePartPath(t)
    expect(a).not.toBe(b)
    expect(a.endsWith(".part") && b.endsWith(".part")).toBe(true)
  })

  test("re-download over an existing final file atomically replaces it", async () => {
    const t = target()
    fs.writeFileSync(t, "old contents")
    const content = Buffer.from("new contents")
    const { fetchImpl } = mockFetch(() => okResponse([new Uint8Array(content)]))
    const res = await downloadArtifactToFile({ artifact: descriptor(), targetPath: t }, deps(fetchImpl))
    expect(res.ok).toBe(true)
    expect(fs.readFileSync(t)).toEqual(content)
  })

  test("stalled stream (bytes stop arriving) → loud network idle error, no residue, no hung promise", async () => {
    const stalled = new ReadableStream<Uint8Array>(
      {
        pull() {
          return new Promise<never>(() => {}) // 永不产出下一块
        },
      },
      { highWaterMark: 0 },
    )
    const { fetchImpl } = mockFetch(() => fakeResponse(200, {}, stalled))
    const res = await downloadArtifactToFile(
      { artifact: descriptor(), targetPath: target() },
      deps(fetchImpl, { idleTimeoutMs: 25 }),
    )
    expect(res).toMatchObject({ ok: false, error: "network" })
    expect(String((res as { detail?: string }).detail)).toContain("idle")
    expect(residueIn(dir)).toEqual([])
  })

  test("no response headers within the watchdog window → loud network error (invoke never hangs)", async () => {
    const impl = (() => new Promise<Response>(() => {})) as unknown as typeof fetch
    const res = await downloadArtifactToFile(
      { artifact: descriptor(), targetPath: target() },
      deps(impl, { idleTimeoutMs: 20 }),
    )
    expect(res).toMatchObject({ ok: false, error: "network" })
    expect(String((res as { detail?: string }).detail)).toContain("no response headers")
  })

  test("disk failure (target dir missing) → classified disk error", async () => {
    const { fetchImpl } = mockFetch(() => okResponse([new Uint8Array(4)]))
    const res = await downloadArtifactToFile(
      { artifact: descriptor(), targetPath: path.join(dir, "no-such-dir", "out.bin") },
      deps(fetchImpl),
    )
    expect(res).toMatchObject({ ok: false, error: "disk" })
  })
})

describe("inline compat fallback (REQ-092 交付 6;移除日 2026-08-15)", () => {
  const content = Buffer.from("compat artifact bytes — same writer, same quota, same hash")
  const hex = sha(content)
  const encoded = content.toString("base64") // REQ-092-compat:构造 legacy 响应 fixture

  function legacyStatusBody(over: Record<string, unknown> = {}) {
    return JSON.stringify({
      job_id: "job_abc",
      status: "completed",
      result: { artifacts: [{ name: "out.bin", size: content.length, sha256: hex, base64: encoded, ...over }] }, // REQ-092-compat fixture
    })
  }

  function compatRoute(over: Record<string, unknown> = {}): MockRoute {
    return (url) => {
      if (url.includes("/content")) return fakeResponse(404, {}, streamOf([utf8(JSON.stringify({ error: "not found" }))]))
      return fakeResponse(200, { "content-type": "application/json" }, streamOf([utf8(legacyStatusBody(over))]))
    }
  }

  test("content 404 → falls back to compat status, decodes in main through the same .part writer, byte+hash equal to stream path", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    const { fetchImpl } = mockFetch(compatRoute(), calls)
    const res = await downloadArtifactToFile(
      { artifact: descriptor({ sha256: hex, size: content.length }), targetPath: target("compat.bin") },
      deps(fetchImpl),
    )
    expect(res).toEqual({
      ok: true,
      path: target("compat.bin"),
      bytes: content.length,
      sha256: hex,
      verification: "verified",
      via: "inline-compat",
    })
    expect(fs.readFileSync(target("compat.bin"))).toEqual(content)
    expect(residueIn(dir, ["compat.bin"])).toEqual([])
    // compat 请求形态:query flag + x-alpha-compat 头 + bearer;jobId 从 artifact id 解析
    expect(calls[1].url).toBe(`${BASE}/v1/cloud/jobs/job_abc?compat=${INLINE_ARTIFACT_COMPAT_FLAG}`)
    expect(calls[1].headers["x-alpha-compat"]).toBe(INLINE_ARTIFACT_COMPAT_FLAG)
    expect(calls[1].headers.authorization).toBe(`Bearer ${TOKEN}`)

    // 等价性:同一内容走流式路径,落盘字节与 sha 一致
    const { fetchImpl: streamImpl } = mockFetch(() => okResponse([new Uint8Array(content)]))
    const streamRes = await downloadArtifactToFile(
      { artifact: descriptor({ sha256: hex, size: content.length }), targetPath: target("stream.bin") },
      deps(streamImpl),
    )
    expect(streamRes.ok).toBe(true)
    expect(fs.readFileSync(target("stream.bin"))).toEqual(fs.readFileSync(target("compat.bin")))
    if (streamRes.ok && res.ok) expect(streamRes.sha256).toBe(res.sha256)
  })

  test("compat quota: oversized inline content rejected before any decode buffer, no residue", async () => {
    const big = Buffer.alloc(200)
    const { fetchImpl } = mockFetch(
      compatRoute({ base64: big.toString("base64"), size: undefined, sha256: undefined }), // REQ-092-compat fixture
    )
    const res = await downloadArtifactToFile(
      { artifact: { id: "art_job_abc_0", name: "out.bin" }, targetPath: target() },
      deps(fetchImpl, { maxBytes: 100 }),
    )
    expect(res).toMatchObject({ ok: false, error: "over-limit" })
    expect(residueIn(dir)).toEqual([])
  })

  test("compat sha256 mismatch → loud failure, no final file (same verification as stream path)", async () => {
    const { fetchImpl } = mockFetch(compatRoute({ sha256: "c".repeat(64) }))
    const res = await downloadArtifactToFile(
      { artifact: { id: "art_job_abc_0", name: "out.bin" }, targetPath: target() },
      deps(fetchImpl),
    )
    expect(res).toMatchObject({ ok: false, error: "sha256-mismatch" })
    expect(fs.existsSync(target())).toBe(false)
    expect(residueIn(dir)).toEqual([])
  })

  test("compat entry without inline content → no-content; absent artifact → not-found", async () => {
    const { fetchImpl: noInline } = mockFetch(compatRoute({ base64: undefined })) // REQ-092-compat fixture
    const r1 = await downloadArtifactToFile(
      { artifact: { id: "art_job_abc_0", name: "out.bin" }, targetPath: target() },
      deps(noInline),
    )
    expect(r1).toMatchObject({ ok: false, error: "no-content" })

    const { fetchImpl: missing } = mockFetch((url) =>
      url.includes("/content")
        ? fakeResponse(404, {}, null)
        : fakeResponse(200, {}, streamOf([utf8(JSON.stringify({ result: { artifacts: [] } }))])),
    )
    const r2 = await downloadArtifactToFile(
      { artifact: { id: "art_job_abc_0", name: "out.bin" }, targetPath: target() },
      deps(missing),
    )
    expect(r2).toMatchObject({ ok: false, error: "not-found" })
  })

  test("compat legacy status response over the buffered cap → over-limit before parsing (Content-Length gate)", async () => {
    // cap 公式 = maxBytes*4/3 + 2MiB 余量;用超限的声明长度走前置闸(边读边计数闸与流路径共用 bodyChunks)。
    const { fetchImpl } = mockFetch((url) =>
      url.includes("/content")
        ? fakeResponse(404, {}, null)
        : fakeResponse(200, { "content-length": String(300 * 1024 * 1024) }, streamOf([new Uint8Array(8)])),
    )
    const res = await downloadArtifactToFile(
      { artifact: { id: "art_job_abc_0", name: "out.bin" }, targetPath: target() },
      deps(fetchImpl),
    )
    expect(res).toMatchObject({ ok: false, error: "over-limit" })
  })

  test("404 with unparseable artifact id and no jobId → honest not-found (no guessing)", async () => {
    const { fetchImpl } = mockFetch(() => fakeResponse(404, {}, null))
    const res = await downloadArtifactToFile({ artifact: { id: "weird-id", name: "x" }, targetPath: target() }, deps(fetchImpl))
    expect(res).toMatchObject({ ok: false, error: "not-found" })
  })
})

describe("helpers", () => {
  test("sanitizeTransportError strips explicit secrets and bearer word-forms", () => {
    const msg = `request failed: authorization Bearer ${TOKEN} rejected; retry with bearer abc.def-123`
    const out = sanitizeTransportError(msg, [TOKEN])
    expect(out).not.toContain(TOKEN)
    expect(out).not.toContain("abc.def-123")
    expect(out).toContain("[redacted]")
  })

  test("resolveContentUrl: same-origin enforced, credentials-in-URL refused", () => {
    expect(resolveContentUrl("/v1/cloud/artifacts/a/content", BASE)).toBe(`${BASE}/v1/cloud/artifacts/a/content`)
    expect(resolveContentUrl(`${BASE}/v1/x`, BASE)).toBe(`${BASE}/v1/x`)
    expect(resolveContentUrl("https://evil.example/x", BASE)).toBeNull()
    expect(resolveContentUrl("https://user:pw@cloud.test/x", BASE)).toBeNull()
    expect(resolveContentUrl("//evil.example/x", BASE)).toBeNull()
  })

  test("expectedShaFromHeaders parses platform ETag/Digest forms", () => {
    const hex = sha(Buffer.from("x"))
    const h = new Headers({
      etag: `"sha256:${hex}"`,
      digest: `sha-256=${Buffer.from(hex, "hex").toString("base64")}`, // REQ-092:digest 头(非内容字段)
    })
    expect(expectedShaFromHeaders(h)).toEqual({ etag: hex, digest: hex })
    expect(expectedShaFromHeaders(new Headers({ etag: `W/"weak-123"` }))).toEqual({})
  })

  test("inlineDecodedBytes matches Buffer decode length", () => {
    for (const n of [0, 1, 2, 3, 4, 57, 100]) {
      const buf = crypto.randomBytes(n)
      expect(inlineDecodedBytes(buf.toString("base64"))).toBe(n) // REQ-092-compat:解码长度预算
    }
  })

  test("writeChunksChecked emits progress with totals and rejects post-hoc size lies", async () => {
    async function* chunks() {
      yield new Uint8Array(4)
    }
    const progress: { bytes: number; total?: number }[] = []
    const res: ArtifactDownloadOutcome = await writeChunksChecked(chunks(), {
      targetPath: target("w.bin"),
      maxBytes: 100,
      expectedSize: 4,
      onProgress: (p) => progress.push(p),
      via: "stream",
      finalize: finalizeWithoutQuota,
    })
    expect(res.ok).toBe(true)
    expect(progress.at(-1)).toMatchObject({ bytes: 4, total: 4, percent: 100 })
  })
})
