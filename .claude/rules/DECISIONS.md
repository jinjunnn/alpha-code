# 决策日志(DECISIONS)

> 架构决策记录(ADR)。每做一个重要决策就在顶部插一条。不删除,只追加"撤回/修订"记录。

---

## ADR-009: 桌面端默认对所有 provider 放开 websearch;alpha.env 作后续秘钥落点,不做前端入口
**日期**:2026-06-18
**状态**:✅ 采纳(实现 POSITIONING 的"优化 Mac 体验 / 自有后端能力";服从 ADR-005 只增不改、ADR-006 运行时心智、ADR-002 后端接缝)
**复盘状态**:未复盘

### 背景
opencode 的 `websearch` 工具(Exa/Parallel 后端)默认只发给官方 `opencode`(Zen)provider:`packages/opencode/src/tool/registry.ts` 的 `webSearchEnabled()` 仅在 `providerID === "opencode"` 或 `OPENCODE_ENABLE_EXA`/`OPENCODE_ENABLE_PARALLEL` flag 为真时返回 true。用户用 DeepSeek 等第三方 provider 时,agent 只有 `webfetch`、拿不到 `websearch`。该工具执行时由 sidecar **直连** `mcp.exa.ai`/`search.parallel.ai`,**不带任何 opencode 鉴权**;`EXA_API_KEY`/`PARALLEL_API_KEY` 为可选,仅用于避开公共端点限流。(对比:Claude Code 自带的 WebSearch 是 Anthropic 第一方、服务端执行的工具,第三方 provider 享受不到——故只能靠这个本地工具补齐。)

### 决策(全部落在 alpha 自有文件,零改 upstream)
1. **默认放开**:`packages/ui-mac/src/main/server.ts` 的 `preferAppEnv()` 注入 `OPENCODE_ENABLE_EXA`(默认 `"1"`),经 `createSidecarEnv()`(process.env 整份拷贝)进 sidecar → `flags.exa` 恒真 → `webSearchEnabled` 对**任意 provider** 返回 true。**不改 `registry.ts` 闸门**(upstream)。
2. **不做前端入口**:不在 opencode 设置弹窗(`packages/app`,upstream)注入,也不建自有 key 设置 UI。终端用户默认拿到 keyless+限流的 websearch,够用即可。
3. **秘钥基础设施(保留待用)**:新增 `packages/ui-mac/src/main/alpha-secrets.ts`,启动时把 `alpha.env`(`KEY=VALUE`,候选路径 `$ALPHA_ENV_FILE` → `<userData>/alpha.env` → `<cwd>/alpha.env`)灌进 `process.env`,**不覆盖已有变量**(shell export 优先)。对终端用户隐形(文件不存在即跳过),作为**后续"用户秘钥落点"的基础**。`alpha.env` 已入 `packages/ui-mac/.gitignore`。
4. **逃生开关**:`ALPHA_WEBSEARCH_DISABLE=1`(不强制开)、`OPENCODE_ENABLE_EXA=0`(显式关)、`ALPHA_SECRETS_DISABLE=1`(不读秘钥文件)。

### 后果
- ✅ 第三方 provider(DeepSeek 等)开箱即有 websearch,零用户配置;零改 upstream(`git diff` 仅含 `ui-mac`/`ext` 等自有文件),ui-mac typecheck 通过。
- ⚠️ 无 key 时走公共端点,**会限流/降质**——已接受;重度使用可在 `alpha.env` 填 `EXA_API_KEY`。
- ⚠️ 公共 Exa 端点"无 key 可用"是从源码读出(key 为可选 query 参数),**尚未运行时实测**确认 keyless 必返结果。
- 🔭 后续:用户计划自有 websearch tool(ADR-002 路径:`.opencode/tool/*` 需按 ADR-006 预 bundle / `@alpha-code/ext` / MCP / ALPHA sidecar 代发);上线时用 `ALPHA_WEBSEARCH_DISABLE=1` 关掉 Exa 默认或给自有工具换名,避免两个 websearch 撞车。

