# alpha-code#224 — L 级方案基线

> 结论：**方案可收敛，但当前状态为 Not Ready，暂不能无臆造地进入实现。**
>
> 本票最小正确实现是：桌面通过一个共享消费者层，钉住 alpha-platform 的不可变契约发布物；HTTP、MCP、artifact、release 共用严格解码；CI 双向跑 fixtures；packaged app 对缺失、未知、未来版本产生持久可见的 loud failure。
>
> 当前有四项上游输入缺失：不可变 commit/可消费包与 fixture 路径、ReleaseV1、按 route purpose 获取 token 的协议、AccountSummary 契约边界。不得由桌面自行补定义。

## ① 只读勘破：真实行为与现有边界

### 1.1 分支、仓库归属与本票现状

- 当前工作树分支：`feat/alpha-code-224`，跟踪 `origin/alpha`。
- HEAD 与 `origin/alpha` 均为 `e6507b0127d9312af8b4419b5ba72d0e5f48f7f9`。
- `origin/alpha...HEAD` 无差异，工作树无变更：**#224 尚未新增任何实现**。
- `ALPHA.md` 明确本仓是 anomalyco/opencode fork：
  - `[上游既有]` `packages/desktop` 是上游 Electron shell。
  - `[Alpha fork 既有]` `packages/ui-mac` 是 Alpha 实际桌面产品壳。
  - `[Alpha fork 既有]` `packages/ext` 是 Alpha 扩展与平台治理缝。
- `architecture/overview.md` 将本地信任边界归桌面，云、模型、计量归 alpha-platform。
- `upstream-integration.md` 要求 Alpha 自有 seam 优先，避免修改上游同步面。

因此，本票实现应落在 `packages/ui-mac`、`packages/ext` 和一个 Alpha 自有消费者包内，不改上游 `packages/desktop`。

### 1.2 身份、账户、模型、云任务与 MCP 现状

| 领域 | 现有真实行为 | 版本/兼容现状 |
|---|---|---|
| Identity/token | `alpha-auth.ts` 本地定义 `TokenResponse`；网络响应直接 cast；同一个 access token 同时写入 `ALPHA_API_KEY`、`ALPHA_CLOUD_TOKEN` | 无 `schema_version` 解码；无 `iss/aud/purpose/scope` route 校验；refresh 失败可能继续保留旧 token |
| Endpoint discovery | `alpha-endpoints.ts` 顺序为环境变量、pin、discovery、默认值 | discovery 文件无 schema 版本；非法或部分数据会回落，失败可静默 |
| Account | `alpha-account.ts` 使用泛型 `authedGet<T>` 和 `.json() as T` | `preload/types.ts` 本地账户类型与已批 Ledger wire 不一致；无大小和版本校验 |
| Model catalog | `alpha-platform-models.ts` 接受缺失 `byok_providers` 的旧形状；失败保留缓存 | `alpha-models.ts` 可退回缓存或 packaged snapshot；契约不兼容也可能被掩盖 |
| Cloud HTTP | `alpha-cloud-jobs.ts` 泛型请求与 cast 响应 | 本地 `CloudJobEnvelope` 没有批准契约中的统一版本和 artifact 结构 |
| Cloud admission | `cloud-envelope-guard.ts` 先检查敏感路径和 JSON 大小 | 当前上限为 1 MiB，不是批准的 `CONTROL_ENVELOPE_MAX_BYTES = 256 KiB` |
| Cloud MCP | `sidecar.ts` 将远端 MCP 注册为 `cloud`；通用 MCP 代码将工具命名为 `cloud_<tool>` | 可绕过 Electron HTTP 适配层；目前没有 Alpha 契约前置/后置校验 |
| Release | `updater.ts` 读取 electron-builder `app-update.yml`，校验 GitHub owner/repo/channel | 这是 GitHub 更新源保护，不是已版本化的 Alpha release wire |

现有未知 cloud status 没有发现被显式映射成 `running` 的代码，这是应保留的好性质；但响应整体仍未经契约验证，尚不能视为 AC 已满足。

### 1.3 Artifact：alpha-work#1/#2 已有实现

