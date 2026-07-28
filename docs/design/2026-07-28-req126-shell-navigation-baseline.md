---
title: REQ-126 主干壳层导航基线 —— 新对话入口、覆盖层让位、壳命令处置、默认对话目录
kind: design
status: active
owners:
  - alpha-code product and design maintainers
last_reviewed: 2026-07-28
review_after: 2026-10-28
---

# REQ-126 方案基线(rev3):alpha 顶替上游叶之后,壳层职责无人继承

> 版本:rev1 → Codex 对抗审计判 BLOCK → rev2 → 收敛轮再判 BLOCK → **rev3(现行)**。
> 审计轮预算已用尽(2 轮,§7 有决定与残留风险)。按本版施工,不要按 rev1/rev2。

## 0. 触发

owner 2026-07-28 报告首页一组回归(原始编号保留,便于对账):

1. 点「新对话」出现闪烁,新对话面板最左侧闪出不该出现的内容,随即被新页面替换;
2. 打开「自动化」后再点具体 session 或「新对话」,自动化不关闭;
3. 「产物」页面应下线,产物的正确形态是 session timeline 中展示 + 右边栏打开;
4. 新对话页丢了选择/新增项目的能力,且默认对话目录不再是 `~/Alpha`(截图「新会话 — alpha-code」);
6. 「搜索」点了完全没反应(owner 已确认症状)。

**核心判断**:这不是五个独立 bug,是**同一类** —— REQ-085/086/125 把上游 `home` /
`new-session` / `session` 三个叶页面换成 alpha 自有 surface 之后,原来挂在这三个叶上的
**shell 级职责**(命令注册、新对话路由入口、覆盖层协调)没有被 alpha 重新承接。

两轮审计把这一类的真实规模挖了出来:**owner 报的「搜索坏了」只是这一类里唯一被点到的那个**;
且失效面**按路由而异**(同一个入口在 session 页可用、在首页/新对话页死),这正是"逐实例修"必然
漏掉的形状。因此本 REQ 的产物不是「修五个 bug」,而是把这一类处置完并留下按**入口**枚举的判据。

## 1. 只读勘破(地面真相)

行号对 `alpha` 分支 `99cc3036c`。`packages/app` 是上游 opencode 前端,alpha **只读不改**
(改它触 `UPSTREAM_PATHS`,north-star 闸门红)。

### 1.1 「新对话」走上游 legacy admission 路由 —— 双壳挂载确凿,视觉归因未证

- 侧栏 `newChat()` → `newSessionHref(dir)` = `/<b64dir>/session`
  (`sidebar/alpha-sidebar.tsx:612-616`、`sidebar/route.ts:28-30`);冷启动落地同路
  (`alpha-sidebar.tsx:571-577`)。
- `/:dir` 一族在**两种 layout 模式下都**挂在 `LegacyServerLayout` 之下(`app.tsx:772-789`),
  它 → `LegacyLayout`(`pages/layout.tsx:81`),后者渲染上游自己的**左侧** `SidebarContent`
  (`pages/layout.tsx:2210`)。
- 同一路由的叶(`createSessionRoute`,`app.tsx:210-226`)在 `params.id` 缺席时**先整套挂载**
  `SessionProviders` + alpha 会话工作区空态,同时 `createEffect` 调 `tabs.newDraft(...)`;后者
  自带 `navigate(draftHref(draftID))`(`context/tabs.tsx:211-224`)跳到 `/new-session?draftId=…`。
- **结论分层**:
  - **CONFIRMED**:一次「新对话」= 上游 legacy 壳 + alpha 会话工作区空态**都会挂载**,再被新会话
    页替换 —— 双壳挂载,不是纯视觉抖动。
  - **UNVERIFIED**:owner 看到的「最左侧的东西」是 legacy `SidebarContent` 还是 alpha 会话工作区
    空态,静态代码判不了。**归因由运行时捕获确认**(CODE-C 第一步)。
  - **修法与归因无关**:两个候选都只在 admission 那一跳产生,S1 去掉这一跳,两者同时消失。
- **与自家契约不一致**:`ROUTE_MANIFEST` 声明 `session-admission` 的 composition 是
  **redirect → `new-session`**(`shared/route-manifest.ts:125-148`),运行时却是「挂载 + 副作用跳转」。

