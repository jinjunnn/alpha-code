---
title: REQ-128 Phase 4 方案基线：Catalog 托管的 OpenCode Plugin（单包窄竖线）
kind: design
status: draft
owners:
  - alpha-code extension maintainers
last_reviewed: 2026-08-03
review_after: 2026-11-03
---

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

这一期把它改成**从我们签名的扩展包目录里取**：

- 用户在扩展中心看到它，点安装；
- 弹出的授权屏上，多一行**说人话的高风险披露**：「在引擎进程内运行代码 —— 与引擎同权限执行 JS」。
  今天签名扩展包的授权屏对这类能力只显示一个 `?` 加一串裸标识符（见 §2.9），这一期把它变成人话；
- 确认后，**一次事务**把插件装上：字节从签名目录取回 → 校验哈希 → 落进 `~/.alpha/plugins/<名字>@<内容地址>/`
  → 把绝对路径写进引擎配置。中途任何一步失败，盘上与账本都一个字节不留；
- **引擎当场重扫**，插件在下一条消息里就真的开始工作（今天签名扩展包装完**根本不通知引擎**，
  见 §2.8 —— 那是这一期必须补的那条线）；
- 点移除，目录、配置条目、授权账、CAS 里的字节引用一起消失。

**范围窄到只有一个包、只有一代 ABI。** 只做 `opencode-notify` 这一个，只对上游 V1 插件文法。
但这一个包的**用户路径整条闭合**：看得见 → 说得清 → 装得上 → 引擎真派发到它 → 卸得掉。

> ⚠️ **必须先说的一条**：`opencode-notify` 今天在 macOS 上**大概率一条通知都不会弹**（§2.11）。
> 它的两个 macOS 通知器都只找一个我们出于公证风险**故意不再分发**的原生二进制；README 与
> `NOTICE.txt` 里写的「代码自带 osascript 回退」在代码里**不成立**。
> 所以本期给用户的可观察产出**不是「弹出了一条通知」**，而是「装上了、引擎真的把事件派发给了它」——
> 证据取自插件自己的日志文件（§4 D3、§6 T8）。这条如实登记在 §7，**不许在 AC 里写成「通知功能可用」**。

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
  `getLegacyPlugins`（`:95-107`）。它对 `Object.values(mod)` 逐个取值，**任何一个导出不是函数就
  `throw new TypeError("Plugin export is not a function")`**（`:102`）。
- **file 源必须导出 `id`**：`shared.ts:306-315`，`source === "file"` 且无 `id` ⇒
  `throw new TypeError('Path plugin ${spec} must export id')`。
  但 `applyPlugin` 只在 **V1 分支**调 `resolvePluginId`（`index.ts:114`），legacy 分支（`:119`）跳过它
  ⇒ **今天的 vendored 插件是以「无 id 的 legacy 函数」被装载的**。
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
> ⇒ 要让 V2 看不见 `plugin[]`，必须把 `:406` 那一行从「拷贝」改成「读 → 剥键 → 写」。

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
  不依赖坏掉的通知后端。这是 §4 D3 与 §6 T8 的证据基础。
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
| 6 | 「起同版本 packaged engine probe 子进程」（`ac#699` dev-plan 3） | 仓内零先例（`utilityProcess.fork` 全仓仅 `server.ts:265`；`new Worker` 仅 `ext-cas-gc-scheduler.ts:103`）；`sidecar.ts` 顶层 `getParentPort()`、start 必 `Server.listen`；打包体关掉 `runAsNode` fuse | **作废该形态**，见 §4 D3 |
| 7 | 验收 gate「ABI corpus：…invalid dispose/cancel…」（`ac#699` AC1） | 上游 `Hooks` 21 键有 `dispose`（`packages/plugin/src/index.ts:223`）、**无 `init`、无 `cancel`**（两轴零命中） | **作废该 AC 维度**：给不存在的成员造反例 = 恒绿断言 |
| 8 | 「Catalog-managed 路径绝不进入 runtime `Npm.add`」+ gate「断言不调用 `Npm.add`」（`ac#699` Outcome / AC3） | 三条 npm 通道；只堵①会被②绕过、被③变成假绿 | **作废该 AC 措辞**，见 §5 第 3 类 |
| 9 | 「pin `#97`/`#99` 的 managed Plugin profile/corpus」（`ac#699` dev-plan 1） | host profile 的唯一权威在 alpha-code 自己（`packages/ui-mac/src/shared/host-extension-package-contract/`），alpha-web 只 vendored 副本 | **重画边界**：归属反了，见 §4 D2 |
| 10 | 「managed loader 禁止 legacy arbitrary function export fallback」（`ac#699` dev-plan 2） | fallback 在 `packages/opencode/src/plugin/index.ts:118`，属 `UPSTREAM_PATHS`（`alpha-check.sh:25`），改不得 | **重画边界**：改成「alpha 生成的 wrapper 让 `applyPlugin` 的 detect 在 `:111` 命中即 return」，见 §4 D1 |
| 11 | 「materialize 到现有 CAS」（`ac#699` dev-plan 2） | ①package 路径今天**不进 CAS**（内存直写）；②file action 不贡献任何 journal digest（`ext-transaction.ts:1186`）⇒ 6h 后被 sweep；③`pinCasBlob` 生产零调用 | **重画边界**，见 §4 D5 |
| 12 | 「同包 npm/vendored/local/legacy 双载拒绝」是待建的四路闸（`ac#699` dev-plan 5） | 三路已在生产（`findPluginBaseConflictStrict` / `findSameNamePluginPathEntry` / `legacySameNamePluginGate`，且锁内 precondition 重跑）；真正无闸的是 V2 加载器与上游目录自动发现 | **重画边界**，见 §5 第 4 类 |
| 13 | 「UI/授权始终披露『同权限 engine-process code』」读作既有能力（`ac#699` dev-plan 6） | 签名 package 的授权屏对 host `alpha.*` token 渲染成 `?` + 裸串两遍；`CAP_VOCAB` 六键无 `alpha.` 前缀 | **重画边界**：要新造 host token + producer derive + renderer 词条，并走一遍 pin 三跳 |
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

