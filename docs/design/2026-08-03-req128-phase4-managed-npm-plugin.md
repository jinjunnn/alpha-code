---
title: REQ-128 Phase 4 方案基线：Catalog 托管的 OpenCode Plugin（单包窄竖线）
kind: design
status: superseded
owners:
  - alpha-code extension maintainers
last_reviewed: 2026-08-03
review_after: 2026-11-03
---

> # ⛔ 本稿整体作废，不得据此开工
>
> **2026-08-03 owner 裁决**：[`ADR-040 扩展安装唯一形态是 Bundle`](../../.claude/rules/adrs/ADR-040-extension-package-taxonomy.md)
> 否决了本稿的**题目本身** —— 不是某几条结论过期，是「Catalog 托管的 OpenCode Plugin」这条路
> 被整条封死。ADR-040「被否决的方案 C」就是本稿。
>
> **裁决的实质**：不接受第三方代码在**引擎进程内**、以**引擎权限**、经**一个我们不拥有的加载器**运行。
> 因此任何扩展安装都不得写入引擎的 `plugin[]`。外部插件（Claude Code / OpenAI Codex）的正确落点是
> **Bundle + 发布端适配器**。
>
> **已执行的回滚**：
>
> | 层 | 动作 | 落地 |
> | --- | --- | --- |
> | 行为层 | 关掉七条写 `plugin[]` 的加法路径，咽喉改成「加元素一律拒」 | `alpha-code#825`（PR #831） |
> | 合同层 | 摘掉 `opencode-plugin` profile 与两个 host capability，profile 集合回到四个 | PR #833 → `alpha-code@c01130fa` |
> | 跨仓 pin | alpha-web 升 host contract pin 到 `c01130fa` | `alpha-web` PR #141 |
>
> **接替本稿的是什么**：发布端适配器 `alpha-web#96`（OpenAI/Codex）/ `alpha-web#98`（Claude Code），
> 它们把外部包适配成 `AlphaPackageDeclarationV1` + `CompatibilityReport`，编译出来就是多组件信封 = Bundle。
> 动笔前的硬前置是三张地基票：`alpha-code#826`（先补语料再定界）/ `#827`（组件上限）/ `#828`（skill 多文件）。
>
> **`hooks` 不在封死范围内**（owner 补充裁决）：封死的是「引擎进程内、引擎权限、上游加载器」这一种形态；
> hooks 跑在 Alpha 自己起的子进程里，权限由我们定，将来会支持。前置是一次引擎事件面勘破，见 ADR-040。
>
> **本稿保留的唯一用途**：它记录了 2026-08-03 那次相位在 `alpha-code@10daf61b` / `alpha-web@a06e642`
> 上实读出的地面事实（尤其 §3 对旧票断言的逐条证伪，以及引擎存在**第二个插件加载器**
> `ConfigExternalPlugin`、上游 V1 ABI 无 init/无 cancel 这两条）。**只当史料读，不当方案读。**

> **勘破基准**：`alpha-code@10daf61b`（只读 worktree `.worktrees/p4-baseline`，分支 `docs/req128-p4-baseline`）
> / `alpha-web@a06e642`。本稿**所有带 `file:line` 的断言都在这两棵树上实读**，凡未实读的一律写
> 「未验证」，不写成事实。所有检索带 `-a`；每个枚举走两条互相独立的检索轴。
>
> **本稿不采信 `aw#99` / `ac#699` 的票面正文，也不采信 2026-07-30 那份基线**
> （`docs/design/2026-07-30-req128-extension-package-baseline.md`）。§3 逐条列出它们今天不成立的
> 断言。照旧票开工会在**第一天**撞上「profile 注册表 exact-set」与「artifact.test.ts:165 的反向
> 断言」两道硬闸。

---

## 1. 大白话：这一期用户会看到什么

今天扩展中心里有一条「完成通知」（`plugin:opencode-notify`）。它的字节是**随 app 安装包一起发货**
的：`packages/ui-mac/resources/plugins/opencode-notify/`（2 个文件、35,078 字节）。要换一版，得重发
一次整个桌面端。

这一期把**取字节的那条路**换掉：改成**从我们签名的扩展包目录里取**。

- 用户在扩展中心（dev 构建）看到它，点安装；
- 弹出的授权屏上，两行**说人话的披露**：「在引擎进程内运行代码 —— 与引擎同权限执行 JS」（高风险徽章）
  与「写引擎配置条目」。这两行用的是**今天就有**的能力词条 `engine:plugin` / `engine:config`
  （`renderer/extensions/ext-authz.tsx:27-35`、`renderer/i18n/en.ts:353-364`）
  —— 本期**不新造能力词、不新增 i18n**（§4 D2，R1 审计 F1 之后改写）；
- 确认后，**一次事务**把插件装上：字节从签名目录取回 → 校验哈希 → 落进 `~/.alpha/plugins/<名字>@<内容地址>/`
  → 把绝对路径写进引擎配置。中途任何一步失败，盘上与账本都一个字节不留；
- **引擎当场重扫**，插件在下一条消息里就真的被派发到（今天签名扩展包装完**根本不通知引擎**，
  见 §2.8 —— 那是这一期必须补的那条线）；
- 点移除，目录、配置条目、授权账一起消失。

**范围窄到只有一个包、只有一代 ABI、只有 dev 一条 channel。** 只做 `opencode-notify` 这一个，
只对上游 V1 插件文法。但这一个包的**用户路径整条闭合**：
看得见 → 说得清 → 装得上 → 引擎真派发到它 → 卸得掉。

> ⚠️ **本期这个包的产品定位（R1 审计 F2 之后改写）**：`opencode-notify` 在 macOS 上**弹不出任何通知**，
> 而且这不是配置问题、是结构性的 —— 它的两个 macOS 通知器都只找一个我们出于公证风险**不再分发**的
> 原生二进制（`plugin.js:299-313` / `:382-398`），README 与 `resources/NOTICE.txt:43-48` 说的
> 「代码自带 osascript 回退」在代码里**不存在**（全文 `osascript` 只在 `:218` 判前台窗口）。
>
> ⇒ 本期**不把它当一个功能插件交付**。它的定位是 **dev-only 的交付链验证载荷（hook canary）**：
> 它存在的意义只有一个 —— 让我们能观察到「签名包的字节真的落了盘、引擎真的把事件派发进了第三方代码」。
> 由此三条硬约束：
> - **展示文案不得叫「完成通知」，不得承诺任何通知行为**；名字与描述按「交付链验证（开发用）」写。
> - **新的 dev release 里不再出现 legacy 的那条 `plugin:opencode-notify` 条目** —— 全 portfolio
>   无真实用户、无兼容要求，不以「已发布过」为由留着一条对用户说假话的条目（§7.5）。
> - **AC 里不许出现「通知弹出」**。本期的用户可观察产出是「装上了、引擎真的把事件派发给了它」，
>   证据取自插件自己的日志文件（§6 T8）。
>
> **这一条是产品文案面，owner 可推翻。** 若要求本期就交付一个**功能可用**的用户插件，则换候选包：
> §2.11 的全部勘破作废、D7 的「单文件自包含」要对新包重跑、**T7 的 operator capture 与 intake 要重做**。

---

## 2. 只读勘破：今天的真实状态

### 2.1 上游 OpenCode Plugin 的真实 ABI（V1）

- 默认导出的形状检测在 `packages/opencode/src/plugin/shared.ts:283`：
  `if (mode === "detect" && !("id" in value) && !("server" in value) && !("tui" in value)) return`；
  `:294` 拒绝同时导出 `server` 与 `tui`，`:297` 要求 `server()`。
- `server(input, options)` 返回的 `Hooks` 在 `packages/plugin/src/index.ts:222-335`，
  **顶层恰 21 个键**（本轮用脚本按 2 空格缩进逐行抽取）：
  `dispose, event, config, tool, auth, provider, chat.message, chat.params, chat.headers,
  permission.ask, command.execute.before, tool.execute.before, shell.env, tool.execute.after,
  experimental.chat.messages.transform, experimental.chat.system.transform,
  experimental.provider.small_model, experimental.session.compacting,
  experimental.compaction.autocontinue, experimental.text.complete, tool.definition`。
- **有 `dispose`（`packages/plugin/src/index.ts:223`），没有 `init`，也没有 `cancel`。**
  两条独立轴：轴一对 `packages/plugin/src/index.ts` 全文 `grep -ani "\binit\b"` 零命中；
  轴二对 `packages/plugin/src/*.ts` 搜 `cancel`，唯二命中是 `tui.ts:147/158` 的 `onCancel?`
  ——那是 TUI 组件回调，不是插件生命周期。
  ⇒ **「初始化」在真实文法里没有名字**，它就是「调 `server(input, options)` 拿返回值」这一步
  （`packages/opencode/src/plugin/index.ts:116`）。
- **legacy 回退真到得了**：`packages/opencode/src/plugin/index.ts:110-121`，detect 不命中就走
  `getLegacyPlugins`（`:95-108`）。它对 `Object.values(mod)` 逐个取值，**任何一个导出不是函数就
  `throw new TypeError("Plugin export is not a function")`**（`:103`）；
  但它先按 `seen` 去重（`:100`），**同一个函数被导出两次只算一个**。
- **file 源必须导出 `id`**：`shared.ts:306-315`，`source === "file"` 且无 `id` ⇒
  `throw new TypeError('Path plugin ${spec} must export id')`。
  但 `applyPlugin` 只在 **V1 detect 分支**调 `resolvePluginId`（`index.ts:113`），legacy 分支（`:118`）
  **完全跳过它** ⇒ **今天的 vendored 插件是以「无 id 的 legacy 函数」被装载的**。
  ⚠️ **推论（R1 审计 F/D1 更正）**：「裸文件因 file 源无 `id` 必然失败」这句话**不成立** ——
  它只在 detect 命中时成立，而裸文件恰恰不命中 detect。不许拿它当 wrapper 的成立理由（§4 D1）。
- `packages/opencode` 在 north-star 的 `UPSTREAM_PATHS` 内（`scripts/alpha-check.sh:25`，实读：
  `packages/opencode packages/core packages/server packages/tui packages/sdk packages/protocol
  packages/schema packages/client`）⇒ 上游装载器改不得。
  ⚠️ **`packages/plugin` 不在这个列表里** —— ABI 的 SOT 不受守卫覆盖。

### 2.2 第二个外部插件加载器：`ConfigExternalPlugin`（生产在用）

`packages/core/src/config/plugin/external.ts`：

- `:75-77` `path.isAbsolute(ref.package) ? pathToFileURL(...).href : (yield* npm.add(ref.package)).entrypoint`
  ⇒ 绝对路径**不走 npm**，但会 `:80 import(entrypoint)`。
- `:15` `const PluginModule = Schema.Struct({...})` —— 它只认 `{id, effect}` / `{id, setup}`。
- `:81` 解码失败 → `:87` `.pipe(Effect.ignoreCause)` **全静默**：无日志、无事件。

后果（**这一条是本相位最容易被漏掉的**）：**V1 形状进 V2 解码器 100% 注册失败，但 `import()` 已经
执行过一次** —— 插件的模块顶层副作用真发生。对 `opencode-notify` 而言，顶层就是
`log("Module loaded")`（`resources/plugins/opencode-notify/plugin.js:748`），**每次 V2 求值都往
`~/.opencode-notify.log` 追加一行**。

配置怎么到 V2 手上（逐跳实读）：`packages/ui-mac/src/main/alpha-config-injection.ts:402-425`
`materializeV2EngineConfig`：`:406 fs.copyFileSync(alphaJsoncPath(), <userData>/alpha-engine-config/opencode.json)`
+ `:424 process.env.OPENCODE_CONFIG_DIR = dir`；`packages/opencode/src/config/paths.ts:39`
把 `Flag.OPENCODE_CONFIG_DIR` 加进 `directories`；V1 的 `plugin` 键经
`packages/core/src/v1/config/migrate.ts:66-68` 迁成 V2 的 `plugins`。

> ⚠️ **订正一条转述**：常见说法是「`materializeV2EngineConfig` 已经在剥 `apiKey`，剥 `plugin` 是
> 同一处同一姿势」。**实读不是。** `:406` 的 `copyFileSync` 是**逐字节裸拷**，不剥任何东西；
> 剥 `apiKey` 发生在 `:411-418` 合成的**另一个文件** `opencode.jsonc` 上。两个文件都会被
> `ConfigPaths.fileInDirectory`（`packages/opencode/src/config/paths.ts:43`）读到并合并。
> ⇒ 要让 V2 **看不见** `plugin[]`，必须把 `:406` 那一行从「拷贝」改成「读 → 剥键 → 写」。
> ⚠️ **这是事实，不是本相位的决定** —— 本相位**不这么做**：那会把用户自己配的所有合法 V2 插件
> 一起关掉（`:406` 拷的是整份用户 `alpha.jsonc`）。V2 那条腿改由 **wrapper 顶层无副作用**
> 结构性关闭，见 §4 D4。

`@alpha-code/ext` 走的是 `OPENCODE_CONFIG_CONTENT` env 通道（`alpha-config-injection.ts:93-97`），
V2 一概不读 ⇒ **只有 `alpha.jsonc` 里的用户安装物会被两个加载器各看一遍**。

### 2.3 三条运行时 npm 通道（不是一条）

| # | 位置 | 触发条件 | 对 managed 路径 |
| --- | --- | --- | --- |
| ① | `packages/opencode/src/plugin/shared.ts:211` `Npm.add(pkg)` | V1 加载器拿到**非路径** spec | 结构性不可达（见下） |
| ② | `packages/core/src/config/plugin/external.ts:77` `npm.add(ref.package)` | V2 加载器拿到**非绝对路径** spec | 结构性不可达（同上） |
| ③ | `packages/opencode/src/config/config.ts:424-457` `npm.install(dir, {add:[@opencode-ai/plugin@…]})` | **for 循环内、无任何条件**，对每个 config 目录（含 `<userData>/alpha-engine-config`）各跑一次 | **与有没有插件无关，恒发生** |

「结构性不可达」的判据实读：`packages/ui-mac/src/main/ext-config.ts:1195-1197`
`persistPluginPath` 拒绝任何非绝对 / 非 `.js` / 不在 `<alphaGlobalRoot>/plugins/` 下的路径。
⇒ managed 插件写进 `plugin[]` 的一定是绝对路径，①②的谓词都不成立。

> **判据纪律**：写「managed 路径不下载」的断言时，**不许写成「没调用 `Npm.add`」** —— 那会被②绕过，
> 也会被③变成假绿（③一直在发生）。见 §5 第 3 类。

### 2.4 宿主 profile 注册表：恰四个 + 三道 exact-set + 一条反向断言

- `packages/ui-mac/src/shared/host-extension-package-contract/registry.ts:3`
  `export type PackageProfileIdV1 = "skill" | "agent" | "mcp-local" | "mcp-remote"`
- 同文件 `:77` `throw new Error("profile registry must contain the sorted host profile set exactly once")`
  —— 比对字面量数组 `["agent@1","mcp-local@1","mcp-remote@1","skill@1"]`。
- `:83` capability exact-set，字面量 `["alpha.connection.v1","alpha.mcp-oauth.v1","alpha.secret-prerequisite.v1"]`。
- `:87-90` limits exact-set，键数组在 `:46-57`（10 条，排序）。
- **反向断言**：`host-extension-package-artifact.test.ts:165-166`
  `expect(JSON.stringify(PROFILE_REGISTRY_V1)).not.toContain("opencode-plugin")` / `.not.toContain("bundle")`。
- 合同文本 `CONTRACT.md:181-184`：「This artifact contains no … or managed OpenCode Plugin profile.」
- 实读 registry JSON：profiles = `['agent','mcp-local','mcp-remote','skill']`；
  capabilities = `['alpha.connection.v1','alpha.mcp-oauth.v1','alpha.secret-prerequisite.v1']`；
  limits 10 条，`maxMarkdownAssetBytes=5242880`、`maxPayloadBytes=1048576`、`maxComponents=16`。
- artifact 聚合：`host-extension-package-artifact.v1.json` 12 个文件，
  `artifactSha256 = 8a191b3375876c2016c725dfb6cb1f8348ef2001abdac8cc9f4e0f20db1695d1`。
- **artifact 闸怎么跑**：仓内没有任何 CI yml 调 `generate-artifact.ts --check`；唯一接线是
  `host-extension-package-artifact.test.ts:229` 用 `Bun.spawn` 起它，随 `bun test src` 跑。
  本轮实跑 `bun generate-artifact.ts --check` → `checked 12 HostExtensionPackageV1 files`，exit 0。

⇒ **`opencode-plugin` 这个 profile 今天在宿主合同里不存在，而且有三道闸主动挡住它。**
且宿主合同的**唯一权威在 alpha-code**：alpha-web 只 vendored 一份副本并按 sha 钉死（§2.5）。

**本轮补查的两条（R1 审计 F1 / F15 的地基，各自实读）**：

- **host capability token 没有任何命名约束。** `registry.ts:68` `isPackageCapabilityV1` 的判定
  只有一条：`CAPABILITY_REGISTRY_V1.some((c) => c.token === token)` —— **membership，不是前缀**。
  ⇒ 把**已经存在于 renderer 词表**的 `engine:config` / `engine:plugin` 直接登记进 host registry
  在结构上成立，不需要为它们造 `alpha.*` 的新名字（§4 D2）。