### 关联
服从 ADR-005(只增不改)、ADR-006(运行时心智:env 经 sidecar 继承)、ADR-002(自有后端走 tool/plugin/MCP/sidecar);实现 POSITIONING 的"优化 Mac 展示逻辑 / 自有后端能力"。

---

## ADR-008: Codex 风格左边栏 —— 自有组件经 AppInterface children + Portal 注入,数据走 SDK,CSS 接缝替换 V2 chrome
**日期**:2026-06-17
**状态**:✅ 采纳(实现 POSITIONING 的"独立前端 / 优化 Mac 展示逻辑";服从 ADR-003 B+A、ADR-005 只增不改、ADR-006 运行时心智)
**复盘状态**:未复盘

### 背景
用户要把顶部多标签(V2 titlebar tab-strip)换成 **Codex 风格固定左边栏**(可折叠):全局导航(新对话/搜索)→ 项目列表(每个可展开其会话)→ 会话;并把 "opencode" 字样换成 "ALPHA CODE"。

调研纠正了一个关键误解:opencode 的**富侧栏(头像 rail + 单项目面板)是 legacy 布局**;`newLayoutDesigns`(V2)反而是**极简壳**(只有 titlebar + main,titlebar 里带 tab-strip,无侧栏),其 home 也无大字 logo。`@opencode-ai/app` 的 `exports` 是**白名单**(`.`、`./updater` 等,无通配),故**无法** deep-import 它的 `useLayout/useSDK/useTabs` 等上下文。

### 决策(全部落在 `packages/ui-mac/*`,零改 upstream)
1. **挂载接缝**:自有 `<AlphaSidebar>` 作为 `AppInterface` 的 `children` 渲染(因此身处 Router + 全部 Provider 内,拿得到 `useNavigate`/`useLocation`/`useCommand`),再用 Solid `<Portal>` 把 DOM 投到 `document.body`(fixed 定位,逃出 opencode 偏移容器,但保留响应式上下文)。
2. **数据走 SDK**:`@opencode-ai/sdk/v2/client`(**必须是 `/client` 子路径**——`/v2` barrel 会带进 server 的 Node-only 依赖,renderer 打包即崩)。`project.list()` + 按目录 `session.list({directory})` + `event.subscribe()` SSE 实时增量。`list()` 默认 `throwOnError:false` → HTTP 4xx/5xx **不抛**,必须判 `{error}` 否则会把列表清空成"暂无项目"。
3. **替换 V2 chrome(CSS 接缝,scoped 于 `body[data-alpha-sidebar]`)**:把 opencode 自带的顶部/首页冗余 chrome 隐掉,侧栏独占导航。**上游耦合点**(upstream 改名只会"外观回退",绝不冲突,sync 后重指即可):
   - `header div:has(> [data-slot="titlebar-tabs"])`(`components/titlebar.tsx`)——隐藏整条顶部 cluster(home 按钮 + session tab-strip + 新建 +);用户要求顶部彻底无 session chrome,故**始终**隐藏(非仅 open 态),折叠靠 reveal 按钮 + 品牌 logo 兼作 home。
   - `.relative.bg-v2-background-bg-deep.flex-1`(`pages/layout.tsx` V2 fallback 外层)——`padding-left` 右移 titlebar+main(仅 `="open"`)。
   - `[class*="grid-cols-[280px"] > aside`(`pages/home.tsx` HomeDesign)——隐藏首页左侧 280px 项目列(已在侧栏),并把 grid 改单列;设置/帮助移入侧栏 footer。
   - `svg[viewBox="0 0 234 42"]`(`@opencode-ai/ui` 的 `Logo` 字标)——全局隐藏 opencode 像素字标,顺带消除冷启动时旧主页字标的一瞬闪现。
   导航项 = 新对话/搜索/插件/自动化(插件→`mcp.toggle`,自动化无 opencode 后端、占位 dead button)。
4. **强制 V2**:主进程 `alpha-defaults.ts` 在 renderer 读取前**一次性**把 `settings.v3.general.newLayoutDesigns` 置 `true`(electron-store `default.dat`,纯 JSON);`ALPHA_LEGACY_LAYOUT=1` 可关。
5. **品牌**:侧栏头部用 α `Mark` + "ALPHA CODE";V2 home/侧栏的自我指代文案已被 ADR-007 transform 覆盖,另修了 ui-mac 自有 zh i18n 的两处 "OpenCode"→"alpha-code"。

