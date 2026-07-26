---
title: REQ-089 Alpha route manifest 成为唯一路由组合真相 — 路由架构基线
kind: design
status: active
owners: [alpha-code product and design maintainers]
last_reviewed: 2026-07-26
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
`route-upstream-shape.test.ts` 的锚点钉住。**整个消费端(含分发与导航目标)落在
`packages/app/src/pages/layout/deep-links.ts` 一个模块内**,ratchet 对该文件施加**全套**规则
(含「参数化 session href 归清单」);同目录其余文件是上游自有侧栏、合法写自己的路由字面量,
只施加 deep-link codec 类规则,那一层由 A 的 path 形状契约管。`layout.tsx` 只留调用适配器,
另有一条窄规则禁止它重新变回消费端(见下 §5.1 F7)。

**B2. 投递恰好一次(AC4)** —— 队列仲裁抽到 `packages/ui-mac/src/main/deep-link-queue.ts`:
renderer 首次 drain 之前(冷启动、首进程命令行、IPC 已订阅但初次 invoke 未回)一律入队;
drain 之后由该 renderer 接管、直发不入队。**所有权钉在「哪个 webContents 实例 drain 过」这个身份
上,不是「有没有窗口」**(见 §5.2 F1:布尔模型分不清崩溃后的 renderer 与活着的 renderer,而向
死掉的渲染进程 `send` 既不抛错也不到达)。四条退出路径 —— reload / `render-process-gone` /
`destroyed` / 被更新的窗口接管 —— 统一由 `trackRendererLifecycle` 在**窗口工厂**
`createMainWindow` 内接线,所以 `window.new` 菜单造出的窗口也必然被接线。renderer 侧
`deep-link-bridge.ts` 把事件降级为**无 payload 的唤醒信号**,buffer 是唯一队列 —— 消费只能靠
drain,drain 即清空,layout 重挂因此结构上无法重放。首进程 `process.argv` 现在也走同一条
`ingest`(Windows/Linux 冷启动唯一入口)。

**C. legacy surface flag 硬切(§2「删 alias 层」落地,owner 2026-07-25 裁决)** ——
`SurfaceMode`/`SurfaceReleaseState`/`SURFACE_RELEASE_STATES`、`ALPHA_SURFACE_*` env 覆盖、
userData pin、`surfaces.resolve` IPC、renderer 三处 `mode !== "alpha"` 闸门、ledger 的
`fallback` 字段**全部删除**;`SurfaceId` 只作 SurfaceBoundary 与失败诊断的稳定名字。
**逃生阀连同崩溃回退一并删**(无真实用户、无向后兼容):致命路径按 AC4 进 Alpha Recovery。
旧版留下的 pin 字段读掉即弃,不改变 composition。ratchet 新增一条防回潮规则。
`docs/design/system/{patterns,replacing-opencode}.md` 里描述该机器的段落已同步改写;
`docs/design/2026-07-24-session-seam-baseline.md` 中"`ALPHA_SURFACE_SESSION` / pin 是启动期
逃生阀"的表述**自本次交付起作废**(该稿是当时事实的记录,不回改)。

**D. 安装包协议清单从 manifest 派生** —— `packages/ui-mac/electron-builder.config.ts`
三处 `schemes: ["opencode", "alpha-code"]` 改为 `[...DEEP_LINK_SCHEMES]`,`getConfig()` 改成
接 channel 参数以便被断言执行。冷启动能不能把 deep link 交给应用取决于**安装包元数据**而非
运行时注册,所以这条不是文本洁癖:清单改了而安装包没跟,操作系统根本不会把新协议交过来,
而全部运行时测试照常绿。

### §5.1 对抗审计驳回后的修正(2026-07-26)

首轮实现被 Codex 对抗审计判 NOT-MERGE(7 Major + 1 Minor)。以下两条**推翻上一轮的声明**,
其余为闸门有效性补强。

