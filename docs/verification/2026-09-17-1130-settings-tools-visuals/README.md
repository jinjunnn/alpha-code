---
title: "#1130 设置「工具」节六态视觉证据(四来源分组 / 服务变更 / 策略文件损坏 / 保存失败 / 加载中 / 读取失败)"
kind: verification
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-09-17
---

# #1130 设置「工具」节六态视觉证据

alpha-code#1130(REQ-131)Settings「工具」节的组件级视觉证据:已批设计稿
[`docs/design/2026-08-25-req131-settings-tool-policy/frame.html`](../../design/2026-08-25-req131-settings-tool-policy/frame.html)
的六个状态 × light / dark × narrow(760px,触发 `settings.css` 的 840px 断点)/ wide(1280px)。
挂载**现役生产组件** `AlphaSettings`(整页 overlay 含类别导航,`api.toolPolicy` 为按状态给定的夹具)
与现役生产 CSS,loopback Vite 构建 + Chrome `--headless=new` 截图;零 Electron、零账号/API key、
零前台窗口(与已批 `2026-08-12-583-584-586-tool-card-visuals` harness 同一模式)。

- 生产基线 commit:`2509364f9b195aff48adc8e9e5854bcb231ea7d3`
- Chrome:`Google Chrome 152.0.7977.83`,采集时间 `2026-09-17T09:06:11.031Z`
- 逐帧完整 sha256 见 [`harness/capture-metadata.json`](harness/capture-metadata.json)
- 帧采自本 PR 的**工作树**:上面的基线 commit 是 `origin/alpha` 的 HEAD,叠加了本 PR 尚未提交的改动;合入后以 PR 的 squash commit 为准(`harness/` 与 `capture.mjs` 的 sha256 在 metadata 里,可据此判断被测源码是否与仓内一致)。

## states

| state | 帧 | 覆盖 |
| --- | --- | --- |
| default | 默认 · 展开与继承 | 四组(本地工具平铺 / 云端工具「已核验」/ 第三方 MCP 服务可展开 / 插件)、整类三态、行内「生效:状态 · 原因」、用户 override 选中 + ↺、锁定行(套餐 / 设备管理)、「新发现」「计费」徽标、服务层「启用」的行内确认条(fetcher)、开发者详情折叠、「N 项注册身份无法核验」只读提示、脚注 |
| rebind | 服务变更 · 回到询问 | context7 服务行「服务已变更」徽标 + 说明 + 「重新启用」/ ↺;service 层失效的工具行只显示原因;tool 层失效的 get-library-docs 行自己给「重新启用」 |
| quarantine | 策略文件损坏 | 整节 `role=alert` 横幅接管焦点 + 「重置为安全默认」+ 备份说明;全部行「生效:已停用 · 设置文件待恢复」、控件锁定、整节淡显 |
| savefail | 保存失败 | resolve-library-id 行点「询问」被拒 ⇒ 控件仍是权威值(无选中)+ 行内 `role=alert`「这项更改没有保存」+ 重试,焦点接管 |
| loading | 加载中 | `aria-busy` 骨架 + 「正在读取工具列表…」 |
| loadfail | 读取失败 | fail-closed 文案(读不到清单时不放宽任何工具)+ 重试 |

## 帧清单(24 帧)