### 1.2 覆盖层的关闭时机既不全也不准

- 关闭效果只写了定制中心一家(`alpha-sidebar.tsx:426-436`),自动化与产物没有。
- 且它只在 **`location.pathname` 变化**时关闭 —— **点当前会话、点已在的首页 URL 不变**,
  覆盖层不会关。owner 报的正是"点某一个具体 session"这个动作,所以"扩 route effect"**不足以**
  满足验收(rev2 在此处判错,rev3 订正)。
- 三个覆盖层各自一个模块级单例:`extensions/ext-hub-state.ts:6-43`、
  `automations/automation-state.ts:4-18`、`alpha-ui/artifact-workbench/workbench-state.ts:8-33`;
  互斥只写在三个 nav 按钮的 `onClick` 内联里(`alpha-sidebar.tsx:907-956`)。

### 1.3 产物工作台 vs 会话右栏 artifacts

- 全页 workbench 挂载 `renderer/index.tsx:510-513`,入口 `alpha-sidebar.tsx:938-956`。
- 右栏 artifacts 面板读同一 REQ-093/094 通道(`session-rail-artifacts.tsx:1-20,46-80`),但
  **只展示最新一次 run**,且**只在 mount/tick 时加载**(`session-rail-artifacts.tsx:35-64`)——
  cloud run 落盘后 watcher 并不通知它(`cloud-run-watcher.tsx:38-48`),**现状本就不自动刷新**。
  故「下线产物页」不会导致刷新退化;补刷新是**新能力**,归跟进票。
- 右栏 **import** 了 workbench 的 `workbench-core` 与 `renderers/*` → **模块不能删**。
- 拓扑还写在 `shared/frontend-surface-manifest.ts:125-141,186-196`、
  `dev/surface-map-inspector.tsx:15-17,47-55`、`docs/design/PAGE-MAP.md:47-60`。

### 1.4 新会话页丢了工作区选择器;默认目录不是默认对话目录

- `AlphaHome` 有完整 chip(`AlphaHome.tsx:34-50,129-197`);`AlphaNewSession` 只读
  `tabs.draft(draftId).directory` 拼标题(`alpha-new-session.tsx:27-32,57-70`),零选择能力。
- 目录来自侧栏 `mostRecentConcreteDir()`(`alpha-sidebar.tsx:550-562`)→ 故显示 `alpha-code`。
- 改目录能力现成:`tabs.updateDraft(draftID, { directory })`(`context/tabs.tsx:225-232`);
  但 draft 叶以 `server\0directory` keyed(`app.tsx:331-364`)→ **切目录 = 整叶重挂**,而 composer
  的文本/附件/mention 是组件本地状态,`AlphaNewSession` 只传一次 `initialText`
  (`alpha-new-session.tsx:61-72`)→ **切目录会无声清空用户已输入内容**。会话页 composer 早已为
  重挂做过 stash(`session-workspace/session-composer-dock.tsx:39-47`),新对话页没有。
- 供给:`ensureDefaultWorkspace` 调的 IPC **返回 `{ok:false}` 而不 throw**(`main/ipc.ts:186-189`),
  调用方 `try/catch` 后连返回值都不看(`sidebar/use-projects.ts:284-299`)→ 失败静默。
- **server / directory 必须同源**(审计 Major-2):默认对话目录 `~/Alpha` 由**主进程在宿主机**供给
  (`main/alpha-user-workspace.ts`),侧栏项目列表来自**本地 sidecar** client
  (`renderer/index.tsx:457-465`),而当前 server 可能是 WSL/remote(`wsl/connections.ts`、
  `packages/app/src/context/server.tsx`)。把「宿主机目录」配到「远端 server」上会开出一个该
  server 上不存在的目录。
- ADR-025 §3 现文字「既有用户有项目照旧(上次使用优先)」与 owner 2026-07-28 拍板冲突,需窄修订。

### 1.5 搜索 = 命令未注册的静默 no-op;且上游 palette 组件 alpha 拿不到

- 侧栏「搜索」→ `command.show()`(`alpha-sidebar.tsx:903`)→ `run("command.palette")`
  (`context/command.tsx:384-386`);`run` = `optionMap().get(id)?.onSelect?.(source)`
  (`command.tsx:378-381`)→ **未注册即静默返回**。