- **「未登记的 profile 到不到得了下游」的咽喉是 `decoder.ts:406`**，不是 payload 解码器。
  `supportComponent()`（`:399`）第一件事就是 `findPackageProfileV1(component.profileId, component.profileVersion)`，
  取不到 ⇒ `:407-412` 具名拒绝 `component-profile-unsupported`。
  两条独立轴：轴一按符号 `findPackageProfileV1` 全仓搜，生产命中只有定义（`registry.ts:59`）与
  `decoder.ts:406` 两处；轴二按 reasonCode 字符串 `component-profile-unsupported` 搜，
  生产命中是 `decoder.ts:127`（枚举）、`:410`（唯一抛出点）、`ext-package-presentation.ts:46`（呈现）。
  ⚠️ 而 `decodePackageProfilePayloadV1`（`decoder.ts:244`）的 profileId 形参**是那个字面量联合类型**，
  `:265-272` 的分派是三元兜底 → `decodeMcpRemotePayload`，**不是具名拒绝** ——
  它靠类型和上游的 `:406` 保证，自己不是闸。写「未知 profile 会被拒」的判据时对准 `:406`。

### 2.5 发布端（alpha-web@a06e642）今天认什么

- **kind 白名单两处，同 code 同文案**：`scripts/lib/extension-package-core.mjs:625-630`
  （`if (component.kind !== "mcp") fail("E_PROFILE_UNSUPPORTED", …, "only skill, agent, and mcp components are supported")`）
  与 `:729-734`（`if (!["skill","agent","mcp"].includes(component.kind)) fail(…)`）。
- `HOST_CONTRACT_PIN`（`:46-53`）：`repo jinjunnn/alpha-code`、`commit 74af30d1b995c14ede4fa1cfc2a9cca4c39dd4b3`、
  `artifactSha256 8a191b33…95d1`。`HOST_CONTRACT_LIVE_REF = "origin/alpha"`（`:56`）。
- **closure exact-set**：`:2157-2172` 比 `["agent","mcp-local","mcp-remote","skill"]` 与三个
  `HOST_CAPABILITY_*`，不等即 `E_HOST_SEMANTIC_PIN`。
- **live 漂移闸**：`verifyLiveHostArtifactAtRepo()`（`:2268-2303`）拿 `origin/alpha` 上的宿主 manifest
  比 pin，不等报 `E_HOST_ARTIFACT_DRIFT`。CI 为此专门 checkout 两份
  （`.github/workflows/channels-ci.yml:44-49` 钉 commit、`:55-60` 取 `ref: alpha`）。
  runbook `docs/runbooks/desktop-extension-package-artifact-bump.md:33-35` 明写 never waived。
  ⇒ **alpha-code 的合同一合并进 `alpha`，alpha-web 主线 CI 立刻红**，这是设计如此。
- `contracts/extension-package/artifact/generic-rules.v1.json` 的 `excluded` 实读 =
  `['cloud','legacy-projection','managed-plugin','nested-bundle','provider-adapter','publish-wrapper']`。
- `alpha-package-declaration-v1.schema.json:380` `"const": "alpha-native"`（`source.kind` 单值），
  编译器另有 `E_SOURCE_UNSUPPORTED`（`extension-package-core.mjs:806`）。
  ⚠️ **该字段是构建期作者元数据，不进签名信封、不到桌面端**，alpha-code 生产码零引用
  ⇒ **它不阻塞本相位**（这一条订正了旧票的一个共识）。
- catalog 实况：`public/catalog/v1/catalog.json` 顶层键 `['version','_note','_disclaimers','entries']`
  —— **没有 `packages` 键**；version `2026-07-18.2`；entries 26 条。`catalog-src/` 下只有
  `assets / catalog.json / curation / intake` —— **`packages/` 目录不存在**。

### 2.6 载荷传输今天有什么

- **资产 mediaType 是单点常量**：`decoder.ts:58` `mediaType: "text/markdown"`（`MarkdownAssetRefV1` 的
  字面量类型）；`:722` 解码时按同一常量校验；`profiles/{skill,agent}.v1.schema.json` 里是 `const`。
- **单资产帽 5 MiB**：`registry.v1.json` 的 `maxMarkdownAssetBytes = 5242880`；宿主双查
  `package-admission.ts:1048`（下载前按 `ref.bytes`）与 `:1053`（下载后按 `byteLength`）。
- **payload 帽 1 MiB**，且那条路**有** timeout 与终态复查：`package-installability.ts:37`
  `PAYLOAD_TIMEOUT_MS = 8000`、`:539` `controller.abort()`、`:543` `redirect:"error"`、`:536/:552` 双查。
- ⚠️ **不对称**：`fetchPackageAsset`（`package-admission.ts:1047-1056`）**没有 timeout**，只有
  `redirect:"error"` 与双查 bytes。这是 Phase 4 顺手要补的。
- 多文件下载器 `downloadRemoteAsset` 只接在 legacy planner 上，**没接进 package 路径**（未复核行号，
  沿用勘破结论，标「未验证」）。

### 2.7 CAS 只是搬运管道，不是持久存储

- GC 的 mark 根恰四类（`packages/ui-mac/src/main/ext-cas-gc.ts:310 markJournals` /
  `:312 markGenerations` / `:315 markSeedLock` / `:320-323` pins）。宽限窗
  `CAS_GC_GRACE_MS_DEFAULT = 6 * 60 * 60_000`（`:34`），按 blob mtime 计。
- **journal 只记 generation item 的 `files[]`**：`ext-transaction.ts:1186` `files: item.files ?? []`；
  file action item 的字段在 `:1197-1206`（`relTarget / slot / preDigest / nextDigest / preAbsent / requireAbsent`），
  **一个 digest 都不贡献**。
- ⇒ **字节只存在于 CAS 且靠 file action 落地的载荷，6 小时后必被 sweep。**
- `pinCasBlob` / `unpinCasBlob`（`ext-cas.ts:239` / `:250`）**生产调用点为零**。
  两条独立轴：轴一按符号名全仓 `grep -ran`，命中只有定义 + `ext-cas.test.ts` / `ext-cas-gc.test.ts`；
  轴二按账本文件名 `pins.json` / `readCasPins`，读点只有 `ext-cas-gc.ts:320`。
  ⇒ 三态判定：**存在，但没接进生产。**
- 签名 package 路径**今天根本不进 CAS**：资产由 `package-admission.ts` 拉进内存 → 校验 → 直写
  （skill 走 generation staging，agent 走 file action）。
- ⚠️ **本相位不接 pin，保持零调用**（§4 D5 已删除）：GC 的删除面**只有 CAS blob**
  （`ext-cas-gc.ts:11-13`），**不碰已经物化到 `~/.alpha/plugins/` 的运行副本**
  ⇒ 载荷 blob 被回收不影响装好的插件；CAS 本来就被定义成「失败后交 GC grace 的缓存」
  （`ext-install-planner.ts:697-701`）。这一节列出的事实**不构成「必须 pin」的理由**。

### 2.8 引擎重扫在签名 package 路径上是断的

- `refreshEngine()` 定义在 `renderer/extensions/use-extensions.ts:677`，实现是
  `client.global.dispose()` + 5s 超时 + `connectOutcome` 判据。
- **签名 package 的三个安装入口一个都不调它**：
  `extension-hub.tsx:659 runPackageAction`、`:1094 installBundle`、`:1219 confirmPackageAuthz`。
  同文件唯一调 `ext.refreshEngine()` 的是 `:788`（agent 导入确认）。
- main 侧唯一补偿只对 MCP：`main/ext-ipc.ts:1068-1081` —— legacy 分支非 enabled MCP 直接返回；
  package 图分支只对 `activateMcp` 逐个 `reloadInstalledMcp`，`activateMcp.length === 0` 直接返回。
- ⇒ **一个只带 skill/agent（或将来带 plugin）的签名 package，装完之后引擎从头到尾没被通知过。**
  这不是 Phase 4 新增的洞，是 Phase 1/2 交付里就存在的，而 plugin **只在引擎实例构造时装载**
  （`packages/opencode/src/plugin/index.ts:130` 的 `InstanceState.make`），所以它对 plugin 是**致命**的。
- Phase 3 `#784` 在本地导入那条线上已经修过同一个洞（G20），修法形状见
  `use-extensions.ts:832-875`：把 IPC 收进这一层、`refreshEngine()` 在这一层**接一次**、
  失败如实降级成 `reload-pending`。

### 2.9 授权披露今天长什么样

- renderer 词表 `CAP_VOCAB`（`renderer/extensions/ext-authz.tsx:27-34`）**恰 6 个键**，
  全是引擎能力语义：`prompt:context / engine:config / engine:plugin / process:spawn /
  network:remote / cloud:dispatch`；`:35` `HIGH_RISK = new Set(["engine:plugin","process:spawn"])`。
  文案在 `renderer/i18n/en.ts:353-364`（`enginePlugin` = “Run code inside the engine process”，
  desc = “Executes JS with the engine's permissions”）与 `zh.ts:352-363`。
- 两条独立轴确认**没有任何 `alpha.` 前缀的键**：轴一 `grep -an "alpha\." ext-authz.tsx` 的命中全是
  i18n key（`alpha.ext.cap.*` / `alpha.ext.authz.*`），零 host token；轴二 `grep -an "alpha.ext.cap\." en.ts`
  只有那 6 组。
- ⇒ 签名 package 携带的 host token（`alpha.secret-prerequisite.v1` 等）走 fallback：图标渲染成
  `?`、粗体名是原始 token、描述行整块不渲染、不打高风险徽章，而 `alpha-ext-authz-id` 再渲染一次原串
  ⇒ **同一串标识符在同一行出现两次**。文件头注释说明这是设计内的前向兼容降级，不是 bug ——
  但意味着**今天所有装 package 的用户在授权屏上读到的都是裸 token**。
- **legacy 目录条目那条路早就在诚实披露同一件事**（本轮补查，F1 的地基）：
  `shared/ext-capability-authorization.ts:9-16` 的 `MANIFEST_CAPABILITIES` 恰 6 个，与 `CAP_VOCAB`
  的 6 个键**逐字相同**；`:30` `if (entry.type === "plugin") return ["engine:plugin", "engine:config"]`
  —— **legacy 插件安装路径今天就同时申请这两个 token**。
  ⇒ 如果 managed 路径只披露「在引擎进程内执行 JS」而不披露「写引擎配置条目」，
  它就**比今天的 legacy 路径披露得更少**，而两者对用户做的是同一件事（都会改写 `alpha.jsonc`
  的 `plugin[]`，`main/ext-config.ts:1190` `persistPluginPath`）。这是 §4 D2 改写的直接理由。
- ⚠️ **本相位不修的那半边**：三个 `alpha.*` host token（`alpha.connection.v1` /
  `alpha.mcp-oauth.v1` / `alpha.secret-prerequisite.v1`）在 `CAP_VOCAB` 里**今天没有词条**，
  仍然渲染成 `?` + 裸串两遍。**这是 Phase 1/2 就存在的缺口，本相位不拥有它**（§7.13）——
  managed plugin 携带的两个 token 都在词表里，本相位的用户路径不经过那三个。

### 2.10 宿主侧按 profile 分叉的全部位置（含兜底式 ternary）

| 位置 | 原文 / 行为 | 性质 |
| --- | --- | --- |
| `main/package-admission.ts:506` | `const kind = component.profileId === "skill" ? "skill" : component.profileId === "agent" ? "agent" : "mcp"` | **兜底 → mcp**，最危险的一处 |
| `main/package-admission.ts:672-681` | builder 三元分派，else → `buildMcpTxItems` | 承接上一处的错误分类 |
| `main/ext-package-lifecycle.ts:35-37` | `packageChildTxKeyV1(kind: "skill"\|"agent"\|"mcp", name)`，else → `` `mcp--${name}` `` | 形参已窄，但调用点用 `as` 强转打穿 |
| `main/ext-package-tx-builders.ts:222-244` | 按 `payload.schema` 分 local/remote，两条都不匹配 ⇒ `config === undefined` ⇒ `:244 {ok:false, reason:"profile cannot build an MCP transaction"}` | **fail-closed，但报错误导** |
| `main/ext-package-uninstall.ts:100/117/126` + `:143-145` | skill/agent/mcp 三臂，其余 `` `no artifact removal seam for package child kind "${child.kind}" — refusing (fail closed)` `` | **fail-closed** |
| `shared/package-secret-prerequisite.ts:101/122/162-170` | 按 payload.schema 收密钥前置，**else 静默返回 `items: []`** | **fail-open** |
| `shared/package-alpha-connection.ts:213-218` | 非 mcp-remote 直接返回空 items | **fail-open** |
| `shared/package-admission.ts:88` | wire 类型 `kind: "skill" \| "agent" \| "mcp"` | IPC 契约面 |
| `preload/types.ts:220` | `InstallReceiptType = "mcp"\|"skill"\|"agent"\|"command"\|"plugin"\|"bundle"\|"cloud"` | **账本侧已有 `plugin`**，包侧还没有 |

⇒ 一条竖线：`:506`（kind）→ `:509`（key）→ `:673`（builder）→ 事务 → 账本 →
`removePackageChildArtifactsV1`（卸载）。**任何一跳漏改 = 装得上卸不掉 / grants 残留。**

**一条今天就在替我们兜底的闸**（实读，可以直接用作判据）：
`main/ext-health-probe-router.ts:40-41` —— file item 的 key 若不匹配
`/^plugin--(.+)--f\d+$/`（`:28-32`，且 name 不含 `--`），pre-switch probe 直接
`{healthy:false, reason: 'no typed probe for file item "…" — refusing (fail closed)'}`。
⇒ plugin 的 file item **必须**叫 `plugin--<name>--f<i>`，否则整次安装响亮失败。

### 2.11 第一个候选包 `opencode-notify` 的实况

- 位置 `packages/ui-mac/resources/plugins/opencode-notify/`，**只有两个文件**
  （`git ls-files` 与 `find` 两条轴一致）：`plugin.js` 34,093 B
  `sha256 22f80c93d8d87f6d29442e33740637608086358916e7111fbf630433de6e43a7`；
  `README.md` 985 B `sha256 c11f874d356c224b7ceeff46dd4a30c6a156cc0e010387082b628d8b743bd8b0`。
  **没有 package.json。**
- **默认导出是 legacy 裸函数**：`plugin.js:1071-1075` `var src_default = opencodeNotifyPlugin; export { opencodeNotifyPlugin, src_default as default }`；
  工厂本体 `:749` `async ({ client }) => { … return { "permission.ask": …, event: … } }`。
  ⚠️ **两个导出是同一个函数值** ⇒ 走 legacy 分支时会被 `getLegacyPlugins` 的 `seen`
  去重（`packages/opencode/src/plugin/index.ts:100`），**只注册一次、不会 throw**。
  ⇒ 「直接把 `plugin[]` 指向这个裸文件会硬崩」这句话**对这个包不成立**（§4 D1 已据此改写）。
- **自包含**：bundle 的模块横幅 9 条全部是 `src/*.ts`（`:20/:25/:87/:291/:370/:481/:576/:652/:741`），
  **零 `node_modules/` 内联**。唯一非内置 specifier 是 `powertoast`（`:584`），
  被 `:580 if (process.platform !== "win32") return false` 挡在前面、且包在 try/catch 里降级
  ⇒ **darwin/linux 依赖闭包为空集**。
  ⚠️ 这一条只有第二条轴抓得到：行首 `grep -anE "^import |require\(|from \""` 会漏掉写在
  `await import("powertoast")` 里、行首有缩进的那一处。
- **顶层就写盘**：`:741-748` `LOG_FILE = ~/.opencode-notify.log`，`:748 log("Module loaded")`。
  ⇒ 任何「校验时试着 import 一下」的设计会污染用户 home。本轮**没有执行它**，全部结论为静态分析。
- ⚠️ **macOS 上的通知后端结构性缺失**：两个 macOS 通知器（`:299-313` 与 `:382-398`）都只找
  `OpenCodeNotifier.app/Contents/MacOS/opencode-notifier` 的三个候选路径，
  而我们**从不往那三处放任何东西**。全文 `osascript` 只出现一次（`:218`），在
  `isMacOSAppFocused()` 里判断终端是否前台，**不是发通知**。
  ⇒ dispatcher 落到 `:693 console.warn("No notification backend available for platform: darwin")`，
  工厂打一行 `:758 log("No notification backend available for this platform.")` 后**照常注册 hooks**，
  每次 `notify()` 早退成 `{action:"dismissed", activated:false}`。
  README/`NOTICE.txt` 里「代码自带 osascript 回退，通知功能保留」这句话**与代码不符**。
- ✅ **但它给了我们一条真实的派发证据**：hooks 内部逐条写日志 ——
  `:760 log("Initialised")`（证明 `server()` 被调用）、`:763 log("HOOK CALLED: permission.ask")`、
  `:804 log(\`EVENT RECEIVED: ${event.type}\`)`。
  ⇒ **「引擎真的把事件派发给了这个插件」可以用 `~/.opencode-notify.log` 里出现 `EVENT RECEIVED:` 证明**，
  不依赖坏掉的通知后端。这是 §6 T8 的证据基础。
  ⚠️ **但这个观测手段自己有两个盲区（R1 审计 F9，措辞必须钉死）**：
  ①`LOG_FILE` 是 `join(homedir(), ".opencode-notify.log")` 的**固定路径且从不轮换**
  （`plugin.js:742`）⇒ **上一轮跑剩的旧行会直接过闸**；
  ②这条日志证明的是「**某一份** `opencode-notify` 的字节被派发到了」，**不证明是 managed 的那一份** ——
  一个把配置写成裸包名 `opencode-notify@0.3.1` 的错误实现会让 V1（`plugin/shared.ts:207-212`）
  走 npm 下载**同一个插件**，日志一模一样。
  ⇒ T8 必须**先记 byte offset、只采 offset 之后新增的行**，并**独立地**断言配置面（§5 第 3 类）。
