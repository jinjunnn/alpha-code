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
(逐条复核见 §1.6)。源码基线:正式版 0.1.22 = `393a35c2a`。本版已吸收 Codex 方案审 R1 的 F1–F8、Q1–Q4
与两条 ARCH-NOTE,以及网络、权限两条兄弟 lane 的冻结接口(各处标注)。`docs/architecture/constraints.md`
不存在(`ls docs/architecture/constraints.md` → `No such file or directory`),本方案不新增偏离;对上游文件
的每一处改动在 §2.7 归类。

**边界与冻结接口**(本文照用、不重复设计):

- 目录 lane(`docs/design/req236-catalog-and-model.md` §2.10,分支 `design/req236-catalog`,修订 `8147dd1bd`):
  ① 删除 `main/index.ts:1456-1458` 的 `await syncLiveAllowlist` 归它;② `requestCatalogRefresh(reason)` 同步返回 `void`、
  永不抛错,任何流程不得等它;③ `pinAppliedCatalog(userDataPath, generation)` 由 `spawnLocalServer` 在 fork 前调用;
  ④ `onDownloadedCatalogChanged(cb)` 默认无人订阅,新目录在下一次引擎换代生效。热续期只改凭据文件、不改模型配置,
  ③ 对「不 fork 的热应用」的约束不适用(§2.1)。
- 网络 lane(`docs/design/req236-network-diagnosis.md` §2.2,修订 `8e23a22fb`):`classifyNetFailure(error: unknown):
  { layer: NetFailureLayer; code: string } | undefined`,`NetFailureLayer = "policy" | "dns" | "tcp" | "tls" | "tls-cert" |
  "http" | "timeout"`,住在新文件 `packages/schema/src/alpha-net-failure.ts`,归网络 lane 的子票;本方案只消费(§2.2)。
- 权限 lane(`docs/design/req236-permissions-and-provenance.md`):每次请求的云 MCP 凭据**从 `ALPHA_CLOUD_MCP_DEF` 里的
  引用读取,不从已装载的条目读取**;云工具来源比较的修正(不再比较令牌值)归它的 C4。本方案不依赖来源比较结果。
- 三档权限、来源分类、配置受控字段归权限 lane;附件与各文件类型的用户可见说明归生图/产物/附件 lane;改名归品牌 lane。

## 1. 只读勘破

文中 `ui-mac`、`opencode`、`ext`、`plugin`、`schema` 均指 `packages/` 下的包;未注明仓的坐标都在 alpha-code。

### 1.1 普通续期今天怎么走(T24 §2.2、T07)

1. 续期提交:`ui-mac/src/main/alpha-auth.ts:891-913` 覆盖 `stored`(含 `mcpAccessToken`)、`tokenGeneration++`、
   置 `unappliedRenewalGeneration`(`:908`)、`applyAuthEnv()`(`:298-331`:`model.invoke→ALPHA_API_KEY`、
   `cloud.dispatch→ALPHA_CLOUD_TOKEN`、`mcp_access→ALPHA_MCP_TOKEN`)再 `publish()`,此时平台态已是 `recovering`
   (`deriveState` `:229-246`,判据 `:237`)。
2. `refreshTokens`(`:716`)→ `awaitRotation`(`:735,765-788`)→ `onRenewed` = `main/index.ts:728`
   `tokenRotation.accept(result,"renewal")` → latch(`:280-296`,实现 `auth-renewal.ts:187-317`)→ `respawn("token-only")`。
   `onRenewed` 的缺省值是 `() => {}`(`alpha-auth.ts:354`),`awaitRotation` 把 `undefined` 当成功(`:770` 的 `!== false`)。
3. `doRespawnSidecar`(`index.ts:1448`)先 `await syncLiveAllowlist`(`:1458`),再 `killSidecar`(`:228`)、
   `spawnLocalServer`(`server.ts:467`,`:494 syncSecretFiles`)、`sessionGrantRegistry.beginSession`(`index.ts:1548`)。

频次实测(owner 正式版当前这次运行):

```
$ grep -c 'main.sidecar.respawn.fork.start' ~/Library/Application\ Support/ai.opencode.desktop/logs/20261030T021718/startup-timeline.log   → 25
$ grep 'main.sidecar.respawn.fork.start' …/startup-timeline.log | grep -c token-only                                                    → 25
首行 2026-10-29 22:17:18,末行 2026-10-30 02:26:46;相邻两次 22:26:46 / 22:36:43
```

约 4 小时 25 次、全部 `token-only`(TTL 15 分钟,`alpha-auth.ts:705`)。每次中断在途流、清会话授权;MCP 状态住在 sidecar
进程内存(`mcp/index.ts:557` 的 `InstanceState`),新进程从空开始。目录 lane 另测得同类 23 次换代全部先等远端目录,均值
4.0 s,6 次等满 8 s(`req236-catalog-and-model.md` §1.1)。

**两个消费者各自怎么拿到凭据**:

- 模型请求:`alpha-models.ts:152` 注入 `provider.alpha.options.apiKey = {file:…/ALPHA_API_KEY}`;引擎装配置时替换
  (`config/variable.ts:35-90`);`provider.ts` 的 `sdk` Map(`:1467`)按含 `apiKey` 的 options 哈希缓存 SDK(`:1839-1847`),
  `getLanguage` 再缓存语言模型(`:1922`)。fork 之后文件改了不会被读。
- 云 MCP,**生产分支**(未设 `ALPHA_WEBSEARCH_DISABLE`):`alpha-config-injection.ts:386` 生成带 `Bearer {file:…ALPHA_MCP_TOKEN}`
  的定义,`:391` 写进 `ALPHA_CLOUD_MCP_DEF`,`:401-405` 直接放进 `OPENCODE_CONFIG_CONTENT.mcp.cloud`;引擎配置加载器在解析时
  把引用替换成令牌本身(`config/config.ts:231-243,487-489` → `variable.ts:35`)。**kill-switch 分支**才置 ARM(`:409`),由 ext
  `installCloudMcp`(`cloud-websearch-kill.ts:411-418` 要求 ARM 与 DEF 同在)解析后写回。两个分支装载后的条目都带字面量令牌;
  `ALPHA_CLOUD_MCP_DEF` 两个分支都保留引用形态。引擎 `mcp/index.ts:324` 以 `requestInit.headers` 交给 transport。

**发送边界的现成接缝(按装着的版本实读)**:

- 每次模型请求在 `session/llm/request.ts:139-151` 触发 `chat.headers`,结果在 `:224-227` 最后合并,经 `session/llm.ts:356`
  进 `streamText({headers})`。`ai@6.0.168` 把请求头小写归一(`dist/index.mjs:4073`);`@ai-sdk/openai-compatible@2.0.41`
  把 `apiKey` 变成配置头(`dist/index.mjs:1719-1723`),发送时 `combineHeaders(config, options)`(`:563,646`),
  `@ai-sdk/provider-utils@4.0.23` 小写且后写者赢(`dist/index.mjs:551-571`)⇒ 请求级 `authorization` 盖过配置头。SDK 重试
  复用同一份请求头、不重新读文件(Codex Q1:`ai/dist/index.mjs:7162,7213`)。