- `command.palette` 全仓只在 `pages/home.tsx:462`、`pages/new-session.tsx:112`、
  `pages/session.tsx:1141` 注册 —— 三个叶全部已被 alpha 顶替 → 全应用无人注册。无第四处、无兜底。
- **不能复用上游面板**:`DialogHomeCommandPaletteV2` 只在
  `packages/app/src/components/dialog-command-palette-v2.tsx:64` 内部导出,
  `packages/app/package.json` 的 `exports` 无该子路径、`src/index.ts` 也不导出 → alpha 无合法导入
  路径,改上游又触 north-star。
- **跳转必须带 server 身份**(审计 Major/rev3 新增):legacy `sessionHref(dir,id)` 在无既有 tab 映射
  时回退到**当前 active server**(`app.tsx:800-818`)—— 用本地 sidecar 的搜索结果配 legacy href,
  在当前 server 是 WSL/remote 时会把用户导到错误的服务器。必须用 server 限定的 canonical 路由。
- 上游三处 palette 语义本就不同(home 搜会话 / new-session 开文件选择 / session 触发 `file.open`);
  alpha 只承诺**搜会话并跳转**。

### 1.6 同一机制下已经静默失效的其余入口(两轮审计枚举,按路由分别判定)

alpha 自有 UI 上当前可点、但**在某些路由下点了什么都不会发生**的入口:

| alpha 入口 | 命令 | 注册处 | 现状 |
|---|---|---|---|
| 侧栏账户菜单「设置」`alpha-sidebar.tsx:251-262` | `settings.open` | `components/settings-dialog.tsx:37`,由 `pages/home.tsx:304` / `new-session.tsx:63` / `session.tsx:176` 调;**另有** `pages/layout.tsx:936`(legacy layout)与 canonical session 路由常驻的 `TargetSessionSettingsCommand`(`pages/session.tsx:159-178`) | **按路由分裂**:会话页**活**(TargetSessionRouteContent 仍挂),首页/新对话页**死**。这是接错线,不是无能力(alpha 另有 `platform.openSettings()`) |
| 新对话页右上角「终端 / 审查」`alpha-sidebar.tsx:843-879` | `terminal.toggle` / `review.toggle` | `pages/session/use-session-commands.tsx:498,513`(已随叶退役) | 死。会话页被 CSS 藏(`sidebar.css:669-671` 依赖 `[data-alpha-session-workspace]` 存在),而 `inWorkspace()` 在**新对话页**为真 → **新对话页这两个按钮可见且无效** |
| 空项目态「打开项目」`alpha-sidebar.tsx:1130-1139` | `project.open` | `pages/layout.tsx:903`(legacy layout,仅 admission 那一跳挂载) | 死 |
| composer 权限档位 `alpha-composer.tsx:258-264` | `permissions.autoaccept.enable` / `.disable` | 上游只有单个 `permissions.autoaccept`(`use-session-commands.tsx:586`) | 双重失效:ID 本就不存在 + 注册处已退役。**更严重**:提交层只对 `readonly` 生效(`composer-state.ts:192`),`full` 与 `ask` **完全同义** → 界面上的「全自动」档位是空承诺 |
| 桌面菜单「新建会话」及其余项 `packages/app/src/desktop-menu.ts:96-140` | `session.new`、`sidebar.toggle`、`fileTree.toggle`、`common.goBack/goForward`、`session.previous/next`、`project.previous/next` | 分散在 `use-session-commands.tsx` / `pages/layout.tsx` / `components/titlebar.tsx`(均随叶或 legacy layout 退役) | 需逐项判定;菜单项本身由 `packages/ui-mac/src/main/menu.ts` 发布,退休要从那里删 |
| 上游 titlebar 的 `home.toggle` / `tab.*`(`components/titlebar.tsx:376-450`) | — | 会话页因 `ownsTitlebar` 不再渲染上游 titlebar;**首页/新对话页仍渲染**(`pages/layout-new.tsx:19`) | 仅在会话页消失;是否需要 = 处置项 |

**这张表是本 REQ 最有价值的产出**,但它**不保证穷尽**(两轮审计各挖出新成员,见 §7 残留风险)。
因此 AC7 的判据写成**按入口枚举**而非按命令枚举:"alpha UI 上不得存在指向未注册命令的可点入口",
新入口天然进判据。处置三选一:**alpha 直接实现 / 明确退休(连入口一起删)/ 本次恢复**。

