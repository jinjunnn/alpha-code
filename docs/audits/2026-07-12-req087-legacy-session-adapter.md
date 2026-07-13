# REQ-087 Spike:LayoutController / LegacySessionAdapter 可行性与边界(2026-07-12)

- Issue:jinjunnn/alpha-code#180(REQ-087,GitHub #202)
- 分支:`feat/180-183-184-product-ownership-s41`
- 结论:**CONDITIONAL GO**(条件见 §8;核心缺口 = 合法导出通道 + live-engine characterization)
- 原型代码:`packages/ui-mac/src/renderer/alpha-ui/session-spike/`(实验闸,永不默认启用)
- 测试:`cd packages/ui-mac && bun test src` → 760 pass / 6 todo / 0 fail;`bun run --cwd packages/ui-mac typecheck` 干净

---

## 1. 依赖拓扑矩阵(交付物 1,对应 AC1)

Provider 挂载层级(`packages/app/src/app.tsx`,冻结面):

| 层 | Provider | 位置 | 生命周期 |
|---|---|---|---|
| Router root | QueryClient + Settings/Command/Highlights + Tabs | app.tsx:475-482, 252-261, 495 | 全程常驻,跨路由 |
| SelectedServerLayout | ServerSDK/ServerSync → Permission/**Layout(ctx)**/Notification/Models + 视觉 `Layout` | app.tsx:117-127, 266-278 | 按 `server.key` keyed 重挂(app.tsx:445-452) |
| `/:dir` DirectoryLayout | SDKProvider + DirectoryDataProvider(DataProvider+LocalProvider) | pages/directory-layout.tsx:86-94, 37-46 | 按 directory keyed 重挂 |
| `/:dir/session/:id?` | **SessionProviders**(Terminal/File/Prompt/Comments) | app.tsx:280-290, 102-106 | session 路由内常驻(切 id 不重挂) |

### pages/layout.tsx(视觉 Layout,2563 行)

| 维度 | 证据(file:line) |
|---|---|
| 消费 context | useServerSDK:96、useParams:117、useServerSync:118、useLayout:119、usePlatform:121、useSettings:123、useServer:124、useNotification:125、usePermission:126、useNavigate:127、useProviders:129、useDialog:130、useCommand:131、useTheme:132、useLanguage:133、useLocation:137(owner 全在 ServerScopedShell 及以上) |
| route params | `params.dir`(decode64 → route memo :136-149)、`params.id`(通知去重 :470-472、prefetch :672/879) |
| persist keys | `Persist.serverGlobal(scope,"layout.page",["layout.page.v1"])` :97-98(lastProjectSession/activeProject/workspaceOrder/workspaceName/workspaceExpanded) |
| commands | `command.register("layout", …)` :993-1119+:sidebar.toggle、project.open/previous/next(mod+o/mod+alt+↑↓)、server.switch、settings.open、session.previous/next(alt+↑↓)、session.previous/next.unseen、session.archive(mod+shift+backspace)、workspace.new/toggle |
| focus/scroll | sidebar aim/hover 状态机 :211-314;`scrollToSession`(`[data-session-id]` scrollIntoView):511-524 |
| prefetch/cache | session 预取管线 :641-888(chunk 200、并发 2、每目录 LRU 10;`session-prefetch`/`session-cache` 全局模块)+ 淘汰时 `dropSessionCaches` :776 |
| notification/permission | `serverSDK().event.listen` 常驻订阅 :400-494(permission.asked/question.asked → toast/系统通知/声音;`permission.autoResponds` 短路 :436) |
| deep link / handoff | `handleDeepLinks` + `setSessionHandoff` :1367-1397;tabs handoff 写侧(session 页在 :127-162 消费) |
| terminal cleanup | workspace reset 时 `clearWorkspaceTerminals` :1561-1566 |
| cleanup | :221-230(计时器/aim)、:494(event unsub)、:2557 |

### pages/session.tsx(session 叶,1729 行)

