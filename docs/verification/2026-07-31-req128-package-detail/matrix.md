---
title: "package 兼容详情与密钥采集视觉矩阵"
kind: verification
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-31
---

# req128-package-detail · package 兼容详情五态与密钥采集态

## harness

`harness/package-detail-harness.html` 逐字加载现役 `tokens.css`、`base.css`、`button.css`、
`dialog.css` 与 `extension-hub.css`。DOM 复刻 `extension-detail.tsx` 的 package 分支，
密钥采集帧复刻 `extension-hub.tsx` 复用的现役 Dialog / Button / `ExtAuthzView` / 密钥字段
结构。harness 自有样式只使用 `hz-*`，不覆盖生产选择器。

```
file://<repo>/docs/verification/2026-07-31-req128-package-detail/harness/package-detail-harness.html?theme=<light|dark>&state=<state>
```

前五态输入是构造的 safe view 视觉夹具，第六帧是构造的 admission preview 密钥采集态；
随包 catalog 当前没有 package。它们证明这些 canonical state 的排版与交互状态，不声称
当前线上 catalog 已有对应条目。renderer 真实按钮 → 两趟 admission → secret store 数据链、
返回值键白名单与零明文回显由 `ext-package-detail-wiring.test.ts` 单独验证。
其中 update-required 使用真 evaluator 可复现的 support-stage 失败夹具：
`package:generic-remote-mcp` / `Generic Remote MCP` / `1.0.0`。support gate 返回已严格解码、
有界的 presentation，卡片与详情页消费同一份 safe view，都会展示真实名称和简介
（`#729` 落地前它回退为裸 package ID 且简介为空；本文件早期版本记录的是那个旧行为）。
空简介章节是否隐藏仍是 owner 看过真实帧后的设计决定，本 harness 不预判。

静态 `file://` harness 没有构建步骤，中文文案仍以字面量复刻；这是它的已知限制。
`ext-package-presentation.test.ts` 逐项把 harness 中会渲染的中文与现役 `zh.ts` 对照，
任一文案漂移都会使闸门变红。

## pairwise 矩阵

| 行 ID | canonical state | theme | 附加维度 | 视觉判据 | 采集 |
| --- | --- | --- | --- | --- | --- |
| P1-compatible-ready-light | compatible + ready | light | 无源 icon | 名称/简介/版本/来源 → 兼容 → 组件/已就绪 → 原因 → 安装；主动作清晰 | [P1](shots/P1-compatible-ready-light.png) |
| P2-compatible-required-dark | compatible + required-action | dark | 长名称、长说明、长 prerequisite、无源 icon | 长文本不横向溢出；两个必需项完整换行；“处理前置条件”可用 | [P2](shots/P2-compatible-required-dark.png) |
| P3-update-required-focus-light | update-required | light | 键盘焦点、无源 icon | “需要更新 Alpha”与原因一致；焦点环可见；按钮是“检查更新”而非安装 | [P3](shots/P3-update-required-focus-light.png) |
| P4-blocked-safety-dark | blocked / package-invalid | dark | disabled、无源 icon | 安全拒绝原因可读；“不可用”按钮为真实 disabled | [P4](shots/P4-blocked-safety-dark.png) |
| P5-blocked-payload-light | blocked / package-payload-integrity | light | disabled、不同 reason、无源 icon | payload 完整性文案与 P4 明确不同；按钮为真实 disabled | [P5](shots/P5-blocked-payload-light.png) |
| P6-secret-collection-dark | admission preview / secret collection | dark | Dialog、能力差异、长 prerequisite label、password、空值 disabled | 组件事实与能力差异先于密钥；label 完整换行；password 输入焦点可见；未填密钥时确认按钮禁用 | [P6](shots/P6-secret-collection-dark.png) |

“无源 icon”指 safe view 没有 icon 字段，页面使用既有首字母占位，不加载远程图片、
SVG 或媒体代理。light/dark、长文本、无源 icon、键盘焦点均以 pairwise 方式覆盖，
没有跑完整乘积。

采集环境（2026-07-31）：Playwright + Chromium，视口 1100×900，`fullPage`，CSS 像素。
harness 经本地静态服务加载（`file://` 被浏览器协议策略拒绝），现役 `tokens.css` / `base.css` /
`button.css` / `dialog.css` / `extension-hub.css` 均以 200 返回，非内联复制。
P6 已由主 session 采集（实现方按验证约束未在沙箱启动浏览器）。采集脚本在同一次页面加载里
读回：能力 ID `alpha.secret-prerequisite.v1`、`新增` chip、密钥名
`ORGANIZATION_RESEARCH_WORKSPACE_ACCESS_TOKEN`、输入框 `type=password`、
**未填密钥时确认按钮 `disabled === true`** —— 判据可执行，不靠肉眼。