## 2. 选定方案与被否决的替代

### S1 新对话直接建 draft,不再借 legacy admission 路由

alpha 自有单一入口 `startDraft({ server, directory })`:等 `tabs.ready()` → 用**同源的
`{server, directory}` 对**调一次 `tabs.newDraft`(它自带跳转)。加最小 in-flight 去重防双击。
侧栏「新对话」与冷启动落地都走它。`useTabs` / `useServer` 经 `alpha-ui/providers.ts` 转口
(ADR-016 借用面单点)。

**同源规则**(fail-closed,最简形态):默认对话目录 `~/Alpha` 是宿主机目录,**只在 server = 本地
sidecar 时可用**;当前 server 为 WSL/remote 时,目录只能取该 server 上已知的项目,取不到就要求用户
显式选择,**不得**把宿主机路径配到远端 server 上。

- **不新增通用 admission 抽象**;`/:dir/session` 原样保留给**深链兼容**
  (`packages/app/src/pages/layout/deep-links.ts:77-86` 仍导航到该 href)。
- 被否决:CSS 隐藏 legacy 左栏(假闸门);admission 上盖 loading 遮罩(同样是遮);改上游让该路由
  直接 redirect(触 north-star)。

### S2 覆盖层:在导航**意图**处关闭 + route effect 兜底

**关闭时机双轨**(rev2 只做 route effect,被判漏 —— 点当前会话 URL 不变):

1. **主轨**:侧栏中一切"要去某处"的点击(具体会话 / 新对话 / 首页 / 项目行)在触发导航的同一处
   关闭全部覆盖层 —— 与目标是否等于当前路由无关;
2. **兜底轨**:保留并扩展现有 route effect(`pathname + search`),覆盖深链、程序化导航、
   自动化面板内回跳等非点击路径。

- **不新建** overlay union 状态机(rev1 的设计已被判过度工程并撤销)。
- 防漏靠**测试**而非架构:关闭测试对"当前登记的每个覆盖层 × 每类导航点击"参数化;新增覆盖层不
  加进列表即漏 —— 这一点明说,不假装架构能挡。

### S3 产物入口下线(owner:先只注释入口,能力差额记跟进票)

删入口(`alpha-sidebar.tsx:938-956`)、删全页挂载(`renderer/index.tsx:510-513`)、删
`cloud-run-watcher.tsx` 的 badge 调用(否则留一个永不归零的计数),**保留** workbench 模块
(右栏依赖其 core/renderers)。同步改 `frontend-surface-manifest.ts`、`dev/surface-map-inspector`
及其模型测试、`docs/design/PAGE-MAP.md`、`CHANGELOG.md` 的 `[Unreleased]`;历史 audit/verification
不动。

**退出条件只要求"不退化"**:右栏现状本就只在 mount/tick 刷新(§1.3),删 watcher badge 不改变它;
"新 run 落盘时右栏自动刷新"是**新能力**,归跟进票 —— rev2 把它写进 CODE-A 退出条件会让该票必然
溢出到右栏容器,已订正。

### S4 新会话页工作区选择器 + 默认对话目录 + **切目录不吞内容**

把 `AlphaHome` 的 chip 抽成 Home/NewSession 共用的受控组件(同源、无新视觉发明 → **不另出设计
稿**,视觉基线沿用已批首页稿)。选中 → `tabs.updateDraft(draftId, { directory })`;
「打开项目…」沿用 `openDirectoryPicker`。

**必含**:切目录会重挂整个 draft 叶 → 必须**保住 composer 已输入内容**(文本/附件/mention 完整
保存并恢复,形制照会话页现成的 remount stash),或退而在 composer 非空时禁止切换并明确提示。
**不允许无提示清空**。

默认目录:任何「开新对话」入口在用户未显式选择时 = **默认对话目录 `~/Alpha`**(受 S1 同源规则
约束);建 draft **前**先 ensure,且必须**检查 `{ok:false}` 返回值**(IPC 不 throw),失败 loud。

- ADR-025 §3 窄修订,附 owner 2026-07-28 拍板。
- 被否决:只改标题不给选择器;默认沿用最近项目(与拍板冲突)。

### S5 搜索:alpha 自有最小搜索 + alpha 壳注册 `command.palette`