- catalog 条目（`alpha-web/catalog-src/catalog.json:567-590`，与已发布副本逐字相同）：
  `entry.version = "1.0.0"`，而 `installSpec.version = "0.3.1"`。落账本、走 downgrade 闸的是
  **前者**（`ext-install-planner.ts:3711` `version: manifest.version`）。
  ⇒ **账本记的版本号与上游真实版本对不上**，这是既存事实。
- 上游 tarball integrity：**全仓零留痕**（查过 `bun.lock`（`opencode-notify` 零命中）、`docs/`、
  `integrity|shasum|tarball` 关键词）。版本号只有散文（README、`resources/NOTICE.txt:43-48`）。
- 本机现状：`~/.alpha/plugins` 不存在，`~/.alpha/alpha.jsonc` 里无任何含 `plugin` 的行
  ⇒ 这台机器上没装过它。「生产在用」指**通道接线完整且被 catalog 供给**，不是此刻有活的安装实例。

### 2.12 现行 vendored 安装通道与 channel

- 分流点 `ext-install-planner.ts:2113` `if (spec.vendoredAssetKey)` ⇒ 走 vendored 分支，**永不走 npm**；
  `:2142` 才是 npm 分支（`spec.package && !spec.vendoredAssetKey`）。
- 载体 `installPluginFromCas`（`:3560`）：`:3597` **要求 `promotedSpecs` 含一个顶层 `plugin.js`**
  （否则 `"seed plugin payload must include a top-level plugin.js entrypoint — refused"`）；
  `:3601 dirName = seedPluginDirName(name, payloadDigest)`（`:2809-2812`，`<name>@<digest 前16 hex>`）；
  `:3603 jsPath = <dir>/plugin.js`；`:3700 nextArray = [...snapshot.value, jsPath]`；
  `:3719 configKey = plugin-path:<jsPath>`；`:3708 origin: "catalog"`。
- item 构造在 `seedPluginPayloadItems`（`:2826-2855`）：内容寻址相对路径、`isSafeRelPath` 前置、
  `portablePathKey` 大小写/Unicode 折叠碰撞拒、`readCasBlobVerified` 逐文件复验、
  `requireAbsent`、key = `` `plugin--${name}--f${i}` ``。
- ⚠️ **`installPluginFromCas` 是 legacy `CatalogEntry` 形态的单装载体，自己开一次事务**
  ⇒ **签名 package 路径不能直接调它**（package 路径要求整张安装图进**一次**事务，`#697` 门二）。
  能复用的是 `seedPluginPayloadItems` 的 item 构造与 `seedPluginFileProbe`。
- **channel 是按构建环境派生的**：`main/alpha-environment.ts:34-46`
  `resolveAppEnvironment({isPackaged, channel})`（未打包一律 `dev`；打包时 `prod→prod`、`beta→beta`、
  **其余 → `dev`**）→ `registryChannelFor`（`prod→stable`、`beta→preview`、`dev→dev`）。
  ⇒ **一个用 dev BuildChannel 打包出来的 mac 应用读的就是 `dev` channel** ——
  真机 L2 证据可以完全不碰 stable。

---

## 3. 已作废的旧断言

> 「影响」列的取值：**作废该 AC** / **重画边界** / **仅备注**。

| # | 原文断言（出处） | 今天的实况 | 影响 |
| --- | --- | --- | --- |
| 1 | 「输出接……`#95` host profile」（`aw#99` Boundary 3） | profile 注册表恰四个（`registry.ts:3`），`:77` exact-set + `artifact.test.ts:165` 反向断言 + `CONTRACT.md:181-184` 明文排除 | **重画边界**：不是「接一个已有 profile」，是「宿主合同新增第五个」 |
| 2 | 「把 profile/rules/input/output vectors 交 `alpha-web#97`」（`aw#99` dev-plan 5） | `#97` 已 CLOSED（2026-07-30，随 `#95` 的 PR#100 一并关，owner 主动砍范围） | **作废该 AC**：收货方不存在 |
| 3 | `aw#99` 的 Boundary 只列 4 个新文件（`scripts/lib/managed-plugin-artifact.mjs` 等） | 真正要改的是**既有** `extension-package-core.mjs` 五处 + 已发布的 `contracts/extension-package/artifact/**` | **重画边界** |
| 4 | AC「断言构建期间网络与 script/bin 调用数为零」（`aw#99` AC1） | producer 结构上不联网（`extension-package-core.mjs` / `gen-…mjs` 零 `fetch`/`node:http*`/`node:net`）⇒ 该断言在 builder 被整个删掉时同样成立 | **作废该 AC**：恒真式。换成 §5 第 1 类里那条可测的 |
| 5 | 「npm 是发布端来源事实，不是 Desktop runtime 安装通道」当成**待建立**的性质（`aw#99` Covers） | 「plugin 零网络」今天只是 catalog 数据的偶然状态，不被任何闸门保证；runtime npm 通道结构上敞开（三条，§2.3） | **重画边界**：价值主张改成「把 app-bundle vendoring 换成 catalog 内容寻址分发 + 把那条性质立成闸」 |
| 6 | 「起同版本 packaged engine probe 子进程」（`ac#699` dev-plan 3） | 仓内零先例（`utilityProcess.fork` 全仓仅 `server.ts:265`；`new Worker` 仅 `ext-cas-gc-scheduler.ts:103`）；`sidecar.ts` 顶层 `getParentPort()`、start 必 `Server.listen`；打包体 `electron-builder.config.ts:139-142` 关掉 `runAsNode` fuse | **作废该形态**。⚠️ 本稿上一版拿 `child_process.fork` 顶替它，**同样不可达**（打包产物里没有 Node 可执行文件，`runAsNode: false`）—— R1 审计 F4 之后**整个运行时探针一并删除**，见 §4 D3 |
| 7 | 验收 gate「ABI corpus：…invalid dispose/cancel…」（`ac#699` AC1） | 上游 `Hooks` 21 键有 `dispose`（`packages/plugin/src/index.ts:223`）、**无 `init`、无 `cancel`**（两轴零命中） | **作废该 AC 维度**：给不存在的成员造反例 = 恒绿断言 |
| 8 | 「Catalog-managed 路径绝不进入 runtime `Npm.add`」+ gate「断言不调用 `Npm.add`」（`ac#699` Outcome / AC3） | 三条 npm 通道；只堵①会被②绕过、被③变成假绿 | **作废该 AC 措辞**，见 §5 第 3 类 |
| 9 | 「pin `#97`/`#99` 的 managed Plugin profile/corpus」（`ac#699` dev-plan 1） | host profile 的唯一权威在 alpha-code 自己（`packages/ui-mac/src/shared/host-extension-package-contract/`），alpha-web 只 vendored 副本 | **重画边界**：归属反了，见 §4 D2 |
| 10 | 「managed loader 禁止 legacy arbitrary function export fallback」（`ac#699` dev-plan 2） | fallback 在 `packages/opencode/src/plugin/index.ts:118`，属 `UPSTREAM_PATHS`（`alpha-check.sh:25`），改不得 | **重画边界**：改成「alpha 生成的 wrapper 让 `applyPlugin` 的 detect 在 `:111` 命中即 return」，见 §4 D1 |
| 11 | 「materialize 到现有 CAS」（`ac#699` dev-plan 2） | ①package 路径今天**不进 CAS**（内存直写）；②file action 不贡献任何 journal digest（`ext-transaction.ts:1186`）⇒ 6h 后被 sweep；③`pinCasBlob` 生产零调用 | **仅备注**。⚠️ 本稿上一版据此设计了 CAS pin/unpin（旧 D5）；R1 审计 F6 之后**全部删除** —— GC 的删除面只有 CAS blob（`ext-cas-gc.ts:11-13`），**不碰已物化到 `plugins/` 的运行副本**，插件装好后照常工作；CAS 本来就被定义成「失败后交 GC grace 的缓存」（`ext-install-planner.ts:697-701`）。见 §4 D5（已删除） |
| 12 | 「同包 npm/vendored/local/legacy 双载拒绝」是待建的四路闸（`ac#699` dev-plan 5） | 三路已在生产（`findPluginBaseConflictStrict` / `findSameNamePluginPathEntry` / `legacySameNamePluginGate`，且锁内 precondition 重跑）；真正无闸的是 V2 加载器与上游目录自动发现 | **重画边界**，见 §5 第 4 类 |
| 13 | 「UI/授权始终披露『同权限 engine-process code』」读作既有能力（`ac#699` dev-plan 6） | 签名 package 的授权屏对 host `alpha.*` token 渲染成 `?` + 裸串两遍；`CAP_VOCAB` 六键无 `alpha.` 前缀；但 `engine:plugin` / `engine:config` **两个词条与高风险徽章今天就有**（`ext-authz.tsx:27-35`），legacy 插件路径已同时申请这两个（`ext-capability-authorization.ts:30`） | **重画边界**：**不新造 token**，把这两个既有 token 登记进 host capability registry 并由 producer derive，走一遍 pin 三跳；renderer 零词条工作（R1 审计 F1） |
| 14 | `ac#699` Dependencies「Blocked by `alpha-web#97`、`alpha-web#99`」 | `#97` 已 CLOSED 且那一步未交付；`#99` 的边界本身作废（第 1/2/3 行） | **重画边界** |
| 15 | 基线 §2.8「四个共用 builder，含 `buildVendoredPluginTxItems`」 | `ext-package-tx-builders.ts` 只导出 `buildDepartingChildConfigItemsV1:94` / `buildSkillTxItems:133` / `buildAgentTxItems:164` / `buildMcpTxItems:213`；`buildVendoredPluginTxItems` **全仓不存在** | **仅备注**（本相位要新建它） |
| 16 | 基线 §2.9「唯一提交对象含 `packageRecord: PackageRecordV1`」 | 已被 `#764` 明确删除 | **仅备注** |
| 17 | 基线 §5「mixed Bundle activation `#697` 排在 `#699` 之后」 | `#697` / `#698` 都已在**没有 managed Plugin 的前提下**合并（2026-08-01/02） | **仅备注**：这条依赖边已死，`#699` 现在是纯增量 |
| 18 | 基线 §1.3「Plugin 获得 client、workspace registration 与 `Bun.$`」 | 打包桌面版里 `$` 恒 `undefined`（内嵌 server 由 `target:'node'` 产出，跑在 Electron utilityProcess） | **仅备注**：安全结论不变，但别把 `Bun.$` 当 PluginInput 字段构造 |
| 19 | 基线 §1.3「runtime 只用可选 `engines.opencode` 做有限检查」 | 该闸被 `packages/opencode/src/plugin/loader.ts:125` 的 `if (base.source === "npm")` 守着，file 源**永不求值** | **仅备注**：对 managed 路径不成立（打包引擎自报 1.17.13 这件事因此**与本相位无因果**） |
| 20 | 基线 §1.3 把插件装载写成**单一**路径（`shared.ts` + `Npm.add`） | 同进程还挂着 `ConfigExternalPlugin`（§2.2），基线全文零字提及 | **重画边界**，见 §4 D4 |
| 21 | `aw#49` Evidence map「AC8 \| `#700`」 | `ac#700` 已 CLOSED 且票面明写不含 managed Plugin，并把 packaged RC 推给 `aw#108`；而 `aw#108` 的 Out of scope 逐字排除 managed Plugin | **作废该 Evidence 行**：两边互指，AC8 在 Phase 4 面上双向落空，由 §6 T8 接管 |
| 22 | 相位表「Phase 4 = `aw#99` + `ac#699`（编排口径 +`aw#108`）」 | 七个跳无票主（§6 开头逐条） | **重画边界**：本稿重列 8 张 |

---

## 4. 选定方案与被否决的替代

> 以下是**编排者已裁决**的，写成决定，不重新论证。每条给出被否决的替代与否决理由。
> **编号保持 D1–D8 不动**（跨节引用多）；R1 审计之后 **D5 整条删除**，槽位保留并写明为什么删。

### D1 — 窄而闭合的竖线（只做一个包、只做 V1 ABI、用户路径整条闭合）

**决定**：只把 `opencode-notify` 一个包变成 Catalog 托管的 `opencode-plugin` profile 组件；只对上游
V1 文法。但用户路径**逐跳闭合**：Hub 里看得见 → 授权屏说清「与引擎同权限执行代码」→ 一次事务装上 →
**引擎真的重扫并派发到它的 hook** → 卸得掉。

**实现形态（钉死，防实现方发挥）**：
1. catalog 只传**一个** JS 资产 = 第三方那个 `plugin.js` 的字节（§2.11：34,093 B，零依赖闭包）。
2. **wrapper 由宿主生成，不由 catalog 传**。落盘两个文件：
   - `plugin.js` = alpha 生成的 strict V1 wrapper（内容由组件 id 确定性派生），
     默认导出 `{ id, server }`；
   - `upstream.js` = 第三方字节，**逐字节不改**。
3. `plugin[]` 里写 wrapper 的绝对路径（`installPluginFromCas` 的载体本来就要求顶层 `plugin.js`，
   `ext-install-planner.ts:3597`）。
4. **wrapper 顶层不 import 上游**（R1 审计 F5）：`import("./upstream.js")` 写在 `server()` **函数体内**，
   顶层只有一个 `id` 常量和一个函数声明。⇒ 一个只 `import()` 模块、不调 `server()` 的求值方
   （V2 加载器就是）**拿到一个零副作用的模块**。这一条同时是 D4 的全部机制。

**为什么要 wrapper —— 身份 / ABI 归一化**（R1 审计之后改写）：

- **归一化 ABI 分支**：`applyPlugin`（`packages/opencode/src/plugin/index.ts:110-117`）先跑 detect，
  wrapper 命中即 `:115 return`，**legacy 分支结构性不可达**。裸文件走的是 legacy 分支
  —— 那条分支的语义是「把模块的每个导出值都当插件工厂」，**取决于第三方怎么写它的导出表**，
  下一版第三方多导出一个常量就变行为。managed 路径不该把装载语义外包给第三方的导出表。
  这就是 `ac#699` 第 2 条真正能实现的形态，**零改上游**。
- **归一化身份**：detect 分支会调 `resolvePluginId`（`:113`），wrapper 由我们给出确定性的 `id`
  （由组件 id 派生）；legacy 分支跳过 `resolvePluginId`（`:118`）⇒ **裸文件装进来是无 id 的**，
  账本 / 去重 / 日志里都没有一个我们说了算的身份。
- **它让「managed」与「未策展导入」在装载语义上真的不同**：今天 vendored 那条路就是裸文件 + legacy，
  managed 若照抄，两条路在引擎眼里一模一样，`plugin_origins` 之外没有任何可区分点。

> ⚠️ **两条曾经写在这里、但不成立的理由，已删除（R1 审计 F/D1 更正，留痕防再犯）**：
> - ❌「file 源必须导出 `id`，裸函数给不出，所以裸文件必然失败」——
>   `id` 要求只在 **detect 分支**（`shared.ts:306-315` 经 `index.ts:113`），裸文件根本不进那条分支。
> - ❌「legacy 分支对任一非函数导出就 `throw`（`:103`），所以裸文件会硬崩」——
>   对**本期这个候选包**不成立：它的两个导出是**同一个函数值**，被 `:100` 的 `seen` 去重
>   （§2.11）。这条对**别的**包可能成立，但本期只做一个包，不能拿它当本期的理由。

**被否决的替代**：
- ❌ **`plugin[]` 直接指第三方文件，靠 legacy fallback 装载**（= 今天 vendored 的做法）。
  否决理由：上面三条，且它让「managed」与「未策展导入」在装载语义上没有任何区别。
- ❌ **改上游 `packages/opencode/src/plugin/index.ts` 删掉 legacy fallback。**
  否决理由：`UPSTREAM_PATHS`（`alpha-check.sh:25`）覆盖它；而且 `@alpha-code/ext` 自己就是
  legacy 形态（`packages/ext/dist/plugin.js` 默认导出函数），删掉会当场打死它。
- ❌ **同时支持 V1 与 V2 两代 ABI。** 否决理由：范围翻倍，且 V2 那条腿有更便宜的关法（D4）。

### D2 — profile 归属：`opencode-plugin` 由 alpha-code 定义；**能力复用既有两个词，不造新词**

**决定**：`opencode-plugin` profile 由 **alpha-code** 的
`packages/ui-mac/src/shared/host-extension-package-contract/` 定义（那是唯一权威）；
alpha-web 消费它并重钉 pin。**三跳 pin 搬运必须有票主**（§6 T3 / T4）。

具体命名（钉死，避免实现方各起一个）：
- profile id：`opencode-plugin`，`profileVersion: 1`，
  mediaType `application/vnd.alpha.host-extension-package.opencode-plugin.v1+json`
  （落在 `alpha-package-envelope-v1.schema.json:152-156` 的 pattern 内，**信封 schema 不用改**）；
- **host capability token：不新造。** 把**已经存在的两个** `engine:config` 与 `engine:plugin`
  登记进 host capability registry，`opencode-plugin` payload 的 compiler-derive **恰好产出这两个**。
  排序后（ASCII）落在三个 `alpha.*` 之后：
  `["alpha.connection.v1","alpha.mcp-oauth.v1","alpha.secret-prerequisite.v1","engine:config","engine:plugin"]`；
