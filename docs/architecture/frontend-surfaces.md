---
title: Frontend surface composition
kind: architecture
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-20
review_after: 2027-01-20
---

# Frontend surface composition

## Authority

[`frontend-surface-manifest.ts`](../../packages/ui-mac/src/shared/frontend-surface-manifest.ts)
is the executable source of truth for top-level frontend composition boundaries.
It covers URL pages and non-URL surfaces because the Alpha renderer mounts both:

- `route`: a page or compatibility redirect owned by the in-app router;
- `overlay`: a full-page workspace, modal, or transient layer above the current route;
- `inline`: a shell or route slot such as sidebar, composer, timeline, or permission;
- `boot`: a recovery host that runs before or while the renderer starts.

The manifest records durable implementation facts only. Requirement status,
priority, ownership assignment, and planned delivery remain in GitHub Issues and
Alpha Delivery.

## Classification

Each entry separates two facts that must not be conflated:

- `lineage` describes the implementation composition: `alpha`, `opencode`, or
  `hybrid`;
- `releaseSurface` optionally links a route leaf to the startup resolver, whose
  effective `alpha` or `legacy` mode and reason can vary by release default,
  environment override, pin, or crash fallback.

An Alpha-looking takeover that still depends on an upstream DOM anchor is
`hybrid`, not a completed Alpha replacement. A runtime `legacy` result does not
rewrite the static lineage; it selects the upstream leaf for that renderer
lifetime.

The inventory is intentionally limited to top-level ownership boundaries. Tabs,
popovers, controls, and render helpers belong to their enclosing surface unless
they acquire an independent host or navigation lifecycle.

## Navigation compatibility

[`legacy-route-abi.ts`](../../packages/ui-mac/src/shared/legacy-route-abi.ts)
remains the only codec for the frozen OpenCode-compatible URL vocabulary. The
current application route chain includes:

```text
/                                      home
/:dir                                 compatibility redirect
/:dir/session                         draft admission
/new-session?draftId=...              draft page
/:dir/session/:sessionId              durable session
```

The Electron renderer uses `MemoryRouter`, so the application route and the
shell document path may differ. Code that decides product navigation reads the
router location; shell diagnostics may read `window.location` but must not treat
`/index.html` as the current product page.

Changing the canonical route vocabulary is a separate compatibility change. It
must preserve existing deep links through typed parsing/redirects and verify
draft promotion, tab lifecycle, provider scope, and back/forward behavior. A
primary workspace that needs deep links and navigation history belongs on a
route; a transient confirmation or contextual picker remains an overlay.

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
valid internal transition targets, real source files, frozen-route mapping, and
coverage of every mount kind. Runtime mount tests remain responsible for the
stronger XOR claim that an Alpha leaf and its upstream fallback are never active
as competing owners at the same seam.
