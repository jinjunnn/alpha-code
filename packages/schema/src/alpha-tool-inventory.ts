// alpha 自有文件(basename `alpha-*` 即 north-star 谓词因子②;ADR-043)。
//
// REQ-131 / #1129(reopen)—— **dynamic tool policy inventory** 的 wire 形状(#724 §5 末条):
//
// > inventory/API 从 live registry/materialization 派生并返回 identity、可信 authority、
// > 继承状态、effective state/reason 与 binding change;不得从历史 `ToolPart.display`
// > 或 UI 名单反推新调用授权。
//
// 消费方是 #1130 的 Settings「工具」节(设计稿 `docs/design/2026-08-25-req131-settings-tool-policy/`
// §3 表);本文件与 `alpha-tool-policy.ts` 同一纪律 —— 纯数据、可被 renderer 原样 import。
// 供给方是 `packages/opencode/src/permission/alpha-tool-inventory.ts`(它 decode 一遍本 schema
// 再返回:形状漂移在引擎侧 loud fail,不让 Settings 拿到解释不了的对象)。
//
// 设计稿 §3 表 → 本形状的逐行映射:
//   四个分组 / 每类每服务条数 / 工具清单     ⇒ `services[].class` + `services[].tools[]`(条数 = length)
//   服务行(名称/展开)                      ⇒ `services[].source` + `services[].origin`
//   工具行名称                              ⇒ `tools[].identity.name`(展示转义归 REQ-125)
//   三态控件写入(带当前 digest)            ⇒ `services[].bindingDigest` / `tools[].bindingDigest`
//   「生效:…」+ 徽标(9 型 reason 逐型)     ⇒ `tools[].effective.state/reason`
//   「继承:默认 / 你的设置(层级)」          ⇒ `effective.reason.kind = "default" | "user"(level)`
//   锁定行(cap-*)/ 损坏恢复 / managed 横幅 ⇒ `effective.reason.kind = cap-*` + 顶层 `user`/`managed`
//   「服务已变更」+ 重新启用                 ⇒ `effective.reason.kind = "binding-changed"` + 当前 digest
//   「仅当前账户与当前项目」                 ⇒ `partition`
//   「新发现」徽标                           ⇒ `tools[].newlyDiscovered`(§3:无 broad override 的新动态工具)
//   「计费:按用量 / 未知」                  ⇒ `tools[].billing`(缺失 ⇒ 显示「未知」,§8)
//   「N 项注册身份无法核验」                 ⇒ `invalid.count`(owner 已裁:暴露计数;原因归开发者详情 ⇒ `invalid.entries[].detail`)
import { Schema, Types } from "effect"
import { ToolAuthority, ToolBillingFact, ToolIdentity, ToolIdentitySource } from "./tool-identity"
import { BindingDigest, ToolClass, ToolPolicyPartition, ToolPolicyRecord, ToolPolicyState } from "./alpha-tool-policy"

/** resolver 的 9 型 reason(#1128 `EffectiveToolPolicyReason` 的 wire 镜像;一型不落)。 */
export const EffectiveToolPolicyReasonV1 = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("invalid-identity"), detail: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("cap-managed") }),
  Schema.Struct({ kind: Schema.Literal("cap-managed-unreadable"), detail: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("cap-entitlement"), verdict: Schema.Literals(["deny", "missing"]) }),
  Schema.Struct({ kind: Schema.Literal("cap-hard-deny"), sources: Schema.Array(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("quarantine"), detail: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("user"), level: Schema.Literals(["class", "service", "tool"]) }),
  Schema.Struct({ kind: Schema.Literal("binding-changed"), level: Schema.Literals(["service", "tool"]) }),
  Schema.Struct({ kind: Schema.Literal("default"), class: ToolClass }),
]).annotate({ discriminator: "kind", identifier: "EffectiveToolPolicyReasonV1" })
export type EffectiveToolPolicyReasonV1 = Types.DeepMutable<Schema.Schema.Type<typeof EffectiveToolPolicyReasonV1>>

