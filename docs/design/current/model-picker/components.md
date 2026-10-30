---
title: model picker component ledger
kind: design
status: active
owners:
  - alpha-code product and design maintainers
last_reviewed: 2026-10-30
review_after: 2027-04-30
---

# Model picker 组件台账

[`design.html`](design.html) 的组件与其交付生命周期的对照。字段定义与本层的用途见
[`../../README.md`](../../README.md#componentsmd-fields)。

**本台账从 2026-10-30 起建,覆盖是部分的,不要当完备清单读。** 活稿是 2026-06-27 的交互原型,
早于本层的组件不回填(同其他页台账的「未登记(历史)」约定)。锚在增量并入活稿时铸造。

## 组件

| 组件 | 锚 | 增量稿 | 设计定稿 | 实现票 | 落地 | 代码入口 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 行首品牌图标(选择器三组行、添加供应商卡;映射外与自定义节点回落通用图形) | `#brand-icons` | [`2026-10-30-req236-model-picker/`](../../2026-10-30-req236-model-picker/frame.html) | — | ac#1558 | — | 现状:`alpha-ui/model-picker-core.ts`(`pico` 字母方块)· `alpha-ui/alpha-composer-model.tsx:761-762` · `alpha-ui/model-picker-add.tsx:239-240` | 设计中 |
| 弹层底部清单状态行(已下载待生效 / 更新失败带最近成功时间与重试;两份清单分开、最多两条) | `#catalog-footer` | [`2026-10-30-req236-model-picker/`](../../2026-10-30-req236-model-picker/frame.html)(待生效)· [`2026-10-30-req236-model-status/`](../../2026-10-30-req236-model-status/frame.html)(更新失败) | — | ac#1556 · ac#1557 | — | 现状:无此槽 | 设计中 |
| 平台段空态与分组头失败提示(「平台模型清单尚未获取」,不显示任何价格) | `#platform-empty` | [`2026-10-30-req236-model-picker/`](../../2026-10-30-req236-model-picker/frame.html) · [`2026-10-30-req236-model-status/`](../../2026-10-30-req236-model-status/frame.html) | — | ac#1556 · ac#1557 | — | 现状:无快照时回退随包平台清单(`main/alpha-live-allowlist.ts` `projectPlatformModels`) | 设计中 |
