---
title: composer component ledger
kind: design
status: active
owners:
  - alpha-code product and design maintainers
last_reviewed: 2026-09-20
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

视觉证据(双主题 × 宽窄 × 正反向,逐项对照已批帧):
[`docs/verification/2026-09-20-1353-send-blocked-visuals/`](../../../verification/2026-09-20-1353-send-blocked-visuals/README.md)。

## 组件

| 组件 | 锚 | 增量稿 | 设计定稿 | 实现票 | 落地 | 代码入口 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 发送被拦下时的输入框提示(提示槽第四个成员) | [`#send-blocked`](design.html#send-blocked) | [`2026-09-19-req160-send-blocked-notice/`](../../2026-09-19-req160-send-blocked-notice/frame.html) | 2026-09-19 | ac#1353 | 2026-09-20 | `alpha-ui/alpha-composer.tsx` 的 `sendBlocked()` + `.a-comp-send-blocked`(`alpha-composer.css`);文案 `alpha.composer.sendBlocked` / `sendBlockedWhy`;判据钩子 `data-alpha-composer-blocked` | 已落地 |
| 运行权限菜单三档(全部批准 / 请求审批 / 只读) | [`#perm`](design.html#perm) | —(活稿 §07 自最初提交即为三档,早于本层;`#1413` 只把第一档措辞与映射改成落地形状,未出增量稿) | — | ac#1413 | 2026-09-24 | `alpha-ui/alpha-composer.tsx` 的 `PermChip` / `PERM_TEXT` / `PERM_ICON`;映射表 `alpha-ui/composer-state.ts` 的 `PERM_AGENT`;主进程注入 `main/alpha-config-injection.ts` 的 `alpha-ask`;文案 `alpha.composer.permAllow*` / `permAsk*` / `permReadonly*`;`.a-chip-perm[data-mode]`(`alpha-composer.css`) | 已落地 |
