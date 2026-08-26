// alpha 自有文件(basename `alpha-*` 即 north-star 谓词因子②;ADR-043)。
//
// REQ-131 / #1128 —— 分层工具策略的共享合同(#724 CLOSE_DECIDE §2/§3/§5)。
//
// 这里只放**纯数据与纯函数**:三态、四类、结构化 selector、matcher/compiler、
// versioned 持久化文档形状。凡是要碰 fs / crypto / 进程环境的东西都住在
// `packages/opencode/src/permission/alpha-tool-policy*.ts` —— 本文件要能被
// renderer(Settings,#1130)原样 import。
//
// 两条基线纪律,写死在类型里:
// · §3:「Settings 和调用方不得手拼 wildcard」—— selector 是结构化对象,匹配是
//   结构相等,不存在任何字符串通配路径;`name="*"` 送进 canonical 得到的 `%2A`
//   在这里根本不是一个层级。
// · §3:「同一 selector 只能有一条记录,不使用对象插入顺序决定安全结果」——
//   `selectorKey` 是唯一性判据,重复即坏文档(quarantine),不是 findLast。
import { Schema, Types } from "effect"
import {
  canonicalToolIdentity,
  parseToolIdentity,
  ToolIdentitySource,
  type ToolAuthority,
  type ToolIdentity,
} from "./tool-identity"

/** UI 三态(§2)。编译到现有 Permission 的 allow/ask/deny,不另造第四种状态。 */
export const ToolPolicyState = Schema.Literals(["enabled", "ask", "disabled"]).annotate({
  identifier: "ToolPolicyState",
})
export type ToolPolicyState = typeof ToolPolicyState.Type

/** 产品四类(§2 表)。用户可调用的 host / builtin-v2 归「本地工具」,不能当作不存在。 */
export const ToolClass = Schema.Literals(["builtin", "alpha-cloud", "third-party-mcp", "plugin"]).annotate({
  identifier: "ToolClass",
})
export type ToolClass = typeof ToolClass.Type

const isCanonicalToolIdentity = (value: string) => {
  try {
    parseToolIdentity(value)
    return true
  } catch {
    return false
  }
}

/**
 * 结构化 selector(§3):class > service > tool 三层,匹配 live `ToolIdentity`。
 * tool 层的 `canonical` 必须是规范形(`parseToolIdentity` 可逆)—— 非规范形在
 * decode 时就拒绝,不会静默变成一条永不命中的死记录。
 */
export const ToolPolicySelector = Schema.Union([
  Schema.Struct({ level: Schema.Literal("class"), class: ToolClass }),
  Schema.Struct({ level: Schema.Literal("service"), source: ToolIdentitySource, origin: Schema.String }),
  Schema.Struct({
    level: Schema.Literal("tool"),
    canonical: Schema.String.check(
      Schema.makeFilter<string>((value) =>
        isCanonicalToolIdentity(value) ? undefined : "must be a normalized canonical tool identity",
      ),
    ),
  }),
]).annotate({ discriminator: "level", identifier: "ToolPolicySelector" })
export type ToolPolicySelector = Types.DeepMutable<Schema.Schema.Type<typeof ToolPolicySelector>>

export const BindingDigest = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/)).annotate({
  identifier: "ToolPolicyBindingDigest",
})

/**
 * 一条用户策略记录(§3/§5)。
 * · service/tool 层的 **enabled** 必须携带 bindingDigest —— 「放宽」绑定在一个具体的
 *   宿主派生 binding 上,rebind 后自动失效回 ask(binding guard 在 resolver 里执行)。
 * · class 层是 broad intent,覆盖该作用域未来成员,不绑定 binding。
 * · disabled / ask 不要求 digest:收紧不需要证据,也不因 rebind 而失效(fail-closed)。
 */
export const ToolPolicyRecord = Schema.Struct({
  selector: ToolPolicySelector,
  state: ToolPolicyState,
  bindingDigest: Schema.optional(BindingDigest),
}).check(
  Schema.makeFilter<{ selector: { level: string }; state: string; bindingDigest?: string }>((record) => {
    if (record.state !== "enabled") return undefined
    if (record.selector.level === "class")
      return record.bindingDigest === undefined ? undefined : "class-level records must not carry bindingDigest"
    return record.bindingDigest !== undefined
      ? undefined
      : "service/tool enabled records must carry bindingDigest (binding guard, #724 §5)"
  }),
)
export type ToolPolicyRecord = Types.DeepMutable<Schema.Schema.Type<typeof ToolPolicyRecord>>