- 新界：`maxScriptAssetBytes = 2097152`（2 MiB）。**刻意与 `maxMarkdownAssetBytes`（5242880）
  和 `maxPayloadBytes`（1048576）都不同** —— 一个把界写死成别的常量的错误实现会被边界对夹具抓住。

**为什么是复用而不是新造（R1 审计 F1，这条推翻了本稿上一版的 `alpha.engine-plugin.v1`）**：

- managed plugin 装完**一定会改写 `alpha.jsonc` 的 `plugin[]`**（`main/ext-config.ts:1190`
  `persistPluginPath`），而 legacy 插件安装路径**今天就同时申请 `engine:plugin` + `engine:config`**
  （`shared/ext-capability-authorization.ts:30`）。只派生一个新 token ⇒ **managed 路径比 legacy
  路径披露得更少**，授权屏对用户不诚实。这不是措辞问题，是少告诉用户一件他会被改的东西。
- host token 的判定**只有 membership、没有 `alpha.*` 命名约束**（`registry.ts:68`，§2.4）
  ⇒ 复用在结构上成立。
- 复用之后 renderer 侧**零工作**：两个词条、两份 i18n、`engine:plugin` 的高风险徽章
  （`ext-authz.tsx:35 HIGH_RISK`）今天全都在。**T5 的「新词条 + i18n」整块工作取消。**

**连锁改动面（复用不等于零成本，逐点点名，一个都不许漏）**：

| 跳 | 位置 | 要改什么 | 票主 |
| --- | --- | --- | --- |
| ① | `registry.ts:4-7` `PackageCapabilityV1` 联合 | 加两个成员 | T1 |
| ② | `registry.ts:78-83` capability exact-set 字面量数组 | 变成 5 个 | T1 |
| ③ | `host-extension-package.registry.v1.json` 的 `capabilities[]` | 按序插入两条（各带 `semantic`） | T1 |
| ④ | `registry.v1.json` 的 `maxCapabilities` 界 | **动笔前先读实值**，确认 5 个 token + 单组件上限仍在界内；不够就在同一票里一起调，**不许留给下游票** | T1 |
| ⑤ | 消费侧反向 pin `packages/alpha-contracts-consumer/src/extension-package-artifact.test.ts:154-158` | exact-set 变 5 个 | T4 |
| ⑥ | alpha-web 的 closure exact-set `extension-package-core.mjs:2158-2166`（今天硬编码三个 `HOST_CAPABILITY_*` 常量） | 加两个常量并进比对 | T3 |
| ⑦ | alpha-web `contracts/.../generic-rules.v1.json` 的 `capabilities` | 与 registry 同集（`artifact.test.ts:166-168` 让两份互当判据） | T3 |

**被否决的替代**：
- ❌ **新造 `alpha.engine-plugin.v1`（本稿上一版）。** 否决理由：见上，且它还要新增 renderer 词条
  与 i18n，把一张合同票的范围扩到 UI —— **更大、更贵、且披露更少**。
- ❌ **不加 profile，把 plugin 压成 skill/agent 的 markdown 资产或 mcp-local 的 command。**
  否决理由：`decoder.ts:58` 的 `mediaType: "text/markdown"` 是字面量类型、schema 里是 `const`；
  把 JS 塞进 markdown 资产 = 让宿主对同一个 mediaType 有两种语义，**下一个洞就长在那里**。
- ❌ **由 alpha-web 定义 profile、alpha-code 消费。** 否决理由：与今天的权威方向相反
  （alpha-web 只 vendored 一份并按 sha 钉死，`extension-package-core.mjs:46-53`），
  反过来做要新造一条 web→code 的合同下发通道。

### D3 — probe 形态：**生产运行时一次代码都不执行**

**决定（R1 审计 F4 之后重写）**：**生产安装路径上不新增任何「把待装模块跑一遍」的探针。**
只留两件东西：

1. **`hooks.probe`（pre-switch，异步）** —— 类型 `HealthVerdict | Promise<HealthVerdict>`
   （`ext-transaction.ts:233`），引擎在 `phase:"pre-switch"` 处 `await`（`:1481` / `:1494`）；
   plugin file item 已由 `extensionHealthProbeRouter`（本身 `async`，`ext-health-probe-router.ts:60-68`）
   接线。plugin 的 probe 复用 `seedPluginFileProbe`（`:37-54`：路径存在 + 可读 + digest 逐字相等）。
   **它只比字节，不执行字节。**
2. **wrapper 的 ABI 形状在测试进程里验（票主 = T2b，含 `server()` 返回值这一段）**：
   对 **wrapper 生成器**的输出 + **固定的候选字节**，在单元测试进程内 `import` 一次，断言：
   - `mod.default` 的**自有键恰为 `{id, server}`**，`id` 是 string、`server` 是 function；
   - `server(stubInput, options)` 的返回值是对象，其键**全部属于** `Hooks` 的 21 键集合；
   - **对这份固定 canary，返回键恰为两项** —— `event` 与 `permission.ask`（§2.11 实读）；
   - **这两项的值都是 `function`**。

   ⚠️ **「键 ⊆ 21 键」和「两个键存在」都还是假闸**（R2 新开的 Major）：
   `{}` 满足前者，`{event: 1, "permission.ask": 1}` 满足两者 ——
   而真实引擎**直接调用 hook 的值**：事件面 `packages/opencode/src/plugin/index.ts:255`
   `void hook["event"]?.({…})`，trigger 面 `:288-290` `const fn = hook[name]; if (!fn) continue;
   yield* Effect.promise(async () => fn(input, output))`。
   ⇒ 一个值不是函数的 hook 表**一到真实派发就抛**，而形状断言全绿。
   **绕过配方**：把 canary 的任一 hook 值换成非函数（如 `1`）⇒ 「两个值都是 function」必须红；
   往返回值里多加一个第三个键 ⇒ 「恰为两项」必须红。

**为什么删掉上一版的「隔离子进程模块导入探针」（三条，都是硬理由）**：

- **它在打包产物里跑不起来**：打包体没有 Node 可执行文件，且 `electron-builder.config.ts:139-142`
  把 `runAsNode` / `enableNodeOptionsEnvironmentVariable` / `enableNodeCliInspectArguments`
  三个 fuse 全关。仓内唯一的生产 fork 先例是 `utilityProcess.fork`（`main/server.ts:265`），
  不是 `child_process.fork`。⇒ **第零问不过：走我们自己的代码和 runbook，到不了那个状态。**
- **它的形状断言可假绿**：上一版写的是「返回键 ⊆ 21 键」，`{}` 就能满足。
- **它有真实副作用**：调 `server()` 会让第三方模块顶层跑起来，往用户 home 写
  `~/.opencode-notify.log`（`plugin.js:742/748`）—— **发生在事务提交之前**，一次失败的安装会留下痕迹。

**如实登记剩下的这套证明不了什么**（必须写进代码注释与 AC，不许写成「等价保证」）：
- 它**不证明真实引擎会派发 hooks**。生产还要过 `plugin_origins` 去重、`applyPlugin` 的 detect
  （`plugin/index.ts:111`）、以及 detect 命中后 `resolvePluginId`（`:113`）这几关。
- 它**不证明插件的功能可用**（`opencode-notify` 在 macOS 上就是「装上了、什么都不弹」）。
- 这两条只能由**真机证据**关闭（§6 T8）。

**被否决的替代**：
- ❌ **起同版本 packaged engine 子进程**（票面原文）。否决理由：仓内零先例；
  `sidecar.ts` 顶层 `getParentPort()`、start 必 `Server.listen(port,password)`；打包体关掉
  `runAsNode` fuse ⇒ 要新造 electron.vite 入口 + IPC 协议 + 端口/口令策略。那是一张独立的大票。
- ❌ **`node:child_process` fork 一个隔离导入探针**（本稿上一版）。否决理由：见上三条。
- ❌ **只做静态 ABI 闸（断言 wrapper 模板的源码文本）。** 否决理由：`{id, server}` 是**运行期**形状，
  断言源码文本属于本 portfolio 已记档的「假闸①」。所以保留的是**测试进程里真 `import` 一次**。
- ❌ **在 main 进程里直接 `import` 待装模块做探测。** 否决理由：第三方模块顶层就写盘
  （`plugin.js:748`），main 进程一旦 import 就无法回收；且顶层可以起定时器、拉网络。

### D4 — V2 加载器：靠 **wrapper 顶层无副作用**结构性关闭，**不动用户配置**

**决定（R1 审计 F5 之后重写）**：`plugin[]` 里的那个绝对路径**会被两个加载器各求值一遍**
（V1 `applyPlugin`、V2 `ConfigExternalPlugin`，§2.2）。本相位对 V2 那条腿的处置只有一条：

> **wrapper 顶层不 import 上游**（D1 实现形态第 4 条）。`import("./upstream.js")` 在 `server()` 函数体内。
> ⇒ V2 `import()` 到的是一个**零副作用**的模块（一个字符串常量 + 一个函数声明），
> 它的 `default` 是 `{id, server}`，既不匹配 `{id, effect}` 也不匹配 `{id, setup}`
> （`external.ts:15-30` 的 `PluginModule` schema）⇒ `:81` 解码失败 → `:87 Effect.ignoreCause` 静默丢弃。
> **第三方字节从头到尾没被 V2 求值过。**

**不变量（一条，落成测试）**：wrapper 模块的 **`mod.default` 自有键恰为 `{id, server}`**
（值类型分别是 string / function），**不含 `effect`、不含 `setup`**。

- 理由：`{id, server, effect}` 是**唯一**会被两个加载器同时接受的形状（V2 解码成功、V1 detect 也命中）
  ⇒ hooks 注册两份。今天仓里不存在这种 artifact（**不存在**态），本相位不许把它造出来。
- ⚠️ **断言必须对准 `mod.default`，不是模块的 named exports**（R1 审计 F5）。
  上一版写的是「模块导出键集不含 `effect`/`setup`」—— **那测错了对象**：V2 读的是
  `mod.default.effect` / `mod.default.setup`（`external.ts:17-28`），
  加一个 named export `effect` 根本不会双注册，而**错误的 default `{id, server, effect}`
  反而能满足「模块只导出 default」这条断言**。
- **绕过配方**：往 wrapper 模板的**默认导出对象**里加一个 `effect: () => {}` ⇒ 必须红。
  第二条绕过：把 `import("./upstream.js")` 从 `server()` 里挪回模块顶层 ⇒
  「V2 求值 wrapper 之后用户 home 无新增写盘」这条断言必须红。

**为什么删掉上一版的「`materializeV2EngineConfig` 全局剥 `plugin` 键」（R1 审计 F5，这是本稿差点交付的用户可见回归）**：

- `alpha-config-injection.ts:406` 的 `copyFileSync` 拷的是**整份用户 `alpha.jsonc`**。
  删掉整个 `plugin` 键 ⇒ **用户自己配的所有合法 V2 插件一起被关掉**，不只是我们的 wrapper。
  我们没有任何机制只剥自己那一条（剥「路径在 `<alphaGlobalRoot>/plugins/` 下的」也会误伤
  用户手工放进同一目录的东西）。
- 而剥键换来的收益，wrapper 顶层不 import 上游**已经全额拿到了**：V2 那次 `import()` 仍会发生，
  但它求值的是我们自己的零副作用模块，用户 home 不会被写。
- ⇒ **代价：一整类用户可见回归；收益：零。删。整张 T6 随之删除。**

**被否决的替代**：
- ❌ **在 `materializeV2EngineConfig` 里全局剥 `plugin` 键**（本稿上一版）。否决理由：见上。
- ❌ **只剥「我们自己写进去的那一条」**。否决理由：要在配置投影层重新识别「哪条是 managed 的」，
  等于把安装侧的身份判定复制到配置投影层 —— 而 wrapper 顶层不 import 已经零成本解决同一问题。
- ❌ **接受第三方在 V2 侧也被 import 一次，只加一条日志观测它。** 否决理由：观测不改变
  「用户 home 每次 fork 被写一行」这个事实，而把一行 `import` 挪进函数体的代价是零。
- ❌ **给 V2 也做一个 `{id, effect}` 形状的 wrapper（双 ABI 兼容包）。**
  否决理由：那正是唯一的双注册形状，范围翻倍且新增一类洞。

### D5 —（**已删除**：CAS pin/unpin 不做）

> 槽位保留是为了留痕。本稿上一版在这里设计了「managed plugin 载荷 blob 装前 pin、卸载成功后 unpin」，
> **R1 审计 F6 之后整条删除**，连带 §5 第 9 类与 §5 第 8 类里那条**「CAS pin 账无该 digest」**的断言。
> （§5 第 8 类今天仍是四条，但第 ④ 条已换成 R2 补的**「账本记录消失」**，与 pin 无关。）

**为什么删**（三条，逐条实读）：

1. **本期 AC（装 / 派发 / 卸）不需要它。** 它服务的是「离线重装 / 修复旧 release」，那是另一期的需求。
2. **它的论证把两件事混了。** GC 的删除面**只有 CAS blob**
   （`main/ext-cas-gc.ts:11-13`：「GC 唯一的删除面是 CAS blob 文件」），
   **不扫已经物化到 `~/.alpha/plugins/<name>@<hex>/` 的运行副本** ⇒
   **插件装好之后照常工作，被回收的只是那份下载缓存**。CAS 本来就被定义成
   「失败后交 GC grace 的缓存」（`main/ext-install-planner.ts:697-701`）。
   上一版把「缓存被回收」写成了「字节丢失」，那是错的。
3. **按上一版的时序还会留下永久垃圾。** 「事务前 pin、仅在成功卸载后 unpin」⇒
   **事务失败就永久遗留一条 pin**（`ext-cas.ts:239` 一 digest 一记录，`:250` 唯一删除点在卸载后），
   而上一版给的判据（「成功安装 / 成功卸载各跑一次 GC」）**测不到失败路径**。
   —— 一个为了防丢字节而加的机制，自己会在最常见的失败路径上留垃圾。

**若 owner 明确把「离线重装 / 修复旧 release」纳入本期 AC**：这不是把上一版恢复回来就行 ——
要单独设计 pin 的生命周期（含事务失败回滚路径），并至少加一条退出条件
「**事务失败之后 pins/GC 恢复原状**」。那是一张独立的票，不并进 Phase 4。

### D6 — 引擎重扫：签名 package 安装路径必须接上

**决定**：照 Phase 3 `#784` 的 G20 形态修（`use-extensions.ts:850-859` / `:865-874` 是现成先例）：
① 把 `extIpc.installCatalog` 的调用**收进 `use-extensions.ts` 这一层**，不让 `extension-hub.tsx` 直连；
② `refreshEngine()` 在这一层**接一次**，不在三个调用点逐处补；
③ dispose 失败**如实降级**为 `reload-pending`，不谎报「下一条消息里就能用」。

理由：三个安装入口今天全部 hub 直连 `extIpc.installCatalog` ——
`extension-hub.tsx:673`（`runPackageAction`，`:659`）、`:1098`（`installBundle`，`:1094`）、
`:1228`（`confirmPackageAuthz`，`:1219`）；main 只对 enabled MCP 补 dispose
（`main/ext-ipc.ts:1068-1081`）。而 plugin 只在引擎实例构造时装载
⇒ **不接这条线，本相位的用户路径结构性不可能闭合**。

⚠️ **判据必须驱动生产入口（R1 审计 F13）**：上一版只写了「三个入口的 spy」，
而一个**新写一个没人调用的 helper**、Hub 仍旧直连 `extIpc` 的实现完全满足它 ——
生产行为一点没变，测试全绿（形态⑧：没测生产接线）。
本相位的判据钉死成：**渲染/调用三个生产 Hub 动作本身**，证明它们都进入同一个 `useExtensions` 方法；
**把中央方法里的 `refreshEngine()` 删掉、或把任意一个入口改回直连 `extIpc`，都必须红**（三条绕过各记一次）。

**被否决的替代**：
- ❌ **在三个入口各补一行 `refreshEngine()`。** 否决理由：`#765` 的 warning 呈现在本仓已栽三次 ——
  **枚举对新调用点默认放行**，第四个入口出现时默认又是 placebo 安装。
- ❌ **在 main 侧对所有 package 安装都 dispose。** 否决理由：dispose 的成败要呈现给用户
  （`reload-pending`），main 侧做完 renderer 拿不到降级态；且 main 侧那条路今天是按「有没有
  enabled MCP」分支的，改成无条件会波及 Phase 1/2 已交付的行为。

### D7 — 载荷传输：单个内容寻址的 JS 资产

**决定**：`opencode-notify` 的 dist **确认自包含**（§2.11：9 条模块横幅全是 `src/*.ts`、
零 `node_modules` 内联、darwin/linux 依赖闭包为空集）⇒ 用**单个内容寻址的 JS 资产**：
给资产 `mediaType` 加一个取值 `text/javascript`，配一条独立的界 `maxScriptAssetBytes`。
**不引入 bundler、不改写第三方字节、不做多文件下载器。**

具体改动面（逐点，实读定位）：
- `decoder.ts:55-60` 的 `MarkdownAssetRefV1` 扩成判别联合（新增 `ScriptAssetRefV1`，
  `mediaType: "text/javascript"`）。**不许放宽成 `string`** —— 那等于取消这道闸。