> 以下八条是**编排者已裁决**的，写成决定，不重新论证。每条给出被否决的替代与否决理由。

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

**为什么要 wrapper**（三条，都实读）：
- `applyPlugin`（`packages/opencode/src/plugin/index.ts:110-117`）先跑 detect，wrapper 命中即
  `return`，**legacy 分支结构性不可达** —— 这就是 `ac#699` 第 2 条真正能实现的形态，零改上游；
- legacy 分支对 `Object.values(mod)` 逐个取值，**任何一个导出不是函数就 `throw`**（`:102`）
  ⇒ 直接指向第三方文件的做法对「导出了一个版本号常量」的插件会硬崩；
- file 源必须导出 `id`（`shared.ts:306-315`），第三方裸函数给不出。

**被否决的替代**：
- ❌ **`plugin[]` 直接指第三方文件，靠 legacy fallback 装载**（= 今天 vendored 的做法）。
  否决理由：上面三条，且它让「managed」与「未策展导入」在装载语义上没有任何区别。
- ❌ **改上游 `packages/opencode/src/plugin/index.ts` 删掉 legacy fallback。**
  否决理由：`UPSTREAM_PATHS`（`alpha-check.sh:25`）覆盖它；而且 `@alpha-code/ext` 自己就是
  legacy 形态（`packages/ext/dist/plugin.js` 默认导出函数），删掉会当场打死它。
- ❌ **同时支持 V1 与 V2 两代 ABI。** 否决理由：范围翻倍，且 V2 那条腿有更便宜的关法（D4）。

### D2 — profile 归属：`opencode-plugin` 由 alpha-code 定义

**决定**：`opencode-plugin` profile 与新 host capability 由 **alpha-code** 的
`packages/ui-mac/src/shared/host-extension-package-contract/` 定义（那是唯一权威）；
alpha-web 消费它并重钉 pin。**三跳 pin 搬运必须有票主**（§6 T3 / T4）。

具体命名（钉死，避免实现方各起一个）：
- profile id：`opencode-plugin`，`profileVersion: 1`，
  mediaType `application/vnd.alpha.host-extension-package.opencode-plugin.v1+json`
  （落在 `alpha-package-envelope-v1.schema.json:152-156` 的 pattern 内，**信封 schema 不用改**）；
- host capability token：`alpha.engine-plugin.v1`（排序后落在 `alpha.connection.v1` 与
  `alpha.mcp-oauth.v1` 之间，registry 数组按序插入）；
- 新界：`maxScriptAssetBytes = 2097152`（2 MiB）。**刻意与 `maxMarkdownAssetBytes`（5242880）
  和 `maxPayloadBytes`（1048576）都不同** —— 一个把界写死成别的常量的错误实现会被边界对夹具抓住。

**被否决的替代**：
- ❌ **不加 profile，把 plugin 压成 skill/agent 的 markdown 资产或 mcp-local 的 command。**
  否决理由：`decoder.ts:58` 的 `mediaType: "text/markdown"` 是字面量类型、schema 里是 `const`；
  把 JS 塞进 markdown 资产 = 让宿主对同一个 mediaType 有两种语义，**下一个洞就长在那里**。
- ❌ **由 alpha-web 定义 profile、alpha-code 消费。** 否决理由：与今天的权威方向相反
  （alpha-web 只 vendored 一份并按 sha 钉死，`extension-package-core.mjs:46-53`），
  反过来做要新造一条 web→code 的合同下发通道。

### D3 — probe 形态：不起第二个引擎

**决定**：**不新造 packaged engine probe 子进程。** 改用两件已接线的东西：

1. **`hooks.probe`（pre-switch，异步）** —— 类型 `HealthVerdict | Promise<HealthVerdict>`
   （`ext-transaction.ts:233`），引擎在 `phase:"pre-switch"` 处 `await`（`:1481` / `:1494`）；
   plugin file item 已由 `extensionHealthProbeRouter`（本身 `async`，`ext-health-probe-router.ts:60-68`）
   接线。plugin 的 probe 复用 `seedPluginFileProbe`（`:37-54`：路径存在 + 可读 + digest 逐字相等）。
2. **一个有界的隔离子进程模块导入探针**（`node:child_process` fork 一个只做导入的脚本，
   带超时与内存/时间上限），做四件事：strict `import` → 断言默认导出是 `{id, server}` →
   调 `server(stubInput, options)` → 断言返回值是对象且其键**全部属于** `Hooks` 的 21 键集合 →
   若有 `dispose` 则调用它。

**如实登记它证明不了什么**（必须写进代码注释与 AC，不许写成「等价保证」）：
- 它**不证明真实引擎会派发 hooks**。生产还要过 `plugin_origins` 去重、`applyPlugin` 的形态检测、
  以及 file 源的 `id` 必须存在这三关（§2.1）。
