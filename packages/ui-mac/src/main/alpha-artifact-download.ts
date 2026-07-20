// alpha cloud artifact streaming downloader — REQ-092 A 侧交付 3/4(alpha-code#184)。
// MAIN-ONLY、electron-free、依赖注入(fetch/token/base 由 alpha-cloud-jobs 装配)——
// 整个模块可在 bun:test 里对 temp dir + mock fetch 全链路验证(alpha-workdir.ts 同款可测性纪律)。
//
// 管线(REQ-092 交付 3/4,fail-closed):
//   ① 限额闸一:descriptor.size 越界 → 发请求前拒绝(零网络、零字节);
//   ② descriptor.contentRef.url 对 cloud origin 解析,强制同源(renderer 提供的 descriptor 按敌意输入
//      处理 —— bearer 绝不跟随跨源 URL 出走);
//   ③ 限额闸二:响应 Content-Length 越界 → 读 body 前 cancel + 拒绝;
//   ④ 流式写盘:response body → 同目录唯一后缀 `.part`,边写边计数 + 单遍 sha256(峰值内存 = 单 chunk,
//      不随文件大小增长);长度未知/对端少报 → 累计首次越界即 abort,关文件、删 `.part`;
//   ⑤ 校验:实收字节 vs Content-Length/descriptor.size;sha256 vs descriptor.sha256/ETag/Digest
//      (多源 digest 互相矛盾 → 读前即拒);全部通过后必须经注入的 run/project 配额 finalizer,
//      由它在原子准入临界区内 rename 落最终名,否则分类报错 + 删 `.part`;
//   ⑥ 重试永不与旧 `.part` 相撞:后缀含 pid/时钟/序号/随机量,open 用 "wx" 保持 loud。
//
// 兼容窗口(REQ-092 交付 6;⏰ INLINE_ARTIFACT_COMPAT_REMOVAL = 2026-08-15 后与平台 flag 一起删):
//   已部署平台可能尚未认得带指纹的 artifact ID / 新 content endpoint → content 404 时在 MAIN 内部
//   回退 legacy 内联路径(status?compat=inline-artifacts-v0),解码后走同一 `.part` 写入器 + 同限额 +
//   同 sha256 校验 —— 内联内容永不转发给 renderer。
//
// token 卫生(REQ-092 AC#5):bearer 只进请求头;所有错误文案过 sanitizeTransportError(剥 token /
// bearer 词形),错误面只携带分类码 + 净化后的 detail。

import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import type { FileHandle } from "node:fs/promises"
import { ALPHA_PATHS } from "../shared/alpha-config"
import {
  ARTIFACT_MAX_BYTES,
  INLINE_ARTIFACT_COMPAT_FLAG,
  parseArtifactId,
  validateArtifactDescriptor,
} from "../shared/cloud-artifact-descriptor"

export type ArtifactDownloadErrorCode =
  | "invalid-artifact" // 提供的 artifact 引用没有可用的 id/contentRef
  | "unsupported-schema" // 未知 schemaVersion:只读/报错,不得静默按 v1 解释(REQ-093 AC#8)
  | "unsafe-url" // contentRef.url 逃出 cloud origin(敌意 descriptor 防 bearer 出走)
  | "unsafe-path" // 目标路径不是绝对路径(调用方必须先过 safeResolveInAlpha)
  | "not-authenticated"
  | "no-cloud-endpoint"
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "no-content" // compat:legacy 条目没有内联内容(产出端超限省略等)
  | "over-limit"
  | "size-mismatch"
  | "sha256-mismatch"
  | "cancelled"
  | "network"
  | "disk"
  | "retryable"
  | "staging-changed"
  | "unsupported-filesystem"
  | `http-${number}`

export type ArtifactDownloadProgress = { bytes: number; total?: number; percent?: number }

export type ArtifactFinalizeInput = { partPath: string; targetPath: string; bytes: number }
export type ArtifactFinalizeResult =
  | { ok: true }
  | {
      ok: false
      error: "over-limit" | "disk" | "retryable" | "staging-changed" | "unsupported-filesystem"
      detail: string
    }
export type ArtifactFinalizer = (input: ArtifactFinalizeInput) => ArtifactFinalizeResult | Promise<ArtifactFinalizeResult>

