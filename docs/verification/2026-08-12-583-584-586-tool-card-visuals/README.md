---
title: "#583/#584/#586 工具卡三形态视觉证据(list 目录网格 / grep 命中高亮 / websearch 富链接)"
kind: verification
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-08-13
---

# #583/#584/#586 工具卡三形态视觉证据

alpha-code#583(list 目录网格)、#584(grep 命中高亮)、#586(websearch 富链接)的
组件级视觉证据:各票主形态 × light / dark × narrow(460px)/ wide(1280px)。挂载
**现役生产组件** `SessionTimelineView` 与现役生产 CSS,loopback Vite 构建 + Chrome
`--headless=new` 截图;零 Electron、零账号/API key、零前台窗口(与已批
`2026-08-12-587-tool-card-provenance` harness 同一模式)。

7-24 的 `2026-07-24-req125-session-visual` G6/G7/G17 截图**不能再当 before/after**
(`#587` 已给每张卡加常驻来源徽标与折叠开发者详情)—— 本目录即三票的重出证据。

- 生产基线 commit:`9b0949ebdacae77fff70e6b8932ba226e897fc5a`
- Chrome:`151.0.7922.137`,采集时间 `2026-08-13T03:04:28Z`
- 逐帧完整 sha256 见 [`harness/capture-metadata.json`](harness/capture-metadata.json)

## states

| state | 票 | 覆盖 |
| --- | --- | --- |
| list | #583 | 目录网格(目录/文件分类图标、目录 accent 分色)+ 头部「共 N 项」计数徽标 + footer 计数;头部路径折叠 home 前缀(基线:不显示带用户名的 home 前缀) |
| grep | #584 | 展开体文件名(info 分色)/ 行号(tertiary)分行 + 命中字面量高亮(warning-subtle mark);头部「N 处命中」为 7-24 已有形态 |
| grep-hidden | #584 | 基线补的「已隐藏」态:路径 redactor 失败 ⇒ 整字段隐藏 + 常驻「详情已隐藏」确定标记(对照帧无此态,按 2026-08-09 基线新增) |
| websearch | #586 | 富链接行:16px 字母徽(**非 favicon**,零远端请求)+ 宿主允许的标题 + 域名;头部「N 条结果」(供应商名不在基线白名单,不显示) |
| all | 三票 | 三卡同帧合影(list 与 grep 间隔 websearch,避开「已探索」折叠成组) |

## 帧清单(20 帧)

| state | theme | width | file | sha256(前 16) |
| --- | --- | --- | --- | --- |
| list | light | narrow | [`list-light-narrow.png`](shots/list-light-narrow.png) | `94facd7b6ee2f716…` |
| list | dark | narrow | [`list-dark-narrow.png`](shots/list-dark-narrow.png) | `ccdd84298213b6fb…` |
| grep | light | narrow | [`grep-light-narrow.png`](shots/grep-light-narrow.png) | `904cce1b079d4be6…` |
| grep | dark | narrow | [`grep-dark-narrow.png`](shots/grep-dark-narrow.png) | `3e8e054ac96fc1e9…` |
| grep-hidden | light | narrow | [`grep-hidden-light-narrow.png`](shots/grep-hidden-light-narrow.png) | `cebd8a78002020b0…` |
| grep-hidden | dark | narrow | [`grep-hidden-dark-narrow.png`](shots/grep-hidden-dark-narrow.png) | `bb0b416587472100…` |
| websearch | light | narrow | [`websearch-light-narrow.png`](shots/websearch-light-narrow.png) | `a317b0763213580e…` |
| websearch | dark | narrow | [`websearch-dark-narrow.png`](shots/websearch-dark-narrow.png) | `8ce365b7ead18f31…` |
| all | light | narrow | [`all-light-narrow.png`](shots/all-light-narrow.png) | `d49ebd8ec7b71556…` |
| all | dark | narrow | [`all-dark-narrow.png`](shots/all-dark-narrow.png) | `3271a03eb876e8e6…` |
| list | light | wide | [`list-light-wide.png`](shots/list-light-wide.png) | `500ae9062a2a6172…` |
| list | dark | wide | [`list-dark-wide.png`](shots/list-dark-wide.png) | `cbc488800095b0fe…` |
| grep | light | wide | [`grep-light-wide.png`](shots/grep-light-wide.png) | `fd78cda49e405a00…` |
| grep | dark | wide | [`grep-dark-wide.png`](shots/grep-dark-wide.png) | `2d248c5d47e7523d…` |
| grep-hidden | light | wide | [`grep-hidden-light-wide.png`](shots/grep-hidden-light-wide.png) | `fc48d4792e52db5a…` |
| grep-hidden | dark | wide | [`grep-hidden-dark-wide.png`](shots/grep-hidden-dark-wide.png) | `3d4027f5108c12a3…` |
| websearch | light | wide | [`websearch-light-wide.png`](shots/websearch-light-wide.png) | `c090a6b348a5f280…` |
| websearch | dark | wide | [`websearch-dark-wide.png`](shots/websearch-dark-wide.png) | `3333fe7d2edf942e…` |
| all | light | wide | [`all-light-wide.png`](shots/all-light-wide.png) | `2f1a1faa590742fc…` |
| all | dark | wide | [`all-dark-wide.png`](shots/all-dark-wide.png) | `73a90e3d26af7f9c…` |

## 与对照帧的三处已裁决偏差(以 2026-08-09 基线与对帧订正为准)

1. **list 头部**不显示 `~/app/kama-bot-local` 之外的任何 home 变体;帧里的路径写法与
   `#587` 常驻来源徽标以今天代码为准。
2. **grep** 新增「已隐藏」态(对照帧没有):redactor 失败 ⇒ 整字段隐藏 + 确定标记。
3. **websearch** 帧里 `.fav` 按字母徽落地(非 favicon);头部不显示供应商名
   (`Exa · 3 条` 不落地),只出「N 条结果」。

## 复现

```bash
cd docs/verification/2026-08-12-583-584-586-tool-card-visuals/harness
../../../../packages/ui-mac/node_modules/.bin/vite --port 4189 --strictPort &
node capture.mjs
```
