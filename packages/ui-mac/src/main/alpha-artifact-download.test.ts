// REQ-092 A 侧单测 —— 流式 artifact 下载器(alpha-artifact-download.ts)。
// 真实 temp dir + mock fetch(与 alpha-workdir 的单测同款可测性纪律):空文件/正常文件/
// 三道限额闸/长度欺骗/断流/取消/sha256 不符/重试不撞 .part/token 卫生/legacy 拒绝。
//
// `#970` 起本文件登记进 scripts/gate-files.tsv(精确条数)。新增的那三条守的是一条**仓库级
// 保证**:平台的分类码到不了 `cancelled` 这个结构槽 —— 也就是「服务端拒绝不会被显示成
// 『你取消了』」。ui-mac 整包地板 3000 对实测 4100+ 有上千条余量,不登记 = 这三条可以被整段
// 删掉而三层全绿。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  downloadArtifactToFile,
  expectedShaFromHeaders,
  resolveContentUrl,
  sanitizeTransportError,
  uniquePartPath,
  writeChunksChecked,
  type ArtifactDownloadDeps,
  type ArtifactDownloadOutcome,
  type ArtifactFinalizer,
} from "./alpha-artifact-download"
import { ARTIFACT_SCHEMA_VERSION, type ArtifactDescriptor } from "../shared/cloud-artifact-descriptor"

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
    id: "art_job_abcd_0_ab12cd34",
    source: "cloud",
    name: "out.bin",
    trust: "sandboxed",
    role: "primary",
    contentRef: { kind: "http-stream", url: "/v1/cloud/artifacts/art_job_abcd_0_ab12cd34/content", auth: "bearer" },
    verification: { status: "unverified" },
    provenance: { producer: "pipeline", jobId: "job_abcd" },
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
    expect(calls[0].url).toBe(`${BASE}/v1/cloud/artifacts/art_job_abcd_0_ab12cd34/content`)
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

  test("rejects legacy artifact metadata without issuing a request", async () => {
    const { fetchImpl, calls } = mockFetch(() => okResponse([]))
    const res = await downloadArtifactToFile({ artifact: { id: "art_job_x_0", name: "a.txt" }, targetPath: target() }, deps(fetchImpl))
    expect(res).toMatchObject({ ok: false, error: "unsupported-schema" })
    expect(calls).toHaveLength(0)
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
    // sha256 = 完整性证据在位(#1111 起零证据下载在读 body 前即拒,进不到累计越界分支)。
    const res = await downloadArtifactToFile(
      { artifact: descriptor({ sha256: "c".repeat(64) }), targetPath: target() },
      deps(fetchImpl, { maxBytes: 100 }),
    )
    expect(res).toMatchObject({ ok: false, error: "over-limit" })
    expect(cancelled.flag).toBe(true)
    expect(residueIn(dir)).toEqual([])
  })

  // ── #1111 完整性证据闸:descriptor 无 size 无 sha256、响应头无 digest = 零证据 ────────────
  // 真 HTTP 上 undici 按 Content-Length 截流:对端少报时客户端只会收到**恰好** declared 字节,
  // 「实收 == 声明」恒真,截断前缀与完整文件不可区分(#402 格 3 C3.7/C3.14 实测:1 MiB 截断
  // 前缀落盘并报 {ok:true}"unverified")。旧用例的假 Response 没有 HTTP 框定,假 body 会把超出
  // 声明的字节继续交给写入器 —— 那条「累计越界 abort」分支在真 HTTP 上根本不存在。
  // 所以判据钉在它前面:零证据必须在读任何 body 字节之前拒绝。
  test("#1111 under-declared Content-Length with zero integrity evidence → unverifiable, rejected before any body byte", async () => {
    const pulled = { count: 0 }
    const cancelled = { flag: false }
    // 模拟 HTTP 框定后的可见形态:body 恰好 = 声明长度(多出的字节客户端永远看不见)。
    const framed = [new Uint8Array(50)]
    const { fetchImpl } = mockFetch(() => okResponse(framed, { "content-length": "50" }, { pulled, cancelled }))
    const res = await downloadArtifactToFile({ artifact: descriptor(), targetPath: target() }, deps(fetchImpl))
    expect(res).toMatchObject({ ok: false, error: "unverifiable" })
    expect(pulled.count).toBe(0) // 读 body 前拒绝,不是收完再后悔
    expect(cancelled.flag).toBe(true) // 上游被 cancel,不悬挂
    expect(fs.existsSync(target())).toBe(false)
    expect(residueIn(dir)).toEqual([])
  })

  test("#1111 zero evidence + chunked (no Content-Length at all) → unverifiable before any body byte", async () => {
    const pulled = { count: 0 }
    const { fetchImpl } = mockFetch(() => okResponse([new Uint8Array(8)], {}, { pulled }))
    const res = await downloadArtifactToFile({ artifact: descriptor(), targetPath: target() }, deps(fetchImpl))
    expect(res).toMatchObject({ ok: false, error: "unverifiable" })
    expect(pulled.count).toBe(0)
    expect(residueIn(dir)).toEqual([])
  })

  test("#1111 header digest alone rescues the size-less descriptor — and catches the truncated prefix", async () => {
    const full = Buffer.from("full content that the origin under-declared")
    const truncated = full.subarray(0, 10) // HTTP 框定后客户端只看得见声明的 10 字节
    const { fetchImpl } = mockFetch(() =>
      okResponse([new Uint8Array(truncated)], {
        "content-length": "10",
        etag: `"sha256:${sha(full)}"`,
      }),
    )
    const res = await downloadArtifactToFile({ artifact: descriptor(), targetPath: target() }, deps(fetchImpl))
    expect(res).toMatchObject({ ok: false, error: "sha256-mismatch" })
    expect(fs.existsSync(target())).toBe(false)
    expect(residueIn(dir)).toEqual([])
  })

  test("#1111 descriptor.size alone is real evidence: matching non-degenerate download stays an unverified success", async () => {
    const content = Buffer.from("sized but digest-less artifact body")
    const { fetchImpl } = mockFetch(() => okResponse([new Uint8Array(content)], { "content-length": String(content.length) }))
    const res = await downloadArtifactToFile(
      { artifact: descriptor({ size: content.length }), targetPath: target() },
      deps(fetchImpl),
    )
    expect(res).toMatchObject({ ok: true, bytes: content.length, verification: "unverified" })
    expect(fs.readFileSync(target())).toEqual(content)
  })

  test("lying Content-Length (over-declares, short body) → size-mismatch, no final file", async () => {
    const { fetchImpl } = mockFetch(() => okResponse([new Uint8Array(10)], { "content-length": "50" }))
    const res = await downloadArtifactToFile(
      { artifact: descriptor({ sha256: "c".repeat(64) }), targetPath: target() },
      deps(fetchImpl),
    )
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
    const res = await downloadArtifactToFile({ artifact: descriptor({ sha256: "c".repeat(64) }), targetPath: target() }, deps(fetchImpl))
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
        artifact: descriptor({ sha256: "c".repeat(64) }),
        targetPath: target(),
        signal: ctrl.signal,
        onProgress: () => ctrl.abort(), // 第一笔进度后取消
      },
      deps(fetchImpl),
    )
    // `#970`:精确形状 —— 流中途取消这条臂必须带结构槽(把 `cancelled: true` 只补给
    // authedFetch 两条臂、漏掉写入器三条臂的半吊子实现,在这里当场红)。
    expect(res).toEqual({ ok: false, error: "cancelled", cancelled: true })
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

  // [#940] 未映射状态经 platform-error-code 咽喉:平台给稳定分类码就呈现 code,无码保持
  // http-<status>(上面 500 那条即对照臂 —— 它的 fakeResponse 连 body 都没有)。
  test("unmapped rejection with a platform classification code surfaces the code, not http-400", async () => {
    const { fetchImpl } = mockFetch(
      () => new Response(JSON.stringify({ error: "upload rejected", code: "upload_reserved_input" }), { status: 400 }),
    )
    const res = await downloadArtifactToFile({ artifact: descriptor(), targetPath: target() }, deps(fetchImpl))
    expect(res).toMatchObject({ ok: false, error: "upload_reserved_input" })
  })

  // ── `#970` 平台伪造 `cancelled` 分类码:呈现槽会碰撞,结构槽结构上到不了 ────────────
  // 夹具刻意用 **409**:实测 12 个状态码,只有 400/409/410/416/429/5xx 到得了咽喉,
  // 401/403/404/413 各自被本文件上方 streamStage 的本地早退臂吃掉。票面 AC3 原文写的 403
  // **产生不了碰撞**(它回 "forbidden"),照原文写出来的判据改前改后都绿 —— 已订正。
  // 409 还是这条路由今天真的会带 code 的状态(alpha-platform 的 artifact_digest_mismatch)。
  test("`#970` 平台伪造的 cancelled 分类码撞进呈现槽,但拿不到「本地取消」的结构槽", async () => {
    const { fetchImpl } = mockFetch(
      () => new Response(JSON.stringify({ error: "conflict", code: "cancelled" }), { status: 409 }),
    )
    const res = await downloadArtifactToFile({ artifact: descriptor(), targetPath: target() }, deps(fetchImpl))
    // 前置断言:碰撞**确实发生了**。没有这一条,夹具状态码选歪时整条用例会改前改后都绿 ——
    // 它守的是「这个夹具真的走到了咽喉」,不是装饰。
    expect(res).toMatchObject({ ok: false, error: "cancelled" })
    // 本体:结构槽缺席 ⇒ 这不是本地取消。消费端因此不会把一次服务端拒绝显示成「你取消了」。
    expect("cancelled" in res).toBe(false)
    expect(residueIn(dir)).toEqual([])
  })

  test("`#970` 外部 AbortSignal 已 abort:预检臂零网络回本地取消,且带结构槽", async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const { fetchImpl, calls } = mockFetch(() => okResponse([new Uint8Array(4)]))
    const res = await downloadArtifactToFile(
      { artifact: descriptor(), targetPath: target(), signal: ctrl.signal },
      deps(fetchImpl),
    )
    expect(res).toEqual({ ok: false, error: "cancelled", cancelled: true })
    expect(calls).toHaveLength(0) // 走的是 authedFetch 的预检臂,不是别的分支冒名顶替
    expect(residueIn(dir)).toEqual([])
  })

  test("`#970` 对照臂:真实平台码与无码拒绝都只落呈现槽,咽喉输出不被吞成裸状态", async () => {
    // 期望值是**独立字面量**,不从生产常量 import —— 锚点等于被测对象自己就是自指等价链。
    const { fetchImpl: withCode } = mockFetch(
      () => new Response(JSON.stringify({ error: "digest mismatch", code: "artifact_digest_mismatch" }), { status: 409 }),
    )
    const coded = await downloadArtifactToFile({ artifact: descriptor(), targetPath: target() }, deps(withCode))
    expect(coded).toMatchObject({ ok: false, error: "artifact_digest_mismatch" })
    expect("cancelled" in coded).toBe(false)

    const { fetchImpl: noCode } = mockFetch(
      () => new Response(JSON.stringify({ error: "service unavailable" }), { status: 503 }),
    )
    const bare = await downloadArtifactToFile({ artifact: descriptor(), targetPath: target() }, deps(noCode))
    expect(bare).toMatchObject({ ok: false, error: "http-503" })
    expect("cancelled" in bare).toBe(false)
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
    expect(res).toMatchObject({ ok: false, error: "invalid-artifact" })
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
    const res = await downloadArtifactToFile({ artifact: descriptor({ sha256: sha(content) }), targetPath: t }, deps(fetchImpl))
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
    const res = await downloadArtifactToFile({ artifact: descriptor({ sha256: sha(content) }), targetPath: t }, deps(fetchImpl))
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
      { artifact: descriptor({ sha256: "c".repeat(64) }), targetPath: target() },
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
      { artifact: descriptor({ sha256: "c".repeat(64) }), targetPath: path.join(dir, "no-such-dir", "out.bin") },
      deps(fetchImpl),
    )
    expect(res).toMatchObject({ ok: false, error: "disk" })
  })
})

test("content 404 fails loudly without an inline compatibility request", async () => {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const { fetchImpl } = mockFetch(() => fakeResponse(404, {}, null), calls)
  const result = await downloadArtifactToFile({ artifact: descriptor(), targetPath: target() }, deps(fetchImpl))
  expect(result).toMatchObject({ ok: false, error: "not-found" })
  expect(calls).toHaveLength(1)
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