export type ArtifactDownloadOutcome =
  | {
      ok: true
      path: string
      bytes: number
      sha256: string
      /** verified = 至少一个可信 digest(descriptor/ETag/Digest)比中;unverified = 无 digest 可比。 */
      verification: "verified" | "unverified"
      via: "stream" | "inline-compat"
    }
  | { ok: false; error: ArtifactDownloadErrorCode; detail?: string }

export type ArtifactDownloadRequest = {
  /** descriptor(schemaVersion=1,严格校验)或旧部署的 legacy meta(`{id, name?, size?, sha256?}`)。 */
  artifact: unknown
  /** 绝对目标路径;调用方负责 sanitizeArtifactName + safeResolveInAlpha(ADR-019 守卫复用)。 */
  targetPath: string
  /** compat 回退用的 job id 兜底(artifact id 可解析时以解析结果优先)。 */
  jobId?: string
  signal?: AbortSignal
  onProgress?: (p: ArtifactDownloadProgress) => void
}

export type ArtifactDownloadDeps = {
  token: string
  /** cloud API origin(descriptor.contentRef.url 是 server-relative,按此解析并强制同源)。 */
  base: string
  fetchImpl?: typeof fetch
  maxBytes?: number
  /** 悬挂检测(alpha-cloud-events 同款纪律):响应头等待 / 相邻 chunk 间隔超时 → loud network 错误,
   *  绝不让 IPC promise 永久悬挂。默认 90s。 */
  idleTimeoutMs?: number
  /** REQ-093/#279:唯一 final rename 权限;生产组装必须注入原子 run/project 配额准入。 */
  finalize: ArtifactFinalizer
}

const DEFAULT_IDLE_TIMEOUT_MS = 90_000

class IdleTimeoutError extends Error {
  constructor(ms: number) {
    super(`stream idle for ${ms}ms (no bytes)`)
    this.name = "IdleTimeoutError"
  }
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/

// ---- token 卫生(REQ-092 AC#5)----
export function sanitizeTransportError(message: string, secrets: readonly string[] = []): string {
  let out = message
  for (const s of secrets) if (s) out = out.split(s).join("[redacted]")
  out = out.replace(/bearer\s+[A-Za-z0-9._~+/=-]+/gi, "bearer [redacted]")
  return out.length > 300 ? `${out.slice(0, 300)}…` : out
}

const errMsg = (error: unknown) => (error instanceof Error ? error.message : String(error))

// ---- 唯一 .part 后缀(重试/并发绝不与旧 .part 相撞;REQ-092 AC#4)----
let partSeq = 0
export function uniquePartPath(target: string): string {
  partSeq = (partSeq + 1) % 46656 // 36^3
  const tag = `${process.pid.toString(36)}-${Date.now().toString(36)}-${partSeq.toString(36)}-${crypto.randomBytes(4).toString("hex")}`
  return `${target}.${tag}.part`
}

// ---- artifact 引用归一(descriptor 严格校验;legacy meta 宽容但零内容字段)----
type NormalizedRef = { id: string; name?: string; size?: number; sha256?: string; url: string }

function normalizeArtifactRef(artifact: unknown): { ref: NormalizedRef } | { err: ArtifactDownloadOutcome } {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    return { err: { ok: false, error: "invalid-artifact" } }
  }
  const o = artifact as Record<string, unknown>
  if ("schemaVersion" in o || "contentRef" in o) {
    const v = validateArtifactDescriptor(o)
    if (!v.ok) {
      const schemaErr = v.errors.some((e) => e.startsWith("unsupported schemaVersion"))
      return {
        err: {
          ok: false,
          error: schemaErr ? "unsupported-schema" : "invalid-artifact",
          detail: v.errors.join("; "),
        },
      }
    }
    const d = v.value
    return { ref: { id: d.id, name: d.name, size: d.size, sha256: d.sha256, url: d.contentRef.url } }
  }
  // 旧部署 artifacts 列表条目(pre-REQ-092):{id, name?, mime?, size?} —— 内容路径按 ID 拼 content endpoint。
  if (typeof o.id !== "string" || !o.id) return { err: { ok: false, error: "invalid-artifact" } }
  return {
    ref: {
      id: o.id,
      name: typeof o.name === "string" ? o.name : undefined,
      size: typeof o.size === "number" && Number.isFinite(o.size) && o.size >= 0 ? o.size : undefined,
      sha256: typeof o.sha256 === "string" && SHA256_HEX_RE.test(o.sha256) ? o.sha256 : undefined,
      url: `${ALPHA_PATHS.cloudArtifacts}/${encodeURIComponent(o.id)}/content`,
    },
  }
}

