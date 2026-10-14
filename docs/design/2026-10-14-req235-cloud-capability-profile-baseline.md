---
title: "REQ-235 方案基线:新的云能力不用等客户端发版就能出现在定制中心"
kind: design
status: proposed
owners:
  - alpha-code desktop maintainers
last_reviewed: 2026-10-14
review_after: 2027-01-14
---

# REQ-235 方案基线 —— `cloud` 档案:表单由签名目录描述、字段合同由服务端注册表单一权威

票面 `alpha-work#114`(L 级,跨 alpha-platform / alpha-web / alpha-code)。本基线是它**升 Ready 的门**;
`requirement-management` 要求的四段(只读勘破 / 选定方案与被否决的替代 / 安全面 / 子票切分)在第一至第四节,
第五节是待 owner 裁决,第六节是本基线自己承认的推断。

**读法**:alpha-code 坐标以 `origin/alpha@74482625a` 为准 —— 它**就是** tag `v0.1.19`
(`git ls-remote --tags origin` 实测 `74482625a7697dac0d363bee872c00253b51dd32 refs/tags/v0.1.19`),
所以下面每一条 alpha-code 坐标同时是「0.1.19 打包客户端里的代码」。alpha-platform 以 `origin/main@03db806` 为准,
alpha-web 以 `origin/main@42d6a05f` 为准(比地面真相的 `9193571` 多一个提交 `42d6a05 chore(catalog): 重签 10-17 到期的扩展目录渠道文件`,
只动 `public/catalog/v1/channels/*`,不碰本文引用的面)。写作 `仓:文件:行`。第一节只陈述**读过、跑过**的事实;设计从第二节起。

票面 AC 原文(不新增、不放宽、不改写):

| AC | 判据 | 将来拿什么证明 |
| --- | --- | --- |
| AC1 | HTML 生成与图片生成两项,只改 alpha-platform 与目录即出现在定制中心并可派发、取回产物;此后新增一种字段合同能表达的云能力,不需要再发客户端 | 打包 RC 记录(客户端版本不变,新目录上架后可用) |
| AC2 | 不认识新形态的 0.1.19 打包客户端,原有云卡片照常显示与使用 | 0.1.19 打包版验证记录 |

## 〇、约束(owner 已批,不是选项)

来自 `alpha-work:governance/customization-center-target-architecture.md` §2.1 与 §6 审计记录(R1 第 8、9 条已接受):

| # | 约束 | 出处 |
| --- | --- | --- |
| 1 | 保留「扩展包信封 + 类型档案」合同,**新增 `cloud` 档案**让云能力数据驱动;客户端按字段描述画表单 | §2.1 第一点 |
| 2 | 字段合同只做**有限的几种类型**(短文本、长文本、单选、文件/代码片段、固定值),带必填与枚举;**不引入任意 JSON Schema 表单框架** | §2.1;R1 #9 |
| 3 | **服务端注册表先补结构化约束和固定输入值,再导出**;合同表达不了的能力仍然要发客户端 | §2.1;R1 #9 |
| 4 | **过渡顺序**:先发认识 `cloud` 档案的客户端,再发用它的新条目;**旧式云卡片保留到旧客户端退场**;新档案只用在新条目上,不替换旧卡片 | §2.1;R1 #8 |
| 5 | alpha-platform / alpha-web **不加管理页面**;目录仍是「文件 + 命令行 + 签名」 | §2.4 |

## 一、只读勘破

### 1.1 云条目今天从目录到表单到派发的完整链路

**目录条目 → 客户端类型。** 作者源 `alpha-web:catalog-src/catalog.json` 有 6 个 `type: "cloud"` 条目
(`cloud:code-review` / `cloud:research` / `cloud:docs` / `cloud:word` / `cloud:excel` / `cloud:powerpoint`),
`installSpec` 形状是 `{ kind: "cloud", pipelineKind, inputContract[{field, description, required?}], budgetDefaults, budgetLimits, tier, upstreamData[] }`。
线上签名目录 `public/catalog/v1/catalog.json` 版本 `2026-08-31.2` 只有前 3 个云条目 + 1 个 package(`package:alpha-first`)
(实测 `python3` 解析)。客户端类型 `alpha-code:packages/ui-mac/src/renderer/extensions/catalog-types.ts:78-93`
`CloudPipelineSpec.pipelineKind: "research" | "code-review" | "docs" | "office-report"`——**这是 TypeScript 类型,不是运行期校验**:
`git grep pipelineKind` 在 `packages/ui-mac/src` 的命中只有 renderer 与一个测试,main 侧零处读它;main 的缓存读端是「浅壳解析」
(`shared/host-extension-package-contract/catalog-package-legacy-compat.test.ts:15-27`:新增同级键照收,只拒空 `entries`);
renderer 的可见性过滤 `renderer/extensions/catalog-installable-view.ts:69-81` 只看 `_verify`、curation 解码、退役社区 Office、advisory,
**不存在任何按宿主版本隐藏条目的机制**(`grep -iE 'minHost|minApp|hostVersion|appVersion|requiresHost|minVersion|clientVersion'` 在 renderer/extensions、
remote-catalog、catalog-channels、catalog-curation、catalog-package-view 零命中)。

**表单。** `renderer/extensions/cloud-dispatch-box.tsx` 把四种 kind 写死:`:228-231` Office 的 `format` 由条目 ID 决定
(`cloud:word→docx / cloud:excel→xlsx / cloud:powerpoint→pptx`,其余 `undefined`);`:232-234` 输入框标签按 kind 三分;
`:236-240` 构造 `input`:research→`{question}`、docs→`{code}`、**其它一律**→`{topic, format: format()}`;`:313` 按钮只在
`office-report && !format()` 时禁用。code-review 走另一条:主进程文件选择 + 同意框上传(`:182-199`)或旧式 git diff(`:201-226`)。
详情页 `renderer/extensions/extension-detail.tsx:1086-1133` 把 `inputContract` 当**纯展示**逐行列出(`:1101-1111`),
然后挂 `CloudDispatchBox`(`:1129`);派发不要求「已启用」,只看 `cloudReady()`。
「启用」= receipts-only:`extension-hub.tsx:1309-1314` → `main/ext-install-planner.ts:1726-1760`(账本 `kind: "cloud"`,零盘副作用);
授权能力 `cloud:dispatch` 由条目类型派生(`shared/ext-capability-authorization.ts:33`);账本类型联合含 `cloud`(`preload/types.ts:261`)。

