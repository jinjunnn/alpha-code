---
id: ADR-004
title: 升级隔离纪律 — CI 守卫 opencode 源码零改动
status: trial
date: 2026-06-14
related: [ADR-005]
---

## 决策
1. CI / pre-push 守卫 opencode 源码零改动。ADR-005 fork pivot 后,守卫形态从"submodule diff 为空"变为"**alpha 相对 dev 的 diff 只含新增文件**",**修改类 allowlist 仅 `bun.lock`**(见后果)。
2. 升级流程:切 upstream ref → review 契约 diff(`packages/sdk/openapi.json` + `plugin/src/index.ts` + `tui.ts`)→ bump 自有依赖版本 → `bun turbo typecheck` → 记录到 `docs/retrospectives/`。

> **辖区口径见 [[ADR-044]](ADR-044-north-star-jurisdiction-is-every-upstream-package.md)(2026-09-06)。**
> 本 ADR 只说「守卫上游源码零改动」,没说守到哪里;实现里长成了一张 8 个包的枚举,而 `origin/dev`
> 当天有 32 个包 —— 22 个上游包零机制,实测改 `packages/plugin/src/index.ts` 守卫仍报 `✓ / rc=0`。
> ADR-044 把辖区改成「`packages/` 全树 − 两张显式 carve-out」,本 ADR 的决策与 allowlist 不变。

## 后果
- ✅ 升级摩擦可量化、可守卫;北极星(冲突文件数 = 0)可机械验证。
- ⚠️ 已知例外(守卫须 allowlist,属"修改"非"新增"):① **`bun.lock`** —— 新增 workspace 包(`packages/ext`、`packages/ui-mac`)必然改写根锁文件,结构性不可避免;升级合并若冲突,`bun install` 重生即可。② 新增 `/api/*` 路由走 `patches/`,补丁失效必须 loud-fail。