// server-relative contentRef.url 对 cloud origin 解析;强制同源(bearer 不跟随跨源 URL)。
export function resolveContentUrl(raw: string, base: string): string | null {
  try {
    const b = new URL(base)
    const u = new URL(raw, b)
    if (u.origin !== b.origin) return null
    if (u.username || u.password) return null
    return u.toString()
  } catch {
    return null
  }
}

// ---- 响应侧 digest 提取(REQ-092;平台契约:ETag `"sha256:<hex>"`,Digest RFC3230 携带 digest 字节的编码形)----
export function expectedShaFromHeaders(headers: { get(name: string): string | null }): {
  etag?: string
  digest?: string
} {
  const out: { etag?: string; digest?: string } = {}
  const etag = headers.get("etag") ?? ""
  const em = /^(?:W\/)?"sha256:([0-9a-f]{64})"$/.exec(etag)
  if (em) out.etag = em[1]
  const dig = headers.get("digest") ?? ""
  const dm = /(?:^|,)\s*sha-256=([A-Za-z0-9+/=]+)/i.exec(dig)
  if (dm) {
    try {
      const hex = Buffer.from(dm[1], "base64").toString("hex") // REQ-092:Digest 头解码(digest 字节,非内容字段)
      if (SHA256_HEX_RE.test(hex)) out.digest = hex
    } catch {
      /* 非法 Digest 头 = 无 digest 可比 */
    }
  }
  return out
}

// ---- chunk 源 ----
// idleMs:相邻 chunk 间静默超时 → 抛 IdleTimeoutError(finally 里 reader.cancel() 会让悬挂的 read
// 以 done 落定,不留未处理 rejection)。写入器把它归类为 network(僵死连接 ≠ 用户取消)。
async function* bodyChunks(body: ReadableStream<Uint8Array>, idleMs?: number): AsyncGenerator<Uint8Array> {
  const reader = body.getReader()
  try {
    for (;;) {
      let r: ReadableStreamReadResult<Uint8Array>
      if (idleMs === undefined) {
        r = await reader.read()
      } else {
        let timer: NodeJS.Timeout | undefined
        try {
          r = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new IdleTimeoutError(idleMs)), idleMs)
            }),
          ])
        } finally {
          clearTimeout(timer)
        }
      }
      if (r.done) return
      if (r.value) yield r.value
    }
  } finally {
    // 提前退出(限额 abort/取消/校验失败/idle)时逐级 cancel 上游流。
    try {
      await reader.cancel()
    } catch {
      /* upstream already gone */
    }
  }
}

// eslint-disable-next-line require-yield
async function* noChunks(): AsyncGenerator<Uint8Array> {
  return
}

/** compat 路径:内联编码文本按 4 字符对齐分片解码 → 与流路径共用同一写入器(单遍 sha/限额/.part)。 */
async function* inlineCompatChunks(encoded: string): AsyncGenerator<Uint8Array> {
  const STEP = 512 * 1024 // 4 的倍数:分片解码不破坏编码组边界
  for (let i = 0; i < encoded.length; i += STEP) {
    yield Buffer.from(encoded.slice(i, i + STEP), "base64") // REQ-092-compat:窗口期 legacy 内联解码(仅 main)
  }
}

/** 解码后的字节数上界(用于在分配任何解码 buffer 之前做限额判断)。 */
export function inlineDecodedBytes(encoded: string): number {
  let pad = 0
  if (encoded.endsWith("==")) pad = 2
  else if (encoded.endsWith("=")) pad = 1
  return Math.floor(encoded.length / 4) * 3 - pad + (encoded.length % 4 === 0 ? 0 : 3)
}