| 维度 | 证据 |
|---|---|
| 消费 context(19 个 hook) | useServerSync:80、useLayout:81、useLocal:82、useFile:83、useSync:84、useQueryClient:85、useDialog:86、useLanguage:87、useSDK:88、useServerSDK:89、useSettings:90、usePlatform:91、usePrompt:92、useComments:93、useTerminal:94、useServer:95、useSearchParams:96、useLocation:97、useSessionLayout:98 |
| route params | `params.id/params.dir` 贯穿(:101-110 prompt 消费、:127-162 tabs handoff、:204 info、:503-538 todo 拉取、:973-1009 diff 拉取) |
| persist keys | `Persist.serverWorkspace(scope, dir, "followup", ["followup.v1"])` :268-281(队列/失败/暂停/编辑) |
| commands | 委托 `useSessionCommands(...)` :749-754(见下) |
| focus/scroll 状态 | `ui.scroll{overflow,bottom,jump}` :112-121;document keydown 抢焦策略 :657-695(终端开着优先 `focusTerminalById` :679-683);composer 自动聚焦 :1495-1502;`createAutoScroll` :1038;历史上翻锚点 capture/restore :1131-1156;scroll cursor/message 定位 :389-437;hash scroll 委托 `useSessionHashScroll` :1469-1493 |
| cleanup | `onCleanup(stopVcs)` :574(sdk event listener);帧/计时器统一回收 :1508-1516 |
| 横向耦合 | layout.handoff.tabs 消费 :134-158;MessageTimeline 20 个闭包 prop 接线 :1644-1679;TerminalPanel :1726;SessionSidePanel :1711-1723;SessionComposerRegion :1520-1571 |

### pages/session/session-layout.ts(27 行,Layout↔Session 耦合点)

| 维度 | 证据 |
|---|---|
| 组成 | `useParams`+`useServer` → `SessionStateKey.from(scope(), SessionRouteKey.fromRoute(params.dir, params.id))` :7-14 |
| tabs/view | `layout.tabs(sessionKey)` / `layout.view(sessionKey)` 切片 :16-26 —— 状态本体在 layout context(`Persist.serverGlobal(scope,"layout",["layout.v6"])` context/layout.tsx:249-284) |
| 生命周期 | sessionKey 槽位 LRU 上限 50(context/layout.tsx:286-346),淘汰时连带清 session 级 persist(prompt.v2/terminal.v1/file-view.v1,:294-319) |

### pages/session/timeline/message-timeline.tsx(1589 行)

| 维度 | 证据 |
|---|---|
| 消费 context | useNavigate:258、useServerSDK:259、useSDK:260、useSync:261、useSettings:262、useDialog:263、useLanguage:264、useSessionKey:265、usePlatform:270、useFileComponent:225 |
| 虚拟列表 | `createVirtualizer`(@tanstack/solid-virtual):18;测量缓存 `timelineCache`(模块级 Map,LRU 16):85, 537-541 |
| prepend anchor | :353-410(`data-timeline-key` 锚 + rAF 补偿);上翻加载由宿主 `onHistoryScroll` 驱动(session.tsx:1135-1156) |
| bottom-follow | 宿主持有(session.tsx autoScroll),timeline 只回调 `shouldAnchorBottom/setScrollToEnd` 等 prop(:235-255 全部 20 个 prop 为宿主闭包) |
| cleanup | :537-541(卸载时 takeSnapshot 入缓存)、:636、:1202 |
| persist | 自身无;scroll 持久化在 layout context `sessionView`(createScrollPersistence,context/layout.tsx:359-374) |

### pages/session/terminal-panel.tsx(338 行)

| 维度 | 证据 |
|---|---|
| 消费 context | useLayout:26、useTerminal:27、useLanguage:28、useCommand:29(仅 keybind 展示)、useSettings:30、useSessionLayout:31 |
| 状态所有权 | 开合 = `view().terminal.opened()`(session 级,:33/36);高度 = `layout.terminal.height()`(全局,:35/220-223)—— 两个所有权不可合并 |
| persist | 终端列表经 context/terminal.tsx `Persist.serverWorkspace(scope,dir,"terminal")` :116;PTY dispose/clone 归 context(:385-416) |
| focus | 打开/切活动终端三段重试聚焦 :82-114;关闭时 blur :116-122 |
| handoff | `setTerminalHandoff/getTerminalHandoff(workspaceKey())` :124-146(loading 期展示标签快照) |
| 生命周期 | 开面板自动 `terminal.new()` :60-69;全关自动收合 :71-80;断连 `recoverTerminal`(clone 去重):151-164 |
| DOM 锚点 | `id="terminal-panel"` :198(spike 探针口径) |

