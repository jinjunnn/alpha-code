---
title: REQ-090 Alpha Dialog L2 visual verification
kind: verification
status: draft
owners:
  - alpha-code frontend
last_reviewed: 2026-07-20
---

# REQ-090 #441 Alpha Dialog L2 视觉证据

真实 CSS harness 截图（#348/#392 同款 L2 模式）：逐字加载 `base.css`、`button.css`、
`dialog.css` 与 `extension-hub.css`，DOM 复刻帧 04 的现役“安全评审已过期”消费者，
不覆写任何 `.a-dialog-*`、`.a-btn` 或 `.alpha-ext-*` 实现样式。

对照基线：已批设计稿 `docs/design/2026-07-20-req090-alpha-surfaces/design.html` 帧 04。

可复现入口：`harness.html?theme=light` 与 `harness.html?theme=dark`。Tab / Shift+Tab
圈禁、Escape、IME、focus restore 与 dismissible 两态由 `Dialog.test.ts` 的 DOM 行为测试覆盖；
#348 busy 不可关闭与安全初始焦点由 `ext-authz-wiring.test.ts` 回归覆盖。

本次受限执行环境内，Playwright Chrome 进程启动即退出，浏览器技能也确认没有可用后端；
因此仓内只固化可复现 harness，未生成或声明浅色/深色 PNG。该限制不替代 L2 截图验收。
