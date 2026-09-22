---
type: design
slug: turn-running-indicator
date: 2026-09-22
status: draft
relates:
  - jinjunnn/alpha-code#1399(本增量是其 Ready 门)
---

# 一轮还在跑的时候,时间线里一直看得出来

> 帧见同目录 [`frame.html`](frame.html)(运行面四个子状态 / 等你面 / 三种结局;右上角切浅深两色、
> 切正常 / 减弱动效)。**未批准**:批准后并入
> [`current/conversation-timeline/design.html`](../current/conversation-timeline/design.html)
> 的 `#ai`,铸锚 `#turn-running`;台账见
> [`current/conversation-timeline/components.md`](../current/conversation-timeline/components.md)。

## 1. 与上一稿的关系

**继承**(时间线活稿与现行实现,全部不动):回合末尾那一族**安静行**的骨架 —— 中断行
(`design ②` 的 `.interrupted`)与空回合行(`#empty-turn`,2026-09-11 批):左对齐、12px 图标槽、
次级灰文字、点分隔;自动重试卡的琥珀底小卡形态(`.retry-card`);顶栏状态胶囊的脉冲点动效
(`a-swk-status-pulse`);工具卡运行态的转圈 / 扫光 / 呼吸(一个像素不动)。

**新增**:回合末尾那一族的**第三个成员** —— 活跃回合的最后一行,「回合脚行」。它有两面:
**运行面**(脉冲点 + 「正在生成」+ 计时)和**等你面**(静止暂停符号 + 「等待你的决定」)。
一轮从发出到结束,这一行始终在;结束的同一帧让位给回合的结局(脚注 / 中断行 / 错误卡 / 空回合行)。

**取代**:活稿 `②` 里的「正在思考」胶囊(`.thinking`,实现为 `ThinkingRow`)。它今天只在
首个 part 到达前存在,是这一轮的**第一格**;本稿把这一格并进脚行 —— 同一位置、同一时刻,
换成脚行的运行面。这是本稿唯一动到既有已批帧的地方,**默认吸收,留给 owner 否决**(§7)。

**为什么是这个形态**:owner 2026-09-22 的观察是「一轮在跑时页面常常什么都不动」。查实现,
这不是某个动效坏了,而是今天的每一种动效都**只覆盖一个瞬间**:三点跳动只到首个 part、
光标只在正文流式时、转圈只在工具卡已建且在跑时;思考流式中只有标题变色,等待审批时
时间线里一个字都没有。缺的不是第六种动效,是一个**与回合同寿命**的元素。回合末尾这一族
(中断行、空回合行)本来就是「这一回合的事实」住的地方,同族再添一个成员,用户学一次就够。

## 2. 动笔前的地面真相(坐标以 `origin/alpha@e98f9a520`)

| 事实 | 坐标 |
| --- | --- |
| 首 token 未到:`ThinkingRow`,`role="status"`,三点 `a-tl-bob`;**只在 `emitted === 0` 时入列** | `session-timeline-view.tsx:889-901` · `timeline-model.ts:975` |
| 正文流式:尾部闪烁光标,无 role / aria-live | `timeline-markdown.tsx:15-27` · `session-timeline.css:783-791` |
| 推理流式:`ReasoningRow` 只有标题变色,无动效 | `session-timeline-view.tsx:651-706` · `session-timeline.css:855-857` |
| 工具卡运行中:chip 转圈 + 卡头扫光 + 图标呼吸;仅在卡已建且该工具在跑时 | `cards/cards.css:278-302` · keyframes `:1435-1456` |
| 等待审批:时间线里**无任何表示**;工具卡为静态「等待运行」灰 chip;composer 只换 placeholder | `tool-card-model.ts:291-298` · `alpha-composer.tsx:877-879` |
| 审批走独立强模态弹窗(2026-07-26 owner 裁决),本稿不动 | `current/conversation-timeline/design.html:269` |
| 「回合在跑」的唯一真相:`session_status[sessionID].type`(`busy` / `retry` / 非 `idle`)→ `activity: running` | `timeline-model.ts:239-240, 711-722` · `session-workspace-core.ts:47` |
| 「等你批准」的唯一真相:permission feed `ready && requests.length > 0`(fail-closed:feed 未就绪 = 无审批可提示) | `session-composer-dock.tsx:107-113` |
| 顶栏状态胶囊:`role="status" aria-live="polite"`,6px 脉冲点 `a-swk-status-pulse 1.4s` | `session-workspace-shell.tsx:214-223` · `session-workspace.css:113-129, 683-692` |
| 回合末尾同族:中断行 `.a-tl-interrupted`(12px 图标、三级灰、xs)、空回合行复用其骨架 | `session-timeline.css:176-230` |
| 回合脚注只在回合**非活跃**且有可见内容时出行 | `timeline-model.ts:939-940` |
| 时间线容器只有 `role="log"`,无显式 aria-live | `session-timeline-view.tsx:243` |
| 减弱动效:光标、思考点、工具卡动效全部 `animation: none` | `session-timeline.css:1047-1059` · `cards.css:1464-1472` |
| 既有文案:「正在生成…」(顶栏)/「停止生成」/「继续生成」/「等待你的决定…」(composer placeholder) | `i18n/zh.ts:1252,1256,1320,1394` |

