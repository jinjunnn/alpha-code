---
title: REQ-089 Alpha route manifest 成为唯一路由组合真相 — 路由架构基线
kind: design
status: active
owners: [alpha-code product and design maintainers]
last_reviewed: 2026-07-25
review_after: 2027-01-16
---

# REQ-089 / #204 路由清单权威 — 路由架构基线(L/M)

本基线是**路由架构**基线,不是 UI 稿。它回答一个问题:能否让一张 Alpha 自有、
版本化的 route manifest 成为**驱动** Web Router + MemoryRouter + deep link + 所有导航
helper 的**唯一权威**(#204 AC2),使上游不能与 Alpha 各自持有一半路由真相。

权威父票 = [#204](https://github.com/jinjunnn/alpha-code/issues/204)。本基线受其 AC1–AC7
约束,并采纳其"过时性结论":旧"保留 `LegacyRouteAbiV1` aliases"已作废 → **硬切**
(删除 alias 层;不迁移未发布旧 URL)。这是 no-backcompat 主权立场,不是过度设计。

复杂度沿用 #204 = **M**。

## 与现状/上一稿的关系

- **无上一稿**:这是 REQ-089/#204 的第一份路由架构基线。#182 此前是单张 umbrella
  实现票(`实现 manifest、composeRoutes、runtime slots 与 ledger`),#204 已裁定其
  "收窄/拆分"。本基线据 #204 的建议子票把 #182 从 umbrella 改写为一条可评审的 CODE
  序列(见 §4),并给出应回填 #182 的窄化 body。
- **只做现状增量,不凭需求措辞重画 IA**:本基线的路由集合、codec、href 语义全部
  从**已运行代码**读出(见 §1),不新造路由树。`composeRoutes` 是 #204 的目标符号,
  当前代码库 grep = 0,**不存在**;本基线把它当"要建的目标",不当既有。
- **与 #204 的关系**:本基线不新增权威,#204 的 AC 与 Non-goals 若与本文冲突,以
  #204 为准、本文为缺陷。本基线只把 #204 的 outcome 翻成一份可实现、可评审的架构
  决策 + 子票切分。
- **session 路由与 #181 解耦**:AC3"每个 route 只组合一个 Alpha surface"对 **session
  路由**而言,组合哪个 surface 取决于 REQ-088/#181 + owner decision A(是否让 Alpha
  Session 成为发布默认)。**manifest 的设计**(路由如何声明自己的唯一 surface)与该
  结果**无关**;只有 alpha-session 路由的**具体 wiring** 随 #181 翻转落地。本基线不因
  #181 阻塞。

---

## §1 只读勘破(ground truth)

**今天路由树的主是上游,不是 Alpha。** 上游 `@opencode-ai/app` 的 `AppInterface`
在 `packages/app/src/app.tsx` 里用 `@solidjs/router` 的 `<Route>` 定义整棵树
(`Routes()` 组件,`app.tsx:749+`:`/`、`/:dir`、`/:dir/session/:id?`、`/new-session`、
`/server/:serverKey/session/:id` 等),并接受一个 `router` prop 与一个 `surfaces` prop。
Alpha 没有自己的路由驱动器。Alpha 今天有三处真实贡献(1–3),外加一条今天在跑的**平行
URL codec**(4,横跨上游 `app` 与 Alpha main,是 §2 必须处置的第二套真相):

1. **URL codec / parse / href 的集中点** — `packages/ui-mac/src/shared/legacy-route-abi.ts`
   (`LegacyRouteAbiV1`,REQ-084)。它是唯一的目录 base64 编解码
   (`encodeDirectory`/`decodeDirectory`,与 `core/src/util/encode.ts` 逐字节一致)、
   路由解析(`parseRoute` → `home|directory|session|newSession|invalidDirectory|unknown`)
   和 URL 构造(`hrefFor.{home,directorySession,session,newSession}`)。消费方遍布
   renderer:`sidebar/route.ts`(把 `hrefFor` 再包成 `sessionHref/newSessionHref/homeHref`
   导航 helper)、`alpha-sidebar.tsx`、`composer-takeover.tsx`、`ext-trust-watcher.tsx`、
   `extension-hub.tsx`、`artifact-workbench.tsx`、`session-spike-host.tsx`、
   `session-workspace-core.ts`、`dev/surface-map-inspector.tsx`。这是 Alpha 已有的
   "单一路由事实源"雏形,但它自我定位为**保存上游冻结 URL 的兼容 ABI**,而非路由
   **驱动器**。

2. **类型化叶注入(surface seam)** — `packages/ui-mac/src/renderer/index.tsx` 约 :450–483。
   Alpha 通过 `AppInterface` 的 `surfaces` prop 注入 `home / newSession / session /
   permission` 叶(经 `SurfaceBoundary` 兜致命 render)。发布态由
   `packages/ui-mac/src/shared/alpha-surfaces.ts` 的 `SURFACE_RELEASE_STATES` 决定:
   `home:alpha`、`newSession:alpha`、`session:legacy`(REQ-088 未交付)。这是 leaf seam
   (#199/REQ-084),**不拥有**路由 identity——它只是把叶塞进上游定义的坑位。

3. **描述性所有权账本** — `packages/ui-mac/src/shared/frontend-surface-manifest.ts`
   (+ `.test.ts`)。它以 `FrontendSurfaceEntry` 记录每个面(route/overlay/inline/boot)
   的 lineage / target / mount / source / entrypoints,并提供 `frontendSurfaceIdForRoute`
   把 `LegacyRoute` 映射到 surface id。**关键限定**:它是**描述性账本**,记录组合事实
   与替换 backlog(`frontendSurfacesPendingReplacement`),**不是可执行的路由驱动器**——
   它不注册路由、不解析 URL、不构造 href。

4. **第二套 URL codec:deep-link 协议链(平行真相)** — 桌面 main 把自定义 scheme 注册为
   默认协议客户端、把 URL 转发进 renderer 解析,构成一条**与 `legacy-route-abi` 并行的
   URL 编解码**,今天在跑:
   - `packages/desktop/src/main/index.ts:269` `app.setAsDefaultProtocolClient("opencode")`;
     `second-instance`(:203,过滤 `opencode://`)与 `open-url`(:216)把 URL 交给
     `emitDeepLinks`(:79),经 `consumeInitialDeepLinks`(:285)/IPC 送达 renderer。
   - `packages/ui-mac/src/main/index.ts` 注册**两个** scheme——
     `setAsDefaultProtocolClient("opencode")`(:666)与 `("alpha-code")`(:669);
     `second-instance`(:479)同时接受 `opencode://` **和** `alpha-code://`(:480)。
     其中 `alpha-code://auth/*` 被 auth PKCE 模块吃掉、**不转发**(:152–154),其余
     `opencode://` 经 IPC `sendDeepLinks` 转发进 renderer。
   - renderer 侧的**运行中第二套 codec** 在 `packages/app/src/pages/layout.tsx`
     (`collectNewSessionDeepLinks`/`collectOpenProjectDeepLinks`,:71 import、:1263/:1267
     消费,经 `deepLinkEvent` CustomEvent + `drainPendingDeepLinks`)→
     `packages/app/src/pages/layout/deep-links.ts`:`parseNewSessionDeepLink`(:22)解
     `opencode://new-session?directory&prompt`,`parseDeepLink`(:13)解
     `opencode://open-project?directory`。它自带 `new URL(...)` 解析、hostname 分派与
     `directory`/`prompt` query schema,与 `parseRoute`/`hrefFor` **各持一份 path/query
     形状**——正是 #204 AC2 所禁的"第二套 regex/codec"。这不是待建目标,是今天就在解码
     真实 URL 的链路(区别于下面的 `composeRoutes`/"Web Router")。

**两个必须钉死的事实**(REQ-097 教训:不对着没在跑的链路设计):

- **`composeRoutes` 不存在**(全库 grep = 0)。它是 #204 的目标,不是既有实现。
- **"Web Router"今天没有发布目标**。两个生产 renderer 入口都只用 `MemoryRouter`:
  `packages/ui-mac/src/renderer/index.tsx:483`(`router={MemoryRouter}`)与
  `packages/desktop/src/renderer/index.tsx`(`DesktopMemoryRouter`,包一层
  `createMemoryHistory` 的 `MemoryRouter`)。`BrowserRouter/createBrowserRouter` 在生产
  路径**零命中**;`packages/storybook/.storybook/mocks/solid-router.tsx` 的 `MemoryRouter`
  是**测试 fixture**。因此本基线把 "Web Router" 当作**测试 fixture / 未来目标**处理:
  为它设计 manifest 派生能力,但**不**把它当已运行链路来设计,也不为它承诺发布行为。

一句话现状:**上游拥有路由树;Alpha 拥有一个集中但被"兼容 ABI"框住的 codec、一个
leaf 注入 seam、一个描述性账本;此外还有一条运行中的 deep-link URL codec(第二套
parse/href)。四者未合成一个能驱动路由的权威。** REQ-089 就是把这四者收敛成一个
**版本化 canonical manifest = 数据/契约**,并让生产入口(含 deep-link)从它派生。

---

## §2 选定方案 + 被否决替代 —— 权威问题

### 权威问题

上游 `app.tsx` 用 JSX `<Route>` 定义树,Alpha 用 `parseRoute`/`hrefFor` 各自解析同一批
URL。**只要两侧各持一份 path 形状,真相就会分裂**(#204 首要风险:#199 与 #204 同时
拥有 parse/href)。要满足 AC2("Web Router、MemoryRouter、deep link 与所有导航 helper
从同一 manifest 派生,不存在第二套 regex/codec"),必须让 **一张 Alpha 自有清单成为
派生源**,任何一侧不能单边改。

### 选定方案:一张版本化 canonical route manifest = 数据 / 契约

- **manifest 是数据 / 契约,不是 Router runtime 副本,也不是页面实现**(#204 设计要点)。
  它把 §1 的三处贡献收敛为一个模块:
  - **route identity**:每条路由一个稳定 route ID + 参数 schema。URL 可寻址路由
    (`home` `/`、`directory` `/:dir` 重定向、`session-admission` `/:dir/session`、
    `new-session` `/new-session?draftId&prompt`、`session` `/:dir/session/:id`)带
    **path 模板 + query schema**,`path/query 往返确定`(AC1)。系统面
    (Settings / Dialog / Recovery)在 manifest 里也有唯一 ID,但标注为**非 URL 寻址**
    (overlay/boot,经模块级瞬态状态到达),其 param schema 为空——满足 AC1 的
    "唯一 route ID + 参数 schema",而不谎称它们有 URL 往返。是否把 Settings 提升为
    URL 路由是一个 owner 可后置的决定;manifest 两种都能表达。
  - **codec**:目录 base64 编解码就是今天 `legacy-route-abi` 的 `encode/decodeDirectory`,
    折进 manifest,成为清单自己的编解码,不再是"兼容 ABI"。
  - **parse + href 共享同一 schema**:`parse(url) → route` 与 `href(route) → url`
    **由同一份 path 模板派生**,禁止只修一侧(#204 设计要点)。golden 往返测试锁死。
  - **surface composition**:每条路由声明它组合的**唯一** Alpha surface(复用
    `alpha-surfaces` 的 `SurfaceId`),供 `composeRoutes`(待建)在生产入口注入。

- **`composeRoutes`(待建)= manifest → 路由注册的唯一函数**。它读 manifest,产出
  供 `MemoryRouter`(生产)与 Web Router(测试 fixture / 未来)消费的路由表,并把每条
  路由绑定到其声明的单一 surface 叶。上游 `app.tsx` 的 `<Route>` 树降级为**由 manifest
  驱动 / 对 manifest 断言的薄适配层**,不再是并行真相源。

- **红旗:上游路由树每次 bump 的 re-sync 无底洞。** 若让 manifest 去镜像上游整棵树
  (含 provider 嵌套、layout 分支),每次上游 bump 都要重新对表——这是一个会吞掉迭代
  的无底洞。**边界约束**:manifest 只拥有 **route identity + param schema + 单一 leaf
  组合**这一层 seam(与 #199 窄边界一致),**不**拥有上游的 provider/ layout 内部结构。
  一条 ratchet 测试断言"上游暴露的 path 形状 == manifest 声明的 path 形状":上游改了
  路由**形状**时它响亮地红,而不是静默漂移。re-sync 只在 path 形状变时发生,且是显式
  失败,不是持续维护税。

- **deep-link scheme + codec 的命运:折码入清单(单一权威),不另留 path-shape ratchet。**
  §1 第 4 项那条 `opencode://`/`alpha-code://` deep-link 是一条**平行 URL codec**
  (`deep-links.ts` 自带 `new URL`+hostname 分派+`directory`/`prompt` schema),正是 AC2
  所禁的第二套 codec,必须明确表态。它的处置**与上游 `<Route>` 树相反**:上游树因 provider/
  layout 内部结构是 re-sync 无底洞,只能用 path-形状 ratchet **隔臂拿住**(不折入);而
  deep-link parse 是一小块**可完全拥有**的真正第二 codec,**折进 manifest**——`new-session`
  /`open-project` 成为 manifest 的 deep-link route identity(query schema = `directory`/
  `prompt`),其 parse/href 与 URL 路由**共用同一份 path/query 模板**,`deep-links.ts` 不再
  持有独立解析(与 `parseRoute`/`hrefFor` 折入清单是同一个"单一权威"动作)。OS 层的协议
  注册(`setAsDefaultProtocolClient("opencode"|"alpha-code")`)是 **transport、不是 codec**:
  它留在 main,但 scheme 字面量与 hostname→route 映射由 manifest 声明,一条 forbidden-import
  /scheme ratchet 断言 main 与 renderer 都不再有清单外的 scheme/hostname 手写解析。结果:
  deep-link 与 Web/Memory Router **同源**(AC2:不存在第二套 regex/codec)。

- **`LegacyRouteAbiV1` 的命运:折码入清单 + 删 alias 层(硬切)。**(#204 AC7 + 过时性)
  - `encode/decodeDirectory`、`parseRoute`、`hrefFor` 的**逻辑**保留,但迁入 manifest,
    去掉 `Legacy` / `兼容 ABI` / `保存上游冻结 URL` 的框架与 `LEGACY_ROUTE_ABI_VERSION`
    身份,改由 manifest 版本承载。
  - **删掉 alias / redirect 兼容层与旧 surface flags**:不保留任何为"未发布旧 URL"
    存在的重定向;`SurfaceMode "legacy"` 与 `SURFACE_RELEASE_STATES` 里的 legacy 分支
    随对应 surface 切 alpha 后删除(session 那支与 #181 耦合,见 §4)。
  - 硬切因为**没有真实用户**(主权立场):保留 alias 只放大实现面与测试面。

### 被否决的替代

1. **保留 aliases / redirect 兼容(旧题原案)** — 已被 #204 过时性结论作废。无用户,
   保留即过度工程,且制造"Alpha 与 legacy 竞争 redirect"(违 AC3)。**否决**。
2. **在 #199 里再放一套 parse/href** — 直接触发 #204 首要风险:真相分裂,两处各持
   path 形状,单边修必然漂移。#199 必须保持**窄 leaf seam**,不得拥有最终 route truth。
   **否决**。
3. **让插件动态注册顶级路由** — #204 明确 Non-goal,且是安全边界破坏(见 §3c)。
   顶级路由所有权归 Alpha,受控扩展入口只能落在 #212 授权的命名空间。**否决**。

---

## §3 安全面(class-first)

按类枚举,不逐实例;每类给出机制与对应 AC。

**(a) fail-closed 类(AC4)** — 非法 directory(base64 解码失败)、缺失必需参数、
未知路由、**未知未来 route/version**、损坏 deep link,一律**确定性拒绝**并进入
fail-closed 错误/恢复,绝不静默回退 legacy 叶或猜测。要点:未知**未来**版本被拒是
**正确性**,不是"应保留旧 alias"的理由——版本可演进,但清单不认识的版本就拒。
今天的 `parseRoute` 已产出 `invalidDirectory` / `unknown`,把它们接到 Alpha Recovery
(`RuntimeRecoveryHost`)而非上游 toast+`replace("/")`。negative fixtures 锁死每一支。

**(b) 单一组合类(AC3)** — 每条路由只组合**一个**正式 Alpha surface:无双挂载、
无双 preload、无 Alpha/legacy 竞争 redirect。机制:`composeRoutes` 是唯一注入点,leaf
是 XOR(alpha 注入时上游叶不挂载,已由 index.tsx surface seam 建立雏形);ratchet 测试
断言同一路由不会既挂 alpha 叶又挂 legacy 叶。#322(已合)的 leaf-XOR / preload /
provider remount 矩阵是该类的既有 VERIFY 支点。

**(c) 路由所有权类(AC6)** — 第三方 extension **不能**注册或覆盖顶级路由。机制:
manifest 是**闭集**,`composeRoutes` 只认清单内的路由;没有"运行时注册顶级路由"的
API。受控扩展入口(若有)只能位于**明确命名的、由 #212 授权**的命名空间(#212 已合,
其顶级路由拒绝测试是本类的证据面)。清单绝不变成插件动态注册入口(§2 否决 3)。

**(d) 死链类(AC7 的交付顺序风险)** — **删 alias 前必须在同一交付内机械扫描 + 迁移
每一处内部手写 href**。#204 明确:先删 alias、后迁 href 会暴露死链。今天手写/半手写
导航面已枚举:`sidebar/route.ts` 的 `sessionHref/newSessionHref/homeHref` 包装,
`alpha-sidebar.tsx`(`navigate(newSessionHref/sessionHref/homeHref)` 多处、
`href={sessionHref(...)}`)、`AlphaHome.tsx`、`automation-panel.tsx`、
`alpha-session-workspace.tsx`(`navigate(hrefFor.home())`,且有测试断言该字面量)。
**外加 deep-link 层(§1 第 4 项,同属这条死链/平行真相扫描面)**:renderer 侧
`packages/app/src/pages/layout/deep-links.ts` 的 `parseNewSessionDeepLink`/`parseDeepLink`
(独立 `new URL`+hostname+`directory`/`prompt` 解析)与 `deepLinkEvent = "opencode:deep-link"`
字面量;main 侧 `setAsDefaultProtocolClient` 的 `opencode`/`alpha-code` scheme 字面量与
`opencode://`/`alpha-code://` 前缀过滤(`packages/desktop/src/main/index.ts:204/269`、
`packages/ui-mac/src/main/index.ts:480/666/669`)。
迁移动作:全部改为从 manifest 派生的 nav helper / deep-link parse,并加一条**禁止手写路由
字面量 / 禁止直接 import 旧 ABI 名 / 禁止清单外的 `opencode://`|`alpha-code://` scheme 字面量
与 hostname 手写解析(含 `deep-links.ts` 的独立 parse)**的 ratchet(forbidden-import / href /
scheme 扫描),使死链**与平行 deep-link 真相**都无法回潮——防止删/改 URL 层后把 deep-link
parser 留成幸存的第二真相(#199 已警示的同一 AC2 truth-split)。

---

## §4 子票切分(把 #182 从 umbrella 改写)

对齐 #204 的建议子票。#182 收窄为下述序列的**壳/首片**,不再一票同时改 schema、
composition、deep link 与验证(#204:评审边界过大)。命名遵循 `[REQ-089][CODE|VERIFY]`,
CODE body 四行。

1. **[REQ-089][CODE] 定义 route manifest schema + 目录 codec + parse/href + 导航 helper**
   (AC1/AC2/AC4)—— 建立版本化 canonical manifest(route ID + param schema + 单一 surface
   声明),把 `encode/decodeDirectory`、`parseRoute`、`hrefFor` 折入清单并去 legacy 框架,
   parse 与 href 共享同一 path schema,golden 往返 + 非法/未知/未来版本 fail-closed
   fixtures。这是 #182 的窄化本体。

2. **[REQ-089][CODE] 让 Web/Memory/deep-link 生产入口从 manifest 组合 surfaces**
   (AC3/AC5)—— 建 `composeRoutes`,MemoryRouter(生产)与 Web Router(fixture)从 manifest
   派生路由表并绑定单一 leaf;上游 `app.tsx` route 树降为薄适配 + path-形状 ratchet;
   **production-entry-asserted** 测试(从真实 route 入口验证,非仅纯函数),覆盖
   Home→Draft→Session、Settings/Dialog/Recovery、back/forward/reload 的 route state 不丢
   不串 scope。**边界/退出条件含 deep-link parser 迁移**:deep-link 生产入口
   (`layout.tsx` `collectNewSessionDeepLinks`/`collectOpenProjectDeepLinks` →
   `deep-links.ts`)改为从 manifest 派生的 deep-link parse,退出条件 = `deep-links.ts` 不再
   持有独立 `new URL`+hostname 分派与 `directory`/`prompt` schema,`opencode://new-session`
   /`opencode://open-project` 的往返由 manifest golden 断言(与 URL 路由共用 path/query 模板)
   ——否则删/改 URL 层会把 deep-link parser 留成幸存的平行真相(见 §2 折码入清单、§3d 扫描)。
   **session 路由的具体 surface wiring 排在 #181 之后**(见下 session 耦合)。

3. **[REQ-089][CODE] 删除 LegacyRouteAbiV1 aliases + 手写 href + 双组合(含机械 href 扫描)**
   (AC7)—— 删 alias/redirect 兼容层与 legacy surface flags,同一交付内机械扫描并迁移
   §3d 枚举的全部内部手写 href **与 deep-link 层(`deep-links.ts` 独立 parse + main 侧
   `opencode://`/`alpha-code://` scheme 字面量)**到 manifest nav helper / deep-link parse,
   加 forbidden-import / href / scheme ratchet 防回潮;`LegacyRouteAbiV1` 命名与
   `LEGACY_ROUTE_ABI_VERSION` 身份移除。

4. **[REQ-089][VERIFY] route/surface 共享验证(引用 #322)** —— 复用/扩展已合的 #322
   Router/MemoryRouter leaf-XOR、preload、provider remount、fatal reload 矩阵,断言
   manifest 驱动后的 leaf 单一组合与导航矩阵仍绿;#212 顶级路由拒绝测试覆盖 AC6。
   #322 已合,本 VERIFY 是其在 manifest-driven 语境下的复用/回归钉,不重造矩阵。

### session 耦合(明确)

AC3 要求 session 路由组合**唯一** Alpha surface。今天 `SURFACE_RELEASE_STATES.session
= "legacy"`(REQ-088 未交付),session 叶发布态仍是上游叶,alpha 外框
(`AlphaSessionWorkspace`)由双闸门控。**manifest 如何声明"一条路由的单一 surface"**
这一设计与该结果**无关**——清单被设计成能表达 session=legacy 或 session=alpha 任一种。
但**具体把 alpha-session 叶接成 session 路由默认组合**这一步,取决于 REQ-088/#181 +
owner decision A(是否让 Alpha Session 成为发布默认);该 CODE 片(子票 2 内的 session
wiring 部分 + 子票 3 内删 session 的 legacy flag)**排序在 #181 翻转之上/之后落地**。
其余路由(home/new-session/directory/系统面)不依赖 #181,可先行。**不因 #181 阻塞整个
基线**。

---

## Ready 处置与残留 owner 决定

- **基线现在即可撰写、可过设计门**:现状勘破完整、方案与否决项成立、子票可切。
- **但不得进入 Ready / 关闭**:#204 的 acceptance owner = **待指定**;未指定前
  (依 #204 与 requirement-management 契约)不得 Ready、不得关闭。
- **session 路由片排在 #181 之后**:decision A(Alpha Session 发布默认)未定 + #181 未
  翻转前,子票 2 的 session wiring 与子票 3 的 session legacy-flag 删除不落地;其余片可先行。

因此 ready_disposition = **ready-blocked-on-owner**。

---

## §5 交付记录 —— #182 收尾(2026-07-25)与本稿的关系

本节记录基线**已落地的部分**与它相对上文的差异,不新增权威:凡与 §1–§4 冲突处,以本节
为**当前事实**(上文是设计意图的原始表述,保留以便追溯)。#494/#495/#496 已交付 manifest /
`composeRoutes` / ownership ledger;#182 收掉最后三片残余。

**A. 上游 path 形状 ratchet(§2 红旗对策落地)** ——
`packages/ui-mac/src/shared/route-upstream-shape.test.ts` 从 `packages/app/src/app.tsx` 源码抽出
整棵 `<Route>` 树(展平嵌套、展开可选段 `:id?`),与 `manifestPathTemplate()` 派生的模板做
**集合相等**断言。只比形状不比参数名(上游 `:dir`/`:id` vs 清单 `:directory`/`:sessionId`),
**不镜像 provider/layout** —— §2 点名的 re-sync 无底洞照旧不进。

**B. deep-link codec 折入清单(§2「折码入清单」落地)** —— `deep-links.ts` 不再持有
`new URL` + hostname 分派 + `directory`/`prompt` schema。改为:manifest 新增
`decodeDeepLink()`,alpha main 解码后**只转发解码结果**(`DeepLinkDelivery` = deepLinkId /
directory / prompt? / 清单派生的 route href),上游 renderer 侧退化为形状校验 + 分发的
passthrough。事件名 `DEEP_LINK_EVENT` 归清单;packages/app 无法 import 清单,故其副本由
`route-upstream-shape.test.ts` 的锚点钉住。ratchet(`route-authority-ratchet.test.ts`)新增
扫描根 `packages/app/src/pages/layout/`,**只施加 deep-link codec 类规则**——该目录里上游自有
侧栏合法地写自己的路由字面量,那一层由 A 的 path 形状契约管,不由 href 规则管。

**C. legacy surface flag 硬切(§2「删 alias 层」落地,owner 2026-07-25 裁决)** ——
`SurfaceMode`/`SurfaceReleaseState`/`SURFACE_RELEASE_STATES`、`ALPHA_SURFACE_*` env 覆盖、
userData pin、`surfaces.resolve` IPC、renderer 三处 `mode !== "alpha"` 闸门、ledger 的
`fallback` 字段**全部删除**;`SurfaceId` 只作 SurfaceBoundary 与失败诊断的稳定名字。
**逃生阀连同崩溃回退一并删**(无真实用户、无向后兼容):致命路径按 AC4 进 Alpha Recovery。
旧版留下的 pin 字段读掉即弃,不改变 composition。ratchet 新增一条防回潮规则。
`docs/design/system/{patterns,replacing-opencode}.md` 里描述该机器的段落已同步改写;
`docs/design/2026-07-24-session-seam-baseline.md` 中"`ALPHA_SURFACE_SESSION` / pin 是启动期
逃生阀"的表述**自本次交付起作废**(该稿是当时事实的记录,不回改)。

**明确未做(与计划的偏离)** —— `packages/desktop/src/main/index.ts` 的
`setAsDefaultProtocolClient("opencode")` **保持不动**。`packages/desktop` 相对 `origin/dev`
的 alpha delta 恒为 0(上游外壳的参照副本,alpha 出货的是 `packages/ui-mac`),它也不依赖
ui-mac —— 让上游外壳反向 import alpha 清单是依赖倒置,且首次改动会在 `packages/{app,ui}` 的
补丁 SOT 之外制造一处长期 sync 冲突面。alpha 真正出货的外壳
(`packages/ui-mac/src/main/index.ts`)早已 `DEEP_LINK_SCHEMES.forEach(...)` 从清单派生,
ratchet 也扫得到它。