### pages/session/use-session-commands.tsx(587 行)

| 维度 | 证据 |
|---|---|
| 消费 context(14 个 hook) | useCommand:37、useDialog:38、useFile:39、useLanguage:40、useLocal:41、usePermission:42、usePrompt:43、useSDK:44、useSettings:45、useSync:46、useTerminal:47、useLayout:48、useNavigate:49、useSessionLayout:50 |
| 注册 | `command.register("session", …)` :574-586,约 25 条:session.new(mod+shift+s)/undo/redo/compact/fork/share/unshare、file.open(mod+k,mod+p)、tab.close(mod+w)、context.addSelection(mod+shift+l)、terminal.toggle(ctrl+\`)、review.toggle(mod+shift+r)、fileTree.toggle(mod+\\)、input.focus(ctrl+l)、terminal.new(ctrl+alt+t)、message.previous/next(mod+alt+[ ])、model.choose(mod+')、model.variant.cycle、mcp.toggle(mod+;)、agent.cycle(mod+.)、permissions.autoaccept(mod+shift+a) |
| 不累积机制 | 按 key 注册 = 同 key 替换(context/command.tsx:106 `registrations.filter((x) => x.key !== entry.key)`)+ onCleanup 反注册(:406-408)—— **结论:同页面双挂载会互相顶替 key,一方卸载即整组命令消失**(见 §2 方案 c 反例) |
| permission 耦合 | `permission.isAutoAccepting/toggleAutoAccept` :123-127, 264-280 |

---

## 2. 边界方案比较(交付物 2,对应 AC2;每项含可证伪依据)

### (a) LayoutController + ShellView 拆分 —— 淘汰(作为 REQ-088 路径)

- 事实:pages/layout.tsx 的控制器职责(persist :97-109、通知订阅 :386-509、prefetch :641-888、命令 :993+、deep link :1367-1397)与视觉渲染在同一组件体内交织,拆分必须**改写冻结的 packages/app**。
- ADR-020 规定 app/ui 只读、唯一写通道是受控 re-freeze;ADR-027 seam 也刻意只换叶、不动 `Layout`(决策 1)。
- 可证伪条件:若未来某次 freeze-base 轮换随上游吸收了 controller/shell 拆分,此结论作废、重评。
- 结论:不是 spike 可验证路径,是 re-freeze 级工程;不阻塞 REQ-088 的叶级 adapter。

### (b) 粗粒度 LegacySessionAdapter(单 adapter 包整页 legacy session)—— **推荐**

- 挂载通道:ADR-027 typed surface seam。`createSessionRoute(props.surfaces?.session ?? Session)`(app.tsx:466)是 **XOR** —— override 与默认叶不可能同时挂载,单挂载是结构保证而非运行时约定。
- 叶挂载点在 `SessionProviders` **内侧**(app.tsx:102-106),即 19 个私有 context 全部由上游 wrapper 按默认生命周期供给,adapter 无须复制任何 provider(AC1 矩阵里的全部依赖原地满足)。
- Alpha 外框零 upstream context:原型 frame 只读路由 ABI(legacy-route-abi)+ 公开导出 `useCommand`,类型面窄(§6)。
- 代价/风险:上游叶的导入通道尚无合法形态(§4);Alpha 只获得**叶盒子**所有权,sidebar/titlebar/终端下坞仍归上游 `Layout`(范围预期需求侧确认)。
- 重挂语义:与 legacy 完全一致(路由级;切 session id 不重挂 SessionProviders)。
- 回退:flag 关 → 默认叶;SurfaceBoundary 致命错误 → 记录 + reload 回 legacy(surface-boundary.tsx:9-35)。
- 可证伪依据:原型 typecheck+bundle+测试全绿(§5);若 live-engine characterization(§7 OPEN)发现 frame 高度/焦点链路破坏 AC5/6,则降级 NO-GO。

### (c) 整页 iframe / Portal 叠挂 —— 反例成立,淘汰

iframe(独立 document):
- **provider 复制**:providers 均为 per-document 树,iframe 内必须再 boot 一个 AppInterface(第二个 ServerProvider/ServerSync SSE/QueryClient/TabsProvider)——数据面直接翻倍。
- **focus/快捷键断裂**:命令面板与快捷键监听在宿主 document(context/command.tsx:390-392 `makeEventListener(document,"keydown")`;session.tsx:1504-1506 同款);`focusTerminalById` 查询宿主 document —— 跨 iframe 全部失效。
- **IPC 断裂**:`window.api` 是 preload 注入的 per-context 对象;deep link 走宿主 `window` CustomEvent(renderer index.tsx `deepLinkEvent`)不跨 frame。
- **PTY**:第二个 TerminalProvider 会对同一 workspace 的持久化终端(context/terminal.tsx:116)做二次 attach/recovery(clone :151-164),行为未定义。

Portal 叠挂(REQ-085 AlphaHome 已实证的旧路):
- 上游叶仍然挂载 → 双生命周期:两份 `session.sync`、两个 document keydown、两个 `#terminal-panel`;
- 致命机制性证据:`command.register("session")` 按 key 替换 —— 双挂载时第二个页面顶掉第一个的注册,而**任一方卸载都会把命令组清空**(command.tsx:406-408 按 entry 身份过滤),另一个仍在的页面失去全部 session 命令。这不是性能问题,是正确性破坏。
- ADR-027 背景陈述与 REQ-085 已裁定该形态不可证明无隐藏副作用。

### (d) 按 view 拆多个 adapter(timeline/terminal/diff 各一)—— 淘汰(作为第一步)

- MessageTimeline 不是自治组件:20 个 prop 全是宿主闭包(scroll 状态机、历史锚点、跟底控制都在 session.tsx :1644-1679)—— 单独 adapter 化 = 把 session.tsx 的滚动/焦点状态机复刻进 Alpha,正是 REQ-087 背景警告的「把私有 context、滚动和快捷键耦合扩散到 Alpha 页面」。
- TerminalPanel 依赖 `useSessionLayout()`(route params + layout context,terminal-panel.tsx:31):在非 `/:dir/session` 路由下 SessionStateKey 语义直接破坏。
- File/Prompt/Comments/Terminal 四个 provider 均未导出,每个 view adapter 都要求上游批量 export 私有 context —— 违反 REQ-087 非目标与 AC8。
- 可证伪条件:等粗粒度 adapter + characterization 锁住行为、REQ-091 runtime parity 立项后,拆 view 才有安全网;届时重评。

---

## 3. 最小原型(交付物 3,对应 AC3/AC4 的可取证部分)

代码:`packages/ui-mac/src/renderer/alpha-ui/session-spike/`
- `spike-flag.ts` —— 实验闸:`localStorage["ALPHA_SESSION_SPIKE"]="1"`,默认恒 off,reload 生效(与 surface「加载时解析一次」语义一致)。
- `spike-probe-core.ts` —— 探针口径与判定(纯逻辑,有单测):可见 composer ≤1、`#terminal-panel`===1(AC3);命令数/panel 数跨切换单调增长检测(AC4 DOM/命令面)。
- `session-spike-host.tsx` —— 两个原型面:
  1. **容器侧 `SessionSpikeHost`**(surfaces.session 不注入 = 上游默认叶):AppInterface children 通道挂载,session 路由上渲染覆盖态框架条(pointer-events:none,不劫持焦点/滚动)+ 路由变化双点采样(0ms/650ms),采样挂 `window.__req087Spike`。
  2. **surface 侧 `sessionSpikeSurface()`**:经 seam 注入 session 叶 = Alpha 自有 header 条 + deep-import 上游叶(`SurfaceBoundary` 兜底);双闸(localStorage + `ALPHA_SURFACE_SESSION=alpha`)全开才返回组件,否则 `undefined` = seam 走默认叶。
- 接线:`renderer/index.tsx` 共 3 行(import 1 行;surfaceComponents memo 内 `if (resolved.session.mode === "alpha") surfaces.session = sessionSpikeSurface()` 1 行;children `<AlphaBoundary name="SessionSpikeHost">` 1 行)。

### 运行方法

```bash
# 1) 容器侧探针(默认叶 + Alpha 覆盖框架)
bun run --cwd packages/ui-mac dev
# DevTools console:
#   localStorage.setItem("ALPHA_SESSION_SPIKE", "1"); location.reload()
# 进入任意会话:右下角出现 REQ-087 SPIKE 橙色计数条;快速切换会话/back-forward 后:
#   window.__req087Spike.summary()
#   → { singleMountViolations: 0, commandAccumulation: false, terminalPanelAccumulation: false } 为通过

# 2) surface 侧原型(Alpha 外框 + legacy 叶,经 seam 注入)
ALPHA_SURFACE_SESSION=alpha bun run --cwd packages/ui-mac dev   # + 上面的 localStorage 闸
# 会话页顶部出现「ALPHA FRAME(REQ-087 原型)」header 条,其内为完整 legacy session;
# 验证:滚动/跟底、终端 ctrl+`、命令面板、composer 聚焦均正常;探针计数无违规。

# 3) 回退:localStorage.removeItem("ALPHA_SESSION_SPIKE") 或去掉 env → reload 即 legacy。
```

### 零默认影响的证明

- `SURFACE_RELEASE_STATES.session === "legacy"`(shared/alpha-surfaces.ts:24,characterization 测试断言);env/pin 不设时 main 解析恒 legacy → index.tsx 的 spike 行根本不执行。
- 双闸任一关闭 ⇒ `sessionSpikeSurface()` 返回 `undefined` ⇒ `surfaces.session` 维持未注入 ⇒ seam 走上游默认叶(app.tsx:466 `?? Session`)。
- 全量回归:`bun test src` 760 pass / 0 fail;`tsgo -b` 干净(§5)。

---

## 4. 关键问题实证:ui-mac 能否导入上游 session 叶(deep-import 通道结论)

| 通道 | 结果 | 证据 |
|---|---|---|
| (a) `@opencode-ai/app/pages/session` 子路径 | **不可用** | package.json `exports` 仅 `.`,`./desktop-menu`,`./updater`,`./wsl/types`,`./vite`,`./index.css`(无 `./pages/*`);typecheck 实测 `TS2307: Cannot find module '@opencode-ai/app/pages/session'` |
| (b) 包根命名导出 | **不可用** | src/index.ts 未导出页面;实测 `TS2305: Module '…/index.js' has no exported member 'Session'` |
| (c) 相对路径 deep import `../../../../../app/src/pages/session` | **机械可行,未合法化** | `tsgo -b` 经 project reference **通过(零报错)**;vite 侧解析为与上游 `lazy(() => import("@/pages/session"))` 相同的绝对模块 id(`@opencode-ai/app/vite` 的 appPlugin 在 ui-mac renderer 全局注册 `@→app/src` 别名),实测独立 build 产出 `session-*.js` 2,159 kB chunk,✓ built |
| (d) `@/pages/session` 别名 | **不可用(typecheck)** | 别名只存在于 vite bundle 层;ui-mac tsconfig 无 paths 映射,实测 TS2307 |

**结论**:合法窄通道**不存在**。通道 (c) 编译与打包均可行,但它绕过包 `exports` 边界、耦合冻结源码树布局,不满足 AC8「深 import 收敛在拟议 upstream-adapter 边界」的**合法化**要求 —— 只满足「收敛」半边(本仓已用锚点测试锁定 `session-spike-host.tsx` 为唯一出现点,见 req087-characterization.test.ts §6)。

**adapter 边界需要的导出**(freeze-base 轮换时加,ADR-020 §5 / ADR-027「seam 是基点的一部分」):

```jsonc
// packages/app/package.json exports 追加(二选一,推荐前者)
"./surface/session": "./src/pages/session.tsx"
// 或 src/index.ts:export { default as SessionLeaf } from "@/pages/session"(打破 lazy 分包,不推荐)
```

仅此一条窄导出,不批量 export `context/*` —— 与 ADR-027 决策 1「只新增窄类型导出」同构。过渡期风险有限:冻结意味着该路径日常不动,只在受控 re-freeze 时可能移动,而移动会先在 typecheck(TS2307)与锚点测试红掉,不会静默漂移。

---

## 5. 度量与证据(对应 AC2/AC3 部分、AC9)

| 项 | 结果 |
|---|---|
| `bun run --cwd packages/ui-mac typecheck`(tsgo -b) | 干净(spike 代码含 deep import) |
| `cd packages/ui-mac && bun test src` | **760 pass / 6 todo / 0 fail**(基线 727 pass;新增 33 用例 + 6 个 live-engine TODO 占位) |
| deep-import 独立 bundle 探针 | `session-*.js` 2,159.12 kB chunk,build 5.1s ✓(与上游 lazy 同一模块 id,不重复打包) |
| spike host 独立 bundle 探针 | 585.41 kB entry + 343.46 kB css,✓ built 4.95s |
| flags-off 行为 | surfaces.session 未注入;默认 release state = legacy(测试断言);全量回归绿 |
| AC5/6/7 运行时数值(mount time/订阅数/内存/长 timeline) | **未采集 —— OPEN**(需 live engine,见 §7;这是 CONDITIONAL 的直接原因,不以「后续优化」跳过) |

---

## 6. 推荐 adapter API(交付物 5 之边界决策;对应 AC8)

```ts
// alpha-app 自有类型 —— 不出现 useLayout()/useSessionLayout() 或任何 upstream context 类型
export interface LegacySessionAdapterProps {
  /** Alpha 外框插槽(header/上下文条);adapter 不反向依赖 chrome 内容。 */
  chrome?: { header?: Component }
  /** 致命 render 错误出口;默认 = SurfaceBoundary 语义(记录 + reload 回 legacy)。 */
  onFatal?: (error: unknown) => void
}
```

控制/事件通道(全部走既有合法面,不新增私有 context 泄漏):
- **命令**:`useCommand().trigger(id)`(`@opencode-ai/app` 既有公开导出)—— `terminal.toggle`、`review.toggle`、`input.focus`、`session.new` 等即 adapter 的事件总线;
- **路由**:`hrefFor`/`parseRoute`(`shared/legacy-route-abi.ts`,版本化 ABI);
- **状态读取**:REQ-091 runtime parity 之前仅允许 DOM 锚点(upstream-anchors 契约面);
- **必须保留的 scopes**:`SessionProviders`/`DirectoryDataProvider`/`ServerScopedShell` 全部按上游默认生命周期,adapter 挂在 seam 叶位、不复制任何 provider。

## 7. Characterization 现状(交付物 4;种子,不是全集)

已锁(源码锚点,`session-spike/req087-characterization.test.ts`,27 用例):
- persist keys:`layout/layout.v6`、`layout.page/layout.page.v1`、`followup/followup.v1`、`terminal`(workspace 级)、session 级三元组 prompt.v2/terminal.v1/file-view.v1、`command.catalog.v1`;
- route→layout 绑定:SessionStateKey 拼合、tabs/view 切片、`/session/:id?` 路由形状、surface XOR;
- terminal panel 依赖形状:三 context、开合/高度所有权分离、自动建/收合、handoff、断连恢复、`#terminal-panel` 锚点;
- 命令不累积机制:keyed register 替换 + onCleanup 反注册;
- timeline:虚拟列表、prepend anchor、测量缓存 LRU 16、vcs 订阅清理、终端抢焦链路;
- 通道锁定:exports map 集合相等断言 + deep import 唯一收敛点断言。

