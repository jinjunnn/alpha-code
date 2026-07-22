---
title: Frontend surface composition
kind: architecture
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-22
review_after: 2027-01-18
---

# Frontend surface composition

## Authority

[`frontend-surface-manifest.ts`](../../packages/ui-mac/src/shared/frontend-surface-manifest.ts)
is the descriptive ledger for top-level frontend composition boundaries. It
records lineage, target, mount, and source facts, but it does not register or
decode routes. It covers URL pages and non-URL surfaces because the Alpha
renderer mounts both:

- `route`: a page or compatibility redirect owned by the in-app router;
- `overlay`: a full-page workspace, modal, or transient layer above the current route;
- `inline`: a shell or route slot such as sidebar, composer, or timeline;
- `boot`: a recovery host that runs before or while the renderer starts.

The manifest records durable implementation facts only. Requirement status,
priority, ownership assignment, and planned delivery remain in GitHub Issues and
Alpha Delivery.

[`route-manifest.ts`](../../packages/ui-mac/src/shared/route-manifest.ts) is the
separate executable authority for formal route identity, parameter schemas,
path/query encoding, and the single leaf-or-redirect composition seam. It is
data and a contract, not a copy of the upstream Router runtime or page tree.

## Classification

Each entry separates two facts that must not be conflated:

- `lineage` describes the implementation composition: `alpha`, `opencode`, or
  `hybrid`;
- `releaseSurface` optionally links a route leaf to the startup resolver, whose
  effective `alpha` or `legacy` mode and reason can vary by release default,
  environment override, or pin. Surface crash diagnostics never change composition.

An Alpha-looking takeover that still depends on an upstream DOM anchor is
`hybrid`, not a completed Alpha replacement. A runtime `legacy` result does not
rewrite the static lineage; it selects the upstream leaf for that renderer
lifetime.

Recovery has two lifecycle slots under one Alpha owner: a dedicated renderer window before the
product window for DbSafety decisions, and one runtime overlay host for sidecar and surface
incidents. Generic upstream Dialog consumers opt into the single Alpha Dialog host; Model/Provider
and Permission remain explicitly outside that migration until their owning lines replace them.

`overlay.settings` is an Alpha-owned full-page overlay with one renderer mount.
The desktop platform's `openSettings` seam routes sidebar, command, menu, and
fallback-home entrypoints to that owner, so the Alpha host never mounts an
upstream Settings dialog or depends on its DOM. Its durable Settings authority
is also excluded from the generic renderer store bridge and is reachable only
through the typed Settings adapter. A desktop Platform coordinator serializes
that adapter's reads and writes, then publishes each successful full value and
opaque revision to both the Alpha overlay and the upstream `SettingsProvider`.
Context setters submit field-level transforms through the same coordinator, so
they rebase on the current authority instead of persisting a stale full-store
snapshot.

The inventory is intentionally limited to top-level ownership boundaries. Tabs,
popovers, controls, and render helpers belong to their enclosing surface unless
they acquire an independent host or navigation lifecycle.

Permission confirmation is an Alpha-owned overlay mounted once inside the active
session provider tree. Its narrow surface client reuses that session's current
server/directory SDK and existing event emitter for pending-request list, asked/replied
events, and atomic replies; it does not create a parallel SDK client or SSE stream.

## Route contract

The versioned route manifest is the only Alpha codec for the current application
URL vocabulary. Its parser, href builder, and navigation targets all consume the
same path/query descriptors:

```text
/                                      home
/:dir                                 compatibility redirect
/:dir/session?prompt=...              draft admission
/new-session?draftId=...              draft page
/:dir/session/:sessionId              durable session
```

Settings, Dialog, and Recovery also have unique manifest identities and empty
parameter schemas, but remain non-URL system surfaces. Invalid directory data,
missing parameters, unknown routes, unsupported manifest or route versions, and
corrupt links select the Recovery identity with a deterministic error code.

The Electron renderer uses `MemoryRouter`, so the application route and the
shell document path may differ. Code that decides product navigation reads the
router location; shell diagnostics may read `window.location` but must not treat
`/index.html` as the current product page.

Router providers, layouts, and route registration remain upstream-owned and are
not duplicated by this contract. A primary workspace that needs deep links and
navigation history belongs on a route; a transient confirmation or contextual
picker remains an overlay.

## Development inspector

Development builds derive the Frontend Surface Map from the canonical manifest.
Open it with the `MAP` control or `Cmd/Ctrl + Shift + M`. It provides:

- lineage and mount filters;
- current router and shell locations;
- route transitions generated from manifest edges;
- resolved Alpha/Legacy mode and resolution reason;
- current mount highlights, source paths, owners, entrypoints, and fallbacks.

The inspector is dynamically imported only when `import.meta.env.DEV` is true.
It is not a product route and is absent from production builds.

## Change discipline

Any change that adds, removes, replaces, or relocates a top-level surface must
update the manifest in the same change. The manifest tests enforce unique IDs,
valid internal transition targets, real source files, canonical route-identity
mapping, and coverage of every mount kind. Route-manifest tests separately
enforce route/version uniqueness, path/query round trips, and fail-closed
recovery. Runtime mount tests remain responsible for the stronger XOR claim that
an Alpha leaf and its upstream fallback are never active as competing owners at
the same seam.