### 后果
- ✅ 深度定制 UI,**零改 upstream**(`git diff packages/app|ui|core|server|sdk` = 空);typecheck/打包通过。
- ✅ 升级隔离:破坏面 = 上述两个 CSS 选择器 + base64 路由编码 + SDK 契约,均为**外观级**可恢复,非 merge 冲突。
- ⚠️ 数据是 SDK 薄重取(SSE 实时),不复用 opencode 内部 session store——符合 ADR-003(SDK 为契约)。
- ⚠️ "插件/自动化"无 opencode 后端(插件→`mcp.toggle`,自动化占位);终端/审查 toggle 经 `command.trigger("terminal.toggle"/"review.toggle")` 触发(命令为契约),不直读 panel 开合状态。

### 修订(2026-06-17):顶栏自有工具条 + 第二个 build-time transform
- **顶栏不再 blanket-hide**:顶部左侧自有工具条([收纳侧栏][首页][后退/前进],Portal 固定)、右侧自有工具条([终端][审查],仅会话内显示),均为自有 DOM;额外隐藏 opencode 顶栏的 `#opencode-titlebar-right [aria-controls="review-panel"]`(用自有审查 toggle 取代)。导航(后退/前进)走 `useNavigate(±1)`。
- **新增 `ui-mac/scripts/patch-upstream.ts`**(与 brand-i18n 同机制的第二个 build-time 源码 transform):对 upstream 文件做精确子串替换、磁盘不动、miss 即 warn。当前两条:`session.tsx` 把 chat 面板 `innerWidth*0.45`→`*0.7`(让审查面板可拖到 ~30%);`layout.tsx` 把 `DEFAULT_SESSION_WIDTH=600`→按窗口 `innerWidth*0.64`(审查面板默认 ~36% 而非满屏)。**这是除 CSS/Portal 外、唯一能改 JS 内联 `style={{width}}` 行为的合规途径**(ADR-007)。新耦合点:这两条子串 + 上述 aria-controls 选择器,upstream 改动只会外观回退、有 warn 兜底。

### 修订(2026-06-17):侧栏 live 数据走 `/global/event`、新会话即时创建、项目 ⋯ 归档/移除(客户端 hide)
排查"点 + 不出现新 session / 选新目录不出现新项目"时,定位到三个上游事实(经多 agent 调研 + 源码核对):
1. **`/api/event`(`client.event.subscribe`)按 `location.directory` 过滤**(`server handlers/event.ts`)——单条全局订阅只能收到默认目录的事件,其它目录的 `session.created`/`project.updated` 被丢。**改用 `/global/event`(`client.global.event()`)——跨目录不过滤的 firehose**(payload = `{directory, project, payload:{type,properties}}`)。这是单订阅能让所有项目 live 的唯一途径。
2. **项目仅在其首个 session 创建时落库**(`core/session.ts` `V2Session.create` 里 `insert(ProjectTable)`),且 `project.updated` 兼作"创建"信号(无 `project.created`)。**非 git 的独立目录会折叠进 `id:"global"`(worktree `/`)单一桶**(`core/project.ts` `resolve`)——故选普通文件夹不会生成同名新项目,只进"全局"。这是 opencode 设计,如实呈现(全局项目显示为"全局")。
3. **opencode 无"删除/归档项目"的 server 接口**(只有 `project.update` 改名/图标、`projectCopy.remove` 删副本目录)。故 ⋯ 菜单的**归档/移除 = 纯客户端 hide**(`alpha.sidebar.hidden` localStorage 集合,渲染时 filter 掉),并提供"已归档(N)·全部恢复"保证可逆。
- 实现:`+`/新对话**即时 `client.session.create({directory})`** 后跳转(opencode 的 draft 是 tab,被本侧栏隐了 → 必须显式建会话才有侧栏条目;"New session - …"/空标题在侧栏显示为"新对话"占位)。会话↔项目改按 **`projectID`** 匹配(每个 Session/事件都带),目录为 fallback。
- 新耦合点(均 SDK 契约或外观级,sync 后不会 merge 冲突):`/global/event` 事件信封形状、`session.create`/`session.list(scope:"project")` 契约、worktree `"/"` 即全局的约定。