**派发。** `window.api.cloud.dispatch(envelope)` → `ipcMain.handle("cloud-dispatch")`(`main/cloud-ipc.ts:90`)→
`dispatchCloudJob`(`main/alpha-cloud-jobs.ts:117-129`)→ `guardCloudEnvelope`(`main/cloud-envelope-guard.ts:85-133`:
调用方自带 `idempotency_key` 即拒 `:89-91`,键由 main mint `:104`;序列化后 256 KiB 帽 `:116`;`input`/`objective` 密钥扫描命中即拒 `:121-126`;
最后按 vendored `CloudJobRequestV1` 解码 `:129`)→ `POST /v1/cloud/jobs`(`:8`)。信封类型 `preload/types.ts:355-364`:`kind?: string`、
`input?: Record<string, unknown>`。vendored 平台契约 `packages/alpha-contracts-consumer/vendor/alpha-platform/contracts/v1/alpha-wire-contracts.schema.json`
里 `CloudJobRequestV1.kind` 是 `{"type":"string","minLength":1,"maxLength":128}`、`input` 是开放对象(实测 `python3` 读 `$defs`)
⇒ **客户端派发一个新 kind 不需要动平台契约 pin**。结果处理 `cloud-dispatch-box.tsx:100-123` 对非 code-review 的 kind 通用:
读 `status.result` 的 `finalAnswer|docs`,`saveRun` 落盘,列出 `artifacts/` 下文件(`:116-118`、`:358-360`)。

**服务端。** `alpha-platform:packages/gateway/src/routes/cloud-jobs.ts:99-131`:`CloudJobRequestV1Schema`
(`contracts/v1/cloud-job.ts:47-51` pipeline 分支 `kind: z.string().min(1).max(128)`、`input: z.record(z.string().max(256), z.unknown())`)→
`lib/cloud-core.ts:172 dispatchJob`:`sandboxClassFor`(`lib/job-class.ts:14-18`,从注册表 tier 派生)未知 kind → 400 `unknown_pipeline_kind`(`:220-223`);
幂等重放查账本(`:236-244`);**逐 kind 手写的准入校验**只有三处:`html-generate` → `HtmlGenerateInputV1Schema`(`:248-251`,400 `html_input_invalid`),
`office-report` → 先把 `format` 非 xlsx/pptx 一律折成 docx、`prompt = String(topic ?? task ?? "")` 再过 `DocumentGenerationInputSchema`(`:252-258`,400 `document_request_invalid`),
`image-generation` → `ImageGenerationInputV1Schema`(`:259-261`,400 `image_request_invalid`);其余 kind **准入期不校验 input**。
执行层 `pipelines.ts:574-611`:`projectPipelineInput` 把 input 投影成「注册表声明键 + 上传保留键」再交 run(`:610`);
`officeReportRun :351-354` 再次 docx 兜底;`htmlGenerateRun :345-349` 与 `imageGenerationRun :476-491` 各自再 parse 一遍。

**注册表。** `lib/pipeline-registry.ts:47-49` `PipelineInputField = { readonly desc: string }` —— **只有一句英文说明,没有类型、必填、枚举、长度**;
`:51-119` 九种 kind;值类型 `any`(`:129-130`,`PipelineInputFor<K>` 键受控值宽松);**未声明键静默忽略是 ap#469 的显式裁决**(`:34-37`),
理由是调用方是模型。`html-generate` 行 `:87-92`:`prompt`,说明里写着 `1–${HTML_PROMPT_MAX_CHARS}`(=4000,`cloud-job.ts:24`);
`image-generation` 行 `:52`:`prompt`,说明里写着「1–4000 characters … US$0.30 hold」;`office-report` 行 `:78-86`:`topic`/`task`(别名)/`format`
(说明「"docx" | "pptx" | "xlsx"; any other value falls back to "docx"」)/`data`。MCP 广播 `cloud-mcp.ts:59-72` 按**一行一字段** `- <kind>.<field> = <desc>`
从注册表现算,判据 `test/mcp-tool-discoverability-461.test.ts:182-191` 解析这个行式;`test/pipeline-input-projection-469.test.ts:34`、
`pipeline-kind-predicate-295.test.ts`、`pipeline-registry-bijection-328.test.ts` 也读注册表(穷举类,按 brief-notes 预授权「只补新成员」)。
固定输入值今天**没有任何地方**声明:Word/Excel/PPT 的 `format` 由客户端条目 ID 写死(上文 `:229-231`),目录的 `inputContract` 只是一句
「应用会自动填写此格式」的散文。

**价格事实。** `contracts/v1/image-generation.ts:6` `IMAGE_HOLD_USD = 0.30`;`:9` `ImageGenerationInputV1Schema = z.object({ prompt: z.string().trim().min(1).max(4000) }).strict()`;
`contracts/v1/document-generation.ts:11` `DOCUMENT_HOLD_USD = 1`、`:21` `DOCUMENT_CONTAINER_USD = 0.03`、`:74-78` `DocumentGenerationInputSchema`
(`format: z.enum(["docx","xlsx","pptx","html"])`、`prompt 1..4000`、`data: z.json().optional()`)。预算缺省:`cloud-core.ts:281` `wall = budget?.max_wall_clock_sec ?? 600`,
`budget` 在信封里可选(`cloud-job.ts:41`)。

**平台契约导出通道(已存在)。** `packages/gateway/scripts/generate-wire-contracts.ts` 从 zod 生成 `contracts/v1/*.json`;
`package.json` `typecheck` = `tsc … && npm run contracts:check`,`contracts:check` = `contracts:generate -- --check && check-contract-fixtures.ts`;
`bin/check` 第一步就是 `typecheck` ⇒ **生成物漂移已经是门**。alpha-web 用 `scripts/check-alpha-platform-contract.mjs` 按锁文件
`alpha-platform-contract.lock.json` 校验 `contracts/alpha-platform/v1/*`(`EXPECTED_COMMIT = 62c7aa6d…`);alpha-code 用
`packages/alpha-contracts-consumer/scripts/vendor-alpha-contracts.ts` 钉 `9cf67bd9…`。

### 1.2 扩展包信封 / 档案 / 注册表 / 解码器对未知档案的处理 —— 整包判「需要更新客户端」的确切条件

- 注册表 `shared/host-extension-package-contract/host-extension-package.registry.v1.json:3-34` 五个档案 `agent@1 command@1 mcp-local@1 mcp-remote@1 skill@1`,
  `:53-65` 限额(`maxEnvelopeBytes 65536`、`maxPayloadBytes 1048576`、`maxPayloadDepth 8`、`maxPayloadNodes 512`、`maxStringBytes 4096`、`maxComponents 32`)。
  `registry.ts:3` `PackageProfileIdV1` 是封闭联合;`:95-99` `assertHostExtensionPackageRegistryV1` 断言档案集**逐字等于**那五个。