- `profiles/opencode-plugin.v1.schema.json` 自己的 `$defs` 资产块，`mediaType` 用新的 `const`，
  `bytes.maximum` 与 registry 的 `maxScriptAssetBytes` **同值**。
- `package-admission.ts:511-519`（`assetRef` 取值条件）与 `:1047-1056`（`fetchPackageAsset`）
  接受新形状，并**补齐与 payload 那条路的对称性**：timeout + 终态 URL 的 HTTPS/userinfo 复查
  （payload 侧在 `package-installability.ts:37/539/543/546-550`）。
- alpha-web `extension-package-core.mjs:1300-1330` 的 `buildPayload` 加分支，
  并把 `:1347-1368` 末尾的隐式兜底改成**显式拒绝**。
- alpha-web `host-asset-parsers.mjs:92-95` 的 `HOST_ASSET_PAYLOAD_SCHEMAS` 登记新 payload schema，
  否则 `:288-293` 直接 `E_ASSET_PROFILE_UNROUTED`（**这是好事，默认不放行**）。

⚠️ **一条必须写进 AC 的诚实降级**：`CONTRACT.md:96-113` 那三条性质
（fail-closed routing / loud stubs / parser staleness）对 JS 资产**不成立** ——
markdown 资产有 `agentMdToEntry` / `skillGenerationProbe` 这种「宿主真会执行的解析器」可以被
staleness 闸盯住，JS 资产没有对应物。本相位**不发明**一个，而是把这条如实登记（§7）。

**被否决的替代**：
- ❌ **逐文件 file table 进 payload。** 否决理由：payload 帽 1 MiB / 512 nodes ⇒ 上限约 100 个文件，
  而且它把「载荷传输」这件事塞进本该只装元数据的 payload JSON 里。
- ❌ **用 bundler 把第三方 dist 重打一遍。** 否决理由：改写第三方字节 ⇒ 上游 integrity 与
  「vendored verbatim」的留痕全部失效，且引入一个新的解析器面。
- ⚠️ **一条必须显式裁决的连带**：现行 vendored 通道的载荷是**目录全量**（含 `README.md`），
  `payloadDigest` 据此算（`ext-manifest-v2.ts:308-314`）。managed 通道只传 `plugin.js` ⇒
  **同一个插件、两个通道，payloadDigest 不等、安装目录名不等、账本身份不等**。
  **本稿的裁决：接受**（两个通道本来就是两条独立的安装记录，`configKey` 也不同），
  并在 §7 如实登记。不接受的替代（让 managed 载荷也带一份同样的 README 来凑 digest）被否决：
  那是为了让两个不同来源的哈希相等而伪造载荷内容。

### D8 — channel：第一个包只推 `dev`，不碰 `stable`

**决定**：第一个 managed plugin 包只 promote 到 `dev` channel。

理由：`stable` 一动就是全体正式版用户，而 `packages[]` 形状出任何问题会让**整个目录**在所有正式版
桌面端上消失（连 26 条 legacy 一起）；release 不可变，回滚 = 发新版本。

**这一条不牺牲真机证据**（实读确认，见 §2.12）：`alpha-environment.ts:34-46` 里
**未打包一律 `dev`、打包时非 prod/beta 的 BuildChannel 也落 `dev`**
⇒ 用 dev BuildChannel 打包出来的 mac 应用读的就是 `dev` channel。
真机 L2 完全可以在打包形态上跑，不需要碰 stable。

**被否决的替代**：
- ❌ **一路推到 stable 以获得「正式版形态」的证据。** 否决理由：上面那条不可逆风险，
  换来的只是「BuildChannel 常量不同」这一点差别。
- ❌ **只在未打包 dev 里验。** 否决理由：本 portfolio 已有两次「dev 能跑、打包炸」的记录
  （source-TS externalize、CSP 撞 `new Function`）。

---

## 5. 安全面：枚举整类 + 不变量

> **类边界前置**：下面每一类都给出**咽喉点**，咽喉对新成员**默认拒绝**。
> 每条不变量都必须能落成一条测试或脚本；写不出绕过配方的判为假闸，不许留在表里充数。

### 第 1 类 — 供给链（tarball / 依赖闭包 / native / install script）

**今天的实况**（本轮复核，两条轴）：alpha-web 侧对这三样**没有任何拒绝闸**，只有事实提取 ——
`.node/.dll/.dylib/.so/.wasm` 只是 `intake-core.mjs:41-53` 的分类清单；`detectScriptSurface`
（`:148-171`）提取的 `packageScripts`/`bins` **在整条 curation/compile 链上零消费**
（轴一按符号 `packageScripts|bins|scriptSurface` 搜 `scripts/`，生产命中只有 `intake.mjs:96/124`
的产出与 `:215/:217` 的**报表打印**；轴二按 `scripts.files|surface.scripts|record.scripts` 搜，零命中）；
`componentsFromNpmLock` 只解析 lockfileVersion 2/3，其余走 `unparsed` 分支如实上报覆盖缺口
（这一条沿用勘破结论，本轮未逐行复核，标**未验证**）。

**不变量（R1 审计 F7/F8 之后重写）**：

1. **`opencode-plugin` profile 的 producer 输入/输出资产集，精确等于一个常规 `.js` 文件。**
   编译期断言：该组件的捕获资产表**恰一个条目**、`class` 是常规文件、扩展名 `.js`、
   `bytes ≤ maxScriptAssetBytes`；**多一个文件、或出现任何非常规文件类型 ⇒ 具名拒绝编译**。
   咽喉是 `extension-package-core.mjs:1429-1438`（编译器只看
   `assetFilesByComponentId[component.id]`，再交 `buildPayload`）。
2. **发布出去的资产字节，逐字等于仓内 vendored 源的字节。**
   判据写法钉死：测试**独立地**读一次 `packages/ui-mac/resources/plugins/opencode-notify/plugin.js`
   （alpha-web 侧读它的 vendored 副本），与 release 产物里那个资产文件**逐字节比对**；
   然后**从 release 字节重算** `payloadRef.sha256` 与 `bytes`，与信封里的值比对。
   ⚠️ **不许把「资产 sha256 == 字面常量 `22f80c93…`」当唯一 oracle**（R1 审计 F8，形态⑨）——
   producer 可以永远发一份硬编码的旧文件、**完全不读仓内源**，那条断言照样绿。
   字面 digest 只保留为**第三方 provenance pin**（记录「我们当初 vendored 进来的是哪一版」），
   不作为「源真的流到了 release」的证据。
3. 上游 tarball integrity **由 operator 一次离线 capture 后写进仓**（`npm view opencode-notify@0.3.1 dist.integrity`
   + `npm pack` 后提取 `dist/index.js` 的 sha256），并**如实登记为「不由闸门保证的性质」**（§7.7）。
   operator capture 只作**来源证据**，不伪装成编译器保证。

**咽喉**：alpha-web `extension-package-core.mjs` 的 `validateBehavior` / `buildPayload` ——
新 kind 的分支末尾必须是**显式 fail**，不是隐式兜底（今天 `buildPayload:1347-1368` 就是隐式兜底）。

**绕过配方（逐条，都必须真跑一遍确认变红）**：
- 不变量 1：捕获树里多放一个文件 ⇒ 具名 error code；把那道断言删掉 ⇒ 从红变绿。
- 不变量 2：**改 vendored 源一个字节、但让 producer 输出不变** ⇒ 必须红。
  这条绕过是本类的主判据 —— 它同时杀掉「硬编码旧文件」与「digest 与字节脱钩」两种错误实现。

⚠️ **两条本稿上一版写过、R1 审计之后删掉的假闸（留痕防再犯）**：
- ❌「构建期网络调用数为零」—— producer 结构上不联网，该断言在 builder 被整个删掉时同样成立（§3 第 4 行）。
- ❌「①非空 `dependencies` / ②install 期 script / ③tarball 内含 `.node` 三个负向 fixture 各报具名 code」
  （R1 审计 F7）。**第零问不过**：D7 已定资产集只有一个 `plugin.js`，
  **捕获树里结构性不会出现 `package.json` 或 `.node`**；真把它们放进捕获树，会先撞上
  「单文件」和「捕获资产必须与 intake 文件表精确相等」（`extension-package-core.mjs:1755-1765`）。
  ⇒ 只能在**合成 fixture 里伪造 metadata**，而 operator 那条真实路径根本提供不了这些字段
  —— 于是**一个接受了真实带 postinstall 上游 tarball 的错误实现，三个 fixture 仍然全绿**。
  真正管用的不变量是上面的第 1 条：**输入/输出资产集精确等于一个常规 `.js`**；
  未发布的 tarball scripts/native 在我们的分发路径上**没有执行入口**。

### 第 2 类 — 字节完整性（三层 tamper）

| 层 | 今天靠什么 | 本相位补什么 |
| --- | --- | --- |
| producer → catalog | 签名信封 + `payloadRef.sha256` | 新资产形状进同一套校验（不新造第二种信任语义） |
| catalog → 宿主 | `fetchPackageAsset`（`package-admission.ts:1047-1056`）双查 bytes + `redirect:"error"` | **补 timeout + 终态 URL 的 HTTPS/userinfo 复查**，与 payload 路径（`package-installability.ts:539/543/546-550`）对称 |
| 宿主 → 引擎 | CAS 内容寻址 + file action 的 `preDigest/nextDigest` + `seedPluginFileProbe` 在 pre-switch 比 digest（`ext-health-probe-router.ts:50-51`） | 复用，零新增 |

**咽喉**：`fetchPackageAsset`（`main/package-admission.ts:1047-1056`）一处。

**判据写法钉死（R1 审计 F10，形态⑤/⑧）**：这一类**极容易被测试注入绕过** ——
admission 取资产时优先用注入的 `deps.fetchAsset`
（`package-admission.ts:516` `(deps.fetchAsset ?? fetchPackageAsset)(assetRef)`），
而现有 package 测试**大量注入它**（例如 `package-update.test.ts:177`）。
⇒ 在注入态下，**把生产的 timeout 与 URL 复查整段删掉，测试照样全绿**。

- ✅ 用**真实 admission**，**不传 `deps.fetchAsset`**，只替换 `globalThis.fetch`。
- ✅ 逐条点名两个 mutation，各要一条用例、各要一次绕过记录：
  ① **服务端永不 EOF** ⇒ 必须有界失败（删掉 timeout ⇒ 挂住 ⇒ 红）；
  ② **终态 `response.url` 是非 HTTPS 或带 userinfo** ⇒ 必须拒绝（删掉该复查 ⇒ 放行 ⇒ 红）。
- ✅ 对照面在 payload 那条路（`package-installability.ts:37/539/543/546-550`），
  本类补的就是这条不对称。

### 第 3 类 — 运行时 npm 三条通道（**票主：T2b**）

**不变量**：managed plugin 的整条安装到装载路径上，**对 registry 主机零连接**。

**判据写法（这一条最容易变成假绿，措辞钉死）**：
- ❌ 不许写「没调用 `Npm.add`」—— 会被 `external.ts:77` 的第二个函数绕过。
- ❌ 不许写「网络调用数为零」—— 通道③（`config.ts:424-457`）**一直在发生**，与插件无关；
  把它算进来这条断言恒假，不算进来就要说清楚边界。
- ❌ **不许拿 `~/.opencode-notify.log` 里出现 `EVENT RECEIVED:` 当本类的证据**（R1 审计 F9）——
  一个把配置写成裸包名 `opencode-notify@0.3.1` 的实现，V1（`plugin/shared.ts:207-212`）会走
  npm 下载**同一个插件**，日志一模一样。**那条日志证明「有个插件在跑」，不证明「跑的是 managed 的那份」。**
- ✅ 写成：**经生产 install 真的写盘之后，读回真实的 `~/.alpha/alpha.jsonc`，断言 `plugin[]` 里
  那一条是 managed wrapper 的\*\*精确绝对路径\*\***（`<alphaGlobalRoot>/plugins/<name>@<hex>/plugin.js`），
  且满足目录圈禁谓词（`main/ext-config.ts:1195-1197` 的 `isAbsolute` / `.js` / `underAlphaPlugins`）；
  并**独立地**断言「①②两条通道的 npm 分支谓词对这个值求值为 false」。
- ✅ **再断言否定面**：`plugin[]` 里**不存在**任何同名的 legacy/npm 条目（裸包名、vendored 目录路径）。
- ✅ **先证明这个观测手段能测出已知的坏**：故意把 config 值改成裸包名 `opencode-notify@0.3.1`
  ⇒ 断言必须红。**测不出已知的坏就打印「本次测量作废」，不给数字。**

**咽喉**：`persistPluginPath`（`ext-config.ts:1190`）。

### 第 4 类 — 双载：逐条点名六条腿

| # | 腿 | 今天有没有闸 | 本相位处置 |
| --- | --- | --- | --- |
| 1 | V1 加载器读 `plugin[]` 的绝对路径（`packages/opencode/src/plugin/index.ts:177-183`） | 有（同名派生路径闸 `findSameNamePluginPathEntry`） | 复用 |
| 2 | V2 `ConfigExternalPlugin` 读迁移后的 `plugins`（`external.ts:45`，**同一份配置**） | **无** | **D4：wrapper 顶层无副作用** ⇒ V2 `import()` 到零副作用模块、`:81` 解码失败、`:87` 静默丢弃，**双注册结构性关闭**；⚠️ V2 那次 `import()` **仍然发生**（这是既有事实，不是本相位新增），只是不再牵出第三方字节 |
| 3 | npm 包名条目（catalog npm 分支 `ext-install-planner.ts:2142` / Hub 未策展导入） | 有（`findPluginBaseConflictStrict`，锁内 precondition 重跑） | 复用 |
| 4 | vendored / seed 插件（同名不同目录） | 有（`legacySameNamePluginGate`） | 复用；并新增「同名 managed 与 vendored 不得共存」一臂 |
| 5 | 引擎对工作目录 `{plugin,plugins}/*.{ts,js}` 的自动发现 | **无，alpha 完全看不见** | **不做**，如实登记（§7） |
| 6 | alpha 自有的 `.alpha/plugins/*.js` fanout（`@alpha-code/ext` 动态 import，第三套 ABI） | **无** | **不做**，如实登记（§7） |

**咽喉**：腿 1/3/4 共用 `persistPluginPath` 之前的那组 precondition；腿 2 咽喉是
**wrapper 模板本身**（顶层不 import 上游，D4）；腿 5/6 无咽喉，故如实登记为已知边界而不是假装有闸。

### 第 5 类 — 授权披露的诚实性（**票主：T5**）

**不变量（R1 审计 F1 之后重写：不新造 token，改为钉住「披露的是哪两件事」）**：

1. **managed plugin 组件派生出来的能力集，恰为 `{engine:config, engine:plugin}` 两个**（不多不少）。
   期望值写成测试文件里的**独立字面量**，**不许 `import` 生产的 derive 函数当期望**
   （那是自指等价链：一起改错就一起自洽）。
2. **断言渲染出来的可观察结果**：把这个组件的授权屏渲染出来，断言
   ① `engine:plugin` 的人话文案与**高风险徽章**都在（`ext-authz.tsx:35 HIGH_RISK`）；
   ② `engine:config` 的人话文案也在；
   ③ 屏上**没有**任何裸 token 形态的行（那是 §2.9 记的 fallback 降级形态）。

**绕过配方（三条，各要一次记录）**：
- 从 derive 里去掉 `engine:config` ⇒ 不变量 1 与渲染断言②同时红
  （**这一条是本类的主判据** —— 它正是「managed 比 legacy 少披露一件事」那个真缺陷）；
- 把 `engine:plugin` 从 `HIGH_RISK` 里删掉 ⇒ 渲染断言①红；
- 把渲染层的词条查找改成 fallback 分支 ⇒ 渲染断言③红。

⚠️ **不许只断言 `CAP_VOCAB["engine:plugin"] !== undefined`** —— 那是内层纯函数，
一个忘了接 i18n / 忘了打徽章的实现照样满足它。要断言渲染出来的可观察结果。

⚠️ **本类不做「对全部 host token 的穷举覆盖闸」**（这是上一版写过的第 2 条不变量，本轮删除）。
理由：三个 `alpha.*` host token 今天在 `CAP_VOCAB` 里**本来就没有词条**（§2.9），
一条「每个 host token 都必须有词条」的穷举闸**第一天就是红的**，
而补齐它们是 Phase 1/2 的存量缺口、不属于本相位（§7.13 如实登记）。
**先证明手段能测出已知的坏、再用它判未知的好** —— 一条注定红的闸只会被人加豁免，那比没有更贵。

### 第 6 类 — secret 不过线（**票主：T2b**）

**今天的实况（本轮复核，与上一版结论相反）**：
`shared/package-secret-prerequisite.ts:162-170` 与 `shared/package-alpha-connection.ts:213-218`
对未匹配的 payload schema 返回空 items —— 但**未登记的 profile 根本到不了这两处**：
`decoder.ts:406` 的 `findPackageProfileV1` 取不到就 `:407-412` 具名拒绝
`component-profile-unsupported`，`PackageSupportedComponentV1` 造不出来（§2.4，两条轴）。
⇒ 这两处的空集**对 skill / agent / 以及本期这个无密钥的 plugin 是正确行为**，不是 fail-open 洞。

**不变量（R1 审计 F15 之后收窄）**：

