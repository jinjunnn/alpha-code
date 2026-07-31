---
title: "package 兼容详情五态视觉矩阵"
kind: verification
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-31
---

# req128-package-detail · package 兼容详情五态

## harness

`harness/package-detail-harness.html` 逐字加载现役 `tokens.css`、`base.css` 与
`extension-hub.css`，DOM 复刻 `extension-detail.tsx` 的 package 分支。harness 自有样式
只使用 `hz-*`，不覆盖生产选择器。

```
file://<repo>/docs/verification/2026-07-31-req128-package-detail/harness/package-detail-harness.html?theme=<light|dark>&state=<state>
```

五态输入是构造的 safe view 视觉夹具；随包 catalog 当前没有 package。它们证明五种
canonical state 的排版与交互状态，不声称当前线上 catalog 已有对应条目。renderer
真实数据链与返回值键白名单由 `ext-package-detail-wiring.test.ts` 单独验证。
其中 update-required 使用真 evaluator 可复现的 support-stage 失败夹具：
`package:generic-remote-mcp` / `Generic Remote MCP` / `1.0.0`。support gate 返回已严格解码、
有界的 presentation，卡片与详情页消费同一份 safe view，都会展示真实名称和简介。

静态 `file://` harness 没有构建步骤，中文文案仍以字面量复刻；这是它的已知限制。
`ext-package-presentation.test.ts` 逐项把 harness 中会渲染的中文与现役 `zh.ts` 对照，
任一文案漂移都会使闸门变红。

## pairwise 矩阵

| 行 ID | canonical state | theme | 附加维度 | 视觉判据 | 采集 |
| --- | --- | --- | --- | --- | --- |
| P1-compatible-ready-light | compatible + ready | light | 无源 icon | 名称/简介/版本/来源 → 兼容 → 组件/已就绪 → 原因 → 安装；主动作清晰 | [P1](shots/P1-compatible-ready-light.png) |
| P2-compatible-required-dark | compatible + required-action | dark | 长名称、长说明、长 prerequisite、无源 icon | 长文本不横向溢出；两个必需项完整换行；“处理前置条件”可用 | [P2](shots/P2-compatible-required-dark.png) |
| P3-update-required-focus-light | update-required | light | 键盘焦点、无源 icon | “需要更新 Alpha”与原因一致；焦点环可见；按钮是“检查更新”而非安装 | 未重采；现存 PNG 是修复前历史帧 |
| P4-blocked-safety-dark | blocked / package-invalid | dark | disabled、无源 icon | 安全拒绝原因可读；“不可用”按钮为真实 disabled | [P4](shots/P4-blocked-safety-dark.png) |
| P5-blocked-payload-light | blocked / package-payload-integrity | light | disabled、不同 reason、无源 icon | payload 完整性文案与 P4 明确不同；按钮为真实 disabled | [P5](shots/P5-blocked-payload-light.png) |

“无源 icon”指 safe view 没有 icon 字段，页面使用既有首字母占位，不加载远程图片、
SVG 或媒体代理。light/dark、长文本、无源 icon、键盘焦点均以 pairwise 方式覆盖，
没有跑完整乘积。

既有帧采集环境（2026-07-31）：Playwright + Chromium，视口 1100×900，`fullPage`，CSS 像素。
harness 经本地静态服务加载（`file://` 被浏览器协议策略拒绝），现役 `tokens.css` / `base.css` /
`extension-hub.css` 均以 200 返回，非内联复制。P3 的现存 PNG 记录修复前行为，不作为
本票修复后的视觉证据；当前 harness 与生产测试是修复后真值。

## 采集时实测记录

> ⚠️ 这一节是在**采集当时**的五帧上量的,其中 **P3 是修复前的帧**(本票让 update-required
> 带上真实名称与简介之前)。下列结论在修复后仍然成立 —— 结构没变,只有首字母占位图的字母
> 从 `p` 变成 `G` —— 但 P3 那两条的**测量对象**是修复前帧,重采后需复核。

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
空简介章节是否隐藏仍是独立设计决定，不在本票范围内。主会话本次没有可用浏览器，
且按验证约束未在沙箱启动 Playwright 或浏览器进程，因此没有把旧 PNG 冒充为修复后截图。
