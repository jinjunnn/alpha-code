# 本地腿与云腿、按账户选路:今天的地面真相(`#1414` 只读勘破)

> **勘破,不是方案。** 本文只回答「今天是什么样」,每一条都给坐标 + 实测输出。
> 选型、咽喉点、AC 的收口**不在本文**,由方案基线在本文之上写。
> owner 的选择题只在 §8 罗列代价,不给推荐。

相邻的两份已钉死的勘破,本文**引用不重做**。两份都**还没合进 `alpha`**,所以这里给的是
分支与 commit 而不是相对链接(链接会让 docs 链接闸红,那是真红不是假红):

| 文档 | 在哪 |
| --- | --- |
| `docs/architecture/2026-09-23-webfetch-egress-decision-chain.md`(`#1412`)—— webfetch 被出网围栏拒的七格判定链,结论「设计问题不是配置问题」 | 分支 `feat/1412-egress-recon` @ `dfca0be4e` |
| `docs/architecture/2026-09-23-runtime-permission-tiers.md`(`#1413`)—— 权限档现状 | 分支 `docs/1413-permission-tiers-recon` @ `3f4afcdbd` |

三份合并后要把这里改成相对链接,并在 `docs/README.md` 里彼此对照。

## 0. 测量口径

| | |
| --- | --- |
| alpha-code | `f56748c4f`(`origin/alpha`),worktree `.worktrees/1414-recon`(bootstrap 过) |
| alpha-platform | **`12cccbf` = `origin/main`**,worktree `.worktrees/476-verify`,`git status --porcelain` = 0 行 |
| ⚠️ 差点量错的树 | alpha-platform 的**主 checkout 停在 `fix/426-deepseek-direct-cap` @ `c492003`**,它**不是** `main` 的祖先:`git diff --stat origin/main..HEAD` 在 `cloud-mcp.ts` / `mcp-tool-registry.ts` 两个文件上就是 `6 insertions / 114 deletions`(`ap#461` 的 `ToolAnnotations` 整段在那棵树上不存在)。第一轮测量跑在那棵树上,**工具集合结论相同,但坐标与 annotations 全不对**;本文所有云侧数字已在 `origin/main` 上重跑。判据:量之前先 `git branch --show-current` + `git merge-base --is-ancestor HEAD origin/main` |
| 云侧探针运行时 | `node --import tsx`,cwd = `packages/gateway`,用**生产自己的**构造函数 `buildMcpServer` + `agents@0.20.1` 的 `createMcpHandler` |
| 装着的 MCP 包 | 服务端 `@modelcontextprotocol/server@2.0.0`(生产依赖);客户端探针 `@modelcontextprotocol/client@2.0.0`;桌面引擎 `@modelcontextprotocol/sdk@1.29.0`(`packages/opencode/package.json:83`) |
| 线上 | `https://alpha-cloud.tidelabs.click`,2026-09-23 08:24Z |
| 日期 | 2026-09-23 |

⚠️ 本仓踩过「装着的那个版本 ≠ 生产用的那个包」:`packages/gateway/package.json` 里
`mcp-sdk-desktop` 是 **别名安装** `@modelcontextprotocol/sdk@1.29.0` 的 devDependency,
**不是**云侧生产用的包。本文所有云侧结论都走 `@modelcontextprotocol/server@2.0.0`。

---

## 1. 云侧今天暴露哪几个工具(实跑,不抄文档)

探针驱动**生产唯一构造点** `buildMcpServer`(`packages/gateway/src/cloud-mcp.ts:70`),
经 `InMemoryTransport` 用真 client 跑 `listTools()`。原始输出:

```
=== listTools() from production buildMcpServer ===
cloud_artifacts   billing=none cost=none shape=sync-fixed tenantMetered=false | annotations readOnly=true  destructive=false openWorld=false | action=artifact.read
cloud_await       billing=none cost=none shape=sync-fixed tenantMetered=false | annotations readOnly=true  destructive=false openWorld=false | action=cloud.read
cloud_cancel      billing=none cost=none shape=sync-fixed tenantMetered=false | annotations readOnly=false destructive=false openWorld=false | action=cloud.dispatch
cloud_dispatch    billing=none cost=none shape=async-job  tenantMetered=true  | annotations readOnly=false destructive=false openWorld=true  | action=cloud.dispatch
cloud_status      billing=none cost=none shape=sync-fixed tenantMetered=false | annotations readOnly=true  destructive=false openWorld=false | action=cloud.read
cloud_web_search  billing=forwarded:/v1/tools/web_search cost=ours shape=sync-fixed tenantMetered=true | annotations readOnly=false destructive=false openWorld=true | action=cloud.dispatch|model.invoke
count=6
has(cloud_web_fetch)=false
has(cloud_fetch)=false
has(webfetch)=false
has(web_fetch)=false
has(cloud_web_search)=true
```

后五行是**先证明手段能测出已知的坏**:四根故意不存在的针全 `false`,一根已知存在的针 `true`
—— 这个探针不会幻觉命中,也不是恒真。

