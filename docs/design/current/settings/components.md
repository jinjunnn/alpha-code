---
title: settings component ledger
kind: design
status: active
owners:
  - alpha-code product and design maintainers
last_reviewed: 2026-09-17
review_after: 2027-03-17
---

# Settings 组件台账

[`design.html`](design.html) 的组件与其交付生命周期的对照。字段定义与本层的
用途见 [`../../README.md`](../../README.md#componentsmd-fields)。

**这是本页第一份台账,随第一个组件级增量新建,覆盖是部分的。** 早于本层的
pane 记为 `未登记(历史)`,不参与「台账没有仍开着的行 = 已对齐」判据。

两条本页专属的读法:

- **已知漂移**:活稿 [`design.html`](design.html) 的设置节仍是 hub-settings 时代的
  「通用 + 快捷键」再加 2026-09-17 并入的「工具」;现役实现(`packages/ui-mac/src/renderer/alpha-ui/settings.tsx`)
  的导航是 通用 / 快捷键 / 扩展存储 / 工具 —— 第三项「扩展存储」(req090 已批)活稿仍未回填。
  修复该漂移不属于任何在途增量,留待下次动到对应 pane 时一并回写。
- `设计中` 行的锚是**已定名、待并入** —— 帧尚在增量目录,批准并入活稿后锚才可
  解析;并入前不要从别处链接它。

## 组件

| 组件 | 锚 | 增量稿 | 设计定稿 | 实现票 | 落地 | 代码入口 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 通用 pane(行为 / 界面 / 通知与权限) | `#settings` | `2026-06-26-hub-settings-redesign/` → `2026-07-20-req090-alpha-surfaces/` | — | — | — | `alpha-ui/settings.tsx` | 未登记(历史) |
| 快捷键 pane | `#settings` | `2026-06-26-hub-settings-redesign/` | — | — | — | `alpha-ui/settings.tsx` | 未登记(历史) |
| 扩展存储 pane(检查 / 回收) | — | `2026-07-20-req090-alpha-surfaces/` | — | — | — | `alpha-ui/settings.tsx` | 未登记(历史) |
| 「工具」三态策略节(四来源分组 / 继承与生效原因 / 绑定变更与损坏恢复) | `#set-tools` | [`2026-08-25-req131-settings-tool-policy/`](../../2026-08-25-req131-settings-tool-policy/design.md) | 2026-08-26 | ac#1130 | 2026-09-17 | `alpha-ui/settings-tools.tsx`(接线 `alpha-ui/settings.tsx` 第四项导航;数据经 `main/tool-policy-client.ts` → preload `toolPolicy`)· 视觉证据 [`../../../verification/2026-09-17-1130-settings-tools-visuals/`](../../../verification/2026-09-17-1130-settings-tools-visuals/README.md) | **已实现**。**与稿的已裁差异**(实现方默认值,均可回滚):①工具行显示引擎 `identity.name` 原文,不是帧里的中文专名(专名映射归 REQ-125,本仓无此表);②Alpha Cloud 组按数据模型渲染成服务行 → 展开到工具,帧里是平铺;③「N 项注册身份无法核验」提示放整节末尾(`invalid.entries[]` 映射不回具体服务);④新增帧外状态「先打开一个项目」—— 策略按 (账户, 项目) 分区,首页无项目可分区;⑤组名「Alpha Cloud」落地为「云端工具」—— REQ-139 品牌残留闸禁止文案里出现独立词 Alpha;⑥方向键按本仓唯一键盘契约(`roving-focus.ts` 的 radio 表)「移动即激活」,不是帧外说明的「左右键切换、空格确认」 |