**OPEN(live-engine,以 test.todo 显式占位,进入 REQ-088 前必须补)**:
- AC5:100+ 长 timeline 首屏/stream/上翻/跟底/hash 定位(无跳动不丢锚);
- AC6:terminal 新建/关闭/重排/切 session/重启恢复、diff/file panel 焦点返回、permission once/always/reject、abort/重试;
- AC4 运行时半边:event subscription 与 PTY 数取证(探针只覆盖 DOM/命令面);
- AC7:mount time/订阅数/内存趋势/滚动性能 vs legacy 基线。

## 8. 结论:CONDITIONAL GO(条件逐条可验)

**GO 的依据**:方案 (b) 的单挂载是 seam 结构保证;provider 零复制;窄 API 成立;原型 typecheck/bundle/回归全绿;回退路径(双闸 + SurfaceBoundary crash-fallback)已验证存在。

**条件(全部满足前 REQ-088 不得把 session surface 升出 legacy 默认)**:
1. **C1 通道合法化裁决**:freeze-base 轮换加 `"./surface/session"` 窄导出(推荐);或书面接受「受限 deep import」过渡态(收敛单文件 + 锚点测试 + re-freeze 检查单挂钩)。二选一,先裁决后动工。
2. **C2 live-engine characterization 全绿**:§7 OPEN 清单(AC5/6/7 + streaming/steer/abort/permission)以真实引擎取证;性能超预算即按 AC7 降级结论,不得「后续优化」。
3. **C3 API 纪律**:adapter props 保持 §6 形态;任何要求私有 context 的新能力回 ADR-029 阶梯裁决,禁止散射 deep import(锚点测试作红线)。
4. **C4 探针矩阵通过**:真实引擎上快速切换两个 session、back/forward、reload、切 directory/server 后 `window.__req087Spike.summary()` 无违规。

