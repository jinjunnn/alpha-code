# S30 — REQ-060 项目级 `.alpha`-only 收尾 + REQ-059 T3b(2026-07-08)

> 契约:ADR-018 §5。WIP=1(S29 已收口)。分支 `feat/s30-req060-finish` → PR → alpha。

## 目标

REQ-060 剩余全清(信任门 UI / T2 / T3 / T5)+ REQ-059 T3b(agents 桥退役),使「项目唯一目录 = `.alpha`」链路端到端可用并真机 verified;全局层 agents 落点与条目化同步收敛。

## 抽取 IDs

| ID | 条目 | 状态(入 sprint 时) |
|---|---|---|
| REQ-060 | 项目级扩展物 `.alpha`-only(剩:信任门 UI / T2 / T3 / T5) | ready |
| REQ-059 | T3b:agents/commands 全局桥退役 + 条目化 | shipped(残 T3b) |

## Task 表

| # | 任务 | 状态 |
|---|---|---|
| S30-1 | 信任门 consent UI:检测 gated → 原生弹窗(B16 模式)→ prefs.json → dispose;拒绝路径记 denied 不重复弹 | ✅ |
| S30-2 | `alpha_register` ext 工具:SAFE_NAME/字段白名单 → 原子写项目 alpha.jsonc → alpha_reload 一条龙;生 TS plugin 拒收 loud | ✅ |
| S30-3 | 创建流改造:agent-creator 落 `<proj>/.alpha/agents` + skill-creator 引导段 + command 指导;REQ-036 修订 | ✅ |
| S30-4 | REQ-059 T3b:writeAgent 去桥(全局 `~/.alpha/agents` + alpha.jsonc 条目;项目 target 同构);removeFsInstall 净除;reconcile 清存量链 | ✅ |
| S30-5 | 真机批(REQ-060 验收 1-6):创建→发现→免重启;信任门双路径;隔离断言;生 TS 拒收;零目录新增 | ✅ |
| S30-6 | 收口:BACKLOG/CHANGELOG/需求档/sprint 回写 + PR merge | ✅ |

## Gates

- 零改上游(north-star guard);`alpha-check` 三关绿。
- 信任门文案与 B16/ADR-021 口径对齐(告知「加载可执行物」的含义)。
- 真机批证据落 `docs/audits/2026-07-08-s30-req060-realmachine/verify.md`。

## 结果

六 task 全完成,一日收口。真机批 12 断言全 PASS(CDP + AppleScript 原生 sheet 实点),证据
[audits/2026-07-08-s30-req060-realmachine](../../audits/2026-07-08-s30-req060-realmachine/verify.md)。

- REQ-060 → **shipped**(核心链路真机 verified):信任门 UI(同意/拒绝双路径 + 不重复弹 + granted
  自动 dispose)、alpha_register(项目级注册一条龙)、创建流改稿(零 `.opencode`)、生 TS 拒收 loud、
  零目录新增全过。**残(会话级)**:模型经真 LLM 会话实调 alpha_register 未演(机制已证)。
- REQ-059 T3b → **shipped + 真机 verified**:writeAgent 去桥条目化(md 真源 + agentMdToEntry
  fail-closed 转换 + alpha.jsonc 条目),装全局 agent 零 `~/.opencode`,卸载净除;reconcile 存量桥
  迁移(单测覆盖,本机无存量验证物)。
- 场中发现:S30-5 启动时发现无 CDP 的旧实例抢占单实例锁导致 9222 拒连(带 flag 的新实例让位退出)
  —— 真机验证前须 pgrep 确认无残留实例,已记入验证方法。
- 单测:ext 24→33,ui-mac 549(全绿);alpha-check 三关绿。

## 回写清单

- [x] BACKLOG:REQ-060 → shipped(核心真机 verified);REQ-059 T3b 残项关闭
- [x] CHANGELOG [Unreleased]:用户可见变化(项目级扩展 `.alpha`-only + 信任门弹窗)
- [x] 需求档 frontmatter:REQ-060 status=shipped;REQ-036 修订节
- [x] 本 sprint.md task 勾选 + 结果
