# REQ-103 切片 1 取证:五维所有权 schema + 三态分离数据面(2026-07-13,S50)

- Issue:jinjunnn/alpha-code#195(parent jinjunnn/alpha-code#212;§1 五维所有权 / §2 三态分离)
- 分支:`feat/195-req103-hub-governance`(worktree,基于 origin/alpha @ a04b7dbf,含 REQ-088/102)
- 范围:仅数据面(shared schema + 推导纯函数 + 主进程只读聚合)。零 Hub UI 改动、零新增
  preload/IPC 通道(下一切片接线)、零冻结面触碰。
- 交付模块:
  - `packages/ui-mac/src/shared/ext-ownership.ts`(+ 单测)—— 五维值域显式枚举 + 严格校验 +
    逐来源映射纯函数;成为 `ext-manifest-v2.ts` 与 `ext-install-planner.ts` 的值域/推导真源
    (planner 私有 `surfacesFor/distributedFor/supportTierFor` 收编,manifest 合成语义逐字保留)。
  - `packages/ui-mac/src/shared/ext-states.ts`(+ 单测)—— availability/activation/health
    三个正交维度的推导纯函数。
  - `packages/ui-mac/src/main/ext-governance.ts`(+ 单测)—— 只读聚合面:既有真源 →
    逐扩展五维 + 三态,输出纯 JSON(IPC 序列化就绪)。

## 1. 模型

五维所有权(`OwnershipDims`,ADR-028 §3 同名字段):

| 维度 | 值域 |
|---|---|
| `authored` | 自由主体名 ≤64(保留值:`alpha`/`user`/`unknown`;catalog source 原样承载 `official`/`community`/…) |
| `curated` | 同上(alpha catalog 通道恒 `alpha`;用户自装 `user`) |
| `distributed` | `bundled` \| `remote-catalog` \| `npm` \| `engine-config` \| `cloud` \| `local-import`(本切片新增,承载 imported* 存量的诚实通道) |
| `runtimeSurfaces` | `engine-process` \| `local-subprocess` \| `remote-service` \| `model-context` \| `cloud-pipeline`(非空、去重) |
| `supportTier` | `alpha` \| `curated` \| `community` \| `user` |

三态(正交,禁止互相塌缩;父 AC2):

| 维度 | 值域 | 真源 |
|---|---|---|
| `availability` | `installed` ≻ `bundled` ≻ `catalog` ≻ `unavailable` + `sources{installed,bundled,catalog}` 全保留 | 账本(records/receipts)、packaged seed(仅 platformCompatible)、已验 catalog |
| `activation` | `enabled` \| `disabled` \| `not-installed` | v2 `desiredState`;v1-only 无通道如实 `enabled`;未安装恒 `not-installed`(≠ disabled) |
| `health` | `ok` \| `degraded` \| `unknown` + issues(`archived-upstream`/`ledger-v1-compat`/`transaction-pending`/`transaction-rolled-back`) | office-advisories(REQ-105 archived)、账本形态、REQ-100 事务态;未安装且无 advisory 如实 `unknown` |

## 2. 来源映射表(纯函数,单测锁死)

| 来源 | 函数 | authored | curated | distributed | runtimeSurfaces | supportTier |
|---|---|---|---|---|---|---|
| 内置 catalog 快照(channel `bundled`) | `ownershipFromCatalogEntry` | entry.source | `alpha` | mcp→`engine-config`;cloud→`cloud`;plugin→vendored?`bundled`:`npm`;skill/agent→builtin?`bundled`:remoteAsset?`remote-catalog`:`bundled` | mcp local/remote→`local-subprocess`/`remote-service`;plugin→`engine-process`;cloud→`cloud-pipeline`;其余→`model-context` | alpha→`alpha`;official→`curated`;community→`community`;其余→`user` |
| signed channel(channel `remote`/`cache`,REQ-101) | 同上 | 同上 | `alpha` | 同上(无 spec.source 时兜底 `remote-catalog`) | 同上 | 同上 |
| packaged seed(REQ-102) | `ownershipFromSeedAsset` | asset.source | `alpha` | `bundled` | kind 级推导 | 按 asset.source |
| 本地安装,条目可解析 | `ownershipFromInstall(record, resolved)` | = catalog 推导(与浏览面同源) | | | | |
| 本地安装,origin=catalog 条目已消失 | `ownershipFromInstall(record)` | `unknown`(不猜) | `alpha`(安装时经策展通道,main 落账事实) | kind 兜底 | kind 级推导 | `user`(策展支持面不可达,不向上猜) |
| created(自定义 MCP) | 同上 | `user` | `user` | `engine-config` | kind 级推导 | `user` |
| imported(npm plugin)/ imported-claude / imported-agents | 同上 | `user` | `user` | plugin+imported→`npm`;其余→`local-import` | kind 级推导 | `user` |

聚合 join 规则(`ext-governance.ts`):安装行 =(record.id, scope)—— global/project 同名分行
(父 AC5);catalog/seed 有而账本无 → scope=null 浏览行;advisory 对安装行与浏览行同样生效。

## 3. 门禁结果(本机,2026-07-13)

```
▶ [1/3] north-star guard (zero upstream edits)
    ✓ zero upstream package edits
▶ [2/3] typecheck (alpha packages: ext + ui-mac)
    ✓ typecheck
▶ [3/3] unit tests (ext + ui-mac)
 1393 pass / 0 fail (packages/ui-mac, 93 files;新增 3 文件 59 测试)
✅ all local gates green — safe to push (alpha-ci will mirror this in ~40s).
```

```
== simulating restore_frozen_frontend from frontend-freeze-base-3 in a temp worktree ==
OK: seam and all anchors survive restore from frontend-freeze-base-3; restored trees match HEAD freeze set
```

新增单测覆盖的边界组合:archived+installed(健康降级不塌缩激活)、bundled+未安装
(可获得 ⊥ 激活)、advisory+enabled(警示 ≠ 禁用)、installed+disabled+健康(激活 ⊥ 健康)、
seed 平台不兼容(不算 bundled)、catalog 条目消失的如实降级、v1-only 存量、聚合输出
JSON round-trip 与确定性排序、采集零写入。

## 4. 后续切片接口要点(取证时点的既定接缝)

- 切片 2(Hub IA 四区 UI):renderer 直接 import `shared/ext-ownership` / `shared/ext-states`
  的类型与值域;数据经 `ext-governance.ts` 的 `GovernanceView`(纯 JSON)—— 需新开一条只读
  IPC 通道包装 `collectGovernanceView`(catalog 输入复用 ext-ipc 既有已验 catalog resolve 面)。
- 切片 3(capability diff 重确认):`MANIFEST_CAPABILITIES` 仍在 `ext-manifest-v2.ts`
  (本切片刻意未动);grant 键集 digest 在 `ext-receipt-v2.computeGrantDigest`,
  generation/previousDigest 链已可用作「权限增加必须重新确认」的比对锚。
