// cloud-vision — 看不了图的模型,把图送云端识图(`#1419`,REQ-228 基线 §2-B;云端半场 alpha-platform#484 已上线)。
//
// 两条路径,最终落到**同一个**识图接口 `POST <gateway>/v1/tools/vision`(基线 §2-0:能力只在 gateway 那条路由上):
//   · 自动转写(产品自己的动作):`chat.message` 里对用户贴的图、`tool.execute.after` 里对 Read 读到的图,
//     **直接打 HTTP**,不经 MCP tool —— 这不是模型发起的工具调用,不该出现在模型的工具轨迹里;
//   · 模型追问:模型调 `cloud_cloud_vision` 时 `tool.execute.before` 把 `args.image` 原地换成压缩后的 base64。
//
// ── 凭据从哪来(2026-09-24 勘破)────────────────────────────────────────────────────
// 引擎访问云端用的是登录铸的 `mcp_access` token:ui-mac 每次 fork 把云 MCP 定义经 `ALPHA_CLOUD_MCP_DEF`
// 交给本插件(`alpha-config-injection.ts:391`),定义里 `headers.Authorization = "Bearer {file:…ALPHA_MCP_TOKEN}"`
// (`cloud-sidecar-config.ts`,`#1195`);`installCloudMcp()` 已经在解析这个 `{file:}`。gateway 的 vision 路由
// 对**这一条封印路径**额外接受 `mcp_access`(alpha-platform `worker.ts` visionHandler:`FORWARDED_MCP_AUTH_OPTS`
// 与 `actionAllowed(auth, "cloud.dispatch")`),而云 MCP 的 `cloud_vision` 也只是把同一个 Authorization 原样转发
// 到同一条路由(`cloud-mcp.ts` mount)。所以这里用的**就是**引擎经 MCP 访问云端的那份凭据,不另铸、不回退。
// 路由的主机:`ALPHA_BASE_URL`(`alpha-auth.ts:301`,= `<platform>/v1`,platform 即 gateway 主机)的 origin。
// 凭据在每次调用时现读文件(令牌续期会重写文件;比引擎装配置时解析一次更新)。
//
// ── 「云端是否可用」(与 alpha-code#1411 同轴)──────────────────────────────────────
// `#1411` / `#1442` 的判据是 `platformPays = ALPHA_CLOUD_MCP_URL && ALPHA_MCP_TOKEN 密钥文件在场`,桌面侧
// 「登录+有额度」与「登录+无额度」**不可区分**(account 契约没有只读额度查询),额度只在调用时以 402 出面。
// 这里同一根轴:DEF 缺席 / 定义无 Authorization(= 密钥文件缺席时 ui-mac 给的 `enabled:false` 形状)/ `{file:}`
// 读不到 ⇒ 未登录;HTTP 401/403 ⇒ 凭据失效;402 ⇒ 无额度;5xx / 网络 ⇒ 上游故障 —— 每一种都给用户说得出原因的话。
//
// ── 固定 `model:"qwen"`、`fallback_on_refusal:false`(owner 2026-09-23)──────────────────
// Code Puppy 只用千问,审核拒绝不换 Gemini:qwen 拒图 ⇒ gateway 回 422 `content_refused`、不扣费,这里显示
// 「这张图片无法识别」。两个参数**每次调用都由本模块写死**,模型在 `cloud_cloud_vision` 里传的值也被覆盖。
//
// ── 模型追问时「读路径」的权限判定(基线 §3 最后一行)────────────────────────────────
// 插件里没有 Read 工具的 `ctx.ask`,而手写一份权限规则求值就是「替别人的文法造替身」。所以这里根本不从路径
// 读盘:`image` 只能指向**本会话里已经出现过的图片** —— 用户贴的(附件编号 / 文件名)或 Read 工具读到的
// (路径 / 文件名)。Read 那一步走的就是引擎自己的权限判定;没读过的路径在这里只会得到一句「先用 Read 读它」。
// 登记簿按会话建,内容哈希去重;进程重启后由 `experimental.chat.messages.transform` 从历史消息里重建。

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { CLOUD_MCP_DEF_ENV, CLOUD_MCP_SERVER_ENV, mcpEngineToolId, resolveFileRefs } from "./cloud-websearch-kill"
import {
  contextText,
  renderTemplate,
  renderWrapper,
  type VisionFailureKind,
  visionFailureId,
  VISION_TOOL_INPUT_OMITTED_ID,
  VISION_TOOL_REFUSED_ID,
  VISION_TRANSCRIPT_ID,
} from "./context-injection"
import { compressForVision, sniffImageMime, VISION_IMAGE_MAX_BYTES, VisionImageDecodeError, VisionImageTooLargeError, type CompressedImage } from "./vision-image"

