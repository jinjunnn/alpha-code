---
id: ADR-035
title: web search 工具失败面接管:websearch.ts / mcp-websearch.ts 两文件走 L3 冻结接管
status: accepted
date: 2026-07-25
related: [ADR-004, ADR-009, ADR-029, ADR-033]
issue: https://github.com/jinjunnn/alpha-code/issues/489
---

> **状态:accepted(owner 2026-07-25 拍板「走 ADR-029 L3 文件级 exclude」,#489 单向门决策)。**
> 本 ADR 按 [[ADR-029]] §3 把两个**文件**从上游同步集移出,交给 alpha 全所有权,让 E7
> (`alpha-code#223`)的「失败诚实」不变量可以真正落到打包端跑的那份代码上。范围仅这两个文件,
> 不扩到 `packages/opencode` 其它任何表面。

## 背景

1. **E7 要求 web search 失败诚实**(设计基线
   [`docs/design/2026-07-22-e7-cloud-web-search-baseline.md`](../../../docs/design/2026-07-22-e7-cloud-web-search-baseline.md),
   决策见 [[ADR-009]] 决策 B):禁伪成功、任何非 2xx 一律 LOUD、云失败不静默切回 keyless。
2. **打包端挂载的是 opencode 副本**。sidecar 服 `virtual:opencode-server` →
   `packages/opencode/dist`(`ui-mac/electron.vite.config.ts`、`sidecar.ts`)。所以失败诚实必须改
   `packages/opencode/src/tool/websearch.ts` 与它唯一的传输实现
   `packages/opencode/src/tool/mcp-websearch.ts`。

   > **事实更正(2026-07-26,#223 R3 Blocker 1)**:本条初版续写「`packages/core` 的 v2 builtin
   > websearch **永不挂载**」——**与事实不符,已作废**。同一个 opencode server 的 HttpApi 同时挂载
   > V2 Session 路由与 Location 服务(`packages/opencode/src/server/routes/instance/httpapi/server.ts`
   > 的 `SessionV2.node` / `buildLocationServiceMap()`),`packages/core/src/location-services.ts`
   > 装载 `BuiltInTools`,其 deps 里就有 `WebSearchTool.node`
   > (`packages/core/src/tool/builtins.ts`)。因此 `packages/core/src/tool/websearch.ts` 是**第二份
   > 已挂载的同名 `websearch` 注册**:同样被 `OPENCODE_EXPERIMENTAL` 打开(其实注册本身无条件),
   > 走自己的 `PermissionV2` 后直接调 Exa/Parallel。R2 把主权最终闸只放进 legacy 那一份,于是
   > R3 判 Blocker 1 未闭合。收口见 §1 第三个被接管文件与 §后果。
   >
   > **教训已登记为类**:本仓「引擎 v1/v2 断层」已第三次现形(picker 走 v2 / 推理走 v1 /
   > 配置信道不通 → 现在是工具注册双份)。因此本轮的守法不是再补一个实例,而是加一条**普查闸**:
   > `packages/ui-mac/src/main/websearch-copies.test.ts` 钉住「全仓注册为 `websearch` 的源文件集合」
   > 与「全仓直接引用 Exa/Parallel 端点的源文件集合」,并要求每一份注册都读同一个主权信号、
   > 且闸排在任何 permission 交互/出网调用之前。出现第四份副本时它变红。
3. **这两个文件当时的行为是两处失守**:`websearch.ts` 用
   `output: result ?? "No search results found…"` 把空/坏响应伪装成成功串;末尾
   `.pipe(Effect.orDie)` 把一切错误塌成匿名 defect(无类别、无状态、表现为工具崩溃)。
   `mcp-websearch.ts` 用 `HttpClient.filterStatusOk` 把每个非 2xx 压成同一个 StatusError,
   状态码与上游 body 都拿不回来,`parseResponse` 找不到结果时返回 `undefined`(伪成功的来源)。
4. **`packages/opencode` 在 north-star 守卫的 `UPSTREAM_PATHS` 内**,守卫用
   `--diff-filter=DMR`:改既有文件必红。#489 因此在 2026-07-22 被暂缓(草稿 PR#506),
   [[ADR-009]] 把它登记为「未竟」。

## 决策

**按 [[ADR-029]] L3 冻结接管以下两个文件**(逐要件登记):

### 1. 被接管表面(退出上游同步集,alpha 全所有权 → L3)

- `packages/opencode/src/tool/websearch.ts` —— 工具定义、provider 选路、失败结算。
- `packages/opencode/src/tool/mcp-websearch.ts` —— MCP over HTTP 的请求/响应/失败映射。
- `packages/core/src/tool/websearch.ts` —— **第二份已挂载的同名注册**(2026-07-26 追加,#223 R3
  Blocker 1;同一裁决的延续,owner 2026-07-25 的「走 ADR-029 L3 文件级 exclude」口径不变)。
  接管内容仅一处:`execute` 首行的主权最终闸(读同一个 `ALPHA_LOCAL_WEBSEARCH_DENY`)。

  **为什么没有更窄的解**(逐条勘探,不是推断):

  - **L0 接缝 / 插件钩子**:V2 的工具结算走 `packages/core/src/tool/registry.ts` 的 `settle`,
    **不触发任何 plugin hook**(`tool.execute.before` 只存在于 V1 的 `session/tools.ts` 与
    `tool/code-mode.ts`)。云工具那条路能用的钩子,在这条路上根本不存在。
  - **注册期摘掉它**:`BuiltInTools`(`packages/core/src/tool/builtins.ts`)是**静态 deps 列表**,
    删掉 `WebSearchTool.node` 既要改上游文件(同样是接管),又把工具**永久**去掉 —— 而主权判决
    是**每次 fork 动态重算**的(登出/BYOK 必须还回 keyless,ADR-009 B1),静态删除违反需求。
  - **permission 层**:V2 的 `PermissionV2` ruleset 与 V1 同病 —— 任何排在注入的 deny 之后的
    allow 都赢,R2 已判定「可覆盖的 permission 不能证明能力真关」。
  - **改 `registry.ts` / `location-services.ts`**:高 churn 的通用上游面,代价远超本票
    (ADR-029 的整包/通用面禁区)。

  代价与 §5 同口径:这个文件的上游 churn 与安全修复不再自动进入 alpha。它同为低频叶子
  (工具实现,无人依赖其内部),且 alpha 的改动面只有首行一句闸 + 三个常量,re-freeze 成本最低。

**刻意不接管上游测试文件**(2026-07-25 修正,#223 对抗审计 Minor 7):初版把
`packages/opencode/test/tool/websearch.test.ts` 整文件加进 exclude 清单「随源接管」,但该文件里还
有一组**未被接管**的断言 —— `registry.ts` 的 `webSearchEnabled` 闸。整文件 exclude 等于把那组断言
也移出守卫:以后改动/删除它们守卫仍绿,而 alpha CI 又不跑 opencode 测试,构成治理盲区。
改用更窄的写法:E7 的失败断言落在 alpha 自有的新文件
`packages/opencode/test/tool/alpha-websearch-failure.test.ts`,上游那份**原样保留、继续受守**。
新增文件对守卫的 `--diff-filter=DMR` 天然不触发(它对上游是 `A`),因此**不需要**任何 exclude 条目
—— exclude 清单只留源文件两条。

**刻意不接管云路径**:`packages/opencode/src/mcp/catalog.ts` 与
`packages/opencode/src/tool/code-mode.ts`。云 `cloud_web_search` 走的是这两处,而它们在
`result.isError` 时**已经**抛出带 body 的 `Error`(已 loud)。为了给云失败加一层分类前缀而把两个
高 churn 通用文件也收编,代价(放弃白嫖面 + 守卫盲区)远大于收益。

> **事实更正(2026-07-25,#223 对抗审计 Major 2)**:本节初版称「云侧的可辨性由平台契约的
> `error.code` 与 HTTP 状态在 body 里透传保证」——**与事实不符,已作废**。真实链路是:
> gateway 返回带状态的 JSON → alpha-platform `packages/gateway/src/cloud-mcp.ts` 的薄壳
> `text(body, !r.ok)` 只把 body 序列化进 MCP text content 并置 `isError`,**HTTP 状态在这一层
> 就被丢掉**;`catalog.ts` 于是抛出一个普通 `Error(body)`。而 gateway 的两条 402 body **也不带
> `error.code`**(只有 `message`,per-job 那条多一个 `job_id`),连「从 body 认码」这条退路都没有。
>
> 因此本 ADR 交付的 `WebSearchFailure`(含 `payment_required`)**只覆盖本地 Exa/Parallel 直连
> 链路**(`websearch` 工具);登录态的 `cloud_web_search` 今天是「loud + 原 body 完整,但**无状态、
> 无分类**」。这个事实由 `alpha-websearch-failure.test.ts` 的 "cloud MCP path" 一组走**真实
> `McpCatalog.convertTool` 链路**钉成回归基线(含一条反向断言:云错误**不是** `WebSearchFailure`、
> 不带 status)。平台侧透传状态/补 402 `error.code` 归 **alpha-platform#105**;在它落地之前,
> 本仓任何文档/代码都不得声称已消费云侧 402。
>
> **该反向断言的到期条件(2026-07-25 二轮登记,R2 B 项裁决)**:它是一条**硬编码的现状 fixture**
> —— 断言的是「云错误里**没有**状态/码」。alpha-platform#105 修好之后它**不会自动变红**(测试喂的是
> 手写的 402 薄壳产物,平台改了也喂不到这里),于是会从「事实基线」悄悄变成**误导性基线**:文档看着
> 像仍未透传,实际早已透传。**#105 一旦落地,必须同步把这条改成 status/code 的正向断言**,并同时更新
> 本 ADR 与 [[ADR-009]] 裁决 (d) 的消费面边界段。到期条件已写进
> `test/tool/alpha-websearch-failure.test.ts` 该组的注释里。

### 2. 为何 L0–L2 不够用(§3 要件:低级别不可行的勘探证据)

- **L0 接缝**:opencode 没有「工具执行结果后处理」接缝。`plugin` 的
  `tool.execute.after` 只在**成功**路径触发(`session/tools.ts`),拿不到失败;而问题正是
  「失败被塌成 defect / 被伪装成成功」。把 web search 整个换成 alpha 自有工具(L0)则等于
  重写 provider 选路 + 传输 + 权限流程,并要压掉上游同名工具(`registry.ts` 闸在守卫内,
  见 [[ADR-009]] 裁决 (b)),比接管两文件大一个量级。
- **L1 变换**:失败语义不是文本/品牌层面的替换,是控制流(错误通道类型 + 状态分支)。
  build-time transform 表达不了,运行时 transform 无处挂。
- **L2 补丁**:技术上可行,但 alpha 至今**没有** patch 施加机制(ADR-004 只为 `/api/*`
  预留了通道,从未建成),#489 暂缓的原因就是等这台机器。为两个文件新建一台 L2 机器
  (施加步 + loud-fail + CI 集成 + 上游漂移维护面),成本高于把两个低 churn 文件冻结。
  这两个文件在上游属低频变更的叶子(工具实现,无人依赖其内部),L3 的代价在此最小。

### 3. 守卫形态(§3 要件)

沿用 [[ADR-033]] 的**文件级 `:(exclude)`** 机制(不是 ADR-020 的整包移出——`packages/opencode`
与 `packages/core` 其余部分仍是高频同步面,必须继续被守着)。两处 exclude 清单同步加**这三条源
文件**(测试文件不在内,理由见 §1),且必须保持一致:

- `.github/workflows/alpha-ci.yml` 的 `upstream-guard` job(CI 强制面)。
- `scripts/alpha-check.sh` 的 `[1/3] north-star guard`(本地先手面,`.githooks/pre-push` 走它)。

> **顺带修复的既有漂移**:`scripts/alpha-check.sh` 此前**完全没有** exclude 清单,`UPSTREAM_PATHS`
> 也停在 ADR-033 之前的五个包 —— 即本地守卫自 ADR-033 起对 16 个被接管/生成文件恒报假红,
> 与 CI 早已不是 1:1。本 ADR 落地时把它与 `alpha-ci.yml` 恢复逐条对齐,否则「本地先跑守卫」
> 这条纪律拿到的永远是噪声。

北极星指标(升级 sync 后冲突文件数 = 0)语义不变;衡量对象缩为「真正零改的上游」。

### 4. 回退方案(§3 要件)

撤销接管走 L3 唯一写通道 = 受控 re-freeze:用某上游 ref 覆盖这三个文件 + 从两处 exclude 清单
移除对应三行 + 删除 alpha 自有的 `test/tool/alpha-websearch-failure.test.ts` /
`packages/core/test/alpha-websearch-sovereignty.test.ts` /
`packages/ui-mac/src/main/websearch-copies.test.ts` + 把失败诚实与主权闸需求降级重表达
(等 L2 patch 机制建成后改走 L2)。代价 = 回退本次失败映射(回到「一切错误塌成 defect」)
**并且**两份 websearch 副本同时回到「主权 deny 可被后置 permission 顶掉」。

### 5. 放弃白嫖范围声明(§3 的 L3 专属要件,单向门)

这三个文件的**上游 churn 与安全修复不再自动进入 alpha**。具体放弃的白嫖面:上游对 Exa /
Parallel 端点、MCP 请求形状、provider 选路策略的后续改动(V1 与 V2 两份各自的),以及这三个文件
里的任何上游安全修复。吸收上游改进的唯一通道 = 受控 re-freeze(逐案评估)。
**owner 2026-07-25 明示接受前两个文件;第三个(`packages/core/src/tool/websearch.ts`)是同一裁决
在 R3 事实更正后的延续 —— 同类叶子、同机制、改动面仅首行一句闸,未另开新的接管类别。**

风险与缓解:端点/请求形状漂移的表现是**运行时失败**而非编译红。缓解 = 本次接管把失败改成
LOUD 且带上游 body —— 端点变了会直接以可辨失败暴露,而不是像接管前那样塌成一个没有信息的
defect。这是本决策自带的 tripwire。

## 后果

- ✅ #489(E7 失败诚实)解锁并交付:**本地 Exa/Parallel 直连链路**的失败集覆盖 `401` / `403`
  (带 `error.code`,`action_forbidden` 与 `job_not_enforceable` 可区分)/ `400` / `402`
  (preauth 拒绝、per-job 超预算)/ `502` / 其余非 2xx 一律 LOUD;空结果不再伪装成成功;
  传输层 defect 收进同一可辨类型。
- ✅ 零命中与 provider error 的判定按结构化事实收口(#223 Major 5):`structuredContent` 进
  schema —— 「`content: []` + `results: []`」是**合法零命中成功**(原样交出 `structuredContent`,
  不编造 "No search results found");「200 + 未置 `isError` 但负载是 `{error:…}`」是**loud
  provider error**,不再当搜索结果回给模型;200 的 HTML/非 JSON 错误页在 `empty_result` 里
  附上原 body,可辨。
  **2026-07-25 二轮更正(R2 Major 5)**:初版这里写「带 `error.code`」——**对模型不成立**,已修。
  `code` 当时只存在字段上,`WebSearchFailure.message` 仅在**有 HTTP status 时**才把它拼进去,而
  工具边界只把 `failure.message` 交给模型(`websearch.ts` 的 `ToolFailure({ message })`)。现在
  status 与 code 各自独立出现在 message 里,回归断言从**最终 `ToolFailure`** 面取(不是中间层)。
- ✅ 传输有界(#223 Major 6):headers + body 读取在**同一个** timeout 内(此前 body 在期限外,
  body 永不结束 = 无限等待且零失败),body 边读边计数。
  **2026-07-25 二轮更正(R2 Major 6)**:初版这里写「2MiB 处停手」——**当时不成立**,已修。实现
  先整块 `push(chunk)` 再判越界,上限只对「块小」的流有效:R2 喂入单个 3 MiB chunk,`Buffer.concat`
  实收 **3,145,728** 字节而声明上限是 **2,097,152**。现在最后一块只保留「剩余可读字节」
  (`subarray`),`MAX_BODY_BYTES` 是与块大小无关的**硬限**,由一条按字节精确断言的测试守住。
- ✅ **主权 deny 的最终规则(#223 R2 Blocker 1 + R3 补全)**:**两份**已挂载的 `websearch` 副本
  (`packages/opencode/src/tool/websearch.ts` 与 `packages/core/src/tool/websearch.ts`)的 `execute`
  首行都读 `ALPHA_LOCAL_WEBSEARCH_DENY`(由 `ui-mac` 的 `applyWebSearchSovereignty()` 每次 fork
  前重算、经 `sidecar-env.ts` 白名单进 sidecar)并直接以 `ToolFailure` 拒绝。它们**不查 permission
  ruleset**,因此 agent wildcard / 持久 session permission / `approved` 三条后置规则都覆盖不了
  (裁决与反向测试见 [[ADR-009]] 裁决 (b))。
  **2026-07-26 更正(R3 Blocker 1)**:初版这里写「`websearch.ts` 的 execute 首行」并据此声称能力
  真关 —— 当时**只覆盖了 legacy 一份副本**,V2 Core 那份不读这个信号、走自己的 permission 后直接
  调 Exa/Parallel。已按上文补齐,并加了防第四份副本的普查闸
  (`packages/ui-mac/src/main/websearch-copies.test.ts`)。真实 V2 链路的回归证据在
  `packages/core/test/alpha-websearch-sovereignty.test.ts`(真 `ToolRegistry.materialize()` +
  `settle()`,含「显式 allow 的 ruleset 也顶不掉」与「permission 层根本没被咨询」两条)。
- ⚠️ **这两条回归跑在 alpha 的合并闸之外**:`scripts/alpha-check.sh` 与 `alpha-ci.yml` 只跑
  contracts-consumer / ext / ui-mac 三个包的测试,`packages/core` 与 `packages/opencode` 的测试
  两处都不跑。因此本轮把**机制事实**(集合普查 + 闸的位置 + 上游次序前提)固化在 ui-mac 与 ext
  的测试里 —— 那两处才是真的会拦住 PR 的地方;engine 侧那两个文件是**行为证据**,需人工跑
  (`bun test test/alpha-websearch-sovereignty.test.ts`)。把 engine 测试纳入合并闸是独立议题,
  不在本 ADR 范围。
- ✅ 本地 `scripts/alpha-check.sh` 的 north-star 守卫与 CI 恢复 1:1,不再恒报假红。
- ⚠️ **单向门**:两个文件脱离上游同步(含安全修复),re-freeze 是唯一吸收通道。
- ⚠️ 接管面每多一处,「北极星」衡量的分母就小一点。本 ADR 的自限是**只收三个源文件**(全部是
  websearch 工具叶子):云路径(`catalog.ts` / `code-mode.ts`)、`session/tools.ts`、
  `permission/index.ts`、`registry.ts`、`location-services.ts`、`builtins.ts` 与上游测试文件
  **明确不收**,理由已在 §1 记录,后续若要收须自己的 ADR。
- ⚠️ **云链路仍无失败分类**(#223 Major 2):`cloud_web_search` 的失败是 loud 且带完整 gateway
  body,但没有 HTTP 状态、没有统一 `error.code` —— 状态在平台薄壳被丢弃。归 **alpha-platform#105**。
  本仓以 `alpha-websearch-failure.test.ts` 的反向断言把这个事实钉住,防止文档再次跑到事实前面。
- ✅ [[ADR-009]] 的「未竟 · #489」条目随本次交付关闭并更正(同 PR)。