- 覆盖面全称断言:

```
$ grep -rn "getLanguage(" packages/opencode/src            → agent/agent.ts:375、session/llm.ts:122 两处
$ grep -rln "Agent.generate\|agent.generate\|\.generate({" packages/opencode/src   → agent/agent.ts、cli/cmd/agent.ts
$ grep -rln "streamText\|generateText\|generateObject" packages/core/src packages/llm/src   → packages/llm/src/llm.ts
```

  `Agent.generate` 只有 CLI 调用;`llm.ts` 只服务默认关闭的原生运行时(`runtime-flags.ts:54`),同样吃 `prepared.headers`。
- **遥测会把请求头导出**:`ai` 把每个请求级头记成 span 属性 `ai.request.headers.<name>`(`dist/index.mjs:2176-2182`,
  streamText 用于 `:6896-6902`),span 经 `tracer.startActiveSpan`(`:2266-2276`)创建。开了 `experimental.openTelemetry` 时
  `session/llm.ts:378-381` 传入 tracer(`:242-253` 的 Proxy 只包了 `startSpan`),由 `core/src/observability/otlp.ts:68-75` 导出。
  把认证头放进请求头 = 新增一条导出通道,必须剔除(F1)。
- 云 MCP transport:`@modelcontextprotocol/sdk@1.29.0` 每次请求重读 `requestInit.headers`(`streamableHttp.js:58-77`),接受 `fetch`
  选项;POST 走 `:338`,GET/SSE 走 `:89`、重连 `:151` 回到同一路径,404 会话恢复 `:299` → `onsessionexpired` → 同一 transport 重新
  initialize(本仓补丁 `patches/@modelcontextprotocol%2Fsdk@1.29.0.patch`);旧 SSE transport 在 `sse.js:68,75,173` 也用传入的 fetch
  (Codex Q4)。云端无状态,每个请求按该请求的 Authorization 新建 server(alpha-platform `packages/gateway/src/cloud-mcp.ts:3,115`)。

**其它事实**:秘密文件是截断后写(`alpha-secret-files.ts:95,113`),今天安全只因写时无读者;`ALPHA_CLOUD_TOKEN` 在 sidecar 内无读者:

```
$ grep -rn '"ALPHA_CLOUD_TOKEN"' --include='*.ts' packages/ui-mac/src packages/ext/src packages/opencode/src | grep -v test
  → 只有 alpha-secret-files.ts:38(物化清单)与 alpha-auth.ts:118-119(写 env)
```

### 1.2 MCP 初始化的全体等待(T24 §2.3)

- `mcp/index.ts:557-623`:`InstanceState.make` 的 init 里 `Effect.forEach(…, {concurrency:"unbounded"})` 对每个服务跑 `create`
  (connect + `tools/list`,`:432-493`),**全部完成后**才 `addFinalizer`(`:598`)并返回。`tools()`(`:737-769`)、`instructions()`
  (`:686-697`)、`status()`(`:662-679`)都先 `InstanceState.get(state)`,于是 `session/tools.ts:480` 与 `session/system.ts:121-123`
  等到最慢的服务;`status()` 对未写入的键报 `disabled`(`:671,675`)。
- 执行消费者捕获 client:`session/tools.ts:482` → `mcp/catalog.ts:54`;**Code Mode** 也直接用捕获的 client
  (`tool/code-mode.ts:185` `input.entry.tool.client.callTool`,子目录来自 `:247` 的 `mcp.tools()`)。
- 进程树:SDK `StdioClientTransport.close()` 只结束直接子进程(`client/stdio.js:137-168`);后代只在实例 finalizer 里对**已存入**
  的 client 清理(`mcp/index.ts:483` `descendants`,`:598-623`);建连失败的 release 只关 transport(`connectTransport` `:273-296`),
  `closeClient`(`:630`)与替换旧 client(`:658`)也不清后代。
- 一个 `timeout` 同时管连接、`tools/list` 与调用(`mcp/index.ts:335,419`;`catalog.ts:43-60`);`ext-config.ts:460-521`
  (`index.ts:874`)给所有缺 timeout 的本机 MCP 写 5000 ms。
- 仓内规则 `packages/opencode/AGENTS.md:104-107`:工作直接写在 `InstanceState.make` 闭包里,`ScopedCache` 负责只跑一次,
  不在其上加 fiber / `ensure()` / started 标志;闭包内的 `forkScoped` 只用于后台流消费者;要非阻塞,**在调用点 fork 那次 `get`**,
  不在闭包里 fork 工作(否则别的方法读到不完整状态)。装着的 effect `4.0.0-beta.83` 的 `ScopedCache.getSuccess` 不等待、
  不启动查找(未完成/失败/缺席都给 none),失败结果会被缓存直到 `invalidate`(`ScopedCache.ts:435-545,825`);finalizer 按
  注册的逆序执行(Codex Q2)。

### 1.3 Office/PDF 的 `spawn uv ENOENT`(T17 出货依赖那一半)

```
$ python3 -I -c '…读 ~/Library/Application Support/ai.opencode.desktop/alpha-engine-config/opencode.json 的 mcp.alpha-*…'
alpha-word  ['uv','run','--no-project','--with','python-docx==1.2.0','/Applications/Code Puppy.app/Contents/Resources/office-mcp/server.py','word','{workspace}'] timeout 5000
alpha-excel / alpha-powerpoint / alpha-pdf 同形(依赖见 shared/office-advisories.ts:75-104)
```

引擎日志(`~/.local/share/opencode/log/opencode.log`)里两种失败按实例目录分得开:

```
run=edbad669 creating instance directory=/private/var/folders/…/T/req105-ac4-ws-z8Agfn
run=edbad669 creating instance directory=/Users/tide/Alpha
run=edbad669 creating instance directory=/Users/tide/code-puppy
… key=alpha-word status=failed error="Operation timed out after 5000ms"   (×2)
… key=alpha-word status=failed error="spawn uv ENOENT"                     (×1)
$ ls -d /private/var/folders/9m/…/T/req105-ac4-ws-z8Agfn   → No such file or directory
$ node v22.22.3 -e 'spawn("uv",["--version"],{cwd:"/nonexistent-dir-xyz",env:{PATH:"/opt/homebrew/bin:/usr/bin:/bin"}})'  → spawn uv ENOENT
  cwd=/tmp, PATH 无 uv → spawn uv ENOENT ;  cwd=/tmp, PATH 含 /opt/homebrew/bin → uv 0.10.10
```

`connectLocal` 以实例目录为 cwd(`mcp/index.ts:406-411`)。结论(强推断):这台机器的 ENOENT 是陈旧实例目录;另一类是
`uv run --with` + Python 启动超过 5 秒。结构性缺陷仍在:探测(`ext-ipc.ts:90-100`,补 `/opt/homebrew/bin` 等,`platform/darwin.ts:5,8`)
与 spawn(裸 `uv`,sidecar env PATH)不同源;首次要联网下包;命令被 alpha-web `catalog-src/catalog.json:59-72`(`a253056`)
逐字锁步(`ext-mcp-policy.ts:56-64` 逐 token 比对)。

