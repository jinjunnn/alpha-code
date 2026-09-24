// `#1391`(`#1383` 基线 §四 子票 1)—— 自定义节点记录的**真源**:读端。只有 main 写(custom-provider-truth-write.ts),任何进程可读。
//
// ── 为什么要有这份文件 ──────────────────────────────────────────────────────────
// 用户在模型选择器里「添加自定义节点」配好的服务地址,`#1392` 之前落在 `<alphaGlobalRoot>/alpha.jsonc`(ext-config.ts 当年的
// persistProvider,已退场)—— 那是可写根 W2,**被围栏的引擎树自己写得了**;出网围栏因此不敢从配置文件派生放行集合(network-egress-derived.ts 文件头),
// 这个功能实际是坏的。本文件给它一个引擎写不到的家:`<appData>/alpha-code-state/custom-providers/<env>.json`,与三个 env 根、
// `cas/`、`fence-workspaces/` 同级 —— 父目录是 alpha-environment.ts 冻结快照的 `casBaseRoot`;W2 只放行 `env/<env>`,W3 是
// `<userData>`(另一棵树),其余固定行都不覆盖它(custom-provider-truth.test.ts 对着生产渲染的 profile 逐行枚举 W-id 断言;
// custom-provider-truth-fence.test.ts 交给真 sandbox-exec 裁;W1 是运行时成员,由 `#1390` 的规则 5b 兜住)。
//
// ── 形状 ─────────────────────────────────────────────────────────────────────
// `{ "v": 1, "providers": [{ "id", "name", "compat": "openai" | "anthropic", "baseURL", "models": ["…"], "imageInput"?: ["…"] }] }`。
// `imageInput`(REQ-228 `#1420`,可选):用户**显式声明**能看图的模型 id,必须是 `models` 的非空无重复子集;缺席 = 一个都看不了。
// 自定义节点指向任意地址,同名 ≠ 同一个模型,所以这里不拿 models.dev 猜 —— 只有用户说了才算(alpha-models.ts 注入为 modalities.input)。
// **密钥不进这里**:仍在 `#1343` 的钥匙串库(alpha-byok-keys.ts,按 provider id 存)。
// 读:**严格** —— 缺失 = 「没有记录」(ok,空清单;用户没加过节点是正常状态,不出声);解析失败 / 版本不认识 / 字段不合法 /
// 同 id 重复 / 多余的键 ⇒ 「没问出来」(ok:false),**不是空记录**,并经注入的 log 出一行原因(`#1387`:静默的失败路径事后
// 无法与「一切正常」区分)。不猜、不修、不改写。字段判据只问「是不是这个形状」;地址准入(https / loopback)是添加时与出网
// 同源的那一份(基线 I4,`#1393`),这里不抄第二份。
//
// ── 读与写为什么拆成两个文件(基线 §四 子票 1 的实现约束,审计 m3)────────────────────
// alpha-models.ts / ext-config.ts / alpha-environment.ts 都在 sidecar 的 import 闭包里(process-fence-write-sites.ts
// sidecarSourceFiles);将来注入面从这里读(`#1392`),本文件就跟着进闭包。写入点若也在这里,写盘登记簿只能给它填 `main-only`
// 这个**文字标签**,测试查不出它是否真的只有 main 执行。所以本文件**零写盘**(连 node:fs 都不 import,读也经注入的 fs);
// 写在 custom-provider-truth-write.ts,它不进闭包由 custom-provider-truth-write.test.ts 对着生产的闭包工具实测。
//
// `#1391` 只落存储层;`#1392` 接上消费者:注入面 / enabled_providers / fork 前的密钥物化经 custom-provider-records.ts(生产读取绑定,
// 含 sidecar 侧的位置解析)从这里取,添加 / 删除在 provider-lifecycle.ts,添加时的地址准入与出网同源(`#1393` 并入),旧 alpha.jsonc
// 记录只记一行日志忽略(server.ts)。electron-free。

import { resolve } from "node:path"
import type { ProviderInput } from "../shared/alpha-model-types"
import type { AppEnvironment } from "./alpha-environment"

export const CUSTOM_PROVIDERS_DIRNAME = "custom-providers"
export const CUSTOM_PROVIDER_TRUTH_VERSION = 1

/** 与 renderer 递上来的 ProviderInput 同一个联合;这里不另定义第二份。 */
export type CustomProviderCompat = ProviderInput["compat"]

export type CustomProviderRecord = {
  id: string
  name: string
  compat: CustomProviderCompat
  baseURL: string
  models: string[]
  /** REQ-228 `#1420`:用户声明能看图的模型(⊂ models,非空);缺席 ⇒ 全部看不了图。 */
  imageInput?: string[]
}

/** `<casBaseRoot>/custom-providers/<env>.json` —— 与 `env/`、`cas/`、`fence-workspaces/` 同级(见文件头)。 */
export function customProviderTruthPath(casBaseRoot: string, environment: AppEnvironment): string {
  return resolve(casBaseRoot, CUSTOM_PROVIDERS_DIRNAME, `${environment}.json`)
}

export type CustomProviderTruthReadDeps = {
  readFileSync: (path: string, encoding: "utf8") => string
  /** 拒绝时出一行原因(必填:没接日志的消费者会把「没问出来」读成「没有」)。缺失是正常状态,不出声。 */
  log: (line: string) => void
}

export type CustomProviderTruthRead =
  | { ok: true; absent: boolean; providers: CustomProviderRecord[] }
  | { ok: false; reason: string }

