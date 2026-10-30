---
title: artifact workbench component ledger
kind: design
status: active
owners:
  - alpha-code product and design maintainers
last_reviewed: 2026-08-28
review_after: 2027-01-16
---

# Artifact workbench(会话产物右栏)组件台账

[`design.html`](design.html) 的组件与其交付生命周期的对照。字段定义与本层的
用途见 [`../../README.md`](../../README.md#componentsmd-fields)。

**本台账从 2026-08-28 起建,覆盖是部分的,不要当完备清单读。** 早于本层的组件
不回填(同 [`../conversation-timeline/components.md`](../conversation-timeline/components.md)
的「未登记(历史)」约定)。

## 组件

| 组件 | 锚 | 增量稿 | 设计定稿 | 实现票 | 落地 | 代码入口 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Office 到站占位文案(现在时口径) | `#switcher` | [`2026-08-28-req108-rail-file-viewer/`](../../2026-08-28-req108-rail-file-viewer/frame.html)(§诚实性) | — | 待立(诚实性窄票,主 session 另立) | — | 现状:`renderers/renderer-views.tsx:676-681` · i18n `zh.ts:914-915` 及 en/zht 对应键(将来时,待改) | 设计中 |
| 产物右栏结果优先(本次对话 / 项目全部切换、主结果预览置顶 + 动作排、技术详情折叠、未完成那一次的状态、本次对话空态) | `#results-first` | [`2026-10-30-req236-results-rail/`](../../2026-10-30-req236-results-rail/frame.html) | — | ac#1552 | — | 现状:`session-rail/artifacts/artifacts-panel-view.tsx`(运行条 + 卡片列表 + 预览)· `session-rail-artifacts.tsx`(项目级数据) | 设计中 |
| 警告与出错文字(与云端记录不一致 / 云端不可用 / 文件不在本机 / 尚未下载 / 预览失败 / 文件校验未通过) | `#artifacts-copy` | [`2026-10-30-req236-ux-core-pages/`](../../2026-10-30-req236-ux-core-pages/frame.html) | — | 待立(本稿票表 T4) | — | 现状:`session-rail/artifacts/artifacts-panel-view.tsx:390,469,532,541,561,581` | 设计中 |
