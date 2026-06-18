---
id: ADR-005
title: 架构 pivot — 从 submodule 隔离改为 fork + 只增不改
status: accepted
date: 2026-06-14
supersedes: ADR-001
---

## 背景
[[ADR-001]] 的"workspace 外复用"持续踩坑(symlink/alias、solid-js 双实例、Tailwind production 0 字节 CSS)。根因:自有前端不是 opencode workspace 的原生成员。

## 决策
本仓库 = `anomalyco/opencode` 的 **fork**;自有包(`packages/ext`、`packages/ui-mac`)是原生 workspace 成员。
- 分支:`dev` = upstream 纯镜像(fast-forward);`alpha` = `dev` + 自有新增。**自有代码只在 `alpha`,仓库只此两分支**(日常只在 alpha 工作)。
- 同步:`.github/workflows/sync-upstream.yml` 每天 dev → merge 进 alpha。
- **铁律(取代"submodule 只读"):只新增文件,从不编辑 opencode 既有文件**(唯一结构性例外:根 `bun.lock` —— 新增 workspace 包必然改写它,见 [[ADR-004]] allowlist)→ fork-sync 永远零冲突。

## 后果
- ✅ 原生构建(`workspace:*` / `catalog:`,无 symlink/alias/dedupe hack);实测 475KB CSS、Electron 原生起窗。
- ✅ 北极星不变(冲突文件数 = 0),守卫见 [[ADR-004]]。
- ⚠️ 仓库带 opencode 全历史;electron 在非 hoisted workspace 需 `ELECTRON_EXEC_PATH`(见 ALPHA.md)。