**⇒ 云侧今天是 6 个工具,其中没有任何形式的 web fetch。** 这是全称事实,已跑过。

### 1.1 花不花钱(权威 = `packages/gateway/src/lib/mcp-tool-registry.ts:68-116`)

| 工具 | 入口直接费用 | 消耗租户桶 | 备注 |
| --- | --- | --- | --- |
| `cloud_status` / `cloud_await` / `cloud_artifacts` | 无 | 否 | 纯读面,`#203` 有意不计量(轮询稍密就会 429) |
| `cloud_cancel` | 无 | 否 | `ap#258`:取消是止损动作,不该被容量桶挡住 |
| `cloud_dispatch` | 无 | **是** | 派发本身免费;**下游异步作业按 job token 逐 token 计费**,不归 `billingPolicy` 管(注册表 `:53-55` 明写 `none` ≠「完全免费」) |
| `cloud_web_search` | **有** | 是 | `forwarded:/v1/tools/web_search`,`costSource:ours`,per-call 计费归调用租户 |

**票面里「读面三个工具不花钱」这句要修正为四个**:`cloud_cancel` 同样零费用、零租户桶。
**唯一有入口直接费用的是 `cloud_web_search`。**

顺带一条与选路直接相关的:`ap#461` 之后,工具面还广播一组**从同一张表派生**的 `ToolAnnotations`
(`mcp-tool-registry.ts:171` 的 `MCP_READ_ONLY_ACTIONS`、`:180` 的 `toolAnnotationsFor`,
统一挂点 `cloud-mcp.ts:113`)。上表那栏 `annotations` 就是 `listTools()` 真的回给客户端的值:
三个读工具 `readOnlyHint=true`,`cloud_cancel` 因为受理 `cloud.dispatch` 被正确判成**非只读**,
`cloud_dispatch` / `cloud_web_search` 是 `openWorldHint=true`。
**它不是安全边界**(该文件自陈,规范也这么写),但它证明云侧**已经有一条「按注册表一行的形态、
逐工具广播不同元数据」的既有通道** —— 与 §2.2 的 per-account 工具集是同一个入口。

### 1.2 线上与 HEAD 是否同一份工具面(部分证据,不是充分证据)

`/mcp` 未认证时 `tools/list` 拿不到工具面 —— 传输层闸排在 handler 之前
(`packages/gateway/src/cloud.ts:256`,`guardMcpTransport`),实测:

```
POST https://alpha-cloud.tidelabs.click/mcp  {"method":"tools/list"}  → HTTP=401
www-authenticate: Bearer error="invalid_token", …, scope="artifact.read cloud.dispatch cloud.read model.invoke"
```

```
GET https://alpha-cloud.tidelabs.click/.well-known/oauth-protected-resource → 200
{"resource":"…/mcp","authorization_servers":["https://auth.tidelabs.click"],
 "scopes_supported":["artifact.read","cloud.dispatch","cloud.read","model.invoke"],"resource_name":"alpha-cloud"}
```

线上广播的 `scopes_supported` 与 HEAD 的 `MCP_SUPPORTED_SCOPES`(注册表 `requiredAction` 并集,
`mcp-tool-registry.ts:132-134`)**逐字相同**。

**诚实边界**:这是**必要非充分**。一个复用既有 action 的新工具不会改变这个并集,
所以它只能排除「线上多出一个用新 action 的工具」,排不掉「线上多/少一个用旧 action 的工具」。
要真的枚举线上工具面需要一张有效 `mcp_access` 令牌,**我手里没有,这一格没测到**。
`/health` 不带 version/sha(实测回包只有 `routes` 与 `readiness`),也给不出发布点对照。

---

## 2. 远端 MCP 的 per-tool 过滤能力

答案分两侧,**结论相反**,而现有代码注释只写了其中一侧。

### 2.1 桌面引擎(客户端):**没有**,只有整 server 开关 —— 属实

- 配置形状 `packages/core/src/v1/config/mcp.ts:44-60`:`Remote` 的字段只有
  `type` / `url` / `enabled` / `headers` / `oauth` / `timeout`。**没有任何 per-tool 字段。**
- 注册逻辑 `packages/opencode/src/mcp/index.ts:705-735`:对每个 connected client,
  把 `s.defs[clientName]` 里**远端列出的每一个** tool 无条件写进结果表,零过滤钩子。
- 整 server 关的语义 `packages/opencode/src/mcp/index.ts:406-410` 与 `:549-552`:
  `enabled === false` ⇒ `DISABLED_RESULT` / `status = "disabled"`,不建 client、不留 defs。
- 这正是 `packages/ui-mac/src/main/cloud-web-search.ts:42-48` 与
  `:184-190` 那条 `TODO(alpha-code#490)` 记着的事实。

桌面侧真实存在的 per-tool 过滤点在**更下游**,不在 MCP 层:

