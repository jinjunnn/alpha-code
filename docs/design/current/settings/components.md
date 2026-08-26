---
title: settings component ledger
kind: design
status: active
owners:
  - alpha-code product and design maintainers
last_reviewed: 2026-08-25
review_after: 2027-02-25
---

# Settings 组件台账

[`design.html`](design.html) 的组件与其交付生命周期的对照。字段定义与本层的
用途见 [`../../README.md`](../../README.md#componentsmd-fields)。

**这是本页第一份台账,随第一个组件级增量新建,覆盖是部分的。** 早于本层的
pane 记为 `未登记(历史)`,不参与「台账没有仍开着的行 = 已对齐」判据。

两条本页专属的读法:

- **已知漂移**:活稿 [`design.html`](design.html) 的设置节仍是 hub-settings 时代的
  「仅 通用 + 快捷键」;现役实现(`packages/ui-mac/src/renderer/alpha-ui/settings.tsx`)
  已有第三项「扩展存储」(req090 已批,活稿未回填)。修复该漂移不属于任何在途
  增量,留待下次动到对应 pane 时一并回写。
- `设计中` 行的锚是**已定名、待并入** —— 帧尚在增量目录,批准并入活稿后锚才可
  解析;并入前不要从别处链接它。

## 组件

| 组件 | 锚 | 增量稿 | 设计定稿 | 实现票 | 落地 | 代码入口 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 通用 pane(行为 / 界面 / 通知与权限) | `#settings` | `2026-06-26-hub-settings-redesign/` → `2026-07-20-req090-alpha-surfaces/` | — | — | — | `alpha-ui/settings.tsx` | 未登记(历史) |
| 快捷键 pane | `#settings` | `2026-06-26-hub-settings-redesign/` | — | — | — | `alpha-ui/settings.tsx` | 未登记(历史) |
| 扩展存储 pane(检查 / 回收) | — | `2026-07-20-req090-alpha-surfaces/` | — | — | — | `alpha-ui/settings.tsx` | 未登记(历史) |
| 「工具」三态策略节(四来源分组 / 继承与生效原因 / 绑定变更与损坏恢复) | `#set-tools`(待并入) | [`2026-08-25-req131-settings-tool-policy/`](../../2026-08-25-req131-settings-tool-policy/design.md) | — | ac#1130 | — | — | 设计中 |
