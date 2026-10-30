---
title: REQ-236 方案基线 —— 云端生图、产物交付与输入文件(T12–T17 解析半)
kind: design
status: draft
owners:
  - Code Puppy desktop and cloud maintainers
last_reviewed: 2026-10-30
review_after: 2027-01-30
---

# REQ-236 方案基线:云端生图、产物交付与输入文件

本基线服务 [alpha-work#118](https://github.com/jinjunnn/alpha-work/issues/118) 的 T12–T16 与 T17 的
「各文件类型解析路径、模型读取能力、本机/云端边界」那一半,对应父 AC4、AC5、AC6。它是这些项**升 Ready 的门**,
不是实现记录;任何一节都不表示代码已改、已部署或已验证。

用户视角三件事:让助手画一张图,对话里能看到「在排队 / 在生成 / 好了(图就在这)/ 失败(为什么、怎么办)」,
而不是靠助手最后一句话;产物页先给结果、只放本次对话的东西;拖进来的文档要么真被读到,要么明确说没读到。

**读法。** 坐标全部钉在:alpha-code 正式版 0.1.22 = `393a35c2a`(本 worktree 的 `HEAD~3`,只多三个文档提交);
alpha-platform `1bcfe09`;alpha-code-plugin `d9e3ca2`。写作 `仓:路径:行`,省略仓名即 alpha-code。
`ui-mac` / `ext` / `opencode` / `schema` 均为 `packages/` 下的包;`gateway/` 指 alpha-platform `packages/gateway/`。
三个仓都没有 `docs/architecture/constraints.md`(`ls` 三处均 `No such file`),本基线不涉及已登记偏离。

**边界(别的 lane,只写接口点):** Office/PDF MCP 的启动、`spawn uv ENOENT`、随包运行环境与逐服务状态归引擎生命周期 lane;
模型能力元数据(是否支持图片 / PDF 输入)归目录与模型 lane;工具来源分类与权限(含 `not-asserted`)归权限与来源 lane;
`cloud_cloud_dispatch` 一类重复拼接的改名归品牌命名迁移 lane;图片**理解**复用 REQ-228 / alpha-code#1421。
本基线消费的冻结接口见 §2.6。

---

## 一、只读勘破

### 1.1 T12 —— 生图首败的真实参数,以及模型看到的契约从哪来

**首败形态**(alpha-work#118 评论 2026-10-30T03:54,会话记录):首次 `kind: "image-generation.prompt"` → `unknown_pipeline_kind`;
重试 `kind: "image-generation"` + `input.prompt` 成功。拒绝出处 `gateway/src/lib/cloud-core.ts:226`
(`unknown pipeline kind: <kind>`,不列合法值)。

模型看到的 `cloud_dispatch` 有且只有三处来源,两处在服务端、一处在桌面:

| 来源 | 坐标 | 事实 |
| --- | --- | --- |
| 工具说明 | `gateway/src/cloud-mcp.ts:61-73` `dispatchDescription()` | 从 `PIPELINE_REGISTRY` 每次现算(单一权威 ✓),排版**一行一字段** `- ${kind}.${name} = ${desc}`(`:64`)。生图那一行字面就是 `- image-generation.prompt = Required description, …` —— 与首败时模型填的 kind **逐字相同**。 |
| inputSchema | `cloud-mcp.ts:452-465` `CLOUD_DISPATCH_BROADCAST_SCHEMA` | `kind: pipelineBranch.shape.kind.optional()`(`:455`)= `z.string().min(1).max(128)`;`:48-50` 注释写明「`kind` 仍然是 `z.string()`,不改 enum」,理由是 REQ-164 基线 §4 Tier A「新增 kind 不变成对外协议变更」。 |
| 桌面工厂技能 | `ui-mac/resources/factory-skills/cloud-capabilities/SKILL.md:38-46` | **手抄**一张 kind 表(`research`/`code-review`/`image-generation` → `{prompt}`)。插件早在 `alpha-code-plugin d9e3ca2` 删掉了同类复述(「kind 清单不再手抄一份 —— 改为读 cloud_dispatch 的工具说明」),桌面这份没跟。被 `ui-mac/src/main/factory-skills.test.ts:303-312` 钉成期望值。 |

另两处不是模型来源但相关:`ext/src/cloud-contract-hook.ts:36-43` 在 `tool.execute.before` 按 vendored
`CloudJobRequestV1`(`kind` 仅 `string 1..128`)校验,`image-generation.prompt` 照样放行;服务端 handler 的严格 union
(`cloud-mcp.ts:192-194`)同样只判字符串,真正拒绝发生在 `dispatchJob` 的注册表查询。说明与 schema 都原样到达模型:
`opencode/src/mcp/catalog.ts:42-52` `convertTool` 透传 `description` 与 `properties`(只覆写根级 `additionalProperties`)。

判据现状:`gateway/test/mcp-tool-discoverability-461.test.ts:132-148` `broadcastKinds()` 用 `/^- ([^ =]+) = (.+)$/` 再按第一个
`.` 切 kind/field —— 判据本身就把「`<kind>.<field>`」当成文法,所以这个易误读的形态被测试锁死。插件文案
`alpha-code-plugin:skills/alpha-cloud/SKILL.md:24` 还把它当示例(「形如 `- research.search = ...`」)。

**结论:**单一权威(注册表)本身是对的;错在投影的排版让「kind 名 + 点 + 字段名」与「一个 kind」同形,
而 schema 对 kind 不设值域,所以没有任何一层在派发前拦住它。说明排版**是否直接导致**模型选错仍是推断(§七)。

### 1.2 T13 —— MCP 与 HTTP 已经落到同一业务入口

`gateway/src/lib/cloud-core.ts:176` `dispatchJob` 的全部调用方(`grep -rn "dispatchJob(" gateway/src`,3 处):
MCP `cloud-mcp.ts:195`(surface `"mcp"`)、HTTP `routes/cloud-jobs.ts:136`、定时 `routes/cloud-schedules.ts:457`。
准入、预授权、幂等、计费都在 `dispatchJob` 之内,两面不分叉。桌面侧 `ui-mac/src/main/alpha-cloud-jobs.ts:1-5` 的 main HTTP
(`dispatchCloudJob :117-129`、`getCloudJobStatus :176`、`listCloudArtifacts :205`、`downloadCloudArtifactTo :214`)与
引擎经 MCP 的 `cloud_*` 打的是同一套 jobs API。

已有 owner 裁决 alpha-work `governance/ADR-004-cloud-capability-integration-surfaces.md`(2026-10-15 采纳)直接约束本题:
决策 2「调用决策面与交付面可以分开:agent 经 MCP 发起任务、拿到产物描述符,字节由宿主经 HTTP 鉴权下载落盘 ——
『产物是二进制』不等于必须新造原生 agent 工具」;决策 4「同一云后端操作,在 agent 工具表里只有一种包装」;
决策 5「`cloud_dispatch` 承载全部云任务 kind,不按 kind 拆」。

### 1.3 T14 —— 今天时间线上的生图是怎么「宣告完成」的

1. **任务状态只来自模型的工具调用。**桌面发现 MCP 派发的任务只有一条路:`renderer/alpha-ui/cloud-run-watcher.tsx:59-66`
   监听引擎 firehose,`cloud-run-core.ts:41-56` 只在**某个 `cloud_await`/`cloud_status` 的输出已是终态**时命中
   (`:37` 非终态返回 null)。模型若派发后不再 await(或 await 超时就收尾),桌面永远不知道这个任务,图片不会落盘。
2. **派发卡片是第三方降级卡。**`session-timeline/cards/tool-card-model.ts:268-279`:云专用卡要求 `category === "alpha-cloud"`,
   即持久化 `authority.kind === "alpha-cloud"`;本次会话四个云调用的 authority 都是 `not-asserted`(#118 评论 2),
   所以落到 `:281-293` 的 metadata-only 卡。修来源证明归权限与来源 lane;**产物行不受影响**:`timeline-model.ts:685-697`
   `artifactLinksOf` 与 watcher 共用 `cloud-facade-identity.ts:13-21` 的 identity 判定(`source="mcp" && origin="cloud"`,
   #879/#934 裁决「不比对 authority」)。
3. **完成后只有一行文件名链接。**`timeline-model.ts:1007-1015` 对含 `artifacts` 的完成态云输出出一行 `kind:"artifacts"`;
   点击经 `cards/timeline-intents.ts:39-50` `bindFocusArtifact` → 右栏产物面板。对话里没有图本身。
4. **「已保存」那句话是模型编的。**工厂技能 `SKILL.md:48` 要求「下载成功后才声称文件已保存,并给出实际路径」,
   可模型手里**没有**下载工具,下载由宿主 watcher 在模型看不见的地方做;模型无从得知成败。

### 1.4 T15 —— 下载失败的可复现根因,以及「切换会话串结果」

**日志事实。**`~/Library/Application Support/ai.opencode.desktop/logs/20261028T033016/main.log:8223,8266`:
`alpha-cloud-jobs: artifact download failed (network)` 两次(23:41:24、23:47:21);另 `20261030T021718/main.log:445`
`alpha-cloud-jobs: fetch failed TypeError: fetch failed`(10-29 23:17:08,`authed()` 的状态/列表请求)。
`grep -h "cloud-jobs\|cloud: artifact\|manifest register" */main.log | sort | uniq -c` 在全部 8 个运行目录里只有这 3 行。

**根因链(全部源码可读、可复现):**

| # | 缺陷 | 坐标 | 用户看到什么 |
| --- | --- | --- | --- |
| R1 | `network` 是兜底分类,底层原因被丢掉 | `alpha-artifact-download.ts:413-419`(无响应头 90 s / fetch 抛)与 `:334-338`(读流抛 / 相邻块 90 s 静默)都只回 `network` + `detail`;`alpha-cloud-jobs.ts:229-231` 记日志时**只写分类码不写 detail**;`:108` 记 `fetch failed` 不带 `error.cause` | 日志无法区分连接失败、首包超时、断流,历史两次失败的底层原因**无从追溯** |
| R2 | 下载失败被记成「保存成功」 | `alpha-workdir.ts:352-355` 下载失败只 `warnings.push` 后 `continue`,`:375` 仍 `ok: true`;watcher `cloud-run-watcher.tsx:39-47` 只看 `r.ok`,忽略 `warnings`,弹「云任务结果已回流」(`i18n/zh.ts:484`) | 弹出成功提示,图却不在 |
| R3 | 失败后不再重试 | `cloud-run-watcher.tsx:63-65` 先 `flushed.add(runId)`,`persist` 对 `ok:false` 只弹错误不抛,`.catch` 永不触发;`flushed` 跨引擎换代存活(`:72-83` 只换 client) | 同一应用生命周期内这张图不会再自动下载 |
| R4 | 下载器自身没有瞬态重试 | `saveCloudRun` 对每个产物只调一次 `deps.download`(`alpha-workdir.ts:352`) | 一次网络抖动 = 这次交付失败 |

**可失败的复现(不需要真网络):**① 单元级 —— 给 `saveCloudRun` 注入 `download: async () => ({ ok:false, error:"network", detail:"no response headers within 90000ms" })`,
断言返回值把失败结构化地交出来:今天返回 `{ ok:true, warnings:[…] }`,断言红;再把同一结果交给 watcher 的 `persist`,断言「不弹成功」:今天红。
② 传输级 —— `downloadArtifactToFile` 注入 `idleTimeoutMs: 50` + 一个不回响应头 / 回一半就断的本地 `Bun.serve`,断言
`outcome.detail` 区分两种阶段且日志行含该 detail:今天日志行只有 `(network)`,红。真机层面的底层原因要等 R1 修好后的下一次现场。

**切换会话串结果。**面板确实按会话身份重挂载(`session-rail/artifacts/session-rail-artifacts.tsx:41-45`),但数据是
`runArtifacts.projectUsage(identity.directory)`(`:64`)—— 整个项目的 run —— 默认选最新一个(`:78-84`)。归属信息在源头就丢了:
firehose 事件里的工具 part 带 `sessionID`,`cloud-run-core.ts:13-18` 的 `CloudRunHit` 只留 `directory/runId/terminal`;
`saveCloudRun` 不写任何会话字段;manifest 也没有(`main/artifact-manifest.ts:62-67`)。这与 REQ-126 #660 裁决 D 的纪律一致
(`docs/design/2026-07-28-req126-artifacts-cross-run.md:55-69`:「本面板的任何文案都不得再对项目级数据作会话级断言」)——
面板从没声称按会话,但父票 AC5「产物属于正确会话」要求它按会话,前提是**先有归属数据**。

**产物身份。**`shared/cloud-artifact-descriptor.ts:60-67`:`contentRef.url` 是**稳定的 server-relative 路径**,鉴权靠 main 持有的 bearer;
身份 = `descriptor.id`(`art_<jobId>_<index>_<fp8>`,`:93-101`)+ `sha256`。manifest 写入时强制 url 以 `/` 开头
(`artifact-manifest.ts:101-110`)。所以「下载地址不是产物身份」今天**已成立**;短期的是 bearer,不是 URL(§1.6 订正架构稿)。

### 1.5 T16 / T17 —— 附件通道逐类,以及内容到底有没有交给模型

composer 入口:`renderer/alpha-ui/alpha-composer.tsx:830-847` `readFiles` → `composer-attachments-core.ts:45-55` `classifyAttachment`:
只收 `image/png|jpeg|gif|webp` 与 `application/pdf`(`:33-36`),其余一律拒「仅支持图片与 PDF;项目内文件请用 @ 引用」;
图片 ≤5 MB、PDF ≤10 MB、≤8 个(`:39-41`)。读成 data URL(`alpha-composer.tsx:819-827`),发送走 v1 `session.promptAsync`
(`:1712`),附件为 `{type:"file", mime, url:data…, filename}`(`composer-attachments-core.ts:79-81`)。拒绝只弹一次 toast(`:858-866`)。
发出后用户气泡显示附件 chip(`timeline-model.ts:294-312`),data URL part 存在引擎会话库里,**重载保留**。

引擎侧对每类 part 的真实处理:

| 类型 | 能进 composer 吗 | 引擎做什么 | 模型实际收到 |
| --- | --- | --- | --- |
| PNG/JPEG/GIF/WebP | 能 | file part 原样,`image.normalize`(`opencode/src/session/prompt.ts:1053-1061`) | 模型 `capabilities.input.image` 为真 → 图片;为假 → `provider/transform.ts:432-440` 换成 `ERROR: Cannot read … Inform the user.`。平台模型一律 `inputModalities(false)`(`ui-mac/src/main/alpha-models.ts:146`),所以登录平台时靠 REQ-228 云识图在 `chat.message` 自动转写(`ext/src/cloud-vision.ts:1-6`) |
| PDF | 能 | file part 原样 | **对 Code Puppy 注入的每个模型都读不到**:`alpha-models.ts:48-49` 的 `inputModalities` 只会写 `["text"]` 或 `["text","image"]`(平台 `:146`、BYOK `:108`、自定义节点 `:186`),从不声明 `pdf` ⇒ `capabilities.input.pdf` 恒假 ⇒ `transform.ts:439` 换成 ERROR 文本。本机 PDF 工具存在却**不在这条路上** |
| MD / TXT / 代码 | 不能(拒) | —— | 只能 `@` 项目内文件:`composer-autocomplete-core.ts:306-314` 产 `file://` + `text/plain`,引擎 `prompt.ts:872-946` 调内置 Read 读盘 → 文本。项目外的文本文件进不来 |
| DOCX/XLSX/PPTX | 不能(拒) | —— | 进不来。即便绕过,引擎 `file:` 分支会把字节编成 data URL(`prompt.ts:997-1011`),`mimeToModality` 不认(`transform.ts:10-16`)⇒ 原样透给 provider,结果取决于 provider,不可控 |

本机读取工具的真实形态:`ui-mac/resources/office-mcp/server.py` 四个格式各有 `read_docx` / `read_xlsx` / `read_pptx` / `read_pdf`
(`:123,:207,:231,:255`);路径必须是**授权工作区内的绝对路径**(`:300-313` `require_workspace_path`);`read_pdf` 只取文本层
(`:675-680`,扫描件得到空串)。启动命令 `uv run --no-project --with … server.py <format> <workspace>`(`shared/office-advisories.ts:113-124`)
—— 0.1.22 现场四个都 `spawn uv ENOENT`(#118 评论 04:11),属引擎生命周期 lane。

**结论:**「能选中 / 能列出工具」与「内容交给了模型」在今天确实是两件事 —— PDF 进得来但到不了模型;Office 与项目外文本根本进不来;
本机文档工具存在,但附件流程从不把文件交给它。

### 1.6 已有断言逐条复核

| 断言 | 出处 | 判定 |
| --- | --- | --- |
| main HTTP 与 agent MCP 访问同一云任务业务入口 | 架构稿 §1 表「云任务与产物」;#118 正文 | **对**:§1.2 三个调用方同一 `dispatchJob` |
| 已有 artifact service、descriptor、manifest、workbench | 同上 | **对**:`artifact-service.ts`、`cloud-artifact-descriptor.ts`、`artifact-manifest.ts`、`artifact-workbench/` 均在 |
| 「下载 URL 是短期传输凭据,不是产物身份」 | 架构稿 §2.4「图片与文件」 | **半对**:「不是身份」对;「URL 是短期凭据」**错** —— URL 是稳定路径,短期的是 main 的 bearer(§1.4) |
| 「产物以稳定引用绑定会话」 | 架构稿 §2.1 表 | **作为现状是错的**:今天没有任何会话绑定(§1.4),这是本基线要补的目标 |
| 服务端说明用 `- <kind>.<field>` 广播,恰好出现 `image-generation.prompt` | #118 评论 1 | **对**:`cloud-mcp.ts:64` |
| 面板按 `projectUsage(directory)` 取全项目 run 并默认选最新 | #118 评论 3 | **对**:`session-rail-artifacts.tsx:64,:78-84` |
| 历史 main 日志两次 artifact download failed (network) | #118 评论 4 | **对**,且另有一次 `fetch failed`(§1.4) |
| 普通附件通道仅接受图片/PDF | #118 正文、评论 5 | **对**:`composer-attachments-core.ts:33-36,:50` |
| 「云识图自动转写走 HTTP,模型追问走 MCP,复用同一识图服务」 | #118 评论 5 | **对**:`ext/src/cloud-vision.ts:3-6` |

### 1.7 跑过的全称断言

- 「`dispatchJob` 只有三个调用方」:`grep -rn "dispatchJob(" packages/gateway/src`(alpha-platform)→ `cloud-mcp.ts:195`、`routes/cloud-schedules.ts:457`、`routes/cloud-jobs.ts:136`、定义 `lib/cloud-core.ts:176`。
- 「Code Puppy 注入的模型从不声明 PDF 输入」:`grep -c "pdf" packages/ui-mac/src/main/alpha-models.ts packages/ui-mac/src/main/alpha-config-injection.ts` → `0` / `0`;`alpha-config-injection.ts:555` 的底表条目是 `modalities: { input: [], output: [] }`。
- 「桌面代码零处构造生图 pipeline input」:`git grep -n "html-generate\|image-generation" -- packages/ui-mac/src packages/ext/src packages/opencode/src ':!*.test.ts' ':!*vendor*' | wc -l` → `1`(一处注释,`host-extension-package-contract/generate-artifact.ts:149`)。
- 「全部运行日志里的云下载/取数失败只有 3 行」:见 §1.4 命令。
- 「三仓无 constraints.md」:`ls …/docs/architecture/constraints.md` ×3 → `No such file or directory`。

---

## 二、选定方案

### 2.0 一句话

**契约在服务端收紧(kind 只能从注册表里选、说明把 kind 与 input 分开写);派发仍是模型经 MCP;交付整段归宿主经 HTTP
(跟踪任务、落盘、记归属、在对话里显示);文档附件走「本机存一份 → 本机读取工具读 → 对话里显示读没读到」。**
不新增云执行链、不按 kind 拆 MCP 工具、不新造原生生图工具。

### 2.1 T12:收紧 `cloud_dispatch` 的输入契约(alpha-platform)

1. **kind 有值域。**把 `CLOUD_DISPATCH_BROADCAST_SCHEMA`(`cloud-mcp.ts:452`)从模块常量改为 `dispatchBroadcastSchema()`,
   在 `buildMcpServer` 内每次构造;`kind` 改为 `z.enum(Object.keys(PIPELINE_REGISTRY))`(**含已停用 kind**,让它们照旧到达
   `cloud-core.ts:230` 拿到 `pipeline_kind_retired` 的「请改用本机」说明,不被 enum 提前截成一句无指导的校验错)。
   词表仍只来自注册表 —— 新增一行注册表 = 广播与值域同时跟上,REQ-164 Tier A「MCP 侧 0 处改动」照旧成立;HTTP wire 合同
   (`CloudJobRequestV1.kind: string`)**不动**,handler 内严格 union(`:192-194`)仍是唯一准入判据,enum 只是派发前多一道零副作用的拒绝。
   这修订了 `cloud-mcp.ts:48-50`「不改 enum」那条注释的理由,需同步改注释并在 PR 正文写明(§五 Q1/Q2 征询)。
2. **说明把 kind 与 input 分开。**`dispatchDescription()` 改为按 kind 分组、kind 名用引号、字段一律带 `input.` 前缀,例如:
   `kind "image-generation" (input fields below go inside "input")` 下一行 `  - input.prompt = <desc>`。仍是一行一字段、
   行尾为界(保留 ap#469「分隔符不和自由文本抢字符」的理由),停用 kind 另起一行「refused: office-report, html-generate」。
   形状由新判据解析,不靠人读。
3. **判据随改。**`test/mcp-tool-discoverability-461.test.ts:132-148` 的 `broadcastKinds` 改解析新形态(kind 行 + `input.` 字段行),
   原六条断言语义不变;新增:tools/list 里 `kind.enum` == 注册表键集(含 `withFakeKind` 活体臂);以 `kind:"image-generation.prompt"`
   调 `cloud_dispatch` ⇒ 返回错误且 `pipelineFetch` 未被调用(与 `transport-contracts-v1.test.ts:226-230` 同一手法)。
4. **桌面与插件删掉复述。**桌面 `cloud-capabilities/SKILL.md:38-46` 的 kind 表删掉,改为「kind 与 input 字段读 `cloud_dispatch` 的工具说明」
   (与插件 `d9e3ca2` 同一处理);插件 `skills/alpha-cloud/SKILL.md:24` 的示例换成新形态。

### 2.2 T13:MCP 与 HTTP 的分工(按 ADR-004 判据逐段落)

| 段 | 谁决定 / 谁负责 | 集成面 | 落点(全部既有) |
| --- | --- | --- | --- |
| 发起生图 | 模型在推理中决定 | MCP `cloud_dispatch` | `cloud-mcp.ts:186-198` → `dispatchJob` |
| 发起生图(界面表单) | 用户在定制中心点 | HTTP | REQ-235 表单 → `cloud-ipc.ts:94` → `alpha-cloud-jobs.ts:117` → 同一 `dispatchJob` |
| 等待、进度、终态 | 宿主(Code Puppy 专属体验) | HTTP SSE / status | `alpha-cloud-events.ts:28` `subscribeCloudJobEvents`、`alpha-cloud-jobs.ts:176` |
| 取产物描述符与字节 | 宿主 | HTTP | `alpha-cloud-jobs.ts:205,:214` |
| 文本结果给模型 | 模型 | MCP `cloud_await`/`cloud_artifacts` | 保留,外部 harness 也用 |

宿主交付**不依赖**模型是否调用 `cloud_await`。MCP 面对外不变(ADR-004 决策 1、5)。

### 2.3 T14 + T15(交付半):宿主跟踪任务到落盘,并记下归属

**新 main 模块 `ui-mac/src/main/cloud-run-tracker.ts`**(electron-free 核 + `cloud-ipc.ts` 薄接线),替换 watcher「只在终态 await 时 saveRun」的触发:

- `track({ directory, runId, origin })`:按 `directory\0runId` **单飞**(在途即复用同一 promise)。顺序:① `recordRunOrigin`(见下);
  ② 本地已有完整 manifest(每个描述符都已登记且 `state ∈ verified|unverified`)⇒ 直接 `saved`;③ 否则 `getCloudJobStatus`,
  非终态 ⇒ `subscribeCloudJobEvents` 直到终态(复用现有退避、90 s 静默重连);④ 终态 ⇒ `saveCloudRun`(复用),对**瞬态**下载失败
  (`network`、`retryable`、`http-5xx`)最多再试 2 次,间隔取 `alpha-cloud-events-core.ts:19` `backoffMs`;`sha256-mismatch`、
  `unverifiable`、`over-limit`、`not-found`、`forbidden`、`unauthorized` 不重试。⑤ 每次状态变化向所有窗口广播
  `cloud-run-state`:`{ directory, runId, sessionID|null, job: { status, code? }, delivery: { status: "pending"|"downloading"|"saved"|"failed", failures: [{ artifactId, code, detail? }] } }`;
  另给 `cloud-run-state-get(directory, runId)` 供重载后取快照。
- 账户切换 / 登出:订阅随 token 身份变化取消(复用 `getAccessTokenIdentity` 的变化点,具体事件见 §五 Q4),不拿新账户去读旧账户的任务。
- **watcher 改触发点**:`cloud-run-core.ts` 增加对**已受理的 `cloud_dispatch` 完成帧**(输出可解码为 `CloudJobAcceptedV1`)的命中,
  `CloudRunHit` 带上 `sessionID / messageID / partID`(取自 part 本身);终态 await 命中保留(重复 `track` 幂等)。
  `cloud-run-watcher.tsx:37-66` 改为调用 `window.api.cloud.trackRun(...)`,删掉 `flushed` 的「首见即永不再试」语义(去重交给 main 单飞)。
  成功/失败 toast 改由 `cloud-run-state` 驱动,`delivery.status === "failed"` 时不得出现「已回流」字样。
- **`saveCloudRun` 结构化失败**:返回值增加 `failures: Array<{ artifactId, code, detail? }>`(`alpha-workdir.ts:352-355` 同时写入),
  `warnings` 保留给非致命信息;`ok:true` 的语义收窄为「status.json 已写」,交付成败只读 `failures`。
- **日志带上真因**:`alpha-cloud-jobs.ts:229-231` 记 `outcome.error` + `outcome.detail`(已过 `sanitizeTransportError`,`alpha-artifact-download.ts:125-130`)
  + 阶段(`headers` / `body`)+ 已收字节;`:108` 补 `error.cause?.code`。不写 URL query、不写 token、不写提示词。

**归属:`ui-mac/src/main/run-origin.ts`(新)拥有 `.code-puppy/runs/<runId>/origin.json`**,`{ schemaVersion:1, sessionID, messageID?, partID?, recordedAt }`。
它是会话工具 part 这一事实的**派生索引**(真源仍是引擎会话记录),只由 tracker 写;**先写者胜**,后来者 sessionID 不同则拒并记一行;
原子写复用 `alpha-workdir.ts` 的 `writeFileAtomic` + `safeResolveInAlpha`。`artifact-service.ts:1614` `runArtifactUsage` 读出
`sessionID: string | null` 带进 `RunArtifactUsage`(`:1592-1610`)。没有 origin 的 run(定制中心派发、定时任务、本基线之前的历史 run)
一律 `null`,**不猜**。选它而不是在 manifest 里加字段:manifest 只在下载成功后才存在(`registerDownloadedArtifact`),
而归属必须在下载之前、失败时也成立;也不从会话消息里现算,因为历史分页加载(`session-timeline.tsx:106-110` `history.more/loadMore`)会让「本次对话」漏项。

### 2.4 T14(界面半):对话里直接显示图片

- **新时间线行 `kind:"cloudImage"`**:在 `timeline-model.ts:1007` `pushToolTrailing` 里,对 identity 为第一方云 facade(`isCloudFacadeToolPart`,
  与产物行同一枚铸币)、远端名为 dispatch、`state.input.kind === "image-generation"` 且输出可解码出 `job_id` 的 part 出一行(挂在回答之后,不进工作过程折叠)。
  同一回合内该 `job_id` 的 `kind:"artifacts"` 行被它取代,不重复出现。
- **状态只由事实驱动**:派发 part `pending/running` → 「正在提交」;已受理 + `job.status` queued → 「排队中」;running → 「生成中 · 已用 m:ss」
  (起点取派发 part 的完成时刻);`completed` + `delivery` pending/downloading → 「已生成,正在存到本机」;`saved` → 直接显示图片;
  `job` failed/cancelled → 平台给的原因(稳定码 → 文案;额度类附既有 `cloud-open-billing-page` 入口,`cloud-ipc.ts:90-92`);
  `completed` 但 `delivery failed` → 「图片已生成,但没存到本机:<原因>」+「重新下载」。**模型的文字不参与任何状态判定。**
- **取图**:`saved` 后经既有 `runArtifacts.read(directory, runId, {artifactId}, {mode:"bytes"})`(`artifact-ipc.ts:51-63`,≤20 MiB)读字节,
  复用 `artifact-workbench/renderers/renderer-views.tsx:210-260` 的 `ImageView`(blob URL,卸载即 revoke;SVG 不内联,`renderers/registry.ts:21-23`)。
- **看大图 / 保存**:点图 → 既有 `focusArtifact(id, runId)` 打开右栏产物面板的预览;「用预览打开」= 既有 `run-artifact-open-external`
  (`artifact-ipc.ts:65-69`,main 复验后打开私有副本);「保存到…」= 新 IPC `run-artifact-save-copy(directory, runId, artifactId)`:
  `verifyArtifact`(全量 sha256 复核)通过后 `showSaveDialog` + 复制,形制照 `workspace-file-service.ts:221-238`。
  不新增路由、不新增覆盖层(REQ-126 ⑤-1)。
- **重载**:卡片挂载时调 `trackRun`(幂等)+ `cloud-run-state-get`,本地已存则直接出图;任务仍在跑则续订。

### 2.5 T15(界面半):产物页结果优先、默认只看本次对话

- **范围**:面板默认只列 `sessionID ∈ {当前会话及其子会话}` 的 run(子会话取 renderer 会话记录的 `parentID` 链,`session-workspace-core.ts:17-22`);
  一个切换「本次对话 / 项目全部」。`sessionID === null` 的 run 只在「项目全部」出现。这让 #660 裁决 D 的纪律仍成立:会话级说法只罩在有归属记录的数据上。
- **结果优先**:选中 run 的主产物预览置顶(图片即大图),其下一排动作「保存到… / 用预览打开 / 重新下载(仅交付失败时)」;
  run 编号、产物 id、sha256、校验状态、来源、配额条全部收进默认折叠的「技术详情」(复用 `artifact-workbench/metadata-view.tsx`)。
- **下载失败可恢复**:面板的单件下载通道(`session-rail-artifacts.tsx:190-200`,#660)保留;失败文案显示 tracker 给的 `code` 对应的人话,
  技术 detail 进详情。

### 2.6 T16 + T17:附件逐类路径与能力说明

**路径表(本基线选定):**

| 类型 | 选定解析路径 | 本机 / 云端 | 内容到了模型的判据 |
| --- | --- | --- | --- |
| PNG/JPEG/GIF/WebP | 不变:data URL 附件。模型能看图 → 原生;不能 + 已登录平台 → REQ-228 云识图转写(按次计费,图离开本机);都不行 → 发送前就标「当前模型看不了图」 | 原生:随请求到模型服务商;转写:到 Code Puppy 云 | 引擎已有行为,本基线只核验可见性 |
| MD / TXT / CSV / JSON / 代码等 UTF-8 文本 | **新**:composer 接收,统一 `mime: "text/plain"`、保留文件名,≤256 KiB;引擎 `prompt.ts:829-848` 已把 data 文本解码成 synthetic 文本 | 随请求到模型服务商 | 发送即交付(引擎同步解码) |
| PDF | **改**:不再作为 data URL 发给模型(§1.5:对所有注入模型都会被换成 ERROR);改走「本机存一份 → 本机 PDF 读取工具」 | 本机读取;读出的文字随后续请求到模型服务商 | 会话里出现该路径的 `read_pdf` 成功调用 |
| DOCX / XLSX / PPTX | **新**:同上,对应 `read_docx` / `read_xlsx` / `read_pptx` | 同上 | 同上 |

**「本机存一份」**:新 main IPC `composer-attachment-stage(directory, name, bytes)`(`ui-mac/src/main/composer-attachment-stage.ts`):
`ensureAlphaScaffold` 后写 `<project>/.code-puppy/attachments/<uuid>/<sanitizeArtifactName(name)>`(`.code-puppy` 自带 `*` 忽略,`alpha-workdir.ts:237-244`),
单文件 ≤20 MiB(与 `attachment-picker.ts:4` 同值),返回项目内相对路径。只在用户选择 / 拖入 / 粘贴时调用。放进项目目录是因为
本机读取工具只认授权工作区内的路径(`server.py:300-313`)。默认值的撤法:改回「拒收 + 引导 @」只需删掉 composer 的这类分支。

**发给引擎的形状**:一个 `synthetic: true` 的文本 part,`metadata["codepuppy.attachment"] = { v:1, name, mime, size, path, reader: "pdf"|"word"|"excel"|"powerpoint" }`
(v1 `TextPartInput` 支持 `synthetic` 与 `metadata`,`sdk/js/src/gen/types.gen.ts:1433-1445`;键名按命名规范由命名迁移 lane 定稿)。
**读取指令由 ext 写**:在 `chat.message` 钩子(与 REQ-228 自动转写同一钩子族,`ext/src/cloud-vision-hooks.ts`)识别该 metadata,
追加一段指令,工具 id 用 `cloud-websearch-kill.ts` 的 `mcpEngineToolId(server, "read_docx")` 推导(仓里不出现第二份 id 字面量,
同 `cloud-contract-hook.ts:8-9` 纪律);读取工具当前不可用时指令改为「告诉用户无法读取及原因」。Office 二进制**永不**以 file part 进入模型请求。

**状态与回显**:时间线用户气泡里的附件 chip(`timeline-model.ts:294-303` 扩展)读同一 metadata,状态:
「已存到本机」→「等待本机读取工具(准备中 / 连接中)」(消费引擎 lane 的逐服务状态)→「已读取」(同会话出现一次该读取工具的成功调用,
且 `input.path` 等于暂存路径)/「读取失败:<原因>」(工具报错或服务 `failed`)/「本回合没有读取」(回合结束仍无读取调用)/
「读到 0 字(可能是扫描件)」(`read_pdf` 全部页空串)。「重试」= 在 composer 里以同一 metadata 再发一条「请读取附件 X」。
发送前的 composer chip 显示路径标签:「文本 · 直接进对话」「PDF · 本机读取」「Word · 本机读取」「图片 · 模型直接看 / 云端识图 / 当前模型看不了图」。
入口拒绝(类型、超限、读盘失败、暂存失败)改为 chip 内联错误 + 移除 / 重试,不再只有一闪而过的 toast。发送失败保留附件(`alpha-composer.tsx:1719-1726` 已是如此)。

**冻结接口(本基线消费,不设计):**
- 引擎生命周期 lane:`mcpServiceState(serverName) → "disabled"|"configured"|"preparing"|"connecting"|"ready"|{ failed: reason }`,renderer 可订阅;
- 目录与模型 lane:`ComposerModel.inputModalities?: { image: boolean; pdf: boolean }`(缺省 = 未知,chip 标「能力未知」);
- 命名迁移 lane:dispatch 远端名常量(今天 `ext/src/cloud-contract-hook.ts:15`、`tool-card-model.ts:140`)、Office 服务键(`office-advisories.ts`)、metadata 键名、`cloud_cloud_*` 引擎 id 的拼接函数;
- 权限与来源 lane:派发卡片的来源分类;本基线的图片卡与附件状态**只依赖 identity**,不依赖 `authority`。

### 2.7 被否决的替代

| 替代 | 不采用的理由 |
| --- | --- |
| 服务端新增窄工具 `cloud_image_generate({prompt})` | 违反 ADR-004 决策 5「不按 kind 拆」与决策 4「一操作一包装」;要做须先由 owner 修订 ADR-004 |
| 桌面原生生图工具(ext → main HTTP 派发) | 同上决策 4;远程 MCP 无逐工具过滤,`cloud_dispatch` 的生图分支仍可调,形成两份包装 |
| 只改说明排版、不加 enum | 说明是散文,模型照样可能编 kind;enum 在派发前零副作用拒绝,成本只是一行派生 |
| `tool.execute.before` 把 `image-generation.prompt` 改写成正确 kind | 替服务端文法造替身,下一个形态又要补 |
| 继续靠 `cloud_await` 终态发现任务 | 模型不 await 就永远不落盘,状态由模型行为决定 —— 正是 T14 要消除的 |
| 归属写进 manifest | manifest 只在下载成功后才存在,失败的任务恰恰最需要归属 |
| 归属从已加载消息现算 | 历史分页加载会漏 run,「本次对话没有结果」会是假话 |
| Office/PDF 在 renderer 里用现有 OOXML 提取器转文本 | 没有 PDF 提取器;同一类文件出现两个解析器、两份输出;本机读取工具已是 Office 的指定能力 |
| PDF 继续 data URL,只在发送前提示「模型读不了」 | 对所有注入模型都读不了(§1.5),等于宣布 PDF 不可用,而本机工具就在那 |
| 附件存到应用私有目录 | 本机读取工具与进程围栏只放行工作区路径(`server.py:310-312`) |
| 下载失败时整轮自动无限重试 | 确定性失败(校验不符、越界、404)重试只会掩盖;限瞬态码、限次数 |

---

## 三、安全面与不变量

**整类边界:**跨进程(renderer ↔ main ↔ 引擎)、跨租户(job_id 来自模型可影响的工具输出)、跨会话 / 跨项目(归属与展示)、
文件系统(暂存与落盘路径)、凭据(bearer)、远端内容(描述符、文件名、图片字节)、计费(重试是否产生新任务)。

| # | 不变量 | 守在哪 |
| --- | --- | --- |
| I1 | bearer 只在 main;renderer 只收状态快照,不收 URL+token 组合 | tracker 全在 main;`cloud-run-state` 载荷无 URL |
| I2 | 产物身份 = `descriptor.id` + `sha256`;`contentRef.url` 只存 server-relative 路径;重下复用描述符,不缓存任何带凭据的地址 | 既有 `artifact-manifest.ts:101-110`、`alpha-artifact-download.ts:173-183` 同源闸 |
| I3 | 时间线与面板的「排队 / 生成中 / 完成 / 失败 / 已保存」只来自平台 status/SSE 与本机 manifest;「已保存」= manifest 已登记且 sha 复核通过 | tracker + `registerDownloadedArtifact` |
| I4 | 归属只由第一方 facade identity 的 part 产生,sessionID 取自该 part;先写者胜;无归属不得显示在「本次对话」 | `run-origin.ts`;面板过滤 |
| I5 | 任意 job_id 都只能读到当前租户自己的任务(平台按租户 404);进入路径前过 `isSafeRunId` | 平台既有;`cloud-ipc.ts:122` 同款校验 |
| I6 | 自动重试只针对瞬态码,最多 3 次尝试;下载重试**永不重新派发**任务(不产生新扣费) | tracker 重试表 |
| I7 | 同一 `(directory, runId)` 同时只有一个交付在跑 | tracker 单飞 |
| I8 | 登出 / 切账号后不再用新身份读旧任务;在途订阅取消 | tracker 订阅随身份变化 |
| I9 | 附件暂存路径恒在 `<project>/.code-puppy/attachments/<uuid>/` 内,文件名净化,≤20 MiB,只在用户动作时写 | `composer-attachment-stage.ts` 复用 `safeResolveInAlpha` + `sanitizeArtifactName` |
| I10 | Office 二进制不以 file part 进入任何模型请求;文本附件只以 `text/plain` 进入 | composer 构造 + 单测 |
| I11 | 「已读取」只是展示事实,不是授权;读取工具照旧走引擎权限与进程围栏 | 附件状态派生只读 part |
| I12 | `kind` 值域每次从注册表派生,不出现第二份词表;handler 严格 union 仍是唯一准入 | `cloud-mcp.ts` + 判据活体臂 |
| I13 | 日志只含分类码、净化后的 detail、阶段与字节数;不含 token、URL query、提示词、文件内容 | `sanitizeTransportError` |
| I14 | 远端文件名与图片只经被动渲染:文件名走文本节点,图片走 `<img>` + blob,SVG 不内联 | 既有 renderer 纪律 |

---

## 四、子票切分

默认不拆;切分理由:跨仓(①②)、界面需要先过设计稿而交付核心不需要(③先行、④等③与稿)、附件与交付代码区不重叠可并行(⑤)。
运行时 / 打包证据并入共享 RC 回归(T23),不单开发布门。

| # | 标题 · 仓 | 覆盖 | 边界 / out-of-scope / 退出条件 | 尺寸 · 难度 · 依赖 · 独立 PR | 将来拿什么证明 | UI 稿 |
| --- | --- | --- | --- | --- | --- | --- |
| ① | `[REQ-236][CODE] 收紧云任务派发说明:kind 只能从注册表选、input 字段与 kind 分开写` · alpha-platform | AC4 · T12 | 边界:`gateway/src/cloud-mcp.ts`(说明、`dispatchBroadcastSchema()`、`:48-50` 注释)、`test/mcp-tool-discoverability-461.test.ts`、`test/transport-contracts-v1.test.ts`、`docs/architecture/cloud-mcp-resource-surface.md` 的说明格式一句。不做:HTTP wire 合同、注册表内容、新工具、改名。退出:§2.1 三条判据绿;cloud worker 已部署并以真实 tools/list 复核 enum | M · 常规(派生 + 判据改写;MCP v2 预校验的错误形状要实测)· 无依赖 · 是(跨仓 + 部署) | `mcp-tool-discoverability-461.test.ts`(新解析)、新增「kind enum == 注册表」「`image-generation.prompt` 派发前拒、零派发」;T23 格「生图首次调用即正确 kind」 | 否 |
| ② | `[REQ-236][CODE] 插件技能按新的派发说明格式指路` · alpha-code-plugin | AC4 · T12 | 边界:`skills/alpha-cloud/SKILL.md:24`。不做:其余插件文案。退出:示例换新形态、无旧形态残留 | S · 轻 · 依赖①已部署 · 是(跨仓) | `grep -n "research.search ="` 零命中 | 否 |
| ③ | `[REQ-236][CODE] 宿主跟踪云任务直到产物存到本机,记下它属于哪个对话,失败说真话并自动重试` · alpha-code | AC4、AC5 · T13、T14 交付半、T15 下载根因与归属 | 边界:`ui-mac/src/main/` 新 `cloud-run-tracker.ts`、新 `run-origin.ts`、`cloud-ipc.ts`、`alpha-workdir.ts`(`saveCloudRun` 结构化失败)、`alpha-cloud-jobs.ts`(日志)、`artifact-service.ts`(`RunArtifactUsage.sessionID`)、`preload/index.ts`+`types.ts`;`renderer/alpha-ui/cloud-run-watcher.tsx`、`cloud-run-core.ts`;`resources/factory-skills/cloud-capabilities/SKILL.md`(删 kind 表、改「下载由宿主完成,不要声称已保存」)+ `main/factory-skills.test.ts:303-312`。不做:时间线 / 面板视觉、平台侧。退出:§2.3 全部行为有测试,R1–R4 各有一条先红后绿 | M · 难(单飞、SSE 生命周期、账户切换、重试边界)· 无依赖 · 否 | 新 `cloud-run-tracker.test.ts`(派发受理后不 await 也落盘;瞬态失败重试、确定性失败不重试;单飞;登出取消)、`run-origin.test.ts`(先写者胜)、`saveCloudRun` 失败结构化、watcher「失败不弹已回流」;`factory-skills.test.ts` 改写;T23 格「下载故障注入后恢复」 | 否(仅 toast 文案) |
| ④ | `[REQ-236][CODE] 对话里直接显示生成的图片;产物页先给结果、默认只看本次对话、可保存` · alpha-code | AC4、AC5 · T14 界面半、T15 界面半 | 边界:`renderer/alpha-ui/session-timeline/`(`timeline-model.ts` 新行、`session-timeline-view.tsx`、`cards/`)、`session-rail/artifacts/*`、`artifact-workbench/metadata-view.tsx`(折叠复用)、`main/artifact-ipc.ts` + `artifact-service.ts`(`run-artifact-save-copy`)、i18n。不做:tracker 逻辑、新路由 / 覆盖层、run 删除(REQ-126 裁决 E)。退出:对照批准稿;下列测试绿 | M · 常规 · 依赖③合并 + 设计稿批准 · 否 | `timeline-model.test.ts`(`cloudImage` 行各状态、同回合取代产物行、非第一方 identity 不出行)、`session-rail-artifacts.test.ts`(同项目两会话各看各的;无归属只在「项目全部」)、`run-artifact-save-copy` 复核失败不出对话框;UI 对照批准稿;T23 格「生图端到端」「切换会话」 | **是**:生图卡六态(正在提交 / 排队中 / 生成中含计时 / 已生成正在保存 / 完成显示图 / 任务失败含额度类与普通类 / 已生成但未存到本机含重新下载);产物页:结果优先布局、动作排、折叠的技术详情、「本次对话 / 项目全部」切换、空态(本次对话无结果)、交付失败态 |
| ⑤ | `[REQ-236][CODE] 附件支持文本与 Word/Excel/PPT/PDF:本机存一份交给本机读取工具,对话里显示读没读到` · alpha-code | AC6 · T16、T17 解析半 | 边界:`renderer/alpha-ui/composer-attachments-core.ts`、`alpha-composer.tsx`(入口、chip、内联错误)、新 `ui-mac/src/main/composer-attachment-stage.ts` + IPC、`ext/src/` 新 `attachment-reader-hooks.ts` + `plugin.ts` 接线、`timeline-model.ts:294-312`(附件 chip 状态)、i18n。不做:Office MCP 启动与运行环境(引擎 lane)、模型能力元数据(目录 lane)、图片理解(REQ-228)。退出:§2.6 路径表每格有测试;暂存不出 `.code-puppy/attachments/` | M · 难(引擎 part 形状、synthetic 指令、状态派生跨三包)· 依赖引擎 lane 的逐服务状态接口、目录 lane 的 `inputModalities`(可先按接口桩开发,合并前接真)· 否 | `composer-attachments-core.test.ts`(.md/.docx/.pdf 分类与上限)、`composer-attachment-stage.test.ts`(路径逃逸、超限、名字净化)、`attachment-reader-hooks.test.ts`(指令用推导 id、服务 failed 时改为如实告知、Office 不成 file part)、`timeline-model.test.ts`(chip 各状态);T23 格「六类附件 → 发送 → 内容问答或明确失败 → 重载保留」 | **是**:composer chip(路径标签四类、能力未知、内联拒绝、暂存中、暂存失败含重试);时间线附件 chip(已存到本机 / 等待读取工具 / 已读取 / 读取失败含重试 / 本回合没有读取 / 读到 0 字) |

**共享 RC 回归(T23)需新增的格**(并入 RC checklist 票,不另开):生图首次调用 kind 正确(至少 3 次独立会话,记每次首调参数);
生图端到端(派发后模型不 await 仍出图、重载后图仍在);下载故障注入后恢复(断网完成 → 恢复网络后自动或手动重下成功,日志带阶段与 detail);
切换会话(同项目两会话各自生图,产物页互不出现);六类附件(MD/DOCX/XLSX/PPTX/PDF/PNG 各一份真实样本 → 发送 → 针对内容的问题答对或明确失败,重载保留)。
LLM 行为类格(首调 kind、是否调用读取工具)按非确定性判据多轮采样,不以单次成功判 PASS。

**本地门怎么判真假:**每张 CODE 票先在 base 上跑一次新测试,确认**红**(证明能失败),再改代码转绿;alpha-code 全量门在
`scripts/worktree-bootstrap.sh` 建的 worktree 里跑,`process-fence-apply.test.ts` 与 `network-egress-fence.test.ts` 缺 Electron 二进制时的定点红
按 `governance/local-verification-traps.md` 判,不算本票回归;alpha-platform 跑 `bin/check`(含 `contracts:check`)。

**建议 / OPTIONAL(不进 AC):**派发拒绝体附 `allowed_kinds`(HTTP 面也受益);面板「在访达中显示」;生图卡「一键重新生成」(见 §六)。

---

## 五、待 Codex 征询

- **Q1 MCP v2 预校验的错误形状。**`@modelcontextprotocol/server@2.0.0` 对 inputSchema 不通过的调用,是返回 `isError` 的 CallToolResult
  (文本里是否列出 enum 合法值),还是抛 JSON-RPC `InvalidParams`?opencode `mcp/catalog.ts:53-67` 又如何把它交给模型?若模型拿不到合法值列表,
  §2.1 需在 handler 拒绝体里补 `allowed_kinds`。坐标:`cloud-mcp.ts:158`(`registerTool` 承担预校验,见 `:178-185` 注释)。
- **Q2 enum 与 REQ-164 Tier A 的理由。**`cloud-mcp.ts:48-50` 当初不改 enum 是怕「新增 kind 变成对外协议变更」。派生 enum 下服务端零改动,
  但外部 harness 若缓存 tools/list,新 kind 在重连前会被客户端侧拒。这个代价是否可接受,还是只对桌面生效(不可能:远程 MCP 无逐工具 / 逐客户端 schema)?
- **Q3 宿主能否直接调用本机读取工具。**opencode v1 插件 API 里,ext 有没有受支持的方式在 `chat.message` 内直接调用某个 MCP 工具并把结果写成 synthetic part
  (类似 REQ-228 自动转写走 HTTP 的做法)?若有,§2.6 应改为宿主读取 —— 「内容已交给模型」变成发送时的事实,不再依赖模型是否照指令调用。
- **Q4 账户身份变化的信号。**tracker 需要在登出 / 切账号时取消订阅。现有 token-rotation(`ui-mac/src/main/index.ts:728` `onRenewed`)与
  `getAccessTokenIdentity` 之间,哪个是「身份变了」而非「同身份续期」的可靠事件?取错会让同身份续期也打断交付。
- **Q5 origin.json 是否该进 manifest 体系。**新增一个 run 级文件 vs. 给 manifest 加 run 级字段并允许「无产物的 manifest」,哪个对 REQ-093 的
  「只有本模块写这个文件」「未知版本只读」纪律破坏更小?

## 六、待 owner 裁决

- **生图失败后,卡片上要不要有「一键重新生成」。**做:用户点一下就再派一次(**会再次扣费**,不经过助手,要在按钮旁写明预留额);
  不做:失败卡只给原因与下一步(额度类带去充值),要重来就再对助手说一次。**默认不做**(AC4 要求的是「失败有可操作原因」,已满足);
  将来要做是纯增量,不影响本基线其余部分。拖着的代价:无,失败时用户多说一句话。

其余选择都有可回滚默认值,已在正文自定并写明撤法:产物页默认「本次对话」(切换即可看全部);Office/PDF 附件存到项目 `.code-puppy/attachments/`
(撤回 = 恢复拒收);文本附件上限 256 KiB(常量);自动下载重试 3 次(常量)。

## 七、仍是推断、没跑过的断言

- 说明排版 `- image-generation.prompt = …` **导致**模型选错 kind:只有字面相同这一相关性,没有对照实验。
- 2026-10-28 两次 `download failed (network)` 的底层原因(连接失败 / 首包超时 / 断流)**不可知**:detail 当时没进日志。第二次(23:47:21)由谁触发
  (watcher 再命中、面板手动下载)也未查明。
- 本次生图会话的 `cloud_await` 输出携带带 `sha256` 的产物描述符:来自 #118 评论 4,未亲自读会话库。
- MCP v2 对 enum 违例的错误形状与模型可见性(Q1)。
- v1 `promptAsync` 传入的文本 part `metadata` 会原样持久化并出现在 firehose 与重载后的消息里:SDK 类型有该字段(`types.gen.ts:1443`),未实跑。
- 模型收到读取指令后会稳定调用本机读取工具:需 T23 多轮采样。
- 本机读取工具能读 `<project>/.code-puppy/attachments/…`:按 `server.py:300-313` 的路径判定推得,未在进程围栏下实跑。
- `subscribeCloudJobEvents` 对图片任务会推送 queued → running → completed 三类帧:按 `alpha-cloud-events.ts` 与平台 SSE 合同推断,未抓帧。
- 子会话派发的任务归属到子会话、父会话的「本次对话」按 `parentID` 链收进:按会话记录形状设计,未验证 renderer 一定持有完整的子会话记录。