- 解码器 `decoder.ts:642-676 supportComponent`:`findPackageProfileV1(profileId, profileVersion)` 查不到 → `component-profile-unsupported`(`:649-655`);
  能力 token 未登记 → `component-capability-unsupported`(`:656-666`);mediaType 与档案不符 → `component-media-type-mismatch`(`:667-674`)。
  `:580-612`:**root 必 required**,所以 root 不受支持必然进 `supportErrors` → `{ ok:false, status:"blocked", stage:"support" }`;optional 叶子不受支持只是 `skipped`。
- 宿主判定 `main/package-installability.ts:239-260 evaluatePackageForHost`:header 失败且 `stage === "support"` → 返回 `verdict: "update-required"`、
  `action: { kind: "update-alpha", reasonCode: "package-host-update-required" }`,**在任何 payload fetch 之前**(`:248-259`)。
  判据已存在:`main/package-installability.test.ts:472-511`(`profileId = "future-profile"` → update-required 且保留 presentation)、
  `:513-552`(unknown profile / unknown capability / unknown profileVersion / mediaType mismatch 各一行,断言 fetch/decode/secret/planner 计数全 0)。
- renderer 可见性:`renderer/extensions/catalog-installable-view.ts:23-36 installableCatalogPackages` **只保留 `verdict === "compatible"`**;
  package 卡只出现在「推荐」分区(`extension-hub.tsx:2586-2588`)与搜索结果(`:938`)。⇒ **0.1.19 对一个 root 档案为 `cloud` 的包:整包 update-required,
  Hub 任何分区都不显示它**;legacy 条目的过滤路径(`:14-20`)与 packages 无关。
- 但有一条更深的门:`main/remote-catalog.ts:126-144 evaluateRemoteCatalogPackages` → `package-installability.ts:184-217 validateCatalogPackageShape`,
  它只要求每个 package 的 **prelude 可安全解码且 `(packageId, version)` 唯一**;一旦失败,**整份已验签的远端目录被当作 `source: "none"`、`reasonClass: "security"` 丢弃**
  (`remote-catalog.ts:136-141`),客户端退回缓存/随包快照。档案是否被支持**不在**这道门里。⇒ 新包只要 prelude 文法与现有包一致(`decoder.ts:416-417`
  `PACKAGE_ID_RE` / `VERSION_RE`),0.1.19 就只是看不见它,而不是整份目录退化。