- 它**不证明插件的功能可用**（`opencode-notify` 在 macOS 上就是「装上了、什么都不弹」）。
- 这两条只能由**真机证据**关闭（§6 T8）。

**被否决的替代**：
- ❌ **起同版本 packaged engine 子进程**（票面原文）。否决理由：仓内零先例；
  `sidecar.ts` 顶层 `getParentPort()`、start 必 `Server.listen(port,password)`；打包体关掉
  `runAsNode` fuse ⇒ 要新造 electron.vite 入口 + IPC 协议 + 端口/口令策略。那是一张独立的大票。
- ❌ **只做静态 ABI 闸（不执行任何代码）。** 否决理由：`{id, server}` 是**运行期**形状，
  静态断言只能看文本，属于本 portfolio 已记档的「假闸①：断言源码文本」。
- ❌ **在 main 进程里直接 `import` 待装模块做探测。** 否决理由：第三方模块顶层就写盘
  （`plugin.js:748`），main 进程一旦 import 就无法回收；且顶层可以起定时器、拉网络。

### D4 — V2 加载器：实测结论写成不变量 + 测试

**决定**：把 §2.2 的实测结论落成**两条不变量 + 两条测试**，不许装作没看见。

1. **`materializeV2EngineConfig` 拷给 V2 的那份 `opencode.json` 必须剥掉 `plugin` 键。**
   落点是 `alpha-config-injection.ts:406` 那一行 `copyFileSync` → 改成「读 → 删 `plugin` 键 → 写」。
   理由：V2 对 V1 形状 100% 注册失败且 `Effect.ignoreCause` 全静默（`external.ts:87`），
   **但 `import()` 已经跑过一次**（`:80`）—— 对 `opencode-notify` 就是每次 fork 往用户 home
   多写一行日志、多起一个 dispatcher。**纯浪费 + 纯风险，没有任何收益。**
2. **alpha 生成的 wrapper 绝不同时导出 `effect` 或 `setup`。**
   理由：`{id, server, effect}` 是**唯一**会被两个加载器同时接受的形状（V2 解码成功、
   V1 detect 也命中）⇒ hooks 注册两份。今天仓里不存在这种 artifact（**不存在**态），
   本相位不许把它造出来。

**测试写法（判据粒度）**：
- 不变量 1：用真 `packages/core/src/v1/config/migrate.ts` 的 `migrate()` + 真 `decodeInfo`
  跑一遍**剥后**的配置，断言 `Info.plugins` 不含我们写进去的那个绝对路径。
  **绕过配方**：把剥键改回 `copyFileSync` ⇒ 该断言必须红。
- 不变量 2：断言 wrapper 模块的**导出键集**与 `{"default"}`（加 wrapper 自己刻意导出的名字）
  逐字相等，且不含 `effect` / `setup`。**绕过配方**：往 wrapper 模板加一行
  `export const effect = …` ⇒ 必须红。

**被否决的替代**：
- ❌ **接受双 import，只加一条日志观测它。** 否决理由：观测不改变「用户 home 每次 fork 被写一行」
  这个事实，而剥键的代价是一行。
- ❌ **给 V2 也做一个 `{id, effect}` 形状的 wrapper（双 ABI 兼容包）。**
  否决理由：那正是唯一的双注册形状，范围翻倍且新增一类洞。

### D5 — CAS：managed plugin 字节必须 pin，卸载时解 pin

**决定**：managed plugin 的载荷 blob 在 `promotePayloadToCas` 之后、事务提交之前
`pinCasBlob(baseRoot, sha256, reason)`；整包卸载成功之后 `unpinCasBlob`。

理由（实读）：file action 不贡献任何 journal digest（`ext-transaction.ts:1186`），
plugins 目录既不是 GC 的 mark 根也不是 sweep 面 ⇒ **字节只在 CAS 的载荷 6 小时后必被回收**
（`ext-cas-gc.ts:34` 宽限窗）。今天这条不咬人，只是因为 vendored 载荷的真源在 `resources/` 里、
每次安装都重新采集；**managed 载荷没有可重新采集的本地真源**。

**被否决的替代**：
- ❌ **不 pin，靠「需要时重新联网下载」。** 否决理由：修复/回滚/重装同 digest 三个动作都会变成
  联网操作，而 catalog 可能已经不再提供那个 payload URL。
- ❌ **把 plugin 载荷改成 generation item**（自动被 mark 根②覆盖，零新增机制）。
  否决理由：换载体 = 改引擎读取的绝对路径形态（`plugins/<dir>/plugin.js` → `ext-store/…/generations/…`）
  + 重写 replace / uninstall 半场 + 动 `persistPluginPath` 的 `underAlphaPlugins` 圈禁
  （`ext-config.ts:1197`）。远超这条窄竖线；pin 是两个调用点。

### D6 — 引擎重扫：签名 package 安装路径必须接上

**决定**：照 Phase 3 `#784` 的 G20 形态修：
① 把 `extIpc.installCatalog` 的调用**收进 `use-extensions.ts` 这一层**，不让 `extension-hub.tsx` 直连；
② `refreshEngine()` 在这一层**接一次**，不在三个调用点逐处补；
③ dispose 失败**如实降级**为 `reload-pending`，不谎报「下一条消息里就能用」。

理由：`extension-hub.tsx:659 / :1094 / :1219` 今天全部 hub 直连 `extIpc`，main 只对 enabled MCP
补 dispose（`main/ext-ipc.ts:1068-1081`）。而 plugin 只在引擎实例构造时装载
⇒ **不接这条线，本相位的用户路径结构性不可能闭合**。

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