一条**本轮实读**出来、票面五个子状态之外的事实:composer dock 还投影一个 `question`
(`headPendingQuestion`,`session-composer-dock.tsx:120-123`)—— 模型用 question 工具向用户
提问时,回合同样在等用户。它与「等待审批」是同一类「轮到你了」,但票面没列、本稿也**没画**;
记在 §8,不在本稿扩 AC。

## 3. 契约(批准后即 AC 字面量锚点)

| 项 | 规则 |
| --- | --- |
| 位置 | 时间线内,活跃回合的**最后一行**;新到的正文 / 思考块 / 工具卡都插在它之前。随内容滚动,**不悬浮、不 sticky**(§7 留 owner) |
| 寿命 | `activity === "running"` 的整段:从这条用户消息成为活跃回合起,到 `session_status` 回到 `idle` 止。五个子状态里没有一个让它消失(AC1) |
| 运行面 | 与中断行同族的安静行:12px 图标槽内 7px `--a-accent` 脉冲点(`a-swk-status-pulse` 同款 1.4s)+「正在生成」(`--a-text-secondary`,sm,medium)+ 点分隔 + 计时(`--a-text-tertiary`,xs,tabular)。①②③④ **不换字、不换形** |
| 等你面 | 仅当 `approvalPending`:换成 `.retry-card` 同族的琥珀底小卡(`--a-warning-subtle` 底、40% `--a-warning` 边、radius lg)。12px 暂停符号(两竖线,`--a-warning` 描边,**静止**)+「等待你的决定」(`--a-text`,medium)+ 点分隔 +「生成已暂停,到审批窗口里选择」(`--a-text-tertiary`,xs)。**计时收起**。无按钮:审批动作仍在弹窗里(AC3) |
| 计时 | 起点 = 该用户消息的 `time.created`,不是行的挂载时刻;`m:ss`;等宽数字;不是进度、不承诺剩余(票面 out of scope) |
| 自动重试 | `status === "retry"` 仍属运行面,行不变;原因与次数由既有自动重试卡说 |
| 消失 | 回合到达任一结局的**同一帧**移除,该位置由结局接管:完成 → 回合脚注;停止 → 中断行;出错 → 回合级错误卡;跑完零正文 → 空回合行。没有淡出、没有停留(AC5) |
| 与工具卡 | 脚行说「这一轮」,卡说「这一步」;卡的动效不动。允许「卡已完成而脚行仍在」;不允许「脚行已消失而卡仍在转」—— 回合结束时仍为 `running` 的卡必须同帧收口(AC2)。等你面时对应的工具卡是静态「等待运行」灰 chip,两者同为静止,不矛盾 |
| 判据钩子 | `data-alpha-timeline-row="turn-running"`,`data-face="running" \| "waiting"` |

## 4. 五个子状态与三种结局

| 子状态 | 回合里同屏有什么 | 脚行 |
| --- | --- | --- |
| ① 已发出,首个字未到 | 只有用户气泡 | 运行面(取代今天的「正在思考」胶囊) |
| ② 正文流式 | 正文 + 句尾光标 | 运行面,在正文之下 |
| ③ 推理流式、未吐字 | 思考头(标题变色,无动效) | 运行面 —— 这几十秒里页面唯一在动的东西 |
| ④ 工具执行中 | 运行态工具卡(转圈 / 扫光 / 呼吸) | 运行面;两层动效各说各的 |
| ⑤ 等待你批准 | 「等待运行」灰 chip 的工具卡;弹窗在时间线之外 | **等你面**:脉冲停、琥珀、计时收起、换词 |

