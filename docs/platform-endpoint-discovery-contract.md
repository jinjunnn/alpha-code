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