**今天的实况**：alpha-web 侧对这三样**没有任何拒绝闸**，只有事实提取 ——
`.node/.dll/.dylib/.so/.wasm` 只是 `intake-core.mjs:41-53` 的分类清单；`detectScriptSurface`
（`:148-171`）提取的 `packageScripts`/`bins` 在 curation 链上零消费；
`componentsFromNpmLock` 只解析 lockfileVersion 2/3，其余走 `unparsed` 分支如实上报覆盖缺口。
（沿用勘破结论，本轮未逐行复核，标**部分未验证**。）

**不变量**：
1. `opencode-plugin` profile 的资产**必须是单个自包含 JS 文件**。producer 编译期对
   ①声明了非空 `dependencies`、②package.json 带任一 install 期 script（`preinstall`/`install`/`postinstall`）、
   ③tarball 内含 `.node/.dll/.dylib/.so/.wasm` 任一，**一律具名拒绝编译**（fail-closed）。
2. 发布进 catalog 的资产字节 sha256 **必须逐字等于仓内 `resources/plugins/opencode-notify/plugin.js`
   的 sha256 = `22f80c93d8d87f6d29442e33740637608086358916e7111fbf630433de6e43a7`**，
   由一条测试比对，不靠目视。
3. 上游 tarball integrity **由 operator 一次离线 capture 后写进仓**（`npm view opencode-notify@0.3.1 dist.integrity`
   + `npm pack` 后提取 `dist/index.js` 的 sha256），并**如实登记为「不由闸门保证的性质」**（§7）。

**咽喉**：alpha-web `extension-package-core.mjs` 的 `validateBehavior` / `buildPayload` ——
新 kind 的分支末尾必须是**显式 fail**，不是隐式兜底（今天 `buildPayload:1347-1368` 就是隐式兜底）。

**绕过配方**：三个负向 fixture（带 dependency / 带 postinstall / 带 `.node`）各让编译器报**具名 error code**；
把任一分支删掉 ⇒ 对应 fixture 从红变绿。
⚠️ **不许写「构建期网络调用数为零」这条 AC** —— producer 结构上不联网，
该断言在 builder 被整个删掉时同样成立（§3 第 4 行）。

### 第 2 类 — 字节完整性（三层 tamper）

| 层 | 今天靠什么 | 本相位补什么 |
| --- | --- | --- |
| producer → catalog | 签名信封 + `payloadRef.sha256` | 新资产形状进同一套校验（不新造第二种信任语义） |
| catalog → 宿主 | `fetchPackageAsset`（`package-admission.ts:1047-1056`）双查 bytes + `redirect:"error"` | **补 timeout + 终态 URL 的 HTTPS/userinfo 复查**，与 payload 路径（`package-installability.ts:539/543/546-550`）对称 |
| 宿主 → 引擎 | CAS 内容寻址 + file action 的 `preDigest/nextDigest` + `seedPluginFileProbe` 在 pre-switch 比 digest（`ext-health-probe-router.ts:50-51`） | 复用，零新增 |

**咽喉**：`fetchPackageAsset` 一处。**绕过配方**：把 timeout 删掉 ⇒ 「服务端永不 EOF」的夹具必须
从「有界失败」变成挂住 ⇒ 用例红（用 fake fetch，不打真网络）。

### 第 3 类 — 运行时 npm 三条通道

**不变量**：managed plugin 的整条安装到装载路径上，**对 registry 主机零连接**。

**判据写法（这一条最容易变成假绿，措辞钉死）**：
- ❌ 不许写「没调用 `Npm.add`」—— 会被 `external.ts:77` 的第二个函数绕过。
- ❌ 不许写「网络调用数为零」—— 通道③（`config.ts:424-457`）**一直在发生**，与插件无关；
  把它算进来这条断言恒假，不算进来就要说清楚边界。
- ✅ 写成：**「managed 安装写进 `plugin[]` 的值，必须满足 `path.isAbsolute && endsWith('.js') &&
  underAlphaPlugins`」**（`ext-config.ts:1195-1197` 已有的谓词），并**独立地**断言
  「①②两条通道的 npm 分支谓词对这个值求值为 false」。
- ✅ **先证明这个观测手段能测出已知的坏**：故意把 config 值改成裸包名 `opencode-notify@0.3.1`
  ⇒ 断言必须红。**测不出已知的坏就打印「本次测量作废」，不给数字。**

**咽喉**：`persistPluginPath`（`ext-config.ts:1190`）。

### 第 4 类 — 双载：逐条点名六条腿

| # | 腿 | 今天有没有闸 | 本相位处置 |
| --- | --- | --- | --- |
| 1 | V1 加载器读 `plugin[]` 的绝对路径（`packages/opencode/src/plugin/index.ts:177-183`） | 有（同名派生路径闸 `findSameNamePluginPathEntry`） | 复用 |
| 2 | V2 `ConfigExternalPlugin` 读迁移后的 `plugins`（`external.ts:45`，**同一份配置**） | **无** | **D4 剥键**，结构性关闭 |
| 3 | npm 包名条目（catalog npm 分支 `ext-install-planner.ts:2142` / Hub 未策展导入） | 有（`findPluginBaseConflictStrict`，锁内 precondition 重跑） | 复用 |
| 4 | vendored / seed 插件（同名不同目录） | 有（`legacySameNamePluginGate`） | 复用；并新增「同名 managed 与 vendored 不得共存」一臂 |
| 5 | 引擎对工作目录 `{plugin,plugins}/*.{ts,js}` 的自动发现 | **无，alpha 完全看不见** | **不做**，如实登记（§7） |
| 6 | alpha 自有的 `.alpha/plugins/*.js` fanout（`@alpha-code/ext` 动态 import，第三套 ABI） | **无** | **不做**，如实登记（§7） |