- **F3 —— 上一轮「明确未做:desktop 保持不动」的判断错误,已撤销。** 该判断只看了
  `packages/desktop` 与上游的 delta,漏了两个外壳**共用同一个
  `@opencode-ai/app` renderer**:本票把该 renderer 的接收契约从 `__OPENCODE__.deepLinks`
  (`string[]`)/`{urls}` 换成 `__alphaDeepLinks`(delivery)/无 payload 事件后,desktop 仍发旧
  形状 = 它的 deep-link 链路被本 PR **静默打断**(可编译、必丢事件)。三处
  `__OPENCODE__.deepLinks` 声明(app / desktop / ui-mac)一并删除 —— 化石类型正是让断链还能通过
  类型检查的东西。处置见 §5.2「desktop 的 deep-link 链路整条删除」。

- **F5 —— 上一轮「应用补丁后与 HEAD 零 diff」的声明不成立,判据已改为可机械执行。**
  `packages/app/vendor/opencode-ai-client-1.17.13.tgz` 在 pin 里不存在、被
  `packages/session-ui/package.json` 以 `file:` 直接依赖,而普通 `git diff` 不携带二进制内容。
  这不只是文档失真:`sync-upstream.yml` 的 `apply_alpha_frontend_delta` 会 `rm -rf packages/app`
  再从 pin 取回,补丁没带二进制 = **每晚 sync 都会把这个包删掉**。SOT 已用
  `git diff --binary` 重生(93.5KB → 195.8KB,含 1 处 `GIT binary patch`),`frontend/README.md`
  的生成命令与 round-trip 判据同步改写为「从 pin 的 archive 建干净树 → apply → `diff -r` 零输出
  且 tgz 存在」(**不能在本仓 `git checkout $PIN -- ...` 上验:它不会删掉 pin 里没有的文件,
  会把缺口掩盖成绿**),sync workflow 加 `--binary` 与 tgz 存在性 loud-fail。

- **F1/F2/F4/F6/F7** 见上文 B2 / D / A 的对应描述;**F8**(patch 的 17 处尾随空白卡
  `git diff --check`)通过 `.gitattributes` 的 `frontend/alpha-patches/*.patch -whitespace` 解决 ——
  unified diff 的空 context 行本就是「一个空格」,其内容的空白在 `packages/{app,ui}` 源头受检。

**闸门有效性**:本轮三个新闸门(路由形状 / deep-link 消费端 / 协议清单)以及 exactly-once
状态机,均按仓内 2026-07-25 固化的纪律**逐条实施绕过变异并确认变红**后才保留;变异清单与结果
随 PR 记录。其中 F6 的形状比较从「全局集合」改为「按互斥 feature branch 分别比较」,正是因为
全局集合看不见路由在两条分支之间搬家。

### §5.2 第二轮对抗审计(R2)驳回后的修正(2026-07-26)

R2 判 §5.1 那一轮为 NOT-MERGE:R1 八条里 4 条仍未闭合,且修复增量自己引入一个 Major。本节
**推翻 §5.1 关于 F3 的处置**,并记录另外四条的重做。

- **desktop 的 deep-link 链路整条删除(owner 2026-07-26 裁决,推翻 §5.1 的 F3 修法)。**
  §5.1 让 `packages/desktop` 也去调 alpha 的 `decodeDeepLink` 与同一个 bridge,代价是**上游外壳
  依赖 alpha 外壳**的倒置。这笔账**第一天就到期了**:R2 在这条新链路上找到一个 Major(main 侧
  `emitDeepLinks` 同时写 `pendingDeepLinks` 与直发 IPC,renderer reload 后
  `consumeInitialDeepLinks()` 会把已消费的链接再放一次)。alpha 不出货 `packages/desktop`,
  让这条链路活着 = alpha 从此要为一个自己不出货的外壳的正确性负责。因此删除:main 侧
  `emitDeepLinks` / `pendingDeepLinks` / `consumeInitialDeepLinks` / `open-url` /
  `second-instance` 的 deep-link 分支 / `setAsDefaultProtocolClient("opencode")`,ipc 与 preload
  的 `consume-initial-deep-links`、`onDeepLink`、`sendDeepLinks`,renderer 侧的消费与 §5.1 加的
  那两个跨包 import,以及 `electron-builder.config.ts` 三个 channel 的 `protocols`,全部移除
  (6 文件,+6 / −68,净 −62 行)。那个 Major 随链路一起消失。
  安装包元数据是最后一处:运行时处理删了而 `schemes: ["opencode"]` 留着 = 「OS 唤起、应用丢
  URL」的新断链,而且它以**裸 scheme** 形态存在,`opencode://` 的 grep 看不见 —— 因此判据改成按
  形状扫(任何 `protocols`/`schemes` 键、任何 `x-scheme-handler` 串),钉在三 channel 的
  builder-config 测试里(+35 行)。
  顺带消除的既有问题:开发机上 desktop 与 ui-mac 争抢 `opencode://` 协议注册。
  **已接受的代价**:`sync-upstream.yml` 只 `rm -rf packages/app packages/ui`、**不擦
  `packages/desktop`**,所以这次删除不会每晚被 sync 冲掉;但上游改动同一区域时会产生一次合并
  冲突,由 sync 的 loud-fail 暴露、人工处置。