### 关联
服从 ADR-003/005/006/007;实现 GOALS 的"独立 Mac 前端骨架"与 POSITIONING 的"优化 Mac 展示逻辑"。

---

## ADR-007: 前端品牌化走 build-time transform,不原地改 upstream 字符串
**日期**:2026-06-15
**状态**:✅ 采纳(实现 POSITIONING 的"自有视觉/品牌";严格服从 ADR-005 只增不改)
**复盘状态**:未复盘

### 背景
要把 UI 里的 "OpenCode" 换成 "alpha-code"。但用户可见文案几乎全在 upstream:`packages/app/src/i18n/{en,zh,...}.ts`(en 约 40 处)+ ~245 个组件文件硬编码。app 的 `LanguageProvider`(`packages/app/src/context/language.tsx`)从**写死的 upstream import** 构建字典,`init` 只收 `{locale}`,**没有运行时 override 接缝**。两条朴素路都不行:① 原地改 upstream 字典 = 每次 `merge dev` 冲突,直接违背北极星;② bun 的 `patches/` 只能 patch **已安装的 npm 依赖**,改不了 `@opencode-ai/app` 这种 **workspace 源码包**。

并且很多 "OpenCode" 不是 app 品牌,而是真实事物名:`OpenCode Zen`(托管网关)、`opencode.json`(配置文件名)、`opencode.ai/zen`(URL)、"the OpenCode team"、`opencode` CLI 命令、WSL(仅 Windows)。盲替会变事实错误。

### 决策
品牌化分两类落点,**全部只增不改 upstream 磁盘文件**:

1. **自有 chrome:直接改**(都在 alpha 自有的 `ui-mac`)——`app.setName`/`APP_NAMES`、`windows.ts` 窗口标题、`index.html <title>`、ui-mac 自有 i18n 的 updater 文案、图标/splash/主题(ADR 无关的既有品牌层)。
2. **upstream 共享文案:build-time transform**——`ui-mac/scripts/brand-i18n.ts` 是一个 Vite 插件(`enforce:"pre"`),在 renderer 打包时按**精选清单**重写 `packages/app/src/i18n/{en,zh}.ts` 里的**app 自我指代**字符串。**磁盘上 git 跟踪的 upstream 源码一字节不动** → `merge dev` 永不冲突。清单**只改自我指代**,真实服务/团队/配置名/CLI/WSL 一律保留。upstream 改了某条文案 → 插件 `warn`(漂移信号),更新清单即可。
3. **agent 身份:全局 instruction 注入**——`sidecar.ts` 把 `alpha-identity.md` 写进 `userDataPath`(dev/打包路径都确定),并 merge 进 `OPENCODE_CONFIG_CONTENT.instructions`(opencode 对该 env 是**叠加**语义,不替换全局/项目配置,provider/auth 不受影响)。`ALPHA_IDENTITY_DISABLE` 可关。同一注入点是将来挂 `@alpha-code/ext`(`plugin:[...]`)的接缝。

### 后果
- ✅ 拿到"深度品牌化"的效果 + "零回滚/零冲突"的成本(B 的深度,A 的代价)。git-tracked upstream 保持 == `dev`。
- ✅ 全程不依赖 gitignore —— gitignore 只拦未跟踪新文件,对已跟踪的 upstream 文件无效;真正"防回滚"的是"根本不改它"。
- ⚠️ 覆盖面 = 精选清单(目前 en + zh 的 app 自我指代 9 条/locale)。其它语言、组件硬编码文案仍显示 OpenCode;按需往 `brand-i18n.ts` 的 map / 其它 i18n 文件扩展。
- ⚠️ transform 是基于精确子串;upstream 改文案会静默漏改(有 `warn` 兜底,非 `strict` 不阻断构建)。
- ⚠️ 身份注入给每个会话加少量 token;文本保持极简、只设产品名,避免影响 agent 行为。