**咽喉**：腿 1/3/4 共用 `persistPluginPath` 之前的那组 precondition；腿 2 咽喉是
`alpha-config-injection.ts:406` 一处；腿 5/6 无咽喉，故如实登记为已知边界而不是假装有闸。

### 第 5 类 — 授权披露的诚实性

**不变量**：
1. `alpha.engine-plugin.v1` 必须在 `CAP_VOCAB`（`ext-authz.tsx:27-34`）有词条、在
   `HIGH_RISK`（`:35`）集合里、en/zh 双份 i18n 都有文案。
2. **比补一个词条强一格的那条**：写一条**穷举测试**，从 host registry 的 `capabilities` 数组
   派生期望集，断言**每一个 host token 都在 `CAP_VOCAB` 里且有 i18n 文案**。
   ⇒ 下一个 host token 默认**红**，而不是默认渲染成 `?`。

**绕过配方**：
- 只加词条不加穷举测试 ⇒ 往 registry 加第四个 capability 而不补词条 ⇒ 应红而不红 ⇒ 说明只做了一半；
- 把 `HIGH_RISK` 里的新 token 删掉 ⇒ 高风险徽章消失 ⇒ 断言「授权屏渲染结果含高风险标记」必须红。
  ⚠️ **不许只断言 `CAP_VOCAB["alpha.engine-plugin.v1"] !== undefined`** —— 那是内层纯函数，
  一个忘了接 i18n 的实现照样满足它。要断言渲染出来的可观察结果。

### 第 6 类 — secret 不过线

**今天的实况**：`shared/package-secret-prerequisite.ts:101/122/162-170` 与
`shared/package-alpha-connection.ts:213-218` 对未登记的 payload schema **静默返回空 items**（fail-open）
⇒ 新 profile 的密钥前置**永远不会被采集**。

**不变量**：
1. `opencode-plugin` payload **不得**声明任何密钥前置，也不得携带 `alpha.secret-prerequisite.v1` /
   `alpha.connection.v1` / `alpha.mcp-oauth.v1`（schema 层 `additionalProperties:false` + capability derive 层双管）。
2. **把那两处的静默 else 改成「未登记即拒」** —— 这是把 fail-open 翻成 fail-closed，
   而不是给新 profile 加一个分支。

**咽喉**：这两个 `shared/` 文件各一处 else。
**绕过配方**：往 registry 里加一个第六 profile 但不在这两处登记 ⇒ 必须红（今天是静默放行）。

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

**绕过配方**：往 registry 加第六个 profile 但不加表项 ⇒ **必须红**（今天是静默变成 `mcp`）。
⚠️ **不许只断言「plugin profile 现在能正确分类」** —— 那是「期望值恰好等于可硬编码的常量」，
一个把 ternary 改成 `else → plugin` 的错误实现照样满足它。判据是**未登记的第六个 profile 被拒**。

**与 `ac#777` 的关系**：`#777` 讲的是「门在自己的环境里跑不出真结果」，这一条是
「枚举对新成员默认放行」—— 同族不同类。**本相位自己收口，不并进 `#777`。**

### 第 8 类 — 卸载残留

**不变量**：整包卸载成功后，四条**一起**断言（不是只断 `ok`）：
① `<root>/plugins/<name>@<hex>/` 目录不存在；
② `alpha.jsonc` 的 `plugin[]` 不含那条绝对路径；
③ `grants.json` 无对应 key；
④ CAS pin 账（`<baseRoot>/cas/v1/pins.json`）无该 digest。

**咽喉**：`removePackageChildArtifactsV1`（`ext-package-uninstall.ts:86-147`）新增的 plugin 臂。
**绕过配方**：把四条里任一条对应的清理动作删掉 ⇒ 对应断言红。
⚠️ 只断 `{ok:true}` 的写法通不过 —— 今天的 fail-closed 分支也返回 `ok:false`，
而一个「删了目录但没摘 config」的实现会返回 `ok:true`。

### 第 9 类 — GC 与 pin

**不变量**：
1. 安装成功后，把 GC 的 `graceMs` 设为 0 跑一轮 `collectCasGarbage` ⇒ 该 blob **必须还在**；
2. 整包卸载成功后，同样跑一轮 ⇒ 该 blob **必须被回收**。

这一对断言能同时杀掉两种错误实现：只写了 pin 没写 unpin（第 2 条红）、
写了 unpin 但漏了 pin（第 1 条红）。
⚠️ **不许只断言 `pinCasBlob` 被调用过**（spy 断言）—— 那是内层调用，一个把 digest 传错的实现照样满足它。
**要跑真的 GC，断言 blob 文件在不在。**

**咽喉**：`pinCasBlob` 在 promote 之后的那一个调用点 + `unpinCasBlob` 在卸载成功之后的那一个调用点。

---

## 6. 子票切分

> **七个无主跳的票主对照**（一个都不许漏）：
> ① host profile 定义 → **T1**；② host capability 新 token + renderer 词条 → **T1**（token/derive）+ **T5**（词条）；
> ③ 三跳 pin 搬运 → **T3**（web 侧升 pin）+ **T4**（code 侧 re-vendor）；④ 载荷传输 → **T1**（形状）+ **T2**（宿主取回）+ **T3**（producer 产出）；
> ⑤ 引擎重扫 → **T5**；⑥ 把第一个真实包签名发进 catalog → **T7**；⑦ Phase 4 的 VERIFY 矩阵 + 打包真机证据 → **T8**。
> 另有一张 **T6** 拥有 D4（V2 加载器不变量）。

