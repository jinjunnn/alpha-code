---
id: B1
title: 登录 shell 同步探测黑屏:异步化 + 缓存
type: perf
priority: P1
status: ready
repo: A
created: 2026-07-03
sprint: —
source: 册 §一 P1 / T1.2 / R6
---

## 背景/证据
`shell-env.ts:36-93` 在 whenReady 前 `spawnSync -il`(5s 超时,超时短路后最坏 ~5s,R6 修正非 10s);本机 267ms,重 dotfiles 用户必踩黑屏。

## 验收标准
1. 黑屏期(首窗前)无任何 `spawnSync`;
2. shell env 探测异步化 + userData 缓存上次结果(启动先用缓存、后台刷新);
3. 重 dotfiles 模拟(sleep 注入 rc 文件)下 T_window 不受影响。

## 关联
A1(窗口先行,已修)、启动性能审计(`audits/2026-07-02-startup-perf-audit.md`)。
