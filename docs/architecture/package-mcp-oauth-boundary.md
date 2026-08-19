---
title: Package MCP OAuth ownership boundary
kind: architecture
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-08-19
review_after: 2027-02-19
---

# Package MCP OAuth ownership boundary

## Why this document exists

A package whose remote MCP declares `auth.kind: "mcp-oauth"` is authorised by
the *engine's* OAuth stack, not by anything compiled into this app. That split
is easy to erode from either side — main "just parsing" a token response once,
or the engine being asked to open browsers on main's behalf — so the ownership
table and the two non-obvious mechanisms below are pinned here.

Its sibling for the other authorization kind is
[`alpha-connection-lifetime.md`](alpha-connection-lifetime.md). The two are
separate subsystems on purpose: an Alpha Connection's durable record is
main-owned; an MCP OAuth credential's durable record is the engine's
`mcp-auth.json` (`0600 + flock`, the accepted boundary for REQ-128 — not
safeStorage, not a migration rider).

## The ownership table

| Fact | Owner | Where |
| --- | --- | --- |
| Discovery, DCR, PKCE, state nonce, token exchange, token store | engine | `packages/opencode/src/mcp/**`, reached only via authenticated typed routes |
| Attempt (which signed prerequisite, which loopback redirect, state check) | main | `packages/ui-mac/src/main/package-mcp-oauth.ts` |
| Prerequisite projection from the signed payload | shared decoder | `packages/ui-mac/src/shared/package-mcp-oauth.ts` |
| Readiness at admission time | engine, asked each time | `resolveMcpOauthBinding` in `package-admission.ts` → `POST /mcp` probe |
| Browser | renderer, given `browserUrl` by main | attempt `begin` outcome |
| Token↔server binding | engine (`getForUrl(name, url)`) | probed against the **re-validated signed envelope URL** |

Main's engine seam has exactly three verbs — `add`, `authStart`,
`authCallback` — and deliberately no credential-removal verb. Revocation is a
separate explicit user action, never a side effect of cancel, install failure
or uninstall (`uninstallPackageV1`'s installer surface has no OAuth verb at
all).

## The loopback callback ownership trick

The engine's `startAuth` registers a pending PKCE transport but no callback
waiter (only its browser-opening `authenticate` does that, and `authenticate`
cannot hand a renderer the URL). So main points the ephemeral instance config's
`oauth.redirectUri` at a per-attempt loopback listener (`127.0.0.1:<random>`),
**bound before `authStart` is called**: the engine's callback-server helper
checks whether the port is in use and stands down when it is. That order is
load-bearing — listener first, then `authStart` — and it is what lets main
verify the provider's `state` against *this attempt* before forwarding only the
authorization code to the engine's typed callback route.

`POST /mcp` writes engine **instance state only** (nothing durable, nothing in
`plugin[]` — ADR-040 is untouched); the durable `mcp.<name>` config lands later
through the normal package transaction and binds the same signed URL.

## Readiness is asked, never cached

There is no main-side "OAuth is ready" record. Admission's required-OAuth gate
(`§2.7`: zero transaction calls before ready) re-probes the engine with the
re-validated signed URL on every attempt, so a token minted for one server can
never follow a tampered or re-pointed envelope to another — the engine's
`getForUrl` refuses the entry and the gate refuses the install. "Cannot ask the
engine" (seam absent, engine unreachable) is treated exactly as "asked and told
no": required refuses, optional installs disabled with
`mcpOauthUnavailable: true`.

Every named behaviour above is pinned by
`packages/ui-mac/src/main/package-mcp-oauth.wiring.test.ts`.