**若 C1 被否且过渡态也不接受 → NO-GO**:REQ-088 保持未激活,回需求修订(替代路线 = 等 REQ-091 runtime parity 或 re-freeze 吸收 controller/shell 拆分)。

## 9. REQ-088 任务分解(交付物 6)

| # | 任务 | 依赖 |
|---|---|---|
| T1 | 通道合法化:freeze-base 轮换加窄导出(ADR-020 §5 流程,含 seam 存活校验更新)或过渡态裁决落 ADR | C1 |
| T2 | AlphaSessionWorkspace 外框正式化:移植 spike frame → 正式 chrome(header/上下文条/alpha 视觉),surface 注入 + SurfaceBoundary | T1 |
| T3 | live-engine characterization suite:先跑 legacy 基线,后跑 adapter 模式对比(§7 OPEN 全项) | 可与 T2 并行 |
| T4 | 性能基线采集与预算判定(mount/订阅/内存/滚动) | T3 |
| T5 | 发布态阶梯:`SURFACE_RELEASE_STATES.session` → `auto-fallback`,灰度 + 回退演练 | T2-T4 全绿 |
| T6 | takeover 共存审计:ComposerTakeover/ModelPickerInject/TimelineInject 在 adapter 模式按 DOM 继续生效(挂载方式无关);正式版裁决其退役时点(REQ-087 非目标保留) | T2 |
| T7 | spike 清理:`session-spike/` 目录删除或转正,localStorage 闸移除,本报告归档 | T5 |

## 10. 风险与回滚

| 风险 | 缓解 |
|---|---|
| R1 deep import 路径随 re-freeze 漂移 | typecheck TS2307 先红(实测验证)+ 锚点测试红;T1 合法化后消失 |
| R2 workspace hoisting 变化导致双 solid-js/router 实例(context 失联) | composer-takeover 已承担同风险且稳定;catalog 版本对齐;冒烟必测 |
| R3 Alpha frame 高度(26px)影响 timeline 虚拟测量/跟底 | 叶置于 `flex:1;min-height:0` 盒内;AC5 live 验证兜底 |
| R4 探针误报(keep-alive 隐藏 composer) | 口径 = 可见 composer(offsetParent),已容忍 total>1 |
| R5 方案 (b) 只交付叶所有权(sidebar/titlebar 仍上游) | 范围预期在 REQ-088 评审时与产品对齐;整 shell 所有权归 REQ-090/091 路线 |
| 回滚 | 双闸任一关 → reload 即 legacy(URL/持久化不变);SurfaceBoundary 致命错误 → 记录 + auto-fallback(release-state 升级后自动);最坏 = 删 `session-spike/` 目录 + index.tsx 3 行,零残留 |
