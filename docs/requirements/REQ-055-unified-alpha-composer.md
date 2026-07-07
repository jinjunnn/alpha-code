---
id: REQ-055
title: AlphaComposer 单一自建 composer(会话页替换上游注入,SDK 参数化提交)
type: feature
priority: P1
status: in-sprint
repo: A
created: 2026-07-07
related: [REQ-054, REQ-038, REQ-028, REQ-029, REQ-043, ADR-016]
---

# REQ-055 — AlphaComposer 单一自建 composer

## 背景(用户拍板,2026-07-07)

首页 composer 是 alpha 自建,会话页是上游 prompt-input + alpha 三层注入(composer-inject 的 chips 移植 + slash-inject 的菜单接管 + model-picker-inject 的弹层接管)。两套实现导致反复不一致,用户当日连续报障:effort 首页死点(REQ-054②)、agent 下拉泄漏内部档(alpha-automation/-standard/alpha-readonly)、chips 焦点肥圈回归、首页缺上下文用量按钮、模型 chip 零工作区死点(REQ-054①)。用户拍板:

> 「我让你将他们封装为一个 CSS 一个完整的组件,不要出现这种不一致」
> 「我需要的是自建的,不要再集成 opencode」「我不要止血,直接登记并处理掉 REQ-055」

根因判定:凡「驱动/观察上游隐藏控件」(agent.cycle 轮转、variant cycleTo、MutationObserver 发布标签)的机制都是脆的——上游不可编辑(ADR-005),注入只能追着它的 DOM 跑。终局 = 编辑器本体也自建,状态本地化,提交走 SDK 显式参数。

## 设计决策

1. **AlphaComposer = 唯一 composer**(`alpha-composer.tsx` + 单一 `alpha-composer.css`);`mode: home | session` 同一组件两处渲染。
2. **提交/中止全走 SDK**:home = `session.create` → `promptAsync`;session = `promptAsync({ model:{providerID,modelID}, agent, variant, parts })`;中止 = `session.abort`。斜杠命令沿既有语义(`command.list` 命中 → `session.command`)。
3. **状态本地化,废除 DOM 驱动**:model(localStorage 持久)、variant(档位表来自 alpha-models catalog)、agent(SDK `/agent` 过滤)、perm(readonly = 提交时 `agent="alpha-readonly"`,不再 agent.cycle)。`switchVariantTo` / `switchAgentTo` / label 发布链退役。
4. **会话页接管**:上游 session composer CSS 隐藏(保留在 DOM,不改上游);AlphaComposer Portal 至其容器位;`composer-inject` / `composer-slash-inject` 退役。
5. **上下文用量 ring**:v1 收养上游活 ring 节点(纯只读复用,沿 composer-inject 已验证的收养逻辑);v2 自建(SSE tokens / model limit)。
6. **内部 agent 隐去**:alpha agent 列表过滤(`alpha-automation`、`alpha-automation-standard`、`alpha-readonly`)+ config 注入 `agent.<name>.hidden: true`(引擎原生字段;程序化 prompt 不受 hidden 影响——调度器/只读档照常)。
7. **focus-visible 治理**:chips 键盘焦点细描边;鼠标/程序化焦点零肥圈。

## 验收标准

1. 首页/会话页 composer 为同一组件(同一类族 DOM),截图对比视觉零差异;
2. effort 两面均可点:有档模型即点即生效(提交带 `variant`,引擎侧生效),无档模型诚实禁用(标题说明);
3. agent 选择器两面只显示可见 agent(build/plan/用户自建),内部三件不可见;自动化调度与只读档功能零回归;
4. 会话页显示上下文用量 ring 且随用量更新;
5. 零工作区首页:模型/effort/发送均有诚实反馈(引导选工作区),无死点(REQ-054① 随本项关闭);
6. 鼠标点击 chips 无 3px 肥圈;
7. `/` 命令与 `@` 提及在两面同源(composer-autocomplete)、行为一致;
8. 上游 composer 不再接收用户输入;composer-inject / slash-inject 于会话页退役;
9. 单测:提交参数构造(readonly 覆盖 / variant 门控 / 斜杠路由)+ agent 过滤 + 状态持久化。

## 非目标(v1 诚实边界)

- 附件/拖拽/图片粘贴(上游 composer 的能力,v1 不迁;+ 按钮沿用现菜单);
- 上下文 ring 自建数据源(v2);
- BYOK 模型的 variant 档位(目录无档位数据 → 诚实禁用);
- 上游 model.choose 命令路径的原生弹层(model-picker-inject 保留兜底,不在本项动)。

## 关联

REQ-054(两缺陷随本项根除)· REQ-038/028/029/043(历次对齐/接真的机制被本项取代,行为语义保留)· ADR-016(前端全面接管——本项是 composer 域的兑现)。
