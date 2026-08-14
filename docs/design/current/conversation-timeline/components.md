---
title: conversation timeline component ledger
kind: design
status: active
owners:
  - alpha-code product and design maintainers
last_reviewed: 2026-08-13
review_after: 2027-01-16
---

# Timeline 组件台账

[`design.html`](design.html) 的组件与其交付生命周期的对照。字段定义与本层的
用途见 [`../../README.md`](../../README.md#componentsmd-fields)。

**这是第一份台账,覆盖是部分的,不要当完备清单读。** 行取自活稿 §⑦
「组件索引与待补」的既有枚举(该节仍是设计侧的完备性来源);本文件只是给它
接上交付侧的列。

两条读法约定:

- **锚目前是分区级**(`#user` / `#ai` / `#tools` / `#struct` / `#panel` /
  `#artifacts`),多个组件共用一个。组件级锚按 README 的增量五步序**在每个组件
  下次被动到时补**,不做一次性回填 —— 回填 18 个锚的收益不抵改错的风险。
- **`未登记(历史)` 的行不参与「台账没有仍开着的行 = 已对齐」这条判据。** 它们
  早于本层存在,实现票已不可靠追溯。判据只对 `设计中` / `待实现` / `已实现` 三
  态的行生效。

## 组件

| 组件 | 锚 | 增量稿 | 设计定稿 | 实现票 | 落地 | 代码入口 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 产物链接行 + 右栏预览联动 | `#artifacts` | `2026-07-21-req124-timeline-artifact-rows/` | 2026-07-23 | ac#454 · ac#865 | 2026-08-08 | `cards/tool-cards.tsx` (`TimelineArtifactRows`) · 接线 `session-timeline-view.tsx` · capability 复用 artifact renderer registry | **已实现·REQ-124 票未关** |
| 用户气泡(附件 / 提及 / 连接器 / 脚注动作) | `#user` | `2026-06-28-timeline-overhaul/` | — | ac#862 | 2026-08-08 | `session-timeline-view.tsx` · 编辑接线 `session-workspace/` | 已实现 |
| 斜杠输入(命令 / 技能 / MCP) | `#user` | `2026-06-28-timeline-overhaul/` | — | ac#861 · ac#582 | 2026-08-13 | `session-timeline-view.tsx`(chip 分型)· 捕获链 `alpha-composer.tsx` → `session-composer-dock.tsx` → `session-slash-origin.ts` → `timeline-model.ts` | **已实现**:命令展开体(ac#861)+ 类型分型(ac#582,来源只读引擎 `/command` 声明的 `source`;E3 橙技能 / E4 紫 MCP)。**与稿的已裁差异**:E4 的 name 显示引擎合成键整串(如 `context7:resolve-library-id`),不切 server 两段 —— 引擎无独立 server 字段,切串 = 从名字反推,基线 §6/T3 禁止 |
| 行内代码评论(用户消息内) | `#user` | — | 2026-07-23 | — | — | — | 未登记(历史) |
| 助手 Markdown · 脚注 · 流式 · 中断 | `#ai` | `2026-06-28-timeline-overhaul/` | — | — | — | `timeline-markdown.tsx` | 未登记(历史) |
| 推理 / 思考块(折叠 + 进行中) | `#ai` | `2026-06-28-timeline-overhaul/` | — | ac#863 | 2026-08-08 | `session-timeline-view.tsx` | 已实现 |
| 自动重试卡 | `#ai` | `2026-06-28-timeline-overhaul/` | — | — | — | `session-timeline-view.tsx` · `cards/tool-cards.tsx` | 未登记(历史) |
| 回合级错误卡(限流 / 接口报错 / 上下文超限) | `#ai` | — | 2026-07-23 | ac#590 | 2026-07-26 | `cards/tool-cards.tsx` | 已实现 |
| 助手侧截图 / 图片 / 媒体预览行 | `#ai` | — | 2026-07-24 | — | — | — | 未登记(历史) |
| 通用工具卡四态(运行 / 完成 / 错误 / 待批) | `#tools` | `2026-06-28-timeline-overhaul/` | — | — | — | `cards/tool-cards.tsx` · `cards/tool-card-model.ts` | 未登记(历史) |
| 各工具类型卡(read / grep / bash / edit / MCP …) | `#tools` | `2026-06-28-timeline-overhaul/` | — | — | — | `cards/tool-cards.tsx` | 未登记(历史) |
| 技能执行卡(助手回合) | `#tools` | `2026-06-28-timeline-overhaul/` | — | ~~ac#585~~ | — | `cards/tool-cards.tsx`(走通用工具卡) | **已被取代**:活稿 ③ 节曾画内联 `.skill-chip`,与 ⑥ 节的整宽工具卡冲突;2026-08-09 已批增量要求每张工具卡常驻来源徽标 + 折叠开发者详情(chip 放不下)⇒ owner 2026-08-13 裁决保持工具卡形态,ac#585 关票。帧已就地标注 |
| 全来源工具卡来源徽标 + 安全通用降级 | `#tool-provenance` | `2026-08-08-req125-tool-card-provenance/` | 2026-08-09 | ac#878 · ac#879 · ac#587 | 2026-08-12 | `cards/tool-card-model.ts`(identity 分派 + 规则表) · `cards/tool-cards.tsx`(来源徽标 / 安全通用卡 / 折叠开发者详情) · `cards/tool-redactor.ts`(共享脱敏) | 已实现 |
| glob(按模式匹配文件)工具卡 | `#tools` | — | 2026-07-23 | — | — | `cards/tool-cards.tsx` · `cards/tool-card-model.ts` | 未登记(历史) |
| bash 运行中的流式输出子消息 | `#tools` | — | 2026-07-24 | — | — | `cards/tool-card-model.ts` | 未登记(历史) |
| 文件 part 徽章六态 | `#tools` | — | 2026-07-24 | — | — | `cards/tool-cards.tsx` · `cards/tool-card-model.ts` | 未登记(历史) |
| 工具折叠分组 · 本回合改动 · 回合分隔 | `#struct` | `2026-06-28-timeline-overhaul/` | — | — | — | `timeline-model.ts` | 未登记(历史) |
| 上下文压缩分隔(图标 · 保留要点 · 展开摘要) | `#struct` | `2026-06-28-timeline-overhaul/` | — | ac#864 | 2026-08-08 | `timeline-model.ts` · `session-timeline-view.tsx` | 已实现 |
| 空态(会话内轻着陆) | `#struct` | — | 2026-07-24 | — | — | `session-timeline-view.tsx` | 未登记(历史) |
| 消息导航(上一条 / 下一条) | `#struct` | — | **无帧** | — | — | 代码未接线(仅有「滚动到底」) | **待补** |
| 右栏审查 / 终端(换肤基线) | `#panel` | `2026-06-28-timeline-overhaul/` | — | — | — | 整页四面板形态见 `../session-workspace/` | 未登记(历史) |

## 本次登记时发现的两处不一致

- **ac#454(REQ-124 CODE,「在 timeline 渲染产物链接行并接入右栏预览联动」)仍
  是 OPEN,但两半都已在代码里** —— 行渲染在
  `cards/tool-cards.tsx` 的 `TimelineArtifactRows`,右栏联动走
  `intents.focusArtifact`,由 `session-timeline-view.tsx` 接线。父票 ac#449 同样
  OPEN。要么补验收关票,要么说明还差什么;当前状态两种读法都成立,这正是台账
  要消除的歧义。
- **「消息导航」是唯一确认无帧且代码未接线的组件。** 活稿 §⑦ 已记为待补,这里
  同步登记,不新增结论。

处置归 GitHub Issues,不写在本文件里。
