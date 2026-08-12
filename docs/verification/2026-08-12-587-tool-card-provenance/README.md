---
title: "#587 工具卡全来源徽标与安全通用卡视觉证据(AC5)"
kind: verification
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-08-12
---

# #587 工具卡 provenance 视觉证据(AC5)

alpha-code#587(REQ-125)的组件级视觉证据:pending / running / completed / error ×
light / dark × narrow(460px)/ wide(1280px)。挂载**现役生产组件**
`SessionTimelineView` 与现役生产 CSS,loopback Vite 构建 + Chrome `--headless=new`
截图;零 Electron、零账号/API key、零前台窗口(与已批 `2026-07-24-req125-session-visual`
harness 同一模式)。

- 生产基线 commit:`5a748ab55df57368fecaafdb2d1456f75e795d0a`
- Chrome:`151.0.7922.77`,采集时间 `2026-08-12T04:21:17Z`
- 逐帧完整 sha256 见 [`harness/capture-metadata.json`](harness/capture-metadata.json)

## states

| state | 覆盖 |
| --- | --- |
| cloud-pending / cloud-running / cloud-completed / cloud-error | 云卡四生命周期态(dispatch / await / web_search / schedule_create 各占一态,状态徽标 + 云端徽标 + 语义中文标题) |
| cloud-all | **Cloud 8/8**:全部 8 个云工具的语义化中文标题 + 关键目标 + `云端` 徽标 + 状态(AC1) |
| matrix | 全来源矩阵:builtin(本机)/ host(宿主)/ Alpha Cloud(云端)/ 第三方 MCP / 插件 / unknown(未知来源 + error);降级卡带确定隐藏理由的安全通用卡(AC2) |
| dev-open | 开发者详情展开态(canonical / technical-id / authority;默认折叠,本帧为点击后交互证据,AC3) |

## 帧清单(28 帧)

| state | theme | width | file | sha256(前 16) |
| --- | --- | --- | --- | --- |
| cloud-pending | light | narrow | [`cloud-pending-light-narrow.png`](shots/cloud-pending-light-narrow.png) | `50dedf4c16a6bd3f…` |
| cloud-pending | dark | narrow | [`cloud-pending-dark-narrow.png`](shots/cloud-pending-dark-narrow.png) | `5784ae88e318fdd5…` |
| cloud-running | light | narrow | [`cloud-running-light-narrow.png`](shots/cloud-running-light-narrow.png) | `93def06a989c0391…` |
| cloud-running | dark | narrow | [`cloud-running-dark-narrow.png`](shots/cloud-running-dark-narrow.png) | `f577820088d107c3…` |
| cloud-completed | light | narrow | [`cloud-completed-light-narrow.png`](shots/cloud-completed-light-narrow.png) | `53092113b06f8ec1…` |
| cloud-completed | dark | narrow | [`cloud-completed-dark-narrow.png`](shots/cloud-completed-dark-narrow.png) | `8ad92bf48a620852…` |
| cloud-error | light | narrow | [`cloud-error-light-narrow.png`](shots/cloud-error-light-narrow.png) | `86c406430af37c46…` |
| cloud-error | dark | narrow | [`cloud-error-dark-narrow.png`](shots/cloud-error-dark-narrow.png) | `bd54f9c026f1f5d3…` |
| cloud-all | light | narrow | [`cloud-all-light-narrow.png`](shots/cloud-all-light-narrow.png) | `fde151f04ffe3980…` |
| cloud-all | dark | narrow | [`cloud-all-dark-narrow.png`](shots/cloud-all-dark-narrow.png) | `8bae6b24e26d2b33…` |
| matrix | light | narrow | [`matrix-light-narrow.png`](shots/matrix-light-narrow.png) | `408d3e2f118e7fe8…` |
| matrix | dark | narrow | [`matrix-dark-narrow.png`](shots/matrix-dark-narrow.png) | `9a97a499ffd344c1…` |
| dev-open | light | narrow | [`dev-open-light-narrow.png`](shots/dev-open-light-narrow.png) | `bb73aefcf2fc7d49…` |
| dev-open | dark | narrow | [`dev-open-dark-narrow.png`](shots/dev-open-dark-narrow.png) | `a487baa5c02c1f62…` |
| cloud-pending | light | wide | [`cloud-pending-light-wide.png`](shots/cloud-pending-light-wide.png) | `2ab0a13959bc751c…` |
| cloud-pending | dark | wide | [`cloud-pending-dark-wide.png`](shots/cloud-pending-dark-wide.png) | `f6bf78d5309b93fb…` |
| cloud-running | light | wide | [`cloud-running-light-wide.png`](shots/cloud-running-light-wide.png) | `774624568fcd48f8…` |
| cloud-running | dark | wide | [`cloud-running-dark-wide.png`](shots/cloud-running-dark-wide.png) | `571961f605761250…` |
| cloud-completed | light | wide | [`cloud-completed-light-wide.png`](shots/cloud-completed-light-wide.png) | `651cb2b23fd359da…` |
| cloud-completed | dark | wide | [`cloud-completed-dark-wide.png`](shots/cloud-completed-dark-wide.png) | `b0648e53b3046595…` |
| cloud-error | light | wide | [`cloud-error-light-wide.png`](shots/cloud-error-light-wide.png) | `fede18650b9d0f3c…` |
| cloud-error | dark | wide | [`cloud-error-dark-wide.png`](shots/cloud-error-dark-wide.png) | `b87e0f63cc5db580…` |
| cloud-all | light | wide | [`cloud-all-light-wide.png`](shots/cloud-all-light-wide.png) | `3bc1e6cbad39eada…` |
| cloud-all | dark | wide | [`cloud-all-dark-wide.png`](shots/cloud-all-dark-wide.png) | `f14d62adf2734fc6…` |
| matrix | light | wide | [`matrix-light-wide.png`](shots/matrix-light-wide.png) | `403e0c2b4872b6e0…` |
| matrix | dark | wide | [`matrix-dark-wide.png`](shots/matrix-dark-wide.png) | `2b49cbc1902e5398…` |
| dev-open | light | wide | [`dev-open-light-wide.png`](shots/dev-open-light-wide.png) | `33358855ea4e6060…` |
| dev-open | dark | wide | [`dev-open-dark-wide.png`](shots/dev-open-dark-wide.png) | `ad93f5ddd4439c13…` |

## 复跑

```sh
packages/ui-mac/node_modules/.bin/vite build \
  --config docs/verification/2026-08-12-587-tool-card-provenance/harness/vite.config.ts \
  --outDir /private/tmp/harness-587-dist --emptyOutDir
python3 -m http.server 4187 --bind 127.0.0.1 --directory /private/tmp/harness-587-dist &
node docs/verification/2026-08-12-587-tool-card-provenance/harness/capture.mjs
# 完成后停止 4187 的 http server
```