- **依赖闭包**(读 owner 机器上 uv 已解析轮子的 METADATA 的 `Requires-Dist`):python-docx 1.2.0 → lxml、typing_extensions;
  openpyxl 3.1.5 → et-xmlfile;python-pptx 1.0.2 → Pillow、XlsxWriter、lxml、typing-extensions;reportlab 5.0.0 → pillow、
  charset-normalizer;pypdf 6.16.1 → typing_extensions(仅 Python < 3.11)。闭包共 11 个发行包,五个顶层包只是其中一部分。
  `server.py` 在工具函数里才 import 格式库(如 `:327`),握手与 `tools/list` 证明不了依赖齐全。
- **安装闸门读目录卡片**:卡片带 `runtimeDep:["uv"]`(`catalog.json:70`),`extension-hub.tsx:1205-1210`、
  `alpha-ui/hub-install-watcher.tsx:175-176` 先用它调 `ext.checkRuntime`,缺 uv 即拒装;详情页 `extension-detail.tsx:607-614` 同样检测。
- 体积实测(arm64):uv 托管的 CPython 3.11.15 完整安装 78 MB;依赖 lxml 20 MB、PIL 13 MB、reportlab 4.8 MB、docx 1.7 MB、
  pypdf 1.7 MB、pptx 1.4 MB、openpyxl 1.3 MB、xlsxwriter 0.9 MB,合计约 45 MB。当前应用 492 MB。
- 签名:`entitlements.plist:10-13` 已含 `allow-jit` 与 `allow-unsigned-executable-memory`,`electron-builder.config.ts:181-182`
  把同一文件用于内嵌子二进制;同 Team 签名满足库校验(Codex Q3)。

### 1.4 上游同步(T24 §2.5)

- 接管清单只有一份数据:`scripts/north-star-guard.sh:118-191` `UPSTREAM_EXCLUDES`(`grep -c "^  ':(exclude)" …` → 49),
  CI 直接跑该脚本(`alpha-ci.yml:133`);已有只读导出模式 `--print-jurisdiction`(`:226-233`)。
- 同步只看冲突:`sync-upstream.yml:154` 直接 `git merge dev`,无冲突即过,其余冲突判「only-add discipline was broken」
  (`:158-159,199-204`),从不读清单。ADR-029 的 L3 定义是「退出同步集…不再 merge」(`ADR-029-upstream-sovereignty-ladder.md:29`)。
- 静默混入实例:`003f6f764`(alpha-code-bot,2026-10-01)给 `session/llm/request.ts` +2 行;`57646831b`(09-24)改了
  `test/provider/transform.test.ts`(逐个合并跑 `git diff --name-only <merge>^1 <merge> -- <49 条>`)。
- 停摆:`#1408` 连续失败 19 次,起自 2026-10-11;run `40869114423` 冲突 77 个路径,50 个在清单内、27 个不在。
- 上游触及频率(样本 2026-09-21..10-09):104 个非合并提交,2 个触及清单,第一个在第 10 位。
- 合入方式:仓内默认「PR → squash 合回 alpha」(`docs/runbooks/ci.md:255`)。2026-09-22 的人工追平 `9dba00807` 是真合并提交
  (父 `ee9200a6f fe3f3a41f`,后者是上游 dev),所以 merge-base 才前移;squash 不会。

### 1.5 T07 引擎侧

`requestSidecarRespawn`/`respawnSidecar` 全部调用点(`main/index.ts`):崩溃自愈 `:349,361`;日志失控 `:432`;目录看护 `:1235`;
登录/登出/模式 `:721`(经 `alpha-auth.ts:568,992,1006,1021`);官方连接器 `:968`;自定义 provider `:1590`;BYOK `:1596`;续期 latch。
终态:generation `recovering → ready|failed|injection-failed`、20 秒上界(`sidecar-lifecycle.ts:27-81`);latch 失败后每 60 秒重试
(`auth-renewal.ts:14`)而平台态一直 `recovering`。renderer 只发意图的通道已有:`recovery-submit` 的 `retry-engine`
(`shared/recovery.ts:13-20`)。云连接器失败后今天靠 10 分钟换代重连,renderer 只对 `disabled` 补连(网络 lane §1.6)。

### 1.6 架构稿断言复核

| 架构稿断言 | 结论 | 依据 |
|---|---|---|
| `index.ts:1444` 起两种 reason 都 fork,`:1458` 先 await 远端目录 | 对 | §1.1;实测每 10 分钟一次 |
| 只改秘密文件/停 respawn 不足以让新凭据生效 | 对 | `variable.ts` 装载期替换 + `provider.ts` 两层缓存 |
| 必须改 `provider.ts` 的取凭据接缝 | **不必** | `chat.headers` 每次请求触发且最后合并;`provider.ts` 不改 |
| 不能只在 `chat.headers` 写一个值就假定它赢 | 对,已核 | 三个包实读;另须剔除遥测导出(F1)、读不到即拒绝(F2) |
| `mcp/index.ts:557` 全体等待;`tools.ts:480`、`system.ts:121` 等它 | 对 | §1.2;另有 Code Mode 消费者与进程树清理缺口 |
| `system.ts` 要改成只等目标服务 | **不必改该文件** | 只读 `mcp.instructions()`;状态不再阻塞后自然不等 |
| Office ENOENT 不能单凭同期日志判为「同步中」根因 | 对,并补:ENOENT 本身是陈旧 cwd | §1.3 |
| 探测扩 PATH 只回布尔、spawn 传裸 uv | 对 | `ext-ipc.ts:90-100`、`mcp/index.ts:407-417` |
| `north-star-guard.sh:161` 允许改接管路径;`sync-upstream.yml:159` 判冲突失败 | 对 | §1.4;另有静默混入与 27 条清单外冲突 |
| `installCloudMcp` 解析引用而 `governedMcpEvidence` 整份比较 | 对,但**两个分支都不相等** | 生产分支由引擎加载器替换(`config.ts:231-243`),kill-switch 分支由 `installCloudMcp` 替换;修正归权限 lane C4 |

## 2. 选定方案与被否决的替代

### 2.1 普通续期热应用(不重启引擎)

一句话:**凭据文件是唯一的运行期凭据源;main 原子重写它,两个消费者在请求边界现读它;读不到就拒绝,绝不回落旧值。**

1. **原子写**:`alpha-secret-files.ts` 新增 `writeSecretFileAtomic(dir,name,value)`(同目录临时文件、0600、fsync、rename),
   `syncSecretFiles`(`:78-126`)也改用它。新增 `applyPlatformCredentialsHot(userDataPath, env)`:只重写 `ALPHA_API_KEY`、
   `ALPHA_MCP_TOKEN`,返回 `applied | needs-structural`。判据 = 新的在场凭据名集合等于**最近一次成功 fork 时写入的集合**
   (`spawnLocalServer` 记录 `syncSecretFiles().written`);还没有 fork 过 ⇒ 直接 `applied`(下一次 fork 自然同步)。