### 关联
- 服从 ADR-005(只增不改)、ADR-004(升级零冲突守卫);与 ADR-006 共享 `OPENCODE_CONFIG_CONTENT` 注入接缝。
- 实现 POSITIONING 的"自有审美/独立前端"诉求,而不牺牲北极星。

---

## ADR-006: 两个运行时世界(bun 源码 vs Electron-Node bundle)—— 自有 ext 必须预 bundle
**日期**:2026-06-15
**状态**:✅ 采纳(**约束 ADR-002 后端扩展的实现方式;不改 ADR-003 的 Electron 模式**)
**复盘状态**:未复盘

### 背景
排查"桌面端聊天无任何反馈"时定位到:每条 prompt 都在服务端直接 Die,日志为
`prompt_async failed ... ERR_MODULE_NOT_FOUND: Cannot find module '.../packages/plugin/src/tool.js' imported from '.../packages/plugin/src/index.ts'`。
根因是 opencode 存在**两个运行时世界**,而我们的桌面端落在不同的那个:

- **bun 世界(原生)**:opencode 是 bun 项目(根 `packageManager: bun@1.3.14`;构建脚本 `#!/usr/bin/env bun` + `Bun.build`;分发的 `opencode` CLI 是 bun 可执行)。源码用 `nodenext` 写法 —— `.ts` 里 import 写 `./tool.js`(指"编译后的同名文件")。bun 能把 `.js` 自动解析到 `.ts`;tsc 编译后也对。
- **Node 世界(桌面端)**:Electron = Chromium + 自带 Node,没有 bun。`packages/ui-mac/src/main/server.ts` 用 `utilityProcess.fork(sidecar.js)` 派生 **Electron-Node** 子进程;sidecar `import("virtual:opencode-server")` 加载的是 `Bun.build({target:"node"})` **预编译好的** `../opencode/dist/node/node.js`。预编译 bundle 在 Node 里跑没问题(import 已内联)。

崩溃只发生在接缝:server **运行时动态加载**的、**不在 bundle 里**的**生 TS**(`.opencode/tool/*.ts`、`.opencode/plugin(s)/*`)。Electron-Node 会 type-strip 跑 `.ts`,但**不会**把 `./tool.js` 改写成 `./tool.ts` → 找不到文件 → Die。同一批文件 bun CLI 能跑,桌面端 Node 跑不了。触发场景:把 fork 仓库本身当项目打开(它带 opencode 维护者的 `.opencode/tool/*.ts`,都 `import { tool } from "@opencode-ai/plugin"`)。

### 决策(钉死的约束)
1. **运行时心智模型**:构建 / CLI / `bun run dev` 的任务运行器 = **bun**;**打包后的桌面运行时 = Electron-Node**,跑的是预编译 node bundle,不是源码。(`bun run dev` 里的 bun 只是任务运行器,真正的 server 子进程仍是 Electron-Node。)
2. **自有 ext 必须预 bundle**:任何会被 server **运行时动态加载**的自有代码(`@alpha-code/ext`、自有 `.opencode/{tool,plugin}`),**必须先打包成自包含 ESM JS**(用 bun build / esbuild `--bundle`,把 `@opencode-ai/plugin` 等依赖内联进去),**禁止**依赖运行时解析生 TS 或 `.js`→`.ts`。这与"server 自己先 bundle 再交给 Node"同构,是 G1 落地的硬前提。
3. **不把 sidecar 改成独立 bun 进程**:那样能让 bun 解析 `.js`→`.ts`,但要丢掉 Electron `utilityProcess` 的 IPC/生命周期集成、且运行时需备 bun。代价不划算,维持 ADR-003 的 Electron-Node 模式。除非将来有强需求,否则不走这条。
4. **使用须知**:不要把 fork 仓库(或 opencode 仓库)本身当工作项目打开 —— 它带 upstream 维护者的生 TS 工具会 crash。日常用 `/Users/tide/app` 下的真实项目即可(全局 `~/.config/opencode` 已验证干净)。

