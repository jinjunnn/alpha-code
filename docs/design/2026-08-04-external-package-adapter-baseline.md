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
                 │  输出:AlphaPackageDeclarationV1 + CompatibilityReport      │
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
2. 对 vendored 的 `AlphaPackageDeclarationV1` 做**严格 schema / profile / graph 校验**;
3. **精确重算文件表 digest**;限制本地命名空间;
4. **host 推导 capability,并绑定到本地确认屏**;
5. 把现有 skills-only 的 `LocalPackagePreviewV1` 扩成 **declaration component 列表**;
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

**不能。** 三格卡死:
skill 车道输入是 `srcDir`/单个 skill;agent 车道输入是已组合的 Markdown + 字段映射;
MCP 车道输入是 `name + server`。三者**只产生 standalone V2/receipt**,
缺 declaration component、缺 package graph、缺声明级 capability 授权模型。

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

### 3.3 逐字段四态映射

**原则:未知语义不静默丢弃。** 每个组件至少一条 finding,`verdict` 等于最强 disposition。

| Claude 插件里的东西 | disposition | 理由 |
| --- | --- | --- |
| `skills/<name>/SKILL.md` + 同目录其余文件 | `mapped` → `skill` profile | `ac#828` 已把载荷升成有界文件清单(`1..64`) |
| `agents/**/*.md` | `mapped` → `agent` profile | 单个 markdown,形状本来就对得上 |
| `.mcp.json` 里声明 `command` 的 server | `mapped` → `mcp-local` | **逐 server 一个组件** |
| `.mcp.json` 里声明 `url` 的 server | `mapped` → `mcp-remote` | 同上 |
| `.mcp.json` 里其它形状的 server | `blocked` | 具名 unknown,**不猜** |
| **非法 JSON 的 `.mcp.json`** | `blocked` + 具名 malformed | ⚠️ **不能当「不存在」**,更不能修补后猜里面的 server |
| `commands/**/*.md` | `blocked`(`ac#840` 落地前) | 宿主三条路都没有安装腿 |
| `hooks/**` | `blocked`(事件面工作落地前) | 引擎缺 `Stop` / `SessionEnd` / 结构化否决 |
| 带可执行位的文件 | 见 `ac#843` | 链路结构上不保留执行位;**告不告知用户是产品裁决** |
| `${CLAUDE_PROJECT_DIR}` 等模板变量 | `review-required`(仅当有可证明的 MCP workspace 映射)否则 `blocked` | **不求值模板** |
| 其余未识别的目录/键 | `blocked` | 未知语义不静默丢弃 |

⚠️ **`skipped` 只在 optional leaf 上合法** —— 不要拿它当「这个我们不支持」的通用出口,
那是 `blocked` 的活。用错会让一个装不全的包以 `compatible` 发出去。

### 3.4 `.mcp.json` 读取器的最小正确形态

实测得出,一个正确的读取器**至少**必须:

1. **先严格 JSON parse**;失败要**具名报 malformed**,不能当「不存在」,更不能修补后猜;
2. 顶层必须是**非 null、非数组的 object**;
3. 若 `mcpServers` 是 object,取它为 server map;**空 object 是合法的零 server,不能退回顶层**;
4. 否则处理语料中**真实存在的 bare 顶层 server map**;
5. 每个 server spec 独立校验:含 `command` 才是 local,含 `url` 才是 remote;其余形状具名 unknown/refuse;
6. **不得只读 `mcpServers`** —— 那会把实测 19 个 server 数成 7 个。

### 3.5 容量:`maxComponents` 与那个 25

按信封真正用的口径实测:**0/62 超过 16,最大 13,中位数 2**。
⇒ **容量今天不卡**,但**余量只有 3**,而且靠最大那个插件的 `.mcp.json` **是非法 JSON** 撑着 ——
那份文件里躺着 **12 个 https server**,上游一修好它就是 `13 + 12 = 25` 个组件。

**本稿的裁定**:`ac#827` 定界时**必须显式回答「25 怎么办」**,并且答案要落进代码或
发布端的 `blocked` finding,**不能只写在 PR 正文里**。
拿「最大 13」去定界 = 定一个偶然值。

> `#827` 与 `ac#828` 改的是**同一个 registry 文件、同一个聚合 SHA** ⇒
> **必须合并成一次跨仓 pin 搬运**,分两次搬第一跳落地就把第二跳的 pin 打陈旧。

### 3.6 装不下的三类:各自的处置

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
2. **零信任外部路径**:所有相对路径过既有的路径文法所有者;**不在第二处复制一份路径判据**。
3. **未知语义不静默丢弃**:每个组件至少一条 finding;`verdict` 等于最强 disposition。
4. **`blocked` 的包不进 build/sign。**
5. **确定性**:同输入双跑,declaration 与 report **逐字节相同**。
6. **不伪造 identity**:manifest/name/version 缺失时**只接受 import spec 显式补齐**;
   **禁止从目录名或 `unknown` 生成 immutable identity**。