| 过滤点 | 坐标 | 生效时刻 | 能不能被顶掉 |
| --- | --- | --- | --- |
| `Permission.disabled`(工具表可见性) | `packages/opencode/src/session/llm/request.ts:234-244` | **每次 LLM 请求** | 能 —— agent wildcard / session permission / `approved` 都排在后面 |
| `AlphaToolPolicy` 目录闸 | `request.ts:155`(`snapshotCatalogDenied`) | 每次 LLM 请求 | deny 不可被 session grant 撬开 |
| `user.tools[k] !== false` | `request.ts:243` | 每次 LLM 请求 | 用户自己的开关 |
| ext 的 `tool.execute.before` | `packages/ext/src/cloud-websearch-kill.ts:291-298` | **执行那一刻**,早于 `ctx.ask` | 不能(抛错即 die) |

### 2.2 云侧(服务端):**有,而且装着的包直接支持按账户变工具集**

装着的 `@modelcontextprotocol/server@2.0.0` 的类型声明(读的是
`node_modules/@modelcontextprotocol/server/dist/createMcpHandler-CLhGwQTn.d.mts`):

```ts
// :3808
type McpServerFactory = (ctx: McpRequestContext) => McpServer | Server | Promise<McpServer | Server>;

// :3781-3798
interface McpRequestContext {
  era: 'legacy' | 'modern';
  authInfo?: AuthInfo;      // pass-through,HTTP only
  requestInfo?: Request;    // 本次 HTTP 请求原件
}
```

包自己的文档注释(同文件 `:3776-3778`)逐字写着:
*"the context exists for factories that vary by principal or era (for example multi-tenant servers keyed off `authInfo`…)"*。

同包 `RegisteredTool`(`:3461-3496`)还带 `enable()` / `disable()` / `update()` / `remove()`。

**实跑验证**(用生产同一条承载层 `agents/mcp/server` 的 `createMcpHandler`,同一个 handler,
只改一个请求头):

```
free  => {"status":200, tools:[always_here]}
paid  => {"status":200, tools:[always_here, paid_only]}
factory ctx seen => {"keys":["era","requestInfo"],"era":"legacy","hasAuthInfo":false,
                     "hasRequestInfo":true,"authHeader":"Bearer probe-paid"}
async factory awaited => true
```

三件事被实测钉住:①同一个 handler 能对不同请求广播**不同的工具集**;
②工厂**可以是 async**(探针在注册前 `await` 了 5ms 才返回 server)⇒ 「先鉴权/查额度再决定工具集」在承载层可表达;
③工厂拿得到本次请求的 `Authorization` 头(经 `ctx.requestInfo`)。

**今天挡在前面的是我们自己的两条,不是包**:

1. `packages/gateway/src/cloud.ts:236-238` 传的是**零参同步**工厂
   `() => buildMcpServer(c.env, authHeader, clientIp)`,`ctx` 一个字都没用。
2. `packages/gateway/src/cloud-mcp.ts:268` 是构造期不变量:
   「注册表登记了 X 但本文件没有实现 ⇒ 抛」。**按账户少挂一个工具会当场把 server 构造失败。**
   另一半在 `test/mcp-tool-registry-187.test.ts:176-183`:`listTools` 名字集合 == 注册表键集合。

`ctx.authInfo` 今天恒 `undefined`,因为 `cloud.ts` 走的是 `handler(request, env, ctx)` 三参形态,
没有传 `requestOptions.authInfo`(`agents` 的 `handler-stateless-CIkKPETH.js:290-296` 显示
`authInfo` 只从 `requestOptions` 或已验证的 OAuth 路径来)。

### 2.3 工具表变化能不能推给已连着的桌面

引擎装了 `ToolListChangedNotification` 处理器并会重新 `listTools`
(`packages/opencode/src/mcp/index.ts:496-503`)。但云侧是 **stateless per-request**、
`maxSubscriptions: 0`、非 POST 早退(`cloud.ts:243`;`:252` 注明 GET/DELETE 是 405),**我没有测到一条能把 notification
推回桌面的通道**。「账户额度中途耗尽 ⇒ 工具当场从模型工具表消失」这一格,**本轮没测,不要当成已知**。

---

## 3. 本地 websearch 今天怎么被门控

### 3.1 票面那条坐标是错的,先更正

票面写「闸门 `registry.ts` 的 `webSearchEnabled()`,判据 `ALPHA_CLOUD_TOKEN` + `ALPHA_CLOUD_MCP_URL`」。
实读 `packages/opencode/src/tool/registry.ts:63-70`:

```ts
export function webSearchEnabled(providerID: ProviderV2.ID, flags = { exa: false, parallel: false }) {
  return (
    providerID === ProviderV2.ID.opencode ||
    providerID === ProviderV2.ID.make("opencode-go") ||
    flags.exa ||
    flags.parallel
  )
}
```

**它一个字都不认账户**。它是上游的 provider 门控(只给 Zen provider,或 Exa/Parallel flag 开着时给所有 provider),
调用点在 `registry.ts:335-338`,**每次 `ToolRegistry.tools()` 求值一次**(即每轮模型请求)。

