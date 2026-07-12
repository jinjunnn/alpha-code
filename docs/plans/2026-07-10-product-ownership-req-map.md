# 2026-07-10 产品所有权专项 → REQ 覆盖与推进图

> [!CAUTION]
> **冻结的历史记录(2026-07-11 cutover)。** 本文不再承载活跃状态或进度;活跃工作以 GitHub Issues 与 [Alpha Delivery](https://github.com/users/jinjunnn/projects/2) 为准。本文引用的 docs/BACKLOG.md 已同日冻结;所有权映射对应的活跃工作见 alpha-code / alpha-work Issues。

> 冻结的点时设计与依赖索引。活跃状态、优先级和 Sprint 只在 GitHub Issues 与 [Alpha Delivery](https://github.com/users/jinjunnn/projects/2) 维护；本文件不再更新。
>
> 来源：工作区级报告 `alpha-product-capability-spec-audit-2026-07-10.md`（Alpha 产品能力、前端接管与定制中心专项审计）与 `alpha-extension-ecosystem-and-route-ownership-spec-2026-07-10.md`（Alpha 路由、页面与扩展生态所有权专项方案）。两份报告是 append-only 证据，不承载状态。

## 1. 拆分原则

1. 不建立一个“全面接管”巨型 REQ；每项必须能在一个明确边界内开发、故障注入、验收和回滚。
2. 页面所有权、路由声明所有权、路由语义所有权、运行时所有权分开交付。
3. Artifact transport、manifest、Workbench、renderer、Office correctness 分开交付。
4. App environment、manifest/receipt、原子事务、signed channel、CAS/seed、治理/策展分开交付。
5. Browser 与 Computer Use 分开；Computer Use 保持 parked，必须等待 Browser 安全基线 verified。
6. 复用并修订 REQ-005、REQ-034、REQ-080；不重开已归档的 REQ-018/019/023/032/046/079。

## 2. 覆盖矩阵

| 专项范围 | REQ |
|---|---|
| Product Kernel、surface seam、legacy URL ABI、冻结恢复 | REQ-084 |
| Home 正式页面 | REQ-085 |
| New Session / Draft 正式页面 | REQ-086 |
| LayoutController / LegacySessionAdapter 可行性 | REQ-087；legacy baseline 复用 REQ-005 |
| SessionWorkspace 与 Workbench 集成 | REQ-088 |
| Alpha route manifest、declaration/semantic ownership | REQ-089 |
| Settings/Dialog/Recovery 表面 | REQ-090 |
| AlphaRuntime parity、移除 AppInterface | REQ-091（parked） |
| Artifact base64/缓冲/传输安全 | REQ-092 |
| Artifact manifest、Registry、MIME、配额与保留 | REQ-093 |
| Workbench 基座与 artifact discovery/cards | REQ-094 |
| Markdown/text/code/JSON/CSV/media/PDF renderer | REQ-095 |
| HTML 隔离预览 | REQ-096 |
| OOXML reopen、derivative、视觉验证 | REQ-097 |
| prod/beta/dev 扩展状态隔离、updater、旧布局迁移 | REQ-098 |
| Manifest/Receipt v2、main-only planner、project scope | REQ-099 |
| 原子安装、Bundle、health、rollback/quarantine | REQ-100 |
| signed stable/preview/dev metadata、轮换、撤销 | REQ-101 |
| CAS、离线 seed、release lock、GC | REQ-102 |
| 五维所有权、Capability slots、Hub Governance IA | REQ-103 |
| 开源生态准入、Default/缓存/按需/Labs、原子 Packs | REQ-104 |
| Office Catalog 归档/advisory 紧急纠偏 | REQ-105；历史交付保留 REQ-080 |
| 内置隔离 Browser + session broker + Workbench mode | REQ-106；Playwright 内核选择复用 D5 |
| Screen Control / Computer Use Labs | REQ-107（parked） |
| Claude plugin / Codex 生态导入 | 修订并重新登记 REQ-034 |

## 3. 依赖图

```text
路由：
REQ-084
  ├─→ REQ-085
  ├─→ REQ-086
  ├─→ REQ-087
  └─→ REQ-090
REQ-085 + 086 + 087 + 094 ─→ REQ-088
REQ-085 + 086 + 088 + 090 ─→ REQ-089 ─→ REQ-091 (parked)

Artifact：
REQ-092 ─→ REQ-093 ─→ REQ-094 ─→ REQ-095
                              ├─→ REQ-096
REQ-093 + 094 + 095 ──────────┴─→ REQ-097

Extension v2：
REQ-098 + REQ-099 ─→ REQ-100
          REQ-099 ─→ REQ-101
REQ-098 + 099 + 100 + 101 ─→ REQ-102
REQ-099 + 100 ─→ REQ-103
REQ-100 + 101 + 102 + 103 ─→ REQ-104
REQ-099 + 100 + 103 ─→ REQ-034

高权限能力：
REQ-094 + REQ-096 + D5 ─→ REQ-106 ─→ REQ-107 (parked)

独立纠偏：
REQ-105（不等待上述架构链）
```

## 4. 建议推进波次

以下仅表达设计依赖顺序，不构成 Sprint 承诺。

### Wave 0：当前暴露面

1. REQ-105 Office Catalog 安全纠偏。
2. REQ-098 App environment 隔离与 updater 修正。
3. REQ-099 Manifest/Receipt v2 与 main-only planner。
4. REQ-092 Artifact transport/base64/限额。

### Wave 1：基础契约

1. REQ-084 Product Kernel M0 与 typed seam。
2. REQ-093 Artifact manifest/registry。
3. REQ-100 原子安装事务。
4. REQ-101 signed channel metadata v2。

### Wave 2：可见产品能力

1. REQ-085 Home surface。
2. REQ-086 Draft surface。
3. REQ-087 LegacySessionAdapter spike。
4. REQ-094 Artifact Workbench。
5. REQ-095/096 核心 renderer 与 HTML 隔离。
6. REQ-102/103 CAS seed 与治理 UI。

### Wave 3：核心工作区与生态

1. REQ-088 SessionWorkspace。
2. REQ-090 Settings/Dialog/Recovery。
3. REQ-089 Alpha route composition。
4. REQ-097 Office Preview Pack。
5. REQ-104 精选 Pack；其信任底座完成后 REQ-034 才满足实施前置。

### Wave 4：终局与高权限

1. REQ-106 隔离 Browser。
2. REQ-091 AlphaRuntime parity 清零与 AppInterface 退役。
3. REQ-107 Computer Use 仅在 REQ-106 verified、用户再次拍板后激活。

## 5. ADR 门

- REQ-084 实施前：新建 `ADR-027 Alpha Product Kernel`，并修订 ADR-016/020；同步调整冻结恢复机制或建立包含 seam 的新冻结基点。
- REQ-099 实施前：新建 `ADR-028 Extension Package & Registry v2`，关联 ADR-014/023/024。
- 完整 TUF、OCI/ORAS、立即拆 `alpha-registry` 新仓、任意 Profile UI、第三方顶级路由均不是当前承诺；真实规模触发后另行立 REQ/ADR。

## 6. 调度归属

本索引不维护当前调度。可执行工作、优先级和 Iteration 以 owning GitHub Issue 与 Alpha Delivery 为准。