- **F1 exactly-once —— 所有权模型从「有没有窗口」改为「哪个 webContents drain 过」。**
  §5.1 的布尔所有权只在启动窗口的 `did-start-loading` 交还,漏两条真实路径:renderer 进程崩溃
  (`render-process-gone`)后窗口仍在、`isDestroyed()` 为假,`webContents.send` 既不抛错也不到达
  —— 链接被判定为已投递而实际丢失;`window.new` 菜单经 `createMainWindow` 造出的第二个 renderer
  完全未接线。现在队列持有**已 drain 且仍活着的 renderer id 栈**,`consumeInitial(rendererId)` 取得
  所有权,`deliver(rendererId, links)` 定向投递并在拒收时弹出该 owner 继续向下试,四条退出路径
  (reload / crash / destroyed / 被更新窗口接管)由 `trackRendererLifecycle` 统一接线,且接线点在
  **窗口工厂内部**,所以不存在「能 drain 却不会交还」的窗口。这些时序逐条是执行级测试。
  **所有权还不够:交给传输 ≠ renderer 拿到。**`webContents.send` 与 `invoke` 的回程都是异步的,
  在这一段里 reload/crash 会把 payload 连同错误一起吞掉。因此投递单位改为**带 id 的 batch**,两条
  传输(live send 与首次 drain)都**保留 main 侧副本直到该 renderer 回 ack**;持有者中途死亡 →
  batch 回队并向仍在的 owner 重试。幂等靠三条:batch 恒定只在 `pending`/`inFlight` 其一;只有被
  交付的那个 renderer 能 retire 它(伪 ack / 陈旧 ack 无效);ack 与 `rendererGone` 竞态时,晚到的
  ack 同样 retire 已回队的副本,所以结果与两条消息的到达顺序无关。renderer 侧再按 batch id 做
  **单文档去重**(reload 后新文档重新开始,所以该重投的仍会重投)。
  **残余边界(明示)**:ack 发生在 deliveries 落入 window buffer 之后。buffer 是同步派发的,布局
  已挂载时 ack 即等于「已消费」;若布局尚未挂载或 `enabled()` 仍为假,deliveries 停在 buffer 里,
  此时 reload 仍会丢。再往前推需要让 `packages/app` 侧的 drain 回 ack —— 那要在上游文件里新开一条
  跨包回线,本轮不做。**R4 把这条残余判为 Major(非 Blocker),已开窄票 #633 承接,见 §5.3。**

- **F5 README 逐字可执行。** R2 指出文档先 `cd packages/ui-mac`、后续却用根相对路径且
  `REPO=$(pwd)`,照抄执行必失败。现每个命令块自带 `set -e` 与
  `cd "$(git rev-parse --show-toplevel)"`,与当前工作目录无关;pin 由 `frontend-pin.lock` 读回,
  块之间不靠 shell 变量传递。二进制判据从「有没有随便一个 `*.tgz`」收紧为「`packages/session-ui`
  以 `file:` 直接依赖的那个精确文件存在」,README 与 `sync-upstream.yml` 同步。
  **写 pin 的位置本身是判据的一部分**:它必须排在**可能冲突的 `git apply --3way` 之前**。反过来
  排,冲突时 `set -e` 会跳过写 pin,而块 4 从 lock 读 pin 重生补丁 —— 补丁以旧 pin 为基底、裹进全部
  上游差异,round-trip 判据照样绿,月更却没升 pin。另补一个可复制的放弃块(`git restore
  --source=HEAD -SW`)把树退回上一个 pin。