### 3.2 今天真正的本地/云选路点(共 4 层,判据分布在 5 处)

```
[main 进程,每次 fork 前]
  server.ts:321  applyWebSearchSovereignty(userDataPath)
    :323  killSwitch    = Boolean(ALPHA_WEBSEARCH_DISABLE)
    :327  platformPays  = Boolean(ALPHA_CLOUD_MCP_URL) && hasSecretFile(userData,"ALPHA_MCP_TOKEN")
    killSwitch            ⇒ ALPHA_CLOUD_WEBSEARCH_DENY=1
    killSwitch||platformPays ⇒ 4 个 keyless flag 覆盖写 "0" + ALPHA_LOCAL_WEBSEARCH_DENY=1
    否则                  ⇒ 删除两个 DENY、还原 keyless 基线、OPENCODE_ENABLE_EXA ??= "1"

[注入面,同一次 fork]
  alpha-config-injection.ts:100  platformPays(**第二次算同一个判据**,注释明写「不许各算各的」)
  alpha-config-injection.ts:373 → cloud-web-search.ts:173 applyWebSearchDenies ⇒ permission deny 注入
                                 (注释 :168-171 自陈「不是主权保证,只是可用性」)
  alpha-config-injection.ts:303-312 + cloud-sidecar-config.ts:33-49 materializeCloudMcpConfig
      platformPays  ⇒ {type:remote, url, enabled:true, headers.Authorization:"Bearer {file:…ALPHA_MCP_TOKEN}"}
      不代付        ⇒ {type:remote, url, enabled:false}     ← 云腿整条关掉
      killSwitch    ⇒ WITHHELD_CLOUD_MCP(url=http://127.0.0.1:1)  ← 云腿整条关掉

[sidecar 内,每轮 LLM 请求]
  registry.ts:335-338      webSearchEnabled(providerID, {exa,parallel})     ← 与账户无关
  llm/request.ts:155,164   policyDenied ∪ Permission.disabled ∪ user.tools

[执行那一刻]
  opencode/src/tool/websearch.ts:145-151       localWebSearchDenied() ⇒ ToolFailure
  core/src/tool/websearch.ts:208 / :261        同上(叶子 + 传输两道)
  opencode/src/tool/mcp-websearch.ts(call)     传输首行
  ext/src/cloud-websearch-kill.ts:291-298      tool.execute.before,对任何 MCP server 上的 web search 形态生效
```

逃生开关 `ALPHA_WEBSEARCH_DISABLE=1` 属实(`server.ts:323`、`alpha-config-injection.ts:103`,
并在 `sidecar-env.ts:66` 的白名单里)。

被拒时模型收到的原话(`packages/core/src/tool/websearch.ts:46-47`):

> Web search is unavailable: the local keyless websearch tool is denied by alpha sovereignty
> (ADR-009 B1/B2 …). This is not a transient failure; do not retry.
> **Use `cloud_cloud_web_search` if it is present**, otherwise answer without web search and say so.

—— 这句话本身就是票面描述的那个缺陷的**成文形态**:它假定本地被关时云腿一定可用。

### 3.3 副本集合:实跑列出

`packages/ui-mac/src/main/websearch-copies.test.ts` 是 ADR-035 的普查闸。在主 checkout 实跑:

```
$ cd packages/ui-mac && bun test src/main/websearch-copies.test.ts
 12 pass / 0 fail / 57 expect() calls   Ran 12 tests across 1 file. [179.00ms]   EXIT=0
```

它只断言不打印,所以另跑一次**独立扫描**把集合列出来(同一套 pattern,扫 `packages/*/src`,
排除 `*.test.ts`,并带一根故意不存在的负针):

```
packages scanned: alpha-contracts-consumer app cli client codemode console containers core desktop docs
  effect-drizzle-sqlite effect-sqlite-node enterprise ext function http-recorder httpapi-codegen identity
  llm opencode plugin protocol schema script sdk sdk-next server session-ui slack stats storybook tui ui ui-mac web
source files scanned: 2490
--- websearch registrations ---
  packages/core/src/tool/websearch.ts
  packages/opencode/src/tool/websearch.ts
--- files naming Exa/Parallel endpoints ---
  packages/core/src/tool/websearch.ts
  packages/ext/src/cloud-websearch-kill.ts        ← 已登记的「纯说明」,普查闸另有断言证明它不出网
  packages/opencode/src/tool/mcp-websearch.ts
--- webfetch registrations ---
  packages/core/src/tool/webfetch.ts
  packages/opencode/src/tool/webfetch.ts
negative needle hits (must be 0): 0
```

**两件事要点名**:

1. **`webfetch` 同样是两份,而它没有对应的普查闸。** websearch 有
   `websearch-copies.test.ts` 钉着;我用文件名与字面量两条轴查过,**没有**任何测试钉住
   webfetch 的副本集合。选路点若只接一份 webfetch,不会有任何东西变红。