alpha 自建**最小**搜索弹窗:输入即在已加载的 `AlphaProjectsApi.store.projects[].sessions` 上按
标题过滤,选中后**用结果来源 server 限定的 canonical 会话路由**跳转
(`/server/:serverKey/session/:id`,`route-manifest` 的 `session` 路由),**不用** legacy
`sessionHref(dir,id)` —— 后者在无 tab 映射时回退当前 active server(`app.tsx:800-818`),会把本地
结果导向错误服务器。alpha 壳**一处**注册 `command.palette`,侧栏按钮与既有快捷键都落到它。

- 边界:alpha 的 `command.palette` = **全局会话搜索**,不继承上游的文件搜索/命令执行语义。
- 被否决:把上游三叶挂回来(与 REQ-125 主权方向反向);深 import 上游内部组件(无导出路径)。

### S6 壳命令处置表(来自审计的 MISSING-CLASS)

对 §1.6 每一项做**显式处置**并落进文档:

- `settings.open`:**改接 alpha 自有设置面**(`platform.openSettings()` / `setSettingsOpen`),
  与路由无关 —— 现状"会话页活、首页死"正是接上游命令的后果;
- 新对话页「终端 / 审查」:该页无此能力 → **连按钮一起退休**(会话页工作区顶栏自有可用同类按钮);
- `project.open`:改走 alpha 目录选择 + `startDraft`;
- `permissions.autoaccept.*`:**最简闭合 = 退休无效的 `full` 档**(提交层只认 `readonly`,
  `full` 与 `ask` 同义,`composer-state.ts:192`)。若产品要保留「全自动」,则必须真接上 permission
  自动放行并断言"请求被自动放行 vs 弹出询问"的差异 —— 只断言 chip 选中态**修前即绿,是假闸门**;
- 桌面菜单各项:逐项恢复或从 `packages/ui-mac/src/main/menu.ts` 退休;
- 上游 titlebar `home.toggle` / `tab.*`:判定是否需要,不需要则显式记「不继承」。

**不要求把上游全部命令重新实现** —— 只处置「alpha 当前可见入口」与 AC 要求的能力,其余标
「不继承」并说明。这是本 REQ 的止损线,防止它膨胀成"复刻上游命令表"。

## 3. 不变量(整类边界,实现必须守住)

1. **入口不变量**:alpha 的新对话入口与冷启动落地不得进入 `session-admission`;
   `/:dir/session` 保留给深链兼容,不在本 REQ 处置。
2. **覆盖层不变量**:任何**导航意图**(含目标 = 当前路由)之后,所有覆盖层关闭;两个覆盖层不同时开。
3. **主权继承不变量**:alpha 顶替上游叶时,该叶承载的 shell 级注册必须**显式**判定继承/退休/恢复;
   **alpha UI 上不得存在指向未注册命令的可点入口**(按入口枚举,不按命令枚举)。
4. **server/directory 同源不变量**:draft 的 `{server, directory}` 必须同源;宿主机默认对话目录
   只配本地 sidecar server;跨 server 组合 fail-closed(要求显式选择)。
5. **默认目录不变量**:目标为默认对话目录时必然已供给;ensure 的 `{ok:false}` 必须被检查并 loud。
6. **不吞内容不变量**:任何导致 draft 叶重挂的操作(尤其切目录)不得无声丢弃用户已输入内容。
7. **闸门真实性**:每条闸门必须**挂载真实组件、断言可观察结果**。仓内既有的
   `settings-surface-ratchet.test.ts:47-60`、`route-composition.test.ts:56-72`、
   `surface-seam-contract.test.ts` 属**源码文本锚定**式断言,证明不了生产路由/注册生效,**不得**
   作为本 REQ 任何 AC 的证据。具体形制:
   - S1:挂真实 `AppInterface + AlphaSidebar`,点新对话,断言出现 `data-alpha-new-session` 之前
     从未出现 legacy sidebar 或 session workspace 的 DOM;
   - S2:挂真实覆盖层宿主,**对每类导航点击(含点当前会话)**断言其 DOM 消失;
   - S4:ensure 返回 `{ok:false}` → 断言未调 `tabs.newDraft` 且有提示;成功路径断言 ensure 先于
     newDraft 且目录为默认对话目录;切目录后断言 composer 内容仍在;
   - S5:断言跳转 href 带结果来源的 server 身份(不是 legacy href);
   - S6:逐入口真触发并断言可观察结果;权限档位若保留必须断言真实放行差异,不得断言 chip 选中态;
   - 「写完自己先绕一遍确认变红」是评审动作,不是 CI 能证明的产品不变量,不写进 AC。

