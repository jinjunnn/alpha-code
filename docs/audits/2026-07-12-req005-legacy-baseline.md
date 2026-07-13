# 2026-07-12 · REQ-005 前端接管收尾核验 — legacy characterization baseline

> **时点声明(append-only)**:本档为 2026-07-12 对冻结基线 **frontend-freeze-base-2**
> (`42f14c6b36d39d99a345ff3459a56b8b5f930ac9`,2026-07-12 17:59 +0800,ADR-020)的一次性
> 静态核对记录。所有 file:line 均指该基线下的工作树
> (分支 `feat/180-183-184-product-ownership-s41`)。后续变化不改写本档,只在文末追加。
>
> - 需求:[REQ-005](https://github.com/jinjunnn/alpha-code/blob/3024732c1e8cbc541df67abeea1f5d7693867023/docs/requirements/REQ-005-frontend-takeover-closeout.md) ·
>   Issue [jinjunnn/alpha-code#214](https://github.com/jinjunnn/alpha-code/issues/214)
> - 用途:本档是 **REQ-087 LegacySessionAdapter spike 的声明输入**
>   ([REQ-087](https://github.com/jinjunnn/alpha-code/blob/3024732c1e8cbc541df67abeea1f5d7693867023/docs/requirements/REQ-087-legacy-session-adapter-spike.md) 交付物①「依赖拓扑清单」
>   的 timeline/diff/terminal/permission 部分)。
> - 范围校正(REQ-005 2026-07-10 批注):本档只建立 characterization baseline,
>   **不代表页面/路由/运行时所有权完成**;不新增任何 selector/observer/Portal。
> - 证据类型:纯代码证据(alpha CSS/TSX ↔ 冻结上游源逐条比对 + REQ-012 锚点契约测试)。
>   真机截图证据见 §5(由 orchestrator 后补,本次不伪造)。

## 0. 方法与证据基础

1. 锚点机器红线:`packages/ui-mac/src/renderer/alpha-ui/upstream-anchors.json`(REQ-012,
   由 `packages/ui-mac/scripts/gen-upstream-anchors.ts` 生成)当前 alive=176、knownDead=6;
   `upstream-anchors.test.ts` 本次运行 5 pass / 0 fail(见 §6 验证记录)。
2. 逐锚点上游 file:line 映射:对 `timeline-reskin.css` + `timeline/*.css` + `composer-reskin.css`
   等 alpha CSS 抽取全部 `data-*` / class / id 锚点,在冻结的 `packages/{ui,app}/src` 逐个定位
   渲染点(方法同 anchor-audit.ts,另加 class/id/data-kind 等测试不覆盖的锚点)。
3. 包归属澄清:`packages/session-ui` 存在同源组件平行拷贝,但 `packages/app` 实际 import 的是
   `@opencode-ai/ui`(`packages/app/src/pages/session/timeline/message-timeline.tsx:19-55`、
   `packages/app/src/pages/session/composer/session-permission-dock.tsx:4`)。本档引用一律指
   `packages/ui` / `packages/app`。

### 0.1 已知锚点清单勘误(诚实项)

- `knownDead` 中的 `component:session-composer` / `component:session-new-composer` 是
  **假死(检测器局限)**:上游以三元字面量渲染
  `data-component={newSession() ? "session-new-composer" : "session-composer"}`
  (`packages/app/src/components/prompt-input.tsx:1517`),anchor-audit.ts 的字面量匹配
  (`packages/ui-mac/src/renderer/alpha-ui/anchor-audit.ts:70-77`,局限自述见 :11)匹配不到该
  形态。运行时 DOM **确实渲染**该锚点——但仅当 `newLayoutDesigns` 打开
  (`prompt-input.tsx:1514` 的 `<Match when={props.controls.newLayoutDesigns}>`;fallback 分支
  `prompt-input.tsx:1688-1697` 的 DockShellForm **无任何 data-component**)。该设置默认值
  `= channel !== "prod"`(`packages/app/src/context/settings.tsx:55`),alpha 在主进程种子为 true
  (`packages/ui-mac/src/main/alpha-defaults.ts:43-47`)——composer 接管的存活依赖这个种子,
  是 REQ-087 必须知道的隐性前置。
- `knownDead` 其余四项(`action:allow`、`action:deny`、`slot:button`、`slot:icon-button`)
  核实为真死:冻结源中无渲染点(权限响应按钮现为普通 `<Button onClick>`,
  `session-permission-dock.tsx:37-49`,无 data-action)。引用它们的 alpha 规则
  (如 `composer-reskin.css:82-93` 的 `[data-slot="icon-button"]`/`[data-slot="button"]` hover)
  当前为惰性规则(不生效、无害),属 REQ-010 重接线清单。

---

## 1. 重型引擎换肤完成度矩阵(REQ-005 AC#1 · 代码证据部分)

> 判定口径:**完成** = 该表面有 alpha 规则且锚点在冻结源可定位;**部分** = 有覆盖但存在
> 未换肤子面/接受的引擎边界;**缺口** = 无 alpha 覆盖或无稳定接缝可挂。
> 「真机截图取证」列全部待 §5 后补,本表不含视觉判断。

### 1.1 终端(ghostty-web) — 总判定:部分

| # | 上游表面 | 上游锚点/源 | alpha 覆盖 | 判定 |
|---|---------|------------|-----------|------|
| T1 | 终端容器外框 | `[data-component=terminal]` `packages/app/src/components/terminal.tsx:654` | `timeline/review.css:311-314`(TL-39:border + radius,frame-only) | 完成(按 TL-39 设计范围) |
| T2 | ghostty 内核(canvas 渲染、字体、光标) | `ghostty-web` 引擎,`terminal.tsx:31-42` 动态加载;主题色由上游 theme 解析 `terminal.tsx:230-249`(`resolveThemeVariant` → `text-stronger`/`background-stronger`) | 无 alpha 规则(ENGINE 不重写,ADR-016 决策②);颜色跟随上游 theme 而非 `--a-*` tokens,一致性依赖 settings-reskin 锁皮(`settings-reskin.css:1-7` 隐藏换肤入口) | 部分(接受的引擎边界,需截图确认观感) |
| T3 | 终端面板 chrome(tab 条、新建/关闭按钮、面板头) | `packages/app/src/pages/session/terminal-panel.tsx:198-208`(仅 `id="terminal-panel"` + aria;**全文件无任何 data-component/data-slot**,按钮均为 Tailwind 裸类) | 无 alpha 规则;CSS-only 无稳定接缝可挂(REQ-005 非目标禁止新增 selector/inject) | 缺口(登记,处置归 REQ-088 结构接管) |
| T4 | 终端 header bar(设计稿有) | 上游不渲染 header DOM(`timeline/review.css:308-309` 已记录) | 无(需 inject,禁止新增) | 缺口(已知,TL-39 输出 FLAG 原样) |

结构性接管遗留(终端):**无**(纯 CSS 外框;无 Portal/observer/隐藏控件点击)。

### 1.2 diff · 代码视图 — 总判定:部分

| # | 上游表面 | 上游锚点/源 | alpha 覆盖 | 判定 |
|---|---------|------------|-----------|------|
| D1 | edit/write 工具卡(内联 diff 折叠 → 紧凑卡) | `[data-component=edit-tool/write-tool/edit-content/write-content]` `packages/ui/src/components/message-part.tsx:1998/2065/2037/2093` | `timeline-reskin.css:97-114`(隐藏内联 diff + 压扁空壳);卡头 `timeline/tools.css:186-218`(TL-21) | 完成 |
| D2 | apply_patch 多文件 diff(头行/徽标) | `[data-scope=apply-patch]` `message-part.tsx:1342`,change 标签 :2200 | `timeline/tools.css:220-261`(TL-23)+ 徽标 TL-22 `tools.css:4-22` | 完成 |
| D3 | 本回合改动汇总卡 | `[data-component=session-turn-diffs-group]` `packages/ui/src/components/session-turn.tsx:438`(app 侧 `message-timeline.tsx:156`) | `timeline/structure.css:39-129`(TL-32;内联展开禁用 :91-93,「在面板打开」pill 由 inject 加) | 完成 |
| D4 | 审查面板壳/头/tab/统一拆分/select/文件行 | `session-review.tsx:340-564`、`#review-panel` `session-side-panel.tsx:218`、tabs/radio-group/select(见 timeline-reskin.css 头部清单 review 段) | `timeline/review.css:23-303`(TL-35..38,2026-06-28 CDP 实证过) | 完成 |
| D5 | diff 引擎内部(hunk、行号、语法色、选区) | `@pierre/diffs`:`packages/ui/src/components/file.tsx:19-20`,渲染在 **Shadow DOM** 内(`packages/ui/src/pierre/file-runtime.ts:23`);配色走 `--diffs-*` 变量(`packages/ui/src/pierre/index.ts:17-70`)继承上游 theme tokens | 无 alpha 规则;外部 CSS 结构上不可达(Shadow DOM),仅自定义属性穿透 | 部分(接受的引擎边界;alpha 未提供 `--diffs-*` 覆写) |
| D6 | 审查面板 diff 包装层(placeholder / large-diff 提示) | `data-slot=session-review-diff-wrapper/-placeholder/-large-diff*` `session-review.tsx:574-601` | 无 alpha 规则 | 缺口(轻;裸样式) |
| D7 | 文件查看器(file tab 打开的代码视图) | `[data-component=file][data-mode=text]` `packages/ui/src/components/file.tsx:666-668`,同 @pierre 引擎;file-tabs `packages/app/src/pages/session/file-tabs.tsx` | 无 alpha 规则(alpha CSS 无 `[data-component=file]` 引用) | 缺口(代码视图整面未换肤) |
| D8 | markdown 代码块(时间线内 shiki 高亮) | `[data-component=markdown-code]` `packages/ui/src/components/markdown.tsx:257`(worker: `markdown-shiki.worker.ts`) | 外壳+复制按钮 `timeline/assistant.css:203-241`(TL-10)、`timeline-reskin.css:237-254`;语法配色跟随上游 theme | 部分(外壳完成,token 色未 alpha 化) |

结构性接管遗留(diff):`timeline-inject.tsx:139-166`(edit/write 卡「在面板打开」pill)与
`:168-188`(TL-32 pill)通过**点击隐藏控件**打开审查面板 —— 查找
`[aria-controls="review-panel"]` 按钮(上游 `session-header.tsx:472`)并 `btn.click()`
(`timeline-inject.tsx:143-147`)。文件级聚焦(`view().review.openPath`,
`packages/app/src/context/layout.tsx:840-858`)从 DOM 层不可达,pill 只能开面板不能定位文件
(inject 注释 :140-142 已自述)。

### 1.3 权限流(permission dock) — 总判定:部分

| # | 上游表面 | 上游锚点/源 | alpha 覆盖 | 判定 |
|---|---------|------------|-----------|------|
| P1 | 权限卡壳(amber 警示卡) | `[data-component=dock-prompt][data-kind=permission]` `packages/ui/src/components/dock-prompt.tsx:15` + `[data-dock-surface=shell]` `dock-surface.tsx:11` | `composer-reskin.css:186-193` | 完成 |
| P2 | 图标/标题/patterns 代码块 | `data-slot=permission-icon/-header-title/-patterns` `packages/app/src/pages/session/composer/session-permission-dock.tsx:27/30/65` | `composer-reskin.css:194-208` | 完成 |
| P3 | 「允许一次」主按钮 | `[data-component=button][data-variant=primary]` `packages/ui/src/components/button.tsx:18` | `composer-reskin.css:209-216` | 完成 |
| P4 | 「拒绝」「总是允许」按钮(ghost/secondary) | `session-permission-dock.tsx:37-47` | 无 permission 作用域规则,落上游默认样式 | 部分 |
| P5 | permission-row/-spacer/-hint(工具描述行) | `session-permission-dock.tsx:26/56-59` | 无 alpha 规则 | 缺口(轻;hint 行裸样式) |
| P6 | 问题卡(question dock,同 DockPrompt 引擎) | `[data-kind=question]` `dock-prompt.tsx:15`,`session-question-dock.tsx` | **完全无 alpha 规则**(alpha CSS 只写了 `data-kind=permission` 作用域) | 缺口 |
| P7 | 权限快捷键 | 上游即无(全仓无 allow/deny keybind;dock-prompt 的 `onKeyDown` prop 权限卡未传,`dock-prompt.tsx:10/15`) | 不适用 | 不适用(记录:非 alpha 缺口) |

结构性接管遗留(权限流):**无**(纯 CSS;dock 未被 Portal/observer 触碰)。
注意旧 `action:allow/deny` 锚点已死(§0.1),权限按钮当前**没有语义化 data-action**,
适配层若需程序化响应只能走 SDK(`session-composer-state.ts:75-90`),不能走 DOM。

### 1.4 矩阵小结

| 引擎 | 完成 | 部分 | 缺口 | 总判定 |
|------|------|------|------|--------|
| 终端 ghostty-web | 1 (T1) | 1 (T2) | 2 (T3,T4) | 部分 |
| diff·代码视图 | 4 (D1-D4) | 2 (D5,D8) | 2 (D6,D7) | 部分 |
| 权限流 | 3 (P1-P3) | 1 (P4) | 2 (P5,P6) | 部分 |

三件均无一「整面缺口」,也无一「全绿」——与 ADR-016 决策②「复用 + 重新换肤」的实际执行
一致:**卡壳/面板层已 alpha 化,引擎内核(ghostty canvas、@pierre Shadow DOM、shiki token)
按决策保留上游**,外加 6 条可回写 Issue 的具体缺口(T3、T4、D6、D7、P5、P6)。

---

## 2. timeline-reskin.css COUPLING 清单更新(dev-plan §7 第 2 项)

已完成,落点:`packages/ui-mac/src/renderer/alpha-ui/timeline-reskin.css:1-157`(头注)。

- **范围**:入口文件 + `timeline/{user,assistant,tools,structure,review,misc}.css` 六个 partial
  的全部上游锚点(约 40 组 / 170+ 个独立锚点),逐条给出上游渲染点 file:line;并列出 inject
  侧只读锚点与 alpha 自有类(防混淆)。
- **核对方法**:脚本化抽取 CSS 内全部 `data-*`/class/id 锚点 → 冻结源逐条定位(§0 方法 2);
  与 REQ-012 清单交叉:**timeline bundle 内零死锚点**(全部可定位到冻结源渲染点)。
- **冻结语义变化(已写进头注)**:packages/{app,ui} 冻结后,上游选择器只会在 re-freeze
  (基线换 tag)时变化 —— 清单从「每加一组选择器就补登」(dev-plan §1 第 4 条的旧维护法)
  改为「**re-freeze/上游 sync 时整体重核一次**」,日常以 upstream-anchors.test.ts 红灯为信号。
- **写法约定**:头注内锚点一律用不带引号的 `[data-x=y]` 形式,避免被 anchor-audit.ts 的
  字面量抽取误读为新引用(该抽取器只匹配带引号形态,`anchor-audit.ts:19`)。
- **最脆弱两条**(头注已标):`session-todo-dock` 内的 `[class*=pb-11]` 与 `[data-state]`
  (Tailwind/Kobalte 内部锚,`timeline/tools.css:289-293`),re-freeze 时优先重核。
- CSS 规则本体零改动(仅头注更新;见本次 diff)。

---

## 3. Legacy 依赖清单(REQ-005 AC#4 → REQ-087 交付物①输入)

> 口径:每面列 ①私有 context(provider + 挂载点)②滚动状态 ③焦点管理 ④layout 交接
> ⑤persist key ⑥alpha 现触 DOM anchor。provider 总拓扑先行:

**Provider 拓扑(冻结源,`packages/app/src/app.tsx`)**
- 全局壳 `AppBaseProviders`(app.tsx:303-336):Meta → Theme → Language → Query →
  WslServers → **DialogProvider**(:322)→ Marked → **FileComponentProvider component={File}**
  (:325,diff 引擎注入点)。
- 共享壳 `SharedProviders`(app.tsx:252-261):**SettingsProvider**(:254)→
  **CommandProvider**(:256)→ Highlights。
- server 域 `ServerScopedShell`(app.tsx:266-278):**PermissionProvider**(:268)→
  **LayoutProvider**(:269)→ Notification → Models → `Layout`(:272,视觉壳)。
  server SDK/sync:**ServerSDKProvider + ServerSyncProvider**(app.tsx:120-124)。
- directory 域(`packages/app/src/pages/directory-layout.tsx:89-91`):**SDKProvider** →
  `DirectoryDataProvider`(:13,内含 ui DataProvider + **LocalProvider** :44)。
- session 域 `SessionProviders`(app.tsx:280-289):**TerminalProvider**(:282)→
  **FileProvider**(:283)→ **PromptProvider**(:284)→ **CommentsProvider**(:285)。
- `useSync` 非独立 provider:由 ServerSync × SDK 合成
  (`packages/app/src/context/sync.tsx:112-117`)。

### 3.1 timeline(会话时间线)

- **私有 context**:session 页一次性消费 19 个 hook(`packages/app/src/pages/session.tsx:80-98`:
  useServerSync/useLayout/useLocal/useFile/useSync/useQueryClient/useDialog/useLanguage/useSDK/
  useServerSDK/useSettings/usePlatform/usePrompt/useComments/useTerminal/useServer/
  useSearchParams/useLocation/useSessionLayout);另 useSessionCommands(:749)、
  useSessionHashScroll(:1469)。MessageTimeline 渲染于 session.tsx:1644-1679
  (`<Show keyed>` :1642,**无 keep-alive/多实例**——切会话即重挂;跨会话只缓存测量
  `timelineCache` in-memory Map,`message-timeline.tsx:85`,cap 16,写回 :539-541)。
- **滚动状态**:`props.scroll = {overflow,bottom,jump}`(`message-timeline.tsx:237`),owner 在
  session.tsx(store `ui.scroll` :116-120;计算 `updateScrollState` :1059-1068;调度 :1070-1083);
  虚拟化 = TanStack `createVirtualizer` 尾锚(`message-timeline.tsx:418-454`,`anchorTo:"end"`
  :440);`onResumeScroll` → session.tsx `resumeScroll` :1085-1093。**滚动位置不持久化**
  (挂载恒回底,`maybeAnchorBottom` :509-524);持久化滚动只存在于 review/file tab(§3.2)。
  回到底部按钮 `message-timeline.tsx:1240-1261` **无任何 data 钩子**(TL-40 结论成立)。
- **焦点管理**:type-to-focus(session.tsx:691-694)、Escape blur(:674-677)、
  `focusInput()`(:744-747);`[data-prevent-autofocus]` 区域豁免(:663/:668;设置方:
  terminal.tsx:655 等)。
- **layout 交接**:`handoff.ts` 为**内存 LRU**(`packages/app/src/pages/session/handoff.ts:8-23`,
  cap 40):prompt 预览跨路由交接(写 `session-composer-region.tsx:150`,读 :130/:272);
  tabs 交接另走 `layout.handoff.tabs`(layout.tsx:572-581,消费 session.tsx:134-158,60s TTL)。
- **persist key**:layout 单 blob `Persist.serverGlobal(scope,"layout",["layout.v6"])`
  (`packages/app/src/context/layout.tsx:249`,落 `opencode.global.dat`,persist.ts:480-482;
  内含 sessionView/sessionTabs/sidebar/terminal/review/fileTree);会话级 GC 键
  `SESSION_STATE_KEYS = prompt(v2)/terminal(v1)/file-view(v1)`(layout.tsx:294-298);
  followup 队列 `workspace:followup`(session.tsx:268-269,legacy `followup.v1`)。
- **alpha 现触 DOM anchor**:`timeline-inject.tsx` —— 读
  `[data-component=tool-trigger/context-tool-group-trigger/tool-output/session-turn-diffs-group/
  session-turn/user-message]`(scan :376-386)、`[data-message-id]`/`[data-timeline-part-id]`
  (:320-321;上游 message-timeline.tsx:1010-1011 / message-part.tsx:1131)、
  `[data-slash-id]`(:259/:402;上游 slash-popover.tsx:104)、
  `[data-action=prompt-submit]`(:411);写:`.a-tc-ico/.a-openp/.a-dirgrid/.a-cmd-chip/
  .a-exit/.a-turn-div` + `[data-alpha-*]` 幂等标记;全局 MutationObserver(:416-417)+
  capture 级 keydown/click(:418-419)。localStorage 私有键:`alpha-cmd:<messageID>`
  (:229-240,斜杠 chip 折叠持久化)。
- **composer 接管(timeline 同屏依赖)**:`composer-takeover.tsx` —— 选择器
  `[data-component=session-composer]`(:20),Portal 进自建 host(:33-41,:98-108),
  body 标记 `data-alpha-composer-takeover` → 上游 composer `display:none`
  (`alpha-composer.css:255-258`);收养上游 progress-circle 按钮(:60-73);
  存活前置 = `newLayoutDesigns` 种子(§0.1)。

### 3.2 diff · file viewer(审查面板/文件查看)

- **私有 context**:FileComponentProvider(app.tsx:325)注入 `File`;SessionReview 经
  `useFileComponent()` 取引擎(`packages/ui/src/components/session-review.tsx:12,169`);
  面板开关 = LayoutProvider 的 `view().reviewPanel.opened/toggle`
  (`layout.tsx:811-822`,底层 `store.review.panelOpened` :754/:769-777,**全局非按会话**);
  文件展开集 = `view().review.open/openPath/closePath`(layout.tsx:823-886,按 sessionKey)。
  diff 数据:`reviewDiffs()`(session.tsx:362-366,git/branch VCS query 或 `turnDiffs()`),
  经 session.tsx:842-878 → `SessionReviewTab`(review-tab.tsx:46-171)→ SessionReview。
  文件聚焦 API:`focusReviewDiff(path)`(session.tsx:926-930)。
- **滚动状态**:review tab 滚动经 `view().scroll("review")/setScroll`(review-tab.tsx:80-118),
  由 `createScrollPersistence` 内存缓存(layout-scroll.ts:16-126)flush 进 layout blob
  (layout.tsx:362-373)→ **持久化**(`layout.v6`);diff 内部滚动由 @pierre 虚拟化
  (`pierre/virtualizer.ts`)管理,不持久。
- **焦点管理**:`[data-prevent-autofocus]` 由 pierre find-bar 等设置(ui/pierre/file-find.ts:21、
  line-comment.tsx:59);面板关闭后焦点回 composer 走 session.tsx type-to-focus(无专用 effect)。
- **layout 交接**:选中行区间经 handoff `{files}`(session-side-panel.tsx:197 写,
  file-tabs.tsx:207 读)。
- **persist key**:并入 `layout.v6` blob(reviewOpen/scroll,layout.tsx:59-65);
  file tab 会话态 GC 键 `file-view`(layout.tsx:296)。
- **alpha 现触 DOM anchor**:CSS 侧见 timeline-reskin.css 头注 review 段;JS 侧仅
  timeline-inject 的 `[aria-controls="review-panel"]` 隐藏控件点击(:143-147;§1.2)。
- **引擎边界**:`File`(file.tsx:666-668)= @pierre/diffs,Shadow DOM(file-runtime.ts:23),
  worker 池(pierre/worker.ts);adapter 不可能从 DOM 层拿到 diff 语义,必须走
  `fileDiff`/props 层。

### 3.3 terminal(终端)

- **私有 context**:TerminalProvider(app.tsx:282,session 域);PTY store **workspace 级**
  (非 session 级):cache key `__workspace__`/目录(`packages/app/src/context/terminal.tsx:23,
  87-89,404-422`),LRU cap 20(:24,:394-402)。面板开关/高度 = layout
  `view().terminal.opened`/`layout.terminal.height`(terminal-panel.tsx:33-36,:222;
  底层 layout.tsx:800-810)。Terminal 组件自身再消费 8 个 context
  (`packages/app/src/components/terminal.tsx:1-18`:theme/language/platform/sdk/server/
  settings/command-keybind/terminal)。
- **持久化**:**localStorage**(非服务器):`Persist.serverWorkspace(scope,dir,"terminal",…)`
  (terminal.tsx:115-117,:153-164)→ `opencode.workspace.<head>.<sum>.dat`
  (persist.ts:338-342,:487-489),内容含 **buffer/cursor/scrollY/rows/cols**;
  server 只收 title+size(terminal.tsx:205-224)。buffer 序列化在组件 cleanup:
  `SerializeAddon.serialize()` + `getViewportY()`(components/terminal.tsx:130-155,:630-648,
  接线 terminal-panel.tsx:305)。trim 策略 :105-113,:292-303。
- **焦点管理**:`autoFocus={opened()}`(terminal-panel.tsx:303)+ rAF/120/240ms 重试聚焦
  (:82-114);关面板 blur(:116-122);`data-prevent-autofocus`(components/terminal.tsx:655)
  使 session 页 type-to-focus 不抢终端键入。keybind `terminal.toggle`
  (components/terminal.tsx:20-21,:377-390 在 xterm 键处理器里放行)。
- **layout 交接**:terminal id 跨 workspace 路由交接 `setTerminalHandoff/getTerminalHandoff`
  (handoff.ts:32-36;terminal-panel.tsx:130/:145)。
- **persist key**:workspace `terminal`(上);GC 键 `terminal(v1)`(layout.tsx:295);
  面板 opened/height 在 `layout.v6` blob。
- **alpha 现触 DOM anchor**:仅 `[data-component=terminal]` 外框 CSS(review.css:311-314);
  **无 JS 触碰**。
- **引擎边界**:ghostty-web canvas,DOM 不可达;WebSocket 直连 PTY
  (components/terminal.tsx:522-616,ticket/cursor 续传协议)——adapter 若移动挂载点,
  必须保 WS 生命周期与 buffer 序列化时序(cleanup flush,:630-648)。

### 3.4 permission flow(权限流)

- **私有 context**:PermissionProvider(app.tsx:268,server 域)——职责是**自动响应**:
  SSE `permission.asked`(`packages/app/src/context/permission.tsx:165-174`)+ autoAccept map
  持久化 `Persist.serverGlobal(…,"permission")`(:62-83);respond 走 serverSDK
  (:121-127)。**dock 的数据源不是该 context**:`permissionRequest()` 是 sync 数据的派生 memo
  (`session-composer-state.ts:34-42`,读 `sync().data.permission`,并剔除 auto-respond 会处理
  的项);`questionRequest()` 同型(:34-37);`blocked()`(:44-48)顺带隐藏 composer
  (session-composer-region.tsx:134)。
- **决策路径**:`decide(response)`(session-composer-state.ts:75-90)→
  directory SDK `client.permission.respond`(:81-86)。**无 keybind**(§1.3 P7)。
- **滚动/焦点**:dock 内联渲染在 `data-component=session-prompt-dock`
  (session-composer-region.tsx:214-252,**非 Portal**);无专用焦点恢复——权限解除后
  composer 重现,焦点靠 type-to-focus 兜底(session.tsx:691-694)。
- **layout 交接 / persist**:请求本体不持久(sync 内存态);autoAccept 键结构
  `<b64(dir)>/<sessionID>` 与目录通配 `<b64(dir)>/*`(permission-auto-respond.ts:3-16)。
- **alpha 现触 DOM anchor**:仅 CSS(composer-reskin.css:186-216,锚
  dock-prompt/data-kind/data-dock-surface/permission-* 见 §1.3);**无 JS 触碰**。
- **adapter 提示**:权限 UI 可整体替换(数据面 = `sync().data.permission` + SDK respond,
  接口窄);但要复刻 `blocked()` 与 composer 的互斥,以及 auto-respond 的剔除逻辑,
  否则会双弹。

### 3.5 其余 alpha 结构性触点(全量登记,供 REQ-087 排雷)

| alpha 文件 | 机制 | 触碰的上游锚点 | 备注 |
|-----------|------|---------------|------|
| composer-takeover.tsx:20,:84-90 | Portal + MutationObserver | `[data-component=session-composer]`(prompt-input.tsx:1517)、`button:has([data-component=progress-circle])`(:63) | 存活依赖 newLayoutDesigns 种子(§0.1) |
| timeline-inject.tsx:416-419 | MutationObserver + capture 事件 | §3.1 列表 | 隐藏控件点击:review 开关(:143-147) |
| model-picker-inject.tsx(:104-120,:275) | Portal + MutationObserver + 隐藏列表点击 | `[data-component=list]`/`[data-slot=list-scroll]`/`[data-slot=list-item][data-key]`(packages/ui/src/components/list.tsx:263/318/340);原生列表隐藏 `model-picker-reskin.css:22-24` | 选型经 `el.click()` 打隐藏原生行(:275) |
| settings-back-button.ts:13-38 | MutationObserver + 合成 Escape | `.settings-v2-dialog`、`[data-slot=tabs-v2-list]`(:14-16) | 关闭走键盘事件仿真(:6-11) |
| composer-reskin.css:180-183 | CSS 隐藏 | `:has(> [data-slash-id])`(slash-popover.tsx:104) | 上游斜杠弹层整体压制,alpha 菜单顶替 |

---

## 4. dev-plan 收尾三项处置(REQ-005 AC#2 对应)

> 注:REQ-005 写的 `dev-plan.md:98-100` 是加 CAUTION 横幅前的行号;当前文件中三项位于
> `docs/archive/assets/design-program/2026-06-28-timeline-overhaul/dev-plan.md` §7(本次核对时为 :106-108)。

| 项 | 本次处置 | 真实状态与证据落点 |
|----|---------|------------------|
| 深浅色 CDP 回归截图归档到 `screenshots/` | 未做,不假勾 | 设计目录下无 `screenshots/`;截图证据将由 orchestrator 按 [[visual-verify-required]] 补录到本档 §5,归档决定随之落 dev-plan 批注 |
| `timeline-reskin.css` 顶部 COUPLING 清单更新 | **完成并回勾**(2026-07-12) | 头注 `timeline-reskin.css:1-157`;核对记录 = 本档 §2 |
| `ship:mac` 真机验收 | 未做,不假勾 | 本任务未运行 ship:mac;验收证据落点 = REQ-005 验证记录(requirements 档「验证记录」节)+ 本档追加节 |

---

## 5. 真机截图取证(2026-07-12 部分补录;余项滚动到 Issue #214)

> 真机 dev 实例(CDP 9222,浅色主题)驱动一条真实会话
> (Shell echo + 写入 s41-note.txt,Claude Opus 4.8 经 PRO 登录态)取证。
> 截图归档:`docs/audits/2026-07-12-s41-visual/`。测试残留已清理
> (工作区测试文件已删,spike flag 已撤;会话记录保留作证据)。

**已取证(浅色)**

- `12-permission-card.png` / `13-diff-expanded.png`:会话页 timeline(用户消息、Shell 工具卡、
  写入工具卡、收尾回复、changed-files 卡)+ 审查面板(Git changes 列表、+/- chips、统一/拆分、
  文件行展开)——对应 §1 矩阵 D1/D3/D4 观感成立,T1 外框未涉及,P 组未触发(见下)。
- `10-prompt-typed.png`:alpha composer(REQ-055 同源)含权限 chip「请求审批」、模型/effort chips。
- `22-spike-summary.png`:REQ-087 探针 overlay 真机在session页可见(左下计数条),
  summary = `{samples:6, sessionRouteSamples:2, singleMountViolations:1,
  commandAccumulation:false, terminalPanelAccumulation:false}`——违例样本源于
  composer 探针计数 0/1(ComposerTakeover 隐藏上游 composer 的既有现状),已归入
  spike CONDITIONAL GO 条件 C4 的待查清单。
- `00-env-snapshot.png`:`window.api.environment()` 只读 IPC 真机返回
  (dev→legacy root、updater feed 禁用)——REQ-098 配套证据。

**未取证(残项,回写 Issue #214,不假勾)**

- [ ] 终端 PTY 面板(ghostty T2-T4):本次会话 Shell 走工具通道,未开 PTY 面板
- [ ] 权限卡 P1-P6:工作区既有规则自动放行,未触发交互卡
- [ ] 深色主题全组 + 40 条 timeline 构件深浅色回归归档
- [ ] `ship:mac` 打包真机验收(dev-plan §7 第 3 项)

---

## 6. 验证记录与结论

**验证(2026-07-12,本工作树)**

- `bun test src/renderer/alpha-ui/upstream-anchors.test.ts`:**5 pass / 0 fail**
  (改动前后各跑一次,均绿——头注锚点写法刻意避开抽取器,清单无需再生成)。
- `bun run --cwd packages/ui-mac typecheck`:改动前基线即红——错误全部来自并行 spike 探针
  `src/renderer/alpha-ui/session-spike/_probe-deep-import.tsx`(untracked,他人 REQ-087 现场),
  与本任务无关;本任务只改 CSS 注释与 docs,改动后错误集不变(见任务汇报)。

**缺口回写清单(供 Issue #214 逐条登记)**

1. T3 终端面板 chrome 无稳定接缝(上游无 data 钩子)——归 REQ-088 结构接管。
2. T4 终端 header bar 需 inject——冻结期禁止,归 REQ-088。
3. D6 session-review diff 包装层(placeholder/large-diff)未换肤——轻,可 CSS 补。
4. D7 file tab 代码视图整面未换肤(`[data-component=file]` 零覆盖)。
5. P5 permission hint 行未换肤——轻,可 CSS 补。
6. P6 question dock(`data-kind=question`)整卡未换肤。
7. (登记非缺口)knownDead 假死两项(session-composer/new-composer)与 newLayoutDesigns
   种子依赖(§0.1)——REQ-087 依赖拓扑必须收录。

**结论**:三重型引擎换肤 = **卡壳层基本完成、引擎内核按 ADR-016 保留、6 条边缘缺口**;
timeline COUPLING 清单已按冻结语义重建并回勾;dev-plan 另两项如实未勾。本档 §1/§3 即
REQ-087 spike 交付物①(timeline/diff/terminal/permission 段)的可直接消费输入。
