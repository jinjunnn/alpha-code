---
title: REQ-128 标准扩展包、外部 Plugin 适配与兼容宿主安装方案基线
kind: design
status: accepted
owners:
  - alpha-code extension maintainers
  - alpha-web catalog maintainers
last_reviewed: 2026-07-30
review_after: 2026-10-30
---

# REQ-128 方案基线

本基线回答一个产品问题：发布者新增 Skill、Agent、MCP/Connection、OpenCode
Plugin 或它们的 Bundle 时，怎样在不发布新版 Alpha App 的前提下，让已经兼容的
宿主安全发现、授权、安装、更新和卸载；怎样把 OpenAI/Codex 与 Claude Code 的
外部 Plugin 包转换成同一条 Alpha 原生链路。

本需求的用户结果不是“支持任意第三方 Plugin”。结果是：

1. 发布者只维护一份作者声明或一个可转换的外部包；
2. `alpha-web` 确定性生成、准入并签名受支持的原生组件与 Bundle；
3. `alpha-code` 只执行本机静态声明支持的 profile/capability；
4. 新条目没有新宿主语义时只发布 Catalog；packages-only 条目对已发布 legacy App
   不可见，foundation host 缺 profile/capability 时才在任何副作用前显示需要更新，
   不会静默忽略后半段然后半安装。

