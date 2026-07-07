# S30 — REQ-055 AlphaComposer 单一自建 composer

> 开批:2026-07-07(用户连续拍板:「封装为一个 CSS 一个完整的组件」「我需要的是自建的,不要再集成 opencode」「我不要止血,直接登记并处理掉 REQ-055」)。
> 需求档:[requirements/REQ-055](../../requirements/REQ-055-unified-alpha-composer.md) · 证据:[audits/req055-dev-verify](../../audits/2026-07-07-req055-dev-verify/verify.md)。

## 抽取 IDs

REQ-055(本体)· REQ-054(两缺陷随本项根除)。

## Task 表

| # | 任务 | 状态 |
|---|---|---|
| T1 | 立项:BACKLOG + 需求档(九条验收 + v1 诚实边界) | ✅ |
| T2 | composer-state.ts 纯核(模型/档位/agent/权限本地状态 + buildPromptRequest/routeSlash/filterAgents)+ 10 单测 | ✅ |
| T3 | alpha-composer.tsx(唯一组件:chips 全家 + 提交/中止 + 忙态轮询)+ alpha-composer-model.tsx(自建模型弹层)+ alpha-composer.css(唯一样式,含焦点圈修复) | ✅ |
| T4 | composer-takeover.tsx(会话页顶替上游 + ring 收养);index.tsx 换挂载 | ✅ |
| T5 | 七文件退役删除(composer-inject / slash-inject / composer-controls / cycle-to / variant-normalize + 两测试);AlphaHome 换用统一组件;startChat 加显式参数 | ✅ |
| T6 | 内部 agent config `hidden: true` 注入(sidecar.ts ×3)+ ADR-022 修订 | ✅ |
| T7 | 门禁:alpha-check 三关绿(503 tests;REQ-012 锚点清单再生 alive=195) | ✅ |
| T8 | dev 实例走查:九条验收全 PASS(端到端:选模型→effort 秒切→SDK 带参发送→Sonnet 7s 回复;agent 列表零泄漏;上游 composer 隐藏;ring 收养) | ✅ |
| T9 | PR 合入 + v0.1.2 发版(自动更新)+ 真机复核 → verified | ✅ |

## Gates

- verified 门 = v0.1.2 真机:两面同构截图、effort 即点即生效、agent 零泄漏、focus 无肥圈、自动化调度/只读档零回归。

## 结果(2026-07-07 收尾)

- PR #137(实现,+1553/−1323)/ #138(发版 prep)合入;**v0.1.2 发布并经自动更新落到用户真机**(0.1.1→0.1.2,检测→下载→Restart 全自动)。
- 用户真机复核:首页统一 composer + agent 下拉零内部泄漏 + 会话页接管(上游 display:none)+ 历史完好 → **REQ-055/REQ-054 verified**。
- 当日全链:用户报障(下拉泄漏/effort 死点)→ 立项 → 实现 → dev 九条验收 → 发版 → 真机复核,单日闭环。