## 4. 子票切分(按依赖排序;边界指名文件)

| 序 | 子票 | 边界 | out-of-scope | 退出条件 |
|---|---|---|---|---|
| 1 | CODE-A 产物入口下线 | `alpha-sidebar.tsx`(nav)、`renderer/index.tsx`(挂载)、`cloud-run-watcher.tsx`(badge 调用)、`workbench-state.ts`(badge 通道)、`shared/frontend-surface-manifest.ts`、`dev/surface-map-inspector` 及其模型测试、`docs/design/PAGE-MAP.md`、`CHANGELOG.md` | 删 workbench 模块本体;**右栏刷新能力(归跟进票)** | 入口与全页均不可达;右栏 artifacts 既有测试绿且行为**不退化**(现状即 mount/tick 刷新);拓扑文档与实现一致 |
| 2 | CODE-B 覆盖层随导航关闭 | `alpha-sidebar.tsx` 的导航点击处 + route effect;`ext-hub-state.ts` / `automation-state.ts` | 新建 overlay 状态机;覆盖层内部功能 | 覆盖层打开时点具体会话(**含当前会话**)/ 新对话 / 首页均关闭;测试对每个已登记覆盖层 × 每类点击参数化,挂真实宿主断言 DOM 消失 |
| 3 | CODE-C 新对话单一入口 `startDraft` | `alpha-sidebar.tsx`(newChat + 冷启动落地)、`alpha-ui/providers.ts`(转口 `useTabs`/`useServer`)、`sidebar/use-projects.ts`(ensure 返回值检查) | 新对话页 UI 与选择器(D 票);`/:dir/session` 路由本身(留给深链) | 新对话与冷启动都不经 admission;等 `tabs.ready()`;`{server,directory}` 同源(非本地 server 不配宿主机默认目录);连点两次只建一个 draft;ensure 失败 loud 且不建 draft;闸门按 §3.7 |
| 4 | CODE-D 新对话页工作区选择器(含内容保护) | `AlphaHome.tsx` 抽 chip、`alpha-new-session.tsx` 接入、`alpha-composer.tsx`(或等效最小保护);`ADR-025` §3 窄修订 | 首页布局改动;跨服务器工作区 | 可切项目/打开新目录并即时生效;**切目录后 composer 内容不丢**(或非空时明确拦截);未选时 chip 与标题显示默认对话目录;ADR 修订落库 |
| 5 | CODE-E 壳命令处置 | `alpha-sidebar.tsx`(设置项、终端/审查按钮、空态打开项目)、`alpha-composer.tsx`(权限档位)、`packages/ui-mac/src/main/menu.ts`(桌面菜单项发布面);处置表落进 `docs/architecture/upstream-integration.md` | 复刻上游命令表;标「不继承」的能力 | §1.6 每项有明确处置;**alpha UI 上不存在指向未注册命令的可点入口**(逐入口真触发断言,退休项断言 DOM 不存在);权限档位按 S6 最简闭合 |
| 6 | CODE-F alpha 自有会话搜索 | 新建 alpha 搜索弹窗 + 壳内注册 `command.palette`;`alpha-sidebar.tsx:903` 接线 | 文件搜索、命令执行、跨服务器检索 | 点搜索/快捷键都打开;输入标题能搜到会话并跳转;**跳转 href 带结果来源 server 身份**;注册 ratchet 挂真实壳断言可触发 |
| — | 跟进票(独立,不阻塞) | 右栏 artifacts 跨 run 浏览 / 云端 run 取回 / 落盘即刷新 | — | 另行登记 |

排序理由:CODE-A 先删产物覆盖层,CODE-B 就只需处理剩下两个;CODE-C 先立 `startDraft` 单一路径,
CODE-D 才在其上接选择器 —— 两票都碰 `alpha-sidebar.tsx` 与目录语义,顺序颠倒必然返工。

## 5. 文档影响