### 旧票处置

| 旧票 | 处置 | 理由 |
| --- | --- | --- |
| `alpha-web#99` | **作废重开**（close as superseded，由 T3 承接） | 它声明的 4 个新文件一个都不该建（真正要改的是既有 `extension-package-core.mjs` 五处 + 已发布 artifact）；收货方 `#97` 已 CLOSED；两条 AC 里有一条是恒真式（§3 第 2/3/4 行）。**Boundary、Dependencies、AC 三样全被推翻，不是「改写沿用」能覆盖的量。** |
| `alpha-code#699` | **作废重开**（close as superseded，由 T1/T2/T5/T6 承接） | 7 条 dev-plan 里 5 条被推翻：第 1 条归属反了、第 2 条要改上游、第 3 条形态零先例、第 5 条三路已在生产、第 6/7 条已上线（§3 第 6–14 行）。验收 gate 的 ABI corpus 维度对准了一个**不存在的成员**。 |
| `alpha-web#108` | **保留不动，不并进 Phase 4** | 它管的是「第一个真实 package」这件事，形态由 owner 的内容决策（哪个远端 MCP）决定，与 managed plugin 无关。合并会把两个互不相干的 owner 决策锁在一张票上。**T7 只管 managed plugin 包**；若 owner 更愿意让 T7 成为第一个真实 package，那是一次编排裁决，不是本稿的默认。 |
| `alpha-work#49` Evidence map「AC8 \| `#700`」 | **改写该行**，指向 T8 | `#700` 已 CLOSED 且明写不含 managed Plugin（§3 第 21 行）。 |
| `alpha-code` vendored producer artifact 落后 aw@`6e0db57d` 一个 commit | **并进 T4** | T4 本来就要覆盖那批字节；但 PR 正文必须**单独列出**因 aw#112 frontmatter 变化而变动的宿主测试语料，不许混在 profile 变更里一笔带过。 |

### 票

