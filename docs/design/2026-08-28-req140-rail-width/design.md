---
type: design
slug: req140-rail-width
date: 2026-08-28
status: proposed
relates:
  - jinjunnn/alpha-code#1161(REQ-140,本增量是其 Ready 门)
---

# 会话右栏宽度规则 —— 上限随窗口计算,会话列保下限

> 帧见同目录 [`frame.html`](frame.html)(规则表 + 三窗口比例示意 + 上限近景,浅/深色)。
> 批准后并入 [`current/session-workspace/design.html`](../current/session-workspace/design.html)
> 的 `#railsec`(「宽度调节」注记)与 `#contract`(「右栏开合」行),台账见
> [`current/session-workspace/components.md`](../current/session-workspace/components.md)。

## 1. 与上一稿的关系

**继承**(session-workspace 现行稿 `#railsec` / `#contract`,全部不动):

- 右栏骨架:tab 化四面板、tab 条 46px、收起行为、按面板记忆宽度;
- 拖宽形态:左缘 6px 热区、悬停/拖动 2px 强调线、键盘 ←/→ 步长 16px;
- 右栏最小宽 320px、默认宽 400px;
- 收起后时间线回中(760 上限)。

**取代**:

- `#railsec` 宽度调节注记中的「拖宽范围 320–560px」;
- `#contract`「右栏开合」行中的「拖宽 320–560px」。

**为什么**:560px 上限是 REQ-125 C4 时代为「产物卡片列」定的;右栏即将承载
文件查看与 html/pdf 就地预览(同日增量 `2026-08-28-req108-rail-file-viewer/`),
固定上限在大窗口下浪费一半屏幕。owner 已明示不要再钉一个新的固定像素值,
方向 = 随窗口宽度算、给会话列留下限 —— 本稿把这个方向落成可批准的具体规则。

## 2. 动笔前的地面真相(全部本轮实读)

| 事实 | 坐标 |
| --- | --- |
| 现上限四层同源:常量 / CSS 字面量 / ARIA / 测试字面量 | `rail-width.ts:6`、`session-workspace.css:509`(`.a-swk-rail-host` max-width)、`session-workspace-shell.tsx:359-360`、`session-rail-artifacts.test.ts:157-165` |
| 唯一 clamp 咽喉,渲染/拖拽/键盘/持久化读写全过它 | `rail-width.ts:21-24` `clampRailWidth`;调用点 `session-workspace-shell.tsx:203-206,277-279,297-306` |
| 布局:根 flex 行,会话列 `flex:1; min-width:0`,右栏 `flex:none` + 行内 width | `session-workspace.css:4-19`、`session-workspace-shell.tsx:351`(`style={{width}}`) |
| 持久化按面板记忆,读写双向 clamp,新旧版本互跑安全 | `rail-width.ts:9,35,51`(localStorage `alpha-session-rail-widths-v1`) |
| 左侧项目栏宽 256px(固定值) | `sidebar/sidebar.css:17`(`--alpha-sidebar-w: 256px`) |
| 窗口最小宽 420px | `main/windows.ts:321` |
| 时间线内容列自身上限 760–820px(与 rail 契约无关,不动) | `session-timeline.css:35,628` |
| 上游未出货 session 页的聊天列下限先例 = 450px | `packages/app/src/pages/session/session-panel-width.ts`(未出货面,仅作取值参照) |

## 3. 规则(批准后即 AC 字面量锚点)

| 契约项 | 值 |
| --- | --- |
| 右栏最小宽 | **320px**(沿用) |
| 右栏默认宽 | **400px**(沿用) |
| 会话列最小可用宽 | **480px**(新) |
| 右栏有效上限 | **会话工作区宽 − 480px**(新;工作区 = `.a-swk-root` 的实际宽,即窗口减项目栏。无固定像素天花板) |
| 冲突裁决 | 工作区 < 800px(= 320 + 480)时,**右栏下限赢**:右栏钉 320px,会话列吃剩余(可能低于 480 —— 那是窗口太小,不是右栏侵占) |
| 窗口变化 | 显示宽实时按当下上限收敛;记忆值不被窗口变化改写,窗口再变宽即恢复 |
| ARIA | `aria-valuemax` = 当下有效上限(动态);`aria-valuemin` 恒 320 |

窗口示例(项目栏按现值 256px):1280 → 上限 544;1440 → 704;1728 → 992;2560 → 1824。

**1280 的诚实注记**:新上限 544 比旧固定值还小 16px。旧规则在 1280 下拉满会把
会话列压到 464(< 480);新规则把这 16px 还给会话列。这是有意的收窄,不是回归。

### 会话列下限取 480 的理由(**已裁决:480,owner 2026-08-28**)

- 仓内最近的先例是上游 session 页的 450px 聊天列下限(未出货,但同一产品形态);
- alpha 会话列的时间线两侧留白与 composer 停靠条比上游宽,450 再打薄会让输入框
  控件行换行,故上调至 480;
- 480 使冲突断点恰为 800px(320 + 480),整数好记、好测。
- 440–520 区间内的值都站得住;本稿推荐 **480**,owner 已采纳(裁决依据即上两条
  论证 + 断点 800)。480 自此为已批契约值。

### 被否决的替代

| 方案 | 为什么否 |
| --- | --- |
| 换一个更大的固定上限(720 / 800) | owner 已明示不钉新固定值;大窗口下仍浪费,小窗口下仍可能挤压会话列 |
| 上限 = 窗口的百分比(如 60%) | 会话列得不到绝对下限保证:超宽窗口没问题,窄窗口 60% 仍会把会话列挤穿 |
| 媒体查询分档 | 现行测试契约明文禁止任何 media query 重声明 rail 宽(audit Major-5,`session-rail-artifacts.test.ts:157-165`);分档也造不出连续行为 |
| 会话列也做成可拖 | 超出本票范围;两条可拖边界互相打架,复杂度不换收益 |

## 4. 实现与测试锚点指引(帧外,给实现票)

- **权威 = 本稿批准的三个契约值(320 / 480 / 「工作区 − 480」规则)**,不是任何一处
  代码字面量。五处(常量、CSS、ARIA、拖拽/键盘 clamp、持久化)都从这一套契约派生。
- CSS 侧该规则可整条表达:`min-width: 320px; max-width: calc(100% - 480px)` ——
  CSS 中 min-width 胜过 max-width,天然实现「右栏让到 320 为止」。JS clamp 加工作区
  宽度项后与之同构;两者是同一契约的两种表达,不允许各自为政。
- 现有两条测试对「只改常量」恒绿(CSS 测试只断 `max-width: 560px` 字面量;
  `rail-width.test.ts:23` 的 `clampRailWidth(9000)===RAIL_MAX_WIDTH` 是自指)。
  **更新测试锚点是 AC 证据的一部分**:新锚点用独立字面量 `320` / `480` /
  `calc(100% - 480px)`,并用实例值断言 clamp(如 `clamp(9000, 工作区=1200) === 720`、
  `clamp(9000, 工作区=760) === 320`),禁止引用生产常量自指。
- 记忆值语义:存「用户选的宽」(交互时按当时上限收敛后写入);读取路径继续双向
  clamp。旧版本读到大值会收敛回 560 显示,新版本读旧值原样可用 —— 双向安全,无迁移。

## 5. 本稿不做的

- rail 内层内容宽(markdown 预览 780px、诚实卡 520px、metadata 640px)—— 内容排版
  契约,另立票;
- 上游 session 页宽度逻辑(未出货面);
- 面板记忆机制重构;
- 会话列自身的排版变化(时间线 760 上限等,全部照旧)。
