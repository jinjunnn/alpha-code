---
id: B1
title: 登录 shell 同步探测黑屏:异步化 + 缓存
type: perf
priority: P1
status: archived
repo: A
created: 2026-07-03
sprint: 2026-07-03-s10-hardening
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

## 采纳方案(2026-07-03,PR #49)
`shell-env-cache.ts`(纯逻辑,4 单测):探测结果缓存 `<userData>/alpha-shell-env.json`,按 shell
路径键控(换 shell 失效)、空探测不缓存(不固化坏态)。`preferAppEnv`:缓存命中 → 0ms 套用 +
后台异步真探测(spawn 非阻塞,成功更新缓存并按「真 export 赢」套差异,新值下次 fork 生效);
未命中(首启/换 shell)→ 保持同步探测(fork 前必须有 PATH,否则 MCP 子进程拿 launchd 贫瘠 env)。

## 验证记录
- 2026-07-03:typecheck + 152 tests 绿(+4);缓存命中路径启动耗时真机测量 → 真机批。
- 已知取舍:改 .zshrc 后第一次启动用旧缓存(后台刷新 + 下次 fork 生效)——boot 延迟换新鲜度,可接受。
