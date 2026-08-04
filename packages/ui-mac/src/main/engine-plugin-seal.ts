// engine-plugin-seal — ADR-040 §决策三 的执行面:**往磁盘 `plugin[]` 加元素一律拒**。
//
// 为什么这是一道咽喉而不是一张黑名单:
//   `alpha.jsonc` 的 `plugin[]` 是引擎把**任意第三方 JS 拉进自己进程、以同等权限执行**的通道。
//   ADR-040 裁定 Alpha 不再提供这个能力,于是「哪些安装路径允许写它」这个问题的答案是**一个都没有**。
//   一个答案为空集的许可表,写成「逐个调用点判断」就是黑名单:枚举对新成员默认放行,而新成员
//   (下一条安装路径、下一个 builder、下一次 rebase 带进来的调用点)必然会出现。
//   所以判据落在**字节写盘那一刻**:凡是「写完之后 `plugin[]` 里出现了写之前没有的元素」,一律拒,
//   不问调用方是谁、有没有登记。新增写入点忘了处理 ⇒ 默认被挡住。
//
// **允许什么**:移除、清空、重排、以及完全不碰 `plugin[]` 的写(mcp / provider / agent / 治理键)。
//   卸载臂、启停投影的 disable 臂、dangling 清扫都落在这一侧 —— 它们是**减法**,是清理方向。
//
// **Alpha 自有 ext 接缝不受影响,因为它根本不写盘**:`alpha-config-injection.ts` 只把
//   `@alpha-code/ext` 的绝对路径合进内存里的 `OPENCODE_CONFIG_CONTENT`(env 通道),
//   `alpha.jsonc` 那一侧它只在文件缺席时 seed 一个 `{$schema}`。这就是为什么本咽喉可以做成
//   「一律拒」而不需要留任何合法加法通道(ADR-040 实读依据四)。
//
// **`#825` 交付时留着的那个已知边界,`#832` 已经关掉**:boot 期把 legacy `~/.opencode/opencode.jsonc`
//   的 `plugin[]` 并进 `alpha.jsonc` 的整文件写。当时它不经过本咽喉,而且每次启动都跑。
//   处置不是给它开豁免口(豁免口会让这道闸看起来完整而实际留门),是两件事一起做:
//   ①`planConfigMerge` 里那条并集删掉 —— 「迁移用户自己的旧配置」不改变「这是一段以引擎同等权限
//   执行的第三方 JS」这个事实;②那次整文件写盘改调 `ext-config` 的原子提交点,于是它**也**过闸。
//   后者才是类判据:这条路上将来新增任何加法,不需要谁记得登记,就已经被挡住。
//
// 接线点(三族物理写原语,主进程里引擎 config 的全部写盘都在其中之一):
//   · `ext-config.ts` 的 `writeConfigTextAtomic`(`writeKey*` / dangling 清扫 / boot reconcile 的
//     整文件写 —— 三者共用的唯一原子提交);
//   · `ext-config-tx.ts` 的 `prepareConfigTx`(计划期具名拒绝)与 `applyConfigImage`(switch 期终闸)。

import * as path from "node:path"
import { parse, type ParseError } from "jsonc-parser"

export type PluginSealVerdict = { ok: true } | { ok: false; reason: string }

/** 该文件的 `plugin` 键读出来是什么 —— `present:false` = 键缺席(与「空数组」不同,要分得开)。 */
type PluginKeyRead = { ok: true; value: unknown; present: boolean } | { ok: false; why: string }

/** 稳定序列化(对象键排序):`plugin[]` 成员可以是 `string` 或 `[spec, options]` 元组,
 *  options 的键序是源文本顺序,不排序会把「同一个条目重排了一下」误判成「新增了一个条目」。 */
function canonical(value: unknown): string {
  if (value === undefined) return "\u0000absent" // 转义写法:字面 NUL 会让 grep/rg 把整个文件判成二进制并静默返回空(#760)
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`
}

function readPluginKey(text: string): PluginKeyRead {
  const source = text.trim() === "" ? "{}" : text
  const errors: ParseError[] = []
  const parsed: unknown = parse(source, errors, { allowTrailingComma: true })
  if (errors.length > 0) return { ok: false, why: `not valid jsonc (${errors.length} syntax error(s))` }
  if (parsed === undefined) return { ok: true, value: undefined, present: false }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, why: "root is not an object" }
  const record = parsed as Record<string, unknown>
  if (!Object.hasOwn(record, "plugin")) return { ok: true, value: undefined, present: false }
  return { ok: true, value: record.plugin, present: true }
}

/** 数组成员的 canonical 多重集;非数组 = 无法证明「没有新增」⇒ 交给调用方拒。 */
function entriesOf(read: Extract<PluginKeyRead, { ok: true }>): { ok: true; entries: string[] } | { ok: false; why: string } {
  if (!read.present || read.value === undefined) return { ok: true, entries: [] }
  if (!Array.isArray(read.value)) return { ok: false, why: "plugin key is not an array" }
  return { ok: true, entries: read.value.map(canonical) }
}

/**
 * 一次 `alpha.jsonc`(或任何引擎 config 文件)的整文本写入是否被 ADR-040 放行。
 *
 * `beforeText` = 写之前的 live 文本(文件缺席传 `"{}"` 或 `""`),`afterText` = 即将落盘的文本。
 * 判据是**元素级**的:`after` 的 `plugin[]` 每个成员都必须能在 `before` 的 `plugin[]` 里找到一份
 * (多重集包含)。找不到的第一个成员即具名拒绝理由。
 *
 * fail-closed 的三种「证不出来」都算拒:待写文本不可解析、既有文本不可解析而待写文本仍有条目、
 * 任一侧 `plugin` 键不是数组而两侧又不逐字相同。
 */
export function sealEnginePluginAdditions(target: string, beforeText: string, afterText: string): PluginSealVerdict {
  const where = path.basename(target)
  const refuse = (why: string): PluginSealVerdict => ({
    ok: false,
    reason: `refused by ADR-040 (extension installs must not write the engine plugin[]): ${why} — ${where}`,
  })

  const after = readPluginKey(afterText)
  if (!after.ok) return refuse(`cannot verify the write, the config being written is ${after.why}`)
  const before = readPluginKey(beforeText)
  // `plugin` 键逐字未变 ⇒ 这次写盘根本没碰它(mcp/provider/agent/治理键的写全部落这里)。
  if (before.ok && canonical(before.value) === canonical(after.value)) return { ok: true }

  const afterEntries = entriesOf(after)
  if (!afterEntries.ok) return refuse(`cannot verify the write, ${afterEntries.why} in the config being written`)
  // 写完之后一个条目都没有 = 只可能是移除/清空,永远合法。
  if (afterEntries.entries.length === 0) return { ok: true }
  if (!before.ok) return refuse(`cannot verify the write, the existing config is ${before.why}`)
  const beforeEntries = entriesOf(before)
  if (!beforeEntries.ok) return refuse(`cannot verify the write, ${beforeEntries.why} in the existing config`)

  const pool = new Map<string, number>()
  for (const entry of beforeEntries.entries) pool.set(entry, (pool.get(entry) ?? 0) + 1)
  for (const entry of afterEntries.entries) {
    const left = pool.get(entry) ?? 0
    if (left === 0)
      return refuse(`this write would add ${entry.length > 200 ? `${entry.slice(0, 200)}…` : entry} to plugin[]`)
    pool.set(entry, left - 1)
  }
  return { ok: true }
}
