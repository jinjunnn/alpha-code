---
title: composer component ledger
kind: design
status: active
owners:
  - alpha-code product and design maintainers
last_reviewed: 2026-09-19
review_after: 2027-03-19
---

# Composer 组件台账

[`design.html`](design.html) 的组件与其交付生命周期的对照。字段定义与本层的用途见
[`../../README.md`](../../README.md#componentsmd-fields)。

**本台账从 2026-09-19 起建,覆盖是部分的,不要当完备清单读。** 整页的分区枚举见活稿各节;
这里只登记从本日起走增量纪律的组件,早于本层的组件不回填(同
[`../session-workspace/components.md`](../session-workspace/components.md) 与
[`../conversation-timeline/components.md`](../conversation-timeline/components.md)
的「未登记(历史)」约定:回填的收益不抵改错的风险)。

锚目前是分区级(`#anatomy` 等),组件级锚在增量并入活稿时铸造。

## 组件

| 组件 | 锚 | 增量稿 | 设计定稿 | 实现票 | 落地 | 代码入口 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 发送被拦下时的输入框提示(提示槽第四个成员) | `#anatomy`(并入时铸 `#send-blocked`) | [`2026-09-19-req160-send-blocked-notice/`](../../2026-09-19-req160-send-blocked-notice/frame.html) | — | ac#1353 | — | 现状:提示槽本体是 `alpha-ui/alpha-composer.tsx:1710-1734` + `alpha-composer.css:44-66`(`.a-comp-model-alert`,今天三个成员);本增量未实现 | 设计中 |