// ---- 核心写入器:chunk 流 → .part(计数 + 单遍 sha256)→ 校验 → 原子 rename ----
type WriteCheckedOpts = {
  targetPath: string
  maxBytes: number
  /** 响应声明的 Content-Length(调用方已保证 ≤ maxBytes);实收不等 → size-mismatch。 */
  declaredLength?: number
  /** descriptor 声明的字节数;实收不等 → size-mismatch。 */
  expectedSize?: number
  /** 归一后的期望 sha256(descriptor/ETag/Digest 单一化后);不符 → sha256-mismatch。 */
  expectedSha256?: string
  signal?: AbortSignal
  onProgress?: (p: ArtifactDownloadProgress) => void
  via: "stream" | "inline-compat"
  finalize: ArtifactFinalizer
}

export async function writeChunksChecked(
  chunks: AsyncIterable<Uint8Array>,
  opts: WriteCheckedOpts,
): Promise<ArtifactDownloadOutcome> {
  const total = opts.declaredLength ?? opts.expectedSize
  const part = uniquePartPath(opts.targetPath)
  const hash = crypto.createHash("sha256")
  let fh: FileHandle | null = null
  let bytes = 0
  let lastEmit = -1
  const emit = (final = false) => {
    if (!opts.onProgress) return
    if (!final && bytes - lastEmit < 256 * 1024) return
    lastEmit = bytes
    opts.onProgress({
      bytes,
      ...(total !== undefined ? { total, percent: total > 0 ? Math.min(100, Math.round((bytes / total) * 100)) : 100 } : {}),
    })
  }
  const cleanup = async () => {
    try {
      await fh?.close()
    } catch {
      /* already closed */
    }
    fh = null
    try {
      fs.rmSync(part, { force: true })
    } catch {
      /* best-effort: .part 不残留 */
    }
  }

  try {
    // "wx":已存在即 loud 失败 —— 唯一后缀让碰撞≈不可能,但绝不静默覆写别人的半成品。
    fh = await fs.promises.open(part, "wx")
  } catch (error) {
    return { ok: false, error: "disk", detail: sanitizeTransportError(errMsg(error)) }
  }

  try {
    for await (const chunk of chunks) {
      if (opts.signal?.aborted) {
        await cleanup()
        return { ok: false, error: "cancelled" }
      }
      bytes += chunk.byteLength
      if (bytes > opts.maxBytes) {
        // 长度未知/对端少报:累计首次越界立即 abort(关文件 + 删 .part;for-await 提前退出会 cancel 上游)。
        await cleanup()
        return {
          ok: false,
          error: "over-limit",
          detail: `stream exceeded ${opts.maxBytes} bytes (declared ${opts.declaredLength ?? "unknown"})`,
        }
      }
      hash.update(chunk)
      try {
        let off = 0
        while (off < chunk.byteLength) {
          const { bytesWritten } = await fh.write(chunk, off, chunk.byteLength - off)
          if (bytesWritten <= 0) throw new Error("short write")
          off += bytesWritten
        }
      } catch (error) {
        await cleanup()
        return { ok: false, error: "disk", detail: sanitizeTransportError(errMsg(error)) }
      }
      emit()
    }
  } catch (error) {
    // 读取侧失败(断流/abort)。写入侧失败已在内层归类为 disk。
    await cleanup()
    if (opts.signal?.aborted) return { ok: false, error: "cancelled" }
    return { ok: false, error: "network", detail: sanitizeTransportError(errMsg(error)) }
  }

  if (opts.signal?.aborted) {
    await cleanup()
    return { ok: false, error: "cancelled" }
  }
  if (opts.declaredLength !== undefined && bytes !== opts.declaredLength) {
    await cleanup()
    return { ok: false, error: "size-mismatch", detail: `content-length declared ${opts.declaredLength}, received ${bytes}` }
  }
  if (opts.expectedSize !== undefined && bytes !== opts.expectedSize) {
    await cleanup()
    return { ok: false, error: "size-mismatch", detail: `descriptor size ${opts.expectedSize}, received ${bytes}` }
  }
  const sha256 = hash.digest("hex")
  if (opts.expectedSha256 !== undefined && sha256 !== opts.expectedSha256) {
    await cleanup()
    return { ok: false, error: "sha256-mismatch", detail: `expected sha256 ${opts.expectedSha256}, got ${sha256}` }
  }
  try {
    await fh.sync()
    await fh.close()
    fh = null
    const finalized = await opts.finalize({ partPath: part, targetPath: opts.targetPath, bytes })
    if (!finalized.ok) {
      await cleanup()
      return finalized
    }
  } catch (error) {
    await cleanup()
    return { ok: false, error: "disk", detail: sanitizeTransportError(errMsg(error)) }
  }
  emit(true)
  return {
    ok: true,
    path: opts.targetPath,
    bytes,
    sha256,
    verification: opts.expectedSha256 !== undefined ? "verified" : "unverified",
    via: opts.via,
  }
}