| 票 | 负责哪些 AC / 决定 | 边界（具体文件） | out of scope | 退出条件 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| **T1** `[REQ-128][CODE] 宿主合同注册 opencode-plugin profile 与 alpha.engine-plugin.v1 能力,并重生 artifact` | D2、D7 的合同半场、②的 token 半场 | `packages/ui-mac/src/shared/host-extension-package-contract/`：`host-extension-package.registry.v1.json`（profiles/capabilities/limits 各按序插入）、`registry.ts:3` 联合 + `:4-7` + `:46-57` + `:77/:83/:87-90` 三处 exact-set、新建 `profiles/opencode-plugin.v1.schema.json`、`decoder.ts:55-60/:113-117/:285-301/:704-740` 解码臂与 `ScriptAssetRefV1`、`synthetic-decoder.ts`、`generate-artifact.ts:14-27/:64-143`、corpus、`host-extension-package-artifact.v1.json`、`CONTRACT.md`（§Profiles / §Exclusions:181-184）、`host-extension-package-artifact.test.ts:63-75` 与 `:165-166` | 宿主实现（admission/事务/卸载）、renderer、alpha-web 任何一行 | ① `bun generate-artifact.ts --check` exit 0；② `bun test src` 绿；③ 新 `artifactSha256` 写进 PR 正文（T3 要用）；④ `artifact.test.ts:178+` 的笛卡尔 derive 矩阵覆盖新 capability；⑤ 边界对夹具：`maxScriptAssetBytes` 恰好值接受 / +1 拒绝，且**期望值从 registry 读，不写字面量** | 无 |
| **T2** `[REQ-128][CODE] 宿主 kind 分流收口 + plugin 事务构造 + CAS pin/unpin + 卸载臂` | §5 第 2/6/7/8/9 类、D5、D7 的宿主半场 | `main/package-admission.ts:506/:672-681/:906/:511-519/:1047-1056`；`main/ext-package-lifecycle.ts:35-37/:349`；新建 `buildPluginTxItems`（`main/ext-package-tx-builders.ts`，复用 `seedPluginPayloadItems` 的 item 构造与 `extensionHealthProbeRouter`）；`main/ext-package-uninstall.ts:86-147` 新增 plugin 臂；`shared/package-secret-prerequisite.ts:162-170` 与 `shared/package-alpha-connection.ts:213-218` 的 else 翻成拒绝；`shared/package-admission.ts:88` wire 类型；`main/ext-cas.ts` 的 pin/unpin 两个调用点 | renderer 任何一行；`installPluginFromCas`（legacy 单装载体，**不复用、不改**）；alpha-web | ① 第 7 类的绕过记录：加第六个 profile 不加表项 ⇒ 红；② 第 8 类四条一起断；③ 第 9 类跑真 GC 断 blob 在不在；④ file item key 必须是 `plugin--<name>--f<i>`（否则 `ext-health-probe-router.ts:40-41` 拒），用一条用例钉住；⑤ 第 6 类：未登记 payload schema 的密钥前置从「静默空集」变「具名拒绝」，绕过记录在案 | T1 |
| **T3** `[REQ-128][CODE] alpha-web:发布端支持 plugin kind + 升 host pin 并重生 producer artifact` | D2 的 web 半场、D7 的 producer 半场、③的前半跳、§5 第 1 类 | `scripts/lib/extension-package-core.mjs`：`:46-53` PIN、`:575-589` `componentProfile`、`:591-687` `validateBehavior`、`:625-630` 与 `:729-734` **两处** kind 白名单、`:1297-1369` `buildPayload`（末尾改显式拒绝）、`:1376-1394` `deriveComponentCapabilitiesV1`、`:2157-2172` closure exact-set；`scripts/gen-extension-package-artifact.mjs:27-107` `HOST_ARTIFACT` 表、`:110-207` `HOST_REGISTRY_BYTES`、`:917-957` profiles mapping、`:982-989` **`excluded` 删 `managed-plugin`**；`scripts/lib/host-asset-parsers.mjs:92-95`；`.github/workflows/channels-ci.yml:48` 的 `ref:`；`contracts/extension-package/CONTRACT.md:33-37/125-140`；重跑 `node scripts/gen-extension-package-artifact.mjs` | alpha-code 任何一行；发布一个真实包（那是 T7） | ① `npm test` 绿（含 `assertVendoredHostContractPin` 的四个 error code 路径）；② 第 1 类三个负向 fixture 各报具名 code；③ 新 producer `artifactSha256` 写进 PR 正文（T4 要用）；④ PR 正文记录「T1 合并到 `alpha` 之后本仓 CI 会红，红的窗口从 X 到 Y」 | **T1**（要它的 artifactSha256）。**硬序见下** |
| **T4** `[REQ-128][CODE] alpha-code re-vendor producer artifact + lock + closure` | ③的后半跳 | `packages/alpha-contracts-consumer/vendor/alpha-web-extension-package/**`（逐字拷 T3 那个 commit 的 `contracts/extension-package/artifact/*`）、`packages/alpha-contracts-consumer/alpha-web-extension-package.lock.json`、`packages/alpha-contracts-consumer/src/extension-package-artifact.test.ts:142-172` 的 closure exact-set；**顺带把落后 aw@6e0db57d 的那批字节前移** | 宿主实现、renderer | ① `bun test src` 绿；② PR 正文**单独列出**因 aw#112 frontmatter 变化而变动的宿主测试语料（`package-mixed-bundle.fixture.ts`、`package-admission.test.ts`、`package-update.test.ts`、`ext-package-detail-wiring.cases.ts`），逐条说明为什么变 | T3 |
| **T5** `[REQ-128][CODE] renderer 半场:host capability 词条穷举闸 + 签名 package 安装路径接引擎重扫` | ②的词条半场、⑤、D6、§5 第 5 类 | `renderer/extensions/ext-authz.tsx:27-34/:35`；`renderer/i18n/{en,zh}.ts`；`renderer/extensions/use-extensions.ts`（新增收口方法，`refreshEngine()` 在这一层接一次）；`renderer/extensions/extension-hub.tsx:659/:1094/:1219` 改走 `ext.*` 不直连 `extIpc` | main 侧任何一行；`main/ext-ipc.ts:1068-1081` 的 MCP 补偿（不动） | ① 第 5 类的穷举测试（加一个不在词表的 host token ⇒ 红）；② G20 形态：三个入口的 spy 断言 `refreshEngine` 被调用**恰一次**，且失败时呈现 `reload-pending`；③ **含 UI 变更 ⇒ 先走 design-loop 出增量帧，批准后实现；帧内零票号零开发术语** | T2 |
| **T6** `[REQ-128][CODE] V2 外部加载器不变量:剥 plugin 键 + wrapper 不得导出 effect/setup` | D4 | `main/alpha-config-injection.ts:406`（copyFileSync → 读/剥/写）；wrapper 模板（与 T2 的 `buildPluginTxItems` 共用同一份，模板本体归 T2，本票只加不变量与测试） | 引擎任何一行；V2 profile / V2 ABI 支持 | ① 用真 `migrate()` + 真 `decodeInfo` 跑剥后配置，断言 `Info.plugins` 不含我们的路径；绕过 = 改回 `copyFileSync` ⇒ 红；② 断言 wrapper 导出键集不含 `effect`/`setup`；绕过 = 加一行 `export const effect` ⇒ 红；③ 断言剥键**不影响** `@alpha-code/ext`（它走 `OPENCODE_CONFIG_CONTENT`，`alpha-config-injection.ts:93-97`）与 V1 注入 | T2（共用 wrapper 模板）。**可与 T5 并行** |
| **T7** `[REQ-128][CODE] 把 opencode-notify 编成 managed plugin 声明并签名发布到 dev channel` | ⑥、D8、§5 第 1 类的 operator capture | alpha-web `catalog-src/packages/<name>/`（新建目录）、`catalog-src/curation/package.*/`、`catalog-src/intake/`；`scripts/build-catalog.mjs` 走既有路径；`scripts/catalog-channels.mjs promote --to dev`；operator 一次离线 capture 的 integrity 记录落 `docs/` | `preview` / `stable` 两条 channel（**不碰**）；legacy `entries[]` 的那条 `plugin:opencode-notify`（**保留不动**，两个通道并存） | ① 构建产物里 `packages[]` 出现该包，且**摘掉 `packages` 后 26 条 legacy entry 的字节与上一版已发布 release 相同**（不是与 `catalog-src/catalog.json` 比）；② 资产字节 sha256 == `22f80c93…`；③ `catalog-sweep.mjs` 在 `catalog-src/curation/package.*/` 出现后**会当场抛错**——本票必须给出裁决（先修 / 已知不修 + 留痕），不许静默；④ dev channel promote 成功，桌面端 dev 构建能浏览到 | T3、T4 |
| **T8** `[REQ-128][VERIFY] Phase 4 验证矩阵 + 每道闸的绕过实施记录 + 打包真机 L2` | ⑦、D3 的「证明不了什么」、`aw#49` AC8 的 Phase 4 半场 | `test-component/` 下的 case 与夹具；`docs/verification/2026-08-xx-req128-phase4/` 证据 | 任何生产代码改动 | ① §5 九类**每一类**都有一条「故意改坏 X ⇒ 它变红」的实施记录，写不出绕过的判为假闸并退回；② **打包真机 L2（dev BuildChannel）**：装 → 引擎重扫 → 在 `~/.opencode-notify.log` 里观测到 `EVENT RECEIVED:`（§2.11）→ 整包卸载 → 目录/config/grants/pin 四清零；③ **如实记录**「通知没有弹出」这一条，不许写成通过；④ 一切检索带 `-a`；⑤ 批量跑测试一律 `bash -c` 并核对 `Test Files N passed (N)` 的 N 与枚举数相等，测不到就打印「本次测量作废」 | 与 T2/T5 并行起草，T7 之后收口 |

