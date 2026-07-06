---
id: REQ-046
title: catalog 双作者源无同步守卫(A 内置 ↔ C catalog-src)—— 钉死上架流程 + 一致性守卫
type: debt
priority: P1
status: registered
repo: X
created: 2026-07-06
sprint: —
source: S23 用户质询挖出(2026-07-06)
---

## 背景/证据
REQ-032 落地后 catalog 存在**两份手工维护的作者源**:A 内置 `packages/ui-mac/src/renderer/extensions/alpha-catalog.json`(离线回退底座)与 C `alpha-web/catalog-src/catalog.json`(远程下发真源)。A 侧生效顺序 = 远端(验签)→ 缓存 → 内置,远端可达时**整份替换**(`catalog-source.ts`,非合并)→ 联网用户只看 C 那份。

两次实证漂移(均为人肉双写失守):
1. **S22(REQ-044)撤架只撤了 A 侧**:C 侧继续下发 mcp-builder/canvas-design/brand-guidelines(builtin 引用无资产,安装恒失败)+ 空壳 bundle:design —— 撤架对联网用户实际无效(S23 补齐,alpha-web PR #7);
2. **S23 上架 E2/E6 先只写了 A 侧**(用户当场点破后补 C 侧)。

拍板依据已存在但未成流程条款:ADR-023 §3(清单下发落点=C)、ADR-014 v3 O4(远程 catalog 依赖 alpha-web)、REQ-032(远端→缓存→内置回退链)。缺的是**上架/撤架操作流程与守卫**。

## 验收标准
1. **流程钉死(ADR 修订或新 ADR)**:上架/撤架的唯一作者动作发生在哪一侧、另一侧如何同步(候选:C 为作者真源 + A 内置发版时快照;或 A 为作者真源 + C 构建时从 A 拉取 + remote-only 条目 overlay;或保双写 + 守卫),经拍板后写入 ADR-023 修订(或独立 ADR)与 PROCESS.md;
2. **机械守卫**:CI(A 侧 alpha-ci 或 C 侧构建脚本)断言两侧条目一致(豁免 remote-only 条目与 remoteAsset 注入字段),漂移即红——不再依赖人肉记得改两边;
3. 守卫上线后用一次真实上架/撤架演练验证(改一侧不改另一侧 → 守卫红)。

## 非目标
- 不改 A 侧回退链语义(远端→缓存→内置,REQ-032 已验收);
- 不在本条里做 catalog 条目内容变更。

## 关联
[[REQ-032]](远程分发管线)· [[REQ-044]](漂移实证①)· [[REQ-045]](补货依赖同一流程)· ADR-023 §3 · ADR-014 v3 O4。
