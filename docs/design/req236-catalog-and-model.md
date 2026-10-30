---
title: REQ-236 T07–T10/§2.4 与 REQ-237 方案基线:启动目录、模型选择与清单远程更新
kind: design
status: draft
owners:
  - Code Puppy desktop and runtime maintainers
last_reviewed: 2026-10-30
review_after: 2027-01-30
---

# 启动目录、模型选择与清单远程更新

**给 owner 的一段话。** 你在 0.1.22 里点「新对话」时,输入框下面常常挂着「正在同步…」半分钟以上,
期间发不了消息,也没有按钮可点;旧版本号的安装提示、所有平台模型共用一个字母图标、选了模型却可能被
别的设置换掉,都属于同一组「界面说的和实际在跑的对不上」。本文把这些现象逐条追到源码与你机器上的
日志,结论是:等待主要不是云端慢,而是本机界面向本机引擎发的请求排不上队(待一次实测确认);
模型清单今天有两份各自打包的副本,平台的名字/能力和自带 Key 的预置清单都要发版才能更新。
方案让一个后台刷新器负责两份清单的拉取和缓存,选择器与引擎读同一份「已应用」的清单,
等待时说清卡在哪并给出出口。不做的话,这些问题每 10 分钟随令牌续期重来一次,且新模型永远要等发版。