// ---- 认证 fetch + 双看门狗 ----
// 内部 AbortController:外部取消即时转发到真实连接;响应头等待超过 idle 上限 → abort + loud network
// (老实现的 30s 全程 timeout 对流式下载不可用,这里只对「无响应头」阶段限时)。
type AuthedFetchResult = { res: Response; done: () => void } | { err: ArtifactDownloadOutcome }
async function authedFetch(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  external: AbortSignal | undefined,
  headerTimeoutMs: number,
  token: string,
): Promise<AuthedFetchResult> {
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  if (external) {
    if (external.aborted) return { err: { ok: false, error: "cancelled" } }
    external.addEventListener("abort", onAbort, { once: true })
  }
  const done = () => external?.removeEventListener("abort", onAbort)
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort()
      reject(new IdleTimeoutError(headerTimeoutMs))
    }, headerTimeoutMs)
  })
  try {
    const pending = fetchImpl(url, { headers, signal: ctrl.signal })
    void pending.catch(() => {}) // 落选方(abort 后的 rejection)不留未处理 rejection
    const res = await Promise.race([pending, timeout])
    return { res, done }
  } catch (error) {
    done()
    if (external?.aborted) return { err: { ok: false, error: "cancelled" } }
    if (error instanceof IdleTimeoutError || ctrl.signal.aborted) {
      return { err: { ok: false, error: "network", detail: `no response headers within ${headerTimeoutMs}ms` } }
    }
    return { err: { ok: false, error: "network", detail: sanitizeTransportError(errMsg(error), [token]) } }
  } finally {
    clearTimeout(timer)
  }
}

// ---- 主入口 ----
export async function downloadArtifactToFile(
  req: ArtifactDownloadRequest,
  deps: ArtifactDownloadDeps,
): Promise<ArtifactDownloadOutcome> {
  const maxBytes = deps.maxBytes ?? ARTIFACT_MAX_BYTES
  const idleMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const fetchImpl = deps.fetchImpl ?? fetch
  if (!path.isAbsolute(req.targetPath)) return { ok: false, error: "unsafe-path" }
  const norm = normalizeArtifactRef(req.artifact)
  if ("err" in norm) return norm.err
  const ref = norm.ref

  // 限额闸一(REQ-092 AC#3):descriptor 声明尺寸越界 → 不发请求、不碰任何字节。
  if (ref.size !== undefined && ref.size > maxBytes) {
    return { ok: false, error: "over-limit", detail: `descriptor size ${ref.size} > max ${maxBytes}` }
  }
  const url = resolveContentUrl(ref.url, deps.base)
  if (!url) return { ok: false, error: "unsafe-url", detail: "contentRef.url escapes the cloud origin" }

  const f = await authedFetch(fetchImpl, url, { authorization: `Bearer ${deps.token}` }, req.signal, idleMs, deps.token)
  if ("err" in f) return f.err
  const res = f.res
  try {
    return await streamStage(req, ref, deps, maxBytes, idleMs, res)
  } finally {
    f.done()
  }
}

