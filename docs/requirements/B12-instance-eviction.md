---
id: B12
title: Instance 不驱逐 + 递归 watcher 常驻(alpha 侧杠杆)
type: perf
priority: P1
status: in-sprint
repo: A
created: 2026-07-03
sprint: 2026-07-05-s17-deep-decisions
source: 册 §6.2 / R2(上游归属)
---

## 背景/证据
上游 `instance-store.ts:43` Map 无 TTL/LRU;每 Instance 一个递归 fs-events watcher 永不解绑 → 运行时内存增长头号来源。**上游归属(R2),本体不可改**;alpha 杠杆:① `ui-mac/src/main/server.ts:58` 停止强开 `OPENCODE_EXPERIMENTAL_FILEWATCHER`(评估功能代价);② 配合 B4 垃圾项目治理减少 Instance 数。

## 验收标准
1. `OPENCODE_EXPERIMENTAL_FILEWATCHER` 强开评估:关掉后功能影响清单(文件树/diff 刷新等),决策落文档;
2. 采取杠杆后:常驻 watcher 数与长时运行内存增长实测下降;
3. 明确记录「上游本体接受」结论(不排改上游任务)。

## 关联
B4(前置)、C5(同缓解路径)、NON_GOALS#3。