- **F6 未声明 guard 全部 fail-closed。** 尾缀正则会把
  `someNewExperiment() && newLayoutDesigns()` 误读成纯 `newLayoutDesigns()`。改为**白名单精确
  匹配**(去空白后与声明文本逐字相等,允许单个前导 `!`):任何 `&&` / `||` / 三元组合一律抛错。

- **F7 消费端判据从文本改为执行。** 两轮收窄的文本规则仍被绕过(改 `navigate` 回调、或在传入
  前改写 delivery),说明**断言源码文本的闸门不是闸门**。消费端整体(drain + 分发 + 导航目标)
  抽成 `createDeepLinkConsumer(deps)` 留在受全套规则约束的 `deep-links.ts`;新增
  `route-deep-link-consumer.test.ts` **执行生产代码**:清单编码 → 清单解码 → 真实 consumer,
  断言观测到的导航目标 == 由清单独立派生的 href(并钉死字面值)。layout.tsx 里只剩 `navigate` 与
  `buffer` 两行原语传递,是执行判据够不到的唯一一段。
  这段兜底一开始只是「源码含这两行」的文本断言,而那不是闸门:保留两行、再用后置 spread 或重复键
  覆盖掉,或者把正确 consumer 晾着、另绑一个空函数给 `onMount`,都能绿。现在改为**结构判据**:
  把 deps 对象按顶层逗号解析成条目,spread / 计算键落进 `foreign`(必须为空)、键集合必须恰好是那
  五个(重复键因此暴露)、`navigate` 与 `buffer` 的值按归一化空白比对,并从调用点取出 `const` 绑定
  名,要求**同一个名字**既订阅了唤醒事件又在 mount 时被调用一次。空白与属性顺序因此自由,覆盖与
  脱钩不再自由;deps 若被提到别处组装则直接报错(那会把接线重新推出判据射程,是本判据存在的理由)。

### §5.3 第四轮对抗审计(R4)驳回后的修正(2026-07-26)

R4 判 R3 那一轮为 NOT-MERGE。F5 已判 FIXED 不再改动;下列三条闭合各自的可执行假绿或新竞态,
第四条是本轮**明确不做**的处置。

- **F1 —— 「交还给谁」按退出原因分岔,retire 按投递历史而非当前持有者。** R3 的
  `rendererGone()` 无论何种退出都立刻回队 + `flush()`,于是:owner 已消费、ack 还在路上时,main
  先处理它的 reload/crash → batch 立刻被改派给**另一个还开着的窗口**并改写 `handedTo` → 迟到的
  ack 因身份不匹配成为 no-op → 同一条链接被消费两次(R4 只读执行已观察到 batch 1 同时送到两个
  窗口)。`deliver` 返回 false 的分支同样只 `owners.pop()`,不回收该 renderer 既有的 `inFlight`,
  于是「不可达且 lifecycle 事件未到」时旧 batch 永久留在 `inFlight`,新 renderer 只拿到新的那批。
  现在:
  - reload(`did-start-loading`)与崩溃(`render-process-gone`)**保留 webContents id**,还会有
    新 document 来 drain,因此未 ack 的 batch **留在该 renderer 名下**等它自己的下一个 document
    —— 推给另一个正在运行的窗口既是重复消费,也把链接送进用户根本没在用的窗口;
  - `destroyed` 才注销 id(不会再有 document 在它下面 drain),此时才回队并向仍在的窗口重试;
    `deliver` 拒收视同 `destroyed`,回收它全部 `inFlight`;
  - `consumeInitial(rendererId)` 除了取 `pending`,还接管**任何当前持有者已不是活 owner** 的
    batch(含它自己跨 reload 留存的那些),所以留存不会变成滞留;
  - retire 的身份判据从「当前 `handedTo`」改为「**曾经**被交付给谁」的历史集合,已被改派的那份
    副本也能被原持有者的迟到 ack 关掉,一次重投不会变成一条重投链。
  `rendererGone` 因此多一个 `exit` 参数,由 `RENDERER_EXIT_BY_EVENT` 在 `trackRendererLifecycle`
  内部映射,调用方仍只有窗口工厂一处。三条时序各有一条执行级测试,并逐条单点回退确认变红。
  **仍在射程外**:`destroyed` 那一支的迟到 ack 无法阻止已经发出的重投(传输已经交付,没有撤回
  通道);该窗口连同它做过的事一起消失,所以重投是这一支的诚实选择,而不是可以两全的选择。

