---
title: Public Cloud MCP onboarding contract
kind: contract
status: active
owners:
  - alpha-platform maintainers
last_reviewed: 2026-10-15
review_after: 2026-12-17
---

# Public Cloud MCP onboarding contract

第三方客户端把 MCP 指向 alpha-cloud 时可以依赖什么:发现链、拿什么凭证、九个工具各要什么
授权、被拒时读到什么、以及**今天办不到的事**。

授权服务器那一半(客户端登记、授权/令牌端点、scope 发放与拒绝、`resource` 参数、AS 侧限流)
在 alpha-web,权威是
[public OAuth authorization-server contract](https://github.com/jinjunnn/alpha-web/blob/main/docs/contracts/public-oauth-as.md)。
**本文不复述那一半的任何数字** —— 第二份口径就是下一个洞。

## 1. 适用范围与基准

> **本文描述的是代码态;服务端已部署上线。**
> 本文每一个字面量都由 `packages/gateway/test/public-contract-doc-190.test.ts` 绑回代码,
> 因此它对 `main` 分支的代码永远为真。线上跑的是哪一版以部署注记为准(见下表「部署基准」),
> 两次部署之间线上可以落后于 `main`。
> 2026-09-17 实测线上:§2 两条 PRM 路径与 AS discovery 均返回 `200`,PRM 文档体与 §2 逐键一致;
> 未认证的 `POST /mcp` 返回 `401`,`resource_metadata` 指向 §2 按端点路径的那条 PRM。
> 服务端接入部分已随 [`jinjunnn/alpha-work#51`](https://github.com/jinjunnn/alpha-work/issues/51)
> 于 2026-09-17 按证据验收([验收评论](https://github.com/jinjunnn/alpha-work/issues/51#issuecomment-5708413307))。
> **本文已有对外发布位,因此它的每一个字面量都是对外承诺。** owner 2026-09-22 裁决对外发布,
> **推翻** 2026-08-25 的「暂不对外」([`ap#388`](https://github.com/jinjunnn/alpha-platform/issues/388));
> 裁决记录在 [REQ-164 方案基线](../design/2026-09-22-req164-mcp-api-key-third-party-baseline.md) §2.9。
> 发布位是 alpha-web 的 `/developers/mcp` 页([`jinjunnn/alpha-web#242`](https://github.com/jinjunnn/alpha-web/issues/242)),
> 随 alpha-web 部署生效;它复述本文的 §2 / §4.1 / §5 / §6 / §7.2 / §10.2,两侧字面量由那一仓的
> `tests/public-developers-mcp.test.mjs` 钉等。**本文仍是唯一权威**,那一页是它的对外渲染,不是第二份口径。
> ⇒ 读者不再只是 Alpha 自家客户端的实现者;改本文任一对外字面量,要连同接入页一起改。

| 项 | 内容 |
| --- | --- |
| 代码基准 | 本仓 `main`;判据 `packages/gateway/test/public-contract-doc-190.test.ts` 每次 `bin/check` 跑一遍 |
| AS 侧基准 | alpha-web `docs/contracts/public-oauth-as.md`(独立演进,本文只交叉链接) |
| 部署基准 | 已部署。2026-09-17 读回 `alpha-cloud` 当前部署注记 `git:a7df676`(2026-09-03 起 100%);之后以 `wrangler deployments list --name alpha-cloud` 的 `git:<sha>` 注记为准,部署流程见 [`runbooks/deploy.md`](../runbooks/deploy.md) |

内部拓扑、逐 hop 信任与目标架构在
[`architecture/cloud-mcp-resource-surface.md`](../architecture/cloud-mcp-resource-surface.md);
本文只写第三方看得见的那一面。

## 2. 发现链

canonical resource URI —— 也是 access token 的 audience —— 是
`https://alpha-cloud.tidelabs.click/mcp`。它是这个资源的**唯一**身份:任何别名(含 workers.dev
形态)签出来的令牌都会被拒。

alpha-cloud 服务 RFC 9728 Protected Resource Metadata,**两条路径,同一份文档**:

| 路径 |
| --- |
| `/.well-known/oauth-protected-resource` |
| `/.well-known/oauth-protected-resource/mcp` |

按端点路径的那条(第二条)也是 `WWW-Authenticate` 里 `resource_metadata=` 指向的值:
`https://alpha-cloud.tidelabs.click/.well-known/oauth-protected-resource/mcp`。

文档体逐键:

| 键 | 值 |
| --- | --- |
| `resource` | `https://alpha-cloud.tidelabs.click/mcp` |
| `authorization_servers` | `["https://auth.tidelabs.click"]` |
| `scopes_supported` | `["artifact.read","cloud.dispatch","cloud.read","model.invoke"]` |
| `resource_name` | `codepuppy` |

响应面:

| 项 | 值 | 为什么 |
| --- | --- | --- |
| 方法 | `GET, HEAD, OPTIONS` | 发现文档是只读面 |
| `Access-Control-Allow-Origin` | `*` | 公开发现文档,RFC 9728 客户端会从浏览器跨源取 |
| `Cache-Control` | `public, max-age=3600` | 可缓存;轮换 AS 时按这个窗口生效 |

两条路径**不受计费就绪状态影响**(服务退化时仍然 200 —— 连「我是谁、去哪拿令牌」都答不出来
比不挂更糟),但**受 IP 抗滥用限流约束**(见 §8):它们是无需凭证的公开端点。

授权服务器自己的 discovery(RFC 8414 metadata、authorization/token 端点、PKCE 与 `resource`
参数的行为)由 `authorization_servers[0]` 指向的那个 issuer 提供,权威是 alpha-web 的
[public OAuth AS contract](https://github.com/jinjunnn/alpha-web/blob/main/docs/contracts/public-oauth-as.md)。
本文只给指针。

## 3. 客户端登记

alpha-cloud 作为受保护资源**不参与客户端登记**。登记(客户端元数据文档形态、抓取时的
fail-closed 条件、redirect URI 要求)全部发生在 AS 侧,见
[public OAuth AS contract](https://github.com/jinjunnn/alpha-web/blob/main/docs/contracts/public-oauth-as.md)
的 "Client registration by metadata document"。

第三方要做的事,在本文这一侧只有两件:

1. 从 §2 的 PRM 拿到 `authorization_servers[0]`,按 AS 文档完成登记与授权;
2. 请求令牌时把 `resource` 绑到 §2 的 canonical resource URI —— 不绑或绑错,拿到的令牌在
   这里一律 401(§5)。

## 4. scope 词表,与两侧的有意不对称

**本资源兑现的 scope 只有四个**,它们是九个工具 `requiredAction` 的并集:

| scope |
| --- |
| `artifact.read` |
| `cloud.dispatch` |
| `cloud.read` |
| `model.invoke` |

**授权服务器的 scope 值域比这个大。** 平台令牌词表今天是九个:

| 词表成员 |
| --- |
| `account.keys.manage` |
| `account.read` |
| `artifact.read` |
| `artifact.upload` |
| `billing.reconcile` |
| `billing.settle` |
| `cloud.dispatch` |
| `cloud.read` |
| `model.invoke` |

**不对称是有意的,处理方式也要写清楚:** 本资源在把令牌变成执行主体**之前**,先把令牌的
`scope` 数组与上面那四个求交。多出来的 scope 被**静默丢弃**,不是整支拒绝 —— OAuth 语义里
资源服务器只兑现自己认得的 scope。交集为空的令牌能通过认证,但授权不了任何工具(§5 的 403)。

⇒ **不要用「AS 签了什么」推断「这里能做什么」。** 唯一权威是本节这四个,以及 §6 逐工具的
`requiredAction`。

**对第三方,不对称还有反方向的一半,而且那一半才是会踩到的:** 本资源 advertise 的四个
scope(PRM 的 `scopes_supported` 与 §5 challenge 的 `scope=`)里,**`model.invoke` 不签发给
第三方客户端** —— 授权服务器对第三方只签发其余三个(哪些签、签几个,数字归 AS contract,
本文只写这条不变量);`model.invoke` 只经平台自有凭证兑现(§4.1 里展开出它的 `models` API key
scope;`platform_access` 自 `ap#226` 起不再被 `/mcp` 受理,见 §10.1)。第三方按 challenge 里那串 scope 去请求时,
AS 在 `resource` 在场时把签不出的成员**丢弃**再签其余(RFC 6749 §3.3:授权响应可以窄于
请求),于是授权响应里会少这一个 scope。**这不是错误,也不影响任何工具**:引用
`model.invoke` 的工具只有 `web_search`、`web_fetch`、`vision` 与 `decide` 四个,而它们的
`requiredAction` 都是 any-of(§6),持有 `cloud.dispatch` 即可调用。⇒ 集成方不要把「授权响应的
scope 集 == challenge 的 scope 集」写成断言,也不要为拿不到 `model.invoke` 开工单。

### 4.1 API key 的 scope 是另一套词表

`sk-alpha-*` 是**专有扩展,不是标准 OAuth**(§10)。它有自己的 scope 名字,并在授权时展开成
上面的 action:

| API key scope | 展开为 |
| --- | --- |
| `models` | `model.invoke` |
| `cloud` | `cloud.dispatch` `cloud.read` `artifact.read` |
| `account.read` | `account.read` |

**`cloud` 的三个 action 不可分割** —— 不存在「只给派活、不给读产物」的组合,也不能直接把
`cloud.read` 当成一个 API key scope 授予(那不是这套词表的成员,授不出任何东西)。
需要更细的粒度就走 OAuth 那条路:`mcp_access` 的授权向量是 scope 数组,可以只带一个。

## 5. 认证与错误形态

`/mcp` 的认证发生在 **transport 层**,排在工具发现之前:未认证的调用方连 `initialize` /
`tools/list` 都拿不到。三档:

| 档 | 何时 | 状态码 |
| --- | --- | --- |
| 认证失败 | 无 `Authorization`、令牌验不过、audience/issuer 不匹配、已过期 | `401` |
| 授权失败 | 令牌有效,但缺这个工具要的 action | `403` |
| 工具内失败 | 授权通过之后的业务错误(参数、越权、上游、限流) | `200` + `isError: true` |

前两档的 `WWW-Authenticate` 逐参数(`403` 一栏以 `dispatch` 为例 —— `scope=` 的值是**那个
工具**的 `requiredAction`,不是全量 scope 集):

| 参数 | 401 | 403 |
| --- | --- | --- |
| `error` | `invalid_token` | `insufficient_scope` |
| `error_description` | `Missing or invalid access token for the codepuppy MCP resource` | `The presented credential is not authorized for this tool` |
| `scope` | `artifact.read cloud.dispatch cloud.read model.invoke` | `cloud.dispatch` |
| `resource_metadata` | `https://alpha-cloud.tidelabs.click/.well-known/oauth-protected-resource/mcp` | `https://alpha-cloud.tidelabs.click/.well-known/oauth-protected-resource/mcp` |

认证方案是 `Bearer`,上表四个参数是 challenge 的**全部**参数。响应体同形:

```json
{ "error": "invalid_token", "error_description": "Missing or invalid access token for the codepuppy MCP resource" }
```

**`scope=` 是重申请指引,按 any-of 读。** 一个工具的 `requiredAction` 有多个成员时,challenge
会把它们全部列出,持有**任一**成员即可放行(§6)。

**JSON-RPC batch 不受支持。** 一次 POST 携带数组会被拒:

```json
{ "error": "JSON-RPC batch requests are not supported on this endpoint", "code": "batch_not_supported" }
```

状态码 `400`。理由是结构性的:一个 batch 可以含多个 `requiredAction` 不同的工具,而 HTTP 只有
一个状态码,「per-tool 403 落在 HTTP 层」对 batch 不成立。**认证仍排在拒绝 batch 之前** ——
无凭证的 batch 先吃 401。

**传输层拒绝是 JSON-RPC error 形状。** 请求体在进入协议层之前有一道有界读:超过 262144 字节的
body 一个都不解析就拒(该拒绝排在认证之前,不为越界请求做任何验证功),不是合法 JSON 的 body
同样在这里拒。两者的响应体都是 JSON-RPC error 对象,`id` 恒 `null`(body 未解析,请求 id 结构上
不可知)。请求体越界 ⇒ `413`:

```json
{ "jsonrpc": "2.0", "error": { "code": -32000, "message": "Payload too large: request body exceeds 262144 bytes" }, "id": null }
```

请求体不是合法 JSON ⇒ `400`,与 MCP server SDK 对同一条件的答复逐字节相同:

```json
{ "jsonrpc": "2.0", "error": { "code": -32700, "message": "Parse error: the request body is not valid JSON" }, "id": null }
```

### 5.1 `sk-alpha-*` 被拒时,`error_description` 说得出是哪一种

上表那句泛化描述回答不了「我该做什么」:填错了要重填,作废了要重新签发,过期了要续期。所以
**API key 类的拒绝**在那句描述末尾追加一个机读原因 `; reason=<值>`。原因是**封闭枚举**,取值只有
下面三个,由签发方(account)判定后一路原样传到这里 —— 中途不改写,也不含 key 片段、租户标识
或时间戳。

| 原因 | 何时 | 401 的 error_description |
| --- | --- | --- |
| `key_unknown` | 平台不认识这串 key:从未签发过,或已经不在了 | `Missing or invalid access token for the codepuppy MCP resource; reason=key_unknown` |
| `key_revoked` | 这把 key 在密钥页被作废过 —— 去重新签发一把 | `Missing or invalid access token for the codepuppy MCP resource; reason=key_revoked` |
| `key_expired` | 这把 key 过了它的 `expires_at` —— 去续期 | `Missing or invalid access token for the codepuppy MCP resource; reason=key_expired` |

状态码与 `error` / `scope` / `resource_metadata` 三个参数与 §5 那张表逐字相同:客户端该走的重授权
闭环一步不变,`reason` 只是给人看的那一句多了一格精度。响应体同形(`error_description` 同样带
`reason=`)。

这三个值只有**持有那串 key 的人**看得到(key 是 256 bit 随机,猜不出),所以它不是可枚举的 oracle。

**其余任何拒绝都不带 `reason=`,逐字节就是 §5 那句泛化描述。** 包括:无 `Authorization`、不是
`Bearer`、JWT 验不过 / issuer 或 audience 不匹配 / 已过期、拿通用平台凭证打 `/mcp`,以及
**account 不可达**时 —— 那一刻平台自己也不知道这串 key 是好是坏,不编一个原因出来。

## 6. 工具面

十个工具。这张表是**能力矩阵的对外副本**,与服务端注册表逐字段一致;`tools/list` 返回的名字
集合与本表的行集合相等。
工具名只说动作,不带服务前缀;`initialize` 回的 `serverInfo.name` 是 `codepuppy`。

| 工具 | 需要的 action(any-of) | 入口计费 | 形态 | 消费租户桶 | `readOnlyHint` | `destructiveHint` | `openWorldHint` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `dispatch` | `cloud.dispatch` | `none` | `async-job` | 是 | 否 | 否 | 是 |
| `status` | `cloud.read` | `none` | `sync-fixed` | 否 | 是 | 否 | 否 |
| `await` | `cloud.read` | `none` | `sync-fixed` | 否 | 是 | 否 | 否 |
| `artifacts` | `artifact.read` | `none` | `sync-fixed` | 否 | 是 | 否 | 否 |
| `cancel` | `cloud.dispatch` | `none` | `sync-fixed` | 否 | 否 | 否 | 否 |
| `web_search` | `cloud.dispatch` `model.invoke` | `forwarded:/v1/tools/web_search` | `sync-fixed` | 是 | 否 | 否 | 是 |
| `web_fetch` | `cloud.dispatch` `model.invoke` | `forwarded:/v1/tools/web_fetch` | `sync-fixed` | 是 | 否 | 否 | 是 |
| `vision` | `cloud.dispatch` `model.invoke` | `forwarded:/v1/tools/vision` | `sync-fixed` | 是 | 否 | 否 | 是 |
| `decide` | `cloud.dispatch` `model.invoke` | `forwarded:/v1/tools/decide` | `sync-fixed` | 是 | 否 | 否 | 是 |
| `account_status` | `cloud.read` | `none` | `sync-fixed` | 否 | 是 | 否 | 否 |

- **any-of**:`web_search` / `web_fetch` / `vision` / `decide` 只要持有两者之一即可 —— 只带 `model.invoke` 的直用客户端也调得通。
- **入口计费**:`none` 指本次 `tools/call` 在入口不直接产生费用,**不等于这个工具免费** ——
  `dispatch` 派出去的异步作业按 job token 逐 token 计量,那不归本列管辖(§7)。
- **消费租户桶**:读面四个工具(含 `account_status`)与 `cancel`(止损动作)不消费,
  所以轮询/查询/取消不会把自己 429 掉(§8)。
- **后三列 = `tools/list` 广播的 `ToolAnnotations`**([`ap#461`](https://github.com/jinjunnn/alpha-platform/issues/461))。
  它们是给 host 的**提示**,不是安全边界 —— MCP 规范自己写着客户端不得据未受信服务端的
  annotations 做调用决策;我们给出它们,是为了让 Claude Code / Cursor 这类客户端的确认策略
  有依据。三格的落值由服务端注册表派生,不是手写:只读 = 同步定形 + 入口零成本 + 受理的
  action 全是读动作(所以 `cancel` **不是**只读 —— 它受理 `cloud.dispatch`,取消是写动作);
  开放世界 = 派异步作业(会联网)或入口直接花第三方的钱;十个工具都不做不可逆删除
  (取消保留结果与产物),所以 `destructiveHint` 全为否。我们**不声明** `idempotentHint`:
  `dispatch` 的幂等来自调用方给的 `idempotency_key`,不是工具的固有属性。
- **`dispatch` 的 `kind`、每种 `kind` 接受的 `input` 字段、以及 `capabilities` 词表,
  都在它的 `description` 里广播**,由服务端的 pipeline 注册表与 tier 路由表派生
  ([`ap#461`](https://github.com/jinjunnn/alpha-platform/issues/461) 起是 kind 与 capability,
  [`ap#469`](https://github.com/jinjunnn/alpha-platform/issues/469) 起连输入字段一起):
  新增一种云端能力时广播自动跟上。[`ap#558`](https://github.com/jinjunnn/alpha-platform/issues/558) 起,
  `inputSchema` 里的 `kind` 是 **enum**,值域取自 pipeline 注册表的全部键(含已停用 kind),
  **新增 kind 在客户端重新获取工具列表后可用**。说明按 kind 分组:kind 名带引号单独成行,其输入字段一律以
  `input.` 前缀逐行写出。
  **本文不复述那份清单**(那会立刻长出第二个会漂移的权威):要看当前值域就读一次 `tools/list`。
  值域外的 `kind` 在 schema 校验阶段就以 `isError` 退回,错误文本列出全部合法 kind,不到 handler、不建作业。
  已停用的 `kind`(云端 Word / Excel / PowerPoint 的 `office-report`、云端网页的 `html-generate`,
  [`ap#552`](https://github.com/jinjunnn/alpha-platform/issues/552))在说明里单列为「拒收」(`refused kinds`),
  不再导出;经 MCP 调用仍会通过 schema 校验到达准入,在预授权之前被拒,
  载荷带 `code: "pipeline_kind_retired"`,说明「已停用,请使用本机生成」,不建作业、不扣费。
- **`code-review` 的联网查证**:先简述意图(`summarize-change`),再用 CHEAP 规划至多三条依赖库行为或
  CVE 搜索词(`plan-lookups`);每条经 gateway 中央搜索执行(`lookup-0`…`lookup-2`),空数组不搜索。
  规划格式错误明确终止且不重试,不当作无需查证。SMART 审查步(`find-issues`)使用这些资料,
  `web=false`、`max_tokens=8000`,不带推理控制字段;结果仍为 `{kind, intent, findings, citations}`,
  `citations` 来自搜索结果。规划、搜索和审查沿用各自现有计费与 402 语义。
- **广播出来的输入字段是「真的会被读到的字段」,不是一份说明文档。** 执行体能读哪些键由同一张
  注册表锁住,**两道闸**:编译期是 `lib/pipeline-registry.ts` 的 `PipelineInputFor<K>`(读一个
  未声明的键 `tsc` 当场报错),运行期是 `projectPipelineInput` —— 派发执行前 input 被投影成
  「只含声明键 + 内部保留键」的新对象,所以绕过类型(`as any`)也读不到:那个键**不在对象上**。
  广播的字段与真实行为因此结构上不会分叉。
  **反过来不成立**:没列出来的字段**不会报错,而是被静默忽略** —— 派发入口不拒没列出来的键
  (`ap#469` 的显式裁决:`dispatch` 的调用方是模型,对编造出来的字段 fail-closed 拒会把
  合理请求打挂)。所以「传了个没列出来的字段但任务成功了」不代表它生效了。
- **列出来、且声明了约束的字段,派发前就判**([`ap#532`](https://github.com/jinjunnn/alpha-platform/issues/532),
  REQ-235)。注册表里每个字段带 `type`(`string` / `json`);今天只有 `image-generation`
  (以及已停用的 `html-generate`)的 `prompt` 另外声明了必填与长度(trim 后 1–4000 个 UTF-16 code unit),
  违反即在任何副作用之前拒,载荷 `{ error, code: "pipeline_input_invalid", details: [{ field, reason }] }`
  (`reason` ∈ `required` / `type` / `minChars` / `maxChars` / `enum`)。其余 kind **约束未声明**,
  沿用各自既有的准入。这道校验只判不改:服务端不替你补缺省值、不 trim,幂等摘要算在你发来的原始请求上。
  同一份字段合同导出为
  [`contracts/v1/cloud-pipeline-registry.json`](../../contracts/v1/cloud-pipeline-registry.json),
  字段与形状见 [`cloud-jobs-v1.md`](cloud-jobs-v1.md)「Pipeline input constraints」。
- **`cancel` 的应答语义**:返回 `{schema_version, job_id, status, accepted}`。
  `accepted:true` ⇔ 行进入(或已处于)`cancelling`/`cancelled`;已终态的作业回 `accepted:false`
  加**真实终态**(结果与产物保留)。取消受理后状态先是 `cancelling`,直到停止协议取得
  「执行确实停了」的正向证据才落 `cancelled` —— 中间用 `status` 轮询看到的就是 `cancelling`。

入参形状(每个工具都是单一扁平对象;[`ap#415`](https://github.com/jinjunnn/alpha-platform/issues/415)
起 `dispatch` 广播的不再是根级 `oneOf` —— 已发布桌面客户端会把根级 `oneOf` 覆写成
自相矛盾的 schema。广播里分支特有字段(`kind`/`input`/`objective`/`capabilities`)标为可选,
**哪个必填由 `autonomy` 决定**:`pipeline` 要求 `kind` + `input`,`bounded-agent` 要求
`objective` + `capabilities`;混装或缺失在提交时被严格 `CloudJobRequestV1` union 拒,
`isError` 载荷带稳定 `code: "envelope_invalid"`):

| 工具 | 分支 | 必填 | 可选 |
| --- | --- | --- | --- |
| `dispatch` | — | `autonomy` `idempotency_key` `schema_version` | `artifact_policy` `budget` `capabilities` `constraints` `input` `kind` `objective` `output_schema` |
| `status` | — | `job_id` | — |
| `await` | — | `job_id` | `timeout_sec` |
| `artifacts` | — | `job_id` | — |
| `cancel` | — | `job_id` | — |
| `web_search` | — | `query` | `max_results` |
| `web_fetch` | — | `url` | — |
| `vision` | — | `image` `mime` | `fallback_on_refusal` `model` `question` |
| `decide` | — | `questions` `state` | `model` |
| `account_status` | — | — | `format` `task` |

完整的 JSON Schema(含类型、区间、枚举)由 `tools/list` 给出,那是权威;本表只钉住字段集合。

`web_search` 成功载荷([`ap#378`](https://github.com/jinjunnn/alpha-platform/issues/378)):
`{ query, provider, results: [{ title, url, snippet? }, …], answer? }`。`results` **必须是数组**,
不是带 provider 前缀的字符串;失败支走 §7 的稳定 `error.code`,结构上不带 `results` 槽。

`web_fetch` 成功载荷([`ap#486`](https://github.com/jinjunnn/alpha-platform/issues/486)):
`{ url, status, content_type, content }`。三件必须说清楚的事:

- **`status` 是目标站自己的 HTTP 状态**,不是我们的。`404` / `403` 是**答案**(页面不存在 /
  站点拒绝),这一跳照常计费 —— 我们完成了一次出站抓取。真正的失败(DNS/TLS/连接失败、超时、
  重定向链不合法、响应体超上限)走 `error.code`,**不计费**,`code` 取值见 §7.3 下方那一段。
- **`url` 是逐跳校验后最终生效的地址**,有重定向时与你传进来的不同。重定向**每一跳**都重新过
  一次主机闸,链上任何一跳落到私有/内部/平台自有主机即整体拒绝。
- **`content` 是剥掉标签、压缩空白并截断的正文**(4000 字符),不是原始 HTML;响应体超过
  2 MiB 时整体拒绝(`response_too_large`),不给截断结果。

**抓取的源 IP 是我们的基础设施** —— 对被抓网站而言,来源是平台而不是你。这是 owner
2026-09-24 具名接受的形态,不是疏忽。

`idempotency_key` 是**信封字段**,不是 HTTP 头 —— MCP 面结构上没有头部载体,所以两面共用
同一个信封定义。取值必须整串匹配 `^[A-Za-z0-9._-]{8,128}$`;不匹配或缺席的派发在任何副作用
之前就被拒。作用域由服务端派生(租户 + 调用方来源),客户端**不需要也不能**把租户拼进键里。

### 6.1 产物字节与摘要

`artifacts` 返回**描述符**,**永不内联字节**:稳定 id、mime、size、sha256、provenance、
`contentRef`。字节取回是对 `contentRef.url` 做一次认证 HTTP 下载。

**内容端点只发与记录 digest 绑定的字节**([`ap#246`](https://github.com/jinjunnn/alpha-platform/issues/246))。
产物写入对象存储时,sha256 随字节交给存储端重算比对,不符 ⇒ 写入被拒;发放时,服务端在发出**任何**
内容字节(含 Range 部分响应与 `If-None-Match` 304)之前,把描述符里的 sha256 与**当前存储对象的
受验 checksum** 比对(内联小产物则对将发字节重算)。不符 ⇒ `409 artifact_digest_mismatch`;当前对象
没有受验 checksum 可比(如一次未带校验和的改写)⇒ `409 artifact_digest_unbound`。两种情况一个内容
字节都不发。判据:[`packages/gateway/test/artifact-byte-verification-246.test.ts`](../../packages/gateway/test/artifact-byte-verification-246.test.ts)
(真存储上翻转一个字节 ⇒ 拒发;摘掉比对 ⇒ 判据红)。

描述符没有 sha256 的产物按 unverified 发放(无 ETag/Digest、无 304、无绑定闸)。消费方仍可自行
复核字节 —— 但「verified 徽标 + 与 digest 不符的字节」这对组合从服务端就发不出来。

`contentRef.url` 是 **server-relative 路径**,对 §2 的 canonical cloud origin 解析。那条内容端点
接受 `mcp_access`(令牌 scope 里必须有 `artifact.read`);**cloud jobs 面的其余端点不接受它** ——
派发、状态、事件流、描述符列表都走 §6 的工具,不要拿这支令牌直打那些 HTTP 端点(一律 401)。
判据:[`packages/gateway/test/authz-cloud-jobs-mcp-229.test.ts`](../../packages/gateway/test/authz-cloud-jobs-mcp-229.test.ts)
(正向端到端 + 路由表派生的负向枚举 + 可达矩阵上界)。

这些 401(内容端点与 jobs 读面的四条 `GET`)带与 §5 表 401 列**同一份** `WWW-Authenticate`
challenge —— 四参数逐字节相同,`resource_metadata` 指向同一份 PRM
([`ap#387`](https://github.com/jinjunnn/alpha-platform/issues/387)):标准客户端的
`401 → 读 resource_metadata → 重授权 → 重试` 闭环在取字节这一跳不再断。响应**体**形状不变,
仍是 `{"error":"unauthorized"}`、无 `code` —— 桌面对「平台不给这些拒绝补 code」有显式在案的
依赖([`ap#330`](https://github.com/jinjunnn/alpha-platform/issues/330))。写面(派发/取消)的
401 不带 challenge。判据:
[`packages/gateway/test/artifact-content-challenge-387.test.ts`](../../packages/gateway/test/artifact-content-challenge-387.test.ts)
(生产装配层驱动;期望值为手抄字面量;与 `/mcp` 活体逐字节对齐;读面清单从路由表派生)。

### 6.2 `vision`:云端识图([`ap#484`](https://github.com/jinjunnn/alpha-platform/issues/484),REQ-228)

把一张图交给云端,拿回「这张图在表达什么」的文字。**它是 gateway `POST /v1/tools/vision` 的薄转发**
(能力只在那条路由上;MCP tool 不写业务逻辑、不单独计费),所以这里写的每一条对直打那条 HTTP 路由
的调用方同样成立。

可选的模型是一张**封闭的模型表**(服务端 `lib/vision-models.ts`,唯一权威;owner 2026-09-24:「合理的使用
动态模型或者数据模型,以便这个接口可扩展」):每行一个对外 `model` 取值,行里钉着上游模型、输出上限、
推理开关、安全设置、按次单价与失败时换到哪一行。`model` 的取值域、默认值、单价与换档链都从这张表派生,
`tools/list` 广播的 `inputSchema.properties.model.enum` 与工具说明里的行清单就是它的对外投影。**今天两行:**

| `model` | 上游 | 每次单价 | 失败时换到 |
| --- | --- | --- | --- |
| `qwen`(默认) | `qwen/qwen3.7-flash` | $0.002 | `gemini` |
| `gemini` | `google/gemini-3.5-flash-lite`(带我们钉死的 `safety_settings`) | $0.01 | —(失败即终) |

入参:

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `image` | base64 字符串(标准字母表,**不带** `data:` 前缀) | 解码后 ≤ 262144 字节 |
| `mime` | `image/png` `image/jpeg` `image/webp` `image/gif` | 封闭枚举;必须与图片字节的**魔数**一致 |
| `question` | ≤2000 字,可选 | 不填 ⇒ 服务端固定模板:先说图想表达什么,再给支撑细节,最后附关键文字原文 |
| `model` | 模型表的 key(今天 `qwen` `gemini`),默认 `qwen` | 封闭集合 —— 是我们自己的稳定名字,**不是**上游模型 id;任意上游 id 一律 `unsupported_model`;上游 id / 输出上限 / 安全设置全由表行决定,调用方传不进来 |
| `fallback_on_refusal` | 布尔,默认 `true` | 见下 |

成功载荷:`{ text, model, fallback_used, usage? }`。`text` 纯文本;`model` 如实写**实际作答**的表行;
`fallback_used` = 实际作答的行 ≠ 请求的行;`usage`(`{ prompt_tokens, completion_tokens }`)是上游报回的
token 计数,缺席合法 —— 计费按次,它只是观测。

**换档规则(沿表行的「失败时换到」走,同一次调用内每行至多试一次):**

- 请求的行上游**故障**(超时 / 5xx / 429 / 空内容或结构错)⇒ 换到它的下一行再看一次,**仍按请求行的单价计费**(§7.1);
- 请求的行**审核拒绝**图片(qwen 实测:上游返回 `data_inspection_failed`)⇒ `fallback_on_refusal` 为 `true` 时同上换行;
  为 `false` 时**不换**,直接失败 `content_refused`;
- 没有下一行的行(今天 `gemini`)失败即终;
- 服务端不做「觉得答得不好再换」的按质量切换。

**失败载荷** = `{ error: { message, code, retryable?, model?, upstream_status? } }`,`isError: true`。
`code` 是**穷举表**(服务端 `VISION_ERROR_CODES`,每个 code 钉一个 HTTP 状态;`model` 是决定这个结局的表行):

| `code` | HTTP | 何时 | 计费 |
| --- | --- | --- | --- |
| `request_invalid` | 400 | 形状不合法(`mime` 不在枚举内、未知顶层键、缺必填、`question` 超长) | 在扣费之前拒,零预留 |
| `unsupported_model` | 400 | `model` 不是模型表里的 key(载荷带 `supported` 列出当前 key) | 同上 |
| `image_invalid` | 400 | 不是合法 base64,或字节头不是四种受理类型之一(伪造魔数) | 同上 |
| `image_mime_mismatch` | 400 | `mime` 与魔数不一致 | 同上 |
| `image_too_large` | 413 | 解码后超过 262144 字节 | 同上 |
| `payload_too_large` | 413 | 请求体超过 393216 字节(直打 HTTP 时;经 `/mcp` 先撞 §5 的 262144) | 同上 |
| `no_vision_backend` | 502 | 服务端未配上游 key | 同上 |
| `content_refused` | 422 | 请求的行审核拒绝且不换行 | 预留作废,**不扣费** |
| `content_blocked` | 422 | 模型因安全设置拦截 | 同上 |
| `provider_rate_limited` | 429 | 上游 429(链上每一行都失败时报最后一行的) | 同上 |
| `provider_timeout` | 504 | 上游超时 | 同上 |
| `provider_unavailable` `provider_rejected` `provider_bad_response` | 502 | 上游 5xx / 传输失败;其余 4xx;2xx 但无内容或结构错 | 同上 |

只有成功才结算,恒一个单位。

**数据去向(必须告知用户):** 图片经我们的 gateway 发往 OpenRouter,再由 OpenRouter 交给该行的模型
提供方 —— `qwen` 是 **Alibaba**,`gemini` 是 **Google**。平台**不存储**图片;日志只记图片的哈希与字节数。
`gemini` 行带我们钉死的一组安全设置(色情 / 仇恨 / 骚扰不拦,危险内容与公民程序类内容中等以上拦);
Google 另有一层不可配置的底线过滤,任何设置下都生效。

### 6.3 `decide`:云端批量判断([`ap#482`](https://github.com/jinjunnn/alpha-platform/issues/482),REQ-227)

把一段文本和若干题(是/否、单选、打分)交给云端,一次拿回全部答案 —— 每个答案是**概率与置信度**,不是文字。
**它是 gateway `POST /v1/tools/decide` 的薄转发**(能力只在那条路由上;MCP tool 不写业务逻辑、不单独计费),
所以这里写的每一条对直打那条 HTTP 路由的调用方同样成立。

可选的模型是一张**封闭的模型表**(服务端 `lib/decide-models.ts`,唯一权威;owner 2026-09-24:「合理的使用动态模型或者
数据模型,以便这个接口可扩展」):每行一个对外 `model` 取值,行里钉着上游模型、按次单价、输入字节上限与题数上限。
`model` 的取值域、默认值、单价与上限都从这张表派生,`tools/list` 广播的 `inputSchema.properties.model.enum` 与工具说明里的
行清单就是它的对外投影。**今天一行:**

| `model` | 上游 | 每次单价 | 输入上限(`state` + 全部题目,UTF-8 字节) | 题数上限 |
| --- | --- | --- | --- | --- |
| `jev`(默认) | Cloudflare Workers AI 上的 `typesafe/jev`(TypeSafe Jev 1.13) | $0.001 | 49152 | 64 |

入参(形状沿用 Jev 原生的 `{state, questions}`;字段文法见 TypeSafe 的 [API reference](https://docs.typesafe.ai/api)):

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `state` | 字符串,或装着文本的 JSON 对象 / 数组 | 被判断的内容。**只收文本**:任何字符串里出现 `data:` URI、或 ≥512 个连续的编码字符,整个请求 `non_text_input` |
| `questions` | `{ <id>: 题, … }`,1 到 64 题 | id 由调用方自选,答案按同一 id 回来。题的 `type` 是 `noul`(是/否;`criteria` 可选 `{true?, false?}`)、`choice`(单选;`criteria` 是 `选项 → 说明 \| null` 的 map,1–255 项)或 `score`(打分;`criteria` 是有序档位数组,2–10 档)。`instructions` 与各 `criteria` 值都可以是字符串或 JSON 结构 |
| `model` | 模型表的 key(今天 `jev`),默认 `jev` | 封闭集合 —— 是我们自己的稳定名字,**不是**上游模型 id;任意上游 id 一律 `unsupported_model` |

成功载荷:`{ model, answers, usage? }`。`model` 是作答的表行;`answers` 与 `questions` 同键,每个答案按题型:
`noul` → `{ type, noul }`(`noul` 是「是」的概率,0–1);`choice` → `{ type, choice, probabilities, confidence }`
(`choice` 是概率最高的选项,`probabilities` 是每个选项的概率,和为 1);`score` → `{ type, score, legend, probabilities, confidence }`
(`score` 是按概率加权的档位,可落在两档之间;`legend` 把档位序号映回描述)。`usage`(`{ input_tokens, output_tokens }`)
是上游报回的 token 计数,缺席合法 —— 计费按次,它只是观测。**答案是概率,不是事实**:`state` 里夹带的指令最坏只会让判断
偏掉,不会让任何东西被执行;要不要据此行动、置信度多低就交给人,由调用方的代码决定。

**失败载荷** = `{ error: { message, code, retryable?, model?, upstream_status? } }`,`isError: true`。
`code` 是**穷举表**(服务端 `DECIDE_ERROR_CODES`,每个 code 钉一个 HTTP 状态):

| `code` | HTTP | 何时 | 计费 |
| --- | --- | --- | --- |
| `request_invalid` | 400 | 形状不合法(题型不在三种之内、`choice` 选项或 `score` 档位数越界、题数超过 64、未知顶层键、结构嵌套超过 16 层) | 在扣费之前拒,零预留 |
| `unsupported_model` | 400 | `model` 不是模型表里的 key(载荷带 `supported` 列出当前 key) | 同上 |
| `non_text_input` | 400 | `state` / `instructions` / `criteria` 里出现 `data:` URI 或 ≥512 个连续编码字符(图片或二进制冒充文本) | 同上 |
| `input_too_large` | 413 | `state` + 全部题目的 UTF-8 字节数超过该行上限(49152);上游按 token 判超限(`max_tokens_exceeded`)时同样映到此 | 同上(上游超限那一支预留作废,**不扣费**) |
| `payload_too_large` | 413 | 请求体超过 131072 字节(直打 HTTP 时;经 `/mcp` 先撞 §5 的 262144) | 同上 |
| `no_decide_backend` | 502 | 服务端未绑 Workers AI | 同上 |
| `provider_rate_limited` | 429 | 上游 429 | 预留作废,**不扣费** |
| `provider_timeout` | 504 | 上游超时(30 s) | 同上 |
| `provider_unavailable` `provider_rejected` `provider_bad_response` | 502 | 上游 5xx / 传输失败 / 渠道计费状态;其余 4xx;2xx 但答案与题目对不上 | 同上 |

只有成功才结算,恒一个单位。**不暴露上游计费状态**:渠道侧的计费状态(Cloudflare AI Gateway 的余额)既不出现在
错误文案里,也不以 `upstream_status` 出面 —— 那种失败回 `provider_unavailable` 且**没有** `upstream_status` 字段;其它
上游 HTTP 失败(4xx / 429 / 5xx)照常带 `upstream_status`。

**数据去向(必须告知用户):** 文本经我们的 gateway 交给 Cloudflare Workers AI,再由 Cloudflare 交给模型提供方
**TypeSafe**。平台**不存储**文本;日志只记输入的哈希、字节数与题数。TypeSafe 的零数据留存只对其企业客户开放,
我们今天不是 —— 不要把不能离开你环境的内容送进来。

### 6.4 `account_status`:免费的账户查询(REQ-232)

**免费、只读、同步**:不计费、不消费租户桶,轮询也不会被 429。数字全部来自 account 的只读检查
(不写账本、不占预留),cloud 只做拼装,不重算额度或分腿。成功载荷:

```
{ schema_version: 1,
  account: { suspended, plan: { status, tier, window5h?, window7d? }, wallet: { balance_fen, available_fen },
             wallet_overflow, admission: { ok, code?, reason? } },
  task?:   { task, estimate, reserve?, admission } }
```

- `account`:会员额度两个窗口(`remaining_credits` / `limit_credits` / `resets_in_min`)、钱包余额与
  **可用**余额(已扣除在途预留)、「额度用完后用余额付」开关(`wallet_overflow`),以及与动作无关的
  账户级准入(停用 / 欠费冻结 / 额度耗尽且未开溢出)。
- 传 `task`(取值见 `tools/list` 的说明:pipeline 的 kind,或 `bounded-agent:openai_agents` /
  `bounded-agent:claude_code`)才有 `task` 段,且**只看这个任务的第一个计费步**,不承诺整个任务付得起:
  - `reserve`:第一步会占的预留额(`hold_fen`)及其在额度 / 钱包两腿上的分配;
  - `admission`:第一步此刻能不能被受理 —— 拒绝时的 `code` 与 `dispatch` 派发时回的是同一个(§7.4);
  - `estimate`:第一步的计费动作是按次定价(`fixed-unit`)时 `{available:true, amount_fen}`,否则
    `{available:false, reason}` —— 今天所有任务的第一步都按实际用量结算,所以恒为「无法估算」,预留额是冻结额不是报价。
  - `bounded-agent:claude_code` 没有 `reserve`:它的第一次模型调用的大小由沙箱里的 Claude Code 决定,派发层
    不知道,所以只报账户级准入。
- `format`(`docx` | `xlsx` | `pptx`)只影响 `office-report`。未知 `task` ⇒ `isError` + `code: "unknown_pipeline_kind"`;
  account 不可达或未配置 ⇒ `isError` + `code: "account_unavailable"`。

### 7.1 哪些调用在入口产生直接费用

gateway 上有一张封闭的付费路由表;**未登记的收费入口结构上不能运行**。它今天八条路径、七个
计费动作:

| gateway 路由 | `action_id` |
| --- | --- |
| `/v1/chat/completions` | `model.invoke.chat` |
| `/v1/messages` | `model.invoke.messages` |
| `/v1/tools/web_search` | `tool.web_search` |
| `/v1/web/search` | `tool.web_search` |
| `/v1/tools/web_fetch` | `tool.web_fetch` |
| `/v1/tools/vision` | `tool.vision` |
| `/v1/tools/decide` | `tool.decide` |
| `/v1/tools/document_generate` | `tool.document_generate` |
| `/v1/tools/image_generate` | `tool.image_generate` |

MCP 面**只有 `web_search`、`web_fetch`、`vision` 与 `decide`** 各打到其中一条,这也是只有它们
`costSource` 不为零的原因。其余六个工具在入口不 reserve、不 settle。

两个 host tool **同价、同额度池**:每次调用一个固定单价,先走会员额度、额度不足才落钱包
(§7.2)。它们今天在账单明细里合记在同一个按次计数上,分不开「搜了几次 / 抓了几页」——
如实登记,分开是另一票的事。

`tool.vision` 按次固定单价,**按调用方选的 `model` 所在的表行取价**(§6.2 的模型表:`qwen` 每次 $0.002,
`gemini` 每次 $0.01)。沿表行换到别的行作答的那一次仍按请求行结算(差价由平台承担)。只有成功才结算;
§6.2 里每一种失败都不扣费。

`tool.decide` 同形:按次固定单价,按 `model` 所在的表行取价(§6.3 的模型表:`jev` 每次 $0.001),与其它云工具
同一额度池。只有成功才结算;§6.3 里每一种失败都不扣费 —— 包括非文本与超限输入(它们在预留之前就被拒)。

### 7.2 额度耗尽会发生什么(ADR-034)

对外行为四条,都是**已裁决的终态**,不是临时状态:

1. 云工具消耗**订阅额度**,不另扣现金;
2. 订阅额度耗尽 ⇒ **默认硬拒,钱包不动**。只有租户**显式打开钱包溢出开关**之后才回落到钱包;
3. 拒绝载荷带**稳定 `code`**(下表),取自单一权威;
4. **tool 与 model 共享同一份额度** —— 折算不看 `action_id`。⇒ 一个长跑作业可以吃光额度,
   使同一租户的交互请求被拒。**这是已接受的形态。**

第 2 条有一句必须说出口的推论:**额度耗尽时充值不会恢复服务**(默认硬拒,钱包不参与)。
要恢复,等额度窗口重置,或在账户页打开钱包溢出开关。

依据 [ADR-034](../../.claude/rules/adrs/ADR-034-allowance-exhaustion-hard-reject.md)。

### 7.3 稳定 `code` 的值域

这是「可诊断的能力拒绝族」的**全集**:job 约束与 account 准入。传输层与鉴权层的 code
(`invalid_token` / `insufficient_scope` / `batch_not_supported` / `rate_limited` / …)**不属于
这个族**,各自就近定义 —— 不要把两者当成一张表。

| `code` | 今天有 producer | 何时出现 |
| --- | --- | --- |
| `account_admission_rate_exceeded` | 是 | 租户容量桶打满(§8) |
| `account_allowance_exhausted` | 是 | 订阅额度耗尽且未开钱包溢出(§7.2) |
| `account_suspended` | 是 | 租户被停用(§10.2) |
| `account_wallet_insufficient` | 是 | 钱包余额为负(欠费,付费动作已冻结),或钱包可用余额(已扣除在途预留)不够本次调用需由钱包承担的部分 |
| `job_max_iter_exceeded` | 否 | 已登记,尚无接线 |
| `job_max_tokens_exceeded` | 否 | 已登记,尚无接线 |
| `document_request_invalid` | 是 | 托管文档输入或 job 预算拒绝 |
| `document_data_invalid` | 是 | `office-report` 的 `xlsx` 没给 `data` 时,先由一次模型调用从 `topic` 整理出的表格数据不合模板输入结构(在开生成环境之前失败) |
| `document_backend_unavailable` | 是 | 托管文档依赖、预授权或持久记录不可用 |
| `document_quality_evidence_invalid` | 是 | 托管文档质量检查拒绝:生成环境交回的质量记录不合法,或与请求、模板、最终文件对不上 |
| `document_quality_package_invalid` | 是 | 托管文档质量检查拒绝:文件结构不合格(ZIP/XML/关系/逐部件覆盖、定稿母版;HTML 与定稿渲染结果不一致) |
| `document_quality_render_invalid` | 是 | 托管文档质量检查拒绝:渲染证据不合格(页面预览、几何、字体、溢出;HTML 四个视口、对比度、键盘) |
| `document_quality_content_mismatch` | 是 | 托管文档质量检查拒绝:内容与请求、源数据或固定版式规则不符(标题、目录、表格、公式、图表、容量) |
| `document_quality_review_rejected` | 是 | 托管文档质量检查拒绝:对真实渲染预览的独立复核在唯一一次修复之后仍不通过(裁切、溢出、可读性、对齐);复核意见不随终态返回 |
| `image_request_invalid` | 是 | 图片描述、上传或 job 预算拒绝 |
| `image_backend_unavailable` | 是 | 图片必需 binding 或计费服务不可用 |
| `image_upstream_failed` | 是 | 图片上游失败或无有效 usage |
| `image_safety_rejected` | 是 | OpenAI moderation_blocked |
| `image_region_rejected` | 是 | OpenAI 地区拒绝 |
| `image_artifact_failed` | 是 | PNG 校验、R2 保存或内部交付元数据失败 |
| `pipeline_output_empty` | 是 | `research` / `code-review` / `docs` 的交付步模型没给出正文(空或只有空白),任务判失败而不是交出空结果 |

「有 producer」= 今天真的会发到 wire 上。标「否」的两个成员是**先登记**,为的是不产生第二个
权威;按它们写重试逻辑没有意义。

派发前的**输入格式**拒绝同样不属于这个族,就近定义、不进 `FAILURE_CODES`:`envelope_invalid`
(信封形状不对)、`unknown_pipeline_kind`(kind 未登记)、`pipeline_kind_retired`(kind 已停用,ap#552)、`pipeline_input_invalid`(违反注册表声明的
字段约束,载荷另带 `details`,见 §6)。它们表示「请求本身发错了」,不建作业,所以也永远不会出现在
`result.failure_code` 里。

**拒绝载荷今天只有 `code`,没有恢复时刻字段。** 见 §11。

### 7.4 派发前的第一步预检,与后续资金失败的原因(REQ-232)

- **派发时先查第一个计费步**:`dispatch`(与 HTTP `POST /v1/cloud/jobs`)在受理之前,用 account 的只读检查
  看任务**第一个计费步**此刻能否被受理(不占预留、不建任务)。拒绝 ⇒ HTTP 402 / MCP `isError:true`,载荷
  `{ error, code, required_fen, available_fen, allowance_remaining_credits, wallet_overflow }`,`code` 是上表
  account 三码之一(`account_suspended` / `account_allowance_exhausted` / `account_wallet_insufficient`),
  `required_fen` = 第一步需由钱包承担的金额,`available_fen` = 钱包可用余额,`allowance_remaining_credits` =
  两个额度窗口剩余的较小者(无订阅时为 `null`)。放行 ⇒ 原样 `202`。
- **查不到不放行**:account 不可达 / 未配置 ⇒ `503` + `code: "account_unavailable"`;account 只给理由不给码的拒绝
  (服务端配置态)⇒ `503` + `code: "preauth_check_unavailable"`。这两个是基础设施类码,不属于上表的能力拒绝族,
  稍后重试即可。
- **只查第一步**:检查与第一步真正扣费之间余额仍可能被别的请求用掉;后续任何一步因钱失败时,作业终态带同一组码:
  状态视图(`status` / `await` / `artifacts` / HTTP `GET /v1/cloud/jobs/:id`)在 `status:"failed"`
  时于 **`result.failure_code`** 给出(不加顶层字段;`result` 其余字段语义不变),SSE 的 `job.failed` 事件记录在
  `data.code` 给出。
- **gateway 402 的 message 尾标**:`/v1/chat/completions` 与 `/v1/messages` 的预授权 402 在 `error.message` 末尾
  追加 ` [failure_code=<code>]`(`/v1/messages` 的错误体没有 `code` 槽,这是码唯一的载体);chat 面的顶层
  `error.code` 不变。

## 8. 限流与退避

两层,方向**刻意相反**;拒绝形状与退避字段的完整契约在
[`rate-limit-backoff.md`](rate-limit-backoff.md),本节只给第三方要知道的那一面。

| 面 | binding | key 前缀 | 限额 | 窗口(秒) | 限流器故障时 |
| --- | --- | --- | --- | --- | --- |
| `gateway` | `RL` | `gateway-preauth:` | `300` | `60` | fail-open |
| `gateway` | `RL_TENANT` | `gateway-tenant:` | `300` | `60` | fail-closed |
| `gateway` | `RL_AGENT_TENANT` | `gateway-agent-tenant:` | `300` | `60` | fail-closed |
| `cloud` | `RL` | `cloud-preauth:` | `120` | `60` | fail-open |
| `cloud` | `RL` | `cloud-action:` | `120` | `60` | fail-open |
| `cloud` | `RL_TENANT` | `cloud-tenant:` | `120` | `60` | fail-closed |
| `cloud` | `RL_SSE` | `cloud-sse:` | `30` | `60` | fail-closed |

「限流器故障时」一列只覆盖限流器的**运行期故障**(`limit()` 抛错)。生产部署里 binding
**缺席**不在此列:那不是故障,是这道已 publish 的闸整个不存在 —— 此时 fail-open 三行的
`RL` 桶同样 **fail-closed 拒**(`429`),不再无声放行
([`ap#386`](https://github.com/jinjunnn/alpha-platform/issues/386);缺席与故障从外部不可
区分,曾让本表 `cloud-preauth:` 的 `120/60` 在生产上实测不成立,
[`ap#173`](https://github.com/jinjunnn/alpha-platform/issues/173))。

第三方在 MCP 面会碰到的是 `cloud-preauth:` / `cloud-action:` / `cloud-tenant:` 三行:
`cloud-preauth:` 拦在 `/mcp` 与两条 `.well-known` 之前(按 IP),
`cloud-action:` 与 `cloud-tenant:` 在 §6 标了「消费租户桶」的那五个工具内(按 IP / 按租户)。
`cloud-sse:` 只挂在 HTTP 的 `GET /v1/cloud/jobs/:id/events` 上(MCP 面没有 SSE 工具),它抑制的是
**连接开启速率**而非并发数 —— 逐条说明在
[`rate-limit-backoff.md`](rate-limit-backoff.md) §1.2。

### 8.1 MCP 工具面**结构上没有响应头**

`tools/call` 的结果是 JSON-RPC 文本。⇒ 退避信息**只能进 payload**,不要去读响应头:

```json
{ "error": "rate limited: tenant capacity exceeded", "code": "account_admission_rate_exceeded", "retry_after_seconds": 60 }
```

`isError: true`,HTTP 仍是 200。IP 抗滥用层在工具内命中时同样是 200 + `isError`,`code` 为
`rate_limited`;而拦在 `/mcp` 之前的那道是真 `429`。

### 8.2 HTTP 面的退避头(只在拒绝时挂)

以 cloud 租户桶为例:

| 头 | 值 |
| --- | --- |
| `retry-after` | `60` |
| `ratelimit-limit` | `120` |
| `ratelimit-remaining` | `0` |
| `ratelimit-reset` | `60` |

**放行的响应上一个 `ratelimit-*` 都没有** —— 平台限流器只回 `{ success: boolean }`,成功时报
一个"剩余"只能是编的。且它是 per-colo 最终一致的**阻尼**,不是精确配额:不要据此做精确调度。

## 9. 协议代际与弃用

`/mcp` 是**单端点双代际**:同一个 URL 同时服务 legacy 与 modern。

| 代际 | 值 |
| --- | --- |
| modern(对外默认) | `2026-07-28` |
| legacy | `2025-11-25` `2025-06-18` `2025-03-26` `2024-11-05` `2024-10-07` |

modern 臂的 wire 形状,三条硬要求(缺一条会被不同的错误码拦掉,现象各不相同):

1. 代际号放在 `params._meta` 里,**不在请求体顶层**。`_meta` 缺键先被 `-32602` 拦;
   **`_meta` 里没有代际号 = 走 legacy**,不会报错,只是行为变成另一件事。
2. `Mcp-Method` 头必需,且必须与 body 的 `method` 一致(不一致 `-32020`)。
3. `tools/call` **另需 `Mcp-Name: <工具名>` 头**,值与 `params.name` 一致。缺了它同样 `-32020`。

这三个头在 CORS 预检里都是被允许的,连同 `authorization` 与 `mcp-protocol-version`。

不支持的代际会被 `400` + JSON-RPC `-32022` 拒,错误体的 `data.supported` 自报服务端支持什么 ——
**那是代际号的权威来源**,不要抄本文这张表。`server/discover` 的 `result.supportedVersions`
给出同一个集合。

其余方法面:

- `GET /mcp` 与 `DELETE /mcp` 是 **405**,不是 401 也不是 SSE。这个端点是 stateless 的,
  没有会话可开也没有会话可关。
- `subscriptions/listen`(modern 代际带来的)被当场拒绝:我们没有订阅能力,也没有事件总线。
- JSON-RPC batch 被拒(§5)。

**弃用政策**(owner 裁决):对外推荐代际是 modern;legacy 支持窗口 = 上游引擎升到 v2 客户端
之后再 +90 天,届时评估退役。详见
[`architecture/cloud-mcp-resource-surface.md`](../architecture/cloud-mcp-resource-surface.md) §5.1。

## 10. 凭证类型与撤销窗口

### 10.1 `/mcp` 接受哪些凭证

| 凭证 | `/mcp` 接受 | 说明 |
| --- | --- | --- |
| `mcp_access` OAuth access token | 是 | 标准路径。audience 必须是 §2 的 canonical resource URI;授权向量是 scope 数组 |
| `sk-alpha-*` API key | 是 | **专有扩展**,见 §10.3 |
| `platform_access` JWT | 否 | 通用平台凭证(`aud = alpha-platform-api`),`/mcp` 自 `ap#226` 起**不再受理**。拒绝形态与无凭证一致(§5 的 401 `invalid_token` challenge),客户端据此走标准 OAuth 取 `mcp_access` |
| dev token | 否 | 仅 `PLATFORM_ENV=dev` 的本地开发,生产不存在 |
| `job_token` | 否 | 模型-egress 凭证,MCP 面不接受(泄漏的 job token 不得用来派新作业) |

`platform_access` 那一行在双接受窗内(2026-08,桌面切到 `mcp_access` 之前的过渡期)曾是「是」;
收紧步 `ap#226` 落地后翻成「否」。它仍是 `/v1/*` 与 gateway 模型面的通用凭证,只是**不再打开 `/mcp`**:
任何客户端在这个面上一律只走 `mcp_access`(或 §10.3 的 API key)。一支 `mcp_access` 的 `aud` 钉在
本资源自己身上,通用凭证能做的事不该比它声明的用途宽。

### 10.2 撤销与轮换,逐格给窗口

**「撤销/停用最长生效时间 = 令牌 TTL」。** 不要读成「立即」。

| 撤销动作 | 最长生效时间 | 依据 |
| --- | --- | --- |
| 撤销 / 停用一支 access token(`mcp_access` / `platform_access`) | **= 该令牌的 TTL** | 本资源不做在线状态检查,只验签名与 claims;TTL 内的令牌照旧可用 |
| 刷新令牌族的撤销 | 由 AS 定义 | 见 alpha-web AS contract 的 revocation 一节 |
| 撤销一支 `sk-alpha-*` API key | 见下表(正缓存) | 边缘缓存窗口,不是「立即」 |
| 一支无效 key 被重新启用 | 见下表(负缓存) | 边缘缓存窗口 |
| 停用租户 | 见本节末 | 语义与上面四种**不同** |

API key 的两个窗口是边缘缓存 TTL,上界:

| 缓存 | TTL(秒) |
| --- | --- |
| 正缓存(撤销传播上界) | `120` |
| 负缓存(重新启用上界) | `60` |

**租户级停用的语义要原样读:**

> 停用拒绝的是**暂停检查之后到达资金咽喉的调用**。已通过 `preauth`、provider 尚未开始的
> 请求**仍会消费**;已存在的预留**仍正常结算**。它**不是**「立刻停掉一切」。

被停用租户的调用会拿到 `account_suspended`(§7.3)。

`mcp_access` 的具体 TTL 由授权服务器决定,归 alpha-web 的 AS contract;本文只钉住不变量
(「窗口 = TTL」),不复制那个数字。

### 10.3 API key 是专有扩展,不是标准 OAuth

前缀 `sk-alpha-`。它:

- **不适用 audience 规则** —— 它不是 JWT,没有 `aud`,§2 的 canonical resource 绑定对它不适用;
- 有**自己的 scope 词表**(§4.1),与 OAuth scope 名字不同;
- 有**自己的撤销语义**(§10.2 的 120 秒缓存窗),与令牌 TTL 无关;
- **不要宣称它等价于标准 OAuth**。它先于 OAuth 存在,是给无头集成用的旁路。

## 11. 今天**不支持**的

显式清单。每一条都有 owning issue 或已裁决的理由;**不要按这些写集成**。

**本表的每一行都挂着一条可执行判据**(`public-contract-doc-190.test.ts` 的「§11 逐行判据」一节),
断的是「这条限制**今天仍然成立**」,不是「这一行填没填归属」:限制一旦被修好,对应判据当场红,
逼人回来删掉那一行 —— 否则这份对外契约会继续宣称一件已经不成立的事(实证:`ap#238`)。
行与判据是**双射**,⇒ **加一行就要加一条判据**,只加行会红。

| 不支持的事 | 现状 | 归属 |
| --- | --- | --- |
| 拒绝载荷里的恢复时刻字段(`retry_at`) | **全仓零实现** —— 生产代码里没有这个字段,wire 上也没有。§7.3 的拒绝今天只有 `code` | [`ap#201`](https://github.com/jinjunnn/alpha-platform/issues/201) |
| **在浏览器里**运行的第三方 MCP 客户端 | 跨源浏览器请求打 `/v1/*`(**含 `contentRef.url` 那次下载**)与 `/mcp` 会得 403 `origin_not_allowed`:origin 闸只放行 §2 的 canonical origin。**Node / CLI 客户端不受影响** —— 它们不发 `Origin`(实测 node v22 的 `fetch`:GET 与 POST 都不发),所以无头集成与 harness 照常可跑 | 这是 [`#179`](https://github.com/jinjunnn/alpha-platform/issues/179) 的**有意裁决**(已认证 API 面钉 canonical 身份),不是缺口;放宽公开可达面归 loopback-callback 那条线,**不在本 epic**。[`ap#173`](https://github.com/jinjunnn/alpha-platform/issues/173) 的 clean-room 矩阵走 Node,不受这条约束 |
| schedule 类工具(`cloud_schedule_*`) | **已按 owner 裁决从 MCP 面剔除**,不会回来。能力保留在 HTTP `/v1/cloud/schedules` | 已裁决 |
| `GET /mcp` 的 SSE 长连接 / `subscriptions/listen` | 端点是 stateless,前者 405、后者当场拒 | 已裁决(§9) |
| JSON-RPC batch | 结构性拒绝(§5) | 已裁决 |
| `job_max_iter_exceeded` / `job_max_tokens_exceeded` | 已登记进 `code` 值域,**今天没有 producer** | [`ap#201`](https://github.com/jinjunnn/alpha-platform/issues/201) |

## 12. 判据索引

本文没有散文承诺。每个数字与字面量都由
[`packages/gateway/test/public-contract-doc-190.test.ts`](../../packages/gateway/test/public-contract-doc-190.test.ts)
绑回代码 —— 那个文件解析本文的表格,再与**跑出来的**权威值做集合/逐字段相等。改文档任一处即红,
改代码而不改文档同样即红。

| 本文位置 | 权威 | 判据形态 |
| --- | --- | --- |
| §2 canonical resource / AS issuer / 两条 PRM 路径 | [`lib/canonical-resource.ts`](../../packages/gateway/src/lib/canonical-resource.ts)、[`lib/protected-resource-metadata.ts`](../../packages/gateway/src/lib/protected-resource-metadata.ts) | 真跑 `protectedResourceMetadataResponse`,逐键比对 |
| §2 响应头与允许方法 | 同上 | 真跑,逐头比对 |
| §4 本资源的 scope 词表 | `MCP_SUPPORTED_SCOPES`(注册表并集) | 集合相等;同时 == PRM 的 `scopes_supported` |
| §4 平台令牌词表 | [`contracts/v1/identity.ts`](../../packages/gateway/src/contracts/v1/identity.ts) 的 `TokenPurposeV1Schema` | 集合相等 |
| §4.1 API key scope 展开 | [`lib/action-authorization.ts`](../../packages/gateway/src/lib/action-authorization.ts) | **全量词表逐个探** `authorizeAction`,放行集合相等 |
| §5 401 / 403 challenge | [`lib/mcp-transport-auth.ts`](../../packages/gateway/src/lib/mcp-transport-auth.ts) | 真跑 `guardMcpTransport`,解析真实 `WWW-Authenticate` 后逐参数比对 |
| §5 batch 拒绝 | 同上 | 真跑,逐字段比对 |
| §5.1 API key 拒绝原因三值 | 同上 + [`lib/api-key-reject-reason.ts`](../../packages/gateway/src/lib/api-key-reject-reason.ts) | 真跑 `guardMcpTransport`(负缓存各喂一个原因),逐行比 `error_description`;原因列集合 == 枚举 |
| §6 工具面九行 | [`lib/mcp-tool-registry.ts`](../../packages/gateway/src/lib/mcp-tool-registry.ts) | 真跑 `listTools` 取名字集合;逐字段比对注册表 |
| §6 入参字段集合 | `tools/list` 的 JSON Schema | 真跑,逐工具比对必填/可选集合 |
| §7.1 付费路由 | [`contracts/v1/billing-actions.ts`](../../packages/gateway/src/contracts/v1/billing-actions.ts) 的 `BILLABLE_ROUTES` | 逐条相等 |
| §7.3 `code` 值域与 producer 分区 | [`contracts/v1/failure-codes.ts`](../../packages/gateway/src/contracts/v1/failure-codes.ts) | 集合相等;producer 分区由 `src/**` 的**字节级**扫描双向确认 |
| §8 桶清单 | [`lib/rate-limit.ts`](../../packages/gateway/src/lib/rate-limit.ts) 的 `BUCKET_POLICIES` | 逐行逐字段相等;fail-open/closed 由**真跑抛错的限流器**判定 |
| §8.1 MCP 拒绝 payload | 同上 | 真跑 `tenantRefusalBody` |
| §8.2 退避头 | 同上 | 真跑 `rateLimitHeaders` |
| §9 代际号 | **wire**(包不导出 modern 代际号) | 真跑 `/mcp`:`-32022` 的 `data.supported` × `server/discover` 交叉 |
| §10.1 凭证受理 | [`lib/tenant-auth.ts`](../../packages/gateway/src/lib/tenant-auth.ts) | 每支凭证真跑一次 `guardMcpTransport`,断接受/拒绝 |
| §10.2 API key 撤销窗口 | [`lib/api-key-auth.ts`](../../packages/gateway/src/lib/api-key-auth.ts) | 真跑 `verifyPlatformApiKey`,读它写进 KV 的 `expirationTtl` |
| §10.3 API key 前缀 | 同上 | `API_KEY_PREFIX` 相等 |