2. **`packages/core` 那一份是活的。** 证据链:
   `packages/core/src/tool/builtins.ts` 的 `node` 依赖里含 `WebFetchTool.node` / `WebSearchTool.node`
   → `packages/core/src/location-services.ts:35` 引入 `BuiltInTools`、`:75` 把 `BuiltInTools.node` 放进
   `locationServices` → `packages/opencode/src/session/session.ts:15`(以及 `agent/agent.ts:30`、
   `session/system.ts:23` 等)装载 `locationServiceMapLayer`。
   ⚠️ 这与 `#1412` 勘破文档「更正 1」里那句「`packages/core` 下那份是并行实现,**不在这条路径上**」
   在字面上冲突。两者可以同时为真(`core` 那份被**装载**,而一次普通会话轮次的工具调用走
   `packages/opencode` 的 ToolRegistry),但**「哪一份服务哪一轮」我本轮没有实测**,
   不要当成已知。要给 webfetch 立闸,这一格必须先跑出来。

---

## 4. 账户/额度信号:谁是权威,什么时候可得

### 4.1 唯一权威是 account 服务,而且是**逐次调用**的

```
cloud_web_search (cloud-mcp.ts:255)
  → GATEWAY.fetch(/v1/tools/web_search)
    → worker.ts:2457  authTenant(...)                        身份
    → worker.ts:2500  accountPreauth(env, auth, "tool.web_search", "web-search", {reservationId})
        → worker.ts:356-429  POST {ACCOUNT_URL}/…/preauthorize(带内部 grant,10s 超时)
            j.ok === true  ⇒ 放行
            j.ok === false ⇒ worker.ts:418  { status: 402, message: "预授权拒绝: …", code? }
            其它一切形状   ⇒ 503 fail-closed(#43)
    → worker.ts:2503  pre.err ⇒ c.json({error:{message, code}}, 402)
  → cloud-mcp.ts:261      text(body, !r.ok)  ⇒ MCP 结果 isError:true + 那份 JSON
```

- 拒绝码值域在 `packages/gateway/src/contracts/v1/failure-codes.ts:20`
  (`account_wallet_insufficient` 等);gateway **只转发不发明**(`worker.ts:418` 的
  `isFailureCode(j.code)`)。
- `env.ACCOUNT_URL` 缺席时 `accountPreauth` 直接放行(`worker.ts:357`);prod 由 readiness
  闸拦住(`worker.ts:242` 注释)。

**⇒ 「这次调用有没有额度」只有在调用发生时才有答案,而且答案来自 account 服务的一次 reservation。
本地无论如何造不出一个权威的 allow**(`packages/opencode/src/permission/alpha-tool-policy.ts:100-101`
的注释就是这么写的)。

### 4.2 桌面侧今天有的是三份**互不相同**的近似值

| # | 判据 | 坐标 | 在哪个进程 | 什么时候可得 | 它其实在说什么 |
| --- | --- | --- | --- | --- | --- |
| A | `platformPays` = `ALPHA_CLOUD_MCP_URL` && 有 `ALPHA_MCP_TOKEN` 密钥文件 | `server.ts:327` / `alpha-config-injection.ts:100` | main | **每次 fork 前**(注册/注入时可得) | 「登录了」,**不是**「有额度」 |
| B | `summaryUsable` = `plan.status === "active" \|\| balanceFen > 0` | `alpha-composer.tsx:997-1001` | **renderer** | 账户 summary 拉回之后 | 「能不能用平台代理模型」 |
| C | `caps.entitlement`(`"allow" \| "deny" \| "missing"`) | `alpha-tool-policy.ts:100-101, 137-138` | sidecar | —— | **服务端 entitlement,但今天没有任何生产调用点传它** |

C 是本次勘破里最值得写下来的一格:**`entitlement` 这个 cap 已经设计好、已经有 disabled 分支
(`:137-138`),但生产唯一的调用路径 `alpha-tool-policy-gate.ts:70-89` 的 `foldRulesetCap`
只产出 `{hardDeny}`**,`resolve(subject, caps)` 的 `caps.entitlement` 恒 `undefined`。
两条轴查过(符号 `entitlement` 全仓非测试命中 = 上表那几行;`caps: {` 全仓非测试命中 = 唯一一处
`alpha-tool-policy.ts:261`)。⇒ **`cap-entitlement` 今天是死分支。**

### 4.3 账户信号到不了 sidecar

`packages/ui-mac/src/main/sidecar-env.ts:30-95` 的白名单里,与账户有关的只有三个布尔:
`ALPHA_WEBSEARCH_DISABLE`(`:66`)、`ALPHA_LOCAL_WEBSEARCH_DENY`(`:70`)、
`ALPHA_CLOUD_WEBSEARCH_DENY`(`:73`)。**没有任何余额 / 套餐 / entitlement 通道**,
而前两个编码的是判据 A(登录),不是额度。

---