1. **显式登记 `opencode-plugin → 无 secret / 无 connection 前置**：
   `decodePackageSecretPrerequisiteProfileV1` 与 `decodePackageConnectionPrerequisiteProfileV1`
   对 plugin payload 返回**空 items**，由一条**具名用例**钉住（不是靠「没写分支所以走 else」）。
2. `opencode-plugin` payload **不得**声明任何密钥前置，也不得携带 `alpha.secret-prerequisite.v1` /
   `alpha.connection.v1` / `alpha.mcp-oauth.v1`（schema 层 `additionalProperties:false` + capability derive 层双管）。

**咽喉**：`decoder.ts:406`（未登记 profile 的具名拒绝）+ payload schema 的 `additionalProperties:false`。

**绕过配方**：把 `opencode-plugin` 的 capability derive 改成会产出 `alpha.secret-prerequisite.v1`
⇒ 不变量 2 红；把 plugin payload schema 放宽成允许额外键 ⇒ 具名用例红。

⚠️ **本类不做「把那两处静默 else 改成未登记即拒」**（这是上一版写过的第 2 条不变量，本轮删除）。
理由（R1 审计 F15）：**第零问不过** —— 要让「未知 schema 静默空集」真的可达，
必须**先改合同加进第六个 profile**，而那时 `decoder.ts:406` 已经会放行它、
新 profile 的密钥语义本来就该由它自己那张合同票负责。为一个到不了的状态重写两处生产 else
属于预防性设计。**T2b 开工时的核实义务（一句话）**：确认没有任何生产路径能绕过
`supportComponent()` 造出 `PackageSupportedComponentV1`（本轮两条轴查过一次，实现时再确认一次）；
若发现有，本条裁决作废，恢复穷举收口。

### 第 7 类 — 兜底式 ternary（`else → mcp`）：改成穷举 + 未知即拒

**决定**：**改**。把 `package-admission.ts:506` 的三元换成一个单点函数
`packageChildKindV1(profileId): {ok:true, kind} | {ok:false, reason}`，与
`ext-package-lifecycle.ts:35` 的 `packageChildTxKeyV1` **共用同一张表**；
`package-admission.ts:672-681` 的 builder 分派同样改成按这张表查，未登记 ⇒ 整个组件具名拒绝；
调用点的 `as "skill" | "agent" | "mcp"` 强转（`package-admission.ts:906`、`ext-package-lifecycle.ts:349`）
一并删掉。

理由：`ext-package-uninstall.ts:143-145` 是 fail-closed 的，所以今天的后果是
**装得上、卸不掉**（`claude-plugin-install.ts:344` 的注释已经点名过这个形态）；
而 `:506` 的错误分类会把一个 plugin 组件静默写进 `alpha.jsonc` 的 `mcp` 段。

**判据：两条都测，缺一条都是假闸（R1 审计 F14）**：

- **A. 五个 profile 的 exact mapping。** 断言 registry 里**每一个**已登记 profile 都在表里有项，
  且**各自路由到不同的具名 builder**（`skill→buildSkillTxItems` / `agent→buildAgentTxItems` /
  `mcp-local`、`mcp-remote→buildMcpTxItems` / `opencode-plugin→buildPluginTxItems`）。
  **期望集从 `PROFILE_REGISTRY_V1` 派生**（断言表的键集 == registry 的 profileId 集，全覆盖），
  **不写字面表** —— 否则就是「期望值恰好等于可硬编码的常量」（形态⑨）。
- **B. 未登记的第六个 profile 被具名拒绝。** 往 registry 加一个不在表里的 profile ⇒ 必须红。

⚠️ **只写 B 不够**（这正是上一版的缺陷）：一个把 `opencode-plugin` **错映成 `skill`**、
同时对未知 profile 默认拒绝的表，**完全满足 B**。
⚠️ **只写 A 也不够**：一个把 `else` 留在那里的实现对已登记的五个都对，对第六个静默变 `mcp`。
✅ **builder / receipt / ledger graph / uninstall 四处必须消费同一个映射结果**，不许各查各的。

**与 `ac#777` 的关系**：`#777` 讲的是「门在自己的环境里跑不出真结果」，这一条是
「枚举对新成员默认放行」—— 同族不同类。**本相位自己收口，不并进 `#777`。**

### 第 8 类 — 卸载残留

**不变量**：整包卸载成功后，**四条一起**断言（不是只断 `ok`）：
① `<alphaGlobalRoot>/plugins/<name>@<hex>/` 目录不存在；
② `alpha.jsonc` 的 `plugin[]` 不含那条绝对路径；
③ `grants.json` 无对应 key；
④ **账本里那条 package 记录消失** —— 走**生产卸载**再把账本读回来，断言这个 packageId
   查不到、且它的 child record 也没了。

> **第 ④ 条的两次变更，一起留痕**：R1 审计 F6 删掉的是「**CAS pin 账无该 digest**」
> （本相位不 pin，`pins.json` 里从头到尾不会有这个 digest，断它「没有」是**恒真式**）；
> R2 补进来的是**另一件事** —— 账本记录消失。两者不是同一条，不要混。

**第 ④ 条的判据钉在真实 mutation 上，不许自己拼等价链**：生产卸载构造的
`PackageLedgerMutationV1`（`main/ext-package-uninstall.ts:184-193`）就是以
`operation: "uninstall"` + **`graphAfter: null`** + `childRecordMutations` 里逐条 `op: "remove"`
把记录删掉的。
- ✅ 判据 = **跑生产卸载 → 重新读账本 → 查不到**；
- ❌ 不许写成「断言我们构造出来的 mutation 里 `graphAfter === null`」——
  那是断言一个**中间值**，一个「mutation 造对了但从没提交」的实现照样满足它
  （形态⑧：没测生产接线）。

**咽喉**：`removePackageChildArtifactsV1`（`ext-package-uninstall.ts:86-147`，
skill/agent/mcp 三臂在 `:100/:117/:126`，`:143-145` 是 fail-closed 兜底）新增的 plugin 臂
+ 账本 mutation 的提交点（`:184-193`）。
**绕过配方**：把四条里任一条对应的清理动作删掉 ⇒ 对应断言红；
第 ④ 条的绕过 = 让卸载**不提交那份 mutation**（或把 `childRecordMutations` 过滤空）
⇒ 账本读回来还在 ⇒ 必须红。
⚠️ 只断 `{ok:true}` 的写法通不过 —— 今天的 fail-closed 分支也返回 `ok:false`，
而一个「删了目录但没摘 config」的实现会返回 `ok:true`。

### 第 9 类 —（**已删除**：GC 与 pin）

> 槽位保留是为了留痕。上一版在这里写了「装完跑 GC blob 还在 / 卸完跑 GC blob 被回收」一对断言，
> **随 D5 一并删除**（R1 审计 F6）。删的理由在 D5：GC 只删 CAS blob，**不碰已物化到 `plugins/`
> 的运行副本**（`ext-cas-gc.ts:11-13`），插件装好后照常工作；
> 而上一版的 pin 时序会在**事务失败**时留下永久 pin，那对断言恰恰测不到。

---

## 6. 子票切分

> **七个无主跳的票主对照**（一个都不许漏）：
> ① host profile 定义 → **T1**；
> ② host capability **登记既有两个 token** + derive → **T1**（registry + 宿主侧）+ **T3**（producer derive + closure）
>    —— **renderer 零词条 / 零 i18n 工作**（R1 审计 F1）；
> ③ 三跳 pin 搬运 → **T3**（web 侧升 pin + 过渡对）+ **T4**（code 侧 re-vendor）；
> ④ 载荷传输 → **T1**（形状）+ **T2a**（宿主取回）+ **T3**（producer 产出）；
> ⑤ 引擎重扫 → **T5**；⑥ 把第一个真实包签名发进 catalog → **T7**；⑦ Phase 4 的 VERIFY 矩阵 + 打包真机证据 → **T8**。
>
> **R1 审计之后的票面变化**：**T6 整张删除**（F5：全局剥键取消，V2 那条腿由 wrapper 模板关掉，
> 模板归 T2b）；**T2 拆成 T2a / T2b**（F16）；**T1 与 T4 是同一个 merge unit**（F3）。
> 总数仍是 8 张：T1、T2a、T2b、T3、T4、T5、T7、T8。

### 旧票处置

| 旧票 | 处置 | 理由 |
| --- | --- | --- |
| `alpha-web#99` | **作废重开**（close as superseded，由 T3 承接） | 它声明的 4 个新文件一个都不该建（真正要改的是既有 `extension-package-core.mjs` 五处 + 已发布 artifact）；收货方 `#97` 已 CLOSED；两条 AC 里有一条是恒真式（§3 第 2/3/4 行）。**Boundary、Dependencies、AC 三样全被推翻，不是「改写沿用」能覆盖的量。** |
| `alpha-code#699` | **作废重开**（close as superseded，由 T1/T2a/T2b/T5 承接） | 7 条 dev-plan 里 5 条被推翻：第 1 条归属反了、第 2 条要改上游、第 3 条形态零先例、第 5 条三路已在生产、第 6/7 条已上线（§3 第 6–14 行）。验收 gate 的 ABI corpus 维度对准了一个**不存在的成员**。 |
| `alpha-web#108` | **保留不动，不并进 Phase 4** | 它管的是「第一个真实 package」这件事，形态由 owner 的内容决策（哪个远端 MCP）决定，与 managed plugin 无关。合并会把两个互不相干的 owner 决策锁在一张票上。**T7 只管 managed plugin 包**；若 owner 更愿意让 T7 成为第一个真实 package，那是一次编排裁决，不是本稿的默认。 |
| `alpha-work#49` Evidence map「AC8 \| `#700`」 | **改写该行**，指向 T8 | `#700` 已 CLOSED 且明写不含 managed Plugin（§3 第 21 行）。 |
| `alpha-code` vendored producer artifact 落后 aw@`6e0db57d` 一个 commit | **并进 T4** | T4 本来就要覆盖那批字节；但 PR 正文必须**单独列出**因 aw#112 frontmatter 变化而变动的宿主测试语料，不许混在 profile 变更里一笔带过。 |

### 票

