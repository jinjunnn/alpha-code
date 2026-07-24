# E7 (#223) LIVE-PATH deploy probe — 云优先前提验证

- 日期:2026-07-22(UTC 10:14 前后,cf-ray `a1f1ad37eff45e6f-LAX`)
- 探针环境:有网络主机(非 codex 沙箱),无用户登录态/平台 token
- 被验前提:E7 基线(`docs/design/2026-07-22-e7-cloud-web-search-baseline.md`,alpha @ 85eea87)——
  「登录态云优先」成立当且仅当**已部署**的 cloud worker 真实提供 `cloud_web_search`,
  且打包默认 URL 指向该 worker(post-9aac1d4)。

## 结论:RUNNING(前提成立)

已部署的 `alpha-cloud` worker 在 `/mcp` 上**匿名可达且 tools/list 列出 `cloud_web_search`**;
gateway 的 `/v1/tools/web_search` 规范路径**存在且鉴权 fail-closed(401,非 404)**;
打包默认 URL 与部署域**同宿主**(`alpha-cloud.tidelabs.click`)。唯一未做的是带真实
bearer 的端到端搜索调用(需用户登录态),但搜索后端密钥已确认配置在位(见 §4),
不存在 502 `no search backend configured` 的空配置风险。

## 1. A 侧:打包默认 `ALPHA_CLOUD_MCP_URL`

- 没有静态打包 env;URL 在运行时派生,**仅登录态(platform-pays / DEV_PLATFORM_TOKEN)才写入**:
  - `packages/ui-mac/src/main/alpha-auth.ts:167` — `if (!token || !base) return`(未登录直接不设)
  - `packages/ui-mac/src/main/alpha-auth.ts:172` — set-if-unset:
    `ALPHA_CLOUD_MCP_URL = ep.mcp ?? \`${ep.cloud ?? base}${ALPHA_PATHS.mcpGateway}\``
- 默认解析结果 = **`https://alpha-cloud.tidelabs.click/mcp`**:
  - `packages/ui-mac/src/shared/alpha-config.ts:29` — `cloud: "https://alpha-cloud.tidelabs.click"`
  - `packages/ui-mac/src/shared/alpha-config.ts:48` — `mcpGateway: "/mcp"`
  - 解析优先级(`packages/ui-mac/src/main/alpha-endpoints.ts:96-108`):
    env override(`ALPHA_CLOUD_URL`)> userData pin > 登录 discovery(token 响应 `endpoints{cloud,mcp}`)> 硬编码默认
- sidecar 注册 `mcp.cloud` 双闸:`packages/ui-mac/src/main/sidecar.ts:369-370` —
  需 `ALPHA_CLOUD_MCP_URL` **且** `ALPHA_CLOUD_TOKEN` secret 文件同时在位;能力位同闸
  (`sidecar.ts:190-193`)。即:登出/BYOK = 云面全暗,登录 platform = 指向下述部署 worker。
- `ALPHA_CLOUD_MCP_URL` 在 sidecar 白名单透传(`packages/ui-mac/src/main/sidecar-env.ts:54`,非密钥)。

## 2. B 侧:部署配置与源码

