---
title: 外部包适配为 Alpha 声明 —— 方案基线
kind: design
status: draft
owners:
  - alpha-code extension maintainers
  - alpha-web catalog maintainers
last_reviewed: 2026-08-04
review_after: 2026-11-04
---

# 外部包适配为 Alpha 声明 —— 方案基线

承接票:[`alpha-web#98`](https://github.com/jinjunnn/alpha-web/issues/98)(Claude Code 适配器)、
[`alpha-web#96`](https://github.com/jinjunnn/alpha-web/issues/96)(OpenAI/Codex 适配器)。
父需求:[`alpha-work#49`](https://github.com/jinjunnn/alpha-work/issues/49)。

> **本稿是 REQ-128 Phase 4 被否决之后的新主线。**
> 被否决的那一份(Catalog 托管的 OpenCode Plugin)已标 `superseded`,
> 见 [`2026-08-03-req128-phase4-managed-npm-plugin.md`](2026-08-03-req128-phase4-managed-npm-plugin.md)。
> 权威裁决在 [`ADR-040`](../../.claude/rules/adrs/ADR-040-extension-package-taxonomy.md)。

## 1. 大白话:这一期用户会看到什么

今天用户想用一个 Claude Code 插件,只有一条路:**本地导入**,而且**只装得了技能**——
`commands` / `agents` / `hooks` / `.mcp.json` 全部具名跳过。

这一期把外部插件变成 Alpha 的**一等公民**:

- 发布者(或我们)把一个 Claude Code 插件**适配**成一份 Alpha 声明,
  编译出来就是一个**多组件 Bundle**(技能 + agent + MCP 一起,一次授权、一次事务、一个包);
- 用户在扩展中心看到它、装它、更新它、卸载它,**和装一个 Alpha 原生包没有区别**;
- 装不了的部分**逐字段告诉用户为什么**,而不是静默丢掉。

**不做什么同样重要**:我们**不执行**外部插件的任何代码。
适配是**纯转换**——读文件、产声明。ADR-040 已封死「第三方代码在引擎进程内以引擎权限运行」这条路。

## 2. 前置:已裁决与已勘破,本稿不重新裁决

### 2.1 三条 owner 裁决

| 裁决 | 出处 |
| --- | --- |
| **扩展安装唯一形态是 Bundle**;任何安装路径不得写入引擎 `plugin[]` | ADR-040 决策二、三 |
| **provider 语义映射的收敛走 B 通往 A** —— 适配器抽成纯库、发布端产物化、alpha-code vendored,本地导入跑同一份;终点是本地 intake 退役,**壳何时拆是排期不是设计** | ADR-040 后果第 3 条(`alpha-code@8f411e77`) |
| **`hooks` 后续会支持**,但前置是一次引擎事件面勘破;**在它落地前任何 hooks 实现票不得升 Ready** | ADR-040 被否决方案 C 的补充裁决 |

### 2.2 三份已落地的勘破,本稿引用不复述

| 文档 | 本稿依赖它的什么 |
| --- | --- |
| [`architecture/claude-plugin-corpus-component-scale.md`](../architecture/claude-plugin-corpus-component-scale.md) | 组件规模与口径:**0/62 超过 16,最大 13,中位数 2**;那个「修好一份坏 JSON 就变 25」的插件 |
| [`architecture/engine-command-and-event-surface.md`](../architecture/engine-command-and-event-surface.md) | `command` 的形状与**三条路都没有安装腿**;事件面与 Claude hooks 的真实文法 |
| [`contracts/host-extension-package-v1.md`](../contracts/host-extension-package-v1.md) | 信封与四个 profile 的合同面 |

### 2.3 五条实测事实,直接决定本稿的取舍

1. **报告是四态不是三态**:`mapped` / `skipped` / `review-required` / `blocked`。
   `skipped` 按 `compatible` 排位,且**只在 optional leaf 上合法**;
   `verdict` 必须等于最强 disposition;**每个声明的组件至少要有一条 finding**。
2. **`.mcp.json` 有两种摆法**:9 份带 `mcpServers` 包裹层(其中 2 份是空的)、
   **12 份 server 直接摆在顶层**(全部来自官方 `external_plugins/`)、1 份非法 JSON。
   ⇒ **只读 `mcpServers` 的实现会把 19 个 server 数成 7 个。**
3. **真实语料里有 0 字节文件**(`skill-creator/scripts/__init__.py`)。
   宿主侧的下界已由 `ac#828` 放开到 `0`;**发布端也必须放开**,否则那个技能在发布端就上不了架。
4. **`commands` 今天进不来**:22/62 个插件带、共 100 个文件,而签名 package / 旧 catalog / 本地导入
   **三条路都没有 command 的安装腿**(`ac#840`)。
5. **hooks 今天进不来**:真正声明了 hook 的是 **7/62**(有目录的 12 个里,5 个没有任何声明);
   实际用到 **7 个事件名**(含 ADR-040 漏掉的 `UserPromptSubmit`);
   `if` 用的是**权限规则文法**、`asyncRewake` 三兄弟真实在用、`timeout` 跨度 **180 倍**(5/10/180/900)。

## 3. 选定模型

### 3.1 一份映射,两处消费(B)

```text
                 ┌──────────────── alpha-web(发布端,唯一真源)────────────────┐
规范化文件表 ──▶ │  纯库 provider-adapter/claude-code.mjs                      │
                 │    无网络 · 无子进程 · 无 dynamic import · 不写盘            │
                 │    不求值模板 · 不跑 package script                          │
                 │  输出:AdapterResultV1(declaration 可为 null,见 §3.4)     │
                 └────────────┬───────────────────────────┬───────────────────┘
                              │ 产物化 + 字节锁            │ 同一份字节
                              ▼                           ▼
                  发布端 compiler → 签名 Bundle      alpha-code vendored 副本
                              │                           │
                              ▼                           ▼
                     用户从扩展中心安装            用户从本机目录导入
```

**为什么必须是纯库,而不是「两边各写一份 + 差异闸」**:
两份别人文法的替身**一定会分叉**,这是本仓记录在案最贵的返工形态。
纯库 + 字节锁让漂移**结构上不可能**,不依赖「两边都记得改」这种纪律。

**为什么必须纯**:不纯就 vendored 不过来 ⇒ B 当场退化成「两处各写」。
所以「纯」不是代码风格,是 B 的生死线。

### 3.2 本地落点(ADR-040 定的基线准入条件)

#### 3.2.1 先澄清「冻结的信封合同」到底冻的是什么

**`AlphaPackageEnvelopeV1` 这个 JSON 本身不带签名字段。**
Ed25519 签的是 **channel、snapshot、payload** 三样。
「冻结信封」实际指四件事:**严格封闭形状**、**允许的 profile/capability 精确集**、
**图约束**、**admission 的五摘要绑定**。

| 冻结体现在 | 出处 |
| --- | --- |
| profile / capability / limit 精确锁死,并负向拒绝非允许 profile | `main/host-extension-package-artifact.test.ts:63`、`:146` |
| 信封与 component 都是 `additionalProperties: false`,component 强制 `payloadRef` | `vendor/extension-package/alpha-package-envelope-v1.schema.json:5`、`:64` |
| `payloadRef` 的 HTTPS / SHA-256 / 字节数 / media type 锁死 | 同 schema `:133` |
| decoder 的**负面空间**被冻结(过宽、图错误、unknown version、inline payload、unknown key) | `shared/extension-package/package-envelope-v1.test.ts:859`、`:1030` |
| **admission binding 必须恰好五项**,逐项篡改验证拒绝 | `main/package-admission.test.ts:436`、`:468` |
| `graphDigest` 必须独立且有语义(不是 envelope/item digest 的别名) | `main/package-admission.test.ts:751` |
| producer/consumer 的目录与字节被反向钉住 | `alpha-contracts-consumer/src/extension-package-artifact.test.ts:34`、`:106` |

⇒ **加 `declaration`、inline bytes 或 local-source 字段,会直接撞 `additionalProperties: false`。**

#### 3.2.2 一份本地声明今天会在哪一步被拒

六处硬要求「你来自已签名 Catalog」:
`VerifiedCatalogLoad.source` 只有 `"none" | "remote" | "cache"`(`package-admission.ts:114`);
channel / snapshot / payload 分别过 Ed25519(`catalog-channels.ts:342`、`:373`、`:499`,
cache/LKG **也重新验证,不因落盘而豁免** `:675`);
admission 必须先取得 verified Catalog(`package-admission.ts:466`);
`catalogId` 必须是 verified snapshot 成员(`:477`);
**`local:` 命名空间被显式拒绝**(`:491`);
输入 decoder 只接 `attemptId/catalogId/...`(`:1134`)。

实际失败顺序(实读得出,不是推断):

| 你怎么塞 | 在哪一步死 |
| --- | --- |
| 带 `attemptId` 的本地声明 | preflight 路由到 admission(`package-installability.ts:303`),在**输入 decoder** 因 unknown key 失败 |
| 不带 `attemptId` | 落入 legacy `installCatalog`(`:309`),其 decoder 同样不接受声明形状(`ext-install-planner.ts:295`) |
| 伪装成单个 `catalogId` | **verified Catalog membership** 处失败 |
| 塞成 `local:` Catalog 项 | **namespace gate** 处失败 |

⚠️ **这些失败没有稳定的数值/枚举错误码,今天 outcome 只有 `reason` 字符串。**
适配器与本地路径的验收**不得断言错误码**——那个东西不存在。

#### 3.2.3 五个 digest 在无签名场景下还剩什么意义

| Digest | 无签名本地声明是否仍成立 | 判断 |
| --- | --- | --- |
| `snapshotDigest` | ❌ | 它绑定 signed coherent Catalog snapshot;**没有 snapshot 就没有被绑定对象** |
| `envelopeDigest` | ❌(按现名义) | 没有 envelope。**可以**算一个「本地声明/文件表 digest」,但**不能继续叫 signed-envelope digest** |
| `graphDigest` | ✅ | 只要 host 从严格验证过的声明**确定性地**产生 effective install graph,它仍能防 TOCTOU;**但不证明来源** |
| `itemDigests` | ✅ | 对 main-held 规范化字节计算,仍有**完整性**意义;**不提供真实性** |
| `capabilityDigest` | ⚠️ 有条件 | 必须由 host **从已验证声明推导**并绑定**用户看到的授权内容**;它证明授权内容未变,**不证明发布者身份** |

> ⚠️ V3 账本另有一个 `installedGraphDigest`(`ext-package-ledger-v3.ts:61`),**不能与 admission 的 `graphDigest` 混为一谈**。
> 今天本地 Claude 路径还把本地 normalized payload digest 放进 graph 的 `envelopeDigest` 字段(`:74`)——
> **那是账本字段复用,不等于签名信封。** 新合同要把这个名字理顺,别把复用固化成谎言。

#### 3.2.4 落点:**扩展现有 local-package seam**(采纳)

**接入点**:`main/local-package-install-port.ts:58`(端口)、
`main/claude-plugin-install.ts:204`(计划构建)、`:470`(执行入口)。

**为什么是它**:本地 Claude plugin 这条车道**已经落在同一套 V3 包图账本上**
(`claude-plugin-install.ts:321`,bundle/root owner claims,四集合双射在提交前校验 `:356`),
**已经有整包卸载**(`ext-package-uninstall.ts:245`)。
缺的只是它的输入还是 skills-only 的 `LocalPackagePreviewV1`(`:79`),
component 固定为 skill、capability 固定 `[]`(`:307`)。

**最小新增**:

1. 新的 main-held `IssuedLocalDeclarationPreview` —— **纯 adapter 在已捕获的规范化文件表上运行**,
   renderer confirm 只回传 `previewId`;
2. 🔴 **校验完整的 `AdapterResultV1`,不只是声明**(审计 B3):
   - **`verdict: "blocked"` ⇒ 零 preview-confirm、零事务、零写盘**;
   - **`review-required` ⇒ 必须在确认屏展示,并绑定精确的 finding digest**;
   - 绑定 `fileTableSha256` 与声明。
   **不做这一条,发布与本地会分叉**:发布端明确拒绝 `blocked` 进入 build/sign
   (`alpha-web/.../extension-package-core.mjs:1992`),而本地若只看声明,
   一个含 `commands`/`hooks` 的包会拿到「映射组件声明 + blocked 报告」,
   **本地照装映射子集,用户得到一个不完整的插件**。
3. 对 vendored 的 `AlphaPackageDeclarationV1` 做**严格 schema / profile / graph 校验**;
4. **精确重算文件表 digest**;限制本地命名空间;
5. **host 推导 capability,并绑定到本地确认屏**;
6. 把现有 skills-only 的 `LocalPackagePreviewV1` 扩成 **declaration component 列表**;
   **agent / MCP 复用既有 installer,不重写它们的语义**。

**账与卸载**:复用 `commitTransactionLedger`(`ext-package-ledger-commit.ts:20`);
写同一套 V3 `packageGraphs` + bundle owner claims + V2 子记录 + 旧 receipt;
⚠️ **子记录仍须是 `user:` / local origin,不得伪造 Catalog supply digests**
(`ext-receipt-v2.ts:224` 已具名拒绝非 Catalog ID 带 `manifestDigest`/`payloadDigest`/grant/channel sequence);
卸载走 `uninstallPackageV1`。

**冻结影响:零。** 保持为**独立的 local contract** 时,
**不需要修改** envelope schema、签名验证、verified Catalog membership、admission 五摘要断言中的任何一条。
必须新增的是**本地声明 contract、local binding 与相应测试**。

#### 3.2.5 候选二与一个明令禁止的伪候选

**候选二:拆出共享 prepared-package executor**
(从 `package-admission.ts:640` 的 `executePreparedPackage` 与 `:710` 的 component dispatcher 抽出,
signed resolver `:466` 原样保留,另增 `prepareLocalDeclaration`)。

要分离的判据有四组:Catalog receipt factory vs local receipt factory;
signed envelope/snapshot binding vs local file-table/declaration binding;
Catalog grants/prerequisites vs 本地 capability confirmation;package graph provenance 的本地语义。

**风险高于候选一**:它会触及 package-admission 的 wiring/parity 闸(`scripts/gate-files.tsv:62`),
需要证明 refactor 等价;而且——
⚠️ **共享执行器若把 signed 专属字段做成普遍 optional,会直接削弱真闸。**

**❌ 明令禁止的伪候选:给 admission 增加 `source: "local"`。**
在 `createPackageAdmissionCoordinator` / `resolvePreparedPackage` 内把 verified Catalog、
membership、`snapshotDigest` 或 `envelopeDigest` 改成可选,会同时撞:
exact five-key/tamper 断言、signed Catalog wiring 集成、`VerifiedCatalogLoad` source 联合、
`local:` namespace 拒绝、envelope/profile/decoder 的负面合同。

**只有在进入 signed resolver 之前做一条完全不相交的 main-minted local 分支才安全** ——
而那实质上就是候选二。

#### 3.2.6 现有 uncurated 车道能不能直接吃一份声明

**不能。** **四**格卡死:
skill 车道输入是 `srcDir`/单个 skill;agent 车道输入是已组合的 Markdown + 字段映射;
MCP 车道输入是 `name + server`。三者**只产生 standalone V2/receipt**,
缺 declaration component、缺 package graph、缺声明级 capability 授权模型。

🔴 **第四格(审计 m1 补入,初稿漏数)**:**缺跨 kind 的一次事务与唯一 package mutation。**
skill 与 agent 是**各自独立的事务**,MCP 甚至是**先写配置、再单独记 receipt**。
⇒ **明令禁止「顺序调用这三条 uncurated lane 来实现 Bundle」** ——
那样第二/第三个组件失败会留下**部分安装**,而且**没有整包图可卸载**。
初稿只写三格,读者会误以为「补三种输入转换即可」。

⇒ 本地 Claude plugin 那条 seam 能省掉**事务、V3 账本、卸载**三大块工作,
**但「声明直接可喂」是不成立的**,输入形状必须扩。

### 3.3 ⚠️ 纯库是**新写的**,不是抽出来的;vendored 可执行代码是**新形态**

这两条是勘破推翻的成本假设,**必须写在基线里**,否则排期会低估。

**一、发布端今天没有「规范化文件表 → 声明 + 报告」这一段。**
`alpha-web/scripts/lib/extension-package-core.mjs` **自己声明**只实现 declaration validator/compiler,
**provider adapter 明确缺席**。最接近的是
`compileAlphaPackageDeclarationV1`(`:1420`)——它吃的是**已有的声明 + 组件资产表**,不是 provider 目录。
⇒ **纯库是新写的代码,不是把现有代码抽一抽。**

**二、`extension-package-core.mjs` 原封不动 vendored 不过来。**
它静态导入了 **5 个 Node builtin**(`node:crypto`、`child_process`、`fs`、`path`、`url`,`:10`),
并有传递的顶层 `fs` 读取。抽纯时必须剥掉七样:
①文件遍历 / symlink / path 绑定 / 读写盘留在 wrapper;
②Git / curation / 签名验证与 `child_process` import;
③host registry/limits 改为**不可变输入注入**;
④文件表统一成 **POSIX 相对路径 + `Uint8Array`**;
⑤用 `TextEncoder` + 纯字节比较替代 `Buffer`;
⑥注入或内置**无副作用**的 SHA-256;
⑦**compiler 与 provider adapter 分层——不能把现有 compiler 冒充 adapter。**

**三、在 Electron main 里执行一份 vendored `.mjs` 纯库,本仓没有先例。**
`packages/alpha-contracts-consumer/vendor/` 今天 **59 个文件:57 个 JSON + 2 个 Markdown,零可执行代码**;
其测试明确把这些当**数据**(producer artifact / schema / registry / fixture / 哈希锁)对待
(`extension-package-artifact.test.ts:34`)。

⇒ **这是一个新的供应链形态**,至少要新增五样:
①可执行 vendor 的**来源 / 版本 / hash pin**;
②**构建打包与模块加载合同**;
③**无副作用 / 无 I/O 的测试闸**;
④**producer-consumer 的字节或语义一致性闸**;
⑤**更新流程与供应链审计规则**。

> ⚖️ **这一条是 owner 裁 B 时尚未测量到的成本。**
> 它不推翻 B(候选 C/D 的代价更大),但它把 B 的第一步从「抽个库」变成
> 「**写一个新库 + 建一条新的可执行供应链**」。排期与审计强度要照这个算。

### 3.4 适配结果合同:`AdapterResultV1`(**不是** CompatibilityReport)

> 🔴 **这一节由 2026-08-04 方案审计的 B1 加入。初稿把这件事交给了现有的 CompatibilityReport,那是错的。**

**现有的 `CompatibilityReport` 承载不了源目录的四态审计**,实读三条:

1. 它的 `inputSha256` 绑定的是**规范化后的声明**,**不是 provider 的文件表**;
2. finding 的 `path` **必须是声明组件的 JSON 路径**(`alpha-web/scripts/lib/extension-package-core.mjs:1209` 明确校验);
3. ⇒ **`commands/**`、`hooks/**`、非法 `.mcp.json`、manifest 未识别字段、support/runtime 文件
   全都逐项绑不上** —— 一个错误适配器可以**静默丢掉它们,仍产出结构合法的 `compatible` 报告**。

**还有一个更硬的矛盾**:真实语料里 **8 个插件不存在任何当前合法组件**,
而**声明必须有 root**。⇒ 这些包**没有合法的输出形状**,而初稿又要求 T1「始终输出声明 + 报告」。

**因此适配器的结果是一个独立合同:**

```jsonc
AdapterResultV1 {
  fileTableSha256: string,        // 绑定精确的规范化【文件表】,不是声明
  declaration: AlphaPackageDeclarationV1 | null,   // 允许 null
  verdict: "compatible" | "review-required" | "blocked" | "no-installable-component",
  findings: [{
    sourcePath: string,           // 【源路径】,不是声明组件的 JSON 路径
    sourceCategory: "skill" | "agent" | "mcp" | "command" | "hook" | "manifest" | "support" | "unknown",
    disposition: "mapped" | "skipped" | "review-required" | "blocked",
    code: string
  }]
}
```

**两条硬规则**:
- **源目录里的每一个条目都必须被至少一条 finding 覆盖** —— 这才是「未知语义不静默丢弃」可检验的形态;
- **现行的 `CompatibilityReport` 只是「可发布声明」的投影**,
  **不冒充 provider 源覆盖报告**;`declaration === null` 时它不存在。

#### 输入合同:`ImportSpecV1`(**必需**,初稿漏了)

> 🔴 由 2026-08-04 方案审计的 M1 加入。

§5 要求「缺 identity 时由 import spec 显式补齐」,而初稿的 T1 入参**根本没有 import spec**。
实测:**62 个真实 manifest 里 27 个没有 `version`**(`main/claude-plugin-intake.test.ts:134` 已钉住),
manifest **也不提供 Alpha 需要的 `publisher` 与 `redistributable`**。
⇒ 不补这一格,实现者只能**拒掉真实包**,或者**硬编码身份与再分发许可**。

```jsonc
ImportSpecV1 {
  packageId, version,            // manifest 缺失时由此补齐
  publisher,                     // manifest 不提供
  redistributable: boolean,      // manifest 不提供,且是发布/seed 的前置事实
  provenance: "manifest" | "import-spec"   // 每个字段的来源必须可追
}
```

**必须在基线里定死的三件事**:
1. **manifest 与 import spec 的优先级**(谁覆盖谁);
2. **缺失时的终态**(是 `blocked` 还是要求用户补,**不得回落到目录名或 `unknown`**);
3. **稳定的 root 选择规则** —— 哪个组件是 required root。
   ⚠️ 见 §5 不变量 8:**Claude 没有 optional 语义,默认全部 `required`**;
   不定这条,一个错误实现可以「把组件标 optional + 用 `skipped`」伪装成完整兼容。

### 3.5 逐字段映射:**必须在实现前冻结,初稿的三个 `mapped` 前提都不成立**

> 🔴 **这一节被 2026-08-04 方案审计的 B2 推翻重写。**
> 初稿按「形状对得上」把 skill / agent / MCP 三大类整体标成 `mapped`。
> 审计**把真实语料喂进生产解析器跑了一遍**,三条全是反例。

#### 实测反例(全部跑过生产代码,不是读 schema 推断)

| 类别 | 实测 | 出处 |
| --- | --- | --- |
| **agent** | **43 个真实 plugin-level agent,只有 9 个通过生产 `agentMdToEntry`,34 个被拒**:`tools` 23、`effort` 7、块式 YAML 4。**宿主在 admission 期就调用该解析器并拒装**,不是预览层差异 | `main/package-admission.ts:561` |
| **skill** | **159 个标准布局里生产 intake 拒 27 个**:12 个含 Alpha 兑现不了的控制字段、18 个不自包含(重叠 3) | `main/claude-plugin-intake.test.ts:84` |
| **MCP** | 19 个 server 三种形状:`args+command` **10**、`type+url` **6**、`headers+type+url` **3**。5 个 local 用 `${...}`,**其中 4 个依赖 MCP profile 根本不携带的 `${CLAUDE_PLUGIN_ROOT}` 文件**;3 个 remote 的 Authorization header 需转成 `headersTemplate + requiredSecrets` | 语料实测 |

⚠️ **仓内现有夹具没有 agent 的真字节** —— 不能据它宣称 profile 接得住
(`docs/architecture/claude-plugin-corpus-component-scale.md` 已具名警告)。

#### 因此:**逐字段 source grammar 与转换/拒绝表,必须在实现开工前冻结**

冻结的内容至少要覆盖:

- **skill**:12 个控制字段各自的处置(拒 / 降级 / 具名 review-required);
  18 个「不自包含」的跨目录依赖怎么办(拒 / 连同插件根文件一起打进组件)。
- **agent**:**frontmatter 每一个字段**的映射或拒绝 —— 尤其 `tools`(23 例)、`effort`(7 例)、
  块式 YAML(4 例)。**不要复用 Alpha 自有的受限文法当作 Claude 的文法**(那是「手写别人文法的替身」)。
- **MCP**:`command + args`、`url + type`、`headers`、secret、`${CLAUDE_PLUGIN_ROOT}`、
  未知键,以及 **`command` 与 `url` 同时出现时的优先级**。
  ⚠️ **错误实现可以丢掉 args / header 之后照样标 `mapped`,产出「装得上但起不来」的 MCP。**

#### 四态表(修订版)

**原则:未知语义不静默丢弃。源目录每个条目至少一条 finding;`verdict` 等于最强 disposition。**

| Claude 插件里的东西 | disposition | 说明 |
| --- | --- | --- |
| `skills/<name>/` **且通过生产 intake** | `mapped` → `skill` | `ac#828` 已把载荷升成有界文件清单(`1..64`,允许 0 字节条目) |
| `skills/<name>/` **含控制字段或不自包含** | **按冻结表逐字段判**(拒 / `review-required`) | 实测 27/159 落在这里 |
| `agents/**/*.md` **且通过生产 `agentMdToEntry`** | `mapped` → `agent` | 实测只有 9/43 |
| `agents/**/*.md` **被生产解析器拒** | **按冻结表逐字段判** | 实测 34/43 |
| `.mcp.json` 的 `command`(+`args`)server | `mapped` → `mcp-local`,**逐 server 一个组件** | ⚠️ `args` 必须一起带,丢了就是「装得上起不来」 |
| `.mcp.json` 的 `url`(+`type`/`headers`)server | `mapped` → `mcp-remote` | Authorization header → `headersTemplate + requiredSecrets` |
| MCP 里的 `${CLAUDE_PLUGIN_ROOT}` 引用 | **`blocked`**,除非该文件被同一个包携带 | 实测 4/5 个 local 依赖 profile 不携带的文件 |
| `.mcp.json` 里其它形状 / `command && url` 同时出现 | `blocked` | 具名 unknown,**不猜** |
| **非法 JSON 的 `.mcp.json`** | `blocked` + 具名 malformed | ⚠️ **不能当「不存在」**,更不能修补后猜里面的 server |
| `commands/**/*.md` | `blocked`(`ac#840` 落地前) | 宿主三条路都没有安装腿 |
| `hooks/**` | `blocked`(事件面工作落地前) | 引擎缺 `Stop` / `SessionEnd` / 结构化否决 |
| **零合法组件的插件**(实测 8 个) | `verdict: "no-installable-component"`,`declaration: null` | 声明必须有 root ⇒ **没有别的合法输出形状** |
| `${CLAUDE_PROJECT_DIR}` 等模板变量 | `review-required`(仅当有可证明的 MCP workspace 映射)否则 `blocked` | **不求值模板** |
| 其余未识别的目录/键/support 文件 | 至少一条 finding | 未知语义不静默丢弃 |

⚠️ **`skipped` 只在 optional leaf 上合法** —— 不要拿它当「这个我们不支持」的通用出口,那是 `blocked` 的活。
**生产校验器确实执行这条交叉校验**(`alpha-web/.../extension-package-core.mjs:1279`),
**但发布的 JSON Schema 只枚举 disposition** ⇒ **单独跑 schema validation 不会执行这条约束,不能当完整闸。**

⚠️ **Claude provider 没有 optional 语义** ⇒ **默认所有映射组件 `required`,不得自行创造 optional**。
否则一个错误实现可以把组件标成 optional、再用 `skipped` 伪装成完整兼容。

### 3.6 `.mcp.json` 读取器的最小正确形态

实测得出,一个正确的读取器**至少**必须:

1. **先严格 JSON parse**;失败要**具名报 malformed**,不能当「不存在」,更不能修补后猜;
2. 顶层必须是**非 null、非数组的 object**;
3. 若 `mcpServers` 是 object,取它为 server map;**空 object 是合法的零 server,不能退回顶层**;
4. 否则处理语料中**真实存在的 bare 顶层 server map**;
5. 每个 server spec 独立校验:含 `command` 才是 local,含 `url` 才是 remote;其余形状具名 unknown/refuse;
6. **不得只读 `mcpServers`** —— 那会把实测 19 个 server 数成 7 个。

### 3.7 容量:`maxComponents` 与那个 25

按信封真正用的口径实测:**0/62 超过 16,最大 13,中位数 2**。
⇒ **容量今天不卡**,但**余量只有 3**,而且靠最大那个插件的 `.mcp.json` **是非法 JSON** 撑着 ——
那份文件里躺着 **12 个 https server**,上游一修好它就是 `13 + 12 = 25` 个组件。

**本稿的裁定**:`ac#827` 定界时**必须显式回答「25 怎么办」**,并且答案要落进代码或
发布端的 `blocked` finding,**不能只写在 PR 正文里**。
拿「最大 13」去定界 = 定一个偶然值。

> `#827` 与 `ac#828` 改的是**同一个 registry 文件、同一个聚合 SHA** ⇒
> **必须合并成一次跨仓 pin 搬运**,分两次搬第一跳落地就把第二跳的 pin 打陈旧。

### 3.8 装不下的三类:各自的处置

| | 今天的状态 | 处置 |
| --- | --- | --- |
| **`commands`** | 22/62 插件、100 文件;**三条路都没有安装腿** | `ac#840`,**范围含安装路径**,不是只补 profile。生效层二选一(存原始 `.md` 让引擎自己扫 / 携带结构化 `ConfigCommandV1.Info`),**不造第三套解析器**;`variant` **不进合同**(上游不兑现它) |
| **`hooks`** | 7/62 插件真正声明;引擎缺 `Stop`、`SessionEnd`、结构化否决;`permission.ask` 声明了却**永不触发** | 先补引擎事件面。**在那之前 `blocked`**,ADR-040 明令不得升 Ready |
| **可执行位** | 语料 9 技能 / 25 文件;链路结构上不保留 | `ac#843`(产品裁决:告不告知用户) |

## 4. 被否决的替代

| | 做法 | 否决理由 |
| --- | --- | --- |
| **给每个 provider 加 profile** | `claude-plugin` / `codex-plugin` | provider 数量会线性污染宿主合同的种类枚举,而该枚举有 exact-set 断言 + 跨仓 vendored pin;且把**来源**当成了**种类**。ADR-040 被否决方案 A |
| **让宿主直接消费外部插件的原生目录结构** | — | 「手写别人文法的替身」。provider 的目录约定由 provider 定义、随时会变 |
| **`opencode-plugin` profile** | REQ-128 Phase 4 | ADR-040 被否决方案 C,已回滚 |
| **两处各写映射 + 差异闸** | — | ADR-040 后果第 3 条候选 D:违反「不得在两处各写一份」;两份替身一定分叉 |
| **本地导入把目录发到 alpha-web 换回声明** | — | 候选 C:装本机插件要联网 + 本地文件出机器。离线与隐私两头都坏 |

## 5. 安全不变量

1. **零执行**:适配器无网络、无子进程、无 `dynamic import`、不写盘、不求值模板、不跑 package script。
   输入是**已 capture 的规范化文件表**。
2. 🔴 **symlink 圈禁与模式位属于 capture 层,不属于纯库**(审计 B4)。
   T1 的输入只有 `path + 字节`,**symlink 身份在 capture 时已被抹掉** ——
   纯 adapter **结构上分不出**正常文件与被 wrapper 跟随的越界 symlink。
   ⇒ **realpath 圈禁必须由两个 capture wrapper(alpha-web 侧与本地侧)各自持有并各自立门**,
   断言 **adapter 从未收到树外字节**。
   同理输入没有 mode ⇒ **规范化条目必须带 `executable` 标记,或在 capture 阶段保守阻断**。
3. **零信任外部路径**:所有相对路径过既有的路径文法所有者;**不在第二处复制一份路径判据**。
4. **源目录每个条目至少一条 finding**;`verdict` 等于最强 disposition。
5. **`blocked` 的包不进 build/sign,也不进本地安装** —— 两边都要执行(见 §3.2.4 第 2 条)。
6. **确定性 + 输入敏感性**:同输入双跑逐字节相同,**且**改变输入的任一维度时输出发生**预期变化**
   (见 §7 T1 —— 只有前半句时,一个返回固定值的实现完全满足)。
7. **不伪造 identity**:manifest/name/version 缺失时**只接受 import spec 显式补齐**;
   **禁止从目录名或 `unknown` 生成 immutable identity**。
8. 🔴 **不得自行创造 optional**:Claude provider 没有 optional 语义 ⇒ **默认全部映射组件 `required`**。
   否则可以「标 optional + `skipped`」伪装成完整兼容。
9. **本地那条路不得放宽签名那条路的判据** —— 见 §3.2,这是准入条件。

## 6. 开发切片与依赖序

> 🔴 **依赖图与切片由 2026-08-04 方案审计的 M2 修订。**
> 初稿把 T5 画成只依赖 T1,那是错的:**T1 只是骨架,Claude 映射在 T3,vendoring 在 T2。**
> 照初稿实施,T5 要么没有 Claude adapter 字节可跑,要么**先在 alpha-code 重写一份映射** ——
> **直接复现 ADR-040 禁止的双真源**,而那正是这份基线存在的理由。

```text
ac#826(语料尺子)✅ 已合
   └─▶ ac#827(定界 + 显式回答「25 怎么办」)  ┐
   ac#828(skill 多文件,宿主侧已交付)         ┴─▶ T0:一次跨仓 pin 搬运(跳 1→2→3→4)
                                                     │
   ⚠️ ac#843(可执行位)—— 已从「并行」改为【前置】,理由见 §5 不变量 2
                                                     │
        ┌────────────────────────────────────────────┘
        ▼
  T1 纯库骨架(alpha-web,新写代码,不是抽出来的)
     · 输入 = ImportSpecV1 + 规范化文件表(POSIX 相对路径 + Uint8Array + executable 标记)
     · 输出 = AdapterResultV1(declaration 可为 null)
     · 无网络/无子进程/无 dynamic import/不写盘/不求值模板/不跑 package script
     · host registry/limits 作为不可变输入注入
        │
        ├──────────────────────┐
        ▼                      ▼
  T3 aw#98 Claude 适配器   T2-infra 可执行 vendor 供应链(alpha-code,新形态)
  T4 aw#96 Codex 适配器       · 来源/版本/hash pin · 打包与模块加载合同
  (逐字段冻结表 §3.5)          · 无副作用闸 · 一致性闸 · 更新与审计规则
        │                      │
        └───────┬──────────────┘
                ▼
        不可变 vendor pin / build   ← ⚠️ T3 与 T2-infra 的 join,初稿漏画
                │
                ▼
        T5a 本地 capture / result / preview binding(alpha-code,【零写盘】)
                │   · realpath 圈禁 + executable 标记由本地 capture wrapper 持有
                │   · 校验完整 AdapterResultV1;blocked ⇒ 零 preview-confirm
                ▼
        T5b 多组件一次事务 + ledger + uninstall(走生产 IPC 与真事务)

并行、不阻塞:
  ac#840(command:范围含安装路径)—— 落地前 commands 恒 blocked
  引擎事件面工作            —— 落地前 hooks 恒 blocked
```

**依赖序里不可换的五条**:
① `#827` 必须在 `#826` 之后(尺子先修好);
② `#827` 与 `#828` **必须同一次搬运**(同一个 registry 文件、同一个聚合 SHA);
③ 🔴 **T5 依赖的是 `T3 + T2-infra` 的 join,不是 T1** —— 先做 T5 就会先写一份注定要被替换的映射,
   **那正是 ADR-040 禁止的「两处各写一份」**;
④ 🔴 **`ac#843` 是前置不是并行** —— T1 的输入必须带 `executable` 标记,
   否则它看不见语料里那 25 个可执行文件(审计 B4);
⑤ 🔴 **T5 拆成 T5a / T5b** —— 前者必须**零写盘**,后者才走真事务;
   合在一票里,「零写盘」那半边的门会被后半边的写盘淹掉。

## 7. 每票的确定性退出门

**通用(每一票都要过)**:
- **绕过配方**:摘掉这票新增的那道闸 ⇒ 断言必须**当场变红**,实测输出进 PR 正文;
- 断言绑**用户可观察的结果**,不绑源码文本、不绑内层纯函数的返回值;
- **不断言错误码** —— §3.2.2 已实证:这条路上今天只有 `reason` 字符串,没有稳定的数值/枚举码。

| 票 | 退出门 |
| --- | --- |
| **T1 纯库** | 🔴 **双跑逐字节相同远远不够**(审计 M5:一个返回固定 declaration/report 的实现完全满足它;若固定值恰等测试 fixture,门全绿而真实插件全部映成同一个包)。**必须加输入敏感性门**:分别改变 identity / 一个文件的字节 / 路径 / MCP `args` / MCP header / 未知类别 / host limit,**断言只有对应的输出字段、digest、disposition 发生预期变化**;**期望值从独立的 canonicalizer 或 fixture oracle 得出,不读 adapter 自己的输出回填**(否则是自指等价链)。<br>「在没有 `fs`/`child_process`/网络的环境里真跑」**可执行**:隔离的 `vm.SourceTextModule`(或等价 isolate),**自定义 linker 拒绝所有 builtin 与 dynamic import**,context 不提供 `process`/`require`/`fetch`/`WebSocket`,**真 evaluate 该模块并调用 adapter**,同时观测全局写入。<br>⚠️ **symlink 门不在这里** —— 见 §5 不变量 2,它属于 capture 层。 |
| **T2-infra vendor 供应链** | 🔴 **「vendored 字节等于旁边的 producer copy」是假闸**(审计 M3)。Electron 生产**只打包 `out/**` 与 `resources/**`**(`electron-builder.config.ts:78`),main 又由 Rollup 从 TS entry 打包(`electron.vite.config.ts:41`)⇒ **packaged app 里根本没装入该模块、或生产 handler 压根没调用它时,那条门照样全绿。**<br>因此:①比较对象必须是**固定 alpha-web commit 构建出的不可变 producer artifact**,**不能由 consumer 的 vendor 反向生成**;②**对 packaged/main build 跑一个特征输入,经真实本地 handler 拿到特征输出**;③**删掉生产的 import/调用、或把 adapter 从 bundle 里移除 ⇒ 门必须红**。<br>「无 I/O、无副作用」用与 T1 同一套 isolate 办法实测。 |
| **T3/T4 适配器** | 🔴 **真实语料逐个跑过 adapter,再送进生产 host parser / decoder / builder**(审计 B2):**159 个 skill、43 个 agent、19 个 MCP server** 全量,并**先把 agent 的真字节补进语料**(今天仓内夹具没有)。<br>覆盖 normal / partial / unknown-field / custom-path merge / missing identity;**源目录每个条目至少一条 finding**;`verdict` 等于最强 disposition;`skipped` **只出现在 optional leaf 上**(⚠️ **单跑 JSON Schema 不执行这条约束**,必须跑生产校验器);`blocked` 的包**不进 build/sign**;**零合法组件的插件产出 `no-installable-component` + `declaration: null`**(实测 8 个)。 |
| **T5a 本地 binding(零写盘)** | 🔴 **`blocked` 的 `AdapterResultV1` ⇒ 零 preview-confirm、零写盘**;**删掉 verdict gate ⇒ 发生写盘且测试变红**(真实本地 IPC 反向用例,审计 B3)。`review-required` 在确认屏展示并绑定精确 finding digest。**realpath 圈禁在这一层立门,断言 adapter 从未收到树外字节。** |
| **T5b 事务 + 账本 + 卸载** | 一份**多组件**本地声明装上后**逐文件比对字节**;卸载后**全部消失**;子记录是 `user:`/local origin 且**不带 Catalog supply digests**;**跨 kind 是一次事务、一个 package mutation**(不得顺序调用三条 uncurated lane)。<br>🔴 **签名路径的反向门必须走真链**(审计 M4:初稿列的「verified Catalog / membership / 五摘要各一条反向用例」**不够** —— 现有五字段 tamper 测试只证明 renderer 改 binding 会被拒,**不证明各 digest 随真实签名输入变化**,也不证明生产 IPC 仍经过签名验证;当前真签名链用例只有单个 happy path、**没有负向半场**)。必须经**真实 `ext-install-catalog` handler + 真实 Ed25519 trust/snapshot/channel/catalog 链**,至少覆盖:①任一签名/快照事实被篡改 ⇒ 零事务;②签名有效但 catalog membership 缺失 ⇒ 零事务;③已签的 `local:` namespace 被拒;④**五种底层签名事实分别变化时,相应 binding 从独立输入推导并变化,旧确认被拒**;⑤**删掉生产的 signed resolver 调用 ⇒ 整门变红**。 |
| **`ac#827`** | 新上限**从实测分布 + 那条 25 的脆弱性推出**并写明口径;边界对夹具恰好值接受 / +1 拒绝;**期望值从 registry 读还不够** —— 再加一条「把界临时挪到另一个值、看边界跟不跟着走」;**并证明触发的是 `maxComponents` 那道闸而不是别的界先咬** |

## 8. 明确不做

publisher portal / open marketplace、root OpenAI Agent Plugins、MCP Apps UI、
Claude LSP / themes / monitors / channels、URL import、
native/managed Plugin、sandbox、nested Bundle、semver solver、
**复制 Claude loader**、**provider CLI**。
