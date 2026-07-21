---
title: REQ-090 Alpha Permission L2 visual verification
kind: verification
status: accepted
owners:
  - alpha-code frontend
last_reviewed: 2026-07-21
---

# REQ-090 #444 Alpha Permission L2 视觉证据

## 证据形态

[`harness.html`](harness.html) 是确定性的静态 CSS harness，直接加载现役 `base.css`、
`button.css`、`dialog.css` 与 `permission-dialog.css`，并复刻生产组件的 Dialog、五项事实、
三态动作和失败摘要结构。harness 自有样式只绘制背景会话与状态切换器，不改写生产
`.a-dialog-*`、`.a-permission-*` 或 `.a-btn` 样式。

对照基线是已批设计稿
`docs/design/2026-07-20-req090-alpha-surfaces/design.html` 的帧 03。该帧早于 #433，仍保留
“待契约”字段和旧 inline dock；本证据按 #433 已发布的 Request / DecisionCommand 真值替换为
Alpha Dialog、完整五项事实及可用三态动作。设计原稿属于受保护资产，未被回写。

本任务明确禁止启动浏览器、headless、Playwright 与截图，因此不声明 PNG 证据。验收者可在允许
浏览器的环境用任意静态服务器打开以下四个确定性 URL；直接 `file://` 打开也能加载相对 CSS。

## 完整事实 / 三态 / 提交失败 × 双主题

| 状态 | 浅色 URL | 深色 URL | 静态判定 |
|---|---|---|---|
| 完整事实 + 三态 | `harness.html?theme=light&state=default` | `harness.html?theme=dark&state=default` | Agent、action、resources、scope、expiry 均为真实字段；reject / always / once 均可辨，且永久项目授权说明可见 |
| 提交失败 + 三态 | `harness.html?theme=light&state=failed` | `harness.html?theme=dark&state=failed` | 五项事实不丢失；错误摘要明确“未收到收据、不假定已授权”，失败动作显示精确重试文案 |

## 行为证据边界

`packages/ui-mac/src/renderer/alpha-ui/PermissionDialog.test.ts` 用 Electron renderer 同款 Solid
Vite 插件编译生产组件，再挂载到内存 DOM。它验证五项公开 Request 字段、三种
DecisionCommand、always 的 project grantScope 与显式 `grantExpiresAt: null`、失败命令精确重试、
409/ConflictError 区分，以及 #441 Dialog 的初始焦点、Tab / Shift+Tab 圈禁和不可关闭合同。

`permission-mount-ratchet.test.ts` 则钉死唯一 Session surface 挂载、旧 dock 文件删除、legacy
`client.permission.respond` 清除、专属 reskin 清除，以及不引入 REQ-212 领域 enum。

内存 DOM 不代替平台字体与原生绘制验收；本任务禁止的浏览器/截图步骤未执行。
