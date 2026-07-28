---
title: Alpha Code upstream integration
kind: architecture
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-28
review_after: 2026-10-28
---

# Upstream integration

## Branch and synchronization model

The repository is a fork. The `dev` lineage is the upstream integration base;
Alpha delivery occurs on the Alpha branch. The
[`sync-upstream.yml`](../../.github/workflows/sync-upstream.yml) workflow and
[`alpha-ci.yml`](../../.github/workflows/alpha-ci.yml) are the executable source
of truth for protected paths and synchronization gates.

`packages/app` and `packages/ui` are not ordinary upstream mirrors. They are an
L3 frozen takeover restored from `frontend-freeze-base-2` after sync. The
restore must preserve the typed `AppSurfaces` seam and pass the freeze/anchor
tests.

## Sovereignty ladder

ADR-029 defines the only supported ways to change upstream behavior:

| Level | Mechanism | Rule |
|---|---|---|
| L0 | Alpha-owned seam | default; add through plugin/tool/MCP/sidecar/config/owned package |
| L1 | Build/runtime transform | upstream source stays byte-identical |
| L2 | Mechanical patch | apply in build/restore; failure must block loudly |
| L3 | Frozen takeover | named path exits sync and accepts full maintenance cost |

There is no direct-edit level for a still-synchronized file. Moving a path to
L2 or L3 requires an accepted ADR naming scope, guard, rollback, and ownership.

## Shell-level registrations when Alpha replaces an upstream leaf

Upstream keeps command registrations (`command.register`) inside the page leaves
and inside the legacy layout. `command.trigger(id)` is
`optionMap.get(id)?.onSelect?.()` — an **unregistered id returns silently**. So
when Alpha takes over a leaf (REQ-085/086/125 replaced `home`, `new-session` and
`session`), every shell-level registration that leaf carried disappears, and any
entry still pointing at it becomes a control that does nothing and reports
nothing. The failure surface is **per route**: the same entry can work on one
route and be dead on another.

**Rule.** Replacing an upstream leaf requires an explicit decision for every
shell-level registration it carried — inherit (re-register in the Alpha shell),
retire (delete the entry as well), or restore. Alpha's UI must not contain a
clickable entry pointing at an unregistered command. The judgement is enumerated
**per entry**, not per command, so a new entry is covered by construction.

Current disposition (REQ-126 AC7):

| Entry | Command | Disposition |
|---|---|---|
| Sidebar account menu → Settings | `settings.open` | Inherited: calls the Alpha settings surface directly, route-independent |
| Sidebar search | `command.palette` | Inherited: registered once by `AlphaSessionSearch` on the shell |
| Sidebar new chat / open project / collapse / back / forward | `session.new`, `project.open`, `sidebar.toggle`, `common.goBack`, `common.goForward` | Inherited: registered once by `AlphaSidebar` on the shell, so the desktop menu and its accelerators reach the same handlers on every route |
| Empty-project state → Open project | `project.open` | Re-wired to Alpha's own directory picker (upstream's command only fed upstream's project list) |
| Floating terminal / review toggles | `terminal.toggle`, `review.toggle` | Retired with the buttons; the session workspace top bar owns the live equivalents |
| Composer permission tier "full auto" | `permissions.autoaccept.*` | Retired; the ids never existed upstream and the submit layer only branches on `readonly` |
| Desktop menu: terminal / file tree / previous·next session / previous·next project | `terminal.toggle`, `fileTree.toggle`, `session.previous`, `session.next`, `project.previous`, `project.next` | Retired from the published menu (`packages/ui-mac/src/shared/desktop-menu-policy.ts`); reviving them needs an Alpha-owned ordering model or panel handle, i.e. a new capability |
| Upstream titlebar `home.toggle` / `tab.*` | — | Not inherited. They are upstream's own controls, registered by the component that renders them, and Alpha adds no entry of its own: home is the sidebar brand button and the tab strip is hidden |

The gates are runtime, not source text:
`packages/ui-mac/src/renderer/sidebar/shell-commands.test.ts` mounts the real
shell and triggers each entry;
`packages/ui-mac/src/main/desktop-menu-publication.test.ts` builds the real
native menu and clicks every item.

## Verification

Run the repository synchronization/CI gates and:

```bash
bash scripts/verify-freeze-restore.sh
bash scripts/alpha-check.sh
```

Do not infer protected paths from old plans or design documents.
