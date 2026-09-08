// #1281:目录里的 BYOK 模型 id,上游还在不在。
//
// ── 为什么需要它 ────────────────────────────────────────────────────────────────────────
// 2026-09-07 靠**人肉网查**才发现:目录里的 `kimi-k2` 上游 2026-05-25 就停用了、
// `moonshot-v1-128k` 2026-08-31 退役,调用返回 404。它们躺在已发布的 0.1.11 里 ——
// 一个带 Moonshot key 的用户选中它,拿到的不是"输出短一点",是这个模型对他完全用不了。
// 没有任何东西会发现这件事,因为我们从不问上游"这个 id 你还认吗"。
//
// ── 判据可行(已勘破,不是设想)──────────────────────────────────────────────────────
// 2026-09-08 实打:智谱 / DeepSeek 的 `GET <baseURL>/models` 带 key 均回 200 且列出真实 id
// (OpenAI 标准形状 `{object, data:[{id,...}]}`)。目录里每个 provider 都是 `compat: "openai"`
// (alpha-models.test.ts 钉着这条不变量),所以这条路对全部 BYOK provider 成立。
//
// ── 三档结局(照本仓 `#890` 已有形状,不新发明)──────────────────────────────────────
//   0 已验证    有 key 的 provider,目录里每个 id 都在上游 /models 里
//   1 真失守    某个目录 id 上游没有了 —— 这次的 kimi-k2 正是此类
//   2 未验证    一个 provider 都没 key。**「没能比对真源」是第三种结局,不是绿。**
// 部分验证(常态:我们不可能持有全部五家的 key)按 0 退出,但**未验证的 provider 与其
// 每一个 id 都逐条打印** —— 不点名就等于本机恒绿的安慰剂闸(`#92` 的 docs-link-check 栽过)。
//
// ── 两条"宁可判未验证也不判红"的规则(误报比漏报贵)──────────────────────────────
//   · 非 2xx(401 坏 key / 429 限流 / 5xx)⇒ 未验证。401 说明的是我们的 key 不对,不是模型没了。
//   · 响应不是 `{data:[{id}]}` ⇒ 未验证。上游改一次响应形状就把整个目录诬告成"全没了",
//     那是**判据自己坏了却给出看起来正常的答案** —— 本仓最贵的一类。
//
// ── 内建正样本自检 ──────────────────────────────────────────────────────────────────
// 每个能真查的 provider,额外查一个**结构上不可能存在**的合成 id。它若被判"在册",
// 说明成员判断坏了 ⇒ 整个脚本按失守退出。绿之前先证明它能红。
import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const CATALOG = join(HERE, "..", "src", "main", "alpha-models.json")
/** 两个 userData 根(prod / dev 渠道各一份);main 每次 fork 前把 keychain 里的 key 落成这些文件。 */
const SECRET_DIRS = ["ai.opencode.desktop", "ai.opencode.desktop.dev"].map((r) =>
  join(homedir(), "Library", "Application Support", r, "alpha-secrets"),
)
/** 结构上不可能被上游收录的 id —— 正样本自检用。 */
const IMPOSSIBLE_ID = "__alpha-liveness-probe-must-not-exist__"

type Provider = { id: string; name: string; baseURL: string; keyEnv: string; models: string[] }

function resolveKey(keyEnv: string): string | undefined {
  const fromEnv = process.env[keyEnv]
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  for (const dir of SECRET_DIRS) {
    const f = join(dir, keyEnv)
    if (!existsSync(f)) continue
    const v = readFileSync(f, "utf8").trim()
    if (v) return v
  }
  return undefined
}

/** 上游 /models 的一次读取。`ids === undefined` 表示**这次没读到可信清单**(⇒ 未验证,不是没了)。 */
async function liveIds(baseURL: string, key: string): Promise<{ ids?: string[]; why?: string }> {
  let res: Response
  try {
    res = await fetch(`${baseURL}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(45_000) })
  } catch (e) {
    return { why: `网络失败:${e instanceof Error ? e.message : String(e)}` }
  }
  if (!res.ok) return { why: `HTTP ${res.status}(坏 key / 限流 / 上游故障都长这样,不能据此判模型没了)` }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { why: "响应不是 JSON" }
  }
  const data = (body as { data?: unknown })?.data
  if (!Array.isArray(data)) return { why: "响应里没有 data 数组(上游形状变了 ⇒ 判未验证,不诬告目录)" }
  const ids = data.map((m) => (m as { id?: unknown })?.id).filter((x): x is string => typeof x === "string")
  if (ids.length === 0) return { why: "data 数组里一个字符串 id 都没有(形状不认识)" }
  return { ids }
}

const catalog = JSON.parse(readFileSync(CATALOG, "utf8")) as { byokProviders: Provider[] }
let real = 0
let checked = 0
const unverified: string[] = []

for (const p of catalog.byokProviders) {
  const key = resolveKey(p.keyEnv)
  if (!key) {
    unverified.push(`  · ${p.id}(${p.name})—— 本机无 ${p.keyEnv};未验证的 id:${p.models.join(", ")}`)
    continue
  }
  const { ids, why } = await liveIds(p.baseURL, key)
  if (!ids) {
    unverified.push(`  · ${p.id}(${p.name})—— ${why};未验证的 id:${p.models.join(", ")}`)
    continue
  }
  checked++
  const live = new Set(ids)
  // 正样本自检:合成 id 必须判"不在册"。判成在册 ⇒ 成员判断坏了,整脚本按失守退出。
  if (live.has(IMPOSSIBLE_ID)) {
    console.log(`    ✗ ${p.id}: 自检失败 —— 合成 id 被判为在册,成员判断不可信`)
    real++
    continue
  }
  const gone = p.models.filter((m) => !live.has(m))
  if (gone.length) {
    real++
    console.log(`    ✗ ${p.id}(${p.name}):目录里这些 id 上游 /models 已无 —— ${gone.join(", ")}`)
    console.log(`      上游当前在册 ${ids.length} 个:${ids.slice(0, 12).join(", ")}${ids.length > 12 ? " …" : ""}`)
  } else {
    console.log(`    ✓ ${p.id}(${p.name}):${p.models.length} 个 id 全部在上游 ${ids.length} 个在册 id 中`)
  }
}

if (unverified.length) {
  console.log(`    ── 本次未能比对真源的 provider(${unverified.length} 个)——`)
  for (const line of unverified) console.log(line)
}

if (real > 0) process.exit(1)
// **只有全部 provider 都验成了才退 0。** 部分验证退 2(未验证档)——
// 理由不是洁癖:目录 8 个 id 里本机只能验 2 个,若按 0 退出,alpha-check 末行会打
// 「✅ all local gates green」,而那句话会把「没检查」读成「检查过了」,正是 `#890` 立三档
// 结局要消灭的形态,也正是 kimi-k2 在目录里躺了三个多月没人发现的那个形态。
// 未验证不拦 push(fail 仍为 0),只是让总结行说实话。
if (unverified.length > 0) {
  console.log(
    checked === 0
      ? "    (一个 provider 都没 key ⇒ 本次完全未验证;这不是绿)"
      : `    (${checked} 个 provider 验过了,${unverified.length} 个没验成 ⇒ 本次不构成整份目录的证据;这不是绿)`,
  )
  process.exit(2)
}
process.exit(0)