export const EffectiveToolPolicyV1 = Schema.Struct({
  state: ToolPolicyState,
  action: Schema.Literals(["allow", "ask", "deny"]),
  reason: EffectiveToolPolicyReasonV1,
}).annotate({ identifier: "EffectiveToolPolicyV1" })
export type EffectiveToolPolicyV1 = Types.DeepMutable<Schema.Schema.Type<typeof EffectiveToolPolicyV1>>

export const ToolPolicyInventoryToolV1 = Schema.Struct({
  /** exact canonical(tool 层 selector 的写入键;§3「exact auth lookup key 仍只有 canonical」)。 */
  canonical: Schema.String,
  identity: ToolIdentity,
  technicalId: Schema.String,
  authority: ToolAuthority,
  billing: Schema.optional(ToolBillingFact),
  /** tool 层写 enabled 记录必须携带的**当前** binding digest(§5;派生不出来则缺席)。 */
  bindingDigest: Schema.optional(BindingDigest),
  effective: EffectiveToolPolicyV1,
  /** 该工具自己的 tool 层用户记录(radiogroup 的「用户 override」;无记录 = 无选中)。 */
  record: Schema.optional(ToolPolicyRecord),
  /** §3:没有适用 broad override 的新**动态**工具(mcp/plugin 类)⇒ Settings 标「新发现」。 */
  newlyDiscovered: Schema.Boolean,
}).annotate({ identifier: "ToolPolicyInventoryToolV1" })
export type ToolPolicyInventoryToolV1 = Types.DeepMutable<Schema.Schema.Type<typeof ToolPolicyInventoryToolV1>>

export const ToolPolicyInventoryServiceV1 = Schema.Struct({
  source: ToolIdentitySource,
  origin: Schema.String,
  class: ToolClass,
  /** 服务级 authority(alpha-cloud verified ⇒「已核验」徽标)。 */
  authority: ToolAuthority,
  /** service 层写 enabled 记录必须携带的**当前** binding digest(§5)。 */
  bindingDigest: Schema.optional(BindingDigest),
  /** 该服务的 service 层用户记录。 */
  record: Schema.optional(ToolPolicyRecord),
  tools: Schema.Array(ToolPolicyInventoryToolV1),
}).annotate({ identifier: "ToolPolicyInventoryServiceV1" })
export type ToolPolicyInventoryServiceV1 = Types.DeepMutable<Schema.Schema.Type<typeof ToolPolicyInventoryServiceV1>>

export const ToolPolicyInventoryV1 = Schema.Struct({
  version: Schema.Literal(1),
  /** 「仅当前账户与当前项目」脚注的数据源。 */
  partition: ToolPolicyPartition,
  /** 用户策略文档层状态:quarantined ⇒ Settings 整节横幅 + 只读 + 重置入口。 */
  user: Schema.Union([
    Schema.Struct({ status: Schema.Literals(["ok", "absent"]) }),
    Schema.Struct({ status: Schema.Literal("quarantined"), reason: Schema.String }),
  ]).annotate({ discriminator: "status" }),
  /** managed cap 层状态:unreadable ⇒ 整节横幅(全部停用,同损坏态形制)。 */
  managed: Schema.Union([
    Schema.Struct({ status: Schema.Literal("ok") }),
    Schema.Struct({ status: Schema.Literal("unreadable"), reason: Schema.String }),
  ]).annotate({ discriminator: "status" }),
  /** class 层用户记录(四组总开关的「用户 override」)。 */
  classRecords: Schema.Array(ToolPolicyRecord),
  services: Schema.Array(ToolPolicyInventoryServiceV1),
  /** 「N 项注册身份无法核验,已自动停用」:计数入正文,原因归开发者详情(owner 裁决 Q1)。 */
  invalid: Schema.Struct({
    count: Schema.Number,
    entries: Schema.Array(Schema.Struct({ technicalId: Schema.String, detail: Schema.String })),
  }),
}).annotate({ identifier: "ToolPolicyInventoryV1" })
export type ToolPolicyInventoryV1 = Types.DeepMutable<Schema.Schema.Type<typeof ToolPolicyInventoryV1>>

const decodeToolPolicyInventory = Schema.decodeUnknownSync(ToolPolicyInventoryV1)

export function parseToolPolicyInventory(value: unknown): ToolPolicyInventoryV1 {
  return decodeToolPolicyInventory(value) as ToolPolicyInventoryV1
}