/** 持久化分区(§5):账户 subject(或 "anonymous")× 工作区/项目身份。 */
export const ToolPolicyPartition = Schema.Struct({
  account: Schema.String.check(Schema.isPattern(/[\s\S]+/)),
  workspace: Schema.String.check(Schema.isPattern(/[\s\S]+/)),
}).annotate({ identifier: "ToolPolicyPartition" })
export type ToolPolicyPartition = Types.DeepMutable<Schema.Schema.Type<typeof ToolPolicyPartition>>

/**
 * versioned 用户策略文档(§5)。未知版本 / 部分非法 / 分区不符 = 整份 quarantine,
 * 由 store 执行;本 schema 只负责「version 1 长什么样」。
 */
export const ToolPolicyDocumentV1 = Schema.Struct({
  version: Schema.Literal(1),
  partition: ToolPolicyPartition,
  records: Schema.Array(ToolPolicyRecord),
}).annotate({ identifier: "ToolPolicyDocumentV1" })
export type ToolPolicyDocumentV1 = Types.DeepMutable<Schema.Schema.Type<typeof ToolPolicyDocumentV1>>

const decodeToolPolicyDocument = Schema.decodeUnknownSync(ToolPolicyDocumentV1)

export function parseToolPolicyDocument(value: unknown): ToolPolicyDocumentV1 {
  return decodeToolPolicyDocument(value) as ToolPolicyDocumentV1
}

/** resolver 的判定主体:live identity + 可信 authority(+ 调用方派生的当前 binding digest)。 */
export interface ToolPolicySubject {
  readonly identity: ToolIdentity
  readonly authority: ToolAuthority
  /**
   * 当前 binding 的宿主派生 digest(§5):第三方 MCP = 去秘密后的 server definition,
   * plugin = 安装 receipt/manifest/loader generation。Alpha Cloud 不用传 ——
   * verified `authority.evidenceDigest` 就是它的 binding。
   */
  readonly bindingDigest?: string
}

/**
 * 分类(§2 表):唯一可信输入是 identity.source 与 verified authority。
 * identity 非法(canonical 铸不出来)⇒ undefined ⇒ 调用方必须按 disabled 处置。
 * 标题 / annotation / technicalId / URL 相似性一概不是输入(§7)。
 */
export function classifyTool(subject: {
  identity: ToolIdentity
  authority: ToolAuthority
}): ToolClass | undefined {
  try {
    canonicalToolIdentity(subject.identity)
  } catch {
    return undefined
  }
  switch (subject.identity.source) {
    case "builtin":
    case "builtin-v2":
    case "host":
      return "builtin"
    case "mcp":
      return subject.authority.kind === "alpha-cloud" ? "alpha-cloud" : "third-party-mcp"
    case "plugin":
      return "plugin"
    default:
      return undefined
  }
}

/** 四类默认(§2 表):本地 enabled,其余一律 ask。 */
export function classDefaultState(cls: ToolClass): ToolPolicyState {
  return cls === "builtin" ? "enabled" : "ask"
}

/**
 * selector 唯一键(§3「同一 selector 只能有一条记录」)。
 * 用 JSON 数组做无歧义分隔 —— origin 里的 `:` / `*` 都是字面字符,不是语法。
 */
export function selectorKey(selector: ToolPolicySelector): string {
  switch (selector.level) {
    case "class":
      return JSON.stringify(["class", selector.class])
    case "service":
      return JSON.stringify(["service", selector.source, selector.origin])
    case "tool":
      return JSON.stringify(["tool", selector.canonical])
  }
}

/** tool > service > class(§3)。数值只用于比大小,不持久化。 */
export function selectorSpecificity(selector: ToolPolicySelector): number {
  switch (selector.level) {
    case "tool":
      return 3
    case "service":
      return 2
    case "class":
      return 1
  }
}

/**
 * 共享 matcher/compiler(§3):selector 对 live identity 的匹配是**结构相等**,
 * 没有任何字符串通配语义。identity 非法 ⇒ 一律不匹配(resolver 早已把它判成 disabled)。
 */
export function selectorMatches(selector: ToolPolicySelector, subject: ToolPolicySubject): boolean {
  const cls = classifyTool(subject)
  if (cls === undefined) return false
  switch (selector.level) {
    case "class":
      return selector.class === cls
    case "service":
      return selector.source === subject.identity.source && selector.origin === subject.identity.origin
    case "tool":
      return selector.canonical === canonicalToolIdentity(subject.identity)
  }
}

/** 三态 → 现有 Permission 动作(§2:不另造第四种状态,也不另造第二个审批引擎)。 */
export function toPermissionAction(state: ToolPolicyState): "allow" | "ask" | "deny" {
  switch (state) {
    case "enabled":
      return "allow"
    case "ask":
      return "ask"
    case "disabled":
      return "deny"
  }
}
