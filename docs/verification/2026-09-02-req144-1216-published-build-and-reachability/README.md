# REQ-144 / alpha-code#1216 — ④格:发布件钉扎(AC2)与 `mcp:access` dispatch 可达性勘破(AC1)

承接 `#1197` 的④格(`docs/verification/2026-08-31-req144-1197-login-minted-mcp-access/`)。

结论矩阵:

| AC | 判定 | 一句话 |
| --- | --- | --- |
| AC2 发布件本体钉扎 | **PASS** | 已验签 manifest → release 资产 → 装机件 `app.asar` 三方逐字一致,标记检索命中、负针零命中 |
| AC1(原判据)D1 `job_admissions` 准入行 | **结构上不可达** | 该行只由 MCP 面 `cloud_dispatch` 写,而该工具**广播出来的 inputSchema 是空的**,模型只能发 `{}`,服务端在 handler 之前就拒 ⇒ 永不落行。阻塞方是 `#793`,不是 `#1214` |
| AC1(改判后,owner 2026-09-02 裁决) | **PASS** | 判据换成 `ap#226` 白纸黑字要的那句「已发布桌面版实际以 `mcp_access` 完成过一次 `tools/call`」;证据 = 0.1.9 app 内端到端见证 + `settle_intent` 时间对齐行 |

阅读顺序:先看 AC2,再看「AC1 —— 勘破」(为什么原判据到不了),最后看「AC1 改判」(新判据与证据)。

---

## AC2 —— 发布件本体钉扎重做到 0.1.9(**PASS**)

信任链从仓内 trust 根起算,每一跳都带负对照。

### ① manifest 签名(用仓内自己的验签器,不手写替身)

`packages/ui-mac/src/main/release-manifest.ts` 的 `verifyReleaseManifestBytes`,
信任根 `docs/contracts/desktop-release-manifest.trust.json`:

| 臂 | 结果 |
| --- | --- |
| 真件(`alpha-release-manifest.json` + `.sig`) | `ok: true`,version `0.1.9`,keyId `a4062792…` |
| 篡改 manifest 一个字节 | `ok: false` — `manifest not valid JSON` |
| 换一个合法 base64 的错误签名 | `ok: false` — `signature verification failed` |

两条负对照证明验签不是恒真。

### ② manifest 登记值 ↔ release 资产

`alpha-code-mac-arm64.zip`(160,032,724 B,kind `updater-archive`):

```
实测 sha256    15c5be089926daa2d54621af9ec229122f3ebd03aaf0612b9d102fb65bf87b01
manifest 登记  15c5be089926daa2d54621af9ec229122f3ebd03aaf0612b9d102fb65bf87b01   ← 逐字相符
```

manifest 另载该资产 `signed / notarized / stapled = true`,
identity = `Developer ID Application: Beijing yuanyuji Technology Co.,Ltd (RQX6X6A635)`。

### ③ release 资产 ↔ 装机件(`app.asar` 逐字节)

```
release zip 内  a9b5ae6faa49093b03c06fb84b9b7d8f01ab0ef07f28f49f58d0552f4bf32b51
/Applications   a9b5ae6faa49093b03c06fb84b9b7d8f01ab0ef07f28f49f58d0552f4bf32b51   ← 相同
装机版本号      0.1.9(CFBundleShortVersionString)
```

**比对手段校准**:把 release 内 `app.asar` 复制一份、翻转 offset 1000000 的一个字节,
同一比对器给出 `release == 变异件: False`,而 `release == 装机: True` ⇒ 比对不是恒 True。

装机件签名面另测:`spctl -a -vvv -t install` → `accepted / source=Notarized Developer ID`;
`xcrun stapler validate` → `The validate action worked!`。

### ④ 标记检索(asar 含大量字面 NUL,一律 `grep -a`)

| 标记 | 属于 | 命中 |
| --- | --- | --- |
| `ALPHA_MCP_TOKEN` | T2(`#1200` 静态 header 通道) | 8 |
| `sweepLegacyCloudMcpAuthEntry` | T3(`#1203` 退役 OAuth 残留) | 2 |
| `engineMcpAuthPath` | T3 | 2 |
| `ensureDirSdkContext` | `#1214` AC1 修复 | 6 |
| `审批请求等待` | `#1214` AC2 呈现 | 3 |
| `zzz-t1216-nonexistent-needle-8f2a` | **负针** | **0**(rc=1) |

T2/T3 计数与 v0.1.7 那轮逐项相同。依《本机验证陷阱》:asar 哈希不等 ≠ 代码不同,但
**哈希相等 = 字节相同**;叠加标记检索证明发布件确含 T2/T3 与 `#1214` 修复。

**判定:④格被测件已钉死为 v0.1.9 发布件本体,且装机件 = 发布件。**