/** 云 worker 自己 advertise 的远端工具名(alpha-platform `cloud-mcp.ts` mount);引擎 id 是 `<server>_cloud_vision`。 */
export const CLOUD_VISION_REMOTE_TOOL = "cloud_vision"
/** gateway 上唯一接受图片的路由(alpha-platform `contracts/v1/billing-actions.ts` `CLOUD_MCP_VISION_ROUTE`)。 */
export const CLOUD_VISION_ROUTE = "/v1/tools/vision"
/** owner 2026-09-23:Code Puppy 只用千问。封闭枚举的 key,不是上游 id。 */
export const CLOUD_VISION_MODEL = "qwen"
/** owner 2026-09-23:审核拒绝不换 Gemini(千问拒的图不经 Google 交给国内用户)。 */
export const CLOUD_VISION_FALLBACK_ON_REFUSAL = false
/** 线上实测默认档约 10 s;上游超时 gateway 自己会以 504 收场,这里只兜住连接层面的挂死。 */
export const CLOUD_VISION_TIMEOUT_MS = 90_000
/** 每会话登记的图片上限(每张最多留一份原始 base64,≤ 5 MiB);超过丢最旧的。 */
export const VISION_SESSION_MAX_IMAGES = 32

export function cloudVisionToolId(env: Record<string, string | undefined> = process.env): string | undefined {
  const server = env[CLOUD_MCP_SERVER_ENV]
  return server ? mcpEngineToolId(server, CLOUD_VISION_REMOTE_TOOL) : undefined
}

/** `ALPHA_BASE_URL`(`<platform>/v1`)的 origin + 识图路由;没有 = 未登录平台 / BYOK 态。 */
export function cloudVisionEndpoint(env: Record<string, string | undefined> = process.env): string | undefined {
  const base = env.ALPHA_BASE_URL
  if (!base) return undefined
  try {
    return new URL(CLOUD_VISION_ROUTE, new URL(base).origin).toString()
  } catch {
    return undefined
  }
}

export type CloudVisionUnavailable = "not-logged-in" | "credential-unreadable"
export type CloudVisionAccess =
  | { readonly ok: true; readonly endpoint: string; readonly authorization: string }
  | { readonly ok: false; readonly reason: CloudVisionUnavailable }

/**
 * 云端识图此刻可不可用,以及用哪份凭据。**每次调用现算**(令牌文件会被续期重写)。
 * 判据与 `#1411` 的 platformPays 同轴:云 MCP 定义在场且带 Authorization、`{file:}` 读得到 ⇒ 可用。
 */
export function cloudVisionAccess(
  env: Record<string, string | undefined> = process.env,
  readFile: (p: string) => string = (p) => readFileSync(p, "utf8"),
): CloudVisionAccess {
  const endpoint = cloudVisionEndpoint(env)
  const raw = env[CLOUD_MCP_DEF_ENV]
  if (!endpoint || !raw) return { ok: false, reason: "not-logged-in" }
  let definition: unknown
  try {
    definition = JSON.parse(raw)
  } catch {
    return { ok: false, reason: "not-logged-in" }
  }
  const header = (definition as { headers?: { Authorization?: unknown } } | null)?.headers?.Authorization
  // 密钥文件缺席时 ui-mac 给的是不带 headers 的 enabled:false 形状(cloud-sidecar-config.ts 文件头第 3 条)。
  if (typeof header !== "string" || header.trim() === "") return { ok: false, reason: "not-logged-in" }
  try {
    const authorization = resolveFileRefs(header, readFile)
    if (typeof authorization !== "string" || authorization.trim() === "") return { ok: false, reason: "credential-unreadable" }
    return { ok: true, endpoint, authorization }
  } catch {
    return { ok: false, reason: "credential-unreadable" }
  }
}

