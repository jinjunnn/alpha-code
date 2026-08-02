---
title: customization center component ledger
kind: design
status: active
owners:
  - alpha-code product and design maintainers
last_reviewed: 2026-08-02
review_after: 2027-01-16
---

# 定制中心组件台账

[`design.html`](design.html) 的组件与其交付生命周期的对照。字段定义与本层的
用途见 [`../../README.md`](../../README.md#componentsmd-fields)。

**这是本页的第一份台账,覆盖是部分的,不要当完备清单读。** 历史行取自活稿现有
分区(四级货架 v6 及其血统),只登记分区级、不逐个回填叶控件;组件级锚按
[`../../README.md`](../../README.md) 的增量五步序**在每个组件下次被动到时补**。

两条读法约定,与 [`../conversation-timeline/components.md`](../conversation-timeline/components.md)
一致:

- **`未登记(历史)` 的行不参与「台账没有仍开着的行 = 已对齐」这条判据。** 它们
  早于本层存在,实现票已不可靠追溯。
- **`设计中` 的行,锚是已约定但尚未存在的 id** —— 增量帧获批并入活稿的那一刻
  才写进 `design.html`。这是 README 增量五步序的第 2 步(先定锚再画),不是断链。
  本文件目前**没有**这样的行。

## 组件

| 组件 | 锚 | 增量稿 | 设计定稿 | 实现票 | 落地 | 代码入口 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 本地插件包导入预览屏 | `#import-preview` | [`2026-08-02-req128-local-plugin-import/`](../../2026-08-02-req128-local-plugin-import/frame.html) | 2026-08-02 | ac#784 | 2026-08-02 | `renderer/extensions/extension-hub.tsx`(`runImportFolder` 分流 + `localPlugin` 预览弹窗)· 判定与文案真源 `main/claude-plugin-intake.ts` | 已落地 |
| 已装扩展包区块(含每技能开关 · 整包移除) | `#installed-packs` | [`2026-08-02-req128-local-plugin-import/`](../../2026-08-02-req128-local-plugin-import/frame.html) | 2026-08-02 | ac#784 | 2026-08-02 | `renderer/extensions/extension-hub.tsx`(`InstalledPackagesSection` / `PackageComponentRow` / `InstalledRow` 的拒绝行) | 已落地 |
| 装后启用与生效状态流(含待重载态) | `#enable-flow` | [`2026-08-02-req128-local-plugin-import/`](../../2026-08-02-req128-local-plugin-import/frame.html) | 2026-08-02 | ac#784 | 2026-08-02 | `renderer/extensions/use-extensions.ts`(`localPluginConfirm` / `uninstallPackage` 各接一次 `refreshEngine`) | 已落地 |
| 推荐页四级货架 | `#featured` | `2026-07-18-req104-four-shelf/` | 2026-07-18 | ac#397 | — | `renderer/extensions/extension-hub.tsx` | 未登记(历史) |
| 浏览卡分级 chip + 「未分级」尾组 | `#browse` | `2026-07-18-req104-four-shelf/` | 2026-07-18 | ac#397 | — | `renderer/extensions/extension-hub.tsx` | 未登记(历史) |
| 详情页事实段 + 组件与来源段 | `#detail` | `2026-07-18-req104-four-shelf/` | 2026-07-18 | ac#397 | — | `renderer/extensions/extension-detail.tsx` | 未登记(历史) |
| 降级与失败态(拉取失败 / 复审过期 / 保守处理) | `#states` | `2026-07-18-req104-four-shelf/` | 2026-07-18 | ac#397 | — | `renderer/extensions/extension-detail.tsx` | 未登记(历史) |
| 已安装行:启用开关 · 会话开关 · 归档警示 | `#policy` | `2026-07-18-req104-four-shelf/` | 2026-07-18 | ac#395 · ac#408 | — | `renderer/extensions/extension-hub.tsx`(`InstalledRow`) | 未登记(历史) |
| 整包事实段 | `#packrel` | `2026-07-17-req104-pack-facts/` | 2026-07-17 | ac#396 | — | `renderer/extensions/extension-detail.tsx` | 未登记(历史) |

## 登记时记下的两处现状 —— 已随本次实现闭合

两条都是登记那一刻的真实缺口,现已被 ac#784 关掉。留在这里是为了让后来人看得出
`#installed-packs` / `#enable-flow` 这两行**为什么存在**。

- **已装的扩展包在已安装页曾经是看不见的。** 唯一能看到「包」的地方是目录条目
  的详情页(`extension-detail.tsx` 的 `kind === "package"` 分支),而它只从远程
  目录进得去;本机导入的包没有目录条目,因此结构上到不了。**现在**已安装页有了
  独立的「扩展包」区块(`InstalledPackagesSection`),排在「已安装条目」之前。
- **整包移除曾经只刷新列表、不重载引擎**,而同一个仓里的启停路径
  (`use-extensions.ts` 的 `setInstallState`)已经在调 `refreshEngine` ——
  后果是移除之后技能仍然能用到下次重启。**现在** `localPluginConfirm` 与
  `uninstallPackage` 各自接了一次 `refreshEngine`,失败则如实呈现「待重载」。

## 落地后核对活稿时发现的两处「代码与稿不一致」

活稿按**上线实况**画;下面两条是画的时候发现的、判断属于**代码**该修的部分,
已如实画进 `design.html` 并在帧外标注。处置归 GitHub Issues,不在本文件里裁决。

- **预览屏「不会安装」那一行的灰标,写的是内部原因码**(如
  `control-field-unsupported`),而不是给用户看的话;它下面那句人话是对的。
  同仓的目录扩展包路径早有相反的规矩:每个 skip token **必须**配一句用户读得懂
  的话,少一条就编译不过(见 `renderer/extensions/ext-package-presentation.ts`)。
- **「读不出插件说明」那一屏自相矛盾**:标题行写「其中 1 个本版本可以装」并把它
  列在「会安装」段里,底部确认键却是禁用的「没有可安装的技能」。本机真实语料
  (`receipts` / `session-report`)走得到这个状态。