协调需求是
[`alpha-work#49`](https://github.com/jinjunnn/alpha-work/issues/49)。本文固定
勘破事实、方案、被否决替代、安全不变量、开发切片和验证边界；GitHub Issues 与
Alpha Delivery 继续持有当前状态、Iteration 与交付证据。

## 1. 只读勘破

### 1.1 仓库与发布链

勘破基线为 `alpha-code@origin/alpha` 的 `a7c39a2a` 与当前 `alpha-web` 默认分支。
GitHub 当前把 `alpha` 设为 `alpha-code` 默认分支；仓内 `AGENTS.md` 仍写 `dev`，
这是独立的治理文档漂移，不改变本方案的代码基线，也不混入功能 PR。

`alpha-web` 现在的作者真源是手写
`catalog-src/catalog.json`。`scripts/build-catalog.mjs` 读取它、绑定资产 digest、
接入 curation，再由 signed channel 发布；还没有
`contracts/extension-package/`、`catalog-src/packages/` 或 package declaration CLI。
可以直接复用的底座是：

- `scripts/intake.mjs` 与 `scripts/lib/intake-core.mjs` 的离线 capture/intake；
- `scripts/lib/catalog-intake-core.mjs`、`intake-analysis.mjs` 与
  `curation-gate.mjs` 的 provenance、SBOM、摘要与准入；
- `scripts/build-catalog.mjs` 与 `scripts/catalog-channels.mjs` 的确定性构建、
  签名和晋级；
- `contracts/consumers/outbound-fixture-bump.md` 规定的 producer-owned、
  commit+SHA vendoring 协议。

现有 intake 拒绝 path traversal、symlink、FIFO 与 read-time TOCTOU，但 walker
尚无统一的文件数、单文件和整包上限；外部包入口必须在复用它之前补齐上限。现有
stable gate 对“没有 curation 的条目”会跳过，因此标准 package 需要一个额外的
package choke point：root 和全部 emitted child（含 optional）未完成 curation、Compatibility
Report 含 `blocked`、或 `review-required` 的精确 report digest 未获批准时，不得写
stable pointer。

### 1.2 Desktop Catalog 与执行边界

当前 `CatalogEntry` 位于
`packages/ui-mac/src/renderer/extensions/catalog-types.ts`，执行字段以内联
`installSpec` 和 `bundleItems` 表达。`packages/ui-mac/src/main/remote-catalog.ts`
与 `catalog-channels.ts` 对 Catalog 外壳只浅验 `{version, entries[]}`，然后把 entry
交给 renderer；main 的 `ext-install-planner.ts` 再从已知字段合成严格的
`ExtensionManifestV2`。

这形成一个已验证的前向兼容漏洞：在已知 MCP entry 上增加未知的
`futureRequiredSemantics`，当前 main 会丢弃该字段，再让合成后的
`ExtensionManifestV2` 严格校验通过。故不能把 `requiresHostCapabilities`、
`minAppVersion` 或新 auth 字段直接加进现有 `entries[]`，并声称旧 App 会
fail closed；已经发布的 App 根本不知道该字段是 required。

当前 Bundle 的真实原子闭包只包含 Skill、无密钥且非 workspace 的 MCP 与 Cloud
receipt。`ext-install-planner.ts` 会跳过 Agent、Plugin、带 secret/workspace 的 MCP
和嵌套 Bundle；它会解析传递图与查环，却只安装 root 的直接 child。Bundle 还没有
自己的 install record。Agent 与 vendored Plugin 已各有单装事务，但实现是整段
executor，不是供 Bundle 组合的 planning builder。

MCP secret 版本目前位于事务 root 之外，并且在 config transaction 前写入；普通
`TxFileAction` 刻意只允许 root 内相对路径。不能为了 Bundle 把它扩大成可删除任意
绝对路径的通用文件事务。现有 secret MCP 结果还会把替换后的 `liveMcp` 真值从 main
经 preload 回给 renderer，再由 renderer 调 SDK；标准 prerequisite 实现必须消除这条
secret 回显缝。

`InstallRecordV2` 没有 package graph、parent、claim 或 owner set，Bundle 也没有
record。现有 `ext-ownership.ts` 表达的是策展/支持责任，不是安装图 ownership，不能
复用。CAS 已按内容共享，不需要再造 CAS refcount；真正缺失的是“谁仍有权要求 child
留在受管配置中”。

### 1.3 OpenCode Plugin

当前 Catalog npm Plugin 安装只把 `package@version` 写进配置和 receipt。真正下载
发生在 engine runtime 的 `packages/opencode/src/plugin/shared.ts`，通过
`packages/core/src/npm.ts` 的 `Npm.add` 执行；未钉版本会变成 `latest`，cache 命中
不重验 Alpha 管理的完整性。npm 安装已经使用 `ignoreScripts: true`，无需重复造一套
script disable。

runtime 只用可选 `engines.opencode` 做有限检查，OpenCode 0.x 会绕过；loader 还允许
从 V1 default object 回退到 legacy 任意函数 export。Plugin 在 engine 进程内运行，
获得 client、workspace registration 与 `Bun.$`，本质是同用户权限的可执行代码。
静态扫描可以发现依赖与明显脚本，不能证明其未来网络、文件或子进程行为。

因此 Catalog-managed npm Plugin 不能继续把 npm 当作运行时安装通道。npm 只作为
发布端来源事实；发布端固定 exact version、tarball integrity 和依赖闭包，拒绝 native
module 与 install-script dependency，把所有声明依赖字节 vendored，产出纯 JS ESM 的不可变 managed
artifact。Desktop 复用 remote asset → CAS → vendored Plugin 事务，安装 Alpha 生成的
strict V1 wrapper，避免回退 legacy export。用户手写的本地/npm legacy Plugin 可以作为
unmanaged 逃生口保留，但不得标为 Catalog-managed 或 verified。

managed Plugin 的健康门不等待 App restart，也不承诺提交后自动回退：授权后、config
switch 前启动同版本 packaged engine probe subprocess，strict import wrapper，执行
bounded V1 init + dispose/cancel；timeout、异常或 ABI 不符使 transaction pre-switch
失败，旧 config 从未切换。probe 通过后才 switch + V3 mutation commit。网络域、文件与
子进程清单只能标为 author-declared / intake-observed non-exhaustive；可强制事实是 ABI、
artifact digest、无 native/install-script dependency 与 engine-process runtime surface。

### 1.4 外部格式不是 Alpha Runtime ABI

OpenAI/Codex 与 Claude Code Plugin 是外部输入格式，不是 Alpha 要模拟的 runtime。

OpenAI 在勘破时同时存在两层格式：

- [`openai/codex@6219b7c40fc9c702c0aef9964e72b492558f60e4`](https://github.com/openai/codex/tree/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/core-plugins)
  的 legacy `.codex-plugin/plugin.json`
  [`manifest.rs`](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/core-plugins/src/manifest.rs)
  与
  [`loader.rs`](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/core-plugins/src/loader.rs)，
  覆盖 metadata、skills、MCP、apps、hooks 与 interface，并对相对路径做约束；
- root `plugin.json` 的新
  [`agent_plugin_manifest.rs`](https://github.com/openai/codex/blob/6219b7c40fc9c702c0aef9964e72b492558f60e4/codex-rs/core-plugins/src/agent_plugin_manifest.rs)
  schema。官方
  [`openai/plugins@11c74d6ba24d3a6d48f54a194cd00ef3beea18f9`](https://github.com/openai/plugins/tree/11c74d6ba24d3a6d48f54a194cd00ef3beea18f9)
  示例仓仍大量使用 legacy `.codex-plugin`，且文档与 runtime 对 hooks 的支持口径仍有漂移。

本期只实现 commit-pinned 的 legacy curated profile。root Agent Plugins 格式明确
报告 `blocked/unsupported-format`；以后可新增 provider adapter，但不得让运行中的
Desktop 下载 adapter 代码。

Claude Code
[`Plugins reference`](https://code.claude.com/docs/en/plugins-reference) 规定 Plugin
manifest 可省略，存在时只有 `name` 必填；未知字段在非 strict 模式可能只是 warning。
其组件与路径合并语义覆盖 skills、commands、agents、workflows、hooks、MCP、output
styles、LSP、themes、monitors、user config、channels 和 dependencies，并区分
`${CLAUDE_PLUGIN_ROOT}`、`${CLAUDE_PLUGIN_DATA}` 与 `${CLAUDE_PROJECT_DIR}`。

本期不复制 Claude loader。只映射明确支持的 Skill、Skill-backed command、Agent 与
MCP 子集；其余执行语义逐项 `blocked` 或在确有等价映射时 `review-required`。
manifest/name/version 缺失只能由 operator 的 import spec 显式补齐，不能从目录名或
`unknown` 静默生成 immutable identity。

## 2. 选定模型

### 2.1 三层合同

三层合同各有一个权威，不合并成万能 Manifest：

| 层 | 权威 | 用途 |
| --- | --- | --- |
| 外部 provider manifest | 外部作者与对应生态 | import 输入；只在固定 adapter profile 下解释 |
| `AlphaPackageDeclarationV1` | `alpha-web` | 作者入口、组件来源、presentation/auth prerequisite 与 Bundle root |
| `HostExtensionPackageV1` artifact | `alpha-code` | `AlphaPackageEnvelopeV1` 浅 header、profile payload schemas、正交 capability vocabulary、legacy projection profile 与 host testvectors |
| `AlphaPackageEnvelopeV1` instance | `alpha-web` compiler | 按 pinned host artifact 生成并进入已签 Catalog；`alpha-code` 只消费同版 artifact |
| `ExtensionManifestV2` | `alpha-code` main | 已知组件的严格执行、事务和 receipt identity |

`AlphaPackageDeclarationV1` 不含签名、策展结论、派生能力摘要、SBOM/provenance 或
secret 值。compiler 生成这些事实并拒绝作者声明与扫描事实冲突。`ExtensionManifestV2`
继续只做执行合同，不承载页面、OAuth 流程或作者源格式。

合同依赖只允许单向：

```text
alpha-code host contract
→ alpha-web declaration/compiler + provider producers
→ alpha-web final producer corpus artifact
→ alpha-code production evaluator/wiring
```

不建中央 contract repo 或 npm contract 包。`alpha-code` 先发布 git+commit+SHA 的 host
artifact；`alpha-web` pin 后才可编译 package；最终 producer corpus 再由 Desktop pin。
这样 web 不发明 host profile/capability，host 也不复制作者 declaration。

### 2.2 正交轴

类型、聚合、来源、载荷、能力、认证和展示独立建模：

| 轴 | v1 值 |
| --- | --- |
| 原生 profile | Skill / Agent / local MCP / remote MCP / OpenCode Plugin / Cloud |
| 聚合 | 单组件 package / 一根 Bundle + 固定 leaf components |
| 外部来源 | alpha-native / openai-codex-legacy / claude-code / opencode-npm |
| 载荷 | signed remote asset / HTTPS MCP config / Alpha Connection reference / builtin |
| 运行表面 | model context / local child process / engine process / remote service |
| 认证 | none / secret prerequisite / MCP OAuth / registered Alpha Connection |
| presentation | bounded text、现有 icon 与受控链接；无 HTML/JS/iframe |

Connector 只是商品分类，Connection 是独立服务认证对象，Bundle 只是安装聚合；
三者都不创造新的 runtime kind。Claude command 本期投影为 Skill-backed command；
不增加一等 `command` kind。

### 2.3 Catalog 迁移：冻结 `entries[]`，新增 `packages[]`

Signed Catalog 外壳保留，`entries[]` 的 **schema/profile/transform** 永久冻结为
legacy projection，内容仍可按唯一 transform 更新；新增 sibling
`packages[]: AlphaPackageEnvelopeV1[]`。现有 App 的浅外壳解析会忽略 `packages[]`，
仍只看到它理解的安全 legacy 条目。foundation App 同时消费 legacy entry 与 package。

发布端必须执行下面的单一降级不变量：

> 任何新 component profile、required host capability、auth prerequisite、Bundle
> graph 或执行语义都不得投影进 legacy `entries[]`。只有能逐字段证明与旧执行语义
> 等价的 package 才可生成 legacy projection；否则它只存在于 `packages[]`。

host artifact 固定 `legacy-entry-v1` profile、`LEGACY_PROJECTION_PROFILES_V1` 与
canonical projection bytes 算法。oracle 以已发布
`v0.1.0@02373249`、`v0.1.1@43bd0e50`、`v0.1.2@cf60bd3b` 的 parser/planner 共同语义
为保守闭集；测试把 compiler 输出送进 pinned old-host oracle 并比较预期 plan。
`scripts/lib/extension-package-core.mjs` 中唯一 `compileLegacyProjection()` 可生成
`entries[]`；provider adapter 和作者均无此权威。新 profile/capability/auth/graph
默认 packages-only。没有安全 projection 时允许该 package 在 `entries[]` 中为零，
不能为满足非空而塞入新语义；其他真正 legacy-safe 内容可继续存在。

Package 与 legacy projection 由同一签名 snapshot 绑定。每个浅 prelude 固定
`{packageId, version, legacyProjectionDigest}`；digest 使用 host artifact 的 canonical
bytes 算法。发布端拒绝同 ID/version 冲突、projection 目标不存在、digest mismatch 与
mix-and-match。foundation host 对同 ID package 永远 shadow legacy：package/prelude
malformed 或 binding mismatch 时拒绝该 package ID，绝不 fallback 到同 ID legacy；
连 prelude 都无法安全解码时拒整个新 snapshot并回到 LKG。

`AlphaPackageEnvelopeV1` 的 bounded header 至少包含：

- package identity/version、bounded presentation 与 legacy projection binding；
- 固定排序的 component descriptors：
  `id/required/dependencies/profileId/profileVersion`；
- compiler 从 profile/auth/aggregation 派生的逐组件 capability 与 package union；
- **只允许** content-addressed payload ref：`sha256/bytes/mediaType/url`；
- bounded Compatibility/curation disposition refs。

provider/adapter/rules/input、完整 report、provenance 与 SBOM digest 不进入 pre-gate
header；它们在 capability/profile 通过后由已签 payload/ref 提供。Envelope 禁止 inline
object payload，保证旧 App 只 JSON-parse 固定浅 header，新 host 过门后才下载并解析执行
payload。Catalog 本身继续受总字节、对象数量、字符串与 header depth 上限。

main 的固定顺序是：

1. 验签 exact Catalog bytes；
2. 只解 bounded envelope header，执行 bytes/depth/count/control-char 上限；
3. 用 app 内静态 Host Capability Registry 比较 profile/version 与所有 required token；
4. 缺失、未知或 profile/version 不匹配时返回 `update-required/blocked`，且
   payload decoder、asset download、secret/OAuth、CAS、planner 与磁盘调用数均为零；
5. optional unsupported child 精确标为 skipped；
6. 只 dispatch 已知 profile 的严格 payload decoder；
7. 再合成 `ExtensionManifestV2` 并进入现有授权/事务。

Host Capability Registry 是 `alpha-code` 拥有的静态数据。`profileId/profileVersion`
负责 payload schema/decoder 门；capability token 只表达跨 profile 的正交行为，例如
MCP OAuth 或 atomic Bundle。package capability 是 compiler 从 component/profile/auth/
aggregation 派生的 union，作者不能另加 raw token。Catalog 不能注入 registry 或 decoder
代码。v1 runtime registry 只需 token→semantic support 与 profile/version support；
introduced/retirement 历史留在文档/testvector，不造运行时历史服务。

### 2.4 `alpha-web` 作者与发布流程

新作者源固定为：

```text
catalog-src/packages/<package-id-dot>/<version>/alpha-package.json
catalog-src/packages/<package-id-dot>/<version>/compatibility-report.json  # provider import 时
catalog-src/assets/<component-id-dot>/<version>/...                         # 复用现有资产树
```

`scripts/lib/extension-package-core.mjs` 是唯一严格 validator/compiler。
`scripts/package-declaration.mjs validate|preview` 只读；不新造 `publish` wrapper。
runbook 继续串现有 `intake.mjs → build-catalog.mjs → catalog-channels.mjs promote`。
唯一 producer 流水线是：

```text
declaration
→ NormalizedPackageBuildRecord(root + every required/optional component)
→ asset capture / intake / SBOM / provenance / curation
→ host-contract Envelope + payload assets
→ optional compileLegacyProjection()
→ one signed snapshot
```

curation 以 normalized package/component record 为入口，不依赖 legacy `entries[]`。
所有 emitted child，包括 optional executable child，都必须完成 curation；optional 只表示
旧宿主不支持时可 skip，不能绕过发布审查。root curation decision 可写
`approvedCompatibilityReportSha256`，仅 `review-required` 必填；它由 reviewer/curation
gate 写，作者和 adapter 不可写。compiler 把 approval disposition 绑定进已签 Envelope。
唯一 `assertPackagesReadyForStable(payload)` 在 `catalog-channels.mjs promote stable`
写 pointer 前检查：`blocked` 永不 build/sign，review-required 可 preview 但未批准 exact
digest 不得 stable，root 或任一 child 未策展不得 stable。

compiler 在 `build-catalog.mjs` 内存中生成 package、payload assets 与安全 legacy
projection，再复用现有 signing。仓库不提交第二份 generated catalog fragment。

v1 只接受“一根 package root + 固定 leaf components”。provider adapter 与 compiler
都不生成 nested Bundle；Desktop 遇到未 flatten 的 Bundle child 在下载前明确拒绝。
不实现 runtime 递归、通用 DAG solver 或 semver solver。

provider adapter 是纯函数：输入经 hardened capture 的文件表与 operator import spec，
输出 declaration 与 Compatibility Report；无网络、subprocess、dynamic import、模板求值
或 package script。OpenAI 与 Claude 是两条独立 adapter 实现，共用同一个 reader/report/CLI
registry，不新建“adapter framework”工程。

每个 declaration 总有一个 package root；单 leaf 也走 root curation，只有 leaf 可在命中
legacy profile 时投影。component `id/version` 唯一派生
`catalog-src/assets/<component-id-dot>/<version>/`，作者不能填写任意资产根路径。package
目录、manifest identity、report identity 必须一致；unknown file、symlink、identity
collision 与非 canonical 顺序拒绝。remote/no-payload component 使用显式 profile。

文件入口上限为每组件最多 512 files、单文件 16 MiB、整 package 64 MiB、最大路径深度
32、manifest JSON nesting 64。前三个数字复用 seed 现值，后两个是本合同新增；所有常量
由 host/producer artifact testvectors 读取，provider 不可覆盖。package-only asset v1
只走在线 content-addressed Catalog asset，不扩 seed/offline precache schema。

Catalog-managed npm Plugin 由独立的 `alpha-web` producer 负责。它接受 operator 已离线
capture 的 exact tarball、registry `dist.integrity`、lock/dependency bytes 与声明，不在
build 中联网、不运行 script/bin；`scripts/lib/managed-plugin-artifact.mjs` 固定完整
dependency closure，拒 native 与 install-script-dependent package，产出 pure-JS ESM
content-addressed asset、provenance、SBOM 和 host profile payload。它不承诺静态证明
Plugin 未来不会动态联网；运行时始终披露同权限 engine-process code。Desktop 只消费
最终已签 artifact ref。

### 2.5 Desktop 单一兼容权威与页面

main 新增唯一 `evaluatePackageForHost()`。Catalog refresh、browse、detail 与 install IPC
都调用它；renderer 只得到 bounded `CatalogPackageViewV1`，不再得到 raw execution
payload、asset URL、config 或 secret target。safe view 使用一份 main-owned
discriminated wire schema：

```ts
CatalogPackageViewV1 {
  verdict: "compatible" | "update-required" | "blocked"
  action: {
    kind: "install" | "update-alpha" | "resolve-prerequisite" | "none"
    enabled: boolean
    reasonCode: PackageReasonCode
  }
  componentSupport: {
    skippedOptional: Array<{ componentId: string; reasonCode: PackageReasonCode }>
  }
  prerequisites: {
    status: "ready" | "required-action" | "optional-disconnected"
    items: SafePrerequisiteSummary[]
  }
  presentation: BoundedPackagePresentation
}
```

`optional-unsupported` 不是顶层 verdict，`connection-required` 也不是；它们分别落在
`skippedOptional` 与 prerequisite status。`update-required/blocked` 的 action 不得是
install，preload 不暴露可绕过的 install method。`reasonCode` 是 host enum 并由本地 i18n
映射；provider 文案只能作为 bounded presentation，不能决定按钮或安全原因。

install IPC 继续只接收 `catalogId`、scope、admission attempt ID 与瞬时 user grants；
main 重取已验 Catalog、重新兼容判定并构造 plan，renderer 篡改状态无效。

通用详情页复用现有 `extension-detail.tsx` 与 card，不为 provider 或 Bundle 新建页面。
信息顺序固定为：

1. 名称、说明、作者、版本与 provenance；
2. installability：compatible / update-required / blocked；
3. required/optional components 与 optional skip；
4. 能力、网络域、运行时和下载事实；
5. secret/OAuth/Connection prerequisite 摘要；
6. Compatibility Report 的 mapped/review-required/blocked；
7. 现有安装确认与授权入口。

安装按钮与原因只消费 main projection，点击后 main 仍重判。v1 复用现有 icon，不新增
截图 gallery 或媒体代理框架；HTML、JS、SVG、iframe 与远程安装向导全部拒绝。后续新增
媒体是独立产品增量；本期不预建 slot/registry。

需要覆盖的 UI 状态是：

| safe-view 组合 | 主动作 | 必须可见的事实 |
| --- | --- | --- |
| compatible | 添加 / 更新 | 组件、能力、auth prerequisite |
| update-required | 更新 Alpha | 缺失的 capability/profile；不能触发安装 IPC |
| blocked | 不可安装 | provider mapping 或安全门阻止原因 |
| compatible + skippedOptional | 添加支持的部分 | skipped child 与影响；required child 不可 skip |
| compatible + required-action | 连接后继续 | service identity 与独立 consent；不把连接说成安装授权 |

现有页面布局、card 与明暗 token 不变；这是状态和数据源增量，不另造通用 UI framework。
实现验证用五个 canonical state shots，并 pairwise 覆盖 theme、长文本、无 icon 与键盘焦点，
不做完整乘积。

### 2.6 Secret、OAuth 与 Connection

package auth declaration 只含稳定 secret ID、label、required 与 injection target metadata，
不含值。Desktop 远程安装只 decode host-owned Envelope auth-prerequisite profile，不 decode
web Declaration。renderer 只在表单短生命周期内存中采集瞬时值；值不得进入持久/全局 state、
log、telemetry、preload result 或 receipt。main 校验 declared set 并写现有受限 secret store。
标准链路删除现有 `liveMcp` secret 真值回显，改为写盘后由 main/engine reload 或 reconnect。

MCP OAuth 不在 Electron 重写。复用 engine 已有 discovery、DCR、PKCE、state、callback 与
token store。Alpha account OAuth 是另一身份，不复用。MCP OAuth 与 registered Alpha
Connection 拆成两张 CODE，因为协议/记录 owner 不同。

MCP OAuth 协议权威边界固定为：

- `alpha-code` main：验 `{catalogId, prerequisiteId, envelopeDigest}`，创建 opaque
  `PackageConnectionAttemptV1` 并把安装绑定到 service identity、attempt 与 connection ID；
- engine MCP route：OAuth discovery/callback/token protocol authority；
- renderer：只运输 attempt ID、打开受控 browser、显示状态，不持有 token。

main 通过现有 authenticated local sidecar typed route 发起/查询 MCP auth，不直接 import
engine OAuth，也不让 renderer 代发自由形状请求。现有 engine 的 `0600 + flock` token
store 作为本期接受边界；切换 safeStorage/keychain 是独立 engine-storage 需求，不是 rider。

registered Alpha Connection v1 由 main-owned 静态 `AlphaConnectionHandlerV1` allowlist 与
`ConnectionRecordV1` repository 负责。handler interface 固定
`begin(attempt) / status(attemptId) / disconnect(connectionId)`；service identity 与 reuse
key 由 handler 返回的 bounded record 决定，renderer 不传。未知 handler 在 auth 前 fail。

required connection 的顺序是：验已签 prerequisite → create/reuse connection →
explicit service consent → durable connection ready → 本地事务只绑定 connection ID。
auth 前取消零本地安装写；OAuth 成功后的远端 consent 不是本地事务可回滚副作用。若后续安装
失败，保留可复用 Connection 并诚实显示；需要 provider 侧撤销时给出独立动作，不声称 rollback。

optional connection 可以“已安装、未连接”，但 runtime 必须显示 unavailable/disconnected。
卸载 package 不自动 revoke shared connection。专有 `connectionHandlerId` 只能命中 App 内
静态 allowlist，未知 handler 在发起 auth 前 update-required。

安装 capability 授权、service OAuth consent 与 runtime MCP tool permission 是三种不同同意，
不得合并成一个开关或收据字段。

### 2.7 Package admission 时序

`PackageAdmissionCoordinator` 是 main 的唯一安装 admission，不新增第二套授权账本；它复用
现有 transaction authorization 作为最终闸。时序固定为：

```text
signed snapshot + shallow Envelope/payload refs
→ main 下载/严格 decode 已知 payload，构造不含 secret value 的完整 plan preview
→ capability authorization
   绑定 signedSnapshotDigest + packageEnvelopeDigest + graphDigest
   + itemManifestDigests + exact capability set
→ required MCP OAuth / Alpha Connection ready
→ renderer 短生命周期采集 secret values
→ main 重取同一 signed snapshot，重算全部 digest/capability/prerequisite binding
→ existing transaction authorization final check
→ runExtensionTransaction
   → prepared secret populate
   → candidate probes
   → config switch + single ledger mutation
```

任一 digest、Catalog snapshot、graph、manifest 或 capability set 漂移都废弃 attempt、
清空瞬时 secret 并回到 preview；旧 `confirmed[key]=capabilities` 不能授权新代码。用户在
capability authorization 前不会做 OAuth 或写 secret；OAuth 后本地安装失败沿 §2.6 的
外部副作用语义处理。required prerequisite 未 ready 时 transaction 调用数为零。

### 2.8 Bundle 事务与 secret prepared resource

单装与 Bundle 共用纯 planning builders 和唯一事务执行器：

- `buildAgentTxItems`
- `buildVendoredPluginTxItems`
- `buildMcpTxItems`
- `extensionHealthProbeRouter`

builder 返回 items、receipt、preconditions、prepared resources 与 typed probe；
执行仍只有 `runExtensionTransaction`。builder/probe router 的行为零变化抽取是一张独立
enabling CODE，只做 parity tests；production mixed Bundle activation 在 V3 repository、
managed Plugin、secret prepared resource 与 admission coordinator 全部完成后由 #697
接线，不能先制造无 owner 的 V2 mixed install。

secret 不扩大普通 `TxFileAction`。它使用现有 append-only version 目录作为受限 prepared
resource：

1. 未授权 plan 不写 secret；
2. 确认重驱后在 populate 阶段写 0700/0600 version；
3. config switch 前不可达；
4. journal 只记录类型化 `mcp-secret-version` 标识，不记录值或任意绝对删除路径；
5. recovery 复用现有 merged reference collector/resolver，检查 main + retained legacy
   config、规范化相对/`~/`/`./` 路径并比较 filesystem identity/symlink alias；任一来源
   不可读或 identity 不确定时保守不删。

workspace 空目录属于非权威 provisioning，失败后允许由受控 GC 清理；原子权威是 config、
receipt 与引用事实。不要为了空目录造一个任意文件系统事务框架。npm Plugin 只有先在发布端
编译为 managed vendored artifact，才能复用 Bundle Plugin builder。

### 2.9 Bundle graph、claim 与卸载

新增 `installs.json` envelope V3，继续复用 V2 child record，新增严格
`packageGraphs` 与 `claims`。唯一事务提交对象是：

```ts
PackageLedgerMutationV1 {
  transactionId: string
  operation: "install" | "update" | "uninstall"
  packageRecord: PackageRecordV1
  graphBeforeDigest: string | null
  graphAfter: PackageGraphV1 | null
  childRecordMutations: ChildRecordMutationV1[]
  claimMutations: ClaimMutationV1[]
}
```

它只挂在 root package receipt item。artifact child items 仍持 capabilities/probes，
但不各自驱动 ledger commit。`commitReceipt`、`receiptCommitted` 与 crash replay 都对
同一 mutation 做 exact replay；V3 repository 一次验证并一次 rename，不能出现“child
records durable 但 graph/claims 缺失”。

ownership 存 owner set，不存可漂移整数 refcount：

- `standalone:<kind>:<name>`
- `bundle:<bundle-id>@<manifestDigest>`
- `legacy-protected`

同一个 exact `kind/name/version/manifestDigest` 可共享；不同 exact digest/version 在
计划期拒绝，不做 semver 求解或同时激活。Bundle 只拥有安装 claim，不拥有用户的 enable、
grant 或 Connection。卸载先释放自己的 claim；只有 owner set 为空、child 明确 managed 且
没有 legacy protection 时才删除。所有删除路径仍由 kind/name 与受控 root 派生，graph 数据
不能作为路径输入。

旧 V2 记录一律迁移为 `legacy-protected`，不猜它是否来自历史 Bundle。V3 repository
cutover 必须覆盖全部 ledger read-modify-write 生产入口：standalone install/update/
uninstall、enabled state、transaction/uninstall recovery、import/adoption/migration、
Bundle mutation 与普通 record upsert/remove。standalone install 写 standalone claim；
standalone uninstall 在仍有 Bundle owner 时只释放 claim，不删实物。旧 V2 App 遇到 V3
envelope 必须拒写，避免 downgrade 静默抹掉 claims。CAS 不新增 refcount。

在 V3 repository 与 graph-aware direct uninstall 全部落地前，foundation host 不广告
`alpha.install.package.v1`；`packages[]` 只能 browse/update-required，不能 production
install。本期只承诺未完成 transaction 或 candidate probe 失败时用 journal before-image
即时回滚，旧 graph 从未被淘汰；成功 commit 后不承诺任意时间恢复上一 graph。persistent
LKG/multi-generation rollback 另立 retention 需求。

## 3. 被否决替代

- **往 legacy `entries[]` 加 required 字段**：旧 App 会静默丢弃，已被 ground-truth
  probe 证伪。
- **单独换一个 Catalog v2 URL**：现有 signed channel 给客户端同一稳定路由，无法让已发布
  App 自动切换；也不能解决错误降级投影。
- **远端下发 provider adapter/decoder JS**：把 Catalog 更新变成 main RCE。
- **复制 OpenAI/Claude 完整 loader**：持续同步无底洞，且把外部 host 语义误称等价。
- **一个万能 Manifest/schema**：混淆作者、展示、认证、执行和 receipt 权威。
- **provider-specific 页面或自定义 HTML**：扩大 XSS/跟踪/兼容面，新能力仍需 App 发版。
- **Desktop nested Bundle/semver solver**：发布端已经能固定 leaf graph，运行时求解没有用户收益。
- **第二套 Bundle installer**：现有事务、单装 action 与 probe 足以组合。
- **把 `TxFileAction` 扩到任意绝对路径**：把 secret cleanup 变成通用删除能力。
- **Runtime 现场 npm install Catalog Plugin**：下载不在 Alpha 事务/完整性闭包内。
- **静态扫描承诺 Plugin 细粒度沙箱**：Plugin 是同权限进程内代码，扫描不能强制未来行为。
- **自研通用 Plugin sandbox**：不属于本期最小闭包。
- **重写 MCP OAuth 或顺手切 token storage/engine generation**：已有协议底座；后两者需独立需求。
- **自助发布门户、registry service、npm contract 包**：没有本期用户结果，git+commit+SHA
  artifact 已够。
- **笛卡尔积“全排列”验证**：组合爆炸；使用 contract corpus、pairwise canonical matrix
  与一次 packaged RC。

## 4. 安全攻击类与不变量

### 4.1 发布/解析

- path traversal、absolute/UNC/drive/NUL/control chars、symlink/hardlink/FIFO/device、
  TOCTOU；
- decompression bomb、巨型文件、文件洪泛、深目录、深 JSON；
- prototype pollution、duplicate ID、canonical JSON/NFC/order/clock/env/locale
  nondeterminism；
- manifest custom-path shadow、default discovery 差异、`${...}` host-path escape；
- import/validate/preview/build 执行 package script/hook/bin 或访问网络；
- author 伪造 curation/signed/derived facts，或声明 token/cookie/secret value；
- adapter/profile/version/rules/input/report digest 被替换或同版本重写历史结果。

不变量：所有文件在同一 capture choke point 和上限下读取；adapter 纯函数；派生事实只有
compiler/intake 可写；`blocked` 不签；`review-required` 未批准 exact report digest 不进
stable；root 或任一 emitted child（含 optional）失败时 package stable pointer 不存在。

### 4.2 宿主兼容与 renderer

- signed semantic smuggling、capability token reuse、profile/version confusion；
- legacy/package downgrade 或 mix-and-match；
- envelope gate 前触发 payload parser bomb/download/secret/OAuth/CAS；
- renderer compromise、UI/install TOCTOU、篡改 auth/ability/installability；
- presentation URL/media tracking、HTML/SVG/redirect parser 面。

不变量：main 静态 registry 和唯一 evaluator 是 installability 权威；unknown required
语义在任何副作用前拒；renderer 只持 safe view 和瞬时 grants；main 每次安装重取已签事实；
v1 无远程自定义 UI。

### 4.3 Secret、OAuth 与 Connection

- secret 经 DOM/log/IPC/result/receipt/telemetry 泄漏；
- undeclared secret、轮换/撤销 stale reference；
- OAuth CSRF、state/PKCE、callback port/redirect mixup、token-server binding、
  stale/concurrent auth；
- external consent rollback illusion；
- proprietary handler confused deputy、shared connection 被 Bundle 卸载误 revoke。

不变量：secret value 只在采集内存与受限 store；OAuth protocol authority 不在 renderer；
required connection ready 前 installer 调用数为零；外部 consent 不伪造 rollback；
Connection 生命周期独立于 package claim。

### 4.4 Transaction、graph 与 Plugin

- secret prepared resource orphan、journal 注入绝对删除路径；
- tampered/duplicate owner、unknown child、graph digest mismatch、dangling claim；
- standalone/Bundle 共享 child 误删、版本冲突双载、downgrade 抹 ledger；
- Plugin captured tarball/closure tamper、signed file-table mismatch、Desktop CAS tamper、
  dependency drift、native/install-script dependency；
- malformed/legacy ABI fallback、double load、activation/probe 失败。

不变量：事务只有全旧或全新；owner set 与 graph/record 一致；legacy/unmanaged 永不 GC；
exact digest 冲突写盘前拒；managed Plugin 只从 Alpha CAS strict wrapper 激活，绝不进入
runtime `Npm.add`；授权明确显示“同权限 engine-process code”。

## 5. 开发切片与依赖

每个 CODE ticket 是一个可独立 review 的实现边界；票内若列两个 PR，它们共享同一 choke
point 且必须顺序合并，不再为纯机械切片建管理票。

| 交付线 | 代码边界与 PR 切片 | 依赖 |
| --- | --- | --- |
| Host contract (`alpha-code#694`) | 发布/校验 `HostExtensionPackageV1`：shallow Envelope、payload profiles、正交 capabilities、legacy oracle/transform/testvectors；只含 synthetic decoder tests，不接生产 UI/IPC | 本基线 |
| Web declaration/compiler (`alpha-web#95`) | PR A：web-owned Declaration/Report、pin host artifact、纯 validator/compiler、`validate/preview`；PR B：NormalizedPackageBuildRecord、`build-catalog` merge、package-only curation/stable gate、唯一 legacy projection、runbook | #694 |
| Web OpenAI adapter (`alpha-web#96`) | commit-pinned legacy `.codex-plugin` curated profile、恶意 corpus、确定性 report | #95 |
| Web Claude adapter（新 CODE） | manifest-present curated profile、显式 supported/blocked fields、恶意 corpus | #95 |
| Web managed Plugin producer（新 CODE） | 离线 captured exact npm tarball/closure → pure-JS ESM content-addressed artifact、SBOM/provenance；build 零网络/零脚本 | #95 |
| Web producer artifact (`alpha-web#97`) | generic+provider+managed-plugin profile/rules/input/report vectors，path+SHA+producer commit、generator drift 与 bump runbook；不声称下游已接线 | #96、Claude adapter、managed Plugin producer |
| 单一兼容接线（新 CODE） | pin #97；`evaluatePackageForHost()` 接 Catalog refresh/browse/detail/install preflight，输出冻结 safe view，main 重判 | #694、#97 |
| 通用详情页 (`alpha-code#695`) | 复用现有 detail/card；三值 verdict + optional/prerequisite 组合、pairwise L2 matrix；v1 无 gallery | 单一兼容接线 |
| Secret prerequisite (`alpha-code#696`) | Envelope prerequisite decode、main-owned store/reference、消除 `liveMcp` 回显、replacement/uninstall/stale negatives | #694 |
| MCP OAuth prerequisite（新 CODE） | main attempt/binding + authenticated engine OAuth route、required/optional 与外部 consent 诚实语义 | #694 |
| Alpha Connection prerequisite（新 CODE） | static handler、main-owned records/reuse/status/disconnect、unknown handler fail | #694 |
| Bundle builder/probe enabling（新 CODE） | 行为零变化抽 builder/router + 明确拒 nested；unit/wiring parity，不做 mixed activation | 本基线 |
| V3 repository cutover（新 CODE） | `PackageLedgerMutationV1`、all-writer V3 cutover、graphs/claims、direct uninstall、migration/downgrade/rollout gate | #694、builder enabling |
| MCP secret prepared resource（新 CODE） | 类型化 `mcp-secret-version` journal/recovery 与 workspace policy；复用 merged reference resolver | Secret prerequisite、builder enabling |
| Package admission coordinator（新 CODE） | digest-bound capability authorization → OAuth/Connection → transient secret → revalidation → transaction/V3 mutation | 单一兼容接线、V3 repository、builder enabling、Secret、MCP OAuth、Alpha Connection |
| Managed Plugin (`alpha-code#699`) | signed managed artifact → CAS strict wrapper；authorization 后的 pre-switch packaged engine probe、double-load/ABI/integrity gates | admission、#97、Web managed Plugin producer |
| Mixed Bundle activation (`alpha-code#697`) | Agent + managed Plugin + secret/workspace MCP 走一个 admission/transaction/V3 mutation；canonical fault/crash evidence | builder enabling、V3 repository、prepared resource、#699、admission |
| Bundle lifecycle (`alpha-code#698`) | graph diff、update/uninstall、claim release、managed GC、fault recovery | #697 |
| Local import parent (`alpha-code#215`) | 保留 REQ-034 身份，拆下面两条 CODE；本期 directory+archive，无 URL import | declaration/report contract |
| Local pure adapter（新 CODE） | normalized file snapshot → declaration/report；消费 #97 的 OpenAI/Claude profile/rules/corpus | #97 |
| Local prepared-plan/import（新 CODE） | `compilePreparedLocalPackageForHost()` 只调 host decoders/builders，`source=user-imported`；picker/capture → digest preview → admission/transaction；Skill/Agent/MCP/flat Bundle，hooks/Plugin/Alpha Connection blocked | local pure adapter、builder enabling、prepared resource、MCP OAuth、admission、#697 |
| Capability VERIFY (`alpha-code#700`) | contract corpus + pairwise canonical harness 可先做；依赖合并后统一 packaged RC | 本基线；最终结果等待所有 CODE |

关键路径：

```text
baseline
  → code #694 host contract
  → web #95 → {OpenAI, Claude, managed Plugin producer} → web #97
  → code single evaluator
  → {detail, secret, MCP OAuth, Alpha Connection, builder enabling}
  → {V3 repository, secret prepared resource}
  → admission → managed Plugin → mixed Bundle → graph update/uninstall
  → packaged VERIFY
```

OpenAI/Claude/managed Plugin producers 在 #95 后并行；local pure adapter 在 #97 后并行。VERIFY 的
corpus/harness 可以立即开发，不因实现票未完成而标成 Blocked；只有最终 packaged PASS
等待依赖。

## 6. 每票确定性退出门

### Web

- `extension-package-contract.test.mjs`：schema/limits/unknown required semantics；
- `package-compiler.test.mjs`：双跑 byte identity、flat fan-out、ID collision、derived
  capabilities/auth、single-leaf root、asset identity、blocked/report approval；
- `package-build-wiring.test.mjs`：真实 `build-catalog` → curation → signed release，
  package-only 正常；手写 derived/projection fields、optional/required child 未策展、
  report digest 替换在 stable pointer 前拒；
- `legacy-package-projection.test.mjs`：唯一 transform；package-only 新语义在
  `packages[]` 存在而 `entries[]` 为零；输出经 v0.1.0–v0.1.2 old-host oracle 得到固定 plan；
- `openai-codex-adapter.test.mjs` 与 `claude-code-adapter.test.mjs`：normal/partial/
  unknown/malicious/deterministic；测试不拉外网、不运行 provider CLI；
- `managed-plugin-artifact.test.mjs`：build 零网络/零 script/bin、exact integrity、
  closure 全 vendored、native/install-script dependency 拒绝、输出可重现；
- `extension-package-artifact.test.mjs`：artifact 路径、SHA、canonical bytes、no live
  secrets、generic/provider/plugin rules+vectors、generator drift。

### Envelope、页面与 auth

- `host-extension-package-artifact.test.ts`：shallow header、payload-ref-only、profile/
  capability authority、legacy oracle 与 synthetic decoder corpus 的 path+SHA artifact；
- `package-envelope-v1.test.ts`：unknown/missing profile/cap 对 payload fetch/decoder/
  secret/OAuth/planner 调用数均为零；optional skip；known payload unknown behavior key
  strict reject；
- `catalog-package-legacy-compat.test.ts`：old hosts只见 safe entries；foundation shadow、
  malformed/binding mismatch no-fallback/LKG；
- `package-installability.wiring.test.ts`：browse/detail/install 走同一 evaluator，
  safe-view reason/action exhaustive，renderer tamper 无效；
- `ext-package-presentation.test.ts` 与 named L2 matrix `req128-package-detail`；
- `package-secret-prerequisite.test.ts`：undeclared/cancel/replacement/uninstall/stale/
  no-value 与 `liveMcp` result 缝消失；
- `package-mcp-oauth.wiring.test.ts`：真实 authenticated engine route、PKCE/state/callback/
  cancel、attempt/service binding；
- `package-alpha-connection.test.ts`：static handler、reuse key/record owner、unknown handler、
  shared disconnect boundary；
- `package-admission.wiring.test.ts`：固定 §2.7 时序，authorization 绑定 snapshot/envelope/
  graph/item/capability digest；漂移清空 attempt/value；required-ready 前 transaction=0。

### Bundle、ledger 与 Plugin

- canonical mixed Bundle：Skill + Agent + managed vendored Plugin + secret MCP +
  已策展但当前宿主不支持的 optional child；
- 对 download、secret populate、config stage、typed probe、receipt commit 与现有
  `TX_CRASH_POINTS` 注入，始终全旧或全新；
- owner-set model/property test 随机执行 standalone、Bundle A/B install/update/
  uninstall/retry/crash，并守住 graph/claim/record/GC 不变量；固定 seeds、有限 operation
  length，失败打印 seed + shrunk sequence；canonical permutations 永远执行，fuzz 仅补充；
- V3 repository test 枚举全部 ledger writer；第一个 V3 write 后 standalone update/
  enable/uninstall、recovery、import 与普通 upsert 仍可工作；direct uninstall claim-aware；
- root-only `PackageLedgerMutationV1` crash replay 证明不存在 child-only durable；
- ABI corpus：合法 V1、legacy-only、未知 ABI、invalid dispose/cancel；
- integrity negatives：producer captured tarball/closure、channel file-table 与 Desktop CAS
  三层 tamper，dependency drift、native/install-script dependency；
- production wiring 断言 managed entry 只到 Alpha CAS wrapper，绝不进入 `Npm.add`；
- candidate probe timeout/throw/ABI fail 全在 config switch 前，旧 config 未动；
- packaged RC 只跑一次真实 mixed install → restart → hook/tool → failed pre-switch update →
  old version healthy → uninstall。

### Local import 与 capability

- `external-package-adapter.test.ts`：两 provider good/partial/unknown/malicious；
- `external-package-import.wiring.test.ts`：picker→snapshot→preview→confirm→host prepared plan，
  `compilePreparedLocalPackageForHost()` 标记 user-imported 且只调 host APIs；
  cancel 零写、digest mismatch/replay 拒；unsupported Plugin/hook/Connection 明确 blocked；
- `external-package-corpus-equivalence.test.ts`：消费 web artifact，path/symlink/archive
  bomb/script 全部拒且不执行；
- #700 使用 contract corpus 与有界 pairwise matrix，不跑笛卡尔积；每格记录 producer、
  consumer、expected verdict 与 evidence path。

## 7. 明确不做

- project-scoped managed Catalog install；
- 自助 publisher portal、namespace 申诉/转移、计费或开放 marketplace；
- OpenAI root Agent Plugins、MCP Apps UI；
- Claude hooks/LSP/workflows/output styles/themes/monitors/user config/channels/dependencies；
- 一等 `command` kind；
- URL import；
- native OpenCode Plugin、通用 sandbox、细粒度动态行为强制；
- screenshot gallery 或远程页面；
- package-only asset 的 seed/offline precache；
- nested Bundle、semver solver、多代 graph retention 或 Plugin commit 后自动健康回退；
- 通用 secret manager/credential rotation 产品面；
- 新 OAuth stack、token store migration 或 engine generation switch。

## 8. 审计记录

2026-07-30 第一轮为三条并行只读勘破：

- `alpha-web`：定位作者/发布 choke point、外部官方格式、provider ticket 边界与
  producer-owned artifact 责任；
- `alpha-code host`：用 ground-truth probe 证实 legacy unknown semantic 会被静默丢弃，
  固定 dual projection、main evaluator、secret/OAuth/Connection 边界；
- `alpha-code Bundle/Plugin`：定位单装 action、事务 root、V2 ledger、npm runtime
  安装与 ABI/health 缺口。

本稿采用的收敛原则是：只修会导致错误安装、越权、跨仓无人负责或实现返工的阻塞项；
可选媒体、通用 provider framework、sandbox、多代 retention 与组合爆炸验证均被排除。
不以增加抽象或票数本身作为“严谨”。

第二轮由三条勘破线交叉对抗，判定 BLOCK；本版已逐项处置：

| 审计阻塞 | 处置 |
| --- | --- |
| web Envelope 与 host capability/profile 形成循环权威 | Envelope/profile/capability/legacy oracle 改为 `alpha-code` host artifact；依赖固定为 host → web compiler/producers → web corpus → host wiring |
| inline payload 使旧 App 在门前解析未知执行对象 | v1 payload-ref-only，Catalog 只含固定浅 header；未知 profile/capability 下 fetch/decoder 为零 |
| legacy projection 只是口号，consumer 可能 fallback | 固定三版 released old-host oracle、唯一 transform、canonical binding；foundation shadow 同 ID，malformed/mismatch 不 fallback |
| package-only 组件进不了现有 curation | 增加 NormalizedPackageBuildRecord；所有 emitted child 策展；root 批准 exact report digest；stable 唯一 gate |
| managed npm artifact 无 producer | 独立 alpha-web CODE，离线 capture、零网络/零脚本、closure vendored；Desktop 只消费签名 ref |
| auth/secret/Connection/transaction 时序未定 | 增加 digest-bound PackageAdmissionCoordinator 固定时序，复用既有 transaction authorization |
| V3 journal 可能只提交 child receipt | root-only `PackageLedgerMutationV1`，commit/replay 只有一个原子 mutation |
| V3 后旧 writer 全拒写 | V3 票扩大为 all-writer repository cutover，并在完成前不广告 package install capability |
| mixed Bundle 先于 ownership 会制造无法迁移记录 | builder parity 独立 enabling；V3/prepared/plugin/admission 后才由 #697 激活 |
| Plugin activation/rollback 会膨胀成跨 restart 状态机 | 收窄为授权后、switch 前 packaged engine probe；成功 commit 后不承诺自动回退 |
| 本地 import 会复制 web compiler 或绕 host gate | 增加 `compilePreparedLocalPackageForHost()`，只调 host APIs，明确支持/blocked profile |
| safe-view 状态、OAuth/Connection seam 未冻结 | 冻结三值 verdict + optional/prerequisite 组合；MCP OAuth 与 Alpha Connection 拆票并固定 owner/interface |

同时删除或降级了无本期收益的设计：profileVersion 不再叠加重复 schema capability；
registry 历史不进入 runtime；header 不塞完整 provenance；UI/测试不跑状态乘积；不做
Plugin post-commit auto rollback、动态行为证明、seed 扩展或通用 prepared-resource framework。

第三轮只检查以上 blocker 是否真正闭合，不再接受新增可选范围。

第三轮收敛审计结论：三条审计线判定前述 contract/producer、old-host downgrade、
package-only curation、auth admission、V3 atomic mutation/all-writer cutover、managed Plugin
producer/probe、local import trust bridge 与依赖方向全部 **CLOSED**；没有新增技术 Blocker。
最后发现的 Plugin probe 依赖反向已修正为
`V3 + prerequisites + builder → admission → managed Plugin → mixed Bundle`。两处 optional
child 文案也已统一为“所有 emitted child 必须策展；optional 只允许宿主不支持时 skip”。

Owner approval：2026-07-30，owner 要求本需求完成“逐票勘破 → 开发计划 → 交叉审计 →
Ready 门”，并授权把审计通过的最小方案与拆票作为开发接手基线。本版据此 accepted；
后续改变合同权威、payload-ref-only、old-host no-fallback、admission 时序、V3 mutation
或 Plugin pre-switch probe，必须回到父需求重新裁决，不能作为实现期顺手优化。