2. **两种完成合同**(F3):
   - 热应用:`setAuthDeps` 增加同步依赖 `applyCredentials()`,`doRefresh` 在 `applyAuthEnv()`(`:910`)后立即调用;成功 = 原子 rename
     且回读摘要一致。成功时**不置** `unappliedRenewalGeneration`,`refreshTokens` 直接回 `applied:true`,普通续期不再出现 `recovering`。
   - structural(在场性变化或热写失败):`doRefresh` 置 `unapplied = G` 并请求 `respawnSidecar("structural")`;`refreshTokens` 等
     `waitForApplied(G, ROTATION_WAIT_MS)`(10 s),为真当且仅当 `markTokenGenerationApplied(g)` 以 `g ≥ G` 被调用。
     `markTokenGenerationApplied` 只由 `doRespawnSidecar` 在**该次 fork** 健康终态之后调用,参数是那次 fork 捕获的
     `forkTokenGeneration`(`index.ts:1495`、`:1551`,取代 latch 的 `onApplied` `:288`)。失败或 20 s 超时 ⇒ 不调用 ⇒ 平台态保持
     `recovering`,由 structural 自愈阶梯重试(`sidecar-lifecycle.ts:11`),放弃后进 RecoverySurface 的 `retry-engine`;迟到完成的旧 fork
     捕获的是旧代,`markTokenGenerationApplied` 对 `g < unapplied` 不动作(`alpha-auth.ts:790-794`)。
   - 谁清 `unapplied`:只有 `markTokenGenerationApplied(g ≥ G)`,以及登录/登出/`initAuthEnv`(身份变化,现状)。`onRenewed` 与它
     「`undefined` 算成功」的缺省值(`:354`、`:770`)一并删除。
3. **删除 latch**:`index.ts` 的 `tokenRotation`(`:280-296`)及其状态(`:193-205,303-312`;`:207` 的 boot 终态上界保留)、
   `:1277` 的 boot-grace accept、`:311,1616` 的 flush、`killSidecar` 的 `token-rotation` 停止模式(`:228`);`SidecarRespawnReason`
   只剩 structural,`shouldReloadRenderer`/`shouldRetryRespawn`/`mergeRespawnReason`(`sidecar-lifecycle.ts:5-15,83-89`)收掉;
   `createTokenRotationLatch`(`auth-renewal.ts:187-317`)删除。
4. **模型请求**:
   - 注入的平台 provider 的 `apiKey`(`alpha-models.ts:152`)改为固定的非凭据占位值:SDK 缓存与 `input.provider.options` 里从此
     没有平台令牌,结构上无可回落(F2)。provider 是否出现仍按凭据文件在场性判(`:125`)。
   - ext 新增 `"chat.headers"` 钩子(`ext/src/plugin.ts`,与 `:128` 的 `chat.params` 并列;`context-injection.ts:607` 已登记
     `no-context`)。平台 provider 判据用 `platform-output-cap.ts:25-27,47-53` 的 `baseURL === ALPHA_BASE_URL`(抽成导出谓词共用)。
     命中则读 `ALPHA_PLATFORM_AUTH_REF`(main 在 fork 时置为 `{file:<abs>/ALPHA_API_KEY}`,加入 `sidecar-env.ts` 白名单)指向的文件,
     写 `output.headers.authorization`;**读不到就抛 `@ai-sdk/provider` 的 `LoadAPIKeyError`**,经 `session/message-v2.ts:633-640` 归为
     `ProviderAuthError`(`core/src/v1/session.ts:49`),请求在发出前被拒绝,界面按现有认证错误给出重试/重新登录(F2)。
     钩子抛错即终止该请求是既有语义(`ext/src/plugin.ts:139` 注释)。
   - 每次 prepare 读一次;同一请求的 SDK 重试复用这份头,不再读文件(Q1)。
   - **遥测剔除**(F1):`session/llm.ts:242-253` 的 tracer Proxy 同时包住 `startSpan` 与 `startActiveSpan`,从初始 `attributes`
     里删掉 `ai.request.headers.authorization`(大小写不敏感),并包住返回 span 的 `setAttribute`/`setAttributes` 丢弃同名键。
5. **云 MCP**(权限 lane 冻结接口):引擎 `connectRemote`(`mcp/index.ts:298-386`)对 `isGovernedMcpEntry(key, mcp, env)` 成立的条目
   (`plugin/src/alpha-cloud-authority.ts:37-48`,只比名字与 URL,两个分支都成立),给 StreamableHTTP 与 SSE transport 传一个 `fetch`
   包装器:每次请求从 **`ALPHA_CLOUD_MCP_DEF` 定义里的 `headers.Authorization` 引用**解析出文件路径、现读、设
   `authorization`;读不到 ⇒ 该请求以认证错误失败,不用已装载条目里的字面量。覆盖 POST、GET/SSE 与重连、404 会话恢复四条路径。
   `installCloudMcp` 与来源比较都不改(后者归权限 lane C4)。
6. 可选顺路(OPTIONAL):不再物化 `ALPHA_CLOUD_TOKEN`(无读者)。
7. 与目录 lane:热路径不调 `pinAppliedCatalog`;`onChanged`(`index.ts:729-737`)照旧每次续期触发,目录 lane 挂在其中的
   `requestCatalogRefresh("identity-change")` 自行比对身份。副作用:新下载的目录不再借 10 分钟换代生效,要等下一次结构性换代或
   重启 —— 即目录 lane §2.4 的默认值,加强方式归它。

恢复范围:

| 变化 | 谁判 | 动作 |
|---|---|---|
| 同身份续期,凭据名集合不变 | `applyPlatformCredentialsHot` | 原子重写两文件;不置 unapplied、不 respawn;在途流、会话授权、MCP 连接不动 |
| 续期后凭据出现/消失 | 同上回 `needs-structural` | structural respawn;按 §2.1-2 的 structural 合同确认 |
| invalid_grant / 撤权 | `doRefresh` 400/401 → `logout()`(`alpha-auth.ts:837-841`) | 现有:清 env、删文件、structural |
| 登录 / 登出 / 切账户 / 切模式 | `completeAuth`/`logout`/`setAuthMode` | 现有 structural |
| 自定义 provider、BYOK 改键 | `provider-lifecycle.ts:118,137`、`index.ts:1596` | 现有 structural;热化为 OPTIONAL |
| MCP 定义改变 | `MCP.add`/`connect` | 只换该服务的代(§2.2) |
| 进程退出、健康失败、围栏重施 | 自愈 / 失控 / generation 终态 | 现有 |
| 热写失败 | `writeSecretFileAtomic` 抛错 | 走 structural 合同;fork 前 `syncSecretFiles` 再失败即拒 fork(`server.ts:502-510`)→ `failed` → `retry-engine` |

