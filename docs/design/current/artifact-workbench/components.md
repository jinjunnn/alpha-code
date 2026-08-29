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
