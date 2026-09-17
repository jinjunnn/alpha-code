---
title: Hierarchical tool policy contract (REQ-131)
kind: contract
status: active
owners:
  - alpha-code
last_reviewed: 2026-09-17
review_after: 2027-03-17
---

# Hierarchical tool policy contract

本契约是 `jinjunnn/alpha-code#724` CLOSE_DECIDE(2026-08-17)§2–§5 的实现落点,由
`#1128` 交付。它定义三态工具策略的**数据形状、合成语义与消费 API**;目录/执行咽喉
的接线(E1–E6)归 `#1129`,Settings 编辑面归 `#1130`。V2 的会话审批(receipts /
saved-rule)另见 [`session-permission.md`](session-permission.md),两者不共享引擎。

## 形状(SOT = `packages/schema/src/alpha-tool-policy.ts`)

- 三态 `ToolPolicyState = enabled | ask | disabled`,经 `toPermissionAction` 编译到
  现有 V1 Permission 的 `allow | ask | deny`。不存在第四种状态,也没有第二个审批引擎。
- 四类 `ToolClass = builtin | alpha-cloud | third-party-mcp | plugin`。分类唯一可信输入
  是 `identity.source` 与 **verified** `authority.kind`(`classifyTool`);标题、
  annotation、technicalId、URL 相似性一律不是输入。用户可调用的 `host` / `builtin-v2`
  归本地类。默认:本地 `enabled`,其余一律 `ask`;identity 铸不出 canonical ⇒ `disabled`。
- **结构化 selector**(`ToolPolicySelector`):`class` / `service (source, origin)` /
  `tool (canonical)` 三层。匹配是结构相等(`selectorMatches`),**没有字符串通配语义**;
  `name="*"` 的 canonical 是 `%2A`,只匹配那个字面工具;手拼 `mcp:<server>:*` 在 schema
  decode 时 loud fail。同一 selector 只允许一条记录(`selectorKey` 唯一),重复即坏文档。
- 持久化文档 `ToolPolicyDocumentV1 = { version: 1, partition, records[] }`,按
  `(account subject 或 anonymous, workspace/project id)` 分区,一分区一文件
  (文件名 = 分区 canonical JSON 的 sha256,SOT =
  `packages/opencode/src/permission/alpha-tool-policy-store.ts`)。

## 合成语义(SOT = `packages/opencode/src/permission/alpha-tool-policy.ts`)

`resolveToolPolicy` 按 #724 §4 的终局顺序(第一版 `deny > ask > allow` 排序已否决):

1. **cap,不可突破**:managed deny(见下)、服务端 entitlement `missing|deny`、
   现有 sovereignty / kill-switch deny(`hardDeny` 输入,只取交集不替换)。
   任一命中 ⇒ `disabled`。managed 层 `unreadable` 同样 ⇒ `disabled`。
2. **用户层**(当前分区):exact tool > service > class。`disabled` 不可被任何下层
   撬开;`enabled` 在 service/tool 层必须过 **binding guard** —— 记录携带的
   `bindingDigest` 与主体当前 binding 逐字相等才生效,否则回 `ask`
   (reason `binding-changed`);class 层是 broad intent,不绑定 binding。
   文档 quarantine(损坏 / 未知版本 / 分区不符 / selector 重复 / 记录非法)⇒
   所有用户可配置工具 `disabled`,恢复入口是 `reset`(坏文件挪去
   `.quarantined-<ts>` 备份,回到批准默认)。
3. **默认**:按四类;新发现工具吃默认。

