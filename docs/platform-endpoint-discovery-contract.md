# Endpoint discovery contract (① — alpha-platform side)

alpha-code resolves its backend endpoints (gateway / account / web / mcp) in this precedence:

```
env override  >  userData pin file  >  login discovery (①)  >  hardcoded default
ALPHA_*_URL      <userData>/           /auth/token response     src/shared/alpha-config.ts
                 alpha-endpoints.json   { endpoints: {...} }
```

The consumer is implemented (`packages/ui-mac/src/main/alpha-endpoints.ts`). Today the **login discovery layer is dormant** — until alpha-web adds the field below, alpha-code falls back to the hardcoded default (currently `https://alpha-gateway.jinjunnm.workers.dev`).

## What alpha-web (`POST /auth/token`) should add

Include an optional `endpoints` object in the token-exchange JSON response:

```jsonc
{
  "access_token": "…",
  "refresh_token": "…",
  "expires_in": 3600,
  "plan": "pro",
  "endpoints": {                                   // NEW — all optional, absolute https URLs
    "platform": "https://alpha-gateway.jinjunnm.workers.dev",  // model proxy (/v1)
    "account":  "https://account.alphacodeone.com",           // account-server
    "mcp":      "https://<cloud-dispatch-worker>/…",          // cloud-dispatch MCP (separate worker)
    "web":      "https://alphacodeone.com"                    // optional; identity/links
  }
}
```

## Why
- The gateway has **no custom domain** — it's the raw `*.workers.dev` URL, which can change (account/subdomain/migration). Hardcoding it in the client shipped the wrong host once already (`api.tidelabs.click` → 404).
- With discovery, **moving the gateway = update the token response**; every client follows on next login, **no app release**.
- `mcp` is the real fix for cloud-dispatch: the MCP tool gateway is a *different* worker than the model gateway (`alpha-gateway.../mcp` → 404). Until `endpoints.mcp` is sent, alpha-code derives `${platform}/mcp` (which 404s) — harmless (cloud dispatch just won't connect), but discovery should provide the correct MCP URL.

## alpha-code behavior once you add it
- `endpoints` is persisted (`<userData>/alpha-discovered-endpoints.json`, 0600) so it survives restart (the proxy env is read at sidecar fork).
- An explicit `ALPHA_*_URL` env or a `<userData>/alpha-endpoints.json` pin still overrides discovery (dev/self-host escape hatch).
- Sending only a subset is fine; unspecified keys keep their resolved value.

---

# Edition 白名单契约(② — `GET /v1/models`,REQ-001)

**权威源**:网关(B)决定「允许哪些 provider / model」;alpha-code 按响应装配显隐,自身不做版本判断。
落地:alpha-platform `e6e90c1`(registry.ts edition 层 + worker.ts/server.ts 双端,2026-07-03 prod)。

## 响应形状(在 OpenAI list 形状上追加两个字段,向后兼容)

```jsonc
// GET /v1/models   (Authorization: Bearer <jwt> 可选 — 带则按租户 edition,不带按默认 edition)
{
  "object": "list",
  "data": [ { "id": "deepseek-chat", "object": "model", "provider": "deepseek", "minPlan": "free" } ],
  "edition": "cn",                       // NEW — 网关判定的版本
  "byok_providers": ["deepseek", "zhipuai", "minimax", "alibaba", "moonshot"]  // NEW — null = 不限制
}
```

## 语义
- `data` = 该 edition 允许的平台代理模型(registry 真实 id;enabled ∩ 白名单)。
- `byok_providers` = alpha-code **内置 BYOK 目录**的 provider 白名单;`null` = 不限制。
  **用户自定义添加的节点不受此约束**(2026-07-03 用户拍板:目录跟随 edition,自定义不拦)。
- 调用时执行:`POST /v1/chat/completions` 对白名单外模型返回 403 `code:"edition_forbidden"`(权威源不只管显示)。

## edition 解析顺序(网关侧)
```
JWT `edition` claim(alpha-web 未来签发,已前瞻接收) > EDITION_CONFIG.tenants[tenant] > EDITION_CONFIG.default
```
配置 = env var `EDITION_CONFIG`(JSON,`EditionConfig` 形状见 `alpha-platform packages/gateway/src/registry.ts`);
**改 var 即生效、不发代码**;缺失/坏 JSON → 代码内默认(intl 不限 / cn=deepseek 系)——fail-open,
这是产品显隐白名单而非安全边界(minPlan/计费硬闸独立)。

## alpha-code 消费(A 侧,feat/req001-edition-allowlist)
- main 在启动(异步)/ 登录 respawn 前 / picker 打开时同步响应到 `<userData>/alpha-live-models.json`;
- fork 期装配(`buildAlphaModelConfig`)与 picker 目录(`getEffectiveCatalog`)都读该缓存;
- 降级:同步失败保留 last-known;无缓存/损坏 → 内置 snapshot(`alpha-models.json`),picker 永不空白,
  代理组显示「内置目录」徽标;
- 生效时机:网关改配置后,客户端**重新登录或重开 picker** 即收窄显示,下次 fork(登录即 respawn)装配生效——不发版。
