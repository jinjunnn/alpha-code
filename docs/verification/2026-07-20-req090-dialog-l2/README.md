---
title: REQ-090 Alpha Dialog L2 visual verification
kind: verification
status: accepted
owners:
  - alpha-code frontend
last_reviewed: 2026-07-20
---

# REQ-090 #441 Alpha Dialog L2 视觉证据

## 证据形态

[`harness.html`](harness.html) 是可本地打开的真实 CSS harness：逐字加载现役
`base.css`、`button.css`、`dialog.css` 与 `extension-hub.css`，不覆写任何
`.a-dialog-*`、`.a-btn` 或 `.alpha-ext-*` 实现样式。顶部控件只负责切换状态与主题。

对照基线：已批设计稿 `docs/design/2026-07-20-req090-alpha-surfaces/design.html` 帧 04。

本环境内 Playwright 的缓存浏览器不存在；改用系统 Chrome 后进程在创建页面前以 `SIGABRT`
退出，沙箱也禁止绑定本地 HTTP 端口。因此证据固化为八个确定性 URL 的可复现 HTML，
不声明 PNG 截图。验收者可从仓库根启动任意静态服务器，按下表逐项打开；直接 `file://`
打开也可加载相对 CSS。

## 四态 × 双主题矩阵

| 状态 | 浅色 URL | 深色 URL | 判定记录 |
|---|---|---|---|
| 默认 dismissible | `harness.html?theme=light&state=default` | `harness.html?theme=dark&state=default` | scrim、raised surface、标题/说明层级、关闭入口与主次按钮在两主题均清晰 |
| busy | `harness.html?theme=light&state=busy` | `harness.html?theme=dark&state=busy` | `aria-busy`、处理提示、禁用动作和无关闭按钮一致表达不可取消的进行态 |
| 非 dismissible | `harness.html?theme=light&state=locked` | `harness.html?theme=dark&state=locked` | 非 busy 锁定态同样不出现关闭按钮，内容与可用动作仍保持足够层级 |
| 嵌套 | `harness.html?theme=light&state=nested` | `harness.html?theme=dark&state=nested` | 下层为 `inert` + `aria-hidden` 且无 `aria-modal`；栈顶独占 `aria-modal=true`，双层 scrim/elevation 可辨 |

## 行为证据边界

`packages/ui-mac/src/renderer/alpha-ui/Dialog.test.ts` 先用 Electron renderer 同款 Solid Vite
插件编译生产组件，再真实挂载 Portal 并驱动 signal 与事件。覆盖 open/busy/dismissible、
Escape/backdrop/关闭按钮、#348 授权宿主状态转换、IME、嵌套栈、sentinel、动态替换与焦点恢复。

Happy DOM 不模拟用户代理的原生 Tab 步进，也不能复现跨域 iframe 内 `keydown` 不冒泡到父文档。
实现对 iframe 的处置是：iframe 本身参加父文档 Tab 顺序，首尾 sentinel 在焦点离开 iframe 后继续
封闭父文档循环；跨域 iframe 内的 Escape 不承诺关闭 Dialog，用户始终保留可见关闭按钮。
这两项由 L2 Electron/真机键盘 harness 复核，不由 DOM 单元测试伪造。