- **desktop 门禁 —— 按形状扫的键面补齐,并写清哪些**不**在射程内。** R4 给出可执行假绿:
  `mac.extendInfo.CFBundleURLTypes: [{ CFBundleURLSchemes: ["opencode"] }]` 是 electron-builder
  官方支持的 macOS 注册写法,却完全不含 `protocols`/`schemes`/`opencode://`,原扫描全绿。现在
  按形状扫的键集合为 `protocols` / `schemes` / `CFBundleURLTypes` / `CFBundleURLSchemes`(任意嵌套
  深度)+ 任意含 `x-scheme-handler` 的字符串;另加一条源码级断言:`packages/desktop` 内不得出现
  `setAsDefaultProtocolClient`(它绕过全部 config 元数据直接注册)。**明确记为本轮范围外**并写进
  测试注释:`nsis.include` / `nsis.script` **脚本内容**(config 里只是文件路径,判它需要解析外部
  脚本)、以及将来另一份经 `deb.fpm` / `rpm.fpm` 出货的 `.desktop` 内容(现只钉住既有那一份)。
  两者都是「真出现那天再补」,现在声称覆盖就是这个函数存在的理由所反对的那种假绿。

- **F7 —— 判据从「名字」改为「词法绑定」。** R3 的结构判据仍可绕:`const buildConsumer =
  createDeepLinkConsumer` 取别名(`calls` 只数文本 `createDeepLinkConsumer(`,别名调用不计),
  外层留一个 deps 完整、`foreign=[]` 的正确 consumer,`onMount` 内部再 `const consumeDeepLinks =
  buildConsumer({ 被改写的 deps })` —— `usage` 只按名字正则匹配、不解析作用域,于是把内层那个
  同名 const 误认成外层绑定。现在两条无例外的规则:工厂**只能被调用、不能被取别名**(import 段
  先按位置抹白,剩下的每一次出现都必须是调用;`import { X as Y }` 则落到「调用数不等于一」被拒),
  以及该 `const` 的标识符在**整份文件里只被绑定一次**(声明 / 函数与箭头形参 / catch 形参都算
  绑定)。R4 的完整构造作为变异用例施加到真实 `layout.tsx` 上确认变红,别名与遮蔽两半也各自
  单独确认。

- **A(ack 早于消费)—— 判为 Major,本轮不做,已开窄票 [#633]。** R4 的判定是:这是用户可见的
  静默功能失败(冷启动 deep link 在 layout 挂载前落进 window buffer,**仍立即 ack**,main 删副本,
  随后 sidecar respawn 的 reload 把 buffer 一起丢掉,用户看到普通首页),但只发生在这个窗口内、
  用户可重新触发、无持久数据破坏与安全问题,因此是 Major 而不是 Blocker。封死它要把 ack 推进到
  `packages/app` 侧 drain 的出口 —— 一条落在上游文件里的**新跨包回传线**,和本票的 main 侧仲裁
  是两件事。§5.2 末尾「残余边界(明示)」记的就是这条边界,现在它有了票号:#633,代码侧的注释
  钉在 `packages/ui-mac/src/renderer/index.tsx` 的 `acceptDeepLinks` 上。