以下均为 `[Alpha fork 既有]`，对应已关闭的 [#184](https://github.com/jinjunnn/alpha-code/issues/184)、[#185](https://github.com/jinjunnn/alpha-code/issues/185) 及后续配额工作 [#279](https://github.com/jinjunnn/alpha-code/issues/279)：

- `cloud-artifact-descriptor.ts`：
  - 当前手写了一份 ArtifactDescriptor mirror 和宽松 validator。
  - 文件注释要求与平台“逐点同步”，正是 #224 应消除的漂移源。
  - 还保留 legacy compatibility 开关。
- `alpha-artifact-download.test.ts` 已覆盖：
  - 流式下载；
  - 未知 `schemaVersion` 在请求前拒绝；
  - foreign `contentRef` 不带 token；
  - 大小、hash、配额、流中断等失败。
- `artifact-service.ts` 已负责 main-owned artifact 操作。
- `artifact-manifest.ts` 已负责本地 manifest。
- `alpha-workdir.ts` 已复用下载与 manifest/service 链。
- `cloud-ipc.ts` 已在完成时校验并登记 artifact，但仍接受 legacy metadata。
- `platform-integration.md` 已记录 streaming、descriptor-only IPC、100 MiB/256 个 artifact 等设计。

**#224 不得重新实现下载、hash、配额、manifest、ArtifactService 或 renderer artifact 模型。**只应将它们的入口 descriptor 校验切到统一的上游消费者，并删除不再允许的 legacy 契约回退。

### 1.4 构建、打包、CI 与测试

- `packages/ui-mac/package.json`：
  - `bun test src`
  - typecheck
  - electron-vite build
  - macOS/Windows package 与 ship。
- `prebuild.ts` 构建扩展和 opencode node server，并准备资源。
- `electron.vite.config.ts` 打包 main、sidecar、worker、preload、renderer。
- `electron-builder.config.ts` 定义 packaged 文件、extraResources、平台 target 和发布 channel。
- `alpha-ci.yml` 当前执行 `ext`、`ui-mac` typecheck/test，但没有契约 fixture job。
- `alpha-windows-build.yml` 可打包并检查 native 依赖，但没有 packaged contract smoke。
- `alpha-check.sh` 只覆盖 upstream guard、typecheck 和现有测试。
- `distribution.md` 是当前 RC 构建、签名和人工 packaged 验证入口。
- 单测框架为 Bun test；`playwright-core` 已存在，但没有 Electron packaged contract harness。
- 测试必须从具体 package 目录运行；typecheck 必须用 `bun typecheck`，不得在仓库根直接跑测试或调用 `tsc`。

## ② 选定方案、前置缺口与被否决替代

### 2.1 进入实现前必须补齐的上游输入

| 缺口 | 为什么阻塞 |
|---|---|
| alpha-platform#32 的 40 位不可变 commit、可消费 package/export 名以及 producer/consumer fixture 路径 | 本票不能用 `main`、`latest` 或自行复制 schema；没有这些值就无法完成可复现 pin |
| `ReleaseV1` 的 schema、fixture 和消费端点 | 用户给出的唯一 CONTRACT SUMMARY 没有 release contract；桌面不能把 electron-builder `app-update.yml` 臆造为 Alpha ReleaseV1 |
| purpose-bound token 获取/交换协议 | 当前一个 token 被用于 model、dispatch、read、artifact、account；批准的 `TokenClaimsV1.purpose` 却必须等于当前 route action，一个固定 JWT 不可能同时满足多个 action |
| AccountSummary 边界 | 已批摘要只有 LedgerEntry/Page；当前桌面还消费 account summary。需明确 summary 是本票范围内的哪个上游 schema，或明确只有 ledger 属于本票 |

上述输入应由 alpha-platform#32/alpha-work#9 补齐。**在补齐前 #224 保持开放，不以本地 shim、临时 schema 或“先兼容再说”绕过。**

### 2.2 契约 pin：只做消费者包装，不复制契约

新增 Alpha 自有消费者包，建议路径：

```text
packages/alpha-contracts-consumer/
├── package.json
├── alpha-platform-contract.lock.json
├── src/
│   ├── index.ts
│   ├── decode.ts
│   └── error.ts
├── fixtures/
│   └── consumer/v1/
└── src/*.test.ts
```

设计约束：

1. `package.json` 依赖 alpha-platform#32 发布的上游 contracts package，并在依赖值和 `bun.lock` 中钉死完整 commit SHA。
2. `alpha-platform-contract.lock.json` 只记录：
   - 仓库；
   - 40 位 commit；
   - 上游 package/export；
   - schema/fixture 文件 SHA-256。
   
   它不是契约定义。
3. `alpha-wire-contracts.schema.json`、`artifact-descriptor.schema.json` 和 platform producer fixtures 均从上游依赖读取；**本仓不保存手写副本或可独立修改的镜像**。
4. 本包仅提供：
   - JSON Schema 编译与复用；
   - `schema_version === 1` / `schemaVersion === 1` 的统一 fail-closed decoder；
   - 256 KiB 控制 envelope、512 KiB 非流式 payload 的前置限额；
   - 安全的 `ContractIncompatibleError`；
   - 桌面自己的 consumer request fixtures。
5. preload/renderer 类型只是经过验证后的 UI projection，不是 wire 真相源。

若 alpha-platform#32 只发布裸 JSON、没有可被 Bun 锁定的 package，则应先由上游提供最小 package manifest；本仓不以复制裸文件替代该缺口。

### 2.3 运行时接入边界

| 消费面 | 具体文件 | 最小改动 |
|---|---|---|
| Identity | `packages/ui-mac/src/main/alpha-auth.ts` | token response 与 JWT claims 先验证再持久化；按 `purpose` 获取 token；校验 `iss/aud/purpose/scope` 与 route；不兼容 token 不得继续使用 |
| Account | `packages/ui-mac/src/main/alpha-account.ts` | 删除泛型裸 cast；LedgerPage/Account schema 经过共享 decoder 后才投影给 IPC |
| Model catalog | `packages/ui-mac/src/main/alpha-platform-models.ts` | 严格消费 `ModelCatalogV1`；契约错误不得回退 cache/static catalog |
| Cloud HTTP | `alpha-cloud-jobs.ts`、`cloud-envelope-guard.ts` | 请求在副作用前补齐并验证 v1；控制 envelope 改为 256 KiB；Accepted/Status 严格解码；未知 status 直接拒绝 |
| Cloud MCP | `packages/ext/src/plugin.ts` | 利用既有 `tool.execute.before/after` seam，对 `cloud_dispatch` 及相关 status/artifact 工具做同一 decoder 的前后置校验；不新建 MCP proxy |
| Artifact | `shared/cloud-artifact-descriptor.ts`、`alpha-cloud-jobs.ts`、`cloud-ipc.ts` | 手写 descriptor mirror 改为上游消费者的薄适配；移除 legacy inline/meta 回退；保留既有 streaming、hash、配额、manifest、ArtifactService |
| Release | `packages/ui-mac/src/main/updater.ts` | 仅在上游提供 ReleaseV1 后，于使用 release 数据前严格解码；现有 GitHub feed 校验继续作为独立供应链保护 |
| IPC/UI | `preload/index.ts`、`preload/types.ts`、`renderer/alpha-ui/providers.ts`、`alpha-boundary.tsx`、`Banner.tsx` | 暴露只读 contract health；契约错误产生持久 `role=alert` banner 和原调用点错误，不使用瞬时 toast 掩盖 |

### 2.4 “版本协商”的精确定义

当前唯一批准机制是 wire 内版本字段，没有批准额外 header 或 handshake。因此本票中的“协商”定义为：

1. 桌面发出的 v1 请求携带并通过 `schema_version: 1` 校验。
2. ArtifactDescriptor 使用批准的 `schemaVersion: 1`。
3. 收到的 JSON、JWT、MCP result、release 数据必须回报同一版本。
4. 缺失、未知、未来版本全部拒绝。
5. 不发明 `Accept-Contract-Version` 等本地 header。
6. 若上游未来批准独立协商协议，必须作为新契约版本/需求消费，不能悄悄扩展本票。

### 2.5 Loud failure

统一错误形状只暴露安全字段：

```text
code: contract-incompatible
surface: identity | account | model-catalog | cloud-http | cloud-mcp | artifact | release
expected_version: 1
received_version: missing | unknown | <number>
reason: schema-validation | size-limit | route-purpose-mismatch
```

行为要求：

- main 进程记录 `error` 级日志，但不写 token、完整 payload、URL query 或本地路径。
- 当前调用立即失败，不返回成功形状、不制造默认值。
- renderer 显示持久错误 banner；相关 account/cloud action 同时显示内联错误。
- MCP 工具抛出可见 tool error。
- contract mismatch 不得读取 last-known cache、packaged catalog 或 legacy artifact。
- 网络暂时失败可按既有策略使用“最后一个已验证为兼容”的缓存，但必须显示 degraded 状态；**契约不兼容绝不属于网络降级。**

### 2.6 Fixture 与 CI

- 上游 producer fixtures：直接从 pinned alpha-platform package 运行，不复制到本仓。
- 本仓 consumer fixtures：放在 `packages/alpha-contracts-consumer/fixtures/consumer/v1`，覆盖桌面发出的 cloud request、MCP request、必要的 release/account request。
- `.github/workflows/alpha-ci.yml` 的现有 required test job 增加 consumer package typecheck/test。
- `scripts/alpha-check.sh` 同步纳入该包，保持本地与 CI 入口一致。
- CI 校验依赖解析出的 commit、lock manifest、schema/fixture hashes 三者一致。
- pin 升级必须通过 fixture harness；不兼容则 PR 红灯，不自动追随上游最新版本。

### 2.7 Packaged-app smoke

新增：

```text
packages/ui-mac/scripts/packaged-contract-smoke.ts
```

使用真实 packaged executable、隔离 user-data-dir、CDP 和 loopback fixture producer：

- 正例：fixture server 返回 v1 identity/account/model/cloud/artifact/release 响应；断言出站请求携带 v1，UI 状态为 compatible。
- 负例：逐面返回缺失版本、`schema_version: 2`、未知 cloud status、错误 token purpose。
- 负例必须断言：
  - 调用失败；
  - 后续副作用未发生；
  - 没有 cache/static/legacy fallback；
  - renderer 存在持久 `role=alert`；
  - main log 有安全的 `contract-incompatible`；
  - MCP 显示 tool error；
  - 应用不把不兼容数据当成功继续运行。

该 smoke 属于 L3，每个 RC 执行一次，接入 `distribution.md` 的共享 RC checklist；不要求每个 PR 都完成签名和完整 packaged 测试。

### 2.8 被否决替代

| 替代 | 否决原因 |
|---|---|
| 在 `preload/types.ts` 或 shared 下继续手写全部 wire interface/schema | 复制真相源，继续产生逐字段同步无底洞 |
| CI 每次拉 alpha-platform `main/latest` | 构建不可复现；上游变化会随机破坏旧提交 |
| 接受 v0/v1/v2 或保留 compatibility shim | 当前无用户、无历史包袱，且批准契约明确拒绝 missing/future/legacy |
| 只在 CI 校验 fixture，不做运行时校验 | 真实服务、MCP、缓存和 updater 均可绕过 CI 假设 |
| 新建 cloud MCP proxy 或复制整套 cloud tools | `packages/ext` 已有 before/after hook seam，新增代理属于过度工程 |
| 桌面实现 reservation/settlement/workflow 全套适配 | 这些是 producer/server 面；桌面没有实际消费路径 |
| 自创版本 header 或 ReleaseV1 | 不属于唯一批准契约，违反纯消费者边界 |

### 2.9 红旗自检

- Pin 的是不可变 commit，不是“永远跟最新”。
- 一个共享 decoder，不在每个 adapter 手写字段。
- 测试 schema 与 fixture，不维护第二份字段清单。
- 只接桌面实际消费面，不扩展到平台内部 accounting/workflow。
- Artifact 只替换契约入口，不重写已完成的数据链。
- 升级 pin 是显式、可审查的独立变更；失败即停，不加 shim。

## ③ 安全面与必守不变量

### 3.1 主要失败面

| 风险 | 现有暴露 | 防线 |
|---|---|---|
| 契约漂移未被 CI 捕获 | 本地 cast、手写 descriptor、旧 gateway 容忍 | immutable pin、hash 校验、双向 fixture、负例 drift |
| 静默降级掩盖不兼容 | model cache/static fallback、endpoint 默认值、artifact legacy | 契约错误独立分类，禁止进入网络降级和缓存回退 |
| 版本校验绕过 | MCP 直连、sidecar 通用工具、IPC view type | HTTP/MCP/IPC/artifact/release 共用 decoder；MCP before/after gate |
| Token confused deputy | 单一 token 被用于多种 purpose | route-purpose token API；`iss/aud/purpose/scope` 精确匹配 |
| 未知状态错误归类 | 未验证的 CloudJobStatus | schema enum 拒绝；不得映射到 `running` |
| 资源耗尽 | 现有控制 envelope 为 1 MiB | 副作用前 256 KiB；非流式响应 parse 前 512 KiB；artifact 保持流式 |
| 日志泄露 | 错误可能携带原始响应 | 稳定错误码和摘要字段；禁止 token/payload/path |
| 本地 schema 成为新权威 | artifact mirror 已有先例 | 契约只能从 pinned upstream package 导入；本仓只有消费者逻辑和 UI projection |

### 3.2 必守不变量

1. alpha-platform 的 pinned commit 与发布 schema 是唯一 wire 真相源。
2. 缺失、未知、未来版本均在副作用前拒绝。
3. 所有出站控制请求先做版本、schema、UTF-8 字节上限校验。
4. 所有入站非流式响应先限字节，再 parse，再验证 schema。
5. contract mismatch 不得被缓存、默认值、legacy metadata 或 compatibility flag 吞掉。
6. 每条平台 route 只使用 purpose 与该 route 相等的 token。
7. HTTP 与 MCP 引用同一 CloudJob/Artifact decoder。
8. 未知 cloud status 永不映射成 `running`。
9. artifact 内容只走既有认证流式路径；descriptor 不承载内容。
10. alpha-work#1/#2 的 streaming、hash、配额、manifest 和 ArtifactService 保持单一实现。
11. 失败同时对调用者和全局桌面状态可见，日志不泄密。
12. ReleaseV1 未由上游定义前，不得用 GitHub updater 文件冒充。
13. 不为 reservation、settlement、ledger producer、workflow 等无桌面消费路径的契约制造 adapter。
14. 任何一项 AC 没有验证证据，#224 不关闭。

## ④ 子票切分、文件边界与验证映射

### 4.1 是否再拆

**不再拆 alpha-code 实现子票。**

理由：

- #224 本身已经是 alpha-work#9 的仓级实现票。
- pin、runtime decoder、fixture CI、loud failure 必须原子落地；拆开会产生“CI 已绿但运行时没守”或“运行时已切但 fixture 尚未钉”的中间状态。
- 不创建 PLAN、DECIDE 或本需求专属 VERIFY 票。
- L3 packaged evidence 进入共享 RC checklist。
- 缺失的 ReleaseV1、token issuance、AccountSummary 和不可变发布坐标由上游需求补齐；它们不是本仓可以自行发明的代码子票。
- 若上游缺口未补齐，保持 #224 开放；不得将 release 等 AC 移到“以后”后提前关闭。

### 4.2 计划触达文件

新增：

- `packages/alpha-contracts-consumer/package.json`
- `packages/alpha-contracts-consumer/alpha-platform-contract.lock.json`
- `packages/alpha-contracts-consumer/src/{index,decode,error}.ts`
- `packages/alpha-contracts-consumer/src/*.test.ts`
- `packages/alpha-contracts-consumer/fixtures/consumer/v1/*`
- `packages/ui-mac/scripts/packaged-contract-smoke.ts`

修改：

- `bun.lock`
- `packages/ui-mac/package.json`
- `packages/ext/package.json`
- `packages/ui-mac/src/main/alpha-auth.ts`
- `packages/ui-mac/src/main/alpha-account.ts`
- `packages/ui-mac/src/main/alpha-platform-models.ts`
- `packages/ui-mac/src/main/alpha-cloud-jobs.ts`
- `packages/ui-mac/src/main/cloud-envelope-guard.ts`
- `packages/ui-mac/src/main/cloud-ipc.ts`
- `packages/ui-mac/src/main/updater.ts`
- `packages/ui-mac/src/shared/cloud-artifact-descriptor.ts`
- `packages/ui-mac/src/preload/index.ts`
- `packages/ui-mac/src/preload/types.ts`
- `packages/ui-mac/src/renderer/alpha-ui/providers.ts`
- `packages/ui-mac/src/renderer/alpha-ui/alpha-boundary.tsx`
- `packages/ext/src/plugin.ts`
- `.github/workflows/alpha-ci.yml`
- `scripts/alpha-check.sh`
- `platform-integration.md`
- `platform-endpoint-discovery.md`
- `ci.md`
- `distribution.md`

不新增临时方案 tracker，不重写受保护的知识、设计、audit 或 `.claude/rules` 资产。

### 4.3 AC1–AC4 与验证名

#### AC1：桌面适配层显式钉一个兼容契约版本

实现边界：

- `packages/alpha-contracts-consumer`
- `alpha-auth.ts`
- `alpha-account.ts`
- `alpha-platform-models.ts`
- `alpha-cloud-jobs.ts`
- `packages/ext/src/plugin.ts`
- `updater.ts`

L0：

- `contract lock resolves to the exact immutable alpha-platform commit`
- `contract exports pin Alpha wire version 1`
- `alpha contracts consumer typechecks without local wire definitions`

L1：

- `producer v1 fixtures decode through the desktop consumer`
- `consumer v1 fixtures validate against the pinned producer schemas`
- `rejects missing schema_version before side effects`
- `rejects unknown schema_version before side effects`
- `rejects future schema_version before side effects`
- `rejects a platform_access token whose purpose does not match the route`
- `alpha auth rejects incompatible token claims before persistence`
- `model catalog rejects incompatible v1 data without static fallback`
- `alpha account rejects an incompatible LedgerPageV1 without cached success`
- `release adapter rejects incompatible ReleaseV1 before updater use`

最后一个测试在 ReleaseV1 发布前为明确阻塞项，不能写假 fixture 代替。

#### AC2：CI 跑 producer/consumer fixtures，拒绝不兼容漂移

实现边界：

- `.github/workflows/alpha-ci.yml`
- `scripts/alpha-check.sh`
- `packages/alpha-contracts-consumer/src/*.test.ts`
- `fixtures/consumer/v1`

L0：

- `contract source lock matches bun.lock and published artifact hashes`
- `alpha-check includes the contracts consumer package`

L1：

- `producer v1 fixtures decode through the desktop consumer`
- `consumer v1 fixtures validate against the pinned producer schemas`
- `rejects incompatible producer fixture drift`
- `rejects a mutated v1 enum without coercion`
- `rejects unknown CloudJobStatus.status instead of mapping it to running`
- `rejects control envelopes larger than 256 KiB before dispatch`
- `rejects non-streaming payloads larger than 512 KiB before parse`
- `cloud HTTP and cloud MCP use the same pinned v1 decoder`

#### AC3：artifact 复用 alpha-work#1/#2，不另造

实现边界：

- `shared/cloud-artifact-descriptor.ts`
- `alpha-cloud-jobs.ts`
- `cloud-ipc.ts`
- 既有 `artifact-service.ts`、`artifact-manifest.ts`、`alpha-workdir.ts` 不重写。

L0：

- 既有 artifact streaming/hash/quota/manifest tests 全部继续通过。
- 删除 legacy compatibility 测试，替换成严格拒绝测试。

L1：

- `artifact download reuses the alpha-work artifact pipeline`
- `rejects an incompatible ArtifactDescriptorV1 before issuing the content request`
- `rejects legacy inline artifact metadata without fallback`
- `rejects artifact descriptor drift through the shared pinned decoder`
- `cloud status and MCP artifact result accept only the referenced ArtifactDescriptorV1`
- `artifact contract failure does not degrade to a partial-success warning`

#### AC4：packaged-app smoke 覆盖协商和 loud failure

实现边界：

- `packages/ui-mac/scripts/packaged-contract-smoke.ts`
- `preload/index.ts`
- `renderer/alpha-ui/providers.ts`
- `renderer/alpha-ui/alpha-boundary.tsx`
- `renderer/alpha-ui/Banner.tsx`
- `docs/runbooks/distribution.md`

L3，共享 RC 验证名：

- `RC-L3 packaged app negotiates pinned Alpha v1 contracts`
- `RC-L3 packaged app loudly rejects missing contract versions`
- `RC-L3 packaged app loudly rejects future contract versions without fallback`
- `RC-L3 packaged cloud MCP rejects incompatible results as visible tool errors`
- `RC-L3 packaged artifact flow rejects incompatible descriptors before download`
- `RC-L3 packaged release flow rejects incompatible ReleaseV1 before updater use`

证据至少包括：

- packaged app 版本与平台 pin SHA；
- fixture case；
- UI `role=alert` 截图；
- 去敏后的 main log；
- “未发生后续副作用”的 fixture producer 计数；
- RC checklist 链接。

### 4.4 完成判定

按 requirement-management 的 L0/L1/L3 闭环语义：

- PR 内：L0 与 L1 全绿，文档同步更新。
- RC：L3 packaged smoke 全绿。
- AC1–AC4 逐项附证据后，才可关闭 alpha-code#224。
- alpha-work#9 由其自身所有子需求完成情况人工判断，不由本票 PR 自动关闭。

本轮仅完成静态勘破与方案基线；未修改文件、未执行实现测试。最终只读核验确认工作树仍与 `origin/alpha` 同一提交、无 diff。
