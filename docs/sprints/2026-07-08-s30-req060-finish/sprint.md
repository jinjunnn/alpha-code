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

(收口时回填)

## 回写清单

- [ ] BACKLOG:REQ-060 → shipped(真机后 verified);REQ-059 T3b 残项关闭
- [ ] CHANGELOG [Unreleased]:用户可见变化(项目级扩展 + 信任门弹窗)
- [ ] 需求档 frontmatter:REQ-060 status 同步;REQ-036 修订节
- [ ] 本 sprint.md task 勾选 + 结果
