---
title: session workspace component ledger
kind: design
status: active
owners:
  - alpha-code product and design maintainers
last_reviewed: 2026-09-10
review_after: 2027-01-16
---

# Session workspace 组件台账

[`design.html`](design.html) 的组件与其交付生命周期的对照。字段定义与本层的
用途见 [`../../README.md`](../../README.md#componentsmd-fields)。

**本台账从 2026-08-28 起建,覆盖是部分的,不要当完备清单读。** 整页的分区枚举
见活稿各节;这里只登记从本日起走增量纪律的组件,早于本层的组件不回填
(同 [`../conversation-timeline/components.md`](../conversation-timeline/components.md)
的「未登记(历史)」约定:回填的收益不抵改错的风险)。

锚目前是分区级(`#railsec` / `#files` 等),组件级锚在增量并入活稿时铸造。

## 组件

| 组件 | 锚 | 增量稿 | 设计定稿 | 实现票 | 落地 | 代码入口 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 右栏宽度规则(上限随窗口 + 会话列下限) | `#railsec` | [`2026-08-28-req140-rail-width/`](../../2026-08-28-req140-rail-width/frame.html) | 2026-08-28 | ac#1161 | 2026-08-29 | `session-workspace/rail-width.ts`(`RAIL_MIN_WIDTH` 320 · `RAIL_DEFAULT_WIDTH` 400 · `SESSION_MIN_WIDTH` 480,固定上限已移除)· `session-workspace-shell.tsx`(按实测工作区宽收敛)· `session-workspace.css` | 已实现 |
| 文件查看器(文件面下钻 + html/pdf 就地预览) | `#files` | [`2026-08-28-req108-rail-file-viewer/`](../../2026-08-28-req108-rail-file-viewer/frame.html) | — | ac#244(子票 ac#245 · ac#246) | — | 现状:`session-rail/files/*` 点击写入无消费者的 tab store(悬空);查看器待实现 | 设计中 |
| 终端面沙箱告知(脚条第三项 + 空态一行 + 悬停层) | `#term-sandbox` | [`2026-09-10-req159-sandbox-disclosure/`](../../2026-09-10-req159-sandbox-disclosure/frame.html) | 2026-09-10 | ac#1322 | 2026-09-10 | `session-rail/terminal/terminal-rail-panel.tsx`(脚条项 `data-alpha-terminal-foot-sandbox` · 空态行 `data-alpha-terminal-empty-sandbox` · 悬停层)· `alpha-ui/sandbox-state.ts`(围栏信号在 renderer 侧的唯一读取点,引擎自报) | 已实现 |
| 工作区只读告知(顶栏胶囊;第二宿主 = 首页 / 新对话 chip 尾标) | `#wtop-readonly` | [`2026-09-10-req159-sandbox-disclosure/`](../../2026-09-10-req159-sandbox-disclosure/frame.html) | 2026-09-10 | ac#1322 | 2026-09-10 | `session-workspace/session-workspace-shell.tsx`(顶栏胶囊 `data-alpha-workspace-readonly` + 弹层)· `alpha-ui/workspace-chip.tsx`(chip 尾标 `data-alpha-workspace-chip-readonly`)· `alpha-ui/workspace-writable{,-core}.ts`(四态)· `main/workspace-write-probe.ts`(探针本体,只在被围栏的 sidecar 里执行) | 已实现 |
