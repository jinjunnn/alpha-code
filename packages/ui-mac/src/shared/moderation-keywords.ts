// REQ-160 AC2 客户端侧(`#1353`)—— 已同步的关键词表,与它在本机的匹配语义。
//
// ── 这份实现存在的唯一理由:与服务端**逐条同义** ────────────────────────────────────────
// 权威实现在 alpha-web `lib/moderation/keywords.ts` 的 `matchKeywords`
// (provenance:仓 `jinjunnn/alpha-web`,该文件最后一次改动 `3493075965fab381cf3c82cd6637a3252b503fdb`,
//  sha256 `7e85f9d0e4272e0c81f3bfcd5eb6b7236a5829e0a0ee6819a276fc448f7186d1`)。
// 服务端在存档入库时用它复判并写留证(`lib/moderation/events.ts:110`);**留证的权威只在那一侧**。
// 本机这一份只做一件事:在发出去之前让无心撞上的人当场知道。它跑在用户自己的机器上、可被绕过,
// **不是安全边界**(方案基线 §③「客户端被篡改绕过拦截」)。
//
// 两侧同义的判据不是「我照着抄了」,而是 `moderation-keywords.test.ts` 的语料夹具
// `moderation-keywords.parity.json`:每条用例逐条对应权威实现里写明的一条语义,期望值是**手写字面量**
// (不从被测对象生成 —— 见《本机验证陷阱》「比较基准与被测对象同源 = 自指等价链」)。
//
// ── 为什么不是正则、不是 SQL LIKE ──────────────────────────────────────────────────────
// 运营在后台表单里敲进去的是**一个词**。含 `%` `_` `.` `+` `[` 的词必须匹配它自己,而不是被当成
// 模式语言展开。纯子串包含是唯一能保证这一点的语义,也是服务端选它的理由。
//
// ── 大小写折叠是必须的,归一化是不许的 ──────────────────────────────────────────────────
// 折叠为了 `HTTP://` / `WeChat` 这类图文违规叶;对中文是 no-op。
// **不做** Unicode NFKC / 全角半角归一:服务端不做,多做一步就是两侧判定不同 —— 本机拦下了、
// 服务端不认为命中(反之亦然),而两边都没有任何东西会红。

/** 服务端 `GET /api/chat-archive/keywords` 返回的一行(wire 是 snake_case,解析后转这个形状)。 */
export type ModerationKeyword = {
  categoryCode: string
  keyword: string
}

export type KeywordHit = {
  categoryCode: string
  keyword: string
}

/**
 * `text` 里包含的每一个启用词,两侧都折叠大小写。
 *
 * 与权威实现逐条同义:
 * 1. 纯子串包含(`String.prototype.includes`),不是模式语言;
 * 2. 两侧 `toLowerCase()`(默认 locale —— 服务端同样是默认 locale 的 JS `toLowerCase`);
 * 3. 存储词两端空白 `trim()`;
 * 4. 只剩空白的词**跳过** —— 否则它命中每一条消息;
 * 5. 命中里回填的 `keyword` 是**原样**存储值(未 trim、未折叠),`categoryCode` 原样;
 * 6. 命中顺序 = `keywords` 的数组顺序;重复的词产生重复的命中(不去重)。
 */
export function matchKeywords(text: string, keywords: readonly ModerationKeyword[]): KeywordHit[] {
  const haystack = text.toLowerCase()
  const hits: KeywordHit[] = []
  for (const entry of keywords) {
    const needle = entry.keyword.trim().toLowerCase()
    if (!needle) continue
    if (!haystack.includes(needle)) continue
    hits.push({ categoryCode: entry.categoryCode, keyword: entry.keyword })
  }
  return hits
}

/** 发送前只需要知道「有没有」。走同一个 `matchKeywords`,不另写一条短路径 —— 两份实现会漂移。 */
export function isBlockedByKeywords(text: string, keywords: readonly ModerationKeyword[]): boolean {
  return matchKeywords(text, keywords).length > 0
}

/** `{ keywords: [{ category_code, keyword }] }` → 内部形状。形状不合 ⇒ `undefined`(不是空表:
 *  空表意味着「问过了,没有启用词」,而解析不了意味着**没问出来**,两者的下游动作相反)。 */
export function parseKeywordPayload(value: unknown): ModerationKeyword[] | undefined {
  if (!value || typeof value !== "object") return undefined
  const rows = (value as { keywords?: unknown }).keywords
  if (!Array.isArray(rows)) return undefined
  const parsed: ModerationKeyword[] = []
  for (const row of rows) {
    if (!row || typeof row !== "object") return undefined
    const categoryCode = (row as { category_code?: unknown }).category_code
    const keyword = (row as { keyword?: unknown }).keyword
    if (typeof categoryCode !== "string" || typeof keyword !== "string") return undefined
    parsed.push({ categoryCode, keyword })
  }
  return parsed
}
