---
title: "#250 L2 真机证据 — ModelPickerInject 弹层锚定与 reskin 修复"
kind: verification
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-19
review_after: 2026-10-19
---

# #250 L2 真机证据 — ModelPickerInject 弹层锚定与 reskin(2026-07-19)

真机 Electron dev 取证(S48 视觉审计同款 CDP 形态:`--remote-debugging-port=9222` 裸 WebSocket,
`OPENCODE_TEST_ONBOARDING=1` 全隔离临时根,git 化种子项目 + 引擎 API 建会话,会话页 `mod+'` 开
native dialog-select-model)。对照基线 = S48 O1 取证
`docs/audits/2026-07-13-s48-req088-visual/43-o1-anchor-forensics.json`(修复前:`popperPositioners:0`、
`computedTf:none`,锚定全局静默失效)。

| 文件 | 内容 |
|---|---|
| `o1-session-picker-light.png` | 会话页 native picker(alpha 全接管):锚定到可见 `.a-chip-model`(弹层底边 = chip 顶 −8px、左对齐)+ reskin 完好(380 宽、原生 header/body 隐藏、搜索/账户 banner/代理分组/tier 徽/底部「添加自定义节点」全在) |
| `o1-session-picker-dark.png` | 同弹层,`data-color-scheme=dark`(审计同款切换;取证后已复原 light) |
| `o1-home-no-native-picker.png` | HOME 地面真相:本构建 AlphaHome 已完全替换上游 home,DOM 无任何上游 composer / model 组件(`o1-home-probe.json`),native dialog 在 home 不可开启 —— home 模型 chip 走 alpha 自建 ChipPopover(`ModelPickPop`,不经本票路径,不受影响) |
| `o1-session-forensics.json` | 修复后取证:`anchored.computedTf = matrix(1,0,0,1,788,-79)`(修复前 none)、`computedPos:fixed`、锚定元素底边 721 = chip 顶 729 − 8、左 788 ≈ chip 左 787.98;`dlgWidth:380`、picker 378×510 充满弹层无裁切 |
| `o1-nochip-guard.json` | 守卫分支(票面②):隐藏 chip + resize → `data-alpha-home-anchor` 被移除、positioner 回落上游默认定位(`position:relative`、`transform:none`、上游默认矩形);chip 恢复 → 锚定回位 |
| `o1-home-probe.json` | home DOM 探针:`upstreamComposer/upstreamNewComposer = []`、无 model 类 data-component,唯一模型按钮 = alpha `.a-chip-model` |

## 三点判定(票面「必须真机验证」)

1. **弹层正确锚定到 chip**:会话页(ComposerTakeover 在场 → 可见 alpha chip)mod+' 开 native
   picker,CSS 单键 `[data-alpha-home-anchor]` 命中(修复前双键 `[data-popper-positioner][…]`
   永不匹配):transform 生效,弹层底边钉在 chip 上方 8px、左对齐 —— 见
   `o1-session-forensics.json` + light/dark 截图。home 的 native 路径在本构建已不存在
   (`o1-home-probe.json`),home chip 走 alpha 自建弹层,与本票无关;锚定分支的语义已变为
   「有可见 chip 即钉其上」,会话页即其现役形态。
2. **无 chip 时不错误锚定**:守卫分支真机验证 —— chip 不可见时属性被移除,上游默认定位原样回落
   (`o1-nochip-guard.json`)。
3. **picker reskin 视觉完好**:380 宽、Kobalte 新增的原生 header(选择模型/连接提供商)与
   body(list/管理模型)按结构规则整体隐藏(原生 list 仍留 DOM 供程序化点选),Portal wrapper
   充满弹层(修复中发现 Portal 包一层无属性 div、且弹层被上游 512px 撑高裁切 footer —— 均已随
   CSS 一并修复),双主题完好。

注:上游 Kobalte 改版后弹层 DOM 全程 `popperPositioners:0`(与 S48 取证一致);JS 侧
`dlg.closest("[data-popper-positioner]") ?? dlg.parentElement` 兜底保留,实际命中 parentElement。
