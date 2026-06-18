---
id: ADR-004
title: 升级隔离纪律 — CI 守卫 opencode 源码零改动
status: trial
date: 2026-06-14
related: [ADR-005]
---

## 决策
1. CI / pre-push 守卫 opencode 源码零改动。ADR-005 fork pivot 后,守卫形态从"submodule diff 为空"变为"**alpha 相对 dev 的 diff 只含新增文件**"。
2. 升级流程:切 upstream ref → review 契约 diff(`packages/sdk/openapi.json` + `plugin/src/index.ts` + `tui.ts`)→ bump 自有依赖版本 → `bun turbo typecheck` → 记录到 `docs/retros/`。

## 后果
- ✅ 升级摩擦可量化、可守卫;北极星(冲突文件数 = 0)可机械验证。
- ⚠️ 唯一例外(新增 `/api/*` 路由)走 `patches/`,补丁失效必须 loud-fail。