| 票 | 负责哪些 AC / 决定 | 边界（具体文件） | out of scope | 退出条件 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| **T1** `[REQ-128][CODE] 宿主合同注册 opencode-plugin profile,并把 engine:config/engine:plugin 登记进 host capability registry` | D2、D7 的合同半场、②的宿主半场 | `packages/ui-mac/src/shared/host-extension-package-contract/`：`host-extension-package.registry.v1.json`（profiles/capabilities/limits 各按序插入）、`registry.ts:3` profile 联合 + `:4-7` **capability 联合加两个成员** + `:46-57` + `:76/:79-83/:87-90` 三处 exact-set、新建 `profiles/opencode-plugin.v1.schema.json`、`decoder.ts:55-60/:113-117/:285-301/:704-740` 解码臂与 `ScriptAssetRefV1`、`:265-272` payload 分派加臂、`synthetic-decoder.ts`、`generate-artifact.ts:14-27/:64-143`、corpus、`host-extension-package-artifact.v1.json`、`CONTRACT.md`（§Profiles / §Exclusions:181-184）、`host-extension-package-artifact.test.ts:63-75` 与 `:165-166` | 宿主实现（admission/事务/卸载）、renderer、alpha-web 任何一行 | ① `bun generate-artifact.ts --check` exit 0；② **`bash scripts/alpha-check.sh` 全绿**（不许用局部 `bun test src` 代替）；③ 新 `artifactSha256` 写进 PR 正文（T3 要用）；④ `artifact.test.ts:178+` 的笛卡尔 derive 矩阵覆盖**两个新登记的 capability**；⑤ 边界对夹具：`maxScriptAssetBytes` 恰好值接受 / +1 拒绝，且**期望值从 registry 读，不写字面量**；⑥ **`maxCapabilities` 的实读值与「5 个 token + 单组件上限仍在界内」的复核结论写进 PR 正文**（D2 连锁④） | 无。**与 T4 同一 merge unit** |
| **T2a** `[REQ-128][CODE] 宿主侧资产取回与完整性:script 资产形状 + fetchPackageAsset 补 timeout 与终态 URL 复查` | §5 第 2 类、D7 的宿主取回半场 | `main/package-admission.ts:510-517`（`assetRef` 取值条件接受 script 资产形状）、`:1047-1056` `fetchPackageAsset`（补 timeout + 终态 URL 的 HTTPS/userinfo 复查，与 `package-installability.ts:37/539/543/546-550` 对称） | kind 分流 / 事务 builder / 卸载臂（那是 T2b）；renderer；alpha-web | ① 用**真实 admission**、**不传 `deps.fetchAsset`**、只替换 `globalThis.fetch`（注入态下删掉生产 guard 也全绿，`package-admission.ts:516` + `package-update.test.ts:177`）；② 两个 mutation **逐条点名**各一条用例 + 各一次绕过记录：永不 EOF ⇒ 有界失败；终态 `response.url` 带 userinfo / 非 HTTPS ⇒ 拒绝；③ **`bash scripts/alpha-check.sh` 全绿** | T1 |
| **T2b** `[REQ-128][CODE] plugin 事务与生命周期:kind 分流收口 + wrapper 模板 + buildPluginTxItems + 卸载臂` | §5 第 3/6/7/8 类、D1 的 wrapper 模板、D4 的不变量 | `main/package-admission.ts:506/:509/:672-681/:906`；`main/ext-package-lifecycle.ts:35-37/:349`；**新建 wrapper 模板**（顶层不 import 上游，`import("./upstream.js")` 在 `server()` 内）与 `buildPluginTxItems`（`main/ext-package-tx-builders.ts`，复用 `seedPluginPayloadItems` 的 item 构造与 `extensionHealthProbeRouter`）；`main/ext-package-uninstall.ts:86-147` 新增 plugin 臂；`shared/package-secret-prerequisite.ts` 与 `shared/package-alpha-connection.ts` **各加一条 plugin 具名用例**（**生产 else 不动**，§5 第 6 类）；`shared/package-admission.ts:88` wire 类型 | renderer 任何一行；`installPluginFromCas`（legacy 单装载体，**不复用、不改**）；alpha-web；**`main/alpha-config-injection.ts`（D4 之后不再动它）**；CAS pin/unpin（D5 已删） | ① 第 7 类 **A+B 两条都测**（五个 profile 的 exact mapping，期望键集从 `PROFILE_REGISTRY_V1` 派生；未登记第六 profile 具名拒绝），两条绕过各记一次；② 第 8 类**四条一起断**（目录 / `plugin[]` / grants / **账本记录消失**）；第 ④ 条走**生产卸载后重读账本**，绕过 = 不提交那份 mutation（`ext-package-uninstall.ts:184-193` 的 `graphAfter: null`）⇒ 必须红；③ file item key 必须是 `plugin--<name>--f<i>`（否则 `ext-health-probe-router.ts:40-41` 拒），一条用例钉住；④ 第 3 类：**经生产 install 真写盘后**读回真实 `alpha.jsonc`，断言精确 managed 绝对路径 + 目录圈禁 + **无同名 legacy/npm 条目**；⑤ wrapper：`mod.default` **自有键恰为 `{id, server}`**（不是 named exports）+ 顶层零副作用（V2 求值后用户 home 无新增写盘），**两条绕过各记一次**；⑥ **D3 的 `server()` 返回值验证归本票**：对固定 canary 断言返回键**恰为 `event` + `permission.ask` 两项**、**两个值都是 `function`**；绕过 = 任一 hook 值换成非函数 ⇒ 必须红（真实引擎在 `plugin/index.ts:255` / `:288-290` 直接调用这两个值）；⑦ **`bash scripts/alpha-check.sh` 全绿** | T1 |
| **T3** `[REQ-128][CODE] alpha-web:发布端支持 plugin kind + 升 host pin(带过渡对) + 重生 producer artifact` | D2 的 web 半场、D7 的 producer 半场、③的前半跳、§5 第 1 类 | `scripts/lib/extension-package-core.mjs`：`:46-53` PIN、`:575-589` `componentProfile`、`:591-687` `validateBehavior`、`:625-630` 与 `:729-734` **两处** kind 白名单、`:1297-1369` `buildPayload`（末尾改显式拒绝）、`:1376-1394` `deriveComponentCapabilitiesV1`（**产出 `engine:config` + `engine:plugin`**）、`:2158-2166` closure exact-set（**加两个 `HOST_CAPABILITY_*` 常量**）、`:2288-2303` `verifyLiveHostArtifactAtRepo`（**临时过渡对**）；`scripts/gen-extension-package-artifact.mjs:27-107` `HOST_ARTIFACT` 表、`:110-207` `HOST_REGISTRY_BYTES`、`:917-957` profiles mapping、`:982-989` **`excluded` 删 `managed-plugin`**；`contracts/.../generic-rules.v1.json` 的 `capabilities`；`scripts/lib/host-asset-parsers.mjs:92-95`；`contracts/extension-package/CONTRACT.md:33-37/125-140`；**`tests/extension-package-contract.test.mjs:84-89`（漂移闸的调用方测试，见退出条件④）**；重跑 `node scripts/gen-extension-package-artifact.mjs` | alpha-code 任何一行；发布一个真实包（那是 T7）；`catalog-sweep.mjs`（那是 T7 的前置修复） | ① `npm test` 绿（含 `assertVendoredHostContractPin` 的四个 error code 路径）；② 第 1 类**两条不变量**：单文件资产集（多一个文件 ⇒ 具名 code）+ **release 字节 ≡ 独立读取的 vendored 源字节、再从 release 字节重算 `payloadRef.sha256/bytes`**；绕过配方「**改 vendored 源一个字节但让输出不变 ⇒ 必须红**」实跑记录在 PR 正文；③ 新 producer `artifactSha256` 写进 PR 正文（T4 要用）；④ **过渡对要改两处，缺一处主线门仍是红的**：(a) `verifyLiveHostArtifactAtRepo`（`extension-package-core.mjs:2288-2303`）临时只接受**精确的一对** `(old-live sha, new-pin sha)`；(b) **调用方测试 `tests/extension-package-contract.test.mjs:84-89` 同步加过渡分支** —— 窗口期接受**同一对**并**断言处于 transition 状态**（不是把 `:88` 那条严格相等删掉），窗口外维持严格相等；**两处都不做任意豁免、不放宽成通配**；`:91-107` 的 stale 负向与 `:109+` 的 unresolvable 负向**原样保留、必须仍然报 `E_HOST_ARTIFACT_DRIFT` / fail-closed**；PR 正文写明窗口起止与「删除过渡对」那个 PR 的编号；⑤ **删除过渡对的 PR 在 T1+T4 落 `alpha` 之后立即合，且函数里的例外与测试里的过渡分支一起删**，本票不闭合到它合并为止 | **T1**（要它的 `artifactSha256`；T1 **不必已合并**）。**硬序见下** |
| **T4** `[REQ-128][CODE] alpha-code re-vendor producer artifact + lock + closure` | ③的后半跳 | `packages/alpha-contracts-consumer/vendor/alpha-web-extension-package/**`（逐字拷 T3 那个 commit 的 `contracts/extension-package/artifact/*`）、`packages/alpha-contracts-consumer/alpha-web-extension-package.lock.json`、`packages/alpha-contracts-consumer/src/extension-package-artifact.test.ts:142-173` 的 closure exact-set（`:154-158` capability 变 5 个、`:171-173` `excluded` 去掉 `managed-plugin`）；**顺带把落后 aw@6e0db57d 的那批字节前移** | 宿主实现、renderer | ① **`bash scripts/alpha-check.sh` 全绿**；② PR 正文**单独列出**因 aw#112 frontmatter 变化而变动的宿主测试语料（`package-mixed-bundle.fixture.ts`、`package-admission.test.ts`、`package-update.test.ts`、`ext-package-detail-wiring.cases.ts`），逐条说明为什么变 | T3。**与 T1 同一 merge unit**（`extension-package-artifact.test.ts:107-110` 反向钉死，见硬序） |
| **T5** `[REQ-128][CODE] renderer 半场:签名 package 安装路径收口到 useExtensions 并接引擎重扫` | ⑤、D6、§5 第 5 类 | `renderer/extensions/use-extensions.ts`（新增收口方法，`refreshEngine()` 在这一层接一次；先例 `:850-859` / `:865-874`）；`renderer/extensions/extension-hub.tsx:673`（`runPackageAction`）、`:1098`（`installBundle`）、`:1228`（`confirmPackageAuthz`）改走 `ext.*` 不直连 `extIpc` | main 侧任何一行；`main/ext-ipc.ts:1068-1081` 的 MCP 补偿（不动）；**`ext-authz.tsx` 与 i18n（F1 之后零改动）** | ① **渲染/调用三个生产 Hub 动作本身**，证明它们进入同一个 `useExtensions` 方法（不许只测一个新 helper）；② 三条绕过各记一次：删掉中央方法里的 `refreshEngine()` ⇒ 红；任一入口改回直连 `extIpc` ⇒ 红；③ 失败如实呈现 `reload-pending`；④ 第 5 类：授权屏**渲染结果**含 `engine:plugin` 人话文案 + 高风险徽章、含 `engine:config` 人话文案、无裸 token 行；派生能力集恰 `{engine:config, engine:plugin}`（期望值写独立字面量，**不 import 生产 derive**）；三条绕过各记一次；⑤ **`bash scripts/alpha-check.sh` 全绿**；⑥ **不含新视觉，不走 design-loop**（用的是既有词条与既有渲染路径）—— 若实现中发现需要新的视觉元素，**停下来报告**，不要顺手画 | T2b |
| ~~**T6**~~ | **整张删除**（R1 审计 F5） | — | — | 全局剥 `plugin` 键会关掉用户所有合法 V2 插件（D4）；「wrapper 不得导出 `effect`/`setup`」测错了对象，正确形态是断 `mod.default` 自有键，已并入 **T2b** 退出条件⑤ | — |
| **T7** `[REQ-128][CODE] 先修 catalog-sweep,再把 opencode-notify 编成 managed plugin 声明并签名发布到 dev channel` | ⑥、D8、F2 的产品定位、§5 第 1 类的 operator capture | alpha-web **`scripts/catalog-sweep.mjs:97-110`（前置修复）**；`catalog-src/packages/<name>/`（新建目录）、`catalog-src/curation/package.*/`、`catalog-src/intake/`；`scripts/build-catalog.mjs` 走既有路径；`scripts/catalog-channels.mjs promote --to dev`；operator 一次离线 capture 的 integrity 记录落 `docs/` | `preview` / `stable` 两条 channel（**不碰**）；alpha-code 任何一行 | ① **先修 `catalog-sweep`**：显式识别 package root 并**跳过 aggregate root**（其风险事实由各 child intake/curation 覆盖），plugin child 仍正常进 sweep；判据 = 在新建 `curation/package.*/` 之后 `catalog-sweep.mjs` 跑通，且把修复前会抛的那两处各写一条用例（`:102` legacy `ENTRY_ID_RE` 拒 + `:110` 读 package root 不存在的 intake）；**「已知不修」不是本票的选项**；② **legacy 面「只动这一条」的 oracle（措辞钉死，R2 新开的 Major：上一版的 ② 与 ⑤ 按字面互斥）**：在**新旧两侧都先滤掉 `plugin:opencode-notify` 这一个 id**，再断言**其余** legacy entries 与上一版已发布 release **逐字节相同**；③ **另立一条独立断言：`plugin:opencode-notify` 在新 dev release 里缺席**（上一版它确实在，`alpha-web/catalog-src/catalog.json:566-591`）。②③ 各要一条绕过：顺手改了别的 legacy 条目 ⇒ ② 红；忘了删那一条 ⇒ ③ 红；④ 第 1 类不变量 2 的两条断言在真实构建产物上跑一遍；⑤ **展示文案按 F2 定位**：不叫「完成通知」、不承诺通知行为、写成「交付链验证（开发用）」；⑥ dev channel promote 成功，桌面端 dev 构建能浏览到 | **T2a + T2b + T4 + T5**（汇合点，F12）、T3 |
| **T8** `[REQ-128][VERIFY] Phase 4 验证矩阵 + 每道闸的绕过实施记录 + 打包真机 L2` | ⑦、D3 的「证明不了什么」、`aw#49` AC8 的 Phase 4 半场 | `test-component/` 下的 case 与夹具；`docs/verification/2026-08-xx-req128-phase4/` 证据 | 任何生产代码改动 | ① §5 **每一个活着的类**（1/2/3/4/5/6/7/8；第 9 类已删）都有一条「故意改坏 X ⇒ 它变红」的实施记录，写不出绕过的判为假闸并退回；② **打包真机 L2（dev BuildChannel）**：装 → 引擎重扫 → **先记 `~/.opencode-notify.log` 的 byte offset**、触发事件、**只采 offset 之后新增的行**里的 `EVENT RECEIVED:` → 整包卸载 → 目录/config/grants/**账本记录** **四清零**（第四条 = 卸载后重读账本查不到这个 packageId，§5 第 8 类）；③ **独立断言身份**：`alpha.jsonc` 里无 legacy/npm 同名配置，账本身份指向 managed package（日志本身证明不了这一点，§2.11）；④ **如实记录**「通知没有弹出」这一条，不许写成通过；⑤ 一切检索带 `-a`；⑥ 批量跑测试一律 `bash -c` 并核对 `Test Files N passed (N)` 的 N 与枚举数相等，测不到就打印「本次测量作废」 | **全部 CODE 票**（T1、T2a、T2b、T3、T4、T5、T7；F12）。可与它们并行起草，T7 之后收口 |

### 硬序（不可换）

```
                     ┌──> T2a ──┐
T1(authored) ──> T3 ─┤          ├──> T5 ──┐
   │                 └──> T2b ──┘         │
   └──[同一 merge unit]──> T4 ────────────┴──> T7 ──> T8
                                                       ↑
                                       T1/T2a/T2b/T3/T4/T5 全部合并
```

**为什么 T1 与 T4 必须是同一个 alpha-code PR（R1 审计 F3，这是上一版最贵的错）**：

上一版把硬序写成 `T1 → T3 → T4`，并给 T1 的退出条件写了 `bun test src`。
**那个退出条件漏跑了真正的门。** alpha-code **自己也反向钉死**了消费侧副本：
`packages/alpha-contracts-consumer/src/extension-package-artifact.test.ts:107-110`
断言「vendored 的宿主合同副本与本仓**活的**宿主 artifact 逐字节相同」，
而正式本地门 `scripts/alpha-check.sh:108-114` 会跑 consumer 测试。
⇒ **T1 单独合并时，本仓自己的正式门就是红的** —— `T1 → T3 → T4` 按绿门根本执行不了。

**可执行的四步窗口（照做，不要即兴）**：

1. **T1 在 alpha-code 里写完但不合并**，把新的 host `artifactSha256` 交出去。
2. **T3 在 alpha-web 合并**：升 `HOST_CONTRACT_PIN` 到新 sha，重生 producer artifact，
   并**在两处**放行**同一对**精确过渡对：
   - (a) `verifyLiveHostArtifactAtRepo`（`extension-package-core.mjs:2288-2303`）；
   - (b) **它的调用方测试** `tests/extension-package-contract.test.mjs:84-89` ——
     `:85` 取真实 live 结果、`:88` 再**独立**做一次 `live.artifactSha256 === HOST_CONTRACT_PIN.artifactSha256`
     的严格相等。⇒ **只改 (a) 不改 (b)，第②步的 `npm test` 仍然必红**（R2 新开的 Major：
     上一版硬序漏了这一跳）。窗口期该测试接受同一对并**断言处于 transition 状态**，
     窗口外维持严格相等。
   - `:91-107` 的 stale 负向（拿更早的合同 commit 必须报 `E_HOST_ARTIFACT_DRIFT`）与
     `:109+` 的 unresolvable 负向（live ref 解析不出必须 fail-closed）**原样保留**——
     过渡对精确到两个 sha，这两条负向不受影响，**它们红了说明过渡对被放宽了**。

   —— 此刻 `origin/alpha` 上的宿主 artifact 还是旧的，没有这一对，alpha-web 主线 CI 会红。
   **只接受这一对，不做任意豁免、不放宽成通配、不加环境变量开关。**
3. **T1 + T4 在同一个 alpha-code PR 里原子落地**：T1 的合同改动 + T4 把 T3 那个 commit 的 producer
   artifact 逐字 re-vendor 进来。两侧同时变新 ⇒ `artifact.test.ts:107-110` 绿、`alpha-check.sh` 绿。
4. **立刻合并 T3 那个「删除过渡对」的 PR**（编号在 T3 的 PR 正文里）：
   **函数里的例外与测试里的过渡分支一起删**，回到「live 严格等于 pin」。窗口关闭。

> `verifyLiveHostArtifactAtRepo` 的 never-waived 语义（runbook
> `docs/runbooks/desktop-extension-package-artifact-bump.md:33-35`）**没有被削弱**：
> 过渡对是一个**精确到两个 sha 的、有删除票的**临时例外，不是豁免机制。
> 窗口期在两个仓的 PR 正文里各留一次痕。

**其余三条硬序**：

- **别绕过 T2b。** 只做 T1+T3 会得到一个「合同认、编译器发得出、宿主 `package-admission.ts:506`
  把它当 mcp、卸载时 `ext-package-uninstall.ts:143-145` 拒绝」的包 —— 正是
  `claude-plugin-install.ts:344` 已经点名的**装得上、卸不掉**。
- **T7 必须汇合 T2a + T2b + T4 + T5**（R1 审计 F12）。上一版让 T7 只依赖 T3/T4 ⇒
  catalog 里可以先出现一个**现役宿主分类成 mcp、卸载又被 fail-closed 拒绝**的包。
  发布永远排在「宿主认得它、装得上、卸得掉、引擎收得到」之后。
- **T8 依赖全部 CODE 票**，且**所有 alpha-code 票的退出条件一律是 `bash scripts/alpha-check.sh`**，
  不许用局部 `bun test src` 代替 —— 那正是 `#777` 刚修掉的「门在自己的环境里跑不出真结果」形态，
  而 `alpha-check.sh` 今天已经真正覆盖 12/12 个代码步。
- **T2b 与 T5 必须同一 Iteration。** 「引擎重扫」这一跳跨了 main（T2b 的事务落地）与
  renderer（T5 的接线），按层拆票切断用户竖线是 Phase 1（漏 renderer 半场）与
  Phase 2（漏三条跨仓竖线）各栽过一次的形态。

---

## 7. 如实登记的边界

**本相位做不到的事。这些不是缺陷，是已知条件；写在这里就是为了不让下一轮 review 把它们当漏掉的闸再开一次。**

1. **本期不交付一个功能可用的插件 —— 这是显式的产品定位，不是「如实登记的缺陷」。**
   `opencode-notify` 在 macOS 上弹不出任何通知：两个 macOS 通知器只找一个我们不再分发的
   原生二进制（`plugin.js:299-313` / `:382-398`），README 与 `resources/NOTICE.txt:43-48` 说的
   「osascript 回退」在代码里不存在（全文 `osascript` 只在 `:218` 判前台窗口）。
   ⇒ 本期把它定位成 **dev-only 的交付链验证载荷（hook canary）**：
   展示文案**不得**叫「完成通知」、**不得**承诺通知行为；新的 dev release 里**不再出现**
   legacy 那条同名条目（§7.5）。用户可观察产出是「装上了、引擎真派发到它」。
   **AC 里不许出现「通知弹出」。**
   ⚠️ **这一条是产品文案面，owner 可推翻**：若要求本期交付功能可用的用户插件，
   则换候选包 —— §2.11 全部作废、D7 对新包重跑、**T7 的 operator capture 与 intake 要重做**。
2. **本期在生产安装路径上不执行任何待装代码，因此证明不了「真实引擎会派发 hooks」。**
   D3 之后留下的两件东西各自能证明什么，说清楚：
   pre-switch 的 `seedPluginFileProbe`（`ext-health-probe-router.ts:37-54`）只证明
   **落盘字节与预期 digest 逐字相等**；测试进程里的 wrapper ABI 断言证明
   **我们自己生成的 wrapper + 那份固定候选字节在 Node 里 import 得动、默认导出是 V1 形状、
   `server()` 返回的键恰为两项且两个值都是函数**（R2 收紧，见 §4 D3 第 2 条 —— 不要拿本节
   当上界去低估已有覆盖）。
   **仍然证明不了的是「真实引擎会派发到它」**：生产还要过 `plugin_origins` 去重、
   `applyPlugin` 的 detect（`plugin/index.ts:111`）、detect 命中后的 `resolvePluginId`（`:113`），
   以及派发时对 hook 值的实际调用（`:255`、`:288-290`）。**这一条只由 T8 的真机证据关闭。**
3. **只做 V1 ABI。** V2 那条腿靠「wrapper 顶层无副作用」结构性关闭（D4），**不做 V2 profile**。
   一旦将来要支持 V2，`{id, server, effect}` 是唯一的双注册形状，必须先钉死那一条。
4. **两条腿不管**：引擎对工作目录 `{plugin,plugins}/*.{ts,js}` 的自动发现
   （`packages/core/src/config/plugin/external.ts:58-70`）、
   alpha 自有的 `.alpha/plugins/*.js` fanout（第三套 ABI）。两条都是用户可达的插件装载路径，
   **本相位的双载闸不覆盖它们**，也没有任何一张票拥有「alpha 要不要、以及怎么看见这两条通道」。
   ⚠️ **「防双载已闭合」这句话的适用范围必须限制在 §5 第 4 类表里的腿 1/2/3/4**。
   写 AC / 写 PR 正文 / 写 T8 证据时，**不许出现无限定的「双载已闭合」** ——
   加载路径一共六条，本相位关掉的是四条。
5. **同一插件、两个通道、两个身份 —— 但本期起 dev 上只留一条。**
   legacy vendored 条目（`plugin:opencode-notify`，载荷含 `README.md`）与 managed package
   （载荷只有 `plugin.js`）的 `payloadDigest` 不等 ⇒ 安装目录名不等、账本记录不等。
   **这个不等本身接受**（D7：两条通道本来就是两条独立安装记录，`configKey` 也不同）。
   但**新的 dev release 里不并存两条** —— legacy 那条按 F2 删掉（T7 退出条件⑤），
   理由是它对用户声称的「弹通知」不成立，而全 portfolio 无真实用户、无兼容要求。
   `preview` / `stable` 上已发布的 release 不动（本期不碰这两条 channel，D8）。
6. **版本号口径不一致（legacy 侧的既存事实）。** catalog `entry.version = "1.0.0"` ≠ 上游真版本 `0.3.1`，
   而落账本、走 downgrade 闸的是前者（`ext-install-planner.ts:3711`）。
   **managed 侧统一用 `0.3.1`**；legacy 那条在新 dev release 里已被删除（§7.5），
   所以 dev 上不再有这个口径冲突；`preview`/`stable` 上已发布的旧 release 保持原样，不追改。
7. **上游 tarball integrity 不由闸门保证。** 仓内零留痕（§2.11），本相位靠 operator 一次离线
   capture 写进仓，**只作来源证据，不伪装成编译器保证**。
   闸门能保证的是「**发出去的字节逐字等于仓内 vendored 源的字节**，且信封里的 digest 是从
   release 字节重算出来的」（§5 第 1 类不变量 2）—— 它挡不住「vendored 进来的那一版本身就被掉包」。
8. **JS 资产没有 parser staleness 闸。** `CONTRACT.md:96-113` 的三条性质对 markdown 资产成立
   （靠 `agentMdToEntry` / `skillGenerationProbe` 这两个「宿主真会执行」的解析器），
   对 JS 资产不成立。本相位**不发明**一个替身。
9. **只推 `dev` channel，不碰 `stable`。** ⇒ 正式版用户看不到这个包；
   `aw#49` AC8 的 packaged **RC（L3）**在本相位不闭合，T8 交付的是 dev BuildChannel 的打包 L2。
10. **`engines.opencode` 对 managed 路径永不求值**（`packages/opencode/src/plugin/loader.ts:125`
    的 `base.source === "npm"` 守着，managed 是 file 源）。
    ⇒ managed artifact 声明 `engines` 无意义，也不会被打包引擎自报的 `1.17.13` 误拒。
    **那个常量与本相位无因果，本相位不修它。**
11. **`packages/plugin`（ABI 的 SOT）不受 north-star 守卫覆盖**（`alpha-check.sh:25` 的
    `UPSTREAM_PATHS` 不含它）。本相位不碰它；但这是一个「枚举对新成员默认放行」的既存缺口，
    应由一张独立窄票拥有，**不并进 Phase 4**。
12. **仍未验证的只剩一条**：§2.6 最后一条（`downloadRemoteAsset` 只接在 legacy planner 上、
    没接进 package 路径）沿用勘破结论，本轮未逐行复核。**标未验证，不写成事实。**
    上一版列在这里的另外两条**已在 R1 轮实读确认，不再标未验证**：
    - ②「alpha-web intake 只提取不拒绝」**成立**：`detectScriptSurface`（`intake-core.mjs:148-171`）
      的产出在整条 curation/compile 链上零消费（两条轴，§5 第 1 类）。
      ⇒ 上一版据此设计的三道 compile gate 是不可达的，已按 F7 删除。
    - ③「`catalog-sweep.mjs` 在 package curation 目录出现后会抛错」**成立，而且是两处**：
      `catalog-sweep.mjs:102` 用 legacy `ENTRY_ID_RE`（`catalog-channels-core.mjs:45`，
      枚举里没有 `package`）先拒；即便放宽 regex，`:110` 还会无条件去读
      **package root 根本没有**的 intake（`extension-package-core.mjs:1890` 明写
      「root 自身没有 intake 许可事实」）。
      现状可复现：`catalog-src/` 下**没有** `packages/` 目录、`curation/` 下 10 个目录**没有**
      任何 `package.*`（两条轴：`ls` + `ls -d catalog-src/curation/package.*` 零命中）
      ⇒ T7 会是第一个踩上的。**已按 F11 改成「T7 开工前先修 + 测」，「已知不修」不是选项。**
      修复形状已有现成谓词可用：`curation-gate.mjs:43` 的 `PACKAGE_CURATION_ID_RE`
      —— producer 侧早已把 package root 与 legacy entry 分开，只有 sweep 没跟上。
13. **三个 `alpha.*` host token 在授权屏上仍然渲染成 `?` + 裸串两遍。**
    `alpha.connection.v1` / `alpha.mcp-oauth.v1` / `alpha.secret-prerequisite.v1` 在 `CAP_VOCAB`
    （`ext-authz.tsx:27-34`）里没有词条（§2.9）。**这是 Phase 1/2 的存量缺口，本相位不拥有它**：
    managed plugin 携带的两个 token（`engine:config` / `engine:plugin`）今天就有词条与徽章，
    本相位的用户路径不经过那三个。
    ⇒ 因此 §5 第 5 类**不立「每个 host token 都必须有词条」的穷举闸** ——
    那条闸第一天就是红的，只会被人加豁免。**补齐这三个词条应由一张独立窄票拥有，不并进 Phase 4。**

---

## 8. 审计记录

> `codex-review-watchdog` 要求的留痕，也是 R2 判闭合的对照物。
>
> **轮数预算：2 轮（M 级），已全部用完。**
> R1 = Codex，2026-08-03，`VERDICT: REJECT`，16 条 finding；
> R2 = Codex，2026-08-03，`RECOMMEND: REVISE`，13 FIXED / 2 PARTIAL / 1 NOT-FIXED / 3 条新增 Major、无 Blocker。
> **本稿收口后不再复审，由派发者直接合。** 依规程，任何额外一轮都必须先向 owner 交互式请示获批
> （S/M/L 一律如此，有新 Blocker 也不例外）；未获批时的默认动作是 Major 及以下直接修、修完不复审。

### R1（2026-08-03，Codex，`VERDICT: REJECT`）—— 全量轮

**总裁决：16 条全部采纳。** 其中 12 条让方案**变小**（删闸、删票、删探针），4 条让闸门变紧。
这正是开发前审计的价值。**R1 修订的净效果：删 6 处、紧 9 处、重写 3 处；票数 8 → 8
（T6 删除、T2 拆成 T2a/T2b）。**

| # | 级别 | 一句话 | 裁决 | 落在本稿哪一节 |
| --- | --- | --- | --- | --- |
| F1 | BLOCKER | 新造 `alpha.engine-plugin.v1` 属重复造词，且漏披露 `engine:config` | **采纳**：不造新 token，把既有 `engine:config`/`engine:plugin` 登记进 host registry 并 derive；删 T5 的词条与 i18n 工作 | §1、§2.4、§2.9、§3 第 13 行、**§4 D2（重写 + 七跳连锁表）**、§5 第 5 类、§6 T1/T3/T5 |
| F2 | BLOCKER | 候选包在 macOS 上功能不闭合，按原方案发布 = 对用户说假话 | **采纳（取方案 b）**：本期定位为 **dev-only 交付链验证载荷（hook canary）**；文案不得叫「完成通知」；新 dev release 删掉 legacy 重复项。**产品文案面，owner 可推翻** | **§1 警告块（重写）**、§2.11、**§7.1（重写）**、§7.5、§7.6、§6 T7 退出条件④⑤ |
| F3 | MAJOR | `T1→T3→T4` 是双仓反向钉死形成的不可执行闭环 | **采纳**：T1+T4 合成同一 merge unit；alpha-web T3 临时只允许精确的 `(old-live, new-pin)` 过渡对，窗口后立刻删；不做任意豁免 | **§6 硬序（重写为四步窗口）**、§6 T1/T3/T4 |
| F4 | MAJOR | D3 的运行时模块导入探针不可达 / 可假绿 / 有副作用 | **采纳**：**删掉运行时探针**；保留 digest pre-switch probe；wrapper 生成器 + 固定候选字节在测试进程里执行；派发由 T8 真机闭合 | **§4 D3（重写）**、§3 第 6 行、§7.2 |
| F5 | MAJOR | D4 全删 `plugin` 键会误伤用户所有合法 V2 插件；T6 的断言测错了对象 | **采纳**：删掉全局剥键与**整张 T6**；改成 wrapper 顶层不 import 上游、`import("./upstream.js")` 放进 `server()`；断言对准 `mod.default` 自有键 | **§4 D1 实现形态④、§4 D4（重写）**、§5 第 4 类腿 2、§6 T2b 退出条件⑤、§6 T6 行 |
| F6 | MAJOR | D5 是本期 AC 之外的离线缓存需求，且时序会留下失败 pin | **采纳**：删掉 D5、pin/unpin、§5 第 9 类，以及第 8 类里那条「CAS pin 账无该 digest」的断言（**注意**：第 8 类今天仍是四条，第 ④ 条已由 R2 换成「账本记录消失」，与 pin 无关） | **§4 D5（删除）**、**§5 第 9 类（删除）**、§5 第 8 类、§3 第 11 行、§6 T2b |
| F7 | MAJOR | 第 1 类的 dependency/script/native 三个 fixture 到不了真实 producer 输入 | **采纳**：删掉三道不可达 compile gate；真正的不变量是「输入/输出资产集精确等于一个常规 `.js`」 | **§5 第 1 类（重写）**、§7.12 ② |
| F8 | MAJOR | 固定 sha256 仍是形态⑨假闸（producer 可永远发硬编码旧文件） | **采纳**：主 oracle 改成「release 字节 ≡ 独立读取的 vendored 源字节」，再从 release 字节重算 digest；字面 digest 降级为 provenance pin | **§5 第 1 类不变量 2（重写）**、§6 T3 退出条件② |
| F9 | MAJOR | 第 3 类无 CODE owner；T8 的日志判据可被 npm / legacy / 旧日志伪造 | **采纳**：第 3 类**归 T2b**（读真实 `alpha.jsonc` 断精确 managed 绝对路径）；T8 加 **byte offset** + 断言无 legacy/npm 同名配置 + 账本身份 | §2.11（日志两个盲区）、**§5 第 3 类（重写）**、§6 T2b 退出条件④、§6 T8 退出条件②③ |
| F10 | MAJOR | 第 2 类可被 `deps.fetchAsset` 注入绕开生产下载器 | **采纳**：用真实 admission、**不传 `deps.fetchAsset`**、只替换 `globalThis.fetch`；逐条点名两个 mutation | **§5 第 2 类（重写）**、§6 T2a 退出条件①② |
| F11 | MAJOR | `catalog-sweep` 不是「可留痕不修」的边界，T7 会交付一条必炸的运维命令 | **采纳**：T7 **先修 `catalog-sweep`**（识别 package root 并跳过 aggregate root），**删掉「已知不修」选项** | §6 T7 边界 + 退出条件①、**§7.12 ③（升级为已验证）** |
| F12 | MAJOR | 依赖图允许先发布后补宿主；退出条件用局部测试代替全仓门 | **采纳**：T7 汇合 T2a+T2b+T4+T5；T8 依赖全部 CODE 票；**所有 alpha-code 票退出条件统一改成 `bash scripts/alpha-check.sh`** | **§6 票表（全部退出条件）**、§6 硬序 |
| F13 | MAJOR | T5 的「三入口 spy」未要求经过生产入口 | **采纳**：测试必须**渲染/调用三个生产 Hub 动作**并证明进入同一个 `useExtensions` 方法；三条绕过各记一次 | **§4 D6（加判据段）**、§6 T5 退出条件①② |
| F14 | MAJOR | 第 7 类只测「未知被拒」，证明不了当前映射正确 | **采纳**：**两条都测** —— 五个 profile 的 exact mapping（期望键集**从 registry 派生**，不写字面表）+ 未知 profile 具名拒绝 | **§5 第 7 类（重写）**、§6 T2b 退出条件① |
| F15 | MINOR | 第 6 类是为未来第六 profile 改生产语义，不是当前可达缺陷 | **采纳**：只**显式登记 `opencode-plugin → 无 secret/connection 前置`** 并测 schema/capability derive；删掉两处生产 else 改造。**核实义务已在本轮完成**：咽喉是 `decoder.ts:406`（两条轴） | **§5 第 6 类（重写）**、§2.4 |
| F16 | MINOR | T2 过宽、T6 应删除 | **采纳**：T6 随 F5 删除；T2 拆成 **T2a 资产取回与完整性** / **T2b plugin 事务与生命周期**；T1/T4 两条评审线、同一 merge unit | **§6 票表**、§6 开头票主对照 |

### 审计方核实通过、本稿直接采信的（R2 不再重新论证）

- **D7 的「Darwin 模块导入闭包」成立**：三轴枚举（`find` / `git ls-files` / `rg -a --files`）
  只有 `README.md` 与 `plugin.js`；静态 import 全是 `node:*`，第三方动态 import 只在
  Linux/Windows 分支且有 catch ⇒ **单文件、无 bundler、不改写第三方字节**的方案成立。
  塌掉的是**通知功能闭包**（F2），不是模块导入闭包。
- **D6（renderer 中央重扫）与 D8（只推 dev）成立。**
- **D1 的 wrapper 方向可保留，但上一版给的理由不准确** —— 已按 §4 D1 改写成
  「身份 / ABI 归一化」，两条不成立的理由留痕在那里。
- **§5 第 8 类「清零」配合真机卸载是有效闸**（本轮由四条改为三条，第 ④ 条随 D5 删除）。
- **§7 的 7/8/9/10/11 属诚实分层**；§7.1/3/5/6 已随 F2/F5 重写；
  **§7.4 保留，但「防双载已闭合」的表述范围被限制在腿 1/2/3/4**。

### 修订中发现、裁决表未覆盖、**本稿不自作主张处置**的连锁项

> 三条都只登记不处置，等编排者裁决。

1. **F1 让 §5 第 5 类原来的「全部 host token 穷举覆盖闸」变成第一天就红**：三个 `alpha.*` token
   今天在 `CAP_VOCAB` 里没有词条（§2.9）。本稿的处置是**把那条闸删掉、换成对本期两个 token 的
   渲染断言**，并把缺口如实登记进 §7.13，建议由一张独立窄票拥有。
   —— 若编排者认为该缺口应并进 Phase 4，则 T5 的范围要重新画（含 i18n 与 design-loop）。
2. **F1 的连锁面比裁决表写的宽一跳**：登记两个 host capability 会同时动
   alpha-web 的 closure exact-set（`extension-package-core.mjs:2158-2166` 的三个
   `HOST_CAPABILITY_*` 常量）与 `generic-rules.v1.json` 的 `capabilities`
   —— 因为消费侧 `artifact.test.ts:166-168` 让这两份**互当判据**。已写进 §4 D2 连锁表⑥⑦与 T3 边界。
   另有一条**必须在 T1 开工时实读**的：`maxCapabilities` 这条界在 5 个 token 下还够不够
   （本稿未读该实值，标**未验证**，已写成 T1 的退出条件⑥）。
3. ~~**F6 删掉 pin 之后，第 8 类只剩三条断言**。「整包卸载后账本里不再有这条记录」不在这三条里，
   本稿**没有**顺手补上（超出裁决范围）。~~
   **→ R2 把它作为「补充项 NOT-FIXED」重新开出，编排者已裁决采纳。第 8 类回到四条**（§5 第 8 类④），
   判据钉在真实 mutation `ext-package-uninstall.ts:184-193` 的 `graphAfter: null` 上。

### R2（2026-08-03，Codex，`RECOMMEND: REVISE`）—— 收口轮

**判定**：R1 的 16 条里 **13 FIXED**；**F3 / F4 PARTIAL**；**补充项 NOT-FIXED**；
且**修复 diff 内新增 3 条 Major**。**无 Blocker。**
**编排者裁决:四条全部采纳**（都真实、都最小、都能落成测试）。

| 项 | R2 判定 | 一句话 | 落在本稿哪一节 |
| --- | --- | --- | --- |
| F3 残留 | PARTIAL → **已收口** | 只放行 `verifyLiveHostArtifactAtRepo` 的过渡对不够：**调用方测试** `tests/extension-package-contract.test.mjs:85` 取真实 live 结果后，`:88` 仍**独立**断言 live SHA 严格等于新 pin ⇒ 第②步 `npm test` 必红 | **§6 硬序第②/④步（重写）**、§6 T3 边界 + 退出条件④⑤ |
| F4 残留 | PARTIAL → **已收口** | `{event: 1, "permission.ask": 1}` 满足上一版全部 D3 断言，而真实引擎**直接调用 hook 的值**（`plugin/index.ts:255`、`:288-290`）⇒ 一到派发就抛；且这段 `server()` 返回值验证**没有 CODE 票主** | **§4 D3 第 2 条（重写：恰两项 + 两值皆 function）**、§6 T2b 退出条件⑥ |
| T7 ②⑤ 互斥 | 新增 MAJOR → **已收口** | ②要求「摘掉 `packages` 后 legacy 与上一版 release 逐字相同」，⑤要求删掉 legacy 的 `plugin:opencode-notify` —— 而上一版确实含它（`alpha-web/catalog-src/catalog.json:566-591`）⇒ **两条按字面不可同时满足**，实现方会卡死 | **§6 T7 退出条件②③（拆成「滤掉这一个 id 后其余逐字不变」+「该 id 缺席」两条）** |
| 卸载账本 | NOT-FIXED → **已补** | 三清零没断「成功卸载后账本里那条 package 记录消失」，而真实卸载 mutation 正是以 `graphAfter: null` 删除它（`ext-package-uninstall.ts:184-193`） | **§5 第 8 类（回到四条）**、§6 T2b 退出条件②、§6 T8 退出条件② |

**三条新增 Major 的共同形态，记在这里当下一轮的对照物**：
**它们全是上一轮修订自己引入的假绿/不可执行判据** —— 修一个假闸时造出的新判据，
如果没有再问一遍「一个错误实现能不能满足它？」，就会带着同一个病换个位置长出来。
本轮三条分别是：**粒度粗一格**（键存在 ≠ 值可调用）、**只堵了咽喉没堵调用方**（函数放行了、测试没放行）、
**两条断言互相否定**（一条要求字节不变、另一条要求删掉其中一条）。

> **轮数预算 2 轮已用尽（R1 + R2）。本次修订之后不再复审，由派发者直接合。**
> 依规程：未获 owner 批准不得加轮；Major 及以下由派发者筛完直接让实现方修、修完直接合。