### P6 采集时的两处观察（提交 owner 判断，非本票缺陷）

1. **无词汇表条目的能力，token 会在同一行渲染两次。** `ext-authz.tsx:139/146`：
   `.alpha-ext-authz-nm > b` 在 `vocab()` 缺失时回退成 `props.cap`，而 `.alpha-ext-authz-id`
   本来就渲染 `props.cap`。`alpha.secret-prerequisite.v1` 今天没有词汇表条目，于是同一串
   出现两次且左侧 `<b>` 被压窄换行。harness 是忠实复刻（同结构同回退），**这是生产真实形状**。
   要消除它得给该 capability 增加词汇表条目（label / desc / icon / tier）——那是产品文案决定，
   不由实现方预判。
2. **禁用态只靠 `button.css:32` 的 `opacity: 0.5` 表达**，深色背景下 primary 按钮的
   禁用观感与可用态差别不大。DOM 判据（`disabled === true`）已验证成立；
   「这个观感够不够清楚」是设计判断。与 R1 审计记录的「文案说可留空、按钮却是灰的且无解释」
   属同一处用户困惑，已另开 P2 文案票。

**P3 已于本票落地后重采**，采集脚本同时读回帧内容以证明拍到的是修复后的形状，而不是
靠肉眼判断：`h2 = "Generic Remote MCP"`（修复前是裸的 `package:generic-remote-mcp`）、
`.alpha-ext-dabout = "Generic Phase 1 compiler corpus input."`（修复前是空串）、
动作按钮 `检查更新`、焦点落在面包屑 `推荐`（首个 tab stop）。裸标识符现在只出现在代码 chip 一处。

## 采集时实测记录

> P1/P2/P4/P5 的记录量自首次采集;**P3 已在本票落地后重采并复核**,下列关于 P3 的两条
> 在新帧上仍然成立(结构未变,首字母占位图的字母从 `p` 变为 `G`)。

- 五帧的章节标题顺序：`简介 → 可安装性 → 组件与前置条件 → 原因 → 动作`（五帧目视一致）。
- 五帧均使用首字母占位图，未加载任何远程图片 / SVG / 媒体代理。
- P2 的 `scrollWidth <= clientWidth`，且两个 prerequisite 标签均在 DOM 中完整保留。
- P3 焦点环可见（Tab 后落在面包屑「推荐」，为首个 tab stop），按钮文案是「检查更新」而非安装；
  安装 IPC 的零调用由 wiring 闸验证，不靠截图推断。
- P4/P5 动作按钮的 DOM `disabled === true`，且两帧 reason 文案不同。

## 不在本证据内

- 真机打包 app 截图属于 L3。
- 认证协议、远程媒体、Plugin 与 Bundle 页面不属于本票。
- installability 真值与点击后 main 重判由生产链测试覆盖，不由静态视觉 harness 代替。

## P3 · update-required presentation

修复前的 P3 中，presentation 回落到 package ID，使完整标识符在详情页出现四次：
面包屑、标题、代码 chip、组件行；首字母占位还另外显示一次首字符。这个计数对应
`extension-detail.tsx` 的四个完整渲染点，不是先前记录的三次。

本票改为由 decoder 在 support 失败时返回已经通过严格边界校验的 presentation，
`package-installability.ts` 将它投影到 `update-required` safe view。P3 因而显示
`Generic Remote MCP` 与非空简介；package ID 只保留在代码 chip。浏览卡片同样渲染
这份 presentation，所以名称与简介也一起受益。header-stage 失败仍保留原回落行为，
空简介章节是否隐藏仍是独立设计决定，不在本票范围内。

P3 已由主会话在本票落地后重采（实现方按验证约束未在沙箱启动浏览器，交接给主会话执行）。
采集脚本在截图的同一次页面加载里读回 `h2`、`.alpha-ext-dabout` 与动作按钮文案，
所以「拍到的是修复后的帧」有可执行证据，不靠肉眼比对。

## #743 补记：package 密钥必填说明

上方 P6 行、PNG 与采集观察是 #743 修复前的点时证据，保留原文，不用新内容覆盖。
因 `ext-package-presentation.test.ts` 以硬编码路径读取 harness，
`harness/package-detail-harness.html` 按 #743 约束原地更新为现役 package 语义：
标题与 placeholder 都明示必填，空态显示「全部密钥均为必填;填写完整后才能确认安装。」

当前交互证据不从该历史 PNG 推断。`ext-package-detail-wiring.test.ts` 通过真 Solid DOM +
生产 `ExtensionHub` 断言：空/纯空白时上述原因在 DOM 中可见且确认按钮禁用，
填入非空后原因消失且按钮恢复；legacy MCP 的原文与空值可确认行为有独立断言。
全局 `.a-btn:disabled` 样式未改；package 现在不再只靠透明度解释禁用原因。