/** 联合每多一个成员这里就少一个键 ⇒ 编译期红,读端的判据跟着 ProviderInput 走。 */
const COMPATS: Record<CustomProviderCompat, true> = { openai: true, anthropic: true }
const RECORD_KEYS: readonly string[] = ["id", "name", "compat", "baseURL", "models", "imageInput"]
const TOP_KEYS: readonly string[] = ["v", "providers"]

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? (error as { code: unknown }).code : undefined
}

function parsesAsUrl(value: string): boolean {
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

/**
 * 单条记录的结构判据:合法返回 undefined,否则返回可读原因(点名第几条、哪个字段)。
 * 多余的键一律拒 —— 尤其 `apiKey`:密钥出现在这里就是有人把钥匙串库的职责写错了地方。
 */
export function invalidCustomProviderRecord(entry: unknown, label: string): string | undefined {
  if (!isRecord(entry)) return `${label} is not an object`
  const unexpected = Object.keys(entry).filter((k) => !RECORD_KEYS.includes(k))
  if (unexpected.length) return `${label} has unexpected key(s): ${unexpected.join(", ")} (secrets never live here)`
  if (typeof entry.id !== "string" || entry.id.length === 0) return `${label}.id is not a non-empty string`
  if (typeof entry.name !== "string" || entry.name.length === 0) return `${label}.name is not a non-empty string`
  if (typeof entry.compat !== "string" || !Object.hasOwn(COMPATS, entry.compat))
    return `${label}.compat is not one of openai | anthropic: ${JSON.stringify(entry.compat)}`
  if (typeof entry.baseURL !== "string" || !parsesAsUrl(entry.baseURL)) return `${label}.baseURL is not a URL: ${JSON.stringify(entry.baseURL)}`
  if (!Array.isArray(entry.models) || entry.models.length === 0) return `${label}.models is not a non-empty array`
  for (const [i, m] of entry.models.entries()) if (typeof m !== "string" || m.length === 0) return `${label}.models[${i}] is not a non-empty string`
  if (entry.imageInput !== undefined) {
    // 空数组与缺席同义却是两种字节 —— 只认缺席这一种(写端 canonical 也只写非空)。
    if (!Array.isArray(entry.imageInput) || entry.imageInput.length === 0) return `${label}.imageInput is not a non-empty array`
    const seen = new Set<string>()
    for (const [i, m] of entry.imageInput.entries()) {
      if (typeof m !== "string" || !entry.models.includes(m)) return `${label}.imageInput[${i}] is not one of models: ${JSON.stringify(m)}`
      if (seen.has(m)) return `${label}.imageInput[${i}] duplicates an earlier entry: ${JSON.stringify(m)}`
      seen.add(m)
    }
  }
  return undefined
}

/** 整份清单的判据(写端落盘前过的也是这一份):每条记录合法且 id 不重复。 */
export function invalidCustomProviderList(entries: unknown, label = "providers"): string | undefined {
  if (!Array.isArray(entries)) return `\`${label}\` is not an array`
  const seen = new Set<string>()
  for (const [i, entry] of entries.entries()) {
    const bad = invalidCustomProviderRecord(entry, `${label}[${i}]`)
    if (bad) return bad
    const id = (entry as CustomProviderRecord).id
    if (seen.has(id)) return `${label}[${i}].id duplicates an earlier record: ${JSON.stringify(id)}`
    seen.add(id)
  }
  return undefined
}

/** 固定键序 + models 拷贝:读回的对象不带文件里的键序,写端用同一个函数得到确定的字节。 */
export function canonicalCustomProviderRecord(r: CustomProviderRecord): CustomProviderRecord {
  return {
    id: r.id,
    name: r.name,
    compat: r.compat,
    baseURL: r.baseURL,
    models: [...r.models],
    ...(r.imageInput?.length ? { imageInput: [...r.imageInput] } : {}),
  }
}

/** 严格读(见文件头)。缺失 ⇒ ok + absent + 空清单;其余任何不对 ⇒ ok:false + 一行日志。 */
export function readCustomProviderTruth(path: string, deps: CustomProviderTruthReadDeps): CustomProviderTruthRead {
  const reject = (reason: string): CustomProviderTruthRead => {
    deps.log(
      `custom providers: truth file ${path} rejected — ${reason}; nothing is derived from it (this is "unanswerable", not an empty list) until the app rewrites it`,
    )
    return { ok: false, reason: `${path}: ${reason}` }
  }
  let text: string
  try {
    text = deps.readFileSync(path, "utf8")
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { ok: true, absent: true, providers: [] }
    return reject(`read failed (${errorMessage(error)})`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return reject(`not JSON (${errorMessage(error)})`)
  }
  if (!isRecord(parsed)) return reject("not a JSON object")
  if (parsed.v !== CUSTOM_PROVIDER_TRUTH_VERSION) return reject(`unsupported version ${JSON.stringify(parsed.v)} (expected ${CUSTOM_PROVIDER_TRUTH_VERSION})`)
  const unexpected = Object.keys(parsed).filter((k) => !TOP_KEYS.includes(k))
  if (unexpected.length) return reject(`unexpected top-level key(s): ${unexpected.join(", ")}`)
  const bad = invalidCustomProviderList(parsed.providers)
  if (bad) return reject(bad)
  return { ok: true, absent: false, providers: (parsed.providers as CustomProviderRecord[]).map(canonicalCustomProviderRecord) }
}