## 5. 关掉整个 cloud MCP server 会连带关掉什么

`ConfigMCPV1.Remote` 只有整 server 的 `enabled`(§2.1),而 `MCP.create` 对
`enabled === false` 直接 `DISABLED_RESULT`、不建 client 也不留 defs
(`packages/opencode/src/mcp/index.ts:406-410`;并行的目录装载分支 `:549-552` 同义)。

**⇒ 被连带关掉的是 §1 那 6 个的全集:**
`cloud_dispatch` · `cloud_status` · `cloud_await` · `cloud_artifacts` · `cloud_cancel` · `cloud_web_search`。

票面那句「关了用户连查看已有作业都做不了」**属实**,而且范围比票面写的更大 ——
连**取消一个在跑的作业**(`cloud_cancel`)都一起没了。

**今天已经有两条路会触发这个全关**,不是假想:

1. `platformPays === false`(登出 / 缺 `ALPHA_MCP_TOKEN` 密钥文件)⇒
   `materializeCloudMcpConfig(url, undefined)` 产出 `enabled:false`
   (`packages/ui-mac/src/main/cloud-sidecar-config.ts:33-41`);
2. `ALPHA_WEBSEARCH_DISABLE=1` ⇒ 写 `WITHHELD_CLOUD_MCP`(`url=http://127.0.0.1:1`,
   `cloud-web-search.ts:75-80`)—— 注释 `:71-73` 自陈这是「诚实降级,连兄弟工具一起损失」。

也就是说:**「一个 kill-switch 关掉一个具名能力」这条 ADR-009 B2 的承诺,在云腿上今天不成立**
—— 它关掉的是六个。

---

## 6. 还有哪些地方已经在替用户做这个决定

按「谁在替谁决定」列全,坐标可点:

| # | 决定者 | 坐标 | 它替用户决定的是 | 判据 | 风险形态 |
| --- | --- | --- | --- | --- | --- |
| 1 | `applyWebSearchSovereignty` | `ui-mac/src/main/server.ts:321-350` | 本地 keyless 腿开不开 | 登录(判据 A)+ kill-switch | 今天这条就是「登录即关本地」的执行点 |
| 2 | `injectAlphaConfig` 里的第二次 `platformPays` | `ui-mac/src/main/alpha-config-injection.ts:100` | 云 server 装不装、装成什么形状 | 同判据 A | 同一判据**两处各算一遍**(注释自陈风险) |
| 3 | `applyWebSearchDenies` | `ui-mac/src/main/cloud-web-search.ts:173-203`,调用点 `alpha-config-injection.ts:373` | 两个 web search 工具在模型工具表里可不可见 | 同判据 A + kill-switch | 注释 `:168-171` 自陈「不是主权保证,只是可用性」 |
| 4 | `webSearchEnabled` | `opencode/src/tool/registry.ts:63-70, 335-338` | 本地 `websearch` 注不注册给这一轮的模型 | **providerID / Exa / Parallel flag** | 与账户完全无关;`OPENCODE_EXPERIMENTAL=1` 会让它恒真(ADR-009 `:93` 记着) |
| 5 | ext `tool.execute.before` | `ext/src/cloud-websearch-kill.ts:263-298` | 任何 MCP server 上「看起来像 web search」的工具能不能执行 | 工具 id 词元启发式 + server 归属 | 词表 `:148-163` 自陈「非穷尽」 |
| 6 | **`buildAlphaCapabilities`** | `ui-mac/src/main/alpha-identity.ts:17-26` | **直接在系统提示里告诉模型「web search 可用」** | `!websearchDisabled && (OPENCODE_ENABLE_EXA !== "0" \|\| cloudDispatch)` | **第四处各算各的**;它写进提示词,和真闸不同源 ⇒ 可以「提示说有、调用被拒」 |
| 7 | `resolveTools` | `opencode/src/session/llm/request.ts:231-245` | 每轮模型工具表的最终三路并集 | user.tools ∪ Permission.disabled ∪ policyDenied | 唯一一个**每轮重算、覆盖全部工具**的点 |
| 8 | **模型默认解析链** | `ui-mac/src/renderer/alpha-ui/model-default-core.ts:6, 29, 64, 82` | 默认给用户选哪个模型 | `loggedIn` **且** `accountUsable`(判据 B) | **同形先例**:文件头 `:6` 逐字记着上一次的用户报障正是「只看 logged-in,不看账户 entitlement」 |
| 9 | gateway failover | `gateway/src/lib/failover.ts:15-56` | 上游 provider 之间选路 | 402 / 429+insufficient_quota / 403 | 不同轴(provider 选路),但它证明**服务端已有一套「按额度改路」的既有词汇** |

**第 8 条值得单独读一遍**:同一个产品里,「按账户选路」这件事已经被做过一次,
而且**第一版正是只看登录不看额度、并因此收到用户报障**(`model-default-core.ts:1-6`)。
本票要做的事与它同形,判据 B 就住在那条链上。