- 随包快照 `renderer/extensions/catalog-source.ts:16-17` 剥掉 `packages`,package 卡只在 main 评估过的 IPC 结果落地后出现(ac#1136 决策)。
- renderer 拿到的只有安全视图 `shared/catalog-package-view.ts:42-66 CatalogPackageViewV1`(verdict / action / components / prerequisites / presentation / listing?),
  **raw payload 从不过 IPC**;详情页经 `ext-package-detail` 取视图(`remote-catalog.ts:78-93`)。
- 档案 → 宿主子类型**只此一张表**:`main/ext-package-lifecycle.ts:55-61 PACKAGE_CHILD_KIND_BY_PROFILE_V1`,`PackageChildKindV1 = skill|agent|command|mcp|plugin`(`:35`),
  测试断言键集等于注册表档案集;`main/package-admission.ts:608` 据它路由,`:910-912` 按子类型**穷举**分派到具名 builder(`main/ext-package-tx-builders.ts` 四条腿)。
  载荷解码 `decoder.ts:479-520 decodePackageProfilePayloadV1` 是**逐档案手写**的解码器(不是按 JSON Schema 通用驱动),`:522-540` 由载荷派生能力 token。
- alpha-web 编译器 `scripts/lib/extension-package-core.mjs:619-634 componentProfile`:`kind` 不在 skill/agent/command/mcp(local|remote) 即 `E_PROFILE_UNSUPPORTED`;
  语料 `contracts/extension-package/artifact/input.cloud-profile.invalid.json`(`kind: "cloud"`)在 `vectors.v1.json` 的期望恰是 `E_PROFILE_UNSUPPORTED`;
  声明 schema `alpha-package-declaration-v1.schema.json` 的 `$defs` 只有 agent/command/mcpLocal/mcpRemote/skill 五种组件。宿主 pin
  `contracts/extension-package/artifact/host-contract-pin.v1.json` = alpha-code `29a869bb`、`artifactSha256 d41c5fdc…`;
  宿主合同变更的消费顺序在 `alpha-web:docs/runbooks/desktop-extension-package-artifact-bump.md`「Host contract bump (always first)」:
  pin 没跟上时 `tests/extension-package-contract.test.mjs` 红 `E_HOST_ARTIFACT_DRIFT`,**从不豁免**。
- alpha-web 上架门 `scripts/lib/curation-gate.mjs:356-399 assertCatalogReady`:每个条目/包要有 `runtime-verification.json` 里**精确版本 + 摘要**的证据(`:387-391`),
  方法:package 一律 `package-install`、legacy cloud 是 `dispatch-completed`(`:392`),`install`/`use` 都要 `pass`(`:393-394`);
  今天 **6 个 legacy 云条目的记录全是 pending**(`catalog-src/intake/runtime-verification.json`,「待云能力核实票提供 / 待 alpha-platform#505 真实派发提供」),
  所以它们今天也发不出去。包还要 root 与组件各一条 curation 决定(`docs/runbooks/catalog-publish.md:79-88`;`build-catalog.mjs:275-279 requireCuration: true`),
  并且包变更必须抬 `catalog-src/catalog.json` 顶层 `version`(runbook `:101-105`)。

### 1.3 HTML 生成与图片生成今天的输入字段

| kind | 准入校验 | 执行体 | 输入字段(唯一) | 预留 | 来源 |
| --- | --- | --- | --- | --- | --- |
| `html-generate` | `HtmlGenerateInputV1Schema`:`prompt` trim 后 1..4000 code units(`cloud-job.ts:24-27`;说明另注 ≤12000 UTF-8 bytes) | `hostedDocumentRun(format:"html")`(`pipelines.ts:345-349`)→ `output.html` + `quality.json` 产物 | `prompt` | US$1(`DOCUMENT_HOLD_USD`) | `cloud-core.ts:248-251` |
| `image-generation` | `ImageGenerationInputV1Schema` strict:`prompt` 1..4000;带 explicit upload 即拒(`cloud-core.ts:259-261`) | `/v1/tools/image_generate`,一张 1024×1024 PNG(`pipelines.ts:476-491`) | `prompt` | US$0.30(`IMAGE_HOLD_USD`) | `image-generation.ts:6-9` |

两者在 alpha-code 全仓**零处**出现(`git grep -E 'html-generate|image-generation'` 在 `packages/ui-mac/src packages/ext/src packages/opencode/src` 排除 vendor:**0**),
在 alpha-web `catalog-src` 与签名目录也是 **0**(同 grep)。这正是票面说的「卡在发版这一步」的地面形态。

### 1.4 跑过的全称断言

| 断言 | 命令(均只读) | 结果 |
| --- | --- | --- |
| 0.1.19 = `origin/alpha` | `git -C alpha-code ls-remote --tags origin \| grep 0.1.19` | `74482625a… refs/tags/v0.1.19`,与 `origin/alpha` 同对象 |
| 客户端无按宿主版本隐藏条目的机制 | `git grep -n -iE 'minHost\|minApp\|hostVersion\|appVersion\|requiresHost\|minVersion\|clientVersion' origin/alpha -- <renderer/extensions, remote-catalog, catalog-channels, catalog-curation, catalog-package-view>` | 0 命中 |
| `pipelineKind` 运行期无人校验 | `git grep -n -E 'pipelineKind\|inputContract\|CloudPipelineSpec' origin/alpha -- packages/ui-mac/src` | 命中全在 renderer + 1 个 renderer 测试 + 随包快照 JSON;main 0 处 |
| alpha-code 零处构造新 kind | `git grep -n -E 'html-generate\|image-generation' origin/alpha -- packages/ui-mac/src packages/ext/src packages/opencode/src ':!**/vendor/**'` | 0 |
| alpha-web 零条新 kind 条目 | `git grep -n -E 'html-generate\|image-generation' origin/main -- catalog-src public/catalog/v1/catalog.json` | 0 |
| vendored 契约 `kind` 是自由字符串 | `python3` 读 `alpha-wire-contracts.schema.json` `$defs.CloudJobRequestV1` | `kind: {type:string, 1..128}`,`input` 开放对象 |
| 编译器拒 `kind:"cloud"` | 读 `vectors.v1.json` 中 `input.cloud-profile.invalid.json` 行 | `errorCode: "E_PROFILE_UNSUPPORTED"` |
| 平台生成物漂移已是门 | 读 `packages/gateway/package.json` scripts + `bin/check` | `bin/check → typecheck → contracts:check → generate-wire-contracts --check` |
| 线上签名目录云条目 | `python3` 解析 `public/catalog/v1/catalog.json@42d6a05f` | 版本 `2026-08-31.2`,cloud 3 个,package 1 个 |

## 二、选定方案与被否决的替代

### 2.0 一句话

**字段合同由 alpha-platform 的 pipeline 注册表单一权威声明,并作为契约产物导出;alpha-web 编译器消费该产物,把每个新云条目编译成扩展包
`cloud` 档案的载荷(字段类型、约束、标签、固定值、预留金额全在载荷里);0.1.20 起的客户端只按签名载荷画表单、按载荷组 `input` 走既有
`window.api.cloud.dispatch`;服务端在准入期按同一张注册表校验 input。0.1.19 看不到新包(整包 update-required,被可见性过滤),旧卡片一行不动。**

反问「能否让服务端成为唯一权威、客户端和目录不手写替身」:能,而且今天已有现成的管道 —— 平台 `contracts/v1/` 生成物 + alpha-web 锁文件校验
(§1.1 末段),只是注册表本身还没有可导出的结构。本方案不新建任何通道,只给注册表补结构、多导出一个 JSON、让编译器多认一种 `kind`。

### 2.1 字段合同(冻结面 F1)—— 注册表侧

`alpha-platform:packages/gateway/src/lib/pipeline-registry.ts` 的 `PipelineInputField` 从 `{ desc }` 扩成:

```ts
interface PipelineInputField {
  readonly desc: string                 // 保持:MCP 广播原样用它(cloud-mcp.ts:59-72 行式不变)
  readonly type: "string" | "json"      // json = 任意 JSON 值(files/data/csv 这类);表单只能表达 string
  readonly required: boolean
  readonly minChars?: number            // 仅 string;trim 后计
  readonly maxChars?: number            // 仅 string;UTF-16 code units,与现有 zod 同口径
  readonly enum?: readonly string[]     // 仅 string;有则值必须 ∈ enum
  readonly default?: string             // 仅与 enum 同现;缺省时服务端代入
}
PIPELINE_REGISTRY[kind] = { tier, hold_usd?: number, input: Record<name, PipelineInputField> }
```

九种 kind **全部**照 `pipelines.ts` 与三处准入 zod 逐个读出来填(与 ap#469 同一纪律),常量复用而不是抄数字:
`html-generate.prompt = { type:"string", required:true, minChars:1, maxChars: HTML_PROMPT_MAX_CHARS }`、
`image-generation.prompt = { …, maxChars: IMAGE_PROMPT_MAX_CHARS }`(把 `image-generation.ts:9` 的字面 `4000` 提成常量)、
`office-report.format = { type:"string", required:false, enum:["docx","xlsx","pptx"], default:"docx" }`、`office-report.data = { type:"json", required:false }`、
`hold_usd`:image `IMAGE_HOLD_USD`,office/html `DOCUMENT_HOLD_USD`。别名字段(`task`/`data`)保持为各自独立的可选字段(今天就是这样广播的)。

**准入校验**:`cloud-core.ts dispatchJob` 在 `:248`(幂等重放之后、任何副作用之前)加一道**从注册表派生的通用校验**:
`required` 缺失、`type` 不符、长度越界、值 ∉ `enum` → 400,稳定码 `pipeline_input_invalid`,`details: [{ field, reason }]`;
未声明键**仍然忽略**(ap#469 裁决不动)。三处手写 zod 保留在后面(它们与注册表共用常量;一条测试断言「注册表派生校验」与三条 zod 在
`contracts/v1/fixtures/invalid/*` 上判决一致)。`default` 由同一处代入,`officeReportRun :352` 与 `:255` 的 docx 兜底因此变成「缺省」而不是「乱填也放行」——
这是对 MCP 模型调用方唯一可观察的收紧(非字符串 / 越界 / 枚举外从静默兜底变成 400),可回滚(放宽一行注册表),**本基线自行裁定,不上报**。

**导出产物(冻结面 F2)**:`generate-wire-contracts.ts` 多写一个 `contracts/v1/cloud-pipeline-registry.json`:

```json
{ "schema": "alpha.cloud-pipeline-registry.v1",
  "kinds": { "<kind>": { "tier": 1, "hold_usd": 1, "input": { "<name>": { "type": "string", "required": true, "minChars": 1, "maxChars": 4000, "enum": null, "default": null, "desc": "…" } } } } }
```

`--check` 漂移已经挂在 `bin/check → typecheck → contracts:check`(§1.4),不加新门。

### 2.2 `cloud` 档案的形状(冻结面 F3)—— 载荷侧

`alpha-code:packages/ui-mac/src/shared/host-extension-package-contract/`:注册表 JSON 加一行
`{ "profileId": "cloud", "profileVersion": 1, "mediaType": "application/vnd.alpha.host-extension-package.cloud.v1+json", "schemaPath": "profiles/cloud.v1.schema.json" }`,
新 `profiles/cloud.v1.schema.json`(与现有五个同构:`additionalProperties:false`、`schema` 常量、`behavior` 对象):

```text
behavior = {
  pipelineKind: ^[a-z][a-z0-9-]{0,63}$                              // 注册表键,原样进信封 kind
  fields: [ 0..16 ] of {
    name:    ^[a-z][a-z0-9_]{0,63}$                                 // = 注册表字段名,原样作 input 键
    control: "text" | "textarea" | "select"                         // 有限类型集,别无其它
    required: boolean
    minChars?: 0..65536, maxChars: 1..65536                          // text/textarea
    options?: [ 1..32 ] of { value ≤256, label ≤80 }, default?      // select;default ∈ options
    label: 1..80, help?: 1..500                                     // 作者写的中文;只渲染为文本节点
  }
  fixed: [ 0..16 ] of { name, value ≤4096 }                         // 用户看不见也改不了;派发时由客户端从签名载荷并入 input
  holdUsd: number ≥ 0                                               // 编译期从注册表 hold_usd 抄入;只用于显示
  upstreamData: [ 1..16 ] of string ≤500                            // 出境内容如实列举(ADR-021)
}
```

`fields` 与 `fixed` 的 `name` 两两不重;`select` ⇔ 注册表该字段有 `enum`(编译期判);`control` 不可能是「文件」——文件上传是宿主原生的
主进程同意流程(`cloud-ipc.ts:91-109`),**不在合同里**,需要它的能力仍发客户端(约束 3「合同表达不了的仍发客户端」有了机械判据:
注册表里 `type:"json"` 或要上传的必填字段 = 不可表达)。**不带 `budget`**:信封里 `budget` 可选、服务端缺省 600s(§1.1),
策略永远 clamp;少一样作者要填、少一处会漂的东西。

**能力 token**:`derivePayloadCapabilitiesV1` 对 cloud 载荷返回 `[]`(没有密钥、没有 OAuth、没有连接);授权确认框里要出现的 `cloud:dispatch`
是**宿主按子类型派生**的(与 legacy `ext-capability-authorization.ts:33` 同一事实),不是载荷自报。

### 2.3 目录侧:作者声明与编译(alpha-web)

作者声明新增组件种类 `kind: "cloud"`:

```json
{ "packageId": "package:cloud-html", "version": "1.0.0", "schema": "alpha.package-declaration.v1",
  "presentation": { "displayName": "云端网页生成", "description": "…" },
  "source": { "kind": "alpha-native", "publisher": "alpha", "redistributable": true },
  "root": { "component": { "id": "cloud:html", "kind": "cloud", "version": "1.0.0",
    "behavior": { "pipelineKind": "html-generate",
      "fields": { "prompt": { "control": "textarea", "label": "页面要求", "help": "…" } },
      "fixed": {}, "upstreamData": ["发送你填写的页面要求(prompt)。", "派发信封元数据(预算/约束;denied_paths 缺省注入)"] } } } }
```

编译器(`extension-package-core.mjs`)对 `kind:"cloud"`:映射到 `cloud@1`(`componentProfile :619-634` 加一支;`PROFILE_REGISTRY :103-134`、
`generic-profiles.v1.json`、声明 schema `$defs.cloudComponent` 各加一项);`validateBehavior` 按 **vendored** `cloud-pipeline-registry.json` 判:
`pipelineKind` 存在;`fields ∪ fixed` 的名字 ⊆ 注册表字段;注册表 `required` 字段全被 `fields` 或 `fixed` 覆盖;`fixed` 值满足 enum/长度;
`type:"json"` 字段不得出现在 `fields`;作者只能**收紧**(required 可由 false 改 true、maxChars 只能更小、options 只能是 enum 子集),不能放宽;
然后把 `required/minChars/maxChars/options/default/holdUsd` 从注册表**抄进载荷**——客户端因此只依赖签名载荷,不依赖平台契约。
ID 文法:`cloud:` 前缀已在 `ENTRY_ID_RE`(`catalog-channels-core.mjs:49`)与 `CURATION_ENTRY_ID_RE`(alpha-code `shared/catalog-curation.ts:39`)里,
curation 决定按现有 `package.<id>` / `cloud.<id>` 目录名落。

### 2.4 客户端侧:画表单、组 input、派发(alpha-code 0.1.20)

- **安全视图加一个投影**:`CatalogPackageViewV1.cloud?: { pipelineKind, fields, fixed, holdUsd, upstreamData }`(冻结面 F4,IPC 形状),
  由 `evaluatePackageForHost` 在 root 档案为 `cloud` 且判定 compatible 时填(与 `listing` 同纪律:main 解码后的投影过 IPC,raw 载荷不过)。
- **Hub**:「云能力」分区(`extension-hub.tsx:2926-3037`)在 legacy `byType("cloud")` 之外再列 `installablePackages().filter(v => v.cloud)` 的 PackageCard;
  包详情(`extension-detail.tsx:149-153` 的 `packageDetail` 视图)在 `view().cloud` 存在时挂表单派发框。
- **表单派发框**(新组件,**不改** `cloud-dispatch-box.tsx` 的 legacy 分支):按 `fields` 顺序渲染 `text`→`<input maxlength>`、`textarea`→`<textarea maxlength>`、
  `select`→`<select>`(default 预选);`required`/`minChars` 不满足即禁用按钮;派发时 `input = { ...Object.fromEntries(fixed), ...Object.fromEntries(fields→value) }`,
  信封 `{ autonomy:"pipeline", kind: cloud.pipelineKind, input, constraints:{ network:"restricted" } }`(无 `budget`),走原 `window.api.cloud.dispatch`、
  原 `beginJob/finish`(产物列表、落盘、取消全复用);显示一行「预留 US$<holdUsd>,按实际用量结算;失败时已产生的费用仍会结算」(措辞照 §2.7);
  `dispatchError` 增两条映射:`pipeline_input_invalid` / `unknown_pipeline_kind` → 「这项云能力的要求已更新,请刷新定制中心或更新 Code Puppy」。
- **「安装」= 写 receipt**:`ext-package-lifecycle.ts` 表加 `cloud: "cloud"`、`PackageChildKindV1` 加 `"cloud"`;`package-admission.ts :910-912` 的穷举分派加一条腿
  `buildCloudTxItems`(镜像 `ext-install-planner.ts:1726-1760`:只有 receipt,零文件、零引擎 config,`desiredState` 恒 enabled 除非既有记录 disabled);
  卸载侧的 fail-closed 表同样加 `cloud`(只删 receipt)。与 legacy 一致,**派发不要求已安装**,只看 `cloudReady()`。
- **legacy 路径零改动**(AC2 的构造性证明):`catalog-types.ts` 的 `CloudPipelineSpec`、`cloud-dispatch-box.tsx` 的四个 kind 分支、
  `catalog-installable-view.ts` 的 entries 过滤、`ext-install-planner.ts` 的 cloud receipt 都不在本票的 diff 里(子票 AC 里写成「diff 不得触及」)。
- 版本抬到 `0.1.20`,`CHANGELOG.md` `[Unreleased]` 一条 Added。

### 2.5 旧客户端兼容 —— 用代码说清 0.1.19 看到新形态会怎样

0.1.19 = `74482625a`,逐步:

1. 远端目录验签通过 → `validateCatalogPackageShape`(`package-installability.ts:184-217`)只读 prelude:新包 prelude 文法与 `package:alpha-first` 同 ⇒ 通过,**整份目录照常采信**。
2. `evaluatePackageForHost` → `decodePackageEnvelopeHeaderV1` → `supportComponent`:`findPackageProfileV1("cloud", 1)` 返回 `undefined`(`registry.ts` 五档案)⇒
   `component-profile-unsupported`(`decoder.ts:649-655`);root 必 required ⇒ `stage:"support"` ⇒ 视图 `update-required` / `package-host-update-required`(`:248-259`),
   **零次 payload fetch**(判据 `package-installability.test.ts:513-552` 已覆盖 unknown profile 这一行)。
3. renderer `installableCatalogPackages` 只留 compatible(`catalog-installable-view.ts:23-36`)⇒ 新包**不出现在任何分区**。
4. legacy 云条目走 `installableCatalogEntries`(`:14-20`),与 packages 无关 ⇒ 三张旧卡(线上目前只有 code-review/research/docs 三张)照常显示、照常派发。
5. 新目录**不改**任何 legacy 云条目的字节(包变更只抬顶层 `version`,`entries[]` 逐字节不变——`catalog-publish.md:101-108` 已有这条纪律与证明脚本)。

AC2 的证据是在 0.1.19 打包版上点出上述 3、4 两步,外加一条可重复的命令:在 `74482625a` 的 checkout 里对构建出的新目录跑
`validateCatalogPackageShape` + `evaluatePackageForHost`(第四节 V1)。

### 2.6 首批两条上架的完整步骤(发布顺序 = 先发客户端,再发目录)

| 步 | 仓 | 动作 | 前置 |
| --- | --- | --- | --- |
| 1 | alpha-platform | P1 合并:注册表结构 + 通用准入校验 + `cloud-pipeline-registry.json`;部署 gateway 与 cloud worker(顺序按 brief-notes:account → gateway → pipelines/cloud);部署后探针:`html-generate` 带 `prompt:""` → 400 `pipeline_input_invalid` | — |
| 2 | alpha-web | W1-a:vendor 该 JSON 进 `contracts/alpha-platform/v1/` + 锁文件 + `EXPECTED_COMMIT` 抬到 P1 的提交 | 1 |
| 3 | alpha-code | C1 合并(`cloud` 档案 + 投影 + 表单 + receipt);宿主产物 `host-extension-package-artifact.v1.json` 的 `artifactSha256` 随之变化 | 1(只为共用常量口径;技术上可并行) |
| 4 | alpha-web | W1-b:按 `desktop-extension-package-artifact-bump.md` 把宿主 pin 抬到 C1 的提交(此前 `E_HOST_ARTIFACT_DRIFT` 恒红,是设计状态);编译器认 `kind:"cloud"`;语料加 `input.cloud.valid.json` / `expected.cloud.compiled.json`;`gen-extension-package-artifact.mjs` 重生成 | 3 |
| 5 | alpha-code | **发 0.1.20**(owner 的动作;合并 ≠ 用户包里有) | 3 |
| 6 | alpha-web | W1-c:作者两份声明 `package:cloud-html` / `package:cloud-image` + curation 决定 + 运行证据(在 0.1.20 上各真实派发一次完成,`runtime-verification.json` 记 `package-install` pass/pass)→ `build-catalog` → 签名 → `promote --to stable` → 部署网站 → 读线上 `catalog.json` 核对两个包在 | 5 + 第五节第 1 条 |
| 7 | — | V1:0.1.20 打包版(二进制不变)看到卡、派发、取回产物;0.1.19 打包版旧卡照常、新包不现 | 6 |

此后「再加一种能力」= 第 1 步只改注册表一行与执行体(不再需要通用校验/导出改动)+ 第 6 步;**不经 3/4/5**——这就是 AC1 后半句的机械含义,
而「能否不发客户端」有了判据:该 kind 的必填字段全是 `type:"string"` 且不需上传。

### 2.7 被否决的替代

| 替代 | 为什么否 |
| --- | --- |
| **A. 旧式条目加扩展字段**(`installSpec.kind:"cloud"` + 新 `pipelineKind` + 一个 `form` 字段) | 0.1.19 浅壳解析照收 ⇒ 卡片**照常出现**;`cloud-dispatch-box.tsx:236-240` 把未知 kind 落进 office 分支,发 `{topic, format:undefined}` 的 `html-generate` ⇒ 服务端 400 `html_input_invalid`(`cloud-core.ts:248-251`)⇒ 用户看到「未知错误」。一张可见的坏卡;且客户端没有任何按宿主版本隐藏条目的机制(§1.4)。与约束 4 相悖 |
| **B. 客户端运行时拉 `GET /v1/cloud/kinds` 画表单** | 未登录/离线无表单;目录与接口成了两个权威;0.1.19 照样不认识;多一条网络依赖才能渲染一个卡片。它适合做 §2.6 `hub_search` 的数据源,不是本票 |
| **C. 任意 JSON Schema 表单框架** | owner 已否(约束 2);注册表今天连类型都没有,先要勘破;安全面是「任意 schema 关键字驱动渲染」 |
| **D. 把 HTML 当 `office-report` 的第四个 `format`** | `DOCUMENT_FORMATS` 含 html,但 `office-report` 准入 `:255` 把非 xlsx/pptx 一律折成 docx;图片根本不是文档;而且仍是客户端按条目 ID 写死 format——换汤不换药 |
| **E. 直接把旧云条目替换成新包,不过渡** | 违反 AC2 与约束 4 |
| **F. 三处各写一份合同**(alpha-web 散文 `inputContract` / 客户端写死 / 服务端 `desc`) | 就是现状;漂移已实证:目录说 Office `format` 必填且「应用会自动填写」,服务端说「乱填回落 docx」,客户端按条目 ID 写死——三处三种说法 |
| **G. 只导出不校验,拿客户端表单当安全边界** | 违反第三节不变量 I1;签名目录保护的是「表单来自谁」,不是「用户填了什么」 |
| **H. 载荷里带 `budget`** | 信封里可选、服务端缺省 + 策略 clamp;多一项会漂的东西、零收益 |

## 三、安全面(必填)

**整类风险**:表单由目录描述驱动 ⇒ 「谁能改目录」与「目录能让客户端做什么」都成了攻击面。守住的不变量:

| # | 不变量 | 靠什么成立 |
| --- | --- | --- |
| I1 | **服务端仍按注册表校验 input;客户端表单不是安全边界** | §2.1 通用准入校验在任何副作用之前;客户端可被改、目录可被签错,服务端判决不变 |
| I2 | **表单形状只来自已验签目录,且是内容寻址的** | ed25519 验签 + 缓存重验(`remote-catalog.ts:8/48/146`);载荷 `sha256 + bytes` 逐字核对(`package-installability.ts:311-315`);随包快照不含 packages ⇒ 新卡只在验签通过后出现 |
| I3 | **载荷有界、类型封闭,坏载荷整包拒而不是半张卡** | 解码器限额(1 MiB / depth 8 / nodes 512 / string 4096)+ cloud 档案自己的上界(fields ≤16、options ≤32、label ≤80、help ≤500、maxChars ≤65536、fixed value ≤4096);`control` 枚举外、名字重复、`select` 无 options 等一律 `package-payload-invalid` → blocked |
| I4 | **标签/帮助只作文本渲染,永不作标记,永不出境** | Solid JSX 文本节点,禁 `innerHTML`;信封 `input` 的键集 = `fields ∪ fixed` 的 `name`,值只有用户输入与 `fixed.value`;`label/help/upstreamData/holdUsd` 结构上不在信封里(子票加断言) |
| I5 | **固定值不可被用户覆盖,也不被服务端信任** | 客户端从签名载荷并入 `fixed`,表单不渲染它;服务端把它当普通 input 校验(enum/长度),不存在「客户端说这是固定值」的旁路 |
| I6 | **主进程咽喉对新路径逐字生效** | 同一个 `cloud-dispatch` IPC:幂等键 main mint、256 KiB 帽、密钥扫描、契约解码(`cloud-envelope-guard.ts:85-133`)一个不少;`cloud.dispatch` purpose 令牌照旧 |
| I7 | **价格文字只是显示,钱的权威在服务端** | `holdUsd` 编译期抄自注册表,服务端 preauth 从不读客户端的数字;文案照 §2.7(预留 ≠ 报价;失败时已产生的费用照结算) |
| I8 | **未知/过期 kind 响亮失败,不静默** | 签名目录可能比注册表旧或新:服务端 400 `unknown_pipeline_kind` / `pipeline_input_invalid` 带 `details`;客户端把码翻成人话,不吞 |
| I9 | **0.1.19 的整份目录不因新包退化** | `validateCatalogPackageShape` 只看 prelude(§1.2);编译器保证 prelude 文法;V1 在 `74482625a` 上实跑这一步 |
| I10 | **授权确认框如实列出 `cloud:dispatch`** | 子类型 `cloud` 派生,与 legacy 同源(`ext-capability-authorization.ts:33`);不由载荷自报 |

**不在本票承诺的**(与总方案 §5 一致):整任务预算事先保证付得起;运行时密钥对 agent 不可见;ADR-040 不变——cloud 载荷是数据,引擎进程不执行任何来自载荷的代码。

## 四、子票切分

| 票 | 仓 | 边界(文件) | 负责 AC | 规模 | 冻结面 | 前后 |
| --- | --- | --- | --- | --- | --- | --- |
| **P1** 注册表结构化约束 + 通用准入校验 + 导出 | alpha-platform | `packages/gateway/src/lib/pipeline-registry.ts`(字段结构、九行填满、`hold_usd`);`lib/cloud-core.ts`(`:248` 前加通用校验,稳定码 `pipeline_input_invalid`);`contracts/v1/image-generation.ts`(提常量);`scripts/generate-wire-contracts.ts`(多写 `contracts/v1/cloud-pipeline-registry.json`);测试:新 `registry-input-validation` 单测(每种约束一条反例,先红后绿)+ `contracts/v1/fixtures/invalid/cloud-input-*.json` + 穷举类 295/328/461/469 **只补新成员**(brief-notes 预授权);文档:`docs/contracts/cloud-jobs-v1.md`(每种 kind 的 input 合同改为「注册表派生」+ 新码)、`docs/contracts/public-cloud-mcp.md` §6/§7.3;部署 gateway + cloud worker + 探针 | AC1 服务端半场 | **M**(难度中:一处类型改动牵九行 + 四个穷举测试;model 按难度选) | **F1** 注册表字段结构、**F2** 导出产物 schema `alpha.cloud-pipeline-registry.v1`(W1 消费) | 第一;其它票对着 F2 开工 |
| **C1** `cloud` 档案 + 安全视图投影 + 表单派发 + receipt | alpha-code | `shared/host-extension-package-contract/{host-extension-package.registry.v1.json, profiles/cloud.v1.schema.json, registry.ts, decoder.ts, generate-artifact.ts, host-extension-package-artifact.v1.json, testvectors/decoder-corpus.v1.json, CONTRACT.md}`;`shared/catalog-package-view.ts`(`cloud?`);`main/package-installability.ts`(投影);`main/ext-package-lifecycle.ts`(表 + 联合);`main/package-admission.ts` + `main/ext-package-tx-builders.ts`(`buildCloudTxItems`)+ 卸载表;`renderer/extensions/{extension-hub.tsx 云分区, extension-detail.tsx 包详情, cloud-form-box.tsx 新}` + i18n + `dispatchError` 两条映射;`docs/contracts/host-extension-package-v1.md`、`CHANGELOG.md`、`packages/ui-mac/package.json` → 0.1.20。**diff 不得触及**:`catalog-types.ts` 的 `CloudPipelineSpec`、`cloud-dispatch-box.tsx`、`catalog-installable-view.ts` 的 entries 路径、`ext-install-planner.ts` 的 cloud 分支 | AC1 客户端半场;AC2(构造性:legacy 零改动) | **L**(难度高:跨合同/解码/事务/IPC/渲染五层,`model: fable`) | **F3** `cloud.v1` 档案 schema、**F4** `CatalogPackageViewV1.cloud` IPC 形状 | 与 W1-a 并行;合并后触发 W1-b 与 0.1.20 发版 |
| **W1** 目录与编译器 | alpha-web | **a** vendor:`contracts/alpha-platform/v1/cloud-pipeline-registry.json` + `alpha-platform-contract.lock.json` + `scripts/check-alpha-platform-contract.mjs`(`EXPECTED_COMMIT`);**b** 编译器:`scripts/lib/extension-package-core.mjs`(`PROFILE_REGISTRY`、`componentProfile`、`validateBehavior` cloud 支、载荷 builder `:1660` 那道「no payload builder」后面)、`contracts/extension-package/artifact/{alpha-package-declaration-v1.schema.json, generic-profiles.v1.json, host-contract-pin.v1.json, host-extension-package.registry.v1.json, vectors.v1.json, input.cloud.valid.json, expected.cloud.compiled.json}`(现有 `input.cloud-profile.invalid.json` 的期望从 `E_PROFILE_UNSUPPORTED` 改为新的具体错误,例如未知 `pipelineKind`)、`scripts/gen-extension-package-artifact.mjs`、`.github/workflows/channels-ci.yml` 的 `ref:`、`contracts/extension-package/CONTRACT.md`;**c** 内容:`catalog-src/packages/package.cloud-html/1.0.0/alpha-package.json`、`package.cloud-image/…`、`catalog-src/curation/{package.cloud-html, cloud.html, package.cloud-image, cloud.image}/1.0.0.json`、`catalog-src/intake/runtime-verification.json`、`catalog-src/catalog.json` 顶层 `version`;`docs/runbooks/catalog-publish.md` 加「cloud 组件包」一节(无源码组件的 intake 处置,见第六节);build → sign → promote → 部署 → 读线上目录核对 | AC1 目录半场;AC2 第 5 步(entries 逐字节不变)与 I9 | **M** | 消费 F2/F3;自己不冻结新面 | a 在 P1 后;b 在 C1 合并后;c 在 0.1.20 发出后 |
| **V1** 打包验证记录 | alpha-code(`docs/verification/`) | 0.1.20 打包版(二进制不变)+ 线上目录:两张卡出现 → 各派发一次 → 产物落盘;0.1.19 打包版:三张旧卡照常显示与派发、新包不现;命令级:在 `74482625a` 的 checkout 对线上 `catalog.json` 跑 `validateCatalogPackageShape`(通过)与 `evaluatePackageForHost`(`update-required`、fetch 0 次) | AC1、AC2 的「拿什么证明」 | **S** | — | 最后;桌面点击部分要 owner 动手(本机取证规则),服务端那半我查 |

发布顺序(再钉一次):**P1 部署 → C1 合并 → 0.1.20 发版 → W1 pin 抬 + 上架 → V1**。目录在客户端之前上架 = 0.1.19 看不见、0.1.20 没到的用户也看不见,
不坏但没意义;顺序反了才危险的是「pin 没抬就编译」——那条由 `E_HOST_ARTIFACT_DRIFT` 结构性拦住。

**OPTIONAL(不在本票,不派)**:research / docs / Word / Excel / PPT 五张旧卡另发一份新包(双列)——注册表与编译器做完就能表达
(`format` 走 `fixed`,`data` 是 `json` 不进表单,`code-review` 因上传不可表达),但约束 4 说旧卡保留到旧客户端退场,何时退场是另一张票的事。

## 五、待 owner 裁决

只有一件,而且是总方案 §4 已经提过的那一件,这里把后果说具体:

1. **真实派发的证据由谁按、钱从哪扣。** 上架门要求每个包在 `runtime-verification.json` 里有「安装 pass + 使用 pass」的精确版本记录
   (`curation-gate.mjs:387-394`,pending 即拒,**没有豁免**)。对 `package:cloud-html` / `package:cloud-image`,「使用 pass」= 在 0.1.20 里各真实派发一次并完成。
   两条路:①给编排器一个生产测试账号的 API key(网站「密钥」页创建,放本机文件,告诉我路径;我只引用路径),由编排器跑,费用计入
   alpha-platform#505 已批的 US$15(预留 US$1 + US$0.30,实际更低);②你在 0.1.20 的定制中心里各点一次,我去读生产记录补证据。
   **不选的代价**:第 6 步永远发不出去,AC1 停在「代码全合、线上没有」——2026-10-13 云 Word/Excel/PPT 就是这个形态。
   **不可逆的部分**:无;两条路都只花这 ≤US$1.30。

另有一件**要 owner 动手但不是裁决**:0.1.20 发版(第 2.6 节第 5 步)。合并不等于用户包里有。

以下几项有可回滚默认值,**本基线自行裁定**,列出只为透明:对 MCP 模型调用方的准入收紧(§2.1);载荷不带 `budget`(§2.2);首批只上 HTML 与图片两包(票面原文);
五张旧卡不在本票双列(第四节 OPTIONAL)。

## 六、仍是推断、没跑过

1. **包确认框的能力派生点**:`package-admission.ts` 用 `evaluateCapabilityDiff`(`:8`、`:1159`)算授权 diff,但**包组件**的 `MANIFEST_CAPABILITIES`
   从哪里按子类型派生我没读到那一行;I10「`cloud:dispatch` 出现在确认框」是对 legacy 派生点(`ext-capability-authorization.ts:33`)的类推。C1 开工第一件事是找到它。
2. **卸载侧**:`ext-package-uninstall.ts` 的 fail-closed 表形状没读,只知道 `ext-package-lifecycle.ts:40-44` 说它 fail-closed。
3. **无源码组件的 intake**:`catalog-publish.md:79-80` 说「每个包的组件都要四件套 intake 记录」,而 cloud 组件没有上游源码;
   `requireCuration` 到底要求 intake 记录还是只要求 curation 决定的 `approvedManifestSha256`,没跑 `build-catalog` 验证。W1 先在本地 build 一次再定处置(绑定到编译载荷 SHA 是我的推断)。
4. **0.1.19 的 UI 行为**(§2.5 第 3、4 步)是照 `74482625a` 的代码推的,没在打包版上点过——这正是 V1 要做的。
5. **包详情页能挂派发框**:只读了 `extension-detail.tsx:149-153` 与 `:336`,没通读那个组件;挂载点可能需要比「加一个 `Show`」多一点改动。
6. **平台三条手写 zod 与注册表派生校验「判决一致」**是设计要求,不是已验证事实;P1 要用 `fixtures/invalid` 先证明两者会在同一输入上红。
7. **alpha-web `E_HOST_ARTIFACT_DRIFT` 的行为**照 runbook 原文引用,没有本地跑 `tests/extension-package-contract.test.mjs` 复现。
8. **office `data` 字段**在 `pipelines.ts:354` 原样透传、准入 `:256` 按 `z.json()` 判——「`type:"json"` 不可进表单」是从这两行推的,没列举过 Word 实际会收什么样的 `data`。
