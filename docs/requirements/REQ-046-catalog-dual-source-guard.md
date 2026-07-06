---
id: REQ-046
title: catalog 双作者源无同步守卫(A 内置 ↔ C catalog-src)—— 钉死上架流程 + 一致性守卫
type: debt
priority: P1
status: shipped
repo: X
created: 2026-07-06
sprint: S24(2026-07-06,PR #122 + alpha-web PR #8)
source: S23 用户质询挖出(2026-07-06)
---

## 拍板(2026-07-06,用户,S23 当场)
**C 仓 `catalog-src/catalog.json` 是 agent / skill / command / MCP / plugin 条目的唯一作者真源,经接口(远程 catalog)下发;只有「必须 A 仓硬编码」的才留 A 仓**:
1. ed25519 验签**公钥**(信任根,必须随包);
2. **离线回退底座**(B20 永不空白 + 首启断网/验签失败兜底)——但**不再手工编辑**:由 C 已发布产物**快照生成**,发版时刷新;
3. **随包资产本体**(builtinAssetKey / vendoredAssetKey 所指的内置 skill 文件、vendored plugin/agent —— 可执行物与离线资产必须随包,ADR-023 phase 2 边界不变);
4. catalog schema / 类型(`catalog-types.ts`)。

今后条目增删的唯一作者动作 = 改 C `catalog-src` → `build-catalog.mjs` → deploy(A 零动作);A 内置只在发版时快照同步。S23 手编 A 内置(E2/E6)是本方案落地前的最后一次双写,内容与 C 逐字一致、无需回滚。

## 背景/证据
REQ-032 落地后 catalog 存在**两份手工维护的作者源**:A 内置 `packages/ui-mac/src/renderer/extensions/alpha-catalog.json`(离线回退底座)与 C `alpha-web/catalog-src/catalog.json`(远程下发真源)。A 侧生效顺序 = 远端(验签)→ 缓存 → 内置,远端可达时**整份替换**(`catalog-source.ts`,非合并)→ 联网用户只看 C 那份。

两次实证漂移(均为人肉双写失守):
1. **S22(REQ-044)撤架只撤了 A 侧**:C 侧继续下发 mcp-builder/canvas-design/brand-guidelines(builtin 引用无资产,安装恒失败)+ 空壳 bundle:design —— 撤架对联网用户实际无效(S23 补齐,alpha-web PR #7);
2. **S23 上架 E2/E6 先只写了 A 侧**(用户当场点破后补 C 侧)。

拍板依据已存在但未成流程条款:ADR-023 §3(清单下发落点=C)、ADR-014 v3 O4(远程 catalog 依赖 alpha-web)、REQ-032(远端→缓存→内置回退链)。缺的是**上架/撤架操作流程与守卫**。

## 验收标准(按拍板收敛)
1. **快照脚本**:A 侧 `alpha-catalog.json` 由 C 已发布 catalog(或 catalog-src)机械生成(剥离/保留 remoteAsset 按 A 侧消费语义定),发版 runbook 加「刷新内置快照」步;
2. **机械守卫**:CI 断言 A 内置 == 最近一次快照产物(手编 A 内置即红),或等价的一致性断言(豁免 remoteAsset 注入字段);
3. **流程入档**:拍板写入 ADR-023 修订(或独立 ADR)+ PROCESS.md/catalog-publish runbook(上架 = 只动 C);
4. 演练:手编 A 内置一条 → 守卫红;C 上架一条 → A 零动作、联网即见、下次发版快照带入。

## 非目标
- 不改 A 侧回退链语义(远端→缓存→内置,REQ-032 已验收);
- 不在本条里做 catalog 条目内容变更。

## 关联
[[REQ-032]](远程分发管线)· [[REQ-044]](漂移实证①)· [[REQ-045]](补货依赖同一流程)· ADR-023 §3 · ADR-014 v3 O4。