### 后果
- ✅ ext 走 bundle → 桌面端可加载;且全程**只增不改 upstream**(只约束自己的产物形态)。
- ✅ 心智模型清晰:不再误以为"桌面端跑 bun"。
- ⚠️ `@alpha-code/ext` 多一道 build/bundle 步骤(应进 `predev`/`prebuild` 与 CI)。
- ⚠️ opencode 维护者工具在桌面端崩溃是 **upstream 的运行时特性,不归我们修**;靠"别开 fork 仓库"规避,不写 patch(写了也会在 sync 时冲突)。

### 关联
- 约束 ADR-002(后端走 plugin/tool/MCP/sidecar)的**实现形态**;不动 ADR-003(前端 B+A + Electron)。
- 直接关系到 GOALS#G1(后端隔离扩展跑通)的成功条件 —— ext 必须以 bundle 形态被运行时发现并 execute。

---

## ADR-005: 架构 pivot —— 从 submodule 隔离改为 fork + 只增不改
**日期**:2026-06-14
**状态**:✅ 采纳(**取代 ADR-001 的 submodule 机制;ADR-002/003 的扩展/前端策略仍有效**)
**复盘状态**:未复盘

### 背景
ADR-001 把 opencode 作 submodule、自有代码在其外。实践中这套"workspace 外复用"持续踩坑:`@opencode-ai/{app,ui}` 只能 symlink + vite alias(alias 绕过 `exports` map → 深子路径如 `/index.css` 解析失败)、solid-js 双实例、Tailwind content-scan 扫不到 app 源码 → **production 构建产出 0 字节 CSS(UI 散架)**。根因:自有前端不是 opencode workspace 的原生成员。用户已在 GitHub 建好 fork `jinjunnn/alpha-code`。

### 决策
改用 **fork 模型**:本仓库 = `anomalyco/opencode` 的 fork;自有包(`packages/ext`、`packages/ui-mac`)是**原生 workspace 成员**。
- 分支:`dev` = upstream 纯镜像(fast-forward);`alpha` = `dev` + 自有新增(产品分支)。
- 同步:`.github/workflows/sync-upstream.yml` 每天同步 dev → merge 进 alpha。
- **铁律(取代"submodule 只读")**:**只新增文件,从不编辑 opencode 既有文件** → fork-sync 永远零冲突,同时拿到原生构建。

