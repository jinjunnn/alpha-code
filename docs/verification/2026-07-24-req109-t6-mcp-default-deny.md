---
title: REQ-109 T6 —— MCP default-deny 真机 bootstrap 对比留档
kind: verification
status: final
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-24
---

# REQ-109 T6(#535)真机验证:非治理 MCP default-deny 下的实例 bootstrap 时长

票面退出条件「真机实例 bootstrap 时长对比留档」。打包版(`ship:mac`,分支
`feat/req109-t6-mcp-default-deny` @ b75cc43a9,安装至 /Applications)真机冷启动,
与基线文档 §① 条目 5 的 2026-07-23 实测(同一污染输入,29s)对比。

## 输入(复现基线的污染态)

`~/.config/opencode/opencode.jsonc` 恢复为 2026-07-23 实测时的三 local MCP
配置(备份 `.alpha-bak-232616`):`fetch`(uvx mcp-server-fetch)、
`markitdown`(uvx markitdown-mcp,实测装不上必败)、`github`
(npx @modelcontextprotocol/server-github)。三者均不在 alpha 治理集。

## 结果

冷启动 00:40:45(`open -a alpha-code`),引擎日志(run=a16cd65d):

| 事件 | 时间戳 |
| --- | --- |
| 首个 `bootstrapping`(engine-scratch-cwd) | 04:40:48.675Z |
| `bootstrapping directory=/Users/tide/app/alpha-code`(大仓) | 04:40:49.191Z |
| 最后一条 `init count=20/21` | 04:40:50.921Z |

**恢复的 10 个目录并发 bootstrap → 全部 init 完成,总窗口 ≈2.25s**;
alpha-code 大仓实例含在内。基线同一污染输入下该仓单实例 29s
(docs/design/2026-07-23-startup-availability-baseline.md §① 5)。

机制归因(排除偶然):

- 引擎日志新增段(116 行)中三个 MCP 名零出现 —— 引擎未尝试 spawn;
- 引擎运行期间 `pgrep -f 'mcp-server-fetch|markitdown-mcp|server-github'`
  计数 = 0(旧行为:每实例都会 spawn,10 实例放大);
- deny 叶的注入形状与治理豁免由单测钉死
  (packages/ui-mac/src/main/mcp-default-deny.test.ts,含「CONTENT 永不带
  timeout」回归守卫)。

## G2 说明

本机 alpha.jsonc 无 mcp 条目,boot reconcile 为 no-op(幂等/原子写/豁免规则由
packages/ui-mac/src/main/ext-config.test.ts 覆盖)。G2 落点与基线的偏差
(schema 约束 + timeout 一物三用 → main 侧 alpha.jsonc reconcile,remote 豁免)
已修订进基线文档 §②。

## 现场恢复

验证后 `~/.config/opencode/opencode.jsonc` 已恢复为仅 `$schema` 的干净态;
打包 app 退出。
