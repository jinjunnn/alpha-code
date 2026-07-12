# 2026-07-12 REQ-084/085/086 视觉验收(S40)

> Append-only 点时证据。真机 dev 实例(CDP 9222)截屏 + DOM 探针,对应
> jinjunnn/alpha-code#177 / #178 / #179 的收尾视觉验收。按用户指令本轮**不做冒烟测试**,
> 以视觉验收 + DOM 探针代替。

| 截图 | 场景 | DOM 探针(Runtime.evaluate) |
|---|---|---|
| `01-home-alpha.png` | `home=alpha`(默认 auto-fallback 解析为 alpha):AlphaHome 经 typed surface 挂载 | `{"url":"/index.html","alphaHomeRoots":1,"newSessionRoots":0,"surfaceErrors":0,"composers":1}` —— 单一 Home page root,无双页面并存 |
| `02-new-session-alpha.png` | 点击「新对话」→ draft 页:AlphaNewSession 经 newSession surface 挂载 | `{"alphaHomeRoots":0,"newSessionRoots":1,"surfaceErrors":0,"composers":1}` —— 首页不再覆盖 /new-session(REQ-086 AC#7),同源 composer |
| `03-home-legacy.png` | `ALPHA_SURFACE_HOME=legacy ALPHA_SURFACE_NEW_SESSION=legacy` env 覆盖重启 | `{"alphaHomeRoots":0,"newSessionRoots":0,"surfaceErrors":0}` —— Alpha 叶不挂载,upstream 叶接管,应用正常、URL 不变(发布回退路径可用) |

已知观察:legacy 模式下 upstream Home 内容区近空——既有 alpha reskin CSS(composer/timeline
takeover)本就隐藏上游 chrome,非本次回归;回退语义(不挂 Alpha 叶、app 存活、导航可用)成立。

配套机器证据:`scripts/verify-freeze-restore.sh` 输出「OK: seam and all anchors survive
restore from frontend-freeze-base-2」;alpha-check 全绿(ext 73 / ui-mac 727);packages/app
typecheck + 407 上游单测零回归。