### 硬序（不可换）

```
T1 ──> T2 ──> {T5, T6}
 └───> T3 ──> T4 ──────────> T7 ──> T8
```

- **T1 与 T3 必须同一 Iteration，且在同一个工作窗口内先后合并。**
  `T1` 一合进 `alpha`，alpha-web 主线 CI 立刻报 `E_HOST_ARTIFACT_DRIFT`
  （`extension-package-core.mjs:2268-2303`，runbook 明写 never waived）。这是设计如此、不可豁免；
  窗口期必须尽量短，并在两个 PR 正文里各留一次痕。
- **别绕过 T2。** 只做 T1+T3 会得到一个「合同认、编译器发得出、宿主 `:506` 把它当 mcp、
  卸载时 `:143-145` 拒绝」的包 —— 正是 `claude-plugin-install.ts:344` 已经点名的
  **装得上、卸不掉**。
- **T5 与 T2 必须同一 Iteration。** 「引擎重扫」这一跳跨了 main（T2 的事务落地）与 renderer（T5 的接线），
  按层拆票切断用户竖线是 Phase 1（漏 renderer 半场）与 Phase 2（漏三条跨仓竖线）各栽过一次的形态。

---

## 7. 如实登记的边界

**本相位做不到的事。这些不是缺陷，是已知条件；写在这里就是为了不让下一轮 review 把它们当漏掉的闸再开一次。**

1. **`opencode-notify` 在 macOS 上不会弹通知。** 两个 macOS 通知器只找一个我们故意不再分发的
   原生二进制（`plugin.js:299-313` / `:382-398`），README 与 `NOTICE.txt:46-47` 说的「osascript 回退」
   在代码里不存在（全文 `osascript` 只在 `:218` 判前台窗口）。
   ⇒ 本期的用户可观察产出是「装上了、引擎真派发到它」，不是「通知功能可用」。
   **AC 里不许出现「通知弹出」。**
2. **probe 证明不了真实引擎会派发 hooks。** D3 的隔离子进程探针只证明模块可导入、形状是 V1、
   `server()` 返回的键都在 `Hooks` 的 21 键里。生产还要过 `plugin_origins` 去重、
   `applyPlugin` 的 detect、file 源的 `id` 三关。这一条只由 T8 的真机证据关闭。
3. **只做 V1 ABI。** V2 那条腿靠「剥掉 `plugin` 键」结构性关闭（D4），**不做 V2 profile**。
   一旦将来要支持 V2，`{id, server, effect}` 是唯一的双注册形状，必须先钉死那一条。
4. **两条腿不管**：引擎对工作目录 `{plugin,plugins}/*.{ts,js}` 的自动发现、
   alpha 自有的 `.alpha/plugins/*.js` fanout（第三套 ABI）。两条都是用户可达的插件装载路径，
   **本相位的双载闸不覆盖它们**，也没有任何一张票拥有「alpha 要不要、以及怎么看见这两条通道」。
5. **同一插件、两个通道、两个身份。** legacy vendored 条目（`plugin:opencode-notify`，
   载荷含 `README.md`）与 managed package（载荷只有 `plugin.js`）的 `payloadDigest` 不等
   ⇒ 安装目录名不等、账本记录不等。**接受**（D7），并在 Hub 上表现为两条独立可安装项。
6. **版本号口径不一致。** catalog `entry.version = "1.0.0"` ≠ 上游真版本 `0.3.1`，
   而落账本、走 downgrade 闸的是前者（`ext-install-planner.ts:3711`）。
   managed 侧统一用 `0.3.1`；**legacy entry 不动**（改它会动一条已发布的 catalog 记录）。
7. **上游 tarball integrity 不由闸门保证。** 仓内零留痕（§2.11），本相位靠 operator 一次离线
   capture 写进仓。闸门能保证的只有「发出去的字节 == 仓内 vendored 的字节」（§5 第 1 类不变量 2）。
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
12. **部分未验证**：①§2.6 最后一条（`downloadRemoteAsset` 只接在 legacy planner 上）沿用勘破结论，
    本轮未逐行复核；②§5 第 1 类里 alpha-web intake 的三条「只提取不拒绝」沿用勘破结论，
    本轮未逐行复核；③`catalog-sweep.mjs` 在 package curation 目录出现后抛错这一条沿用勘破结论，
    本轮未实跑 —— **T7 开工前必须先跑一次确认**。