被否决:每次续期仍重启只改文案(中断与清授权都在);补丁 `provider.ts` 按凭据版本重建 SDK(引用在装载期已丢、要新接管);
本机凭据中继当 baseURL(新常驻组件);续期后 `MCP.add` 同名替换(打断在途云调用);把读文件挪到 fetch 层让重试也取新值
(单次请求内固定凭据已够,且要改 `provider.ts`);读不到时放行 SDK 缓存 key(F2 明确禁止)。

### 2.2 MCP 逐服务启动(按仓内 InstanceState 规则分解)

改动在已接管的 `mcp/index.ts`、`session/tools.ts`、`tool/code-mode.ts` 与两份已接管的 TS 生成物(§2.7)。

1. **结构**(遵守 `AGENTS.md:104-107`):实例闭包只做同步工作 —— 建 `s`(配置、每服务的代与阶段、`scope = yield* Effect.scope`、
   `disposed=false`),并在闭包里建一个内层 `connections = ScopedCache.make({lookup: connect})`,键为 `name#generation`,寿命 = 实例 scope。
   每个键的查找**直接**做该服务的 spawn / initialize / `tools/list`,由 ScopedCache 保证只跑一次。
2. **非阻塞 = 在调用点 fork 那次 get**:`tools()`/`instructions()`/`status()` 用 `ScopedCache.getSuccess` 读当前键(不等待);
   阶段仍是 `configured` 的服务,在调用点 `Effect.forkIn(s.scope)` 一次 `ScopedCache.get`。`mcp.callTool(origin, …)` 对**目标服务**
   做阻塞 `get`(连接预算内),其余服务不等。全局 `Semaphore(4)`(layer 级,所有实例共用)包住每次 spawn+握手。
3. **阶段与对外状态**:`configured → preparing → connecting → ready | failed`,`disabled` 单列。对外 `Status`(`mcp/index.ts:124-130`)
   增 `{status:"connecting"}`;`failed` 增可选 `code`:本机 `workspace_missing | dependency_missing | spawn_failed`;握手
   `handshake_timeout | tools_list_failed | auth`;远端网络类用网络 lane 的 `classifyNetFailure(error).layer`
   (`policy | dns | tcp | tls | tls-cert | http`,`timeout` 记为 `handshake_timeout`),认不出才记 `transport`。
4. **进程树从 spawn 起托管**(F4):查找里 `acquireUseRelease(spawn, 握手, release: 失败或中断 ⇒ 杀后代(`descendants` `:483`)再关
   transport)`,成功后在该键的 scope 里 `addFinalizer(杀后代 + 关)`。于是失败、中断(实例销毁、查找未完成时 invalidate)、代替换
   (invalidate 旧键)都同时结束父进程与后代;`closeClient`/替换旧 client(`:630,658`)改为 invalidate 对应键。
5. **销毁顺序**(Q2,finalizer 逆序执行):闭包内先建 `connections`(其 finalizer 关闭所有键、杀进程树,最后执行),最后注册
   `addFinalizer(() => s.disposed = true)`(最先执行);调用点 fork 的 get fiber 注册得更晚,最先被中断。每次发布(阶段写回、
   `ToolsChanged`)都核 `!s.disposed` 且代号未变。
6. **失败与重连**:本机确定性失败(两种 missing、EACCES)与 `policy`、`tls-cert`、`http` 4xx、`auth`、`needs_auth` 停在 `failed`,
   直到配置变化、用户重试(`POST /mcp/:name/connect`,递增代)或实例重建。远端 `dns | tcp | tls | handshake_timeout` 与 `http` 5xx
   在实例存活期内**有界后台重连**:30 s 起翻倍、封顶 10 min,每次 = 递增代 + 在调用点 fiber 内重新 `get`;成功、销毁、配置变化或
   用户断开即停,成功后退避复位(网络 lane 接口请求 ②)。
7. **预算**:准备 = 一次 stat;连接+initialize = `mcp.timeout ?? 30s`;`tools/list` = catalog 超时;调用 = `requestTimeout`。去掉
   `ext-config.ts:460-521` 的 5 秒补写(`index.ts:874`);已写进第三方条目的 5000 不回收。
8. **执行走服务入口**:`McpTool` 带 `{origin, generation, defDigest}`;`session/tools.ts:480-487` 与 `tool/code-mode.ts:185`(F5)都改调
   `mcp.callTool(origin, name, args, {generation, defDigest, timeout, signal, onprogress})`,由它取**当前**连接;代变了且定义摘要不同
   ⇒ 响亮失败「工具定义已变化,请重试」,相同 ⇒ 用新连接。一次模型请求的工具集合在 prepare 时固定。
9. `session/system.ts`、`prompt.ts` 不改。ui-mac 消费方 `ext-mcp-activation.ts:218-221`、`hub-view.ts:282-289` 把 `connecting` 映射为
   「准备中」,远端失败层文案用网络 lane 的 `netFailureCopy`。

被否决:只缩短全局 timeout;闭包内 fork 工作再回填状态(违反 `AGENTS.md:107`,且别的方法读到半成品);返回空列表省等待;
每轮开始前「等一小会儿」;桌面侧给云连接器单做重连(状态机外再造恢复所有者,网络 lane §2.4 同判)。

### 2.3 第一方 Office:可发现与可执行分开

1. 构建期导出:`ui-mac/scripts/gen-office-mcp-tools.ts` 以模块方式载入 `server.py` 调 `tools_for()`(不改 `server.py` 字节),写
   `resources/office-mcp/tools.json`(`{serverSha256, formats}`),入库;测试重生成逐字节比较。
2. `plugin/src/alpha-first-party-mcp.ts`(ADR-043 命名谓词内):`declaredFirstPartyTools(name, entry, env, readFile)` 只在 `entry.command`
   与 main 经 `ALPHA_OFFICE_MCP_MANIFEST` 声明的随包命令逐 token 相等、且 `server.py` 摘要一致时返回该格式的定义。
3. `tools()` 对未就绪的第一方服务给声明定义(identity 与连上后相同);`session/tools.ts` 与 Code Mode 子目录(`code-mode.ts:247`)
   都经同一 `tools()` 拿到它们,执行都经 `mcp.callTool` 只等该服务;连上后 `tools/list` 与声明不一致 ⇒ 本次调用失败并弃用声明。
4. 第三方首次握手前不进工具表。

被否决:改登记为插件工具(身份变 plugin,MCP 绑定失效);从目录短文案猜 schema;用旧缓存定义当已连接。

### 2.4 Office/PDF 运行环境随应用交付

1. **完整闭包锁定**(F6):`ui-mac/resources/office-runtime/requirements.in` 只列五个顶层包;开发期用解析器按
   `aarch64-apple-darwin` / `x86_64-apple-darwin`、Python 3.11 生成两份带哈希的 lock(`requirements-arm64.lock`、`requirements-x64.lock`),
   覆盖全部传递依赖(今天的闭包 11 个,§1.3);运行时包(python-build-standalone 3.11)URL + sha256 记在 `office-runtime.lock`。
