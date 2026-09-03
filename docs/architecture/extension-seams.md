# opencode 扩展接缝操作手册

> 来源:10-agent cartography 工作流(已逐条核实到文件)+ 主 Claude 独立复核 `plugin/src/index.ts`、`server/src/api.ts`。
> opencode:本仓 **fork**(`anomalyco/opencode`,`merge dev → alpha` 追平上游,ADR-005 —— 已取代原 submodule pin `7efade2`);`@opencode-ai/sdk` / `@opencode-ai/plugin` 随上游演进(npm 当前 `1.17.13`)。
> ⚠️ 本文产出于 submodule/pin 时期,下文若出现「submodule / 钉死 ref / checkout 新 ref」措辞,一律按 **fork + `git merge dev`** 理解(接缝模型本身不变)。

## A. 后端:零-fork 扩展(自有能力住在 opencode 源码之外)

所有项都被 opencode 运行时从配置目录自动发现(`.opencode/` 向上走到 git 根、全局配置目录、`~/.opencode`)。alpha-code 的做法:打成独立包 `@alpha-code/ext`,经 `.opencode/opencode.jsonc` 的 `plugin[]` / `mcp` 引用。

| # | 能力 | 落点(零 fork) | 状态 |
|---|---|---|---|
| 1 | 自定义**工具**(agent 可调) | `.opencode/tool/*.ts`,`import {tool} from "@opencode-ai/plugin"`,default export `tool({description, args, execute})`。发现于 `opencode/src/tool/registry.ts` glob `{tool,tools}/*.{js,ts}`。仓库范例:`.opencode/tool/github-pr-search.ts` | ✅ 确认 |
| 2 | **插件 hooks** | `.opencode/plugin(s)/*.ts` 或 config `plugin:["spec"\|["spec",opts]]`。加载于 `opencode/src/plugin/loader.ts`,调用于 `plugin/index.ts`。`server(input,options)=>Hooks` | ✅ 稳定 |
| 3 | **上下文注入** | `experimental.chat.system.transform`(改 system prompt 数组)/ `experimental.chat.messages.transform`(改整段历史);或 config `instructions` / `references`(本地目录/git 仓库→Reference Guidance) | ⚠️ experimental(注意 NON_GOALS#4) |
| 4 | **MCP server**(独立进程暴露 tools/resources/prompts) | config `mcp.servers`(`{type:"local",command}` 或 `{type:"remote",url,headers,oauth}`)。host 用 `@modelcontextprotocol/sdk` 桥接,合并进工具表 | ✅ 确认 |
| 5 | 声明式 agents/commands/skills/themes | `.opencode/{agent,command,skill,theme}/...`(themes 是 JSON) | ✅ |

**稳定 hooks 全集**:`tool`、`event`(观测全部 server 事件)、`config`、`auth`、`provider`、`chat.message`、`chat.params`、`chat.headers`、`permission.ask`(自动 allow/deny 策略)、`command.execute.before`、`tool.execute.before/after`、`tool.definition`(改写工具对 LLM 的描述与 `parameters`;**触发面 = 内置工具 + 插件工具,不含 MCP 工具**,见下)、`shell.env`、`dispose`。
> **`tool.definition` 够不到 MCP 工具(`#793` 实测,2026-09-03)。** 全仓只有一处触发点 ——
> `packages/opencode/src/tool/registry.ts:356` 的 `plugin.trigger("tool.definition", …)`,它住在
> `ToolRegistry.tools()` 里;而 `ToolRegistry.all()` 返回的是 `[...builtin, ...custom]`,`custom`
> 只装 `.opencode/tool/*` 与插件工具。MCP 工具走的是另一条路:`session/tools.ts` 的
> `for (const [key, entry] of Object.entries(yield* mcp.tools()))` 循环里由
> `McpCatalog.convertTool` 现场合成,**从不进 registry**。
> ⇒ 要改 MCP 工具交给模型的 `description` / `inputSchema`,`packages/ext` 这一层(L0)结构上做不到;
> 落点只能是 `session/tools.ts` 那个循环(已按 ADR-041 收编,`#793` 的修复即落在那里)。
> 两条独立检索轴:①`plugin.trigger("tool.definition"` 全仓 1 处;②`registry.ts` 的 `all()` 构成里
> 没有任何 `mcp.tools()`。

**PluginInput 给你**:`client`(连到运行中 server 的 `OpencodeClient`)、`project/directory/worktree`、`serverUrl`、`$`(Bun shell,完整宿主权限)、`experimental_workspace.register(type, adapter)`(自定义沙箱/工作区后端)。

### 唯一需 fork 的场景:新增 HTTP `/api/*` 路由
`server` 路由是 `HttpApi.make("server").add(Group)...` 编译期静态组装,插件层**没有挂路由的口子**。新增路由 = 改 `opencode/packages/opencode/src/server/routes/instance/httpapi/{api,server}.ts` + 新 `groups/handlers`。
**规避(按推荐序)**:① **自有 sidecar 服务**(自己的 Hono/Bun 进程,内部用 SDK 调 opencode)——最干净,零改源码;② 若"接口"本质是 agent 能力 → 做成 MCP tool;③ 工具/插件内 `fetch`/`$`/`client` 代理外部服务;④ 实在要同端口同鉴权的 `/api/*` → `patches/` 补丁层,单点插入(ADR-002 例外)。

## B. 前端:独立 Mac UI(已选 B+A)

后端契约干净稳定:SDK over HTTP + 单条 SSE + 仅 PTY 用裸 WS。渲染器只通过两个接缝对接后端:`createOpencodeClient`(唯一构造点 `app/src/utils/server.ts`)与 SSE 循环(`app/src/context/server-sdk.tsx`)。宿主集成全走注入的 `Platform` + `AppInterface` props。

**已选方案 B+A**:
- 挂 `AppInterface`(`app/src/app.tsx` ~L380):接受 `defaultServer`、`servers`、`router`(可注入 `MemoryRouter`)、`disableHealthCheck`、`children`。`Platform`(`app/src/context/platform.tsx`,~40 可选方法)是唯一宿主接缝。
- 复用**整个** state/sync/transport 层(`context/server-*.tsx`、`global-sync/*`)与全部屏幕;只自己管外壳/Platform。`packages/desktop/src/renderer/index.tsx` 就是范例:`<AppInterface defaultServer servers router={MemoryRouter}>` + 代理到 `window.api` 的 Platform。
- 换肤(A):opencode 组件零硬编码色,全读 `var(--token)`/`var(--v2-*)`;加主题 JSON 或覆盖 token,~250 个 token 由 `ui/src/theme/resolve.ts` 算法派生。**注意:token 只改颜色/间距/字体,改不了布局**。
- **视觉改造走自有组件,不改 `pages/*`**:`pages/layout.tsx`(~90KB)、`session.tsx`(~57KB)、`home.tsx`(~47KB)是高 churn 大文件,改它们=每次升级重 merge。要换屏幕,逐个用自有组件替换,别编辑官方屏幕内部。
- Mac 外壳保留 Electron:复用 desktop 的 sidecar 拉起 + Basic auth(`OPENCODE_SERVER_PASSWORD`)+ `oc://renderer` 协议 + `virtual:opencode-server` 内嵌(`desktop/electron.vite.config.ts`)。

### B2. alpha ui-mac 的 renderer↔main 信任接缝(自有面,REQ-104 #397 增)

自有 Mac 壳(`packages/ui-mac`)的 IPC 信任边界遵守与 desktop 相同的纪律(只新增 handler+preload 对,renderer 零路径/零 URL 输入权)。签名目录的策展消费(REQ-104)新增如下接缝,全部 fail-closed:

- **策展契约执行器**(`src/shared/catalog-curation.ts`):entry `curation` 对象的唯一采信入口(`decodeEntryCuration`;未知 schema/未知键/不变量失败 = 整体不采信),main 与 renderer 共用同一真源;契约 = alpha-web `contracts/catalog-intake/CONTRACT.md`,由 vendored testvectors(`src/shared/catalog-intake-contract/`)钉死防漂移。
- **只读 blob 通道**(`ext-curation-blob`,`src/main/curation-blobs.ts`):renderer 只给 `(catalogId, kind)`;entry/BlobRef/URL 全由 main 从已验 catalog 派生并按合同 §7.3 采信前置(bytes/sha256 精确匹配 + canonical 字节复验 + 剖面校验,拒重定向,5 MiB 帽)。失败不影响货架/启用判定。
- **session-grant 持久投影强制**(`src/main/ext-curation-policy.ts`):`activationPolicy=session-grant` 的记录持久 enabled 非法 —— 启动 reconcile 把此类账本记录**归位为 disabled**(mcp/agent/plugin/skill 四型;先于 skills 允许集派生,注入面同强制),安装/更新链的归位 = 账本 upsert **写点例外**(`UpsertInput.sessionGrantEnforced`:planner 在 curation 判定 session-grant 时给 receipt 模板打标,写点不以 prev enabled 复活、恒落 disabled —— 与 receipt 同原子,receipt 之前任何失败账本零副作用),持久 enable 在 `setInstallStateByKey` 被闸,解析两路分明(`#817`):legacy catalog record 要求解析到与安装身份 id/kind/name/version 精确对应的已验 **entry**(取不到即拒,会话级启用 = #408);**signed package child**(有效 V3 graph 节点命中 (kind,name) 或 claim 含 bundle owner)则按 exact graph/record 身份 + **(packageId, 已装 record.version) 双键**解析已验 **`packages[]`**,逐项核对 envelope/component/payload/manifest digest,mismatch/missing/delisted/security 一律 fail-closed 且**永不回退 entries**(package envelope 无 curation 字段 ⇒ 全匹配即诚实 uncurated 保守面,session-grant 分支按构造不触发)。oracle(已验 channel LKG → v1 缓存 → 随包补充)**区分「不可判定」与「空集」**:两级已验源都不可用且存在已启用 catalog 记录时,fail-closed 置 enforcementGap 阻断 sidecar,不以空集放行。

## C. 禁区(升级必冲突,永不编辑)
- `opencode/packages/core/**`(仅 `/public`、`/session/runner`、`/system-context` 稳定且仍在开发)
- `server/src/api.ts`、`handlers.ts`、`groups/**`(静态路由组装)
- `opencode/src/server/routes/instance/httpapi/{api,server}.ts` + `groups/handlers`
- `opencode/src/config/{config,paths}.ts`、`plugin/{loader,index,shared}.ts`、`tool/registry.ts`、`mcp/index.ts`、`index.ts`
- `packages/sdk/js/src/**`(生成)、`packages/sdk/openapi.json`(生成)
- `app/src/pages/**`、`context/server-sync.tsx`、`global-sync/**`、`server-sdk.tsx`、`utils/server.ts`(外包,别改)
- `ui/src/components/**`、`ui/src/v2/components/**`、`ui/src/theme/resolve.ts`、`ui/src/styles/theme.css`
- `desktop/src/main/ipc.ts`、`src/preload/**`(IPC 信任边界;保留 Electron 时只新增 handler+preload 对)
- `packages/plugin/src/**`(契约类型;只跟版本,别 fork)

## D. 升级隔离纪律
opencode 当前是 submodule(无 `.gitmodules` 改动、无 subtree),自有代码只在 `.opencode/` 与同级 `packages/`,与 `opencode/packages` 物理隔离。
- 钉死 ref(submodule),自有代码在外;升级 = checkout 新 ref + bump SDK/plugin 版本 + review `openapi.json` 与 `plugin/index.ts`/`tui.ts` 契约 diff。
- 不可避免的 fork → 集中到 `patches/`(`git format-patch` / `bun patch`),build 时应用,补丁失效 loud-fail;路由新增放**新文件** + `api.ts`/`server.ts` 单行插入。
- 锁工具链:消费 workspace 包时,`effect`/`@opentui/*` 0.3.4 等 catalog 版本要对齐;升级 gate 在 `bun turbo typecheck`。
- CI 守卫:`git diff opencode/packages` 非空即失败。

## E. 仍待你拍板的技术问题(cartography openQuestions 摘录)
1. 自有 UI 是否需要官方完整 state/sync 层(→ B 划算)还是窄表面(→ C 更省)?——**已选 B**。
2. 上下文注入用 `experimental.*`(无 fork 但 unstable)能否满足,还是需要一等 System Context source(今天需改 core)?
3. upstream `dev` 动多快、有无稳定 tag 可钉?——目前只有 `dev` 分支无 tag,pin 风险需关注。
