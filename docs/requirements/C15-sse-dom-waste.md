---
id: C15
title: 运行时 SSE/DOM 浪费收窄(firehose 过滤 + observer 收窄 + idle 去抖)
type: perf
priority: P2
status: ready
repo: A
created: 2026-07-03
sprint: —
source: 册 §一 P2 / R6(降级)/ §7g(A3 尾项)
---

## 背景/证据
3 个 alpha SSE 消费者裸遍历整条 firehose、对 token 增量无合并;3 个 `document.body` 全子树 MutationObserver 全生命周期常开,timeline 那个每宏任务 7 次全文 QSA(R6:有 setTimeout(0) 去抖 + 逐 token no-op,影响弱于字面)。**含 A3 尾项**:每回合 `session.idle` 触发全量 `session.list`,未去抖(册 §7g deferred)。

## 验收标准
1. SSE 消费者按 directory/事件类型前置过滤(不裸遍历);
2. MutationObserver 作用域收窄(容器级而非 body 全子树)、断连时机明确;
3. `session.idle` → session.list 去抖合并;
4. 流式期间 CPU 采样对比(前后各一次,量化下降)。

## 关联
A3(已修主体)、C14(注入面重构同场)、B12(资源域)。
