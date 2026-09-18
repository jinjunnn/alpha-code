---
title: 引擎 tool policy 面走出引擎进程的接缝(REQ-131 / #1130 路线 B)
kind: architecture
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-09-17
review_after: 2027-03-17
---

# 引擎 tool policy 面走出引擎进程的接缝

REQ-131 的 Settings「工具」节要从**引擎(sidecar)进程**读 live inventory、写策略记录。
inventory 与策略文档住在引擎的实例态服务里(`AlphaToolInventory.Service` / `AlphaToolPolicy.Service`,
按 `(account, workspace)` 分区);桌面 main / renderer 不能自己重算一份(#724 §9 CODE#3:
「只消费 policy inventory/API;不建第二 identity / UI auth map」)。本文记录 2026-09-17 勘破出的
那一跳:**不扩 ADR-033 名单、不碰 `httpapi/api.ts`**,把出口挂在已收编的 v2 permission 面上。

## 1. 注册链(装着的那份代码,不是印象)

| 层 | 文件 | 收编状态 | 结论 |
| --- | --- | --- | --- |
| v2 路由组定义 | `packages/protocol/src/groups/permission.ts`(`makePermissionGroup`) | ADR-033 §守卫盲区,已收编 | 四个端点加在这里 |
| v2 handler | `packages/server/src/handlers/permission.ts`(`HttpApiBuilder.group(Api, "server.permission")`) | ADR-033 §1,已收编 | handler 加在这里 |
| 组装 | `packages/protocol/src/api.ts` → `.add(makePermissionGroup(...))`;`packages/server/src/handlers.ts` → `Layer.mergeAll(..., PermissionHandler, ...)` | 上游 | 整组 / 整 handler 引用,加端点不用动 |
| 引擎侧挂载 | `httpapi/api.ts:50` `ServerApi = makeApi({...})`;`httpapi/server.ts` `serverRoutes = HttpApiBuilder.layer(Api).pipe(Layer.provide(handlers))` | 上游 | 同上,不用动 |
| `httpapi/groups/permission.ts` | v1 `/permission` 组,与 v2 `server.permission` 是两套 API | 上游 | 与本路线无关 |

## 2. 真正的坑不在注册,在暴露

**v2 handler 能看见的上下文只有两种来源**:core 的 location services(`core/src/location-services.ts`,
上游)和 `httpapi/server.ts` `app` 组的**顶层**成员。`LayerNode.compile`(`core/src/effect/layer-node.ts`)
对依赖用 `Layer.provide`、只对顶层用 `provideMerge` —— 把新 node 当成某个 node 的**依赖**挂进去,
handler 是看不见的;而 `app` 组本身是上游文件。

出路是让 `app` 组里一个**已收编的顶层 node** 合成暴露它。实读候选:

- `Permission.node` / `MCP.node`(已收编)—— inventory 依赖它们 ⇒ LayerNode 环,不行;
- `ToolRegistry.node`(已收编)—— 要先把 inventory 自己的 node 拆开,且撞下面的 ESM 环,不值;
- **`SessionPrompt.node`**(`session/prompt.ts`,#1011 收编)—— 依赖面已含 ToolRegistry / MCP / Config /
  AlphaToolPolicy,合成暴露不必新增任何 dep。**选它。**

**InstanceStore 在请求时取,不加进宿主的 deps。** 探针版把 `InstanceStore.node` 加进了 SessionPrompt 的 deps
(bridge 在 layer 构建期 `yield* InstanceStore.Service`);实测这会让**每个**编译 `SessionPrompt.node` 的测试
被迫绑定 `InstanceStore.bootstrapNode`(`test/session/alpha-subtask-attachment-policy.test.ts` 当场
`Unbound layer node: @opencode/InstanceBootstrap`;`test/session/prompt.test.ts` 等四个上游测试同形)。
而 v2 handler 的请求上下文 = `app` 组**全部顶层输出**的合并(`LayerNode.compile` 对顶层 `provideMerge`,
`httpapi/server.ts` 把它整份 `Layer.provide` 给 handlers),`InstanceStore.node` 正是顶层成员 ⇒ bridge 在
每次调用里 `Effect.serviceOption(InstanceStore.Service)` 一定拿得到;缺席只可能是装配变了,所以 die 而不是
静默成空清单。

`tool/registry → tool/task → session/prompt → alpha-tool-inventory → tool/registry` 是 ESM 环:
顶层直接取 `AlphaToolInventory.exposed` 在 inventory 先被加载时撞 TDZ,所以宿主用
`Layer.suspend(() => AlphaToolInventory.exposed)`。

**`packages/server` 只依赖 core / protocol**(`packages/server/package.json`),import 不到 opencode
的服务标签。标签放 core:`packages/core/src/permission/alpha-tool-policy-api.ts`(既在 ADR-033 §1 收编
目录 `core/src/permission/**` 内,又是 `alpha-*` 命名)。opencode 侧
`permission/alpha-tool-inventory.ts` 的 `bridge` 按 v2 location 的 `directory` 用 `InstanceStore.provide`
注入 `InstanceRef` 再跑 `list()` / `setRecord` / `removeRecord` / `reset` —— 与上游
`server/src/pty-environment.ts` ↔ `opencode/src/plugin/pty-environment.ts` 同形。

handler 用 `Effect.serviceOption` 取标签、缺席即 **503 `ServiceUnavailableError`**(fail-closed),
**不**把它写进 handler 的 R:R 一变,上游 `packages/server/src/routes.ts` 与
`packages/cli/src/commands/handlers/serve.ts` 的 `toWebHandler` / `serve` 约束当场红(两处都不在名单里)。

## 3. 落地形状

引擎侧(全部在收编名单内或 alpha 自有,零上游改动;守卫 `scripts/north-star-guard.sh` rc=0):

| 面 | 路径 |
| --- | --- |
| core 标签 | `packages/core/src/permission/alpha-tool-policy-api.ts`(`@opencode/v2/AlphaToolPolicyApi`,含 `WriteError{kind: quarantined \| io}`) |
| 端点 | `GET /api/permission/tool-policy/inventory` · `PUT /api/permission/tool-policy/record` · `POST /api/permission/tool-policy/record/remove` · `POST /api/permission/tool-policy/reset`(`packages/protocol/src/groups/permission.ts`) |
| handler | `packages/server/src/handlers/permission.ts`:503 没接线 / 409 文档待恢复 / 400 记录不合 schema(service/tool 层 enabled 无 digest)/ 500 落盘失败 |
| 实现 + 合成暴露 | `packages/opencode/src/permission/alpha-tool-inventory.ts`(`bridge` / `exposed`;InstanceStore 请求时取)· `packages/opencode/src/session/prompt.ts`(宿主,deps 不变) |
| 闸 | `packages/opencode/test/server/alpha-tool-policy-route.test.ts`(R1–R5,登记于 `scripts/gate-files.tsv`)· `httpapi-exercise` 四条 scenario |

桌面侧:`ui-mac/src/main/tool-policy-client.ts`(按 protocol 定义直接 fetch,main 侧再 decode 一次
`parseToolPolicyInventory`)→ `main/tool-policy-ipc.ts` → preload `window.api.toolPolicy` →
`renderer/alpha-ui/settings-tools.tsx`。契约见 [`../contracts/tool-policy.md`](../contracts/tool-policy.md)。

## 4. 主动没走的路

- **路线 A(收编 `httpapi/api.ts` + `server.ts`)**:直接,但那是上游高频文件,每次 sync 都要合;B 成立后
  不需要扩 ADR-033 名单,也就没有 owner 级决策要递。仍是保底。
- **路线 C(main 侧重算 inventory)**:main 拿不到引擎的 live registry;重算 = 第二份 identity,基线明禁。
- **重生 SDK(`packages/sdk/js/src/v2/gen/*` + `openapi.json`)**:本仓自 #433 起未再重生
  (`git log -- packages/sdk/js/src/v2/gen/sdk.gen.ts`),重生要跑 `bun dev generate` ⇒ 撞 models.dev
  网络陷阱且带出一片与本票无关的生成物漂移。四条路由形状固定,main 侧按 protocol 定义直接 fetch。
  要不要在别的票里统一重生,是编排者的事,不在这里顺手做。