---

## 7. 云侧其实已经有一份 web fetch 实现(没有任何人在调)

`packages/gateway/src/lib/web.ts`:

- `:6-34` `isBlockedHost()` —— localhost/`.internal`/`.local`、云元数据 `169.254.169.254`、
  我方基础设施(`*.workers.dev` / `*.cfargotunnel.com` / `codepuppy.cn` / `tidelabs.click` …
  按标签边界后缀匹配)、RFC1918 / CGNAT / 组播 / IPv6 私网。
- `:38-43` `validateUrl()` —— 只收 `http(s)`。
- `:46-77` `webFetch()` —— 手动跟 4 跳重定向且**每跳重验**,15s 超时,HTML 去标签,截断 4000 字符。
- `:80-92` `WEB_FETCH_TOOL` —— OpenAI-wire 的函数工具定义。
- 测试 `packages/gateway/test/web.test.ts`(`isBlockedHost`/`validateUrl` 相关断言 14 处)。

**但它今天零消费者。** 两条独立检索轴:

```
# 全部在 .worktrees/476-verify(= origin/main @ 12cccbf)里跑,单棵树,不混 worktree

轴 1(符号名)  $ grep -rn "WEB_FETCH_TOOL|webFetch\b" packages/ --include=*.ts --include=*.mjs --include=*.js
  packages/gateway/src/lib/web.ts:46 / :80 / :81      ← 只有它自己的定义,零调用点

轴 2(import 路径) $ grep -rn "lib/web.js" packages/gateway/src --include=*.ts
  packages/gateway/src/worker.ts:28: import { webSearch, type WebSearchFailureCode } from "./lib/web.js";
                                                        ↑ 只进了 webSearch

轴 3(注释点名的那三个消费者) $ grep -cinE "web_search|web_fetch" bounded-agent.ts pipelines.ts agent-runner.mjs
  packages/gateway/src/bounded-agent.ts:0
  packages/gateway/src/pipelines.ts:0
  packages/gateway/src/agent-runner.mjs:0
```

文件头 `:2` 写着「抽自 bounded-agent;给 bounded-agent + pipelines 复用」—— **那句话今天不成立**,
接线已经不在了。`BILLABLE_ROUTES`(`contracts/v1/billing-actions.ts:70-76`)里也只有
`/v1/chat/completions` / `/v1/messages` / `/v1/tools/web_search` / `/v1/web/search`,
**没有任何 fetch 路由**。

⇒ §1「云侧没有 web fetch」在**工具面/计费面**上成立;但「从零开始造」这个前提不成立 ——
**一份带 SSRF 闸、有测试的实现已经躺在仓里**,缺的是一条封印付费路由 + 一行 MCP 注册 + 计费档位。

---

## 8. 摆给 owner 的代价(不选,只定价)

### 8.1 云 web fetch:新增能力,还是不做

**新增的具体工作量(勘破后的真实清单,不是估算)**:
① `lib/web.ts` 的 `webFetch` 已存在 ⇒ 复用;
② 新增一条封印付费路由(`BILLABLE_ROUTES` + `billing-actions` 注册 + account 侧单价);
③ `MCP_TOOL_REGISTRY` 加一行(必须显式选 `shape`/`costSource`/`tenantMetered`,
构造期不变量 `mcp-tool-registry.ts:256-274` 会强制一致);
④ `cloud-mcp.ts` 加一个 `mount`。
**不新增**:出网围栏(云侧抓取发生在 Worker 上,`#1412` 那条链根本不涉及)。

**不做的代价**:webfetch 只剩本地一条腿,而那条腿**今天对任意 URL 都是 403**
(`#1412` 的勘破已钉死,且是设计问题)。也就是说「不做」等于「读网页这件事在本票范围内不修」——
它会被推给 `#1412` 那条独立票,而那张票的结论是必须改出网围栏的**设计**。

**SSRF 面的差异(不可逆的那一半)**:本地 webfetch 从用户机器出网,云 web fetch 从我们的
Worker 出网 ⇒ **抓取源 IP 变成我方基础设施**。`isBlockedHost` 已经挡了内网与我方域名,
但 `lib/web.ts:4-5` 的注释自陈「防不了 DNS rebinding」。这条一旦上线就是对外可达的抓取代理,
关掉容易,但**期间被滥用的记录不可回收**。

### 8.2 无额度时云腿怎么拒(这不是 AC,是选择题)

今天的形态是:云 `cloud_web_search` 返回 `isError:true` + 402 JSON(§4.1),**而本地腿已被关**
(§3.2),模型收到的是一次失败,没有退路。可选形状至少三种,代价不同:

- **保持「调用时才知道」**:零新增信号通道;代价是每次都要真打一次 402 往返,
  而且模型工具表里一直挂着一个注定失败的工具。
