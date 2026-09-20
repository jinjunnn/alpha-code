---
title: "#1353 发送被本机词表拦下时的输入框提示 —— 双主题视觉证据与逐项对照"
kind: verification
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-09-20
---

# #1353 「这条消息没有发出去」提示的视觉证据

alpha-code#1353(REQ-160 AC2 客户端侧)那条新提示的组件级视觉证据,对照的是已批增量帧
[`docs/design/2026-09-19-req160-send-blocked-notice/frame.html`](../../design/2026-09-19-req160-send-blocked-notice/frame.html)
(owner 2026-09-19 裁决:文案保留「内容安全审核」、用琥珀、定时自动化命中不弹提示)。

挂载**现役生产组件** `AlphaComposerRuntime`(首页与对话页是同一个组件)与现役生产 CSS,
`window.api.moderation.check` 是按状态给定的夹具。**提示不是画出来的**:harness 把文字打进
生产 textarea、按回车,由生产 `submit()` 置起 —— 走的就是用户那条路。loopback Vite 构建 +
Chrome `--headless=new` 截图;零 Electron、零账号 / API key、零前台窗口(与已批
`2026-09-17-1130-settings-tools-visuals` harness 同一模式)。

- 生产基线 commit:`e70aa48d6e48c070cf588ff5198f5849aeb22933`
- Chrome:`Google Chrome 153.0.8010.50`,采集时间 `2026-09-20T04:51:26.637Z`
- 逐帧完整 sha256 见 [`harness/capture-metadata.json`](harness/capture-metadata.json)
- 帧采自本 PR 的**工作树**;合入后以 PR 的 squash commit 为准(`harness/` 与 `capture.mjs` 的
  sha256 在 metadata 里,可据此判断被测源码是否与仓内一致)

## 每一帧都先自证它处在它自称的状态

`capture.mjs` 在截图**之前**读 `data-blocked-present`,与该状态的期望逐格比对,不等就抛错中止。
少了这一条,反向格会退化成「页面根本没渲染出来」而照样过 —— 那正是本仓
《断言的粒度不能比缺陷粗一格》点名的形态。下表 `blockedPresent` 一列是**实测读回值**。

## states

| state | 覆盖 |
| --- | --- |
| `session-blocked` | 对话页:同一段文字按下回车 → 本机词表命中 → 提示就地出现,正文原样留着 |
| `session-clean` | **反向格**:同一段文字、同一次发送,只是没命中 ⇒ 发出去了、槽里什么都没有 |
| `session-typed` | **版式对照组**:同一段文字留在输入框里、不按发送。用来证明窄宽下第二行被输入框自己截住,与本增量无关(见下方「已测量的既有行为」) |
| `home-blocked` | 首页:同一个组件、同一条提示(已批稿「同一个输入框,首页也一样」) |

## 帧清单(16 帧)

| state | theme | width | blockedPresent | file | sha256(前 16) |
| --- | --- | --- | --- | --- | --- |
| session-blocked | light | wide | `True` | [`session-blocked-light-wide.png`](shots/session-blocked-light-wide.png) | `f0d2efe5be1897d7…` |
| session-blocked | dark | wide | `True` | [`session-blocked-dark-wide.png`](shots/session-blocked-dark-wide.png) | `afb1af41efdc5572…` |
| session-blocked | light | narrow | `True` | [`session-blocked-light-narrow.png`](shots/session-blocked-light-narrow.png) | `989d27af537756a9…` |
| session-blocked | dark | narrow | `True` | [`session-blocked-dark-narrow.png`](shots/session-blocked-dark-narrow.png) | `a6132f4609fa2065…` |
| session-clean | light | wide | `False` | [`session-clean-light-wide.png`](shots/session-clean-light-wide.png) | `0ae0a4a4dd6dcf3b…` |
| session-clean | dark | wide | `False` | [`session-clean-dark-wide.png`](shots/session-clean-dark-wide.png) | `7c2633d16e1c0e8c…` |
| session-clean | light | narrow | `False` | [`session-clean-light-narrow.png`](shots/session-clean-light-narrow.png) | `cf44a4f39047c808…` |
| session-clean | dark | narrow | `False` | [`session-clean-dark-narrow.png`](shots/session-clean-dark-narrow.png) | `d997fb3db2442b63…` |
| session-typed | light | wide | `False` | [`session-typed-light-wide.png`](shots/session-typed-light-wide.png) | `ade4b6430381bf06…` |
| session-typed | dark | wide | `False` | [`session-typed-dark-wide.png`](shots/session-typed-dark-wide.png) | `d3135b4194f29659…` |
| session-typed | light | narrow | `False` | [`session-typed-light-narrow.png`](shots/session-typed-light-narrow.png) | `f194cb9f12115e06…` |
| session-typed | dark | narrow | `False` | [`session-typed-dark-narrow.png`](shots/session-typed-dark-narrow.png) | `4a83ad7a297e6e53…` |
| home-blocked | light | wide | `True` | [`home-blocked-light-wide.png`](shots/home-blocked-light-wide.png) | `c9ad4cc6ea8e5fd9…` |
| home-blocked | dark | wide | `True` | [`home-blocked-dark-wide.png`](shots/home-blocked-dark-wide.png) | `eaf2704ec0dd330a…` |
| home-blocked | light | narrow | `True` | [`home-blocked-light-narrow.png`](shots/home-blocked-light-narrow.png) | `c12ea4ab7f8de33e…` |
| home-blocked | dark | narrow | `True` | [`home-blocked-dark-narrow.png`](shots/home-blocked-dark-narrow.png) | `1ac6af9d532313bb…` |