export type VisionOutcome =
  | { readonly ok: true; readonly text: string; readonly model: string; readonly fallbackUsed: boolean }
  | { readonly ok: false; readonly kind: VisionFailureKind; readonly detail: string }

/** HTTP 状态 + 错误码 → 用户能看懂的一类(错误码表见 alpha-platform `contracts/v1/vision.ts` `VISION_ERROR_CODES`)。 */
export function classifyVisionFailure(status: number, code: string | undefined): VisionFailureKind {
  if (code === "content_refused" || code === "content_blocked") return "refused"
  if (status === 401 || status === 403) return "credential"
  if (status === 402) return "no-credit"
  if (status === 429) return "rate-limited"
  if (status === 400 || status === 413) return "image-rejected"
  return "provider"
}

export type DescribeImageInput = {
  readonly access: { readonly endpoint: string; readonly authorization: string }
  readonly image: CompressedImage
  readonly question?: string
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
}

/** 请求体的形状(与 alpha-platform `VisionRequestV1Schema` 同形;`model` / `fallback_on_refusal` 恒由本模块写死)。 */
export function visionRequestBody(image: CompressedImage, question?: string) {
  return {
    image: image.base64,
    mime: image.mime,
    ...(question ? { question } : {}),
    model: CLOUD_VISION_MODEL,
    fallback_on_refusal: CLOUD_VISION_FALLBACK_ON_REFUSAL,
  }
}