async function streamStage(
  req: ArtifactDownloadRequest,
  ref: NormalizedRef,
  deps: ArtifactDownloadDeps,
  maxBytes: number,
  idleMs: number,
  res: Response,
): Promise<ArtifactDownloadOutcome> {
  if (res.status === 404) {
    // 已部署平台可能不认得带指纹的 ID / 尚未上新 content endpoint → 窗口期 legacy 内联回退(仅 main)。
    await discardBody(res)
    return fetchInlineCompat(req, ref, deps, maxBytes)
  }
  if (res.status === 401) return discardAnd(res, { ok: false, error: "unauthorized" })
  if (res.status === 403) return discardAnd(res, { ok: false, error: "forbidden" })
  if (res.status === 413) return discardAnd(res, { ok: false, error: "over-limit", detail: "platform rejected: artifact exceeds max size" })
  if (!res.ok) return discardAnd(res, { ok: false, error: `http-${res.status}` })

  // digest 三源归一(descriptor.sha256 / ETag / Digest):互相矛盾 → 读 body 前即拒。
  const hdr = expectedShaFromHeaders(res.headers)
  const shaCandidates = [...new Set([ref.sha256, hdr.etag, hdr.digest].filter((x): x is string => typeof x === "string"))]
  if (shaCandidates.length > 1) {
    return discardAnd(res, {
      ok: false,
      error: "sha256-mismatch",
      detail: "digest sources disagree (descriptor vs ETag/Digest headers)",
    })
  }
  const expectedSha256 = shaCandidates[0]

  // 限额闸二(REQ-092 AC#3):声明 Content-Length 越界 → 读任何 body 字节之前 cancel + 拒绝。
  let declaredLength: number | undefined
  const lenRaw = res.headers.get("content-length")
  if (lenRaw != null && lenRaw !== "") {
    const n = Number(lenRaw)
    if (Number.isFinite(n) && n >= 0) {
      if (n > maxBytes) {
        return discardAnd(res, { ok: false, error: "over-limit", detail: `content-length ${n} > max ${maxBytes}` })
      }
      declaredLength = n
    }
  }

  return writeChunksChecked(res.body ? bodyChunks(res.body, idleMs) : noChunks(), {
    targetPath: req.targetPath,
    maxBytes,
    declaredLength,
    expectedSize: ref.size,
    expectedSha256,
    signal: req.signal,
    onProgress: req.onProgress,
    via: "stream",
    finalize: deps.finalize,
  })
}

async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel()
  } catch {
    /* nothing to discard */
  }
}
async function discardAnd(res: Response, outcome: ArtifactDownloadOutcome): Promise<ArtifactDownloadOutcome> {
  await discardBody(res)
  return outcome
}

// ---- 兼容窗口:legacy 内联回退(REQ-092 交付 6;⏰ 2026-08-15 移除,见 INLINE_ARTIFACT_COMPAT_REMOVAL)----
// 旧内联 status JSON 会把内容放大 ~4/3,必须整份缓冲才能 JSON.parse —— 诚实缓解:响应缓冲带硬帽
// (maxBytes*4/3 + 2MiB),Content-Length 前置判 + 边读边计数,越界即 abort。解码前再按解码字节数过限额,
// 解码分片写入与流路径同一 writeChunksChecked(同限额、同 sha256、同 .part/rename)。
async function fetchInlineCompat(
  req: ArtifactDownloadRequest,
  ref: NormalizedRef,
  deps: ArtifactDownloadDeps,
  maxBytes: number,
): Promise<ArtifactDownloadOutcome> {
  if (req.signal?.aborted) return { ok: false, error: "cancelled" }
  const fetchImpl = deps.fetchImpl ?? fetch
  const idleMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const parsed = parseArtifactId(ref.id)
  const jobId = parsed?.jobId ?? req.jobId
  if (!jobId) {
    return { ok: false, error: "not-found", detail: "content endpoint 404 and no job id available for legacy fallback" }
  }
  const statusUrl = resolveContentUrl(
    `${ALPHA_PATHS.cloudJobs}/${encodeURIComponent(jobId)}?compat=${INLINE_ARTIFACT_COMPAT_FLAG}`,
    deps.base,
  )
  if (!statusUrl) return { ok: false, error: "unsafe-url" }

  const f = await authedFetch(
    fetchImpl,
    statusUrl,
    { authorization: `Bearer ${deps.token}`, "x-alpha-compat": INLINE_ARTIFACT_COMPAT_FLAG },
    req.signal,
    idleMs,
    deps.token,
  )
  if ("err" in f) return f.err
  const res = f.res
  try {
    return await inlineCompatStage(req, ref, deps, maxBytes, idleMs, parsed, res)
  } finally {
    f.done()
  }
}