---

## AC1 —— 勘破:这条判别子今天走我们自己的代码到不了

`#1216` 票面写的是「等 `#1214` 修好后由 owner 在发布件里触发一次真实 dispatch」。
`#1214` 已修(0.1.9)。**在请 owner 动手之前先跑第零问「这个状态,走我们自己的代码到得了吗」——
答案是到不了。**

### 谁写这一行:只有一个入口

- `job_admissions` 的唯一生产写入点是 `admitJob`(`alpha-platform` `cloud-core.ts:297`),
  由 `dispatchJob` 调用。
- `surface="mcp"` 只在**一处**传入:`cloud-mcp.ts:96`,即 MCP 工具 `cloud_dispatch`。
  另外五个云工具(`cloud_status` / `cloud_await` / `cloud_artifacts` / `cloud_cancel` /
  `cloud_web_search`)都不碰 `dispatchJob`。
- `caller_ref='mcp:access'` 由 `deriveCallerRef`(`job-ledger.ts:118-131`)在 `via==="mcp"`
  时返回的租户级常量。

⇒ **判别子 = 模型在桌面端调用 MCP 工具 `cloud_dispatch`**,没有第二条路。

### 桌面 UI 那条「下发云端任务」不算

`packages/ui-mac/src/renderer/extensions/cloud-dispatch-box.tsx:194` →
`window.api.cloud.dispatch` → `alpha-cloud-jobs.ts:117` `dispatchCloudJob`,走的是
**HTTP** `POST /v1/cloud/jobs`,带 `purpose=cloud.dispatch` 的 platform_access。
它产生的是 `surface='http'` + `caller_ref='jwt:cloud.dispatch'`,**不是**本 AC 的判别子。

### 为什么模型调不动它(实测,带对照臂)

云 worker 用 `server.registerTool(name, { inputSchema: CloudJobRequestV1Schema }, …)`,
而 `CloudJobRequestV1Schema` 是 `z.discriminatedUnion("autonomy", […])`
(`contracts/v1/cloud-job.ts:56`)。

以 `packages/gateway/node_modules` 里**装着的那个版本**(`@modelcontextprotocol/sdk@1.29.0`,
`zod@4.4.3`)起真 server + 真 client,走 `InMemoryTransport` 发 `tools/list`:

| 臂 | 广播出的 inputSchema |
| --- | --- |
| `cloud_dispatch`(真实 schema,逐字 import 生产源) | `{"type":"object","properties":{}}` — **整个 union 被静默丢掉** |
| 对照臂:普通 `z.object({query,n?})` | `{"type":"object","properties":{query,n},"required":["query"],…}` |

对照臂非空 ⇒ 探针不是瞎的。**模型收到的是「这个工具没有任何参数」。**

再发 `tools/call`,同一对真 server/client:

| 参数 | 结果 |
| --- | --- |
| `{}`(桌面唯一能构造的形状) | `isError=true`,`-32602 Input validation error … invalid_union`,**handler 没跑** |
| 完整合法信封(对照臂) | `isError=false`,handler 跑了 |

handler 没跑 ⇒ `dispatchJob` 没跑 ⇒ `admitJob` 没跑 ⇒ **`job_admissions` 不落行**。

### `#793` 的诊断需要更正一处

`#793` 记的是「桌面 `convertTool` 无条件写死 `properties:{} + additionalProperties:false`,
把服务端的 `oneOf` 分支全禁掉」。实测:**服务端根本没广播 `oneOf`** —— union 在
`registerTool` 那一步就丢了。所以:

- `packages/opencode/src/mcp/catalog.ts:43-48` 的 `convertTool` 确实还在写死那三行(现状核对属实);
- 但**只修桌面侧修不好**:桌面从未收到过分支信息。
- 另测:`convertTool` 合成的 `{type:object,properties:{},additionalProperties:false}` 交给
  引擎实际使用的 `jsonSchema()`(`ai@6.0.168`),其 `validate` 为 `undefined` ⇒ **本地不做校验**。
  所以本地校验不是拦路点,**「模型不知道要传什么」才是**。

修法的方向因此落在 alpha-platform 一侧。已实测的候选形状(同一探针):

| 候选 | 广播字段数 |
| --- | --- |
| 现状 `z.discriminatedUnion` | 0 |
| 扁平 `z.object`(`autonomy` 为 enum、分支字段 optional) | **7**(`schema_version,idempotency_key,autonomy,kind,input,objective,capabilities`) |
| 非判别 `z.union` | 0 |

真正的判别仍可留在 handler 内用 `CloudJobRequestV1Schema.parse` 执行,服务端语义不放松。
**但这改的是公共 Cloud MCP 面广播出去的形状(REQ-130 契约面),选型归 owner,本文不代为决定。**