/** 一次识图调用。绝不抛:每种结局都是一个可分类的 `VisionOutcome`。 */
export async function describeImage(input: DescribeImageInput): Promise<VisionOutcome> {
  const doFetch = input.fetch ?? fetch
  let response: Response
  try {
    response = await doFetch(input.access.endpoint, {
      method: "POST",
      headers: { authorization: input.access.authorization, "content-type": "application/json" },
      body: JSON.stringify(visionRequestBody(input.image, input.question)),
      signal: AbortSignal.timeout(input.timeoutMs ?? CLOUD_VISION_TIMEOUT_MS),
    })
  } catch (error) {
    return { ok: false, kind: "network", detail: error instanceof Error ? error.message : String(error) }
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (response.ok) {
    const text = (body as { text?: unknown } | undefined)?.text
    if (typeof text === "string" && text.trim() !== "") {
      const model = (body as { model?: unknown }).model
      return { ok: true, text, model: typeof model === "string" ? model : "", fallbackUsed: (body as { fallback_used?: unknown }).fallback_used === true }
    }
    return { ok: false, kind: "provider", detail: `${response.status} success body without text` }
  }
  const error = (body as { error?: { code?: unknown; message?: unknown } } | undefined)?.error
  const code = typeof error?.code === "string" ? error.code : undefined
  const message = typeof error?.message === "string" ? error.message : ""
  return { ok: false, kind: classifyVisionFailure(response.status, code), detail: `${response.status}${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}` }
}

// ── 进模型上下文的文字(全部经 context-injection.ts 登记)────────────────────────────

/** `#1447` R1 m1:label / body 里的定界符换成形近字符,免得云端正文或文件名里的「〕」提前闭合外框。 */
export function safeDelimiters(text: string): string {
  return text.replaceAll("〔", "〘").replaceAll("〕", "〙")
}

/** `#1447` R1 m2:块里的标签 = `#<编号> <名字>`,模型据编号追问;重建后编号来自持久化的标记,不漂移。 */
export function visionLabel(entry: { readonly number: number; readonly label: string }, name?: string): string {
  return `#${entry.number} ${name ?? entry.label}`
}

/** 转写块:外框是 alpha 的字(登记为 wrapper),正文是云端认出来的内容(别人的字)。 */
export function visionTranscriptBlock(label: string, text: string): string {
  return renderWrapper(VISION_TRANSCRIPT_ID, { label: safeDelimiters(label), body: safeDelimiters(text) })
}

/** 失败块:整句都是 alpha 的字(每种原因各一条登记模板,`{name}` = 图片标签)。 */
export function visionFailureBlock(label: string, kind: VisionFailureKind): string {
  return renderTemplate(visionFailureId(kind), { name: safeDelimiters(label) })
}

/** 历史里 `cloud_cloud_vision` 因审核被拒(引擎把 isError 抛成部件的 error)时,回放给模型的替换文本。 */
export function visionToolRefusedText(): string {
  return contextText(VISION_TOOL_REFUSED_ID)
}

/** 历史里 `cloud_cloud_vision` 的 `input.image` 已是 base64 本体、原引用又不可考时,回放给模型的替换文本。 */
export function visionToolInputOmittedText(): string {
  return contextText(VISION_TOOL_INPUT_OMITTED_ID)
}

// ── 会话级登记簿 ──────────────────────────────────────────────────────────────────

export type VisionImageEntry = {
  /** 会话内的附件编号,从 1 起;模型据此追问。 */
  readonly number: number
  /** 给人和模型看的标签:文件名,或 Read 的路径的 basename。 */
  readonly label: string
  /** 原始字节的 sha256(去重 / 计费不重复的依据)。 */
  readonly hash: string
  /** Read 工具读到时的绝对路径;用户贴的图没有。 */
  readonly path?: string
  /**
   * 压缩后的形态(懒算、按上限各缓存一份)。缺省上限 = 直打 HTTP 的 `VISION_IMAGE_MAX_BYTES`;追问走 `/mcp` 时传
   * `VISION_MCP_IMAGE_MAX_BYTES`(`#1447` R1 B1)。解不出 / 缩不进 ⇒ 抛 VisionImageDecodeError / VisionImageTooLargeError。
   */
  compressed(maxBytes?: number): Promise<CompressedImage>
}

/** `#1447` R1 M1:持久化标记里恢复登记项所需的全部字段(哈希与编号以标记为准,不对存下来的字节重算)。 */
export type RestoreImageInput = {
  readonly hash: string
  readonly number: number
  readonly label?: string
  /** 云端认出来的正文;有则恢复 transcripts(重启后同图再贴不再出网)。 */
  readonly text?: string
  /** 持久化的图片字节(可能是引擎缩过的);只用于之后的追问压缩。缺席则只恢复正文与哈希映射,不登记条目。 */
  readonly base64?: string
  readonly path?: string
  readonly partID?: string
}

export type RegisterImageInput = {
  readonly base64: string
  readonly label?: string
  readonly path?: string
  /** 引擎 part id:同一 part 每次请求都会再经过登记簿(messages.transform 重建),用它免去重复哈希。 */
  readonly partID?: string
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

export class VisionSession {
  /** hash → 云端认出来的正文(只记成功;失败不记,下次仍会重试)。 */
  readonly transcripts = new Map<string, string>()
  private readonly inflight = new Map<string, Promise<VisionOutcome>>()
  private readonly entries: VisionImageEntry[] = []
  private readonly hashByPart = new Map<string, string>()
  /** 因超过 VISION_SESSION_MAX_IMAGES 被挤出去的哈希:再遇到不重新编号(编号一旦漂移,模型手里的引用就全错了)。 */
  private readonly evicted = new Set<string>()
  private nextNumber = 1
  /** 本进程里是否已从会话历史恢复过(`#1447` R1 M1);钩子第一次碰到这个会话时做一次。 */
  hydrated = false

  /** 登记一张图(同内容只登记一次;再次出现只补路径别名)。已被挤出登记簿的内容返回 undefined。 */
  register(input: RegisterImageInput): VisionImageEntry | undefined {
    const known = input.partID ? this.hashByPart.get(input.partID) : undefined
    const bytes = known ? undefined : Buffer.from(input.base64, "base64")
    const hash = known ?? sha256(bytes!)
    if (input.partID) this.hashByPart.set(input.partID, hash)
    if (this.evicted.has(hash)) return undefined
    const existing = this.entries.find((e) => e.hash === hash)
    if (existing) {
      if (input.path && !existing.path) (existing as { path?: string }).path = input.path
      return existing
    }
    return this.createEntry({ number: this.nextNumber++, label: input.label, hash, path: input.path, base64: input.base64, bytes })
  }

  /**
   * `#1447` R1 M1:从持久化标记恢复(进程重启后)。哈希与编号取**标记里的值** —— 引擎会把 >2000px 的图缩过再存
   * (`session/prompt.ts` 的 `image.normalize` 在本插件之后跑),对存下来的字节重算哈希会与当初贴图时算的对不上,
   * 同图再贴就会再计费。正文有则恢复 transcripts;字节只用于之后的追问压缩。
   */
  restore(input: RestoreImageInput): VisionImageEntry | undefined {
    if (input.partID) this.hashByPart.set(input.partID, input.hash)
    if (typeof input.text === "string" && input.text !== "" && !this.transcripts.has(input.hash)) this.transcripts.set(input.hash, input.text)
    if (this.evicted.has(input.hash)) return undefined
    const existing = this.entries.find((e) => e.hash === input.hash)
    if (existing) {
      if (input.path && !existing.path) (existing as { path?: string }).path = input.path
      return existing
    }
    if (!input.base64) return undefined
    if (input.number >= this.nextNumber) this.nextNumber = input.number + 1
    return this.createEntry({ number: input.number, label: input.label, hash: input.hash, path: input.path, base64: input.base64 })
  }

  private createEntry(input: { number: number; label?: string; hash: string; path?: string; base64: string; bytes?: Buffer }): VisionImageEntry {
    const { base64, bytes } = input
    // 直打 HTTP 与 `/mcp` 追问的上限不同(B1),各缓存一份;失败不缓存,下次重试。
    const compressedByLimit = new Map<number, Promise<CompressedImage>>()
    const entry: VisionImageEntry = {
      number: input.number,
      label: input.label ?? (input.path ? path.basename(input.path) : `image-${input.number}`),
      hash: input.hash,
      ...(input.path ? { path: input.path } : {}),
      compressed: (maxBytes: number = VISION_IMAGE_MAX_BYTES) => {
        let promise = compressedByLimit.get(maxBytes)
        if (!promise) {
          promise = compressForVision(bytes ?? Buffer.from(base64, "base64"), { maxBytes })
          compressedByLimit.set(maxBytes, promise)
          promise.catch(() => {
            compressedByLimit.delete(maxBytes)
          })
        }
        return promise
      },
    }
    this.entries.push(entry)
    while (this.entries.length > VISION_SESSION_MAX_IMAGES) {
      const dropped = this.entries.shift()
      if (dropped) this.evicted.add(dropped.hash)
    }
    return entry
  }

  /** 本会话登记过的图(编号升序)。 */
  list(): readonly VisionImageEntry[] {
    return this.entries
  }

  /**
   * 模型在 `image` 里写的引用 → 登记项。认:附件编号(`1` / `#1` / `图片 1` / `image 1`)、文件名 / 路径 basename、
   * 绝对或相对 `directory` 的路径(与 Read 读到时的路径比对)、sha256 前缀(≥ 8 位)。多个命中取最近登记的。
   */
  lookup(ref: string, directory: string): VisionImageEntry | undefined {
    const trimmed = ref.trim()
    if (!trimmed) return undefined
    const numbered = /^#?\s*(?:图片|附件|image|attachment)?\s*#?\s*(\d+)\s*$/i.exec(trimmed)
    if (numbered) {
      const n = Number(numbered[1])
      return this.entries.find((e) => e.number === n)
    }
    const latest = (pred: (e: VisionImageEntry) => boolean) => [...this.entries].reverse().find(pred)
    if (/^[0-9a-f]{8,64}$/i.test(trimmed)) {
      const byHash = latest((e) => e.hash.startsWith(trimmed.toLowerCase()))
      if (byHash) return byHash
    }
    const resolved = path.resolve(directory, trimmed)
    const byPath = latest((e) => e.path !== undefined && e.path === resolved)
    if (byPath) return byPath
    const base = path.basename(trimmed)
    return latest((e) => e.label === trimmed || e.label === base || (e.path !== undefined && path.basename(e.path) === base))
  }

  /** 同一张图在途的调用只发一次;成功即记入 transcripts。 */
  describeOnce(entry: VisionImageEntry, run: () => Promise<VisionOutcome>): Promise<VisionOutcome> {
    const cached = this.transcripts.get(entry.hash)
    if (cached !== undefined) return Promise.resolve({ ok: true, text: cached, model: "", fallbackUsed: false })
    const pending = this.inflight.get(entry.hash)
    if (pending) return pending
    const promise = run()
      .then((outcome) => {
        if (outcome.ok) this.transcripts.set(entry.hash, outcome.text)
        return outcome
      })
      .finally(() => this.inflight.delete(entry.hash))
    this.inflight.set(entry.hash, promise)
    return promise
  }
}

export type TranscribeDeps = {
  readonly access: CloudVisionAccess
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
  readonly log?: (message: string) => void
}

/**
 * 一张已登记的图 → 进模型上下文的一段字(转写块或失败块)。绝不抛。
 * 云端不可用 ⇒ 不压缩、不出网,直接给原因;同一内容只出网一次(会话内哈希去重)。
 * `name` 是这一次出现时的名字(同一张图换名再贴,块里写的是这次的名字),缺省用登记时的;块里的标签恒为 `#<编号> <名字>`。
 */
export async function transcribeEntry(session: VisionSession, entry: VisionImageEntry, deps: TranscribeDeps, name?: string): Promise<string> {
  const label = visionLabel(entry, name)
  const cached = session.transcripts.get(entry.hash)
  if (cached !== undefined) return visionTranscriptBlock(label, cached)
  if (!deps.access.ok) return visionFailureBlock(label, deps.access.reason === "credential-unreadable" ? "credential" : "not-logged-in")
  const access = deps.access
  let image: CompressedImage
  try {
    image = await entry.compressed()
  } catch (error) {
    if (error instanceof VisionImageDecodeError || error instanceof VisionImageTooLargeError) {
      deps.log?.(`[@alpha-code/ext] cloud vision: ${label} not sent — ${error.message}`)
      return visionFailureBlock(label, "unsupported-format")
    }
    // 装不上 photon(wasm 缺席之类)也落在这一格:本机压不了 ⇒ 不发原图去撞 413。
    deps.log?.(`[@alpha-code/ext] cloud vision: compressor unavailable for ${label} — ${error instanceof Error ? error.message : String(error)}`)
    return visionFailureBlock(label, "unsupported-format")
  }
  const outcome = await session.describeOnce(entry, () => describeImage({ access, image, fetch: deps.fetch, timeoutMs: deps.timeoutMs }))
  if (outcome.ok) return visionTranscriptBlock(label, outcome.text)
  deps.log?.(`[@alpha-code/ext] cloud vision: ${label} failed (${outcome.kind}): ${outcome.detail}`)
  return visionFailureBlock(label, outcome.kind)
}

// ── 引擎 part 的形状判定(只认本模块要用的字段)───────────────────────────────────

export type ImageFilePartLike = { readonly id?: string; readonly type: "file"; readonly mime: string; readonly url: string; readonly filename?: string }

export function isImageFilePart(part: unknown): part is ImageFilePartLike {
  const p = part as { type?: unknown; mime?: unknown; url?: unknown } | null
  return !!p && p.type === "file" && typeof p.mime === "string" && p.mime.startsWith("image/") && typeof p.url === "string" && p.url.startsWith("data:")
}

/** `data:<mime>;base64,<payload>` → payload;不是 base64 data URL 就 undefined。 */
export function dataUrlBase64(url: string): string | undefined {
  const marker = ";base64,"
  const at = url.indexOf(marker)
  return url.startsWith("data:") && at > 0 ? url.slice(at + marker.length) : undefined
}

/** 模型把 base64 本体直接塞进 `image`(而不是引用)时也接得住:长度够、字符集对、解出来是四种图之一。 */
export function looksLikeBase64Image(value: string): boolean {
  if (value.length < 256 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false
  return sniffImageMime(Buffer.from(value.slice(0, 64), "base64")) !== undefined
}