2. **构建**:prebuild `scripts/build-office-runtime.ts` 下载并校验运行时,`pip install --require-hashes --only-binary=:all: -r <arch lock>`
   (不加 `--no-deps`,哈希模式下缺一个依赖即失败)+ `pip check`,`compileall` 预编译,删掉 `test/`、`tkinter`、`idlelib`、`ensurepip`、`pip`。
3. **构建验证真实能力**(F6):用随包解释器以 `-I` 逐个 import 闭包里的顶层模块;再经 stdio 驱动 `server.py`,四种格式各「写一个
   样例文件再读回」并比对内容。x64 产物在有 Rosetta 时以 `arch -x86_64` 跑同一验证,没有则响亮跳过并由 T23 覆盖。
4. **打包与签名**:darwin 下 `extraResources` 加 `native/office-runtime/build/<arch>/ → office-runtime/`(形同 `electron-builder.config.ts:150-160`
   的 alpha-fence 条目);`beforePack`(`assertMacTargetArch`,#1496)扩到 `office-runtime/` 下每个 Mach-O 含目标切片。entitlements
   不变:已有授权 + 同 Team 签名(§1.3,Q3);签名后的包能否运行归 T23。体积上界 ≈ 78 MB + 45 MB/架构,实际数由构建日志打印。
5. **命令与单一权威**:`alphaOfficeInstallCommand`(`office-advisories.ts:113-124`)改为
   `["{alphaResources}/office-runtime/bin/python3","-I","-B","{alphaResources}/office-mcp/server.py",format,"{workspace}"]`;`validateServer`
   的命令头 `python3` 在白名单(`ext-config.ts:79`)。`ext-mcp-policy.ts:47-64` 对四个第一方条目不再比对卡片命令 token,一律写 main 模板。
6. **安装与详情的准备检查**(F7):main 新增「随包 Office 运行时是否就绪」事实(随包 `python3` 可执行且 `server.py` 在资源根内),经 IPC
   暴露;`extension-hub.tsx:1205-1210`、`alpha-ui/hub-install-watcher.tsx:175-176`、`extension-detail.tsx:607-614` 对这四个 catalog id 用它,
   不再读卡片的 `runtimeDep`。跨仓:alpha-web 卡片里的 uv 命令与 `runtimeDep` 对这四个 id 不再被消费,清理为可选跟进,不阻塞。
7. **存量迁移**:`alpha-office-instance.ts` 的 `reanchorOfficeCommand`(`:89`,boot 时 `index.ts:873` 已在跑)识别旧 uv 模板 ⇒ 改写为新模板
   并去掉 `timeout`;幂等、写锁内、响亮日志。
8. 随包可执行文件缺失 ⇒ `failed/dependency_missing`,修复动作 =「重新安装 Code Puppy」;不弹全局错误,不重启引擎。

被否决:首次使用时下载组件包;随包 uv + 离线轮子;系统 `/usr/bin/python3`;用 TypeScript 重写四个工具;Local Daemon(owner 已排除);
只锁五个顶层包配 `--no-deps`(F6:握手通过、真读写才缺库)。

### 2.5 上游同步遵守接管清单

1. 一份清单:`north-star-guard.sh` 增只读模式 `--print-takeover`,逐行打印 `UPSTREAM_EXCLUDES` 的路径(不跑 git、不判字节)。
2. `sync-upstream.yml` 在 `Merge` 步之前新增 `Takeover intake check`:从合并前的可信树取脚本
   (`git show "$OLD_ALPHA:scripts/north-star-guard.sh" | bash -s -- --print-takeover`),`MB=$(git merge-base alpha dev)`,
   `touched = git diff --name-only --no-renames $MB $NEW_DEV`,与清单前缀匹配。有交集 ⇒ 不合并、不出 bundle,把每条路径的上游提交、
   上游差异与我方差异写进 step summary 与 artifact,`::error title=takeover upgrade review required::` 失败。
3. 无交集才合并;剩余冲突都在清单外,报错改为「既不是干净上游也不是登记接管:按 ADR-029 登记或还原」并列路径。
4. 合并后再断言 `git diff --name-only $OLD_ALPHA alpha -- <清单>` 为空。
5. **受审集成必须保留上游祖先**(F8):人工移植落在一个真合并提交上,第二父 = 本次审查的 `dev` SHA(形同 `9dba00807`);该 PR 用
   `gh pr merge --merge` 合入或直接推这个合并提交,**禁止 squash / rebase**。`docs/runbooks/ci.md:255` 的 squash 默认给「受审上游
   集成」写明例外,告警 issue 文案同步写出。之后 merge-base 前移,下一次自动同步只看新增的上游提交。
6. 候选 job 仍无推送凭据(`#899`);新步骤只执行 alpha 树里的脚本;`docs/architecture/upstream-integration.md` 同票更新。
7. 现状:27 条清单外冲突会让新流程以新文案继续失败,直到逐条登记或还原 —— 一次性清理,不属于本机制。

被否决:全局 `merge=ours` 或对接管路径自动取我方;工作流里另写一份路径表;继续只靠冲突判断;把接管文件移出仓库;
移植后 squash 合入(merge-base 不前移,下次又命中同一批路径)。OPTIONAL:先并入第一个触及清单的提交之前的部分。

### 2.6 T07:重启由 main 按白名单决定,恢复有终态

- 允许触发 respawn:崩溃自愈、日志失控、目录看护、身份变化、用户发起的 provider/BYOK/官方连接器变更、凭据在场性变化或热写失败。
  在 `sidecar-lifecycle.ts` 列成 `SidecarRespawnTrigger` 联合类型,写进 `main.sidecar.respawn.fork.start` 的 `reason`。
- 不得触发:令牌续期、任何单个 MCP 失败(含 Office 运行时缺失、云连接器网络失败)、远端目录刷新失败(目录 lane 冻结接口保证)。
- renderer 只发意图:引擎停摆走 `recovery-submit`/`retry-engine`;MCP 重试走 `/mcp/:name/connect`。
- 终态:普通续期不进 `recovering`;structural 确认见 §2.1-2;每个 MCP 停在 `ready` 或带 `code` 的 `failed`(网络类在退避中重连);
  generation 20 秒终态不变。

### 2.7 上游文件改动登记(ADR-029 / ADR-041 / north-star 例外)

| 文件 | 归类 | 说明 |
|---|---|---|
| `opencode/src/mcp/index.ts` | 已接管(ADR-041,`north-star-guard.sh:161`) | 先例 `#1011`、`#1547` 均未另立 ADR |
| `opencode/src/session/tools.ts` | 已接管(`:169`) | execute 改走 `mcp.callTool` |
| `opencode/src/tool/code-mode.ts` | 已接管(`:168`) | `:185` 改走 `mcp.callTool`(F5) |
| `opencode/src/session/llm.ts` | 已接管(`:171`) | 遥测剔除认证头(F1) |
| `opencode/test/mcp/lifecycle.test.ts`、`test/session/tools.test.ts`、`test/tool/code-mode.test.ts`、`test/tool/code-mode-integration.test.ts` | 已接管(`:164,189,179,178`) | 补桩与用例;新测试优先放 `test/mcp/alpha-*.test.ts`(ADR-043) |
| `sdk/js/src/v2/gen/types.gen.ts`、`sdk/js/src/gen/types.gen.ts` | 已接管生成物(`:130,160`) | 只改这两份里的 MCP `Status`;同目录其它文件不在授权内 |
| `sdk/openapi.json` | **不改**(不在例外表) | 先例:ADR-033 改了公开 schema(`fd357d58b`),该文件至今无 alpha 提交 |
| `plugin/src/alpha-cloud-authority.ts`、新 `alpha-first-party-mcp.ts`;`schema/src/alpha-net-failure.ts`(网络 lane) | alpha 自有(ADR-043) | 无需例外 |
| `opencode/src/provider/provider.ts`、`session/system.ts`、`config/variable.ts`、`session/prompt.ts` | **不改** | — |
| `packages/opencode/AGENTS.md` | **不改** | §2.2 按其规则分解,不需要改写规则 |
| `.github/workflows/sync-upstream.yml`、`scripts/north-star-guard.sh`、`docs/runbooks/ci.md` | alpha 自有 | 发布链,独立 PR |

## 3. 安全面与不变量

整类边界:凭据从签发到请求头的每一跳(含遥测出口);每个 MCP 子进程树的生到死;一份接管清单的读者;随包可执行物的来源。

- **I1 凭据只有一个运行期源**:sidecar 内只从 `<userData>/alpha-secrets/` 现读;值不进 sidecar env、`OPENCODE_CONFIG_CONTENT`、日志、
  renderer;平台 provider 配置只有非凭据占位值。`ALPHA_PLATFORM_AUTH_REF`、`ALPHA_CLOUD_MCP_DEF` 只携带 `{file:}` 引用(测试断言其值
  匹配 `^\{file:/.+\}$`,或定义里的 header 是引用形态)。
- **I2 原子替换**:秘密文件只经 `writeSecretFileAtomic` 写;读者只会读到完整的旧值或新值。
- **I3 旧代不覆盖新代**:续期两次 CAS(`alpha-auth.ts:833-836,873-876`)保持;文件写入在 main 单线程按提交顺序串行;structural 确认只认
  `g ≥ G`。
- **I4 在场性变化必走 structural**,并按 §2.1-2 的合同确认。
- **I5 读不到即拒绝**:平台模型请求与 governed 云 MCP 请求在凭据读不到时失败为认证错误,从不使用 SDK 缓存或已装载条目里的旧值;
  头注入只作用于 `baseURL === ALPHA_BASE_URL` 的 provider 与名字+URL 匹配 `ALPHA_CLOUD_MCP_DEF` 的条目,第三方行为不变。项目插件
  能读同 UID 文件是既定残留(`alpha-secret-files.ts:19-21`),本方案不扩大。
- **I6 遥测不含凭据**:导出的 span 属性里没有 `ai.request.headers.authorization`,也没有令牌子串。
- **I7 进程树有主**:每次 spawn 起即由该次尝试托管,失败、中断、代替换、实例销毁都同时结束父进程与后代;销毁开始后不再发布。
- **I8 重试有界**:确定性失败不重试;网络类重连 30 s 起、封顶 10 min,只在实例存活期内;没有任何 MCP 失败会触发引擎重启。
- **I9 声明定义不等于已连接**:声明工具执行前必须完成 initialize + `tools/list` 且定义一致;只对与随包命令逐 token 相等的条目生效。
- **I10 随包运行时可复现且完整**:运行时与全部传递依赖按两架构 lock 的 sha256 安装;Office 命令只由 main 模板产生。
- **I11 接管内容不被自动改写**:同步在合并前后两次核对清单;清单只有守卫脚本一份,来自合并前的可信树;受审集成保留上游祖先;
  候选 job 不持有推送凭据。

## 4. 子票切分

| # | 标题 · 仓 | 覆盖 | 边界 / out-of-scope / 退出条件 | 尺寸 · 难度 · 依赖 · 独立 PR | 将来拿什么证明 | UI 稿 |
|---|---|---|---|---|---|---|
| 1 | `[REQ-236][CODE] 续期登录改为热应用凭据:引擎不重启、在途回答不中断` · alpha-code | AC7(T24 §2.2)、AC2 子集(T07) | `ui-mac/src/main/{alpha-auth,alpha-secret-files,auth-renewal,sidecar-lifecycle,sidecar-env,alpha-models,index,server}.ts`、`ext/src/plugin.ts`、`opencode/src/mcp/index.ts`(仅 `connectRemote`)、`opencode/src/session/llm.ts`(仅遥测 Proxy)。不做:BYOK/自定义 provider 热化、来源显示(权限 C4)、目录刷新(目录 C1)。退出:§2.1 的 1–5 | L · 难(凭据竞态、秘密与遥测不变量)· 功能上无前置;与目录 C1 同改 `index.ts`/`server.ts`,建议 C1 先合 · 独立 PR | 新 `credential-hot-apply.test.ts`:续期后 respawn 次数 0、不置 unapplied;在场性变化 ⇒ structural,且只有捕获 `g ≥ G` 的健康 fork 才确认(失败、超时、迟到旧 fork 三臂);新 `ext/src/platform-credential-header.test.ts`:读不到 ⇒ 抛 `LoadAPIKeyError`;真引擎 + 真 ext + 本机假网关 `token-hot-apply.engine.test.ts`:换文件后下一请求带新令牌、删文件后请求被拒且假网关收不到任何请求(反向臂去掉钩子即带占位值被拒);遥测用例捕获真实 span 属性无认证头(反向臂去掉剔除即出现);`lifecycle.test.ts` 用**生产形态**定义(注入面产出的 `OPENCODE_CONFIG_CONTENT` 经真加载器替换 + `ALPHA_CLOUD_MCP_DEF`)与 kill-switch 形态各一,覆盖 POST、GET/SSE 重连、404 会话恢复三条路径换凭据;T23:正式包连续三次续期 PID/generation 不变、在途流完整、会话授权仍在 | 否 |
| 2 | `[REQ-236][CODE] MCP 改为逐服务后台启动:一个连接器慢或坏不再拖住对话与其它工具,断网后自动重连` · alpha-code | AC7(T24 §2.3)、AC2 子集(T07) | `opencode/src/mcp/index.ts`、`session/tools.ts`、`tool/code-mode.ts`、两份已接管 TS 生成物、`ui-mac/src/main/{ext-mcp-activation,hub-view,ext-config,index}.ts`。消费网络 lane 的 `classifyNetFailure`。不做:第一方声明定义(#4)、分类器本身(网络 lane)。退出:§2.2 的 1–9 | L · 最难(Effect scope、并发、销毁与重连竞态)· 无硬前置;网络 lane 分类器若未合,先记 `transport`,合后即接 · 独立 PR | 新 `opencode/test/mcp/alpha-mcp-independent-startup.test.ts`:不应答 initialize 的服务在场时快服务工具 1 s 内可用(今天红);建连中销毁 ⇒ 父与后代 pid 都退出、无迟到写回;查找未完成时 invalidate 同样;cwd 不存在 ⇒ `workspace_missing` 不重试;命令不在 PATH ⇒ `dependency_missing`;6 服务时并发 ≤ 4;重连后定义变化的调用响亮失败(普通工具与 Code Mode 各一);远端 `tcp` 失败后按 30 s 起退避重连并回到 `connected`(时钟可注入),`policy`/`auth` 不重连;T23:挂起一个第三方握手时普通对话与已就绪工具完成;云连接器一次网络失败后不重启 App 回到可用 | 否(「准备中」文案走 T19) |
| 3 | `[REQ-236][CODE] 文档工具随应用自带运行环境,不再依赖用户机器上的 uv` · alpha-code | AC6 子集(T17 出货依赖) | `ui-mac/{resources/office-runtime/*, scripts/build-office-runtime.ts, electron-builder.config.ts}`、`shared/office-advisories.ts`、`main/{ext-mcp-policy,alpha-office-instance,ext-ipc}.ts`、`renderer/extensions/{extension-hub,extension-detail}.tsx`、`renderer/alpha-ui/hub-install-watcher.tsx`。跨仓:无必需改动(alpha-web 卡片清理为可选)。不做:各格式能力说明(附件 lane)。退出:§2.4 的 1–8,构建日志打印两架构实际体积 | L · 难(原生扩展签名公证、双架构闭包)· 去掉 Office `timeout` 一步依赖 #2 · 独立 PR(发布链) | 新 `office-runtime-lock.test.ts`(两架构 lock 覆盖 `requirements.in` 的完整闭包:删掉一个传递依赖即红);构建验证脚本的四格式「写后读回」与逐模块 import(只握手不算);`office-mcp.test.ts` 期望命令更新;`alpha-office-instance.test.ts` 旧 uv 命令迁移;`ext-mcp-policy` 卡片仍为 uv 命令时写入 main 模板;安装入口用例:PATH 无 uv、随包运行时在 ⇒ 安装成功(今天红),运行时缺 ⇒ 具名拒绝;T23:无 Homebrew/uv 的干净账户里四格式各读写一次 | 否(失败文案走 T19) |
| 4 | `[REQ-236][CODE] 文档工具在连接完成前即可被选用,调用时只等对应服务` · alpha-code | AC6 子集(T17)、AC7 子集(T24 §2.3) | `ui-mac/scripts/gen-office-mcp-tools.ts`、`resources/office-mcp/tools.json`、`plugin/src/alpha-first-party-mcp.ts`、`opencode/src/mcp/index.ts`(`tools()`/`callTool`)、main 注入 `ALPHA_OFFICE_MCP_MANIFEST`。不做:第三方预广告。退出:§2.3 的 1–4 | M · 难 · 依赖 #2、#3 · 与 #2 同一引擎文件,单独 PR | `office-mcp-tools-snapshot.test.ts`(重生成逐字节相等,改一个 schema 字段即红);引擎用例:Office 连接中时声明工具在表,普通工具与 Code Mode 调用都只等它而另一慢服务仍在连接;连上后定义不符 ⇒ 调用失败并弃用声明 | 否 |
| 5 | `[REQ-236][CODE] 上游同步遵守接管清单:碰到接管文件转人工升级审查,不再静默合并` · alpha-code | AC7(T24 §2.5) | `scripts/north-star-guard.sh`、`.github/workflows/sync-upstream.yml`、`docs/runbooks/ci.md`、`docs/architecture/upstream-integration.md`。不做:27 条清单外冲突的清理、OPTIONAL 部分前进。退出:§2.5 的 1–6 | M · 常规 · 无前置 · 独立 PR(发布链) | 新 `ui-mac/src/main/sync-upstream-takeover-isolation.test.ts`(Bun.YAML 抽步骤体、真 git 仓):非接管改动照常合;无冲突改接管 ⇒ 审查标题失败且我方文件逐字节不变;冲突改接管同上;**人工以合并提交移植后,下一次运行不再命中、照常合并**;变异臂:移植改用 squash ⇒ 再次命中同一批路径;删掉 intake 步 ⇒ 无冲突那例静默合入;`north-star-guard.test.ts` 增 `--print-takeover` 与数组同源;断言工作流里没有字面接管路径 | 否 |

运行时/打包证据全部归共享 RC 回归 T23。本地门:`gate run`(type-check、`bun test src` 对照 base 失败集、north-star 守卫、文档链接);
新测试先在已知坏的输入上证明会红。缺 Electron 二进制的 worktree 里 `process-fence-apply.test.ts`、`network-egress-fence.test.ts` 恒红,不算回归。

## 待 Codex 征询

R1 的四问已答并落进正文(Q1 §2.1-4、Q2 §2.2-5、Q3 §2.4-4、Q4 §1.1/§2.1-5)。编排器裁定不开第二轮,此处不再新增。

## 待 owner 裁决

无。自定、可回滚的默认值:

- 文档工具运行环境随包交付(每架构约 +78–123 MB 上界)。撤法:§2.4-4 改为首次准备下载,命令模板不变。
- 接管文件被上游触及时整次同步停下等人工移植。撤法:启用 §2.5 的 OPTIONAL 部分前进。
- 四个第一方 Office 条目的命令与准备检查只认 main。撤法:恢复 `ext-mcp-policy.ts:56-64` 比对与卡片 `runtimeDep` 检查并同步 alpha-web。
- 云连接器网络类失败的后台重连 30 s 起、封顶 10 min。撤法:去掉重连,恢复「停在 failed 等用户重试」。

转给其它 lane 的接口事实:#1 不再借 10 分钟换代应用新目录(目录 lane §2.4 默认值,加强归它);云工具来源显示归权限 lane C4,#1 不改变它;
#2 消费网络 lane 的 `classifyNetFailure` 与 `netFailureCopy`;#1 与目录 C1 同改 `main/index.ts`、`server.ts`。

## 仍是推断、没跑过的断言

- 请求级 `authorization` 在真实请求里盖过 SDK 配置头;遥测 Proxy 同时覆盖 `startSpan` 与 `startActiveSpan` 两条创建路径 —— 源码推导,
  #1 的线上与遥测测试才是证据。
- 云 MCP 在同一连接上换头后继续可用(服务端无状态,未跑)。
- 这台机器的 `spawn uv ENOENT` = 陈旧实例目录作 cwd(日志相关 + Node 复现,未在打包应用内复现);5 秒超时 = `uv run --with` 启动慢(未计时)。
- 随包运行时裁剪后的体积、签名后能否运行(只有未裁剪上界实测;运行归 T23)。
- 内层 `ScopedCache` 在查找未完成时被 invalidate,已取得的资源随键 scope 关闭而释放 —— 依 API 文档与 Codex Q2 推断,由 #2 的首批用例证明。
- 依赖闭包按 Python 3.11 + 两架构解析后与本机缓存一致 —— 本机只有 arm64 样本。
- 接管路径被上游触及的频率只量了 2026-09-21..10-09(2/104);10-10 之后上游未拉取。