### 因此

- 请 owner「在发布件里点一次云任务」**产生不了**这条判别子 —— 那是《勘破先于闸门设计》里
  「finding 论证充分 ≠ 场景可达」的同一个坑,只是这次坑在我们自己的票面上。
- `#1216` 的 AC1 保持未完成,阻塞方改记为 `#793`(不是 `#1214`)。

---

## AC1 改判(owner 裁决,2026-09-02):判据换成 `ap#226` 白纸黑字要的那句

原 AC1 要的 `job_admissions` 行,上一节已证明**结构上取不到**。改判的理由不是「取不到就降格」,
而是**原判据本来就比它服务的那张票要得多**:

`ap#226`(REQ-130 收紧步)的准入原文是

> 已发布的桌面版**实际**以 `mcp_access` 完成过一次 `tools/call`。

不是「一条 dispatch 准入行」。`#1197` 当初挑 `job_admissions` 做判别子,是因为它是当时能想到的
**服务端持久记录**;但那张表恰好落在唯一一条结构不可达的路上,而 `ap#226` 从未要求过它。

**新 AC1**:已发布的桌面端(0.1.9)以登录铸的 `mcp_access` 在云 MCP 面完成过一次真实
`tools/call`,且服务端留有与该次调用时刻对得上的持久痕迹。

### 证据

**① 端到端见证(app 内,发布件本体)**

0.1.9 装机后新建会话发起云端联网搜索:

- 审批对话框呈现,Action 逐字为 `mcp:cloud:cloud_web_search`(即云 MCP 面的工具调用,
  不是 HTTP 面),含主体 / 资源 / Scope / 有效期共 5 条事实与 3 个决策按钮;
- 点「允许一次」后搜索**完成**,返回真实答案(2.9 秒 / 882 tokens)。

对照:同一路径在 0.1.8 及之前**四次复现全部等满 5 分钟 fail-closed**(`#1214`),
所以「出结果」本身就是发布件走通了这条路的证据,不是可以碰巧发生的事。

云 MCP 面消费的凭证是登录铸的 `mcp_access`(`{file:}` header 通道,`oauth:false`),
其 `aud` 逐字为云 MCP 资源、且为标量 —— 已在 `#1197` ②格进程内解码断言(PASS),
本轮不重复取证。

**② 服务端持久痕迹(D1 `alpha-settle-intent`)**

`cloud_web_search` 经 gateway 的封印路由 `/v1/tools/web_search` 按次计费到调用租户
(`worker.ts:2433`,该路由是**唯一**额外接受 `mcp_access` 的路由,`ap#228`)。查 `settle_intent`:

```
action_id=tool.web_search  state=delivered  created=2026-09-02 09:21:22 UTC  charged_fen=15  billing_path=wallet
```

**时间对齐**:v0.1.9 的 release 发布时刻是 `2026-09-02T09:19:13Z`;该表里
`tool.web_search` 共 6 行,**发布时刻之后有且仅有这一行**(上一行是同日 03:41:19,
属发布前的编排者直连探针)。

**查询手段先做正样本对照**:同一查询给出 `model.invoke.chat` 58 行 delivered / 23 行 void、
`model.invoke.messages` 5 行 void,并逐行给出时间戳 ⇒ 空结果会是真空,不是瞎查。

### 如实声明证据强度(不粉饰)

`settle_intent` 的列里**没有凭证类别**(`0001_settle_intent.sql:13`:只有 `tenant_ref` /
`action_id` / `state` / 时间 / receipt)。带 `caller_ref` 的那张表正是打不开的 `job_admissions`。
所以服务端痕迹**不是**「字段上写着 via=mcp」,归因靠三条合起来:

1. app 内审批框逐字显示 `mcp:cloud:cloud_web_search` ⇒ 走的是云 MCP 面,不是 HTTP 面;
2. 云 MCP 的 `cloud_web_search` 原样转发调用方 Authorization(`cloud-mcp.ts:201`),
   而桌面在该通道上带的就是 `mcp_access`(`#1197` ②格);
3. 计费行时刻与该次调用对得上,且是 0.1.9 发布之后唯一一行。

**这比原 AC1 的判据更强,不是更弱**:`job_admissions` 的行同样分不出「发布件发的」还是
「持 token 直连发的」(`#1197` 自己写过这一点),它从来只是「有过一次 dispatch」的代理;
而这里有的是**发布件本体内被见证的那一次调用**,代理不再必要。

**判定:AC1 PASS。** `ap#226` 的准入条件因此满足。

### 遗留

`cloud_dispatch` 桌面侧不可用这件事本身仍未修,已从本票剥离为 alpha-platform 一侧的
独立 CODE 票(`#793` 的服务端半场);它是产品能力,不是本票的证据格。
