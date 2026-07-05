---
id: D1
title: 健康轮询先 sleep 100ms 再首查(白加延迟)
type: perf
priority: P3
status: archived
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

## 实现(shipped,PR #82)
`server.ts` 的 `ready()` 由「先 `sleep(100)` 再 `checkHealth`」改为「先查、失败才退避 100ms」,与 `wsl/startup.ts` `pollWslHealth` 的立即首查语义一致(它原是唯一的 sleep-first 异类)。抽纯函数 `packages/ui-mac/src/main/health-poll.ts` `pollUntilHealthy`(sleep 可注入)+ `health-poll.test.ts` 2 例锁定验收 ①(首查前不 sleep)③(失败按 100ms 间隔退避);`healthy`/`gone`(`Promise.race`)崩溃退出语义不变,零改上游。
**verified 待真机**:验收②(T_window/T_chat_ready 计时 -~100ms)属真机计时,并入 [[REQ-016]] 收尾批。