- **注册期就按账户决定工具集**(云侧可行,§2.2 实测):代价是要改
  `cloud-mcp.ts:268` 那条构造期不变量与 `test/mcp-tool-registry-187.test.ts:176-183` 那条等式闸
  —— 它们今天正是「工具面不会悄悄变」的保证;放宽它就要换一条等价强度的判据。
  另外「额度中途耗尽」还需要 §2.3 那条我没测到的推送通道。
- **把账户信号送进 sidecar**(判据 C 那个死分支的复活):代价是
  `sidecar-env.ts` 白名单要开一个新通道,且这个值天然会**过期**(fork 时算的,session 里一直用)。

### 8.3 kill-switch 今天关掉六个工具

§5 的事实与 ADR-009 B2「一开关一具名能力」直接冲突。要不要在本票里一并收口(让 kill-switch
只关 web search、保住 dispatch/status/await/artifacts/cancel),是一个**范围问题**,不是 AC。
不动的代价:ADR-009 B2 继续写着一件代码不做的事。

### 8.4 ADR-009 的文本今天已经和代码对不上(两处)

本票 AC3 要求「决策文件与代码说同一件事」。开工前先知道**它现在已经不同**:

| ADR-009 的原话 | 坐标 | 代码实际 | 坐标 |
| --- | --- | --- | --- |
| B1 判据 = `ALPHA_CLOUD_MCP_URL` + **`ALPHA_CLOUD_TOKEN`** 密钥文件;「`ALPHA_CLOUD_TOKEN` 仍然是 B1 的判据」 | `ADR-009:30-32, 61` | `ALPHA_CLOUD_MCP_URL` + **`ALPHA_MCP_TOKEN`** 密钥文件(`#1195` 换轴) | `server.ts:327`、`alpha-config-injection.ts:100` |
| 2026-08-03 就地修订:云 MCP 走标准 MCP OAuth,定义里「没有任何凭证通道 —— 没有 `headers.Authorization`、没有 `{file:…}` 引用」 | `ADR-009:22-29` | 代付态写 `headers:{Authorization:"Bearer {file:…}"}`、`oauth:false` | `cloud-sidecar-config.ts:42-48` |

这不是本文要修的东西(勘破不改文档),但**它是 AC3 的真实起点**:要改的不只是 B1/B2 的决策实质,
还有两条已经漂掉的事实描述。

---

## 9. 本轮**没有**测到的(不要当成已知)

1. **线上工具面的直接枚举** —— 缺有效 `mcp_access` 令牌;`/mcp` 未认证恒 401,§1.2 那条
   `scopes_supported` 只是必要非充分条件。
2. **线上代码与 `12cccbf` 是否同一份** —— `/health` 不带 version/sha,本轮没跑
   `wrangler deployments list`(会碰 owner 的生产凭证)。
3. **工具表变更能不能推给已连着的桌面**(§2.3)—— stateless + `maxSubscriptions:0` 下
   我没有测出一条 server→client 的 notification 通道。
4. **一次普通会话轮次到底走 `packages/opencode` 还是 `packages/core` 的 websearch/webfetch 副本**
   (§3.3 第 2 点)—— 只证明了两份都被**装载**,没有证明哪一份被**执行**;这与 `#1412` 文档的
   「更正 1」字面冲突,必须实测才能收口。
5. **无额度账户的端到端现场** —— 我没有一个零余额的真账户,§4.1 那条链是读代码 + 读契约得到的,
   不是跑出来的。402 的**实际 wire body**(`code` 字段到底出不出现)因此未验。
6. **`ALPHA_WEBSEARCH_DISABLE=1` 下六个工具真的全消失** —— §5 是读三处代码推出来的结论
   (`materializeCloudMcpConfig` / `WITHHELD_CLOUD_MCP` / `MCP.create`),没有跑一个装载实例复验。

---

## 附:本文用到的探针

| 探针 | 干什么 | 怎么证明它不瞎 |
| --- | --- | --- |
| `buildMcpServer` + `InMemoryTransport` + `listTools()`(在 `origin/main` 的 worktree 里跑) | 枚举云侧工具面 + annotations | 4 根不存在的针全 miss + 1 根存在的针 hit;并在**两棵不同的树**上各跑一次,工具集合一致 |
| `agents/mcp/server` 的 `createMcpHandler` + 一个按 header 分叉的 async 工厂 | 证明「按账户变工具集」在承载层可表达 | 同一 handler 两次请求拿到**不同**的工具集;`await` 真的被等到 |
| 独立源码普查(`packages/*/src`,2490 个文件) | 列出 websearch / webfetch 副本 | 与 `websearch-copies.test.ts`(12 pass)的断言集合一致 + 一根不存在的注册名负针 |
| `curl` 打线上 `/mcp` 与 PRM | 线上可达面 | 401 的 `www-authenticate` 与 200 的 PRM 互相印证 scope 集合 |
| `scripts/check-doc-links.py` | 本文的相对链接 | **先拿到已知的红**(初稿两条跨分支链接 → `✗ 2 broken (of 2 checked)`),改掉后 `✓ 54 resolve`;不是「0 条链接所以绿」 |