| state | theme | width | file | sha256(前 16) |
| --- | --- | --- | --- | --- |
| default | light | narrow | [`default-light-narrow.png`](shots/default-light-narrow.png) | `2dbe8c74caf07dc6…` |
| default | dark | narrow | [`default-dark-narrow.png`](shots/default-dark-narrow.png) | `6e668f4f5864e86d…` |
| rebind | light | narrow | [`rebind-light-narrow.png`](shots/rebind-light-narrow.png) | `d0e498499f380fbe…` |
| rebind | dark | narrow | [`rebind-dark-narrow.png`](shots/rebind-dark-narrow.png) | `cf3d32ac7552b6bb…` |
| quarantine | light | narrow | [`quarantine-light-narrow.png`](shots/quarantine-light-narrow.png) | `ffc9e9b6bc694797…` |
| quarantine | dark | narrow | [`quarantine-dark-narrow.png`](shots/quarantine-dark-narrow.png) | `1cbf29ba85ab3a88…` |
| savefail | light | narrow | [`savefail-light-narrow.png`](shots/savefail-light-narrow.png) | `5a41a60f3f29e5d5…` |
| savefail | dark | narrow | [`savefail-dark-narrow.png`](shots/savefail-dark-narrow.png) | `7774e45446c51d4e…` |
| loading | light | narrow | [`loading-light-narrow.png`](shots/loading-light-narrow.png) | `6cd3f3be62d31381…` |
| loading | dark | narrow | [`loading-dark-narrow.png`](shots/loading-dark-narrow.png) | `cdac41130e8af728…` |
| loadfail | light | narrow | [`loadfail-light-narrow.png`](shots/loadfail-light-narrow.png) | `183a8b3c4a7a5814…` |
| loadfail | dark | narrow | [`loadfail-dark-narrow.png`](shots/loadfail-dark-narrow.png) | `79742f04703621cb…` |
| default | light | wide | [`default-light-wide.png`](shots/default-light-wide.png) | `0313ccd64d9b9404…` |
| default | dark | wide | [`default-dark-wide.png`](shots/default-dark-wide.png) | `4d9039e063505202…` |
| rebind | light | wide | [`rebind-light-wide.png`](shots/rebind-light-wide.png) | `769ff11e465ad8bc…` |
| rebind | dark | wide | [`rebind-dark-wide.png`](shots/rebind-dark-wide.png) | `26a5c12e2f1ddacc…` |
| quarantine | light | wide | [`quarantine-light-wide.png`](shots/quarantine-light-wide.png) | `77fe82144a7e06be…` |
| quarantine | dark | wide | [`quarantine-dark-wide.png`](shots/quarantine-dark-wide.png) | `2657a3da6a879ffa…` |
| savefail | light | wide | [`savefail-light-wide.png`](shots/savefail-light-wide.png) | `951e003ce888589d…` |
| savefail | dark | wide | [`savefail-dark-wide.png`](shots/savefail-dark-wide.png) | `afda04d725630bb2…` |
| loading | light | wide | [`loading-light-wide.png`](shots/loading-light-wide.png) | `eaa747fe8d8a4eba…` |
| loading | dark | wide | [`loading-dark-wide.png`](shots/loading-dark-wide.png) | `09155a0f066e06a1…` |
| loadfail | light | wide | [`loadfail-light-wide.png`](shots/loadfail-light-wide.png) | `85bd6b8d1f5fbfd3…` |
| loadfail | dark | wide | [`loadfail-dark-wide.png`](shots/loadfail-dark-wide.png) | `63c90e591e177e60…` |

## 与已批帧的已裁决偏差(实现方默认值,可回滚;均已写进 PR 正文)

1. **工具行名称**显示引擎 `identity.name` 原文(`read` / `bash` / `resolve-library-id`),不是帧里的
   中文专名(读取文件 / 终端命令)—— 设计稿 §3 明写「专名映射归 REQ-125 展示规则」,本仓今天没有
   这张映射表,不在本票造第二份名单。
2. **Alpha Cloud 组**按数据模型渲染成「服务行(带已核验徽标)→ 展开到工具」,帧里是工具平铺;
   inventory 的 alpha-cloud 类同样是 `(source, origin)` 分服务,平铺会丢掉 service 层的三态与 digest。
3. **「N 项注册身份无法核验」提示**放在整节末尾而不是某个服务的展开区末尾 —— `invalid.entries[]`
   只有 technicalId,映射不回具体服务;原因归开发者详情(owner Q1 裁决原样)。
4. 新增一个帧外没有的状态:**没有项目目录**(在首页打开设置)⇒ 「先打开一个项目」,不向引擎发请求。
   策略按 (账户, 项目) 分区是 #1128 的数据模型,首页没有项目可分区。
5. 帧里的组名「Alpha Cloud」落地为「云端工具 / Cloud tools」—— REQ-139(ac#1198)的品牌残留闸对 en/zh/zht
   全部文案零 allowlist 地禁止独立词 `Alpha`,与本仓其余云端文案(「云端能力」「云端执行」)同一叫法。
   服务行仍显示引擎 origin 原文(夹具里是 `alpha-cloud`,技术标识不是文案)。
6. 三态 radiogroup 的键盘:方向键(→↓ / ←↑)只在组内移动焦点、**不写入**,空格 / 回车才提交 ——
   与帧外说明「左右键切换、空格确认」一致;移动走本仓唯一的 `alpha-ui/roving-focus.ts`(C21 AC2 棘轮),
   提交走原生 `<button>` 的 click。R1 审计前曾按 APG「移动即选中」实现,已改回帧的语义
   (那是放宽权限的路径,方向键不该在无确认下改动长期策略)。

## 复现

```bash
cd docs/verification/2026-09-17-1130-settings-tools-visuals/harness
../../../../packages/ui-mac/node_modules/.bin/vite --port 4191 --strictPort &
node capture.mjs
```
