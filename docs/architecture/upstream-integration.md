---
title: Alpha Code upstream integration
kind: architecture
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-13
review_after: 2026-10-13
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

## Verification

Run the repository synchronization/CI gates and:

```bash
bash scripts/verify-freeze-restore.sh
bash scripts/alpha-check.sh
```

Do not infer protected paths from old plans or design documents.