- 本基线(新增,rev3)。
- `.claude/rules/adrs/ADR-025-user-workspace-alpha-dir.md` §3 窄修订(默认对话目录)。
- `docs/design/PAGE-MAP.md`:产物页面下线、新对话页新增工作区选择器。
- `packages/ui-mac/src/shared/frontend-surface-manifest.ts`:相关 surface 的 lineage/target。
- `docs/architecture/upstream-integration.md`:§1.6 壳命令处置表(顶替上游叶时的继承纪律)。
- `CHANGELOG.md` `[Unreleased]`:产物入口下线属用户可见变更。

## 6. 风险登记

- **R1** 视觉归因未证(§1.1)——CODE-C 第一步先运行时捕获;修法与归因无关,不阻塞排期。
- **R2** 右栏 artifacts 只覆盖最新 run 且不自动刷新,产物页下线有真实能力差额(owner 已接受,跟进票)。
- **R3** 切目录重挂导致内容丢失(§1.4)——CODE-D 硬性验收项,不得降级为"已知问题"。
- **R4** 上游 pin 再 bump 时 `tabs.newDraft`/`updateDraft`/`useServer` 形状变化 —— 借用面经
  `providers.ts` 单点转口,失败模式是 typecheck 红而非静默。
- **R5** §1.6 处置表**不保证穷尽**:两轮审计各挖出新成员(第 2 轮还纠正了「设置」那行的事实)。
  判据按入口枚举,CODE-E 实现时以**运行时逐入口触发**为准,不以本表为完备性依据。
- **R6** WSL/remote server 语义:同源规则是 fail-closed 的最简形态,未覆盖"远端 server 也想要一个
  默认工作目录"的场景;真需要时另立需求,不在本 REQ 扩张。

## 7. 审计记录(Codex 跨模型对抗,2 轮,预算已用尽)

**第 1 轮 → BLOCK**:3 Blocker(上游 palette 组件不可导入 / 壳注册盘点不完整 / 切目录丢 composer
内容)+ 6 Major(单壳不变量与深链矛盾、S1 漏 `tabs.ready` 与 server authority、S2 union 过度工程、
S3 边界不完整、多条假闸门、回归风险枚举不足)+ 切分建议。→ rev2 逐条处置。

**第 2 轮(收敛轮)→ BLOCK**:Blocker-1/3、Major-1/3/4/6、Minor、切分建议判 FIXED;仍开:

| 结论 | rev3 处置 |
|---|---|
| Blocker-2 NOT-FIXED:§1.6 事实错误且不完整 | 已复核属实并订正:`settings.open` **按路由分裂**(会话页活/首页死,`pages/session.tsx:159-178` 常驻注册);补上桌面菜单其余命令与 titlebar 项;边界加 `main/menu.ts`;并加 R5 明说该表不保证穷尽 |
| Major-2 NOT-FIXED:server authority 只补一半 | 已加 §1.4 末段 + S1 同源规则 + 不变量 4 + R6 |
| Major-5 NOT-FIXED:S6 权限档位仍是假闸门 | 已复核属实(`composer-state.ts:192` 只认 `readonly`,`full`/`ask` 同义)→ S6 改为**最简闭合 = 退休 `full` 档**,保留则必须断言真实放行差异 |
| 新 Major:S2 只监听路由变化,点当前会话不关 | 已订正为双轨(导航意图处关闭 + route effect 兜底),§1.2 / S2 / 不变量 2 / CODE-B 同步 |
| 新 Major:CODE-A 的右栏刷新退出条件必然溢出 | 已订正:右栏现状本就不自动刷新,退出条件降为"不退化",刷新能力归跟进票 |
| 新 Major:S5 用 legacy href 会导向错误 server | 已订正为 server 限定 canonical 路由(§1.5 末 / S5 / CODE-F) |

**轮数决定**:审计预算定为 2 轮并已用尽。第 2 轮的所有 finding 都已在 rev3 落字,且其中三条经我方
独立复核确认(设置注册分裂、权限档位空承诺、右栏不自动刷新)。**残留风险 = R5**:处置表可能仍不
完备 —— 这正是 AC7 判据按"入口"而非"命令"枚举、并要求 CODE-E 运行时逐入口触发的原因。第 3 轮预期
只会再挖出同类新成员而不改变方案结构,故停在此处;若 owner 要求穷尽,应作为 CODE-E 的运行时枚举
工作,而不是再开一轮纸面审计。
