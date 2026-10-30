---
title: REQ-236 引擎生命周期基线 —— 令牌热续期、MCP 逐服务启动、Office 运行环境、上游同步隔离
kind: design
status: draft
owners:
  - Code Puppy desktop and runtime maintainers
last_reviewed: 2026-10-30
review_after: 2027-01-30
---

# REQ-236 引擎生命周期基线

登录着用 Code Puppy 的人,现在大约每十分钟会被后台悄悄重启一次引擎:登录凭证到期前自动续一次,
而每续一次,整个引擎就关掉重开。正在写的回答会断,刚批准过的「本次会话允许」会被清空,界面短暂
显示「正在同步…」。同一时间,Word/Excel/PowerPoint/PDF 四个文档工具在正式版里一直起不来,日志里
写的原因还是错的,让人以为是电脑没装某个工具。另外,我们每天自动并入开源引擎更新的任务已经连续
失败了 19 天,失败之前它还曾把上游改动悄悄混进我们自己接管的文件里。这份方案把这四件事改成:
续凭证不再重启、文档工具随应用自带运行环境并且一个工具坏了不拖累别的、上游更新碰到我们接管的
文件就停下来交给人审,不再静默合并。不做的话,上面这些中断和误报会照旧每天发生。

本文是 [REQ-236](https://github.com/jinjunnn/alpha-work/issues/118) T24 §2.2/§2.3/§2.5、T17 出货依赖
那一半、T07 引擎侧那一半的 L 级方案基线,以 [运行权威架构稿](codepuppy-runtime-authority.md) 为起点
(逐条复核见 §1.6)。源码基线:正式版 0.1.22 = `393a35c2a`(本 worktree 只多三份文档提交)。
`docs/architecture/constraints.md` 不存在(`ls docs/architecture/constraints.md` → `No such file or directory`),
本方案没有可对照的已登记偏离;它不新增偏离,对上游文件的每一处改动在 §2.7 归类。

**边界**:目录刷新调度、缓存采纳、模型状态合同、picker、REQ-237 归 `req236-catalog` lane。其冻结接口
(`docs/design/req236-catalog-and-model.md` §2.10,分支 `design/req236-catalog`)本文照用、不重复设计:
① 删除 `main/index.ts:1456-1458` 的 `await syncLiveAllowlist` 归它;② `requestCatalogRefresh(reason)` 同步返回
`void`、永不抛错,任何流程不得等它;③ `pinAppliedCatalog(userDataPath, generation)` 由 `spawnLocalServer` 在 fork
前调用,picker 与引擎只读这份「已应用」目录;④ `onDownloadedCatalogChanged(cb)` 默认无人订阅,新目录在下一次
引擎换代生效,不自动重启。本方案让普通续期**根本不再进入** respawn 链,因此不依赖①何时落地;热续期只改凭据
文件、不改模型配置,所以③「不 fork 的热应用必须经同一函数取钉住结果」的约束对它不适用(§2.1)。三档权限、来源
分类、配置受控字段归权限 lane;附件与各文件类型的用户可见说明归生图/产物/附件 lane;改名归品牌 lane。

## 1. 只读勘破

文中 `ui-mac`、`opencode`、`ext`、`plugin` 均指 `packages/` 下的包;未注明仓的坐标都在 alpha-code。

### 1.1 普通续期今天怎么走(T24 §2.2、T07)

链路(全部实读):

1. 续期提交:`ui-mac/src/main/alpha-auth.ts:891-913` 覆盖 `stored`(含 `mcpAccessToken`)、`tokenGeneration++`、
   置 `unappliedRenewalGeneration`、`applyAuthEnv()` 改写 main 的 `process.env`(`:298-331`:
   `model.invoke→ALPHA_API_KEY`、`cloud.dispatch→ALPHA_CLOUD_TOKEN`、`mcp_access→ALPHA_MCP_TOKEN`),再
   `publish()` —— 此时平台态已是 `recovering`(`deriveState` `:229-246`,判据在 `:237`)。
2. `refreshTokens`(`:716`)→ `awaitRotation`(`:735,765`)→ `onRenewed` = `main/index.ts:728`
   `tokenRotation.accept(result,"renewal")` → latch(`:280-296`,实现 `auth-renewal.ts:187-313`)→
   `respawn("token-only")`。
3. `doRespawnSidecar`(`index.ts:1448`)先 `await syncLiveAllowlist`(`:1458`,catalog lane 的),再
   `killSidecar`(`:228` stop 模式 `token-rotation`)、`spawnLocalServer`(`server.ts:467`,其中
   `:494 syncSecretFiles` 把三个变量写进 `<userData>/alpha-secrets/`)、`sessionGrantRegistry.beginSession`
   (`index.ts:1548`,会话授权从空集开始)。token-only 只是不 reload renderer(`sidecar-lifecycle.ts:5`)。

**频次实测**(owner 正式版当前这次运行):

```
$ grep -c 'main.sidecar.respawn.fork.start' ~/Library/Application\ Support/ai.opencode.desktop/logs/20261030T021718/startup-timeline.log   → 25
$ grep 'main.sidecar.respawn.fork.start' …/startup-timeline.log | grep -c token-only                                                    → 25
首行 2026-10-29 22:17:18,末行 2026-10-30 02:26:46;相邻两次 22:26:46 / 22:36:43
```

即约 4 小时 25 次、全部 `token-only`,每 10 分钟一次(TTL 15 分钟,`alpha-auth.ts:705` 注释)。
每一次都中断在途流、清会话授权;MCP 状态住在 sidecar 进程内存里(`mcp/index.ts:557` 的 `InstanceState`),
新进程从空开始,每个目录第一次 `mcp.*` 调用要重付一次全体初始化(§1.2)。catalog lane 另测得:同类 23 次
续期换代全部先等远端目录,均值 4.0 s,6 次等满 8 s(`req236-catalog-and-model.md` §1.1)。

**两个消费者各自怎么拿到凭据**:

- 模型请求:`ui-mac/src/main/alpha-models.ts:152` 注入 `provider.alpha.options.apiKey = {file:…/ALPHA_API_KEY}`;
  引擎在**装配置时**替换(`opencode/src/config/variable.ts:35-90`);`provider.ts` 的 InstanceState 持有
  `sdk` Map(`:1467`),按含 `apiKey` 的 options 哈希缓存 SDK(`:1839-1847`),`getLanguage` 再按
  `providerID/modelID` 缓存语言模型(`:1922`)。fork 之后凭据文件改了也不会被读。
- 云 MCP:ext 的 `config` 钩子 `installCloudMcp`(`ext/src/plugin.ts:161` → `cloud-websearch-kill.ts:411-449`)
  在装载时把 `Bearer {file:…ALPHA_MCP_TOKEN}` **解析成字面量**写回 `cfg.mcp.cloud`;引擎
  `mcp/index.ts:324` 以 `requestInit.headers` 交给 transport。

**发送边界的现成接缝(按装着的版本实读)**:

- 每次模型请求都在 `opencode/src/session/llm/request.ts:139-151` 触发 `chat.headers`,其结果在 `:224-227`
  **最后**合并进 `prepared.headers`,经 `session/llm.ts:356` 交给 `streamText({headers})`。
- `ai@6.0.168` 把请求头经 `withUserAgentSuffix` 归一成小写(`dist/index.mjs:4073`);
  `@ai-sdk/openai-compatible@2.0.41`(平台 provider 的 npm,`alpha-models.json` `platformProvider.npm`)
  把 `apiKey` 变成配置头 `Authorization`(`dist/index.mjs:1719-1723`),发送时
  `combineHeaders(this.config.headers(), options.headers)`(`:563,646`),`@ai-sdk/provider-utils@4.0.23`
  的 `normalizeHeaders` 小写化且后写者赢(`dist/index.mjs:551-571`)。⇒ 请求级 `authorization` 盖过 SDK
  缓存里的旧 key。(源码推导,未跑端到端,列入末节。)
- 覆盖面全称断言:

```
$ grep -rn "getLanguage(" packages/opencode/src            → agent/agent.ts:375、session/llm.ts:122 两处
$ grep -rln "Agent.generate\|agent.generate\|\.generate({" packages/opencode/src   → agent/agent.ts、cli/cmd/agent.ts
$ grep -rln "streamText\|generateText\|generateObject" packages/core/src packages/llm/src   → packages/llm/src/llm.ts
```

  `agent.ts:375` 的 `Agent.generate` 不经 `chat.headers`,但唯一调用方是 CLI(桌面不发 CLI);`llm.ts` 只服务
  `OPENCODE_EXPERIMENTAL_NATIVE_LLM` 原生运行时(`runtime-flags.ts:54`,默认关),而它同样吃 `prepared.headers`。
- 云 MCP:`@modelcontextprotocol/sdk@1.29.0` 的 `StreamableHTTPClientTransport._commonHeaders()`
  **每次请求**重读 `requestInit.headers`(`dist/esm/client/streamableHttp.js:58-77,327-338`),并接受 `fetch`
  选项(`:31`)。云端是无状态 MCP:每个请求按该请求的 Authorization 新建 server
  (alpha-platform `packages/gateway/src/cloud-mcp.ts:3,115`)。

**其它事实**:

- 秘密文件写法是截断后写(`alpha-secret-files.ts:95,113` `writeFileSync`),今天安全只因为写的时候没有读者
  (fork 之前)。热应用必须改成同目录临时文件 + rename。
- `ALPHA_CLOUD_TOKEN` 在 sidecar 内没有读者:

```
$ grep -rn '"ALPHA_CLOUD_TOKEN"' --include='*.ts' packages/ui-mac/src packages/ext/src packages/opencode/src | grep -v test
  → 只有 alpha-secret-files.ts:38(物化清单)与 alpha-auth.ts:118-119(写 env)
```

### 1.2 MCP 初始化的全体等待(T24 §2.3)

- `mcp/index.ts:557-623`:`InstanceState.make` 的 init 里 `Effect.forEach(…, {concurrency:"unbounded"})`
  对每个启用服务跑 `create`(connect + `tools/list`,`:432-493`),**全部完成后**才 `addFinalizer`(`:598`)并返回
  状态。init 中途被销毁时,已连上的 client 没有 finalizer 兜底。
- `tools()`(`:737-769`)、`instructions()`(`:686-697`)、`status()`(`:662-679`)都先 `InstanceState.get(state)`,
  于是 `session/tools.ts:480` 与 `session/system.ts:121-123` 等到最慢的服务。`status()` 对还没写入的键报
  `disabled`(`:671,675`)—— 一旦改成立即返回,进行中的服务会被误报成「已禁用」。
- 工具对象在广告时捕获 client:`session/tools.ts:482` → `mcp/catalog.ts:54` `client.callTool`。重连后旧工具对象
  拿着已关闭的 client。
- 一个 `timeout` 字段同时管连接、`tools/list` 与工具调用(`mcp/index.ts:335,419`;`catalog.ts:43-60`)。
  `ext-config.ts:460-521`(`index.ts:874` 每次启动调用)给**所有**缺 timeout 的本机 MCP 写入 5000 ms,
  理由正是「冷缓存会挡住约 29 秒」—— 它在用缩短总超时掩盖全体等待,并把 PDF 调用也压到 5 秒。
- 生命周期托管的先例:`project/bootstrap.ts:39-40` 明写「每个服务用 `Effect.forkScoped` 绑定自己的实例
  状态 scope 管理慢工作」,`snapshot/index.ts:765` 就在 `InstanceState.make` 的 init 里 `forkScoped`;
  `InstanceState.make` 的 scope 随 `ScopedCache.invalidate` 关闭(`effect/instance-state.ts:26-42`)。
- 核心启动(`project/bootstrap.ts:33-46`)不含 MCP;MCP 状态在首次 `mcp.*` 调用时才初始化。

### 1.3 Office/PDF 的 `spawn uv ENOENT`(T17 出货依赖那一半)

正式版配置里的四条(只打印命令字段):

```
$ python3 -I -c '…读 ~/Library/Application Support/ai.opencode.desktop/alpha-engine-config/opencode.json 的 mcp.alpha-*…'
alpha-word  ['uv','run','--no-project','--with','python-docx==1.2.0','/Applications/Code Puppy.app/Contents/Resources/office-mcp/server.py','word','{workspace}'] timeout 5000
alpha-excel / alpha-powerpoint / alpha-pdf 同形(依赖见 shared/office-advisories.ts:75-104)
```

引擎日志(`~/.local/share/opencode/log/opencode.log`)里**两种**失败,按实例目录分得开:

```
run=edbad669 creating instance directory=/private/var/folders/…/T/req105-ac4-ws-z8Agfn
run=edbad669 creating instance directory=/Users/tide/Alpha
run=edbad669 creating instance directory=/Users/tide/code-puppy
… key=alpha-word status=failed error="Operation timed out after 5000ms"   (×2)
… key=alpha-word status=failed error="spawn uv ENOENT"                     (×1)
$ ls -d /private/var/folders/9m/…/T/req105-ac4-ws-z8Agfn   → No such file or directory
```

run `71a56d7a`、`d70079b0`(issue 里引用的 23:44 那次)同样是在创建这个已不存在的临时目录实例之后报四条
ENOENT。Node 对**不存在的 cwd** 就报这句话,与「找不到 uv」逐字相同:

```
$ node v22.22.3 -e 'spawn("uv",["--version"],{cwd:"/nonexistent-dir-xyz",env:{PATH:"/opt/homebrew/bin:/usr/bin:/bin"}})'  → spawn uv ENOENT
  cwd=/tmp, PATH 无 uv                                                                                          → spawn uv ENOENT
  cwd=/tmp, PATH 含 /opt/homebrew/bin                                                                           → uv 0.10.10
```

`connectLocal` 正是把实例目录当 cwd(`mcp/index.ts:406-411`)。结论(强推断,未在打包应用内复现):这台机器上
的 ENOENT 是**陈旧实例目录**,不是 GUI PATH;另一类失败是 `uv run --with` 解析依赖 + 起 Python 超过注入的
5 秒。旁证:缓存的登录 shell PATH 含 `/opt/homebrew/bin`(`alpha-shell-env.json`,经 `server.ts:392-433` 合入),
`/opt/homebrew/bin/uv` 存在;`UV_CACHE_DIR` 已指向围栏内(`server.ts:536-537`),该目录实际 332 MB。

结构性缺陷仍成立,换一台机器就会咬人:

- 探测与 spawn 不同源:`ext-ipc.ts:90-100` 用 `which` + 补 `/opt/homebrew/bin` 等(`platform/darwin.ts:5,8`)只回
  布尔;spawn 传裸 `uv` 走 sidecar env 的 PATH(`sidecar-env.ts:32`)。登录 shell 探测失败的机器上探测说有、
  spawn 说没有。
- 首次运行要联网下包(出网登记 `network-egress-registry.ts:98-99`)、要一个 uv 托管的 Python。
- 命令形状被跨仓锁步:alpha-web `catalog-src/catalog.json:65,108,150,194`(`a253056`)逐字带 uv 命令,
  `ext-mcp-policy.ts:56-64` 要求卡片命令与 `alphaOfficeInstallCommand`(`office-advisories.ts:113-124`)逐 token 相同。
- `resources/office-mcp/server.py` 是自写的 stdio JSON-RPC server(`:41-117`),`tools_for()`(`:119`)纯标准库,
  格式库在工具函数里才 import(如 `:718`)⇒ 工具 schema 不装依赖也能导出。

体积实测(arm64,owner 机器上 uv 已下好的同一套):CPython 3.11.15 完整安装 78 MB
(`du -sh ~/.local/share/uv/python/cpython-3.11.15-macos-aarch64-none`);依赖 lxml 20 MB、PIL 13 MB、
reportlab 4.8 MB、docx 1.7 MB、pypdf 1.7 MB、pptx 1.4 MB、openpyxl 1.3 MB、xlsxwriter 0.9 MB,合计约 45 MB。
当前 `/Applications/Code Puppy.app` 为 492 MB。

### 1.4 上游同步(T24 §2.5)

- 接管清单只有一份数据:`scripts/north-star-guard.sh:118-191` 的 `UPSTREAM_EXCLUDES`
  (`grep -c "^  ':(exclude)" scripts/north-star-guard.sh` → 49);CI 直接跑这个脚本(`alpha-ci.yml:133`)。
  已有只读导出模式 `--print-jurisdiction`(`:226-233`),漂移度量脚本消费它而不抄清单(`north-star-drift-metrics.sh`)。
- 同步只看冲突:`sync-upstream.yml:154` 直接 `git merge dev`;无冲突即通过,冲突里除 `bun.lock`/`app`/`ui` 外
  一律当「only-add discipline was broken」失败(`:158-159,199-204`)。它**从不读接管清单**。
- ADR-029 对 L3 的定义是「退出同步集…不再 merge,无处冲突;唯一写操作 = 受控 re-freeze」
  (`.claude/rules/adrs/ADR-029-upstream-sovereignty-ladder.md:29`)。实际行为与之相反,两种证据:
  - 静默混入:机器人合并改了接管文件 ——
    `003f6f764`(alpha-code-bot,2026-10-01)把 `session/llm/request.ts` +2 行;`57646831b`(2026-09-24)改了
    `test/provider/transform.test.ts`。(`git diff --name-only <merge>^1 <merge> -- <49 条>` 逐个合并跑出。)
  - 冲突停摆:`#1408` 记录连续失败 19 次,起自 2026-10-11,最后成功 2026-10-10。最近一次 run `40869114423`
    冲突 77 个路径,其中 50 个在接管清单里、27 个**不在**(`.gitattributes`、`AGENTS.md`、`packages/desktop/*`、
    `packages/llm/*`、`opencode/src/config/config.ts` 等)—— 清单之外也有历史偏离,守卫只拦「这个 PR 新增的」。
- 上游触及频率(样本 2026-09-21..10-09):`git rev-list --count --no-merges fe3f3a41f..055d95bb7` → 104;
  加 `-- <49 条>` → 2;第一条出现在第 10 个提交。

### 1.5 T07 引擎侧:谁能触发重启、恢复有没有终态

`requestSidecarRespawn`/`respawnSidecar` 的全部调用点(`main/index.ts`):崩溃自愈 `:349,361`;日志失控 `:432`;
目录看护 `:1235`;登录/登出/模式 `:721`(经 `alpha-auth.ts:568,992,1006,1021`);官方连接器 `:968`;
自定义 provider `:1590`;BYOK 改键 `:1596`;续期 `token-only`(latch)。终态:sidecar generation 有
`recovering → ready|failed|injection-failed` 且 20 秒上界(`sidecar-lifecycle.ts:27-81`);latch 失败后每 60 秒
重试(`auth-renewal.ts:14`)而平台态一直 `recovering`,没有出口。renderer 已有「只发意图」通道:
`recovery-submit` 的 `retry-engine`(`shared/recovery.ts:13-20`,`RuntimeRecoveryHost.tsx`)。renderer 模型链的
无界退避(`model-recovery.ts` `loadEngineModelsWithRetry`)归 catalog lane。

### 1.6 架构稿断言复核

| 架构稿断言 | 结论 | 依据 |
|---|---|---|
| `index.ts:1444` 起 token-only 与 structural 都 fork,`:1458` 先 await 远端目录 | 对 | §1.1;且实测每 10 分钟一次 |
| 只改秘密文件/停 respawn 不足以让新凭据生效 | 对 | `variable.ts` 装载期替换 + `provider.ts:1839-1847,1922` 两层缓存 |
| 必须改 `provider.ts` 的取凭据接缝 | **不必** | `chat.headers` 已在每次请求触发且最后合并,装着的 SDK 让请求头赢(§1.1);`provider.ts` 不改 |
| 不能只在 `chat.headers` 写一个值就假定它赢 | 对,已核 | 按装着的三个包实读;仍要线上请求级测试(§4 #1) |
| `mcp/index.ts:557` 全体等待;`tools.ts:480`、`system.ts:121` 等它 | 对 | §1.2;另发现 finalizer 在 forEach 之后、`status()` 默认 `disabled` |
| `system.ts` 要改成只等目标服务 | **不必改该文件** | 它只读 `mcp.instructions()`;状态立即返回后自然不等;`system.ts` 不在接管表 |
| Office ENOENT 不能单凭同期日志判为「同步中」根因 | 对,并补:ENOENT 本身是陈旧 cwd | §1.3 |
| 探测扩 PATH 只回布尔、spawn 传裸 uv | 对 | `ext-ipc.ts:90-100`、`mcp/index.ts:407-417` |
| `north-star-guard.sh:161` 等允许修改已接管路径;`sync-upstream.yml:159` 判冲突失败 | 对 | §1.4;并补静默混入实例与 27 条清单外冲突 |
| `alpha-secret-files.ts:1` 描述 fork 时映射 | 对 | 且写法非原子(§1.1) |
| `installCloudMcp` 解析密钥引用而 `governedMcpEvidence` 整份比较 | 对 | `cloud-websearch-kill.ts:438`、`plugin/src/alpha-cloud-authority.ts:67-82`:装载后的 `Bearer <字面量>` 永远不等于注入的 `{file:}` 定义 |

## 2. 选定方案与被否决的替代

### 2.1 普通续期热应用(不重启引擎)

一句话:**凭据文件就是唯一的运行期凭据源;main 原子重写它,两个消费者都在请求边界现读它。**

1. `alpha-secret-files.ts` 新增 `writeSecretFileAtomic(dir,name,value)`(同目录 `.<name>.tmp-*`,0600,
   fsync,rename),`syncSecretFiles`(`:78-126`)也改用它。新增 `applyPlatformCredentialsHot(userDataPath, env)`:
   只重写 `ALPHA_API_KEY`、`ALPHA_MCP_TOKEN`;返回 `{status:"applied"} | {status:"needs-structural", reason}`。
   判据 = 续期前后**在场的凭据名集合相同**(`mcp_access_token` 出现/消失会改变注入面是否装云 MCP,
   `alpha-config-injection.ts:102`,只能走 structural)。热路径从不删文件。
2. `alpha-auth.ts`:`setAuthDeps` 增加同步依赖 `applyCredentials()`;`doRefresh` 在 `applyAuthEnv()`(`:910`)
   之后立即调用;`applied` 时**不**置 `unappliedRenewalGeneration`(`:908`),于是普通续期不再出现
   `recovering`;`needs-structural` 或写失败时保留现有语义:置 unapplied、`respawnSidecar("structural")`。
   写/读者:main 是秘密文件唯一写方;sidecar 只读。
3. `main/index.ts`:删除 `tokenRotation` latch(`:280-296`)及其状态(`:193-205,303-312`;`:207` 的 boot 终态
   上界保留)、boot-grace 的 `tokenRotation.accept`(`:1277`)与 `:311,1616` 的 flush、`killSidecar` 的
   `token-rotation` 停止模式(`:228`);`SidecarRespawnReason` 只剩 structural,`shouldReloadRenderer`/
   `shouldRetryRespawn`/`mergeRespawnReason`(`sidecar-lifecycle.ts:5-15,83-89`)随之收掉;`createTokenRotationLatch`
   (`auth-renewal.ts:187-317`)删除。boot 时续期若早于首个 fork,fork 自然带上新值;晚于 fork 就走热路径 ——
   不再需要 boot 代际结算。
4. 模型请求:ext 新增 `"chat.headers"` 钩子(`ext/src/plugin.ts`,与 `:128` 的 `chat.params` 并列;
   `context-injection.ts:607` 已登记为 `no-context`)。判定平台 provider 用 `platform-output-cap.ts:25-27,47-53` 的
   `baseURL === ALPHA_BASE_URL` 判据(抽成导出谓词两处共用,不另写一份);命中则每次读 `ALPHA_PLATFORM_AUTH_REF` 指向的文件,写
   `output.headers.authorization = "Bearer …"`(小写,与 SDK 归一一致)。`ALPHA_PLATFORM_AUTH_REF` 由 main 在
   fork 时置为 `{file:<abs>/ALPHA_API_KEY}`(引用,不是值),加进 `sidecar-env.ts` 白名单;读不到就不写头,
   请求以 401 显形,不抛错打死请求。`provider.ts` 不改。
5. 云 MCP:`installCloudMcp` 仍先解析一次以保持「读不到就不装」(`cloud-websearch-kill.ts:436-446`),但写回
   `cfg.mcp.cloud` 的是**未解析**的定义。引擎 `mcp/index.ts:324`:对 `governedMcpEvidence(key,mcp)` 成立的条目,
   把 header 里的 `{file:}` 从 `requestInit` 拿掉,改由传给 StreamableHTTP/SSE transport 的 `fetch` 包装器在每次
   请求时现读文件补上。解析函数挪进 `plugin/src/alpha-cloud-authority.ts`,ext 与引擎共用一份;非 governed 条目
   行为逐字不变。云端无状态,无需重连。
6. 可选顺路(OPTIONAL):不再物化 `ALPHA_CLOUD_TOKEN`(无读者,§1.1)。
7. 与 catalog lane 的接口:热路径只改两份凭据文件,不改 provider/模型配置,不调 `pinAppliedCatalog`;`onChanged`
   (`index.ts:729-737`)照旧在每次续期触发,catalog lane 在其中挂的 `requestCatalogRefresh("identity-change")` 由其
   自身比对身份标签,纯续期不拉目录。副作用如实登记:今天每 10 分钟的续期换代顺带「应用」新下载的目录;本票
   落地后,新目录要等下一次结构性换代或重启才生效 —— 这正是 catalog lane §2.4 写明的默认值,要不要在
   `onDownloadedCatalogChanged` 上挂空闲换代归它,本方案不加订阅者。

恢复范围(细化到代码):

| 变化 | 谁判 | 动作 |
|---|---|---|
| 同身份续期,凭据名集合不变 | `applyPlatformCredentialsHot` | 原子重写两文件;不 respawn;在途流、会话授权、MCP 连接不动 |
| 续期后凭据出现/消失 | 同上返回 `needs-structural` | 现有 structural respawn |
| invalid_grant / 撤权 | `doRefresh` 400/401 → `logout()`(`alpha-auth.ts:837-841`) | 现有:清 env、删文件、structural |
| 登录 / 登出 / 切账户 / 切模式 | `completeAuth`/`logout`/`setAuthMode` | 现有 structural(不在本期改) |
| 自定义 provider 地址/协议/模型、BYOK 改键 | `provider-lifecycle.ts:118,137`、`index.ts:1596` | 现有 structural;热化为 OPTIONAL |
| MCP 定义改变 | `MCP.add`/`connect` | 只换该服务的 generation(§2.2) |
| 进程退出、健康失败、围栏重施 | 自愈 / 失控 / generation 终态 | 现有 |
| 热写失败 | `writeSecretFileAtomic` 抛错 | 一次 structural 兜底;它的 `syncSecretFiles` 再失败即拒 fork(`server.ts:502-510`)→ generation `failed` → 现有 RecoverySurface 的 `retry-engine` |

在途云任务:热续期不打断 MCP 调用;structural 场景沿用现状(按 job ID 查结果、不自动重派),本方案不新增重派路径。

被否决:

- 每次续期仍重启、只改 loading 文案 —— 中断与清授权都还在。
- 补丁 `provider.ts`(按凭据版本重建 SDK)—— `{file:}` 引用在装载期已丢失,需新增接管 + ADR,而 `chat.headers` 现成。
- main 起一个注入凭据的本机 HTTP 中继给 provider 当 baseURL —— 新增常驻组件与故障面,只为替代一个现成钩子。
- 续期后对云 MCP `MCP.add` 同名替换(只重连该服务)—— 会打断在途云调用;无状态服务端下每请求换头就够。
- 把旧 token 挂在 SDK 里等 401 再刷新重试 —— 每轮都先吃一次 401,且写操作未知结果不能自动重放。

### 2.2 MCP 逐服务后台启动

改动只在已接管的 `mcp/index.ts`、`session/tools.ts`(ADR-041 文件级接管)与生成的 SDK 类型。

1. **状态模型**:`State` 增 `runtime: Record<name, {generation, phase, failure?, ready: Deferred}>`,phase =
   `configured → preparing → connecting → ready | failed`,`disabled` 单列(用户配置事实,不是失败)。
   对外 `Status`(`:124-130`)增一个变体 `{status:"connecting"}`(覆盖 configured/preparing/connecting),
   `failed` 增可选 `code`:`workspace_missing | dependency_missing | spawn_failed | handshake_timeout |
   tools_list_failed | transport | auth`。`status()` 对进行中服务报 `connecting`,不再默认 `disabled`。
2. **init 立即返回**:`InstanceState.make` 的 init 先建 `s`、**先** `addFinalizer`(关 client、杀后代、置
   `s.disposed = true`),再 `Effect.forkScoped` 一个后台 fiber 逐服务连接。连接受 layer 级
   `Semaphore(4)` 约束(所有实例共用,防多实例同时各起四个 Python);完成一个发布一个(写 `s.clients/defs`、
   发 `ToolsChanged`)。fiber 直接拿 `s`,不回调 `InstanceState.get`(避免在 ScopedCache lookup 里重入)。
3. **迟到不写回**:每次写回前核 `!s.disposed && s.runtime[name].generation === gen`,不符则关掉刚得到的 client。
   `add`/`connect`/`disconnect` 先递增该服务 generation 再动作。
4. **失败分类,不无限重试**:spawn 报 ENOENT 之后再分类 —— 实例目录不存在 ⇒ `workspace_missing`;否则
   `dependency_missing`(命令名照抄)。这是对真实失败的归因,不是 spawn 前的闸门,不复制 libuv 的 PATH 查找。
   确定性失败(两种 missing、EACCES)停在 `failed`,直到配置变化、用户重试(既有 `POST /mcp/:name/connect`)
   或实例重建;远端传输错误沿用 `#1547` 的连接内重试,之后同样停在 `failed`。
5. **各自预算**:准备 = 一次 stat(不计时);连接+initialize = `mcp.timeout ?? 30s`(现状);`tools/list` = 现有
   catalog 超时;调用 = 现有 `requestTimeout`。去掉 `ext-config.ts:460-521` 的 5 秒补写(`index.ts:874` 调用点)——
   全体等待消失后它只剩副作用(把调用也压到 5 秒)。已写入第三方条目的 5000 不回收(分不清是不是用户写的)。
6. **执行走服务入口**:`McpTool` 携带 `{origin, generation, defDigest}`;`session/tools.ts:480-487` 的 execute 改调新的
   `mcp.callTool(origin, name, args, {generation, defDigest, timeout})`,由它取**当前** client;generation 变了且新定义
   摘要不同 ⇒ 响亮失败「工具定义已变化,请重试」;摘要相同 ⇒ 用新 client。一次模型请求的工具集合在
   `prepare` 时固定(`request.ts` 现状),后台变化只进下一步。
7. `session/system.ts`、`prompt.ts` 不改:`instructions()` 立即返回就绪服务的说明。
8. ui-mac 消费方:`ext-mcp-activation.ts:218-221` 与 `hub-view.ts:282-289` 把 `connecting` 映射成「准备中」而不是
   `failed`;文案走既有状态 chip。

被否决:只缩短全局 timeout(仍等最慢者,且误杀长调用);未托管的 fire-and-forget(销毁后孤儿进程与迟到写回);
返回空列表省等待(第一轮静默缺工具);每轮开始前「等一小会儿」(把全体等待换个名字留下)。

### 2.3 第一方 Office:可发现与可执行分开

1. 构建期导出:`ui-mac/scripts/gen-office-mcp-tools.ts` 用 Python 以模块方式载入 `server.py` 调 `tools_for()`
   (不改 `server.py` 字节,alpha-web 记录的 `artifactDigest` 不变),写 `resources/office-mcp/tools.json`:
   `{serverSha256, formats:{word:[…],…}}`,入库;测试重跑生成并逐字节比较,漂移即红。
2. 新增 `plugin/src/alpha-first-party-mcp.ts`(ADR-043 命名谓词内):`declaredFirstPartyTools(name, entry, env, readFile)`,
   仅当 `entry.command` 与 main 经 env `ALPHA_OFFICE_MCP_MANIFEST`(指向随包 `tools.json` 的路径)声明的随包命令
   **逐 token 相等**、且 `server.py` 的 sha256 与清单一致时,返回该格式的工具定义。
3. `mcp/index.ts` `tools()`:就绪服务给实时定义;未就绪但有声明定义的第一方服务给声明定义(identity 与连上
   后完全相同:`{source:"mcp", origin, name}`,策略绑定不变)。调用时 `mcp.callTool` 只 `await` 该服务的 `ready`
   (连接预算内);若此前失败且可重试,发起一次连接。连上后比对 `tools/list` 与声明定义,不一致 ⇒ 本次调用失败、
   丢弃声明定义,下一步只用实时定义。
4. 第三方服务首次握手前不出现在工具表里;设置页显示「准备中」。

被否决:把 Office 工具改登记成插件工具(身份变成 plugin,REQ-131 的 MCP 绑定全失效);从目录短文案猜 schema;
用上次连接的缓存定义当已连接。

### 2.4 Office/PDF 运行环境随应用交付

选定:**每个架构随包一份固定的 CPython + 预装依赖**,不再用 uv。

1. 锁定:`ui-mac/resources/office-runtime.lock` 记录 python-build-standalone 3.11 的 `aarch64-apple-darwin` /
   `x86_64-apple-darwin` 包 URL + sha256,以及五个依赖的 macOS 轮子(两架构各一份)URL + sha256。
2. 构建:prebuild 新增 `scripts/build-office-runtime.ts`:按 lock 下载、校验哈希、解包到
   `native/office-runtime/build/<arch>/`,`pip install --no-deps --only-binary=:all: --require-hashes --target` 装进运行时
   自己的 site-packages,`compileall` 预编译,删掉 `test/`、`tkinter`、`idlelib`、`ensurepip`、`pip`。哈希不符即红。
3. 打包:`electron-builder.config.ts` 在 darwin 下加 `extraResources: {from:"native/office-runtime/build/<arch>/", to:"office-runtime/"}`
   (形同 `:150-160` 的 `alpha-fence` 条目);`beforePack`(`assertMacTargetArch`,#1496)扩到 `office-runtime/` 下每个 Mach-O
   都含目标架构切片。签名/公证:沿用 electron-builder 深签(`alpha_fence.node` 已证明 extraResources 的 Mach-O
   会被签成同 Team,`:150`);`entitlements.plist` 预期不改(CPython 无 JIT),由本票第一步的公证实跑确认。
4. 体积:上界 ≈ 78 MB + 45 MB / 架构(未裁剪实测,§1.3);裁剪后实际数由构建日志打印,作为本票退出证据。
5. 命令:`alphaOfficeInstallCommand`(`office-advisories.ts:113-124`)改为
   `["{alphaResources}/office-runtime/bin/python3","-I","-B","{alphaResources}/office-mcp/server.py",format,"{workspace}"]`;
   `checkAlphaOfficeMcpSafety` 的期望值由它派生,自动跟随;`validateServer` 的命令头 `python3` 已在白名单
   (`ext-config.ts:79`,`-I`/`-B` 不在 `EVAL_FLAGS` 里)。绝对路径 ⇒ 探测与 spawn 天然同一个可执行文件;不联网、不写 uv 缓存。
6. 单一权威:`ext-mcp-policy.ts:47-64` 对四个第一方 Office 条目**不再比对目录卡片的命令 token**,一律写 main 的模板
   (身份仍按 catalogId/名称识别,`artifactDigest` 照算)。alpha-web 卡片里的命令变成纯展示,不再需要两仓锁步。
7. 存量迁移:`alpha-office-instance.ts` 的 `reanchorOfficeCommand`(`:89`,boot 时 `index.ts:873` 已在跑)增加一条:
   识别旧 uv 模板逐 token 形状 ⇒ 改写为新模板并去掉 `timeout`;幂等、写锁内、响亮记日志。
8. 准备阶段:可执行文件缺失(包被破坏)⇒ `failed/dependency_missing`,修复动作 =「重新安装 Code Puppy」;
   不弹全局错误,不重启引擎。

被否决:首次使用时下载组件包(要新的下载/校验/更新通道与离线失败面,省下的只是体积);随包 uv + 离线轮子
(仍需随包 Python,多一层);系统 `/usr/bin/python3`(没有 CLT 会弹安装框);把四个工具用 TypeScript 重写
(行为面全换,超出本票);Local Daemon(owner 已排除)。

### 2.5 上游同步遵守接管清单

1. 一份清单:`north-star-guard.sh` 增只读模式 `--print-takeover`,逐行打印 `UPSTREAM_EXCLUDES` 去掉
   `:(exclude)` 的路径(与 `--print-jurisdiction` 同纪律:不跑 git、不判字节)。工作流不抄名单。
2. `sync-upstream.yml` 在 `Merge` 步之前新增 `Takeover intake check`:从**合并前**的可信树取脚本
   (`git show "$OLD_ALPHA:scripts/north-star-guard.sh" | bash -s -- --print-takeover`),
   `MB=$(git merge-base alpha dev)`,`touched = git diff --name-only --no-renames $MB $NEW_DEV`,与清单做前缀匹配。
   有交集 ⇒ 不合并、不出 bundle,把每条路径的上游提交(`git log --oneline $MB..$NEW_DEV -- p`)、上游差异与我方差异
   (`git diff $MB $OLD_ALPHA -- p`)写进 step summary 与 artifact,`::error title=takeover upgrade review required::` 失败。
3. 无交集才合并;剩余冲突按定义都在清单外,报错文案改为「冲突路径既不是干净上游也不是登记接管:按
   ADR-029 登记或还原」并列出路径(替代「only-add discipline was broken」)。
4. 合并成功后再断言 `git diff --name-only $OLD_ALPHA alpha -- <清单>` 为空,否则失败(兜住改名等漏判)。
5. 升级审查 = 人工一次「显式移植」合并 PR(先例 `#1248`、`#1370`/PR #1401):在接管文件里吸收上游改动并跑行为
   测试;合入后 merge-base 前移,自动同步恢复。`sync-upstream-alert.ts` 按失败步名指纹,新步名自带分类,无需改逻辑。
6. 候选 job 仍无推送凭据(`#899` 分离不变);新步骤只执行 alpha 树里的脚本。`docs/architecture/upstream-integration.md`
   同票更新。
7. 现状提醒:当前 27 条清单外冲突(§1.4)会让新流程以新文案继续失败,直到逐条登记或还原 —— 那是一次性债务清理,
   不属于本机制,已在交回里列出。

被否决:全局 `merge=ours` 或对接管路径自动取我方(把上游安全修复与接口变化一起藏掉,dispatch 已禁);在工作流里
另写一份路径表(第二真源);继续只靠冲突判断(无冲突的混入照样静默,§1.4 两例);把接管文件整体移出仓库
(重写 fork 结构,收益不抵)。OPTIONAL:交集出现时先把「第一个触及接管路径的上游提交之前」的部分并进来。

### 2.6 T07:重启由 main 按白名单决定,恢复有终态

- 允许触发 respawn 的原因只剩:崩溃自愈、日志失控、目录看护(catalog lane 的信号)、身份变化(登录/登出/模式)、
  用户发起的 provider/BYOK/官方连接器变更、热写失败兜底。在 `sidecar-lifecycle.ts` 列成一个联合类型
  `SidecarRespawnTrigger`,每个调用点传具名原因并写入 `main.sidecar.respawn.fork.start` 的 `reason`。
- **不得**触发 respawn:令牌续期、任何单个 MCP 失败(含 Office 运行时缺失)、远端目录刷新失败。前两条由本方案
  落地;第三条由 catalog lane 的冻结接口保证(删除 `:1456-1458`,`requestCatalogRefresh` 不返回结果、无人等待,
  新目录不自动换代)。
- renderer 只发意图:引擎停摆走既有 `recovery-submit`/`retry-engine`;MCP 重试走既有 `/mcp/:name/connect`。
- 终态:普通续期不再进入 `recovering`;MCP 每个服务停在 `ready` 或带 `code` 的 `failed`;引擎 generation 的
  20 秒终态不变;latch 的无出口 60 秒重试随 latch 删除。

### 2.7 上游文件改动登记(ADR-029 / ADR-041 / north-star 例外)

| 文件 | 归类 | 说明 |
|---|---|---|
| `opencode/src/mcp/index.ts` | 已接管(ADR-041 文件级,`north-star-guard.sh:161`) | 扩大改动面,先例 `#1011`、`#1547` 均未另立 ADR |
| `opencode/src/session/tools.ts` | 已接管(`:169`) | execute 改走 `mcp.callTool` |
| `opencode/test/mcp/lifecycle.test.ts` | 已接管(`:164`) | 可扩;新测试优先放 `test/mcp/alpha-*.test.ts`(ADR-043 谓词) |
| `opencode/test/session/tools.test.ts` | 已接管(`:189`) | MCP.Service 桩补 `callTool` |
| `sdk/js/src/v2/gen/*`、`sdk/js/src/gen/types.gen.ts`、`client/src/generated*` | 已接管生成物(`:129-130,136-138,160`) | `Status` 增变体后重新生成 |
| `plugin/src/alpha-cloud-authority.ts`、新 `alpha-first-party-mcp.ts` | alpha 自有(ADR-043 谓词) | 无需例外 |
| `opencode/src/provider/provider.ts` | **不改** | §2.1 用 `chat.headers` |
| `opencode/src/session/system.ts`、`config/variable.ts`、`session/prompt.ts` | **不改** | — |
| `.github/workflows/sync-upstream.yml`、`scripts/north-star-guard.sh` | alpha 自有 | 发布链,独立 PR |

## 3. 安全面与不变量

整类边界:凭据从签发到请求头的每一跳;每个 MCP 子进程的生到死;一份接管清单的读者;随包可执行物的来源。

- **I1 凭据只有一个运行期源**:sidecar 内只从 `<userData>/alpha-secrets/` 现读;值不进 sidecar env、
  `OPENCODE_CONFIG_CONTENT` 字面量、日志、renderer。`ALPHA_PLATFORM_AUTH_REF` 与云 MCP 定义只携带 `{file:}` 引用
  (测试断言其值匹配 `^\{file:/.+\}$`)。
- **I2 原子替换**:秘密文件只经 `writeSecretFileAtomic` 写;读者永远读到完整的旧值或新值。
- **I3 旧代不覆盖新代**:续期提交前的两次 CAS(`alpha-auth.ts:833-836,873-876`)保持;文件写入在 main 单线程内
  按提交顺序串行,最后提交者赢;登出删除文件在任何热写之后发生(`logout` 改代,迟到响应被 CAS 丢弃)。
- **I4 在场性变化必走 structural**:凭据出现/消失不热应用,因为注入面据在场性决定装不装云 MCP。
- **I5 头注入范围封闭**:`chat.headers` 只对 `baseURL === ALPHA_BASE_URL` 的 provider 写;云 MCP 的请求期解析只对
  `governedMcpEvidence` 成立的条目生效;第三方 provider/MCP 行为逐字不变。项目插件今天已能在
  `chat.params`/`chat.headers` 的 `input.provider.options.apiKey` 读到 fork 时的 key、也能读同 UID 文件
  (`alpha-secret-files.ts:19-21` 的既定残留),本方案不扩大该面。
- **I6 无孤儿、无迟到写回**:finalizer 先于后台 fiber 注册;实例销毁中断 fiber、关闭 transport、杀子进程后代;
  每次写回核 `disposed` 与 generation。
- **I7 确定性失败不重试**:`workspace_missing`/`dependency_missing`/EACCES 停在 `failed`;没有任何 MCP 失败会触发
  引擎重启。
- **I8 声明定义不等于已连接**:声明工具执行前必须完成 initialize + `tools/list` 且定义一致;只对与随包命令逐 token
  相等、`server.py` 摘要一致的条目生效。
- **I9 随包运行时可复现**:运行时与轮子按 lock 的 sha256 校验;Office 命令只由 main 模板产生,目录卡片不能改写它。
- **I10 接管内容不被自动改写**:同步在合并前后两次核对接管清单;清单只有守卫脚本一份;读取它的脚本来自合并前的
  可信树;候选 job 不持有推送凭据。

## 4. 子票切分

| # | 标题 · 仓 | 覆盖 | 边界 / out-of-scope / 退出条件 | 尺寸 · 难度 · 依赖 · 独立 PR | 将来拿什么证明 | UI 稿 |
|---|---|---|---|---|---|---|
| 1 | `[REQ-236][CODE] 续期登录改为热应用凭据:引擎不重启、在途回答不中断` · alpha-code | AC7(T24 §2.2)、AC2 的子集(T07:续期不再进入恢复态) | `ui-mac/src/main/{alpha-auth,alpha-secret-files,auth-renewal,sidecar-lifecycle,sidecar-env,index}.ts`、`ext/src/{plugin,cloud-websearch-kill}.ts`、`plugin/src/alpha-cloud-authority.ts`、`opencode/src/mcp/index.ts`(仅 `connectRemote`)。不做:BYOK/自定义 provider 热化、目录刷新(catalog lane)。退出:§2.1 的 1–5 落地,latch 删除 | L · 难(凭据竞态与秘密不变量)· 功能上无前置;catalog lane 的 C1 同改 `index.ts:729-737,1456-1458` 与 `server.ts:494-514`,建议 C1 先合、本票 rebase · 独立 PR(安全 + 引擎接缝) | 新 `credential-hot-apply.test.ts`(续期后 respawn 调用次数 0;在场性变化 ⇒ structural);新 `ext/src/platform-credential-header.test.ts`;真引擎 + 真 ext + 本机假网关的 `token-hot-apply.engine.test.ts`(换文件后下一请求带新 token,反向臂去掉钩子即带旧 token);`lifecycle.test.ts` 增 governed 远端用例(两次调用之间换文件,第二次带新头、无第二次 initialize);T23 格:正式包连续三次续期 PID/generation 不变、在途流完整、会话授权仍在 | 否 |
| 2 | `[REQ-236][CODE] MCP 改为逐服务后台启动:一个连接器慢或坏不再拖住对话与其它工具` · alpha-code | AC7(T24 §2.3)、AC2 子集(T07 终态) | `opencode/src/mcp/index.ts`、`opencode/src/session/tools.ts`、生成的 SDK/client 类型、`ui-mac/src/main/{ext-mcp-activation,hub-view,ext-config,index}.ts`(去 5 秒补写)。不做:第一方声明定义(#4)。退出:§2.2 的 1–8 | L · 最难(Effect scope、并发与销毁竞态)· 无前置;catalog lane 的 V1 若证实其 H1(MCP 全体初始化拖住新对话),本票即其根因修复,但本票不等 V1 · 独立 PR(引擎接缝) | 新 `opencode/test/mcp/alpha-mcp-independent-startup.test.ts`:不应答 initialize 的服务在场时快服务的工具 1 秒内可用(今天红);连接中销毁无孤儿 pid、无迟到写回;cwd 不存在 ⇒ `workspace_missing` 且不重试;命令不在 PATH ⇒ `dependency_missing`;6 个服务时并发 ≤ 4;重连后定义变化的调用响亮失败;T23 格:挂起一个第三方握手时普通对话与已就绪工具完成 | 否(新增「准备中」文案走 T19) |
| 3 | `[REQ-236][CODE] 文档工具随应用自带运行环境,不再依赖用户机器上的 uv` · alpha-code | AC6 子集(T17 出货依赖) | `ui-mac/{resources/office-runtime.lock, scripts/build-office-runtime.ts, electron-builder.config.ts}`、`shared/office-advisories.ts`、`main/{ext-mcp-policy,alpha-office-instance}.ts`。不做:各格式能力说明与附件流程(附件 lane);alpha-web 卡片清理(可选跟进)。退出:§2.4 的 1–8,构建日志打印两架构实际体积 | L · 难(原生扩展的签名与公证)· 去掉 Office `timeout` 一步依赖 #2 · 独立 PR(发布链) | `office-mcp.test.ts` 期望命令更新;新 `office-runtime-lock.test.ts`;`alpha-office-instance.test.ts` 旧 uv 命令迁移;`ext-mcp-policy` 卡片仍是 uv 命令时写入 main 模板;darwin 下随包 python 跑 `server.py word <tmp>` 5 秒内完成 initialize + `tools/list`(运行时缺席时响亮 skip);第一步先做签名 + 公证实跑;T23 格:无 Homebrew/uv 的干净账户里四格式各读写一次 | 否(失败文案走 T19) |
| 4 | `[REQ-236][CODE] 文档工具在连接完成前即可被选用,调用时只等对应服务` · alpha-code | AC6 子集(T17)、AC7 子集(T24 §2.3 可发现/可执行) | `ui-mac/scripts/gen-office-mcp-tools.ts`、`resources/office-mcp/tools.json`、`plugin/src/alpha-first-party-mcp.ts`、`opencode/src/mcp/index.ts`(`tools()`/`callTool`)、main 注入 `ALPHA_OFFICE_MCP_MANIFEST`。不做:第三方预广告。退出:§2.3 的 1–4 | M · 难 · 依赖 #2、#3 · 与 #2 同一引擎文件,单独 PR | `office-mcp-tools-snapshot.test.ts`(重生成逐字节相等,改一个 schema 字段即红);引擎用例:Office 连接中时声明工具在表、调用只等它而另一慢服务仍在连接;连上后定义不符 ⇒ 调用失败并弃用声明定义 | 否 |
| 5 | `[REQ-236][CODE] 上游同步遵守接管清单:碰到接管文件转人工升级审查,不再静默合并` · alpha-code | AC7(T24 §2.5) | `scripts/north-star-guard.sh`、`.github/workflows/sync-upstream.yml`、`docs/architecture/upstream-integration.md`。不做:27 条清单外冲突的清理、OPTIONAL 部分前进。退出:§2.5 的 1–6 | M · 常规(先例齐全)· 无前置 · 独立 PR(发布链) | 新 `ui-mac/src/main/sync-upstream-takeover-isolation.test.ts`(Bun.YAML 抽步骤体、真 git 仓):非接管改动照常合;无冲突改接管 ⇒ 以审查标题失败且我方文件逐字节不变;冲突改接管同上;变异臂删掉该步 ⇒ 无冲突那例静默合入;`north-star-guard.test.ts` 增 `--print-takeover` 与数组同源(删一条即变);断言工作流里没有字面接管路径 | 否 |

运行时/打包证据全部归共享 RC 回归 T23,不为单票另造发布门。本地门:alpha-code 的 `gate run`(type-check、
`bun test src` 对照 base 失败集、north-star 守卫、文档链接);新测试先在已知坏的输入上证明会红(各票「反向臂/变异臂」)。
`process-fence-apply.test.ts` 与 `network-egress-fence.test.ts` 在缺 Electron 二进制的 worktree 恒红,不算回归。

## 待 Codex 征询

1. **请求头覆盖是否真的处处成立**:§1.1 依据 `ai@6.0.168`、`@ai-sdk/openai-compatible@2.0.41`、
   `@ai-sdk/provider-utils@4.0.23` 的源码推出请求级 `authorization` 盖过 SDK 配置头。请核:重试(`maxRetries`)、
   `timeoutFetch`(`provider.ts` `options.fetch`)与 `wrapLanguageModel` 中间件是否会重建或丢弃请求头;除
   `Agent.generate`(CLI)外,v1 会话里是否还有绕过 `LLMRequestPrep.prepare` 的模型请求。
2. **`forkScoped` 与 `ScopedCache`**:在 `InstanceState.make` 的 lookup 里 `forkScoped` 的 fiber,是否在
   `ScopedCache.invalidate` 时被可靠中断;fiber 若误调 `InstanceState.get(state)` 是否会在同一键上死锁(`instance-state.ts:26-42`)。
3. **随包 CPython 的签名与公证**:python-build-standalone 二进制与 lxml/Pillow/reportlab 的 `.so` 经 Developer ID
   重签 + hardened runtime + 库校验后,能否在不加 entitlement 的情况下由 sidecar 子进程启动并 import;
   `com.apple.security.cs.allow-unsigned-executable-memory` 是否会被 ctypes/cffi 路径需要。
4. **自定义 `fetch` 与本仓 SDK 补丁**:`patches/@modelcontextprotocol%2Fsdk@1.29.0.patch` 增了 `onsessionexpired`
   重新初始化;给 StreamableHTTP 传自定义 `fetch` 后,`_fetchWithInit`(`streamableHttp.js:32,274,367`)的 GET/SSE
   重连路径是否也会走到该包装器。

## 待 owner 裁决

无。按规则自定、可回滚的默认值:

- 文档工具运行环境**随包**交付(每架构约 +78–123 MB 上界,§1.3)。撤法:把 §2.4 第 3 步换成首次准备下载,命令模板不变。
- 接管文件被上游触及时**整次同步停下等人工移植**。撤法:启用 §2.5 的 OPTIONAL 部分前进。
- 第一方 Office 命令以 main 模板为唯一权威、不再比对目录卡片命令。撤法:恢复 `ext-mcp-policy.ts:56-64` 的比对并同步
  alpha-web 卡片。

需要编排器转给其它 lane 的接口事实(不是本方案的 owner 决定):

- #1 让装载后的云 MCP 定义与注入定义逐字相等,`governedMcpEvidence` 将开始成立 ⇒ 云工具来源会从 `not-asserted`
  变为 `alpha-cloud`,这是权限/来源 lane(T04)的显示面。
- #1 落地后续期不再换代,新下载的目录推迟到下一次结构性换代或重启才生效。catalog lane 已把「下一次换代生效」
  定为可回滚默认值并写明加强方式(其 §2.4,及「待 owner 裁决」节下默认值第 1 条:在 `onDownloadedCatalogChanged`
  挂空闲换代);REQ-237 只要求「明确的生效边界」且「不要每次轮询都重启引擎」(alpha-work#119 正文),
  该默认值仍满足,此处不另起裁决。
- #1 与 catalog lane 的 C1 同改 `main/index.ts`、`server.ts`,合并顺序见 §4。

## 仍是推断、没跑过的断言

- 请求级 `authorization` 在真实请求里盖过 SDK 缓存的旧 key —— 源码推导(§1.1),#1 的线上测试才是证据。
- 云 MCP 在同一 client 上换头后继续可用 —— 依据服务端无状态实现,未跑。
- 这台机器的 `spawn uv ENOENT` = 陈旧实例目录作 cwd —— 日志相关 + Node 复现,未在打包应用内复现;另一类
  5 秒超时 = `uv run --with` 启动慢,未计时。
- 随包运行时裁剪后的体积、签名公证无需新 entitlement —— 只有未裁剪上界实测。
- 让云 MCP 定义保持 `{file:}` 引用即可使 `governedMcpEvidence` 成立 —— 代码阅读推断。
- `forkScoped` fiber 随实例销毁被中断 —— 依先例推断(Codex 第 2 问)。
- 换代后每个目录重付一次 MCP 全体初始化:进程内状态随进程消失是代码事实;它在现场造成的耗时没有对照实验
  (catalog lane 同一推断,其 V1 负责判定)。
- 接管路径被上游触及的频率 —— 只量了 2026-09-21..10-09(2/104);10-10 之后上游未拉取,77 条冲突说明期间有大改动。
