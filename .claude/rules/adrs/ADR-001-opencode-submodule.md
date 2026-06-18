---
id: ADR-001
title: opencode 以 pinned submodule 引入,自有代码在其外
status: superseded
date: 2026-06-14
superseded-by: ADR-005
---

> ⚠️ 已被 [[ADR-005]](ADR-005-fork-pivot.md)(fork + 只增不改)取代,保留作历史。

## 决策
opencode 作 git submodule 钉死 `7efade2`,自有代码全在 submodule 外的同级 `packages/`。升级 = 切 submodule ref + bump 契约版本。

## 后果
- ✅ 隔离 + 可追踪升级 + 可 diff 审查;opencode 当只读上游。
- ⚠️ 实践中"workspace 外复用 app/ui"持续踩坑(symlink/alias 绕过 exports map、solid-js 双实例、Tailwind 扫不到源码 → production 0 字节 CSS)→ 触发 ADR-005 pivot。