Binding digest 来源(#724 §5):Alpha Cloud 复用 verified `authority.evidenceDigest`;
第三方 MCP 用 `mcpBindingDigest`(去秘密后的 definition:remote 取 `url`、local 取
`command+cwd`;headers / environment / oauth / enabled / timeout 不参与);plugin 经
`deriveBindingDigest` 对安装 receipt / manifest / loader generation 派生(由 #1129 供值)。

## managed cap(#1128 必修)

SOT = `packages/opencode/src/permission/alpha-managed-policy.ts`。与上游
`config/managed.ts` 的 `OPENCODE_TEST_MANAGED_CONFIG_DIR || systemManagedConfigDir()`
不同:**系统 managed 目录无条件读取,env 不能替换它**。`OPENCODE_TEST_MANAGED_CONFIG_DIR`
只是 additive 的最低优先来源;系统目录 / MDM plist 存在但读不出 ⇒ 整层 `unreadable`
⇒ resolver `disabled`(不静默丢 org deny)。测试对系统目录的控制**仅经函数参数注入**。
负向闸在 `packages/opencode/test/permission/alpha-tool-policy.test.ts`(M 组)。

## V1 审批层的会话语义(SOT = `packages/opencode/src/permission/index.ts`)

`#1122` B9/B13 的修复,#724 §4.4/§4.5:

- `always` 产生的是 **session grant**(`sessionID + permission + resource pattern`),
  不是规则:换会话必须重新进待批队列;instance 内跨会话不共享。
- grant 只能 **discharge ask**:deny / allow 只由 ruleset 决定,任何旧批条都压不过
  后来收紧的 deny(结构性,不是排序巧合)。
- `once` 只放行当次,不落账。
- `clearGrants({ sessionID? })` 是切账户 / 登出的清账口,由 #1129/#1130 接线。
- 上游 `test/permission/next.test.ts` 的 “reply - always persists approval and
  resolves” 断言的是 B13 的缺陷行为(跨会话直通),与本契约相悖;该文件是上游
  资产、不在任何 alpha 门内,按 #1128 交付时的实测记录为已知分歧。

## 消费 API

`AlphaToolPolicy.Service`(LayerNode `AlphaToolPolicy.node`):
`resolve(subject, caps?)`(每次调用重读 cap 与文档 —— #724 §6 要求 executor 调用时
重读)、`inspect()`、`setRecord` / `removeRecord`(quarantine 期间拒写,先 `reset`)、
`reset()`。账户 subject 今天默认 `anonymous`(引擎侧尚无账户权威),经 layer 注入。

判据:`packages/opencode/test/permission/alpha-session-grants.test.ts`、
`packages/opencode/test/permission/alpha-tool-policy.test.ts`(均登记于
`scripts/gate-files.tsv`),生产双咽喉取证见
`packages/opencode/test/tool/alpha-725-policy-chokepoints.cases.ts`(#1128 后
B9/B13 转绿,B2/B3/B4/B6/B10/B11 属 #1129)。

写侧失败 `ToolPolicyWriteError` 携带 `kind: quarantined | io`(#1130):消费面据此区分
「文档待恢复,先 reset」与「落盘失败」,不解析 message 文本。

## 出口:HTTP 面与桌面 IPC(#1130)

引擎侧的 inventory / 写口经**已收编的 v2 permission 组**走出引擎进程(接缝勘破见
[`../architecture/2026-09-17-tool-policy-transport-seam.md`](../architecture/2026-09-17-tool-policy-transport-seam.md));
每个端点按 v2 location(`x-opencode-directory` / `location[directory]`)解析引擎实例,
因为策略按 `(account, workspace)` 分区 —— 没有实例就没有分区。

| 端点(`packages/protocol/src/groups/permission.ts`) | 成功 | 失败 |
| --- | --- | --- |
| `GET /api/permission/tool-policy/inventory` | 200 `{ data: ToolPolicyInventoryV1 }`(SOT `packages/schema/src/alpha-tool-inventory.ts`) | 503 `ServiceUnavailableError`(引擎没接线,不返回空清单) |
| `PUT /api/permission/tool-policy/record`,payload = `ToolPolicyRecord` | 204 | 400(记录不合 schema:service/tool 层 enabled 未带 bindingDigest、class 层带了)· 409 `ConflictError`(文档待恢复)· 500 `UnknownError`(落盘失败)· 503 |
| `POST /api/permission/tool-policy/record/remove`,payload = `{ selector }` | 204 | 同上 |
| `POST /api/permission/tool-policy/reset` | 200 `{ data: { backup?: string } }` | 503 |

标签:core `@opencode/v2/AlphaToolPolicyApi`(`packages/core/src/permission/alpha-tool-policy-api.ts`),
实现 = `packages/opencode/src/permission/alpha-tool-inventory.ts` 的 `bridge`(`InstanceStore.provide`
按 directory 注入实例),由 `session/prompt.ts` 的顶层 node 合成暴露。handler 用 `serviceOption`
取标签,缺席即 503。判据:`packages/opencode/test/server/alpha-tool-policy-route.test.ts`(R1–R5,
登记于 `scripts/gate-files.tsv`)+ `httpapi-exercise` 四条 scenario。

桌面侧(`packages/ui-mac`):main `tool-policy-client.ts` 按上表直接 fetch(不经生成的 SDK,理由见接缝文档 §4),
并对 inventory 再 decode 一次 `parseToolPolicyInventory`;经 `tool-policy-ipc.ts` 暴露为 preload
`window.api.toolPolicy = { inventory, setRecord, removeRecord, reset }`(形状 SOT
`packages/ui-mac/src/shared/tool-policy-wire.ts`)。renderer 只拿**闭集**结果码:读侧
`engine-unavailable | not-wired | invalid-shape | request-failed`,写侧再加
`quarantined | invalid-record | write-failed`;不携带路径、栈或引擎原文。四种读失败都 fail-closed:
Settings 不显示清单、不放宽任何工具。判据:`packages/ui-mac/src/main/tool-policy-client.test.ts`、
`packages/ui-mac/src/renderer/alpha-ui/settings-tools.test.ts`。