7. **本地那条路不得放宽签名那条路的判据** —— 见 §3.2,这是准入条件。

## 6. 开发切片与依赖序

```text
ac#826(语料尺子)✅ 已合
   └─▶ ac#827(定界 + 显式回答「25 怎么办」)  ┐
   ac#828(skill 多文件,宿主侧已交付)         ┴─▶ T0:一次跨仓 pin 搬运(跳 1→2→3→4)
                                                     │
        ┌────────────────────────────────────────────┘
        ▼
  T1 纯库骨架(alpha-web,新写)
     · 输入 = POSIX 相对路径 + Uint8Array 的文件表;输出 = 声明 + 四态报告
     · 无网络 / 无子进程 / 无 dynamic import / 不写盘 / 不求值模板 / 不跑 package script
     · host registry/limits 作为不可变输入注入
        │
        ├─▶ T2 可执行 vendor 供应链(alpha-code,新形态)
        │      · 来源/版本/hash pin · 打包与模块加载合同
        │      · 无副作用测试闸 · producer-consumer 一致性闸 · 更新与审计规则
        │
        ├─▶ T3 aw#98 Claude 适配器(消费 T1)
        ├─▶ T4 aw#96 Codex 适配器(消费 T1)
        │
        └─▶ T5 本地落点(alpha-code):扩 local-package seam
               · IssuedLocalDeclarationPreview(main-held,confirm 只回 previewId)
               · 严格 schema/profile/graph 校验 + 文件表 digest 重算 + 本地命名空间限制
               · host 推导 capability 并绑定确认屏
               · LocalPackagePreviewV1 扩成 declaration component 列表
               · 复用 commitTransactionLedger / uninstallPackageV1

并行、不阻塞上面这条链:
  ac#840(command:范围含安装路径)—— 落地前 commands 恒 blocked
  引擎事件面工作           —— 落地前 hooks 恒 blocked
  ac#843(可执行位的产品裁决)
```

**依赖序里不可换的三条**:
① `#827` 必须在 `#826` 之后(尺子先修好);
② `#827` 与 `#828` **必须同一次搬运**(同一个 registry 文件、同一个聚合 SHA);
③ **T5 必须在 T1 之后** —— 本地那条路要跑的就是 T1 那份字节,先做 T5 就会先写一份注定要被替换的映射,
   而那正是 ADR-040 禁止的「两处各写一份」。

## 7. 每票的确定性退出门

**通用(每一票都要过)**:
- **绕过配方**:摘掉这票新增的那道闸 ⇒ 断言必须**当场变红**,实测输出进 PR 正文;
- 断言绑**用户可观察的结果**,不绑源码文本、不绑内层纯函数的返回值;
- **不断言错误码** —— §3.2.2 已实证:这条路上今天只有 `reason` 字符串,没有稳定的数值/枚举码。

| 票 | 退出门 |
| --- | --- |
| **T1 纯库** | 同输入双跑,declaration 与 report **逐字节相同**;**一条断言证明它在没有 `fs`/`child_process`/网络的环境里跑得起来**(不是「我没 import」,是真的跑);hostile 语料覆盖 traversal / symlink / oversize / deep JSON / `${...}` 转义 / script marker,**断言零执行** |
| **T2 vendor 供应链** | vendored 字节与 producer 产物**逐字节相等**;**改一个字节 ⇒ 闸红**;模块加载后**无 I/O、无副作用**(实测,不是声明) |
| **T3/T4 适配器** | 覆盖 normal / partial / unknown-field / custom-path merge / missing identity;**每个组件至少一条 finding**;`verdict` 等于最强 disposition;`skipped` **只出现在 optional leaf 上**;`blocked` 的包**不进 build/sign** |
| **T5 本地落点** | 一份**多组件**本地声明装上后**逐文件比对字节**;卸载后**全部消失**;子记录是 `user:`/local origin 且**不带 Catalog supply digests**;⚠️ **一条独立断言证明签名那条路的判据一格都没放宽**(verified Catalog、membership、五摘要各一条反向用例) |
| **`ac#827`** | 新上限**从实测分布 + 那条 25 的脆弱性推出**并写明口径;边界对夹具恰好值接受 / +1 拒绝;**期望值从 registry 读还不够** —— 再加一条「把界临时挪到另一个值、看边界跟不跟着走」;**并证明触发的是 `maxComponents` 那道闸而不是别的界先咬** |

## 7. 明确不做

publisher portal / open marketplace、root OpenAI Agent Plugins、MCP Apps UI、
Claude LSP / themes / monitors / channels、URL import、
native/managed Plugin、sandbox、nested Bundle、semver solver、
**复制 Claude loader**、**provider CLI**。