- `packages/gateway/wrangler.cloud.jsonc:7` — custom domain `alpha-cloud.tidelabs.click`(与 A 侧默认同宿主 ✓)
- 同文件 services:`GATEWAY → alpha-gateway` binding(审计#12,`cloud_web_search` 转发所依赖)
- `packages/gateway/src/cloud.ts:81` — `app.all("/mcp", ...)` MCP Streamable HTTP 端点
- `packages/gateway/src/cloud-mcp.ts:150-165` — `cloud_web_search` tool:authTenant 闸 →
  `env.GATEWAY.fetch("https://gateway.internal/v1/tools/web_search")`(cloud-mcp.ts:157)
- `packages/gateway/src/worker.ts:795` — `app.post("/v1/tools/web_search", webSearchHandler)`(规范路径,9aac1d4 引入)
- 9aac1d4(2026-07-08 17:46 +0800)`git merge-base --is-ancestor` 确认在 origin/main ✓

## 3. 活体探针(无凭证)

### 3a. `alpha-cloud` /health — 200

```
$ curl https://alpha-cloud.tidelabs.click/health
{"ok":true,"service":"alpha-cloud (ADR-016: cloud jobs API + MCP facade)","api_version":"2026-07-01",
 "routes":[...,"CRUD /v1/cloud/schedules (PA-28)","GET /v1/cloud/jobs?since=&origin=schedule","ALL /mcp"]}
```

### 3b. `/mcp` initialize — 200,匿名握手成功

```
$ curl -X POST https://alpha-cloud.tidelabs.click/mcp -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"initialize",...}'
data: {"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{"listChanged":true}},
       "serverInfo":{"name":"alpha-cloud","version":"2026-07-01"}},"jsonrpc":"2.0","id":1}
```

### 3c. `/mcp` tools/list — **`cloud_web_search` 在列**(决定性证据)

匿名 tools/list 返回 8 个工具,与当前 `cloud-mcp.ts` 完全一致:
`cloud_dispatch, cloud_status, cloud_await, cloud_artifacts, cloud_schedule_create,
cloud_schedule_list, cloud_web_search, cloud_schedule_delete`

```
{"name":"cloud_web_search","description":"Web search via the platform host-tool endpoint
 (Tavily/Brave keys stay in gateway; billed per call to the calling tenant). Returns {query, results}.",
 "inputSchema":{...,"properties":{"query":{"type":"string"},"max_results":{"type":"number"}},"required":["query"]}}
```

### 3d. `/mcp` tools/call cloud_web_search(无凭证)— 鉴权 fail-closed ✓

```
data: {"result":{"content":[{"type":"text","text":"{\"error\":\"unauthorized\"}"}],"isError":true},"jsonrpc":"2.0","id":3}
```

### 3e. gateway `/v1/tools/web_search`(无凭证)— **401 非 404** ⇒ post-9aac1d4 路径已部署 ✓

```
$ curl -X POST https://alpha-gateway.tidelabs.click/v1/tools/web_search -d '{"query":"probe"}'
HTTP/2 401
{"error":{"message":"unauthorized"}}
```

(pre-9aac1d4 的 worker 无此规范路径,会 404;401 证明 handler 在且先鉴权。)

## 4. 部署新鲜度与密钥在位(wrangler 只读查询)

- `wrangler deployments list`:
  - `alpha-cloud` 最新 deploy **2026-07-08T10:18:58Z**(= 18:18 +0800,**晚于** 9aac1d4 的 17:46 +0800)✓
  - `alpha-gateway` 最新 deploy **2026-07-09T04:22:31Z** ✓
- `wrangler secret list --config wrangler.jsonc`(gateway):**`TAVILY_API_KEY` 与 `BRAVE_API_KEY` 均已配置**
  ⇒ worker.ts:762 的 502 `no search backend configured` 分支不会命中。

## 5. 边界与残留

1. **未验证项(需用户登录态)**:带真实 bearer 的端到端 `cloud_web_search` 调用返回真实
   `{query, results}` + 计费落账。鉴于 3c/3e 证明链路在、§4 证明密钥在,剩余风险仅为
   provider key 失效/额度耗尽——属运行期问题,不影响 E7 前提判定。
2. **部署 vs main 的漂移(反向,不阻塞 E7)**:活体 `/health` 响应**缺 `readiness` 字段**
   (当前源码 cloud.ts 已带,#43/#58 2026-07-19 合入),与 deploy 时间戳一致——已部署 worker
   为 07-08/07-09 版本,**晚于 9aac1d4(E7 所需)但早于 07-19 的 strict fail-closed 加固**。
   E7 前提不受影响;安全加固的重部署应另行跟踪,勿混入 #223。
3. tools/list 匿名可枚举(工具名/描述可见,调用被鉴权闸住)——与源码设计一致
   (authTenant 在各 tool handler 内),非缺陷,记录在案。
