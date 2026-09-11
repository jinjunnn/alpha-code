---
type: design
slug: req160-empty-turn-row
date: 2026-09-11
status: accepted
relates:
  - jinjunnn/alpha-code#1318(本增量是其实现前的形态修正)
  - jinjunnn/alpha-code#1325(REQ-160 AC3)
  - jinjunnn/alpha-work#101 AC3
---

# 模型一个字都没回时,把这件事说在它发生的地方

> **owner 2026-09-11 批准**,帧已并入活稿 `#empty-turn`、台账已回填,**本目录自此冻结**。(呈现形态 + 文案裁决)。帧见同目录 [`frame.html`](frame.html)(常态 / 无重试入口 / 重试失败 / 与既有中断行同屏,浅深两色)。
> 批准后并入 [`current/conversation-timeline/design.html`](../current/conversation-timeline/design.html)
> 的 `#struct`,铸锚 `#empty-turn`;台账见
> [`current/conversation-timeline/components.md`](../current/conversation-timeline/components.md)。

## 1. 与上一稿的关系

**继承**:时间线现行的**中断行**形态(`design ②` 的 `.interrupted` 帧)—— 左对齐安静行、
12px 描边图标、三级灰正文、点分隔、就地的强调色文字按钮、失败提示就地出现。

**新增**:同族的第二个成员 —— 助手回合结束但一个字都没回时的那一行。

**取代**:`#1318` 票面 §Scope 里的
「Sticky **top** banner under session header」+ AC1(常驻顶部横幅)+ AC4(按 `messageId` 记住已关闭)。

**为什么**(owner 2026-09-10 提出「这个前端元素的类型好像不对」,以下是查证后的四条):

| # | 顶部横幅的问题 |
|---|---|
| 1 | **事件是一个回合的,横幅是整个会话的。** 你滚到别处它还在,它描述的那条消息却已经不在视野里。 |
| 2 | **票面自己露了馅**:为了一个全局元素,它不得不发明「按 `messageId` 记住已关闭」这种状态。要给全局元素挂逐条记忆,说明它本来就该挂在那一条上。 |
| 3 | **顶栏这个位置已经有人了。** REQ-159 刚把「沙箱开启」「这个项目只读」放进会话顶栏 —— 那些是**会话/应用级**的持续状态。把「这一条回复是空的」也塞进去,会让这个位置什么都说,于是什么都不说。 |
| 4 | **这个仓早有这一族的既定形态**:中断行。它的源码注释明写「左对齐安静行,**不是居中告警 pill**」,并且是 fail-closed 的(动作接不上就只剩事实陈述,不给一个点不动的按钮)。同一族的新成员没有理由另起一种。 |

另外:票面 §Scope 写「Likely touch: `packages/app/src/pages/session/timeline/`」—— 那是**上游**的叶子,
alpha 早在 REQ-125 C5/C6 就自持了时间线,而北极星守卫会拦下对它的改动。这一句也一并作废。

## 2. 动笔前的地面真相(本轮实读)

| 事实 | 坐标 |
| --- | --- |
| 中断行的形态与 fail-closed 取舍 | `session-timeline-view.tsx:797-830` `InterruptedRow` |
| 该族样式:左对齐、三级灰、12px 描边图标、强调色文字按钮、失败就地 | `session-timeline.css:176-230` |
| 既有文案三条 | `i18n/zh.ts:1368-1371`(`interrupted` / `continueTurn` / `continueFailed`) |
| 会话顶栏现有常驻元素 | `session-workspace-shell.tsx`:运行状态胶囊 · 沙箱 · 只读(REQ-159) |
| alpha 自持时间线,上游那棵不再消费 | `renderer/alpha-ui/session-timeline/`;北极星守卫辖区 |
| 空回合的判据(票面 §Scope,未改) | 完成 + `finish`/`reason` 为 `unknown` + 无非空 text + `tokens.output === 0` |

## 3. 契约(批准后即 AC 字面量锚点)

| 项 | 规则 |
| --- | --- |
| 位置 | 时间线内,**紧挨那个空回合**,与中断行同族同层 |
| 形态 | 左对齐安静行:盾形 12px 描边图标(`--a-warning` 描边)+ 三级灰事实句 + 点分隔 + 强调色文字按钮 |
| 数量 | **一个元素**,两层文字(事实 + 可能性)。票面原本是「顶部横幅 + 气泡内提示」两个说同一件事 |
| 动作 | 「修改后再试」聚焦输入框。**fail-closed**:intent 缺席就只剩事实句,不给点不动的按钮(同中断行) |
| 失败 | 动作失败就地出提示,再点即重试(同中断行) |
| 关闭 | **没有关闭按钮**。它不是通知,是那一回合的事实;回合还在,这行就在 |
| 多条 | 每个空回合各有自己那一行。不需要「只显示最新一条」—— 那是全局元素才有的问题 |
| 判据钩子 | `data-alpha-timeline-row="empty-turn"` |

## 4. 文案(owner 2026-09-11 已裁)

**裁决:把内容安全审核放在明面上,但不断言它就是原因。** 四条判据同时成立时提示;原因以
**可能性**给出,安全审核排第一位 —— 既满足备案叙事(产品确有内容安全这一环并对用户可见),
又不在猜错时指责用户。

为什么不能断言:票面自己的 §Context 写着这一形态**没有** error、**没有**任何内容安全枚举落在
存储里 —— 它是从「跑完了 + 无正文 + 零 token」推断的。真实原因也可能是上游抖动、供应商 bug、
网络中断。与 REQ-159 的「不许宣称比实际更大的保护面」同源:那次别把保护说大,这次别把原因说死。

因此这一行是**两层**:上层是确知的事实,下层是可能性与出路。仍然是一个元素、一行的重量。

| 槽位 | zh | en |
| --- | --- | --- |
| 事实句 | 模型没有返回内容 | The model returned no reply |
| 次级说明 | 可能未通过内容安全审核,也可能是模型或网络异常 | It may not have passed content safety review, or the model or network may have failed |
| 动作 | 修改后再试 | Edit and retry |
| 动作失败 | (沿用既有 `alpha.timeline.continueFailed`) | (同) |

被否决的票面原文:标题直接写「内容未通过安全审核」/「Content blocked by safety review」——
它把一个推断当判决说给用户听。

## 5. 批准后的落点

1. 帧并入 `current/conversation-timeline/design.html` 的 `#struct`,铸锚 `#empty-turn`;
2. 台账加一行(组件 / 锚 / 增量稿 / 实现票 `ac#1318` · `ac#1325`);
3. `#1318` 的 AC1 / AC4 按本稿改写(**AC 改写归 owner**,实现票不自行改);
4. 本目录就地冻结。
