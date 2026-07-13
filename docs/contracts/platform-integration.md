---
title: Alpha Code platform integration
kind: contract
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-13
review_after: 2026-10-13
---

# Alpha Code platform integration

This contract describes the desktop side of the Alpha Web and Alpha Platform
integration. Service wire formats remain owned by their producer repositories.

## Ownership and authority

| Surface | Owner | Desktop seam |
| --- | --- | --- |
| Authorization code, refresh/session rotation, endpoint discovery | `alpha-web` | `alpha-auth.ts`, `alpha-endpoints.ts` |
| Model gateway and model registry | `alpha-platform` | injected `alpha` provider |
| Cloud Jobs HTTP/SSE, artifacts, schedules, MCP facade | `alpha-platform` | main-process clients and injected MCP server |
| Account summary and billing transactions | `alpha-platform` account service | main-process account client |

Current Alpha Platform contracts are
[`cloud-jobs-v1.md`](https://github.com/jinjunnn/alpha-platform/blob/main/docs/contracts/cloud-jobs-v1.md)
and
[`account-billing.md`](https://github.com/jinjunnn/alpha-platform/blob/main/docs/contracts/account-billing.md).
Endpoint precedence is defined in
[`platform-endpoint-discovery.md`](platform-endpoint-discovery.md).

## Authentication flow

1. The main process creates PKCE S256 verifier/challenge and state, then opens
   `GET <web>/auth/authorize` with client `alpha-code`, redirect
   `alpha-code://auth/callback`, and OAuth grant metadata scope
   `openid profile platform`.
2. Alpha Web authenticates the user and returns a one-time authorization code.
3. The desktop validates state and exchanges the code and verifier at
   `POST <web>/auth/token`.
4. Alpha Web returns a short-lived ES256 access JWT, rotating refresh token,
   session ID, and endpoint discovery. The JWT channel claim is `scope=user`;
   that is distinct from the OAuth grant metadata scope.
5. The desktop persists credentials in the main-process auth store, using OS
   `safeStorage` when available and restrictive file permissions for the
   documented fallback. Bearer values are never exposed to the renderer.
6. Refresh rotates the refresh token. A rejected refresh degrades to logged
   out/BYOK; transient network or server failure keeps the still-valid token
   for a later retry.

## Runtime seams

- **Model proxy:** platform mode sets the model gateway base and injects an
  `alpha` provider. BYOK providers remain direct and do not traverse Alpha
  Platform.
- **Cloud Jobs:** renderer requests cross narrow IPC handlers; the main process
  calls the Cloud Jobs HTTP/SSE and artifact APIs with the main-held bearer.
- **MCP facade:** the sidecar receives the Cloud MCP URL and a `{file:...}`
  bearer reference. The MCP facade fronts the same Cloud Jobs model; it is not
  a second execution truth.
- **Account:** the main process reads summary and transactions from the
  desktop-facing account endpoint. The renderer receives typed results, never
  the bearer.
- **Secret transport:** on each sidecar fork, login and BYOK secrets are
  mirrored into `0600` secret files. The sidecar allowlist carries non-secret
  endpoint configuration, while provider/MCP configuration carries file
  references rather than token values.

Login activates platform mode and respawns the sidecar in place when a live
window exists. Cold-start callbacks defer activation until the next normal
sidecar start. Logout clears token state and re-forks without platform
credentials.

## Invariants

- Alpha Web is the authority for public identity and desktop sessions; Alpha
  Platform verifies its JWT and owns enforcement, metering, jobs, and ledger.
- The renderer never receives access, refresh, provider, MCP, or account
  bearer values.
- The model gateway and Cloud Jobs/MCP worker are separate endpoints.
- Endpoint discovery accepts HTTPS or loopback HTTP only; malformed or unsafe
  values fall through to the next precedence layer.
- Any modification to synchronized upstream paths follows the sovereignty
  ladder in ADR-029. This contract does not reinstate the superseded claim that
  all integration must be additive-only.
- Active gaps and rollout state belong in GitHub Issues and Alpha Delivery,
  not in this contract.