| 结局 | 接管者 | 播报 |
| --- | --- | --- |
| 完成 | 回合脚注(`.meta`:模型 · 时长 · tokens)。脚行最后一格的计时 = 脚注里那个时长 | 顶栏胶囊 `aria-live` 回到「空闲」 |
| 你按了停止 | 中断行「已由你停止 · 继续生成」 | 中断行自身 `role="status"` |
| 出错 | 回合级错误卡 | 错误卡 `role="alert"` |
| 跑完零正文 | 空回合行 | 空回合行(既有) |

## 5. 无障碍(AC4)

- 脚行的**文字部分**是 `role="status"`(隐含 `aria-live="polite"` + `aria-atomic="true"`),
  与今天 `ThinkingRow` 的做法一致,不给时间线容器加显式 `aria-live`(`role="log"` 已隐含 polite,
  再加只会重复播报)。
- 只在值得听的时刻改字,因此只有三次播报:出现时「正在生成」;轮到你时「等待你的决定,生成已暂停,
  到审批窗口里选择」;批完回到「正在生成」。①→②→③→④ 之间**不换字**,所以不播报 —— 那些变化
  由正文、思考块、工具卡进入 `role="log"` 时各自播报。
- 计时放在 status 元素**之外**且 `aria-hidden="true"`:每秒一次的文字变化不能进 live 区。
  脉冲点、暂停符号同样 `aria-hidden`。
- 结束不由脚行播报(被移除的元素没有可靠的最后一次播报),由接管者播报(§4 表)。成功完成
  这一种没有时间线内的播报,靠顶栏胶囊回到「空闲」—— 这是既有行为,本稿不加隐藏 live 区。

## 6. 动效与减弱动效

只复用,不新造:脉冲点 = `a-swk-status-pulse`(顶栏同款,1.4s);等你面零动效。
**没有**用 `a-tc-spin`(那是「这一步在跑」的符号,同屏两种转圈会让人分不清层级)、
**没有**沿用 `a-tl-bob` 三点(比脉冲点吵,且与句尾光标抢节奏)。

`prefers-reduced-motion: reduce` 时脉冲点静止(与光标、思考点、工具卡同一条既有规则);
**计时照走** —— 这时它是页面上唯一的「还活着」信号,所以不能随动效一起省掉。帧右上角
可切换预览。

## 7. 留给 owner 的三点(每条都有默认值,可回滚)

1. **「正在思考」胶囊并进脚行。** 默认:并 —— 一轮里只有一个元素、一种形状,首个字到达前后
   不换壳。代价:活稿 `②` 那枚强调色胶囊从产品里消失,首个字到达前的文案从「正在思考…」
   变为「正在生成」。不并的话:胶囊照旧,脚行从首个 part 起才出现,首 token 前后形状会变一次。
2. **带计时。** 默认:带 —— 它是减弱动效下唯一的活信号,也是「没卡住」最诚实的证据,且与
   完成后脚注里的时长首尾相接。代价:多一处每秒跳动的数字;若嫌吵,去掉后运行面只剩脉冲点 + 词。
3. **不悬浮。** 默认:随内容滚动 —— 用户滚上去读旧内容时它随回合离开视野,那时顶栏胶囊
   仍在。另一种是 `position: sticky` 贴在时间线底缘,滚上去也看得见;代价是多一层悬浮物,
   与「滚动到底」按钮抢同一块地、遮正文。

## 8. 批准后的落点与本稿明知不做的事

1. 帧并入 `current/conversation-timeline/design.html` 的 `#ai`,铸锚 `#turn-running`;
   同段的「正在思考」胶囊按 §7-1 的裁决处理(并 → 该帧标注「已并入回合脚行」;不并 → 原样)。
2. 台账行由「设计中」翻为已批;实现票关闭的同一 PR 回填落地列与代码入口。
3. `#1399` 的 AC 若因 §7 裁决而措辞有变,**AC 改写归 owner**。
4. 本目录就地冻结。

**不做**:不动审批走独立弹窗这条裁决;不动顶栏胶囊 —— 但记一条实读出来的不一致:等待审批时
顶栏仍显示「正在生成…」,与本稿等你面的说法相左,是否让胶囊也分两面归后续;不画 `question`
工具的「等你回答」(§2 末),它是同一类状态、票面之外;不做进度百分比与预计剩余。
