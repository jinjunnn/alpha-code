---
title: Alpha platform endpoint and model discovery
kind: contract
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-22
review_after: 2026-10-13
---

# Platform endpoint and model discovery

## Endpoint resolution

`alpha-code` resolves service bases in this precedence order:

```text
environment override > <userData>/alpha-endpoints.json > OAuth token discovery > bootstrap default
```

The executable consumer is
[`alpha-endpoints.ts`](../../packages/ui-mac/src/main/alpha-endpoints.ts); bootstrap
defaults and appended paths are defined in
[`alpha-config.ts`](../../packages/ui-mac/src/shared/alpha-config.ts).

The current `alpha-web` authorization-code and refresh-token responses include:

```json
{
  "endpoints": {
    "schema_version": 1,
    "web": "https://alphacodeone.com",
    "platform": "https://alpha-gateway.tidelabs.click",
    "account": "https://account.alphacodeone.com",
    "cloud": "https://alpha-cloud.tidelabs.click",
    "mcp": "https://alpha-cloud.tidelabs.click/mcp"
  }
}
```

The producer is
[`lib/endpoints.ts`](https://github.com/jinjunnn/alpha-web/blob/main/lib/endpoints.ts).
Values may be overridden per deployment. Discovery is accepted atomically only
when `schema_version` is exactly `1`, all required service bases are present,
there are no unknown fields, and every base is HTTPS (or loopback HTTP for
development). An unversioned, partial, future, or unsafe discovery payload is a
`contract-incompatible` failure; it is not merged and does not change the
current discovery state. Valid discovery is normalized and persisted to
`<userData>/alpha-discovered-endpoints.json` with mode `0600`.

The persisted copy is decoded just as strictly at startup and is never trusted
as a legacy format. If it is unversioned, malformed, or otherwise incompatible,
the desktop deletes it, records the contract failure for the persistent
renderer alert, and continues endpoint resolution through the remaining
environment, pin, and bootstrap-default layers. This fail-safe boot path does
not accept or migrate the rejected data.

The model gateway and Cloud Jobs/MCP service are separate Workers. If `mcp` is
omitted, the client derives `${cloud}/mcp`; it must never derive MCP from the
model gateway. Environment variables remain development/self-host escape
hatches: `ALPHA_WEB_URL`, `ALPHA_PLATFORM_URL`, `ALPHA_ACCOUNT_URL`,
`ALPHA_CLOUD_URL`, and `ALPHA_MCP_URL`.

The desktop-facing account endpoint above is distinct from the service-to-
service `ACCOUNT_URL=https://account.tidelabs.click` committed in Alpha Platform
Wrangler configuration. Do not exchange these hostnames without deployment and
authentication evidence.

## Model edition discovery

`GET /v1/models` is the executable source for the signed-in model catalog. In
addition to OpenAI list fields, Alpha Platform returns `edition` and
`byok_providers`. `data` contains platform-proxy models allowed for the resolved
edition; `byok_providers` limits only the built-in BYOK catalog and does not
block user-created providers. The gateway enforces the edition again on model
calls, so client filtering is presentation, not authorization.

`alpha-code` strictly decodes `ModelCatalogV1` from the pinned Alpha Platform v1
contract before updating `<userData>/alpha-live-models.json`. A transient
network failure may retain the last response that was already validated as v1.
A contract mismatch is different: it raises the persistent contract-health
failure and blocks cache/static catalog fallback for that process. Active model
IDs and edition rules come from the current Alpha Platform registry and tests,
not from examples in this document.
