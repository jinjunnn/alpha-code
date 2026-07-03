---
id: D1
title: 健康轮询先 sleep 100ms 再首查(白加延迟)
type: perf
priority: P3
status: ready
repo: A
created: 2026-07-03
sprint: —
source: 册 §一 P3
---

## 背景/证据
健康轮询固定先 sleep 100ms 再发首查,每次启动白加 ≥100ms。

## 验收标准
1. 首查立即发出,失败后再进入退避间隔;
2. T_window/T_chat_ready 打点(T0.1)对比减少 ~100ms。

## 关联
A1(窗口先行已修)、B5(健康检查同域,可同批顺带)。
