---
title: REQ-090 Alpha Settings L2 static harness
kind: verification
status: active
owners:
  - alpha-code frontend
last_reviewed: 2026-07-21
review_after: 2026-10-21
---

# REQ-090 #443 Alpha Settings L2 静态 harness

## 证据形态

[`harness.html`](harness.html) 逐字加载现役 `base.css`、`button.css`、
`banner.css` 与 `settings.css`。Settings DOM 复刻生产组件的类名、结构和
`data-*` 状态；仅 `.l2-*` 类用于状态/主题导航，不覆写生产 Settings 样式。

对照基线：已批设计稿
`docs/design/2026-07-20-req090-alpha-surfaces/design.html` 帧 01(Settings)。

按任务约束，本次没有启动浏览器、headless、Playwright 或截图工具，也不声明
PNG/真机视觉证据。最终 Electron 真机截图与逐像素验收归视觉验收 owner；本目录只提供
可复现的静态 L2 输入。

## 四态 × 双主题矩阵

| 状态      | 浅色 URL                                     | 深色 URL                                    | 静态覆盖点                                                  |
| --------- | -------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------- |
| 默认      | `harness.html?theme=light&state=default`     | `harness.html?theme=dark&state=default`     | 三段导航、扩展存储未检查态、五项聚合字段、手动检查/回收入口 |
| 保存失败  | `harness.html?theme=light&state=save-failed` | `harness.html?theme=dark&state=save-failed` | 权威旧值仍生效、草稿保留、稳定错误说明、重试保存            |
| GC 进行中 | `harness.html?theme=light&state=gc-running`  | `harness.html?theme=dark&state=gc-running`  | `checking`、非量化进行态、双动作禁用                        |
| GC 失败   | `harness.html?theme=light&state=gc-failed`   | `harness.html?theme=dark&state=gc-failed`   | `fail-closed`、聚合计数、未执行清理、重新检查               |

## 数据边界

静态帧只出现 `blobsTotal`、`sweepableCount`、`sweptCount`、`keptByGrace`、
`warningCount` 对应的五张计数卡及稳定状态码。容量、时间戳、路径、digest、逐项进度和
warnings 明细均不进入 harness；生产组件的字段白名单另由内存 DOM 测试锁定。
