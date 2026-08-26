---
title: REQ-128 —— 桌面端对公网 stable 的 package:alpha-first 浏览/详情/安装取证
kind: verification
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-08-26
review_after: 2026-11-26
---

# aw#163 · 桌面端浏览 / 详情 / 安装 `package:alpha-first`(公网 stable)

票:[jinjunnn/alpha-web#163](https://github.com/jinjunnn/alpha-web/issues/163) ·
父需求:[jinjunnn/alpha-web#108](https://github.com/jinjunnn/alpha-web/issues/108) ·
能力矩阵:[alpha-code#700](https://github.com/jinjunnn/alpha-code/issues/700)

被测树:`alpha-code` 分支 `aw-163`,base `alpha` @ `8e30bdb77`(含 `ac#1132` / PR #1137,
`CHANNEL_BASE_URL` 已指向 `codepuppy.cn`)。**未改任何生产代码** —— 本次变更只有本目录的证据
与两个 harness。

## 0. 结论

| AC | 判定 | 一句话 |
| --- | --- | --- |
| 1 · package-capable desktop build 在 Extensions hub 浏览到 `package:alpha-first` | **PASS** | 真 IPC 面从 `codepuppy.cn` 取到已验签 catalog;真 Solid DOM 的生产 `ExtensionHub` 里出现 `[data-package-card="package:alpha-first"]`,且**只有它一张**卡 |
| 2 · 详情页正确 | **PASS** | `ext-package-detail` 返回值逐字段等于独立 curl 到的载荷;点开卡片后生产 `ExtensionDetail` 的标题/简介/版本/五个小节全部对上 |
| 3 · 安装成功;skill 落到预期 targetDir | **PASS** | 生产 admission 两趟(authorize → confirm)提交成功;两个资产按 sha256 逐字节落进 `<globalRoot>/ext-store/skill--alpha-first/generations/<genId>`;**引擎自己的读**(`packages/ext` 的 `injectSkillGenerationPaths`)在启用后恰好注入那一个目录 |
| 4 · 证据落 `docs/verification/` + 在 #108 / #700 矩阵留言 | **PASS**(本目录) | 留言由主 session 发,见票面 |

一条必须一起读的既定行为:**目录安装的 skill 落账为 `desiredState: "disabled"`**
(`packages/ui-mac/src/shared/ext-install-policy.ts:68`:`origin==="catalog"` 且
`source !== "alpha"` ⇒ 保守面)。所以「装完立刻可用」不成立,用户还要在 Hub 里启用一次。
这不是本票的缺陷,是 #395/#397 的既定策略;记在这里,是为了让 §3 里
「未启用时引擎注入的 `skills.paths` 为空」有一个诚实的解释,而不是被读成安装没生效。

## 1. 地面真相 —— 独立 `curl`,不经任何生产代码

原始输出:[`results/raw-curl-ground-truth.txt`](results/raw-curl-ground-truth.txt)。

```
https://codepuppy.cn/catalog/v1/channels/stable.json   → http 200, sequence=11,
                                                          target 2026-08-25.2 / 95220 B
release catalog sha256 = 1bdc9ad8d1bff83252eaa41cb1bc48b4bced7553e570439b4f1379b65c14b99d
entries=28  packages=1  → package:alpha-first@1.0.0 / root skill:alpha-first
payload sha256 = 495b415b…db45dc (624 B), behavior.targetDir = "alpha-skills"
  LICENSE.txt  1065 B  91d6e75b…3dde5
  SKILL.md     2679 B  27e1b014…9d3cdca
https://alphacodeone.com/catalog/v1/channels/stable.json → curl (35) SSL_ERROR_SYSCALL（旧域已停用）
```

两个 harness 的期望值都是**从这一份逐字抄写的独立字面量**,不 import 生产常量 ——
比较基准与被测对象同源就是自指等价链,那样的绿不含信息。

## 2. 两个 harness 各自证什么

| harness | 位置 | 覆盖 | 跑法 |
| --- | --- | --- | --- |
| IPC + 安装 | [`harness/live-desktop-package.ts`](harness/live-desktop-package.ts) | AC1 的数据链、AC2 的 wire 契约、AC3 全程、5 条负向对照 | `bun docs/verification/2026-08-26-req128-163-desktop-live-package/harness/live-desktop-package.ts` |
| 真 DOM 渲染 | [`../../../packages/ui-mac/test-component/aw163-live-catalog-hub.live-cases.ts`](../../../packages/ui-mac/test-component/aw163-live-catalog-hub.live-cases.ts) | AC1/AC2 的**用户可见 DOM** | `cd packages/ui-mac && bun test ./test-component/aw163-live-catalog-hub.live-cases.ts` |

**两个都打真网络,因此都不进任何闸门**,也都不在 `packages/ui-mac/src` 下(`bun test src` 的采集面)。
DOM harness 用 `.live-cases.ts` 后缀而不是 `.cases.ts`:仓里每个 `.cases.ts` 都由一个
`src/**/*.test.ts` 起子进程跑、是闸门的一部分,这一份**没有也不该有**那个 spawner。

DOM harness 存在的理由是一句现成的话:`test-component/ext-package-detail-wiring.cases.ts`
第 1–3 行自己写着「随包 catalog 当前没有 `packages[]`……**不声称线上已经有 package 流量**」。
本票要证的正是那句被排除掉的话,所以只改一件事 —— catalog 不是夹具,是
`refreshRemoteCatalog(userData, "stable")` 从公网拉下来并全链验签的**那一份**。

### harness 自己的两个已知偏离(诚实记录)

1. **`GlobalRegistrator.register()` 会把 `globalThis.fetch` 换成 happy-dom 的同源策略实现**,
   于是 main 侧 catalog 客户端拿到 `Cross-Origin Request Blocked`、整条链 fail-closed。
   那是 harness 自己造的假红(生产 main 跑在 Node 里)。做法:注册前存下 Node 的 `fetch`,
   注册后**还原全局** —— 撤掉 harness 加的垫片,而不是往生产代码注入 dep。
2. `window.api.ext` 的非 catalog 方法(安装/卸载/inventory 等)是常量桩。DOM harness 只证
   浏览与详情两条读路径;安装由 IPC harness 走真实现证。

## 3. 逐条 AC 的命令 · 真实返回 · 判定

三轮采样,逐轮全绿:
[`results/ipc-install-round1.log`](results/ipc-install-round1.log) ·
[`round2`](results/ipc-install-round2.log) ·
[`round3`](results/ipc-install-round3.log) ·
[`results/hub-render-round1.log`](results/hub-render-round1.log) ·
[`round2`](results/hub-render-round2.log) ·
[`round3`](results/hub-render-round3.log)。

```
$ bun docs/verification/2026-08-26-req128-163-desktop-live-package/harness/live-desktop-package.ts
  → exit 0 · checks=70 failures=0   （×3 轮逐轮相同）

$ cd packages/ui-mac && bun test ./test-component/aw163-live-catalog-hub.live-cases.ts
  → exit 0 · 1 pass / 0 fail        （×3 轮逐轮相同）
```

`expect() calls` 在三轮里是 157 / 157 / 204 —— 差异全部来自 `waitFor` 的轮询重试次数,
不是用例数变化(`Ran 1 test across 1 file` 三轮相同)。**不要**把它读成不稳定。

### AC1 —— 浏览

走的生产路径:

```
ipcMain.handle("ext-remote-catalog")                      ← registerPackageCatalogReadIpcHandlers
  → refreshRemoteCatalog(userData, "stable")               零 deps ⇒ 真 fetch / 真 CHANNEL_BASE_URL / 真内置公钥
  → catalog-channels 全链验签(trust → snapshot → channel → payload,CONTRACT §5)
  → evaluateCatalogPackagesForHost(逐组件取载荷 + sha256 钉死 + profile 解码)
  → projectRemoteCatalogForRenderer
  → renderer installableCatalogPackages()               ← extension-hub.tsx:886-888 的同一个函数
  → 生产 ExtensionHub 渲染 [data-package-card]
```

真实返回:

```
source=remote  via=channel-stable  channel=stable  version=2026-08-25.2  error=null  (108 ms)
catalog.entries = 28   catalog.packages = 1
installableCatalogPackages(...) → ["package:alpha-first"]
卡片 = {"catalogId":"package:alpha-first","verdict":"compatible","prerequisite":"ready","action":"安装"}
DOM  = document.querySelectorAll("[data-package-card]") → ["package:alpha-first"]
```

判定 **PASS**。三条让「一个错误实现也能满足」变不成立的细节:
`source` 必须是 `remote`(临时 userData 无缓存、`via=channel-stable` 排除 legacy v1 面);
卡片清单断言的是**相等**不是**包含**;搜索框打 `zzz-no-such-package` 后卡片数掉到 0、清空后回来 ——
DOM 真的挂在这份数据上,不是一张静态夹具。

### AC2 —— 详情

走的生产路径:`preload/index.ts:228 packageDetail()` → `ipcMain.handle("ext-package-detail")`
→ `extension-detail.tsx:148-152` 的 `createResource`。

真实返回(逐字段对独立字面量):

```json
{"catalogId":"package:alpha-first","verdict":"compatible",
 "action":{"kind":"install","enabled":true,"reasonCode":"package-compatible"},
 "components":[{"componentId":"skill:alpha-first","role":"root","required":true,
                "included":true,"skipReasonCode":null}],
 "prerequisites":{"status":"ready","items":[]},
 "presentation":{"displayName":"Alpha install check","description":"A single first-party skill…","version":"1.0.0"}}
```

wire 键集恰为 `[action, catalogId, components, prerequisites, presentation, verdict]`(不多不少);
整个 package 面过线的字节里没有 `payloadRef` / `catalog/assets` / `sigUrl` / `https://` / 载荷 digest。

DOM 侧(生产 `ExtensionDetail`,zh locale):

```
h2       = "Alpha install check"
about    = "A single first-party skill that checks an Alpha extension package finished installing …"
version  = "版本 1.0.0"
sections = ["简介","可安装性","组件与前置条件","原因","动作"]
组件小节含 "skill:alpha-first";可安装性小节含「兼容」;动作小节含「安装」
```

负向:未知 `catalogId` → `null`;非字符串 `catalogId` → `null`。判定 **PASS**。

### AC3 —— 安装

走的生产路径:`createPackageAdmissionCoordinator`(与 `ext-ipc.ts:359-380` 同形,零 deps),
两趟 authorize → confirm,落 `runExtensionTransaction`。

```
preview  → ok=false stage=authorize "package admission: exact package plan requires confirmation"
  plan.items[0] = {componentId:"skill:alpha-first", key:"skill--alpha-first", kind:"skill", name:"alpha-first",
                   payloadDigest:"sha256:495b415b…db45dc",
                   operations:["write-generation","write-install-record","write-capability-grant"]}
  binding.snapshotDigest = e9f813c5…d4243   ← 等于 §1 裸取 snapshot.json 的 sha256
  授权 diff = 一行、capability 空集、requiresConfirmation=false（纯 skill 包）

commit   → {ok:true, kind:"skill", name:"alpha-first", installed:["skill:alpha-first"], skipped:[]}
```

落点由**生产的**指针解析器交出(不是我们拼一条路径去 `existsSync`):

```
resolveLiveGenerationDir(root, skillGenerationKey("alpha-first"))
  = <globalRoot>/ext-store/skill--alpha-first/generations/gen-000001-<hex>
目录内文件 = [{LICENSE.txt,1065,91d6e75b…},{SKILL.md,2679,27e1b014…}]   ← 与公网资产逐字节相同
SKILL.md frontmatter name（生产 parseSkillFrontmatter）= "alpha-first"
<root>/skills/alpha-first 不存在（generation 是单一真源)
账本 packageGraphs = ["package:alpha-first"],root=(skill, alpha-first),origin=catalog,desiredState=disabled
```

**引擎的读**(不是「断言引擎会读的那个文件」)——
`packages/ext/src/gen-skill-paths.ts::injectSkillGenerationPaths`,即引擎 config hook 真正调的那个:

```
desiredState=disabled                    → 注入 skills.paths = []          （fail-closed 允许集）
setInstallStateByKey({type:"skill",name:"alpha-first",scope:"global",state:"enabled"}) → {ok:true}
再读                                      → cfg.skills.paths = ["<…>/ext-store/skill--alpha-first/generations/gen-000001-<hex>"]
                                            且该目录里确有 SKILL.md
```

判定 **PASS**。

## 4. 负向对照 —— 先证明这套观测能测出已知的坏

《观测手段自己有盲区》要求的那一步。五条全部在 IPC harness 的 §4,逐轮复现:

| 对照 | 做了什么 | 实际结果 |
| --- | --- | --- |
| 4a | 把内置信任根换成另一把合法 ed25519 公钥 | `source=none`,`reasonClass=security`,日志 `R1 trust signature INVALID` + `legacy v1 fallback FORBIDDEN` |
| 4b | 载荷取回时换成 `{}` 字节(digest 不匹配) | 卡片落 `verdict=blocked` / `action={kind:none,enabled:false,reasonCode:package-payload-integrity}` |
| 4c | admission 传一个未发布的 `catalogId` | `ok=false`,`catalogId not found in verified Catalog` |
| 4d | 重放已消费的 `attemptId` | `ok=false`,`package admission: stale or replayed attempt` |
| 4e | 用**同一个生产客户端**打旧域 `alphacodeone.com` | `source=none`(TLS 起不来)—— 上面的绿不可能来自任何旧域内容或缓存 |

另外两条不是设计的对照,是 harness 真的红过、修完才绿的:
①binding 字段名猜错(它没有 `catalogVersion`/`version`)→ FAIL 两条;
②授权 diff 期望写成空数组、实际是一行空 capability → FAIL 一条。
**这套记账真的会红**,不是恒绿的装饰。

## 5. 本票没有覆盖的

- **已发布的 `v0.1.3` 桌面版够不着新域** —— 它把旧域编译进了二进制
  (`git show v0.1.3:packages/ui-mac/src/main/catalog-channels.ts:30`),生产无运行期覆盖口。
  那是发版要解决的问题,不是本票 AC(AC 原文是「package-capable desktop build」)。
- **packaged 构建的端到端**(真 Electron 进程、真 `app.getPath("userData")`)未跑;
  本票按 AC 允许的「IPC / install log digests」取证。
- **启用后引擎会话里真的能用到这个技能**(engine 侧 skill 发现之后的执行面)不在本票,
  §3 只证到「引擎的 config hook 注入了那个目录且目录内容正确」。
