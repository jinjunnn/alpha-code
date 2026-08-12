// #879(REQ-125)— 工具卡共享 redactor(纯函数、零依赖)。
//
// 基线 `docs/design/2026-08-08-req125-tool-card-provenance/design.md` §5.3:
// 任何进入卡片的自由文本 / URL / 路径先过这里,再进有界渲染。判据(AC5):
// **任何一步失败都返回 { ok: false },调用方隐藏整个字段并显示「详情已隐藏」**,
// 不允许回退到 raw string。成功结果里被命中的 span 已替换为 REDACTED_SPAN。
//
// 边界纪律:截断永远发生在脱敏扫描**之前**,且截断点回退到最近的空白/换行
// (有界回看窗口)—— 被截成半截的 token 形状不再匹配任何 pattern,靠丢弃
// 截断尾部保证「显示出来的内容全部经过完整扫描」。

/** 命中 span 的确定替换标记(基线原文;#587 接手视觉形态)。 */
export const REDACTED_SPAN = "[已隐藏]"

export type RedactResult = { ok: true; value: string; truncated: boolean } | { ok: false }

/** 截断后回看窗口:在窗口内找最近空白作为安全切点;找不到则整窗丢弃。 */
const TRUNCATION_LOOKBACK = 512

// ── 敏感 span 形状(自由文本/错误/输出/diff 共用) ───────────────────────────
// 全部为线性扫描的确定边界 pattern;输入先截断(≤ 调用方 maxChars ≤ 200k)。
const TEXT_PATTERNS: RegExp[] = [
  // PEM 私钥块(完整边界;不完整的 BEGIN 由下方尾部检查兜底)。
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  // HTTP credential 形态。
  /\b(?:bearer|basic)\s+[A-Za-z0-9\-._~+/=]{8,}/gi,
  // secret 味的赋值(env / JSON / YAML:`X_TOKEN=…`、`"api_key": …`)。
  // 关键词前后的 key 名量词必须有界:无界 `[\w.-]*` 在长不间断 [\w.-] 输出
  // (hex/base64url 单行)上是 O(n²) 回溯,实测 16k→544ms、64k→8.8s,关键词密集
  // 形状(`token` 重复)16k 超 110s —— 渲染进程主线程直接冻结(#879 审计 R-final)。
  /[\w.-]{0,64}(?:tokens?|secrets?|passwd|password|api[-_]?key|credentials?|private[-_]?key)[\w.-]{0,64}["']?\s*[:=]\s*["']?[^\s"']+/gi,
  // 常见 token 前缀。
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  /\bxox[a-z]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  // JWT(三段 base64url)。
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g,
  // 自由文本里的 URL userinfo(结构化 URL 字段另走 redactUrl)。
  /(?<=https?:\/\/)[^\s/@]{1,128}:[^\s/@]{1,128}@/gi,
]

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/

/** 路径 segment 的 secret sentinel(词界匹配,`tokenizer` 不误伤)。 */
const SENTINEL_SEGMENT =
  /(?:^|[-_.])(?:tokens?|secrets?|passwd|password|credentials?|api[-_]?key|private[-_]?key)(?:[-_.]|$)|^\.env(?:$|\.)/i

function safeTruncate(raw: string, maxChars: number): { text: string; truncated: boolean } {
  if (raw.length <= maxChars) return { text: raw, truncated: false }
  let text = raw.slice(0, maxChars)
  // fail-closed:截断点向前回退到空白边界,保证不显示被切成半截的 token。
  const window = Math.min(text.length, TRUNCATION_LOOKBACK)
  const tail = text.slice(text.length - window)
  const lastBreak = Math.max(tail.lastIndexOf(" "), tail.lastIndexOf("\n"), tail.lastIndexOf("\t"))
  text = lastBreak >= 0 ? text.slice(0, text.length - window + lastBreak) : text.slice(0, text.length - window)
  return { text, truncated: true }
}

/**
 * 自由文本 / 错误 / 输出 / diff 的共享脱敏:先截断(字符 + 可选行帽),再整段扫描。
 * 失败(任何异常)= { ok: false },调用方必须隐藏整字段。
 */
export function redactText(raw: string, maxChars: number, maxLines?: number): RedactResult {
  try {
    let { text, truncated } = safeTruncate(raw, maxChars)
    if (maxLines !== undefined) {
      let lines = 0
      for (let index = 0; index < text.length; index += 1) {
        if (text.charCodeAt(index) === 10) {
          lines += 1
          if (lines >= maxLines) {
            text = text.slice(0, index)
            truncated = true
            break
          }
        }
      }
    }
    for (const pattern of TEXT_PATTERNS) text = text.replace(pattern, REDACTED_SPAN)
    // 残留的不完整 PEM BEGIN(END 被截掉/缺失)⇒ 边界不可确定,从该点起整体隐藏。
    const pem = text.match(PEM_BEGIN)
    if (pem && pem.index !== undefined) text = `${text.slice(0, pem.index)}${REDACTED_SPAN}`
    return { ok: true, value: text, truncated }
  } catch {
    return { ok: false }
  }
}

/**
 * 结构化 URL 清洗:只认 http(s);删除 userinfo / query / fragment,保留
 * scheme + host(:port)+ 脱敏 pathname。解析失败 / 超长 = { ok: false }。
 */
export function redactUrl(raw: string, maxChars: number): RedactResult {
  try {
    if (raw.length === 0 || raw.length > maxChars) return { ok: false }
    const url = new URL(raw)
    if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false }
    const pathname = url.pathname
      .split("/")
      .map((segment) => (segment && SENTINEL_SEGMENT.test(segment) ? REDACTED_SPAN : segment))
      .join("/")
    return { ok: true, value: `${url.protocol}//${url.host}${pathname === "/" ? "" : pathname}`, truncated: false }
  } catch {
    return { ok: false }
  }
}

/**
 * 路径脱敏:分隔符归一 → home 前缀折叠为 `~` → sentinel segment 替换。
 * 控制字符 / 空串 / 超长 = { ok: false }(截断的路径指向错误目标,不降级显示)。
 */
export function redactPath(raw: string, maxChars: number): RedactResult {
  try {
    if (raw.length === 0 || raw.length > maxChars) return { ok: false }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(raw)) return { ok: false }
    let path = raw.replaceAll("\\", "/")
    path = path.replace(/^(?:[A-Za-z]:)?\/(?:Users|home)\/[^/]+/, "~")
    const value = path
      .split("/")
      .map((segment) => (segment && SENTINEL_SEGMENT.test(segment) ? REDACTED_SPAN : segment))
      .join("/")
    return { ok: true, value, truncated: false }
  } catch {
    return { ok: false }
  }
}