服务 [REQ-236 / alpha-work#118](https://github.com/jinjunnn/alpha-work/issues/118) 的 T07、T08、T09、T10
与 T24 §2.4「模型」,以及 [REQ-237 / alpha-work#119](https://github.com/jinjunnn/alpha-work/issues/119) 的 AC1–AC3。
不覆盖:是否为普通续期重启引擎、令牌热应用、MCP 逐服务启动、Office 运行依赖、上游同步隔离
(引擎生命周期 lane `req236-lifecycle`);权限三档与来源分类(权限与来源 lane);品牌改名(命名迁移 lane,
本文按现名书写)。与这些 lane 的接缝见 §2.10。

## 0. 基线与证据边界

| 项 | 值 |
| --- | --- |
| 源码 | alpha-code `393a35c2a`(= 0.1.22 正式版)。本 worktree 相对它只多三份文档提交:`git diff --stat 393a35c2a HEAD` → `docs/README.md`、`docs/design/codepuppy-runtime-authority.md` 两个文件 |
| 平台 | alpha-platform `1bcfe09`(`git show 1bcfe09:<path>` 只读) |
| owner 机日志(只读) | main/renderer:`~/Library/Application Support/ai.opencode.desktop/logs/20261030T021718/{main,startup-timeline}.log`(0.1.22,2026-10-29 22:17 起);引擎:`~/.local/share/opencode/log/opencode.log`(UTC 时间戳,比本地早 4 小时) |
| 线上目录 | `curl -sS -m 15 -A alpha-design-recon/1.0 https://alpha-gateway.tidelabs.click/v1/models` → `200`,经本机代理,**不作生产时延结论** |
| 架构约束 | `ls docs/architecture/constraints.md` → `No such file or directory`;本仓无该文件,本方案无可对照的「已知偏离」登记表(见 §3 末) |

本文所有「实测」都是对已发生事件的只读回看;没有启动/退出 App、没有故障注入、没有读任何密钥。

## 1. 只读勘破

### 1.1 T07:一次「正在同步…」里每一层在做什么

**读取链(全部在 renderer,不经 main/IPC):**

| 层 | 坐标 | 预算 | 行为 |
| --- | --- | --- | --- |
| 发起 | `renderer/alpha-ui/alpha-composer.tsx:1112-1172`(`readModels`) | 链生命期 | 每次 `runModelChain` 立刻调 `modelContract.list(directory, chainSignal)`,打 `renderer.home.model_list.start/end` |
| 目录屏障 | `renderer/alpha-ui/model-contract.ts:202-308` | 单探针 1s(`:111` `CATALOG_READY_PROBE_TIMEOUT_MS`) | 循环发 `v2.provider.get(marker)`;404/`ProviderNotFoundError` = 未收敛继续;**1s 不答 = abort 本条、计 `probeTimeouts`、换一条新请求**(`:275-279`) |
| 列表 | `model-contract.ts:323-327` | 10s(`model-picker-logic.ts:20` `ENGINE_FETCH_TIMEOUT_MS`,经 `:120` `requestBudget`) | 屏障过后发 `v2.model.list`;到期 = `ModelContractError("list")` |
| 恢复 | `alpha-composer.tsx:1280-1302` → `model-recovery.ts:43-77` | 1/2/4/8s 封顶、无上限 | 失败 → `setModelChainState("recovering")`(`:1286`)→ 退避后整条重来 |
| 呈现 | `alpha-composer.tsx:1851-1855` | — | `recovering` 只渲染 `alpha.model.syncing`(`i18n/zh.ts:1174`「正在同步…」),**无任何按钮**;重试按钮只在 `error`(`:1843-1850`) |

main 侧的 `models-catalog` IPC 只读一个本机文件(`main/models-ipc.ts:20` → `alpha-platform-models.ts:173-185`),
不是悬挂点;引擎侧 `v2.model.list` 的 handler 只读内存目录(`packages/server/src/handlers/model.ts:11-14`
`catalog.model.available()`)。所以「读取超时 → 重探」这条链**住在 renderer 的 model-contract + composer 恢复环**;
问题是它发出去的请求为什么二三十秒没人答。

**两次独立的同形样本**(`startup-timeline.log`,本地时间;引擎行换算自 UTC):

| 时刻 | 样本 A(2026-10-29 23:10) | 样本 B(23:43,即 REQ-236 评论里的 39.10s) |
| --- | --- | --- |
| 触发 | `:177` `renderer.composer.mount mode=home`,前一行是手动 `launch_draft`(不是冷启动,进程已跑 53 分钟) | `:283` 同上(进程已跑 86 分钟;引擎是 23:36:46 token-only 换出的第 9 代) |
| 屏障首轮 | `:182` `barrierMs=56.4 probes=1` | `:288` `barrierMs=57.7 probes=1` |
| 列表 | `:184` `durationMs=10058.7 outcome=error:request` | `:290` `durationMs=10060.1 outcome=error:request` |
| 第二轮屏障 | `:189` `barrierMs=41276.3 probes=42 probeTimeouts=41` | `:293` `barrierMs=28030.7 probes=28 probeTimeouts=27` |
| 同刻放行的其他屏障 | `:187-188` 另两条 `barrierMs≈3446 probeTimeouts=3`,与上一行相隔 ≤2ms | — |
| 引擎同窗 | 03:10:24.664Z 四个 Office MCP `spawn uv ENOENT`(composer mount 后 75ms);Skill `init` 依次在 03:10:49.494 / :59.913 / 03:11:04.163 / 03:11:16.906Z | 云端 MCP 隧道 03:43:59.871 起陆续 CONNECT(`main.log:649-667`);Skill `init` 在 03:44:14.269 / :25.236 / :33.825 / :38.865Z |
| 放行时刻 | 23:11:16.925,**最后一次 Skill init 之后 19ms** | 23:44:38.890,**最后一次 Skill init 之后 25ms** |

读法:

1. 屏障首轮 57ms 就过了,说明目录早已收敛;此后 `model.list` 与屏障探针**一起**没人答。
2. 引擎事件循环在窗口内是活的(同窗有日志、有新的出网隧道),不是整进程卡死。
3. Skill `init count=N` 由 `packages/opencode/src/skill/index.ts:245` 打出;它在 `Command.state`
   (`packages/opencode/src/command/index.ts:64-155`)里**排在 `mcp.prompts()` 之后**(`:105` 先等 MCP,`:134` 再 `skill.all()`)。
   所以每条 `init` 行 = 某个目录的 MCP 全体初始化刚结束、`command.list` 即将返回。
   `MCP.state` 要等全部服务 connect + tools/list 才返回(`packages/opencode/src/mcp/index.ts:557-597`,`concurrency:"unbounded"` 但整批等待)。
4. 谁在等 `command.list`:composer 一挂载就由 `composer-autocomplete.tsx:133-141` 的 `createResource`
   发 `c.command.list({directory})`,**无超时、无 abort**。
5. renderer 对同一 loopback origin 长期占着的连接:引擎 `global event connected/disconnected`
   (`packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts:27,46`)计数 ——
   `grep "run=<id>" opencode.log` 得 d70079b0(第 9 代)connected=5/disconnected=0,71a56d7a(样本 A 那代)4/0,
   bae75cdf 5/0;其中 1 条是 main 的 `chat-archive-uploader.ts:359`(undici,另一个连接池),
   其余来自 renderer 的 `sidebar/use-projects.ts:585`、`alpha-ui/cloud-run-watcher.tsx:59`、
   `extensions/use-extensions.ts:1024`(hub 打开后常驻)以及上游会话同步。

**根因假设(未验证,按证据强弱排序):**

- **H1 renderer 端同源连接排队。** Chromium 对 HTTP/1.1 同一 scheme+host+port 默认最多 6 条连接;
  3–4 条常驻 SSE 占位后只剩 2–3 条。每个新挂载的 composer / 其他目录的 `command.list` 各占一条,
  要等那个目录的 MCP 全体初始化(云端 MCP 经代理 10–25s)才释放。屏障的「1s 不答就 abort 再发」
  让每条新探针重新排到队尾,所以**只有在所有排在前面的 `command.list` 都返回后**探针才过得去 ——
  与两次「最后一个 Skill init 之后 19/25ms 放行」、样本 A 三条屏障同毫秒放行完全吻合。
- **H2 引擎侧等待。** 请求已到引擎,但 v2 handler 在等与 `Command.state` 同一把锁/同一初始化。
  反证:handler 只读内存目录,窗口内没有 `booting location services` 日志;但无法从源码排除 Effect 层的共享初始化。
- **H3 其他**(例如 loopback 代理/围栏)。窗口内 main 无相关日志,暂无支持证据。

H1 与 H2 的判别实验在 §2.5 与子票 V1;2026-07-12 的同类判别实验当时未完成
(`docs/audits/2026-07-10-s39-req083/verify.md:64`)。

**会话级统计**(同一 log 文件,注意 renderer 每类标记每进程只打 25 条:`alpha-composer.tsx:737,1118`):

```
grep '"name":"renderer.home.catalog_ready"' .../20261030T021718/startup-timeline.log | grep -v '"probeTimeouts":0'
→ 22:17:33 probeTimeouts=13 / =1;23:11:16 =3,=3,=41;23:44:38 =27
model_list.end outcome:  ok ×23, error:request ×2   (25 条已触顶,之后的事件没有记录)
上一会话 20261028T033016:一次 probeTimeouts=76(barrierMs=87669.9)
```

**令牌续期的远端目录等待**(每次 respawn 都 `await syncLiveAllowlist`,`main/index.ts:1456-1458`):

```
awk 抽取 main.log 中每条 "respawning sidecar" 之后的首个 attempt:1 请求
→ respawns=23(全部 reason=token-only,grep -o 计数 23/23) timeouts=6 mean_ms=4034.57
   超时 8001–8002ms 的六次:22:56、23:06、01:06、01:16、01:36、02:06
```

即每 10 分钟一次的普通续期,引擎换代前平均先白等 4.0s 远端目录,四分之一的情况等满 8s
(23:46 那次 fork 在 `main.sidecar.respawn.fork.start` 前 3.55s 才开始)。目录拉取结果只影响「下一次 fork 的平台段」,
与这次续期本身无关。另外,每次 token-only 换代都丢掉引擎里各目录的 MCP 状态,下一次新对话要重付一次
MCP 全体初始化 —— 这是 H1 的触发条件随续期周期性复现的原因(换不换代归生命周期 lane)。

### 1.2 两份模型清单的真实来源与流向

| 事实 | 坐标 / 命令 | 结果 |
| --- | --- | --- |
| 随包目录版本与规模 | `python3 -I` 读 `packages/ui-mac/src/main/alpha-models.json` | `version 2026-09-06.2`;`platformModels` 12;`byokProviders` 5,模型 10 |
| 线上 cn 平台目录 | 上文 curl;与 owner 机 `alpha-live-models.json` 一致 | 6 个:deepseek-v4-flash/pro、glm-5.2、glm-5-turbo、qwen3.7-max/plus。随包 12 条富化里 claude ×4、gpt ×2 对 cn 是死数据 |
| 平台行的 `provider` | 同上 | 是**路由腿**不是品牌:`qwen3.7-max → openrouter`、`glm-5.2 → zhipu`;schema 枚举 `deepseek/openai/openrouter/anthropic/zhipu/alibaba`(alpha-platform `contracts/v2/model-catalog.schema.json`) |
| 平台展示/能力从哪来 | `alpha-live-allowlist.ts:119-135` `projectPlatformModels` | id+pricing 取远端快照;name/reasoning/web/variants 取**随包** `platformModels` 按 id 拼接 —— 要与网关 registry 逐 id 手工同步 |
| registry 有没有展示字段 | alpha-platform `packages/gateway/src/models-config-loader.ts:30-41` `ModelEntry` | 无 name/brand/reasoning/variants;只有路由、计价、minPlan |
| BYOK 目录从哪来 | `alpha-models.ts:83-118` | 只读随包 `byokProviders`;`baseURL`、`keyEnv`、`compat`(→npm)都在这份数据里 |
| BYOK 元数据跨腿借用 | `shared/alpha-model-types.ts:89-104` `byokModelMeta`,`:98` | BYOK 模型没有自己的 `modelMeta` 时借**平台同名条目**的 name/reasoning/variants;与目录自己的 `_variantsNote`「同一模型经直连与经 OpenRouter 形状不同,不得跨腿套用」矛盾 |
| BYOK baseURL 决定出网放行 | `main/server.ts:184-200` 注释 + `network-egress-derived.ts` | 放行集合从 `buildAlphaModelConfig` 的 `options.baseURL` 派生 —— 谁能改 baseURL,谁就能给引擎开出网口并收到用户 Key |
| 刷新点 | `index.ts:764`(启动,fire-and-forget)、`index.ts:1458`(**每次** respawn,await);`grep -rn platformLive renderer preload` | `models-platform-live` IPC 只在 preload 声明,renderer 零调用;picker 打开不刷新(`models-ipc.ts:10-14` 自认「既存缺陷」) |
| picker 与引擎是否同一版本 | `index.ts:761-763` 注释;`alpha-models.ts:73`(sidecar fork 时读快照)vs `alpha-platform-models.ts:175`(picker 每次读盘) | **不是**:刷新成功后 picker 立即变,引擎要等下一次 fork。今天每 10 分钟的续期换代把这个缺口盖住了 |
| 引擎如何拿到模型配置 | `alpha-config-injection.ts:188,474` | fork 时写 `OPENCODE_CONFIG_CONTENT` 环境变量 ⇒ 目录变化只能在新一代引擎生效 |
| runbook 与契约冲突 | `docs/runbooks/model-catalog-updates.md` 第 20-21 行、B 节「同时去 alpha-platform 把 id 加进 edition 白名单」 vs `docs/contracts/byok-availability.md`「目录主权」 | runbook 说 BYOK 显隐受 edition 白名单控制;契约(REQ-109 #595)说 `byok_providers` 无任何策略消费方。**runbook 错**。runbook 还写「启动/开 picker 时同步」「刷新点只有启动与登录后两处」—— 都与上表不符;`review_after: 2026-10-30` 已到期 |

### 1.3 T08:图标为什么是 α 和同一个字母

| 位置 | 坐标 | 现状 |
| --- | --- | --- |
| home 模型 chip | `alpha-composer.tsx:467-469` | 写死 `α` |
| 会话内 chip | `composer-reskin.css:91-111` | 隐藏上游 `provider-icon`,`::before` 写死 `α`;会话 composer 已改挂 `AlphaComposer`(`session-workspace/session-composer-mount.tsx:47`),该选择器只命中上游 `app/src/components/prompt-input*.tsx`,**疑似死样式** |
| picker 平台行 | `model-picker-core.ts:115` | 全部用 `platformProvider.pico`(`alpha-models.json` 里 `{letter:"C"}`) |
| picker BYOK / 自定义行 | `:131,145,172` / `:220` | BYOK 用各 provider 的 `pico` 字母;自定义节点取 id 首字母 |
| 可复用资源 | `packages/ui/src/components/provider-icon.tsx`(`ProviderIcon`,未知 id 回落 `synthetic`)+ `provider-icons/sprite.svg`;`packages/ui/package.json` exports `"./*"` | sprite 已含 `anthropic openai deepseek zhipuai alibaba moonshotai minimax google xai openrouter`(逐个 grep `types.ts`),无 `qwen`。`packages/ui` 为 MIT(`LICENSE` 首行),ui-mac 已依赖 `@opencode-ai/ui`(`ui-mac/package.json:60`) |

### 1.4 T10:为什么会提示安装比当前还旧的版本

`main/updater-controller.ts:87-102` 的 `start()`:持久化记录 `{version}` 与当前版本**不相等**就投影成
`ready`(注释明说「不在这里做版本算术」),比当前旧的记录同样被投影;随后 `check()` 在 `ready` 态直接
早退(`:74-77`),后台 10 分钟定时检查(`index.ts:1055`)从此全部空转 —— 旧记录会一直挂着
「更新 X 已就绪」(`updater-state-surface.ts:38`,`unsolicited:true`)直到用户点安装,
`install()` 才经 `runCheck()` 让 feed 重判(`:109-115`)。

owner 机现状(只读):`opencode.updater` 内容 `{}`;0.1.22 各会话 `main.log` 只有 `idle → checking`,
没有 `→ ready` 恢复;`grep -rn "0\.1\.17" .../logs/*/main.log` 唯一命中是 23:03:19 一个
**packaged 0.1.17** 进程用 prod userData 启动(`20261030T030319/main.log:1`,只活了一行)。
本机 `packages/ui-mac/dist/mac-arm64/Code Puppy.app` 版本 0.1.17(`PlistBuddy` 实读),
`/Applications/Code Puppy.app` 0.1.22,二者 bundle id 都是 `com.tide.alphacode`。
因此:**源码缺陷是确定的**;owner 截图里那次 0.1.17 的具体来源(陈旧记录 vs 误启动 dist 里的旧包)没有日志可证,列入推断。

### 1.5 T24 §2.4:显式选择能不能被换掉

- 会话内发送 `alpha-composer.tsx:1712-1717` 的 `promptAsync` 只带 `sessionID/directory/parts/agent`,**不带 `model`**;
  首发 `sidebar/use-projects.ts:465` 只在 `session.create` 时带 model。
- 引擎 `packages/opencode/src/session/prompt.ts:688`:`input.model ?? ag.model ?? currentModel(sessionID)`。
  用户经 `switchModel`(`alpha-composer.tsx:1079`)写进 `SessionTable.model` 的选择排在 agent 自带模型**之后**。
- 承受者:owner 机 prod 环境 `grep -rh "^model:"` 结果 0 —— 今天没有自带模型的 agent;但 hub 安装 agent
  (REQ-234)与插件导入会把它带进来,T24 已把这条列为需求。
- 回执面已存在:用户行显示 user message 的 `model`(`session-timeline-view.tsx:428-443`),助手 footnote 取
  assistant 的 `providerID/modelID`(`timeline-model.ts:733-740`)—— 都是引擎落库的事实。

### 1.6 架构稿(`codepuppy-runtime-authority.md`)本范围断言复核

| 断言 | 复核 |
| --- | --- |
| `index.ts:728` onRenewed 进入 token rotation;`:1444` 起两种 reason 都 fork,`:1458` 先 await 远端目录 | **对**(`:1448` 是函数头,`:1458` 是 await)。补充实测:23/23 次、均值 4.0s、6 次 8s 超时 |
| `alpha-platform-models.ts:121` 序号+身份仲裁、一次后台补试;`:64` 单次 8s | **对**,预算在 `:65` |
| `models-ipc.ts:9` 刻意不在读取时刷新 | **对**(`:10-14`) |
| picker 与 sidecar 共用投影,但「同一投影 ≠ 同一已应用版本」 | **对**,且源码自认(`index.ts:762`) |
| `model-contract.ts:174` 等 marker 后再请求目录 | 大体对;屏障在 `:202-308`,调用在 `:319` |
| `alpha-composer.tsx:1079` v2 switchModel、`:1712` v1 promptAsync、`prompt.ts:656/688` | **对**;补充:发送不带 model ⇒ agent 模型可覆盖显式选择 |
| §3「缓存:账户/环境隔离」作为要守的不变量 | **部分不成立**:快照按环境隔离(userData 分 prod/beta/dev),不按账户隔离;身份变化只阻止旧轮写入(`:121`),不使旧账户的快照失效。承受者 1 个账户,登记为残余风险,不立票 |
| 「把本机引擎连接、目录准备、云目录刷新和工具握手分开表达」 | 方向对;本文把根因从「云端握手」改为待判别的 H1/H2(§1.1) |

## 2. 选定方案

### 2.1 一个刷新器、两份文档、一个「已应用」版本

新增 `packages/ui-mac/src/main/catalog-refresher.ts`(main-only),**取代**三个散落刷新点,成为两份远程目录
唯一的拉取/校验/采纳所有者(REQ-237「不建第二个同步器」):

| 文档 | 来源 | 鉴权 | 账户/edition 相关 | 本机落点(已下载 LKG) |
| --- | --- | --- | --- | --- |
| 平台目录 V3 | 网关 `GET /v1/models` | 有登录态就带 bearer(维持现状 `alpha-platform-models.ts:62-64`) | 是(edition) | `alpha-live-models.json`(沿用) |
| BYOK 预置目录 v1 | 网关 `GET /v1/byok-catalog` | **从不带凭据**(结构上无法按账户收窄) | 否 | `alpha-byok-catalog.json`(新) |

- **入口**:`requestCatalogRefresh(reason)`,`reason ∈ boot | identity-change | interval | manual`,返回 `void`,永不 throw、
  永不被 respawn/发送/启动 await。
- **单飞 + 仲裁**:每份文档同一时刻最多一个在途请求;平台文档沿用 `refreshSequence` + `getAuthIdentityTag()` 仲裁
  (`alpha-platform-models.ts:46,118-121`),旧轮不得写盘或改 health。
- **节奏**:boot 一次;`identity-change` 只在身份标签真变化时拉平台文档(续期每次也会触发 `onChanged`,
  所以由刷新器自己比对标签,纯续期不拉);`interval` 30 分钟一次两份都拉;`manual` 来自横幅/状态行的重试。
  首试 8s、超时后 1s 补试一次(沿用 `:160-165`),之后等下一个触发点 —— 不在刷新器里再造无限退避。
- **校验与采纳**:平台文档沿用「整份拒绝」纪律(ADR-039;`:71-81`);BYOK 文档见 §2.3。通过才原子写 LKG
  (`writeFileAtomicSync`,同 `alpha-live-allowlist.ts:102-107`),失败保留旧 LKG。
- **刷新结局按文档分别记**(R1 F4):现有 `alpha-catalog-health.ts:19` 只有一个 `failure`,`:29` 的
  `reportCatalogRefresh(null)` 会把它整个清空 —— 两份文档共用它时,一份成功就抹掉另一份仍在的失败。改为在同一个
  health 所有者内按文档保存:`reportCatalogRefresh(doc: "platform" | "byok", code: string | null)`,内部
  `Record<doc, CatalogRefreshFailure | null>`;IPC `alpha-catalog-health` 与推送 `alpha-catalog-failure` 发出汇总
  `{ platform: … | null, byok: … | null }`,横幅(`renderer/alpha-ui/Banner.tsx:76-78`)按文档分别说明哪一份没更新、
  最近成功时间与重试。某一份成功只清它自己那一格。不新建第二个 health 模块。
- **不再存在的东西**:`index.ts:1456-1458` 的 await;`models-platform-live` IPC 及其 preload 声明
  (零调用者,`preload/index.ts:389`、`preload/types.ts:1349-1352`)。

### 2.2 平台展示与能力字段归网关(目录 V3)

网关 registry 是平台模型事实的唯一权威,展示与能力字段也跟着它走,客户端不再按 id 维护第二份:

- alpha-platform `models.config.json` 每个模型加 `display: { name, brand, reasoning?, web?, variants? }`;
  `brand` 枚举(首版):`anthropic | openai | deepseek | zhipu | qwen | moonshot | minimax`。
  `variants` 的选项键只允许 `reasoningEffort | reasoning | thinking`(今天随包数据实际用到的全集),由 loader 校验。
- 新契约 `contracts/v3/model-catalog.schema.json`:行增加必填 `display`;**删除** `byok_providers`(#595 后无消费方);
  `/v1/models` 只发 V3(worker.ts 与 server.ts 都走 `lib/model-catalog-v2.ts` 的唯一 producer,改名为 v3)。
- alpha-code:`alpha-contracts-consumer` 的 model-catalog 能力 pin 升到 V3(`decode.ts:35,59`、
  `alpha-platform-model-catalog.lock.json`);快照行加 `display`(`alpha-live-allowlist.ts:32-37`、`:69-86` 同一校验函数);
  `projectPlatformModels`(`:119-135`)改为全部字段取快照;**删除随包 `platformModels` 与 `platformProvider.pico`**。
  无快照时平台段为空并如实标「平台模型清单尚未获取」,不再回退到随包 12 条(那份数据本身就是要消灭的第二权威)。
  撤销方式:恢复 `alpha-models.json` 的 `platformModels` 与 `projectPlatformModels` 的 `!snapshot` 分支,纯数据回滚。
- 过渡期事实(R1 Q4 限定):桌面端解码 `/v1/models` 的生产路径只有 `alpha-platform-models.ts:71` 一处。网关先部署 V3 时,
  0.1.22 解码失败 → `:94` 上报不兼容、`:128` 返回且不覆盖 LKG、`:173` 继续返回本地目录;横幅去重在 `Banner.tsx:76`。
  确定的后果是 **0.1.22 此后取不到任何目录更新**;只有在现有模型与路由都不变的前提下,它用 LKG 发出的平台调用才不受影响 ——
  不能推广到之后的模型退役或路由变化。owner 已裁「不考虑旧客户端兼容」,不加双协议。

### 2.3 BYOK 预置目录:数据可远程更新,可执行字段留在 App 里

把今天 `byokProviders` 里的字段按「谁能决定 Key 发去哪」切开:

| 字段 | 归属 | 理由 |
| --- | --- | --- |
| `baseURL`、`keyEnv`、`compat`(→ npm 适配器) | **App 内置适配器表** `main/byok-adapters.ts`(新,由现 `alpha-models.json` 搬出) | 决定用户 Key 发去哪、出网放行哪个主机(`server.ts:184-200`);远程数据改它 = 远程重定向用户密钥 |
| provider 的 `name`、`brand`、`preset`、排序;模型的增删、`name`、`reasoning`、`variants`、`imageInput` | 远程 BYOK 目录 | 在同一 provider、同一端点、用户自己的 Key 下,最坏结果是显示错误或请求被上游拒,不越出用户已授权的边界 |

远程文档 `byok-catalog v1`(alpha-platform 发布,schema 进 `contracts/v1/byok-catalog.schema.json`):
`schema_version: 1`、`catalog_version`(单调递增整数)、`published_at`、`providers[]: { id, name, brand, preset, models[]: { id, name, reasoning?, variants?, image_input } }`。
每个模型自带完整元数据 —— **删除 `byokModelMeta` 的平台同名回落**(`alpha-model-types.ts:98`),两类目录从此不互相借数据。

客户端采纳规则(`catalog-refresher.ts` 内,一个纯函数 `adoptByokCatalog(doc, adapters, current)` 便于单测):

1. 信封不合 schema 或 `schema_version` 不是 1 → 整份拒绝,保留 LKG。
2. `catalog_version` ≤ max(LKG, 随包引导版本) → 不采纳(防回滚;要撤一次坏发布就发一个更高版本)。
3. `providers[].id` 不在 App 适配器表 → **跳过该 provider** 并记一条日志(这正是 AC1「客户端已支持的范围」)。
4. 模型 `variants` 出现允许集外的选项键 → 跳过该模型(不半应用)。
5. 随包 `alpha-models.json` 只保留 BYOK 段作为**首启引导**,格式与远程文档同构并带自己的 `catalog_version`;
   App 升级带来更高的随包版本时随包胜出。

**随包 JSON 的其他直接读者一起迁**(R1 F2;`rg -n 'alpha-models\.json|readCatalogSnapshot' packages/ui-mac/src`,
剔除注释/测试/定义后的生产命中除 `alpha-models.ts`、`alpha-platform-models.ts` 外还有四个)。`keyEnv` 搬进适配器表、
随包格式改变之后,它们若仍读旧字段:

| 读者 | 今天读什么 | 不迁会怎样 | 改为 |
| --- | --- | --- | --- |
| `main/alpha-byok-keys.ts:50`(`keyEnvFor`)、`:54`(`isCatalogByokId`) | `CATALOG.byokProviders[].keyEnv / id` | 钥匙串里已存的 Key 映射不到 env,不再物化 | 读 `byok-adapters.ts` |
| `main/alpha-secret-files.ts:37`(`secretEnvVars`) | 同上 `keyEnv` | 要物化的文件名集合缺失 BYOK 项;`:118-123` 会把「不在 wanted 集」的既有 BYOK 密钥文件**删掉** ⇒ 已配好的直连全部不可执行 | 读 `byok-adapters.ts` |
| `main/alpha-provider-status.ts:41`(`getProviderKeyStatus`) | `CATALOG.byokProviders` 的 id/keyEnv | picker 的「已配置 Key」判定错 | provider 身份读适配器表(谓词 1 的 KEY 半边),展示名读已应用目录 |
| `main/ext-config.ts:1173`(`isReservedProviderId`) | `PROVIDER_CATALOG.platformProvider.id / byokProviders` | 保留 id 判定漏项,自定义节点可与内置 id 冲突 | 读适配器表 + 平台 provider 常量 |

规则:**Key 名、预置身份、保留 id 只认适配器表**;已应用目录只提供模型与展示元数据。C2 必须带一条回归:用真实钥匙串
存储格式预置一个已有 BYOK Key → 走迁移后的 `syncSecretFiles` → fork → 引擎配置里出现该 provider 且 `{file:}` 指向的文件
存在 → 一次请求带上该 Key(沿用 `custom-provider-derivation.test.ts` 的真引擎夹具形态,测试经注入把适配器表的 baseURL
指向本地桩服务端,断言桩收到的鉴权头)。迁移前后同一 Key 的密钥文件不被删除。

BYOK 契约两个谓词的输入集不变:「本地目录」从「随包 JSON」改为「本机已应用 BYOK 目录」(§2.4),它在读取时仍是
本机事实;刷新失败、平台不可达、未登录都只意味着继续用已采纳版本 —— 不新增登录/会员/余额/网关在线前提(AC3)。
远程退役一个模型的效果与今天 App 升级删掉它相同(谓词 1 变假,现有 `checkSelectedModel` 挂起选择),不是新的在线闸门。

### 2.4 选择器与引擎读同一份「已应用」目录

main 在每次 fork 前把当刻的两份 LKG 合成一份钉住文件 `<userData>/alpha-applied-catalog.json`:
`{ generation, platform: <快照>|null, byok: <已采纳目录>, byokSource: "remote"|"bundled" }`。

- 写入点:`server.ts` `spawnLocalServer`,紧接 `syncSecretFiles`(`:494-503`)之后、`applyWebSearchSovereignty()`(`:514`)之前;
  失败按密钥文件同样 fail-closed 拒绝本次 fork。
- 读取点只有两个,都读钉住文件:`buildAlphaModelConfig`(`alpha-models.ts:63-208`,sidecar 与出网派生共用)与
  `getEffectiveCatalog`(`alpha-platform-models.ts:173-185`,picker)。**刷新器写 LKG,不写钉住文件。**
- 因而「已下载」与「已应用」分开:`EffectiveCatalog` 增加 `applied: { platformFetchedAt, byokVersion }` 与
  `downloaded: {…}`;两者不同时 picker 底部一行说明「模型清单已更新,将在引擎下次启动后生效」。
- 生效时机默认:**下一次引擎换代**(任何 reason,含 App 重启)。今天每 10 分钟的续期换代会顺带应用;
  生命周期 lane 去掉续期换代之后,生效推迟到下一次结构性换代或重启。撤销/加强方式:在 §2.10 的
  `onDownloadedCatalogChanged` 上挂一个空闲时换代,不改本文其余部分。

这一步同时修掉 §1.2「picker 先变、引擎后变」的既有缺口(AC2:界面与实际发送用同一份有效目录)。

### 2.5 T07:状态如实、等待有出口、根因按实测分支修

**四种状态的单一来源**(不新造状态机,全部是已有事实的投影):

| 状态 | 事实来源 |
| --- | --- |
| 界面可用 | 窗口与本机数据(草稿、会话、已应用目录)—— 不依赖引擎 |
| 目录已缓存 | `EffectiveCatalog.downloaded`(LKG 存在与 fetchedAt) |
| 目录已被引擎应用 | `EffectiveCatalog.applied` + 当前 generation(§2.4) |
| 目标模型可执行 | 现有 `canSend`(`alpha-composer.tsx:1034-1049`)与 BYOK 契约谓词 2,不改 |

**状态行与出口**(替换 `alpha-composer.tsx:1851-1855`;R1 F1 修订):

- **覆盖 `loading` 与 `recovering` 两态,从实际读取开始计时。** 首轮屏障一直不答时,`model-contract.ts:275-279` 只计数并
  `continue`,`list()` 的 Promise 既不 resolve 也不 reject;composer 停在 `:1102` 设下的 `loading`,只有 `:1286` 的失败
  回调才会进 `recovering`。所以只挂在 `recovering` 上的出口会漏掉最长的那种等待,只在 `ModelContractError` 上加字段也
  传不出这段在途状态。计时起点 = `readModels()` 发出本轮第一条请求(`:1112-1124`),跨重试累计,链成功或被 supersede 时清零。
- **在途阶段由屏障自己发布。** `createModelContract` 的 options 增加 `onProgress?(p)`(与现有 `onCatalogReady` 同一注入通道,
  `model-contract.ts:35-50`),`p = { stage: "barrier" | "list", probes, probeTimeouts, since }`:进入屏障、每次单探针到期
  (`:275-278` 处)、屏障通过后发出 `model.list` 时各报一次。composer 用它决定状态行文案;`ModelContractError` 另加
  `stage` 与 `kind: "no-answer" | "http" | "network"`(`:83-91`),只用于失败后的说明。
- **呈现**:10s 内中性色「正在读取模型状态」;≥10s 说明卡点 —— 屏障探针连续不答写「本机引擎暂未响应(已等待 N 秒)」,
  引擎换代中写「引擎正在重启」 —— 并给「重试」按钮(复用 `retryCurrentModel`,`:1388-1391`);≥30s 增加「重启引擎」按钮
  (复用现有 recovery 动作 `RECOVERY_ACTIONS.retryEngine`,`shared/recovery.ts:18`)。错误态与等待态不再共用错误样式。
- **测试从真实探针驱动**:组件测试注入的 contract 用小 `probeTimeoutMs` 与一个 `provider.get` 永不 settle 的客户端,
  让屏障真的连续到期;断言链仍处于 `loading` 时到点出现按钮(现码上红:`loading` 不渲染任何状态行)。不直接把状态设成 `recovering`。时序标记的 25 条上限改为每代引擎 25 条(`alpha-composer.tsx:737,1118` 等计数器在
generation 变化时归零),否则长会话里的复发没有记录。

**根因修复按 V1 结果二选一**(两支都预先写好,V1 结束即派):

- H1 成立 → (a) ui-mac 自己的三条 `/global/event` 订阅(`use-projects`、`cloud-run-watcher`、`use-extensions`)合并为一个
  分发器(放在 `use-projects.ts:572-600` 现有那条流上)。上游会话同步还另有一条:`packages/app/src/context/server-sdk.tsx:278`
  由 `server-sync.tsx:639` 启动(R1 ARCH-NOTE),所以合并后 renderer 至少仍有 **2 条**;能否让 ui-mac 直接订阅上游那条的
  事件(只消费、不改上游文件)在 C3b 实现时核实,做不到就是 2 条。(b) `composer-autocomplete.tsx:133-141` 不在挂载时拉
  `command.list`,改为首次打开斜杠菜单时拉(`:169-175` 已有打开即刷新),并给它 10s abort。
  判据:§5 的复现夹具在修前红、修后绿。
- H1 的三个平台前提 —— 同源 6 连接上限、SSE 流计入、排队请求取消后重发落到队尾 —— 在已安装的 Electron **42.3.3**
  (`/Applications/Code Puppy.app/.../Electron Framework.framework/.../Info.plist:14`)对应的 Chromium **148.0.7778.218**
  上**均未验证**(R1 Q1);其他 Chromium 版本的经验不作证据。C3b 维持「V1 判定后才开」。
- H2 成立 → renderer 侧只做上面的状态行;引擎侧阻塞点交给生命周期 lane 的 MCP 逐服务启动设计,本文不改引擎。

**模型目录刷新失败提示的位置与语义**(T06 后半句「目录失败提示不遮住导航、设置及操作区」,自 alpha-code#1550 AC2 移交,归 C3a):

现状:`CatalogFailureBanner`(`renderer/alpha-ui/Banner.tsx:68-87`)在 `renderer/index.tsx:588-592` 全局挂载,样式
`alpha-ui/banner.css:14-23` 为 `position: fixed; top: 12px; left: 50%; width: min(720px, calc(100vw - 32px))`,
z-index 为 `--a-z-modal - 1`(REQ-230 有意压在设置页这类 `--a-z-overlay` 浮层之上)。任何固定浮动位置都会在某个窗口宽度下
压住顶部导航、设置入口或页面操作区;而放进应用整体布局的页面流要改上游冻结布局。

语义判断:目录刷新失败是**降级不是阻断**(`Banner.tsx:62-63` 自己写明:BYOK 与上次成功的缓存目录照常可用)。它只在
「选模型、发消息」时与用户有关;设置、定制中心、自动化、产物这些页面不消费模型目录。因此提示跟着使用点走,放进已有的
流内位置,不再用全局浮层:

| 状态(按文档,汇总自 §2.1 的 health) | 位置 | 内容 | 动作 |
| --- | --- | --- | --- |
| 某份目录**从未成功获取**(平台段为空,或 BYOK 仍是随包引导版)且最近一次刷新失败 | composer 已有流内提示位 `.a-comp-model-alert`(`alpha-composer.tsx:1843-1870` 那一槽,`alpha-composer.css:44`);同时在 picker 对应分组头 | 「平台模型清单暂时取不到」+ 原因分类 | 「重试」= `requestCatalogRefresh("manual")` |
| 有已应用版本,最近一次刷新失败 | 只在 picker 弹层底部一行(随弹层出现,流内) | 「模型清单更新失败,正在使用 <时间> 同步的版本」+ 原因 | 「重试」 |
| 最近一次刷新成功 | 不显示 | — | — |
| 设置 / 定制中心 / 自动化 / 产物页 | 不显示 | 这些页不消费模型目录;回到对话或打开选择器时提示自然出现 | — |

- 同一提示槽一次只显示一条,优先级:发送被拦(REQ-160)> C3a 模型状态行 > 「BYOK 节点未加载」> 目录未获取。
- 删除 `index.tsx:588-592` 的全局挂载与 `banner.css` 里 `.a-catalog-failure` 的 fixed 规则;`ContractFailureBanner`
  (`Banner.tsx:41-56`)对 `surface === "model-catalog"` 不再渲染 —— 该情况已由 per-doc health 记为 `contract-incompatible`
  并走上表;其他契约面的全局横幅不在本票范围。
- C3a 可先于 C2 合并:先用现有单值 health 呈现平台一份,C2 按文档拆分后同一位置按文档逐条显示。
- 被否的位置:右下角 toast(窄窗口压住发送键,且一闪即逝说不清持续状态);顶栏下方、压在面板之下(设置页会盖住它,
  与「设置页也看得到」的初衷矛盾,而那一初衷本身就不成立 —— 见上);保留全局浮层只调宽度/位置(总有窗口宽度会遮挡);
  进入应用整体页面流(要改上游冻结布局)。

### 2.6 T08:按模型品牌显示图标

- 品牌事实:平台行取 V3 `display.brand`(网关权威);BYOK 行取远程目录 provider 的 `brand`;自定义节点**不猜**,
  显示统一的「自定义节点」中性图形。不用 `provider` 字段(那是路由腿,qwen 会显示成 OpenRouter)。
- 品牌 → 图标:renderer 里一张固定小表映射到上游 sprite id
  (`anthropic→anthropic, openai→openai, deepseek→deepseek, zhipu→zhipuai, qwen→alibaba, moonshot→moonshotai, minimax→minimax`),
  渲染用 `@opencode-ai/ui/provider-icon` 的 `ProviderIcon`;表外品牌走 `ProviderIcon` 自带的 `synthetic` 回落。
  图标是 App 资产,新品牌要显示自己的图标需要发版(§2.9),数据仍可先行。
- 改动点:`model-picker-core.ts` 行类型 `pico` → `brand`(`:17,115,131,145,172,220`);`alpha-composer-model.tsx:761-762`;
  home chip `alpha-composer.tsx:467-469` 显示当前所选模型的品牌,未选时显示中性图形;确认无渲染方后删除
  `composer-reskin.css:91-111`;`model-picker-add.tsx:239-240` 的添加卡片同样换品牌图标。
- 资源与许可:只用 `packages/ui/src/components/provider-icons/sprite.svg` 已有图形(仓库 MIT;图形为各供应商公开品牌标识,
  仅用于指明供应商)。不新增图形资源。

### 2.7 T10:只呈现比当前版本新的已下载更新

- `UpdaterBackend` 增加 `isNewer(version: string): boolean`,`updater.ts` 用 electron-updater 自己的
  `autoUpdater.currentVersion.compare(version) < 0` 实现(`electron-updater@6.8.9` `AppUpdater.d.ts:98`
  `readonly currentVersion: SemVer`;它在 `AppUpdater.js:340-358` 用同一个 semver 判可更新)—— 消费更新器的判断,不手写比较,不加依赖。
- `start()`(`updater-controller.ts:87-102`):记录 `isNewer` 才投影成 `ready`,否则清记录并 `check()`;
  恢复出来的 `ready` 不再让 `check()` 早退(`:74-77` 改为只在 `sessionDownloaded` 时早退),后台检查照常重判。
- `install()`(`:106-128`):`quitAndInstall` 前再判一次 `isNewer(current.version)`,不成立则清记录、转 `up-to-date`。
  下载包完整性仍由 electron-updater 的 sha512 校验负责,不另造。
- 恢复决策打一条日志(记录版本、当前版本、结论),今后同类现象可从日志判断来源。

### 2.8 T24 §2.4:显式选择决定执行模型

- composer 区分「用户显式选择」与「解析出的默认」(`applyDefaultComposerModel` 已是默认写入口;显式写入口是
  `selectComposerModel`,`alpha-composer.tsx:1051-1092`),用一个 `explicit` 标记记在 composer 模型状态里。
- 发送时,显式选择存在就带上它,未显式选择时不带(agent / 命令推荐照旧生效)。**四个发送入口都要带**(R1 F3):

  | 入口 | 坐标 | 携带 | 引擎侧优先级 |
  | --- | --- | --- | --- |
  | 会话内普通消息 | `alpha-composer.tsx:1712-1717` `promptAsync` | `model: {providerID, modelID}` + `variant` | `prompt.ts:688` `input.model ?? ag.model ?? currentModel` —— 已正确 |
  | 首发普通消息 | `sidebar/use-projects.ts:493` 起的 `promptAsync` | 同上 | 同上 |
  | 会话内斜杠命令 | `alpha-composer.tsx:1668-1673` `session.command` | `model: "<providerID>/<modelID>"` + `variant`(v1 `CommandInput`,`prompt.ts:1580` 起有这两个字段) | `prompt.ts:1455-1462` 今天是 `cmd.model → cmd.agent.model → input.model → currentModel`,**显式选择排在后两位** |
  | 首发斜杠命令 | `sidebar/use-projects.ts:485-487` `session.command` | 同上 | 同上 |

- **引擎文件必须改一处**:把 `prompt.ts:1455-1462` 的 `taskModel` 顺序改为 `input.model → cmd.model → cmd.agent.model →
  currentModel`。因为客户端只在用户显式选择时才带 `input.model`,这一改等价于「显式选择优先,命令/agent 推荐只作默认」;
  不带时行为与今天相同。`packages/opencode/src/session/prompt.ts` 已在 ADR-041 的 L3 接管清单里(`ADR-041-tool-identity-ledger.md:60`,
  `scripts/north-star-guard.sh:173` 已排除),所以**不扩大排除面**;按 ADR-029 第 3 条,C6 以具名窄补丁交付:该块加
  `alpha:` 标注说明来源(REQ-236 T24 §2.4),并在 ADR-041 接管清单的 `prompt.ts` 条目下追加一行订正,登记它新增的
  「命令模型优先级」职责(ADR-041 原本只为工具身份接管它)。§2.11 对应的替代一行已同步改写。
- 回执:沿用已有两处事实面(用户行 model、助手 footnote)。两者不一致时 footnote 加一句「实际使用 X」——
  只在不一致时出现,不新增常驻 UI。

### 2.9 仍需要发 App 的情形

1. 新 BYOK 供应商(新 baseURL/Key 名/协议适配器)。
2. 新的推理选项键或新的请求协议(超出 `reasoningEffort | reasoning | thinking`、`openai | anthropic` 适配器)。
3. 新品牌要显示专属图标(数据可先发,图标回落为通用图形)。
4. 目录 schema 主版本变化(V3→V4、byok v1→v2)。
5. 平台模型需要客户端新能力(例如看图要开平台聊天入口的图片通道)。

### 2.10 与生命周期 lane 的冻结接口

| 我方提供 / 修改 | 形状 | 对方可以假设 |
| --- | --- | --- |
| 删除 `index.ts:1456-1458`(注释两行 + `await syncLiveAllowlist(...)`) | — | respawn 链路里不再有任何远端目录等待;token-only 是否 fork 由对方决定,本文不依赖 |
| `requestCatalogRefresh(reason)` | `catalog-refresher.ts` 导出,同步返回 `void`,永不 throw | 对方如需在身份变化时刷新,直接调;不得 await |
| `pinAppliedCatalog(userDataPath, generation)` | 由 `spawnLocalServer` 在 fork 前调用 | 对方若新增「不 fork 的配置热应用」路径,模型配置必须经同一函数取钉住结果,否则 picker 与引擎会再次分叉 |
| `onDownloadedCatalogChanged(cb)` | 订阅,回调参数 `{ platformChanged, byokChanged }` | 默认无人订阅;对方若要「空闲时换代应用新目录」在此挂接 |
| `index.ts:764` 启动刷新改为 `requestCatalogRefresh("boot")`;`index.ts:729-737` `onChanged` 内加 `requestCatalogRefresh("identity-change")` | — | 不影响 `tokenRotation` latch 与 `authScheduler` |

### 2.11 被否决的替代

| 替代 | 不选的理由 |
| --- | --- |
| 继续在 respawn 前 await 目录,只把 8s 改小 | 实测 6/23 次撞满预算;目录与续期无因果,任何预算都是白等 |
| 去掉目录 marker 屏障,直接读引擎目录 | 会把 6,132 行中间目录当首屏(#857);问题不在屏障本身 |
| 把屏障单探针期限从 1s 调大 | 若 H1 成立,只是换一种方式排队;若 H2 成立,无效 |
| BYOK 目录走 alpha-web 现有 ed25519 签名通道(`catalog-channels.ts`) | 要改 alpha-web 通道契约与发布流水线;可执行字段留在 App 之后,远程数据的最坏后果不需要签名级信任,TLS + 自有源与 `/v1/models` 同级即可 |
| BYOK 远程目录也携带 baseURL/Key 名 | 远程可重定向用户密钥并铸造出网放行(`server.ts:184-200`) |
| 平台展示字段放第二份网关文档 | 同一 id 两份文档仍需对齐;一份 V3 文档一次校验、原子采纳 |
| 客户端按模型 id 前缀推品牌(`claude-` → Anthropic) | 手写别人文法的替身,新模型即漏 |
| 用 `provider` 字段选图标 | 那是路由腿,qwen 会显示 OpenRouter |
| 拉到新目录就立刻换代引擎 | 会打断正在输出的回答;生效时机交给换代边界与对方 lane |
| T10 手写版本比较或新增 semver 依赖 | electron-updater 已暴露它自己的 `currentVersion: SemVer` |
| T24 改引擎 `prompt.ts:688` 的优先级 | 普通消息不必改:请求里带 `model` 即可让现有优先级给出正确结果;命令路径 `:1455` 必须改,见 §2.8 |

### 2.12 随方案校正的文档

- `docs/runbooks/model-catalog-updates.md`:删除「BYOK 显隐受 edition 白名单控制」与 B 节「同时把 id 加进 edition 白名单」;
  刷新点改为「启动、身份变化、每 30 分钟、手动重试」;A 节第 5 步改为改网关 `display`;B 节改为改 alpha-platform 的
  BYOK 目录并部署,`ship:mac` 只用于 §2.9 的情形;写明「已下载 ≠ 已应用」与生效时机。
- `docs/contracts/byok-availability.md`:谓词 1 输入表「本地目录」改为「本机已应用 BYOK 目录」;「目录主权」改写为
  「BYOK 目录 = 远程发布 → 本机校验采纳 → 钉住应用;随包仅首启引导;从不按账户/edition 收窄;拉取失败从不移除条目」,
  保留「不得引入在线政策面」;删除 `byok_providers` 仍被解码那一条(V3 已删字段)。这是 REQ-237 Scope 第 4 条的落实,不是新裁决。

## 3. 安全面与不变量

整类边界:

1. **远程数据 → 可执行配置**:远程目录能影响的只有模型 id、展示与三种推理选项键;端点、Key 名、协议适配器、
   出网放行集合只由 App 二进制决定。
2. **远程数据 → 计费**:缓存只用于可见性;平台调用的准入与计价仍由网关逐次判定,客户端快照里的倍数只展示。
3. **账户隔离**:BYOK 拉取不带凭据;平台快照仍按现有身份仲裁写入(残余:不按账户失效,见 §1.6)。
4. **回滚与重放**:两份文档的采纳都单调(平台按 fetchedAt 序号仲裁,BYOK 按 `catalog_version`);损坏/空/旧代文档整份拒绝。
5. **本机竞态**:刷新器写 LKG、main 在 fork 前钉住、读者只读钉住文件 —— 写读不交叉。
6. **本机请求饥饿**:renderer 对引擎 origin 的长连接数有上界(H1 分支落地后 ui-mac 自有订阅为 1 条,加上游会话同步 1 条,共 ≤2 条 SSE),后台资源请求带 abort。
7. **更新器**:只安装比当前新的版本;来源与完整性仍由 electron-updater 的 feed 与 sha512 负责。

实现必须守住的不变量(每条都对应一个先红后绿的测试,见 §4):

- I1 目录请求一直不返回时,本机 fork 与就绪照常推进(R1 F5:判据是生产入口的**行为**,源码锚只作辅助)。
  两处检查:① `spawnLocalServer` 单测 —— 注入 `fork`(`server.ts:115`)并让 `/v1/models` 与 `/v1/byok-catalog` 的 fetch 永不 settle,
  先 `requestCatalogRefresh("boot")` 再 spawn,断言 fork 被调用、spawn 完成;② 换代链路(`index.ts` 跑不进单测)用 dev 构建把
  平台端点指向一个只收不答的本地桩,触发一次续期,读 `startup-timeline` 中 `main.auth.rotation` → `main.sidecar.generation.emit phase=recovering`
  的间隔:今天等于目录请求耗时(实测 23:46:42.282 → 23:46:45.859 = 3.58s,修前红),修后应 <1s。源码锚
  (`doRespawnSidecar` 体内无 `syncLiveAllowlist(` / `requestCatalogRefresh` 的 await)保留为辅助。
- I2 `buildAlphaModelConfig` 与 `getEffectiveCatalog` 只读 `alpha-applied-catalog.json`;任何地方不得直接读 LKG 拼目录。
- I3 BYOK provider 的 `options.baseURL` 只来自 `byok-adapters.ts`;远程文档里出现 `baseURL/keyEnv/compat/npm` 字段 = schema 拒绝。
- I4 BYOK 拉取请求不带 `authorization` 头。
- I5 拉取失败、校验失败、平台未登录都不减少已应用 BYOK 目录的条目。
- I6 平台段没有有效快照时不声称任何价格(沿用 #679),也不回退随包平台清单。
- I7 picker 平台行的品牌不来自 `provider` 字段。
- I8 `start()` 只把 `isNewer` 的记录投影成 ready;`install()` 对非更新版本不调用 `quitAndInstall`。
- I9 显式选择存在时,四个发送入口(两处 `promptAsync`、两处 `session.command`)的请求体都带 `model`;不存在时都不带。
  命令路径上带了 `model` 时,引擎实际执行的模型是它,而不是命令或其 agent 绑定的模型。
- I10 两份目录的刷新结局各自保存:任一份成功只清除它自己的失败,另一份的失败仍可见。
- I11 目录格式迁移后,迁移前已配置的 BYOK Key 仍被物化为密钥文件、仍注入引擎配置,且不被 `syncSecretFiles` 的清理分支删除。

`docs/architecture/constraints.md` 不存在,无「已知偏离」可对照;本方案不新增偏离,并消除一个既有双权威
(随包平台富化 vs 网关 registry)与一个跨腿借数据(`byokModelMeta` 平台回落)。

## 4. 子票切分

拆分理由:跨两个仓(alpha-platform 发布、alpha-code 消费);C1 有生命周期 lane 在等(冻结接口);V1 决定 C3b 的内容;
其余按「可独立评审、可独立回滚」各一张。

| # | 标题 / 仓 | 覆盖 | 边界(关键文件) | out-of-scope | 退出条件 | 尺寸·难度·依赖·独立 PR | 将来拿什么证明 | UI 稿 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| V1 | `[REQ-236][VERIFY] 判定新对话模型读取悬挂发生在界面排队还是引擎` · alpha-code | 236 AC2 / T07(根因) | 打包 0.1.22(Electron 42.3.3 / Chromium 148)加 Chromium `--log-net-log`;`startup-timeline.log`、`opencode.log`;dev 复现夹具(N 个目录各配一个不应答的远程 MCP + 打开 N 个 composer);连接计数含上游 `server-sdk.tsx:278` 那条事件流 | 修复本身 | 夹具先证明能测出饥饿(修前必现);真实环境 ≥3 次「续期换代后新对话」样本;报告 H1/H2 结论、每次的 socket 等待证据,以及 H1 三个前提(6 连接上限、SSE 计入、取消重发落队尾)在该 Chromium 版本上的实测结论 | M·难(要在打包环境复现间歇现象)·无·— | 报告进 `docs/verification/`;netlog 中 `127.0.0.1:<port>` 的 socket 池等待事件或已发出未响应 | 否 |
| C1 | `[REQ-237][CODE] 目录刷新不再阻塞引擎换代,选择器与引擎读同一份已应用目录` · alpha-code | 237 AC2(平台段)/ 236 AC2 / T07 | 新 `main/catalog-refresher.ts`;`index.ts:764,729-737,1456-1458`;`server.ts:494-514`;`alpha-models.ts:73`;`alpha-platform-models.ts:118-185`;`models-ipc.ts`;`preload/index.ts:389`、`preload/types.ts:1349-1352` | V3/BYOK 远程文档与 health 按文档拆分(C2);UI 文案 | I1(行为检查两处)、I2 的测试先红后绿;`bun test src` 对 base 失败集不新增 | M·常规·无·**独立 PR**(换代链路接缝,生命周期 lane 依赖) | 新 `catalog-refresher.test.ts`(单飞、身份仲裁、纯续期不拉);`server.test.ts` 增「目录 fetch 永不 settle 时 `spawnLocalServer` 仍完成 fork」(I1①);dev 桩下续期 `main.auth.rotation`→`generation.emit recovering` 间隔 <1s(I1②,修前 3.58s);辅助源码锚 `catalog-refresher.wiring.test.ts`;`alpha-platform-catalog.cases.ts` 增「刷新成功后 picker 仍显示已应用版本」(现码上红) | 否 |
| P1 | `[REQ-237][CODE] 网关发布平台模型展示字段与自带 Key 预置目录` · alpha-platform | 237 AC1 | `models.config.json` 增 `display`;`models-config-loader.ts`;`lib/model-catalog-v2.ts`→v3;`contracts/v3/model-catalog.schema.json`、`contracts/v1/byok-catalog.schema.json` + producer fixtures;`src/byok-catalog.json`;worker.ts/server.ts 新路由 `GET /v1/byok-catalog`;BYOK 文档首版内容 = alpha-code 现随包 5 provider / 10 模型(元数据补全,含今天靠平台回落的那几条) | 客户端消费;任何账户/edition 逻辑进入 BYOK 端点 | 网关 `bun test` 绿;producer fixture 与 schema 互验;部署后 `curl /v1/models` 为 V3、`curl /v1/byok-catalog` 无需凭据返回 v1 | L·常规·无·独立 PR(跨仓契约) | `model-catalog-v2.test.ts` 改 V3 并加「display 必填、variants 选项键越界即装载失败」;新 `byok-catalog.test.ts`(schema、无凭据可读、不读 edition) | 否 |
| C2 | `[REQ-237][CODE] 桌面端采纳远程平台展示字段与自带 Key 预置目录` · alpha-code | 237 AC1、AC2、AC3 / 236 T09 | `alpha-contracts-consumer`(V3 pin + byok v1 pin、`decode.ts:35,59`);`catalog-refresher.ts` 的 BYOK 文档与 `adoptByokCatalog`;新 `main/byok-adapters.ts`;随包 JSON 的四个直接读者 `alpha-byok-keys.ts:50,54`、`alpha-secret-files.ts:37`(及 `:118-123` 清理分支的 wanted 集)、`alpha-provider-status.ts:41`、`ext-config.ts:1173` 改读适配器表;`alpha-catalog-health.ts:19,29` 按文档保存 + `Banner.tsx:76-78` 汇总呈现;`alpha-models.json`(删 platformModels/platformProvider.pico,BYOK 段改首启引导格式);`alpha-live-allowlist.ts:32-135`;`alpha-models.ts:83-118`;`shared/alpha-model-types.ts:89-104`;runbook 与 BYOK 契约(§2.12) | 品牌图标(C4);新供应商协议 | I3–I6、I10、I11 测试先红后绿;`alpha-reasoning-badge-parity` 起真引擎对账仍绿;BYOK 契约回归闸门表全部仍绿 | L·难(三处消费者 + 四个直接读者同改、契约改写、真引擎对账)·P1、C1·独立 PR | 新 `byok-catalog-adopt.test.ts`(未知 provider 跳过、越界选项键跳过模型、版本不升不采纳、文档带 baseURL 被拒);**已有 Key 迁移回归**:预置真实存储格式的 BYOK Key → `syncSecretFiles` → fork → 引擎配置含该 provider 且文件存在 → 本地桩收到该 Key,迁移前后密钥文件不被删(I11);`alpha-catalog-health` 用例覆盖「平台先败后 BYOK 成功」「BYOK 先败后平台成功」「单边恢复」三种顺序(I10;现码上前两种红);`alpha-models.test.ts` 改为断言 baseURL 只来自适配器表;`network-egress-derived.test.ts` 加「远程目录无法新增放行主机」;T23 格「发布一次 BYOK 目录变化 → 同一打包客户端拉取 → picker 出现 → 真实发送」 | picker 底部「清单已更新,下次引擎启动后生效」一行、平台段「尚未获取」空态、横幅按文档分别说明 |
| C3a | `[REQ-236][CODE] 模型状态行说明卡点并提供重试与重启引擎,目录失败提示改到使用处且不遮挡` · alpha-code | 236 AC2 / T07、T06 后半句(目录失败提示不遮住导航/设置/操作区,自 alpha-code#1550 AC2 移交) | `alpha-composer.tsx:1102,1112-1124,1286,1843-1870,737,1118,1388-1391`;`model-contract.ts:35-50`(新增 `onProgress`)、`:83-91`、`:275-279`;`renderer/alpha-ui/Banner.tsx:41-87`、`renderer/index.tsx:588-592`、`alpha-ui/banner.css:14-23`;picker 弹层底部与分组头(`alpha-composer-model.tsx`);`i18n/zh.ts`、`en.ts` | 根因修复(C3b);引擎改动;其他契约面的全局横幅 | 等待计时从实际读取开始,`loading` 与 `recovering` 两态都有 ≥10s / ≥30s 两档出口;等待态不用错误样式;目录失败提示只出现在 composer 流内提示位与 picker 内,全局 fixed 浮层删除 | M·常规·C1(读 applied/downloaded);按文档逐条显示待 C2·否 | `alpha-composer-model.cases.ts` 增用例:注入小 `probeTimeoutMs` + `provider.get` 永不 settle 的客户端,屏障真实连续到期,链仍在 `loading` 时到点出现「重试」/「重启引擎」(现码上红);`model-contract.test.ts` 增 `onProgress` 每次到期都报、`stage/kind` 分类;`catalog-failure-banner.cases.ts` 改为断言:无已应用平台目录 + 刷新失败 ⇒ composer 流内提示位出现、全局层无 `.a-catalog-failure`(现码上红);有已应用版本 + 失败 ⇒ 只在 picker 底部;设置页不出现;UI 对照批准稿在窄(≤800px)与宽窗口下不压住导航、设置入口、发送区;T23 格「冷启动 ×3 + 续期后新对话 ×3 分阶段计时」 | **要**:状态行四种文案与两档按钮、中性色/错误色区分;目录失败提示的两种状态(从未获取 → composer 提示位 + 分组头;有旧版本 → picker 底部一行),含最近成功时间、原因、重试,窄/宽两种窗口宽度的摆放 |
| C3b | `[REQ-236][CODE] 本机请求不再被常驻订阅和后台列表占满`(V1 判 H1 时开)· alpha-code | 236 AC2 / T07 | `sidebar/use-projects.ts:572-600`;`alpha-ui/cloud-run-watcher.tsx:59`;`extensions/use-extensions.ts:1024-1050`;`alpha-ui/composer-autocomplete.tsx:133-175`;只读核实能否消费上游 `packages/app/src/context/server-sdk.tsx:278` 的事件 | 引擎 MCP 生命周期;改上游 app 包 | V1 的复现夹具修前红、修后绿;引擎日志 `global event connected` 每代来自 renderer 的不超过 2 条(ui-mac 1 + 上游 1;若能复用上游那条则为 1) | M·难(三个订阅方的事件语义要逐一对齐)·V1·否 | 夹具测试;`shell-commands-test-runtime.tsx` 现有可控 SSE 流加「ui-mac 只建一条连接」断言 | 否 |
| C4 | `[REQ-236][CODE] 模型选择器与输入框按模型品牌显示图标` · alpha-code | 236 AC2 / T08 | `model-picker-core.ts:17,115,131,145,172,220`;`alpha-composer-model.tsx:761-762`;`alpha-composer.tsx:467-469`;`composer-reskin.css:91-111`;`model-picker-add.tsx:239-240` | 新图标资源;品牌改名 | 品牌映射单测;视觉与批准稿一致 | M·常规·C2·否 | `model-picker-core.test.ts` 增「平台行品牌来自 display.brand,不来自 provider」(I7)、「自定义节点为中性图形」;UI 对照批准稿 | **要**:home chip、会话 chip、picker 三组行、添加卡片、未知品牌与自定义节点回落 |
| C5 | `[REQ-236][CODE] 更新提示只出现比当前版本新的已下载更新` · alpha-code | 236 AC2 / T10 | `updater.ts:72-88`、`updater-controller.ts:7-11,74-128` | 发布流程 | I8 测试先红后绿 | S·常规·无·独立 PR(发布链) | `updater-restore.test.ts` 增「记录 0.1.17 + 当前 0.1.22 ⇒ 不进 ready、清记录、调用 check」(现码上红)、「恢复 ready 不阻断后台检查」、「install 对非更新版本不 quitAndInstall」;T23 格「升级提示回放」 | 否 |
| C6 | `[REQ-236][CODE] 发送与斜杠命令都按用户明确选择的模型执行,agent/命令推荐只作默认` · alpha-code | 236 AC2 / T24 §2.4 | `alpha-composer.tsx:1051-1092,1668-1673,1712-1717`;`sidebar/use-projects.ts:485-487,493`;引擎 `packages/opencode/src/session/prompt.ts:1455-1462`(已在 ADR-041 L3 清单,具名窄补丁 + ADR-041 接管清单追加订正,不改排除面);footnote 不一致提示 `timeline-model.ts:733-740` | `prompt.ts:688` 普通消息路径(已正确);agent 模型推荐机制本身 | I9 测试先红后绿 | M·常规·无·**独立 PR**(改引擎接管文件) | 组件测试断言两处 `promptAsync` 与两处 `session.command` 的请求体在显式选择时含 `model`、未显式时不含(现码上红);`packages/opencode/test/session/prompt.test.ts`(同在 ADR-041 清单)增「命令绑定 agent 带模型 B、input.model=A ⇒ 实际执行 A」与「不带 input.model ⇒ 仍用 B」;T23 格「装一个带 model 的 agent 与一条绑定它的命令,显式选另一模型,普通消息与该命令的 footnote 都显示所选模型」 | 否(不一致提示沿用 footnote 现样式) |
| V2 | `[REQ-236][VERIFY] 核对现行模型清单的端点可用性与能力标注` · alpha-code + alpha-platform | 236 AC2 / T09 | 平台 6 个 cn 模型各一次最小真实请求(长期生产测试账号);owner 机已配 Key 的 BYOK 用 `packages/ui-mac/scripts/verify-byok-catalog.ts`;看图标注按 runbook B 节复查 | 修数据(结论转入 P1 的 BYOK 首版内容或网关 display) | 每个模型 PASS/FAIL/未验证一行 | S·常规·无·— | 报告进 `docs/verification/`。花费上限:平台 6 次 × ≤200 token,按 `deepseek-v4-flash` 基准倍数最高 15.8×,合计估算远低于 ¥1(未按实价核算,V2 开跑前按网关价目算出上限再报);先跑 1 条验证输出格式 | 否 |

所有 T23 格进共享 RC 回归,不另造发布门。父票 AC 不因任何子票合并而关。

## 5. T07 验证设计(给 V1 与 T23)

- **样本**:≥3 次独立冷启动(完全退出 → 等 30s → 启动)与 ≥3 次「token-only 换代后首次新对话」(现场两次失败都属于后者)。
- **分阶段记录**:`main.app.ready` → `main.sidecar.*.fork.start/end` → `renderer.composer.mount` →
  `model_list.start` → `catalog_ready{barrierMs,probes,probeTimeouts}` → `model_list.end`;引擎侧每目录 MCP 初始化起止
  (现仅有 `server unavailable` 与 Skill `init` 两个代理信号)与 `global event connected` 计数;netlog 中引擎 origin 的
  socket 分配/排队事件。
- **判别**:H1 预测「探针在 renderer 网络栈里等 socket、从未发出」,H2 预测「已在 socket 上发出、无响应」。
- **先证明能红**:dev 夹具让 4 个目录各挂一个 TCP 黑洞远程 MCP、打开 4 个 composer,修前必须复现饥饿;不复现即夹具无效,不得用它判绿。
- **报告**:每轮原始数据、样本数、失败数;3 个样本不报 P95。

## 待 Codex 征询

R1 已答复全部四问,结论已回写:Q1 → §2.5(三个前提在 Electron 42.3.3 / Chromium 148 上未验证,C3b 维持 V1 后才开);
Q2 → 不变(本版可达路径中三个选项键只进请求体,`@ai-sdk/openai-compatible@2.0.41` 的 URL/headers/fetch 取自 config,I3 不扩展);
Q3 → §2.3 读者迁移表与 C2;Q4 → §2.2 过渡期断言限定。本轮无新的待征询项。

## 方案审记录

**R1(Codex,只读,结论 FIX-THEN-MERGE)**,编排器裁决全部接受:

| finding | 改在哪 |
| --- | --- |
| F1 Major 等待出口漏掉无限 `loading` | §2.5「状态行与出口」改为覆盖 loading/recovering、从实际读取计时、屏障经 `onProgress` 发布在途阶段、测试由真实探针驱动;§4 C3a 行 |
| F2 Major 随包 JSON 四个直接读者漏迁 | §2.3 新增读者迁移表与已有 Key 迁移回归;§3 I11;§4 C2 行 |
| F3 Major 斜杠命令入口绕过显式模型 | §2.8 改为四个发送入口 + `prompt.ts:1455-1462` 具名窄补丁(ADR-041 清单内,追加订正);§2.11 对应行;§3 I9;§4 C6 行(S→M,独立 PR) |
| F4 Major 两份目录共用单值 health | §2.1 新增「刷新结局按文档分别记」;§3 I10;§4 C2 行 |
| F5 Minor I1 源码锚不能证明不等待 | §3 I1 改为两处生产入口行为检查,源码锚降为辅助;§4 C1 行 |
| ARCH-NOTE 上游另有一条事件流 | §2.5 H1 分支、§3 第 6 条、§4 C3b 与 V1 行改为「ui-mac 1 条 + 上游 1 条」 |

**R1 后追加范围**(编排器移交):目录刷新失败提示的位置与语义(alpha-code#1550 AC2 后半句)→ §2.5 新增小节;§4 C3a 行与其 UI 稿需求。

## 待 owner 裁决

无。以下是我已定的默认值,可直接回滚:

- 新目录的生效时机 = 下一次引擎换代(§2.4)。若希望「拉到新清单后在空闲时自动生效」,在 `onDownloadedCatalogChanged` 上加空闲换代,不改其余设计。
- 没有平台快照时平台段为空,不回退随包 12 条(§2.2)。回滚 = 恢复随包 `platformModels` 与投影分支。

## 仍是推断、没跑过的断言

1. H1(renderer 同源连接排队)是两次样本的最佳解释,但没有 netlog 或独立带鉴权请求证明;H2 未被排除;其三个平台前提在 Electron 42.3.3 / Chromium 148 上均未验证。
2. 「每次 token-only 换代丢掉 MCP 状态、下一次新对话重付初始化」由源码(InstanceState 随进程)与日志时序推出,未做对照实验。
3. 样本 A/B 的四条 Skill `init` 分别属于哪个目录未确认(日志行不带目录)。
4. owner 截图里「安装 0.1.17」的具体来源未定:陈旧持久化记录与误启动 `dist/` 里 0.1.17 包都可能,日志都不足以判定。
5. `byokModelMeta` 平台回落在 intl edition 下会让直连 `glm-5.2` 等丢失推理档 —— 从代码推出,未在 intl 快照下实跑。
6. 上游 sprite 的 `alibaba` 图形作为 Qwen 品牌图标是否被用户认得,未做视觉确认(C4 稿上定)。
7. `composer-reskin.css:91-111` 是死样式:只证明了会话 composer 已换成 `AlphaComposer`,未证明上游 `prompt-input*` 在任何 alpha 面都不再渲染。
8. 在 V2 之前,线上 6 个平台模型与 BYOK 10 个模型「端点实际可用」未逐个实测;本文只读了目录。
9. 网关部署 V3 后,在现有模型与路由不变的前提下 0.1.22 用 LKG 的平台调用不受影响 —— 由代码路径推出(R1 Q4 同结论),未实跑;0.1.22 此后取不到目录更新是确定后果。
10. 目录失败提示移入 composer 与 picker 后,用户在设置等页面看不到它;判断「这些页面不需要它」依据的是这些页不消费模型目录,未做用户验证。