### 后果
- ✅ 原生构建:`ui-mac` 镜像 `packages/desktop`,`@opencode-ai/*` 走 `workspace:*`/`catalog:`,**无 symlink/alias/dedupe hack**。实测 production 产出 475KB CSS(此前 0)、Electron 原生起窗。
- ✅ 升级仍干净:只增不改 → merge dev 零冲突。北极星(冲突文件数=0)不变,守卫从"submodule diff 为空"变为"alpha 相对 dev 的 diff 只含新增文件"。
- ⚠️ 代价:仓库带 opencode 全历史(NON_GOALS#3 原"不维护硬分叉"已据此修订为"维护 fork 但守只增纪律")。
- ⚠️ electron 在非 hoisted workspace 里 electron-vite 解析不到 → 需 `ELECTRON_EXEC_PATH`(已记录于 ALPHA.md)。

### 撤回/修订记录
- 取代 ADR-001 的"submodule + 自有代码在外"机制。ADR-001 保留作历史。

---

## ADR-004: 升级隔离纪律 — CI 守卫 opencode 源码零改动
**日期**:2026-06-14
**状态**:🔄 试行
**复盘状态**:未复盘

### 背景
隔离架构的成败取决于"没人偷偷改 opencode 源码"。需要机械守卫,不能靠自觉。

### 决策
1. `opencode/` 为 git submodule,钉死 commit `7efade2`。
2. CI/pre-push 检查:`git -C opencode status --porcelain` 为空,且 submodule 指针只能整体跳 ref(不能有工作树改动)。
3. 升级流程:切 submodule 新 ref → review `packages/sdk/openapi.json` 与 `packages/plugin/src/index.ts`、`tui.ts` 三处契约 diff → bump 自有依赖版本 → 跑 `bun turbo typecheck` → 记录到 `docs/retros/`。

### 后果
- ✅ 升级摩擦可量化、可守卫。
- ⚠️ 唯一例外(新增 /api 路由)必须走 `patches/` 补丁层,且补丁失效会 loud-fail。

---

## ADR-003: 前端走 B+A(挂 AppInterface + 自定义 Platform + token 换肤),保留 Electron
**日期**:2026-06-14
**状态**:✅ 采纳
**复盘状态**:未复盘

### 背景
要"独立 UI",但官方 `@opencode-ai/app` 已含 300 文件的 state/sync/SSE/permission/diff 层。三档可选:A 仅换肤 / B 复用渲染器换外壳 / C 全新 SDK 渲染器。

### 考虑的方案
- 方案 A:只覆盖 CSS token。改不了布局,算不上独立 UI。
- 方案 B:挂 `AppInterface`(`packages/app/src/app.tsx` ~L380)+ 自定义 `Platform`(`context/platform.tsx`,~40 方法的单一 host 接缝),复用全部状态层,屏幕逐个替换。
- 方案 C:只依赖 `@opencode-ai/sdk` 自建一切。最干净边界,但要重写状态层,成本最大。

### 决策
选择 **B + A**(用户拍板):挂 `AppInterface` + 自定义 `Platform` + token 主题,屏幕按需逐个替换;Mac 外壳**保留 Electron**,复用 `packages/desktop` 的 sidecar + `window.api` 模式。

### 后果
- ✅ 最快起步,白嫖状态/同步/事件层,升级摩擦小。
- ✅ 保留向 C 渐进迁移的路(逐屏替换)。
- ⚠️ 若改官方 `pages/*` 屏幕视觉,会在升级时重新 merge 大文件——故视觉改造优先走 token + 自有组件,不改 `pages/*` 内部。
- ⚠️ 复用 app/ui + 内嵌 server 需从 submodule **源码构建**(它们 private)。

---

## ADR-002: 后端走 plugin/tool/MCP/sidecar,绝不 fork server 路由
**日期**:2026-06-14
**状态**:✅ 采纳
**复盘状态**:未复盘

### 背景
opencode `server` 路由是 `HttpApi.make(...).add(Group)` 编译期静态组装,**插件层无挂路由口子**。新增 HTTP 接口要改 `api.ts`+`server.ts`(高 churn,升级必冲突)。但工具/hooks/MCP 都是零-fork 接缝。

### 决策
- 自有后端能力 = `@alpha-code/ext` 包(server plugin `{id, server}` + 自定义 tools)+ 必要时 MCP server,经 `.opencode/opencode.jsonc` 的 `plugin[]` / `mcp` 引用。
- 需要给自有 UI 的新 HTTP 接口 → **自有 sidecar 进程**(Hono/Bun),内部用 `@opencode-ai/sdk` 调 opencode。
- 仅当确需与官方同端口/同鉴权的 `/api/*` 路由时,才走 `patches/` 补丁层(见 ADR-004 例外)。

### 后果
- ✅ 后端定制零改 opencode 源码。
- ⚠️ 上下文注入目前只有 `experimental.chat.{system,messages}.transform`(core 的 `SystemContextRegistry` 不对外开放)——按 NON_GOALS#4 标注风险使用。

---

## ADR-001: opencode 以 pinned submodule 引入,自有代码在其外
**日期**:2026-06-14
**状态**:✅ 采纳
**复盘状态**:未复盘

### 背景
要既隔离又能继承升级。opencode 当前是 `anomalyco/opencode` 全量克隆。

### 考虑的方案
- 方案 A:vendored 目录(拷进来)。无版本追踪,升级靠手动。
- 方案 B:git submodule 钉死 ref,自有代码在 submodule 外。
- 方案 C:纯 npm 依赖 `@opencode-ai/*`。但 server/opencode 是 private,前端复用/内嵌 server 走不通。

### 决策
选择 **B**:`opencode/` = submodule @ `7efade2`(已就地注册,未重新下载)。自有代码全在 `packages/` 等同级目录。升级 = `git -C opencode checkout <ref>` + bump 契约版本。

### 后果
- ✅ 隔离 + 可追踪升级 + 可 diff 审查。
- ✅ opencode 当作只读上游,不在其历史里提交自有改动。
- ⚠️ upstream 只有 `dev` 分支、无 tag、正处 Effect 大迁移——pin 必须谨慎,升级前先看契约 diff。