## 与已批帧的逐项对照

已批稿 §3 的契约逐条对照,判据来自帧与实测:

| 契约项 | 帧要求 | 实现 | 结论 |
| --- | --- | --- | --- |
| 位置 | 文字区之下、工具栏之上,与既有三条同槽 | 实测 narrow:textarea `bottom=95` → 提示 `top=95,bottom=162` → 工具栏 `top=168` | 一致 |
| 形态 | 左侧 3px 琥珀细边 + `--a-warning-subtle` 底 + 两句文字,无图标 / 无按钮 / 无关闭叉 | `.a-comp-send-blocked` 逐值取自帧的 `.sb-notice`;组件测试断言该元素内 `button, a, input, [tabindex]` 计数为 0 | 一致 |
| 颜色 | 琥珀而非红 | 浅色 `#d97706` 边 + 琥珀底;深色随 token 走 | 一致(见 light / dark 两组帧) |
| 首页与对话页同一条 | 同一个组件 ⇒ 同一条提示 | `home-blocked` 与 `session-blocked` 两组帧同形 | 一致 |
| 窄宽 | 横向放不下时次句换行到第二行,两句都不截断 | `*-narrow` 四帧:事实句一行、说明句整句换到第二行 | 一致 |
| 出现 | 按下发送且命中的那一刻;不发给引擎;正文与附件原样留着 | 组件测试断言 `promptAsync` / `session.command` / `startChat` 零调用,textarea 值不变 | 一致 |
| 不出现 | 词表没同步下来或读不到 ⇒ 不拦也不提示 | `session-clean` 帧 + 组件测试两格(check 回 false / check 抛错) | 一致 |
| 读屏 | `role="alert"`,出现即播报两句全文 | 组件测试断言 `role` 与 `textContent` 等于两条 i18n 值的拼接 | 一致 |
| 键盘 | 不新增可聚焦元素,Tab 次序不变 | 同上,可聚焦元素计数 0 | 一致 |
| 判据钩子 | `data-alpha-composer-blocked`;反向用例 = 未命中时该元素不存在 | 帧的 `blockedPresent` 一列即该钩子的实测读回值 | 一致 |
| 文案 | 「这条消息没有发出去」/「没有通过内容安全审核。修改后可以重新发送。」 | `alpha.composer.sendBlocked` / `alpha.composer.sendBlockedWhy`,zh 与 en 逐字取自已批稿 §4 | 一致 |

## 已测量的既有行为(不是本增量引入,本票不改)

窄宽下那段两行的草稿,**第二行会被输入框自己截住**。实测两格(同一棵树、同一段文字):

| | textarea 高 | scrollHeight | 提示 |
| --- | --- | --- | --- |
| `session-blocked` | 54 | 65 | `top=95`(紧贴 textarea 底边,**无重叠**) |
| `session-typed`(对照组) | 54 | 65 | 不存在 |

两格逐字相同 ⇒ 截断来自 `.a-comp-input` 的 `min-height:54px` + 无 JS 自动长高(`rows="1"`),
与这条提示无关。**已如实回报,未顺手改** —— 改它要动输入框本体的高度策略,超出本票范围。

## harness 的已知局限(只影响看图,不影响判据)

工具栏的图标在 harness 里缺字形(「+」按钮不显示、chevron 画成实心三角、发送箭头是黑色)——
图标走应用壳的 sprite,本 harness 没挂。它们在本增量的改动面之外(提示条本身**没有图标**,
这是已批稿的裁决),逐项对照表里的每一条都不依赖它们。

## 怎么复跑

```
cd docs/verification/2026-09-20-1353-send-blocked-visuals/harness
../../../../packages/ui-mac/node_modules/.bin/vite --config vite.config.ts --port 4193 &
node capture.mjs
```