async function inlineCompatStage(
  req: ArtifactDownloadRequest,
  ref: NormalizedRef,
  deps: ArtifactDownloadDeps,
  maxBytes: number,
  idleMs: number,
  parsed: ReturnType<typeof parseArtifactId>,
  res: Response,
): Promise<ArtifactDownloadOutcome> {
  if (res.status === 401) return discardAnd(res, { ok: false, error: "unauthorized" })
  if (res.status === 403) return discardAnd(res, { ok: false, error: "forbidden" })
  if (res.status === 404) return discardAnd(res, { ok: false, error: "not-found" })
  if (!res.ok) return discardAnd(res, { ok: false, error: `http-${res.status}` })

  // 响应缓冲硬帽:Content-Length 前置判 + 边读边计数(内联 JSON ≈ 内容 * 4/3 + 信封)。
  const cap = Math.ceil((maxBytes * 4) / 3) + 2 * 1024 * 1024
  const lenRaw = res.headers.get("content-length")
  if (lenRaw != null && lenRaw !== "") {
    const n = Number(lenRaw)
    if (Number.isFinite(n) && n > cap) {
      return discardAnd(res, { ok: false, error: "over-limit", detail: `legacy status response ${n} bytes > cap ${cap}` })
    }
  }
  const buf: Uint8Array[] = []
  let got = 0
  if (res.body) {
    try {
      for await (const chunk of bodyChunks(res.body, idleMs)) {
        if (req.signal?.aborted) return { ok: false, error: "cancelled" }
        got += chunk.byteLength
        if (got > cap) {
          return { ok: false, error: "over-limit", detail: `legacy status response exceeded cap ${cap}` }
        }
        buf.push(chunk)
      }
    } catch (error) {
      if (req.signal?.aborted) return { ok: false, error: "cancelled" }
      return { ok: false, error: "network", detail: sanitizeTransportError(errMsg(error), [deps.token]) }
    }
  }

  let status: unknown
  try {
    status = JSON.parse(Buffer.concat(buf).toString("utf8"))
  } catch {
    return { ok: false, error: "not-found", detail: "legacy status response is not JSON" }
  }
  const result = (status as { result?: unknown } | null)?.result
  const arts = (result as { artifacts?: unknown } | null)?.artifacts
  if (!Array.isArray(arts)) return { ok: false, error: "not-found", detail: "legacy result carries no artifacts" }

  // 定位条目:ID 内嵌 index 优先(名字都在时须一致),否则按名字匹配。
  let entry: Record<string, unknown> | undefined
  if (parsed && parsed.index >= 0 && parsed.index < arts.length) {
    const cand = arts[parsed.index] as Record<string, unknown> | undefined
    const candName = cand && typeof cand.name === "string" ? cand.name : undefined
    if (cand && (ref.name === undefined || candName === undefined || candName === ref.name)) entry = cand
  }
  if (!entry && ref.name !== undefined) {
    entry = arts.find((a): a is Record<string, unknown> => !!a && typeof a === "object" && (a as Record<string, unknown>).name === ref.name)
  }
  if (!entry) return { ok: false, error: "not-found", detail: "artifact not present in legacy result" }

  const inline = entry.base64 // REQ-092-compat:窗口期 legacy 内联字段,仅 main 消费,永不进 renderer
  if (typeof inline !== "string") {
    return { ok: false, error: "no-content", detail: "legacy artifact entry has no inline content" }
  }
  // 限额(与流路径同值):按解码后字节数在分配任何解码 buffer 之前判断。
  const decoded = inlineDecodedBytes(inline)
  if (decoded > maxBytes) {
    return { ok: false, error: "over-limit", detail: `legacy inline artifact ${decoded} bytes > max ${maxBytes}` }
  }
  const entrySha = typeof entry.sha256 === "string" && SHA256_HEX_RE.test(entry.sha256) ? entry.sha256 : undefined
  const shaCandidates = [...new Set([ref.sha256, entrySha].filter((x): x is string => typeof x === "string"))]
  if (shaCandidates.length > 1) {
    return { ok: false, error: "sha256-mismatch", detail: "digest sources disagree (descriptor vs legacy entry)" }
  }
  const entrySize = typeof entry.size === "number" && Number.isFinite(entry.size) ? entry.size : undefined

  return writeChunksChecked(inlineCompatChunks(inline), {
    targetPath: req.targetPath,
    maxBytes,
    expectedSize: ref.size ?? entrySize,
    expectedSha256: shaCandidates[0],
    signal: req.signal,
    onProgress: req.onProgress,
    via: "inline-compat",
    finalize: deps.finalize,
  })
}
