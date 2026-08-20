---
title: REQ-089 #497 route/surface shared verification (reuse #322 under manifest authority)
kind: verification
status: complete
owners:
  - alpha-code maintainers
last_reviewed: 2026-08-20
review_after: 2027-02-20
---

# REQ-089 / #497 — route/surface shared verification

L1 re-run of the #322 leaf-XOR / preload / provider remount / fatal-recovery
matrix **after** route-manifest authority, plus the #212 closed-universe tests
that cover REQ-089 AC6. Evidence only: no production code changed.

- Issue: [#497](https://github.com/jinjunnn/alpha-code/issues/497)
- Parent: [#182](https://github.com/jinjunnn/alpha-code/issues/182)
- Baseline: [`docs/design/2026-07-22-req089-route-manifest-authority/baseline.md`](../../design/2026-07-22-req089-route-manifest-authority/baseline.md) §4 child 4
- Prior L2 live capture (historical, 2026-07-19, SHA `a5613686`): [`../2026-07-19-cap-session-surface/README.md`](../2026-07-19-cap-session-surface/README.md)
- Measured HEAD: `9bcb82c923e7ff7727992ae5afe1555a39703529` (`origin/alpha` at capture). Evidence commit later rebased onto `2cb98ccae` (`#1037`, docs-only); route/surface sources were unchanged, matrix not re-run.
- Environment: [`environment.json`](./environment.json)
- Run facts: [`results/results.json`](./results/results.json)

## Method

Bootstrapped an isolated worktree (`scripts/worktree-bootstrap.sh ac-497`) so
`node_modules` is local. Ran `bun test` from `packages/ui-mac` with an explicit
file list under `bash -c` (zsh does not split unquoted `$(...)`; a zero-file
run would look like a red). Confirmed `Ran N tests across M files` matches the
enumerated file counts (10 then 1).

This VERIFY ticket asked for the bun matrix, not a new Electron CDP recapture.
The 2026-07-19 L2 screenshots remain the last live session-surface capture;
several of those live cells are **superseded** by the hard cut (see matrix).

## Gates

| Gate | Command | Summary | Verdict |
| --- | --- | --- | --- |
| Manifest + seam + AC6 | `bash -c 'bun test --cwd packages/ui-mac src/renderer/alpha-ui/surface-seam-contract.test.ts src/main/alpha-surfaces.test.ts src/renderer/alpha-ui/surface-boundary.test.ts src/renderer/route-composition.test.ts src/shared/route-manifest.test.ts src/shared/route-manifest-packaging.test.ts src/shared/route-upstream-shape.test.ts src/shared/route-deep-link-consumer.test.ts src/shared/route-authority-ratchet.test.ts src/main/ext-security-boundaries.test.ts'` | `130 pass / 0 fail` across **10** files (428 ms) | true-green |
| MemoryRouter remount shell | `bash -c 'bun test --cwd packages/ui-mac src/renderer/surface-remount.test.ts'` | `8 pass / 0 fail` across **1** file (8.96 s) | true-green |

Totals: **138 pass / 0 fail / 11 files**.

## #322 matrix under manifest-driven composition

| # | 2026-07-19 live cell | Current L1 anchor | Result |
| --- | --- | --- | --- |
| 1 | Production surface resolve (env > pin > release default) | **Superseded.** `SURFACE_RELEASE_STATES` / `ALPHA_SURFACE_*` / `alpha-surfaces-resolve` are forbidden by `route-authority-ratchet.test.ts`. Failures persist only as diagnostics (`alpha-surfaces.test.ts`). | N/A (hard cut) — ratchet green |
| 2 | Home leaf XOR | `route-composition.test.ts` — every manifest route resolves to exactly one matching surface mount; renderer entry binds `productionRoutes.home` once | PASS |
| 3 | Draft / new-session leaf XOR | Same composition table (`new-session` / `session-admission` / `directory` → `newSession`) | PASS |
| 4 | Session release default = upstream legacy leaf | **Superseded.** Manifest composition is `session` → Alpha session surface (`expectedSurfaces.session = "session"`). Dual alpha/legacy mount is what the ratchet forbids. | N/A (hard cut) — composition green |
| 5 | Invalid directory fail-closed | `route-manifest.test.ts` `fail-closed route recovery > invalid directory` | PASS |
| 6 | Preload forwards only to the effective leaf | `surface-seam-contract.test.ts` `preload: () => Leaf.preload?.()` | PASS |
| 7 | Provider wrappers around injected leaves | `surface-seam-contract.test.ts` SessionProviders / DraftProviders; plus `surface-remount.test.ts` real MemoryRouter shell | PASS |
| 8 | Fatal → persist → `location.reload` → home crash-fallback to legacy | **Superseded.** `surface-boundary.test.ts` asserts `location.reload` and `crash-fallback` are absent; fatal path admits Alpha Recovery with a stable incident. | N/A (hard cut) — Recovery ratchet green |
| 9 | Clear failure record → home returns to alpha | Residual: `alpha-surfaces.test.ts` atomic persist / corrupt-as-empty. No env pin machine remains to restore. | PASS (diagnostics only) |
| 10 | Env-override layering | **Superseded** (same as #1). | N/A — ratchet green |
| 11 | Session dual gate (env + spike) | **Superseded.** Manifest is the closed composition; no spike/env XOR. | N/A — composition green |
| 12 | Production MemoryRouter | `route-composition.test.ts` `router={MemoryRouter}` once; `surface-remount.test.ts` mounts `AppInterface` with MemoryRouter | PASS |
| — | Navigation matrix (Home→Draft→Session, system surfaces, back/forward/reload identity) | `route-composition.test.ts` history identity; `route-manifest.test.ts` parse/href round-trip; `route-deep-link-consumer.test.ts` executed consumer | PASS |
| AC6 | Third-party cannot register/override top-level routes | `#212` tests in `ext-security-boundaries.test.ts` describe `AC4①` (REQ-103 numbering): closed `parseRoute` universe + renderer has no `addRoute` / `registerRoute` / `routes.push` / `createBrowserRouter`. Manifest is the closed set. | PASS |

## AC6 coverage note

REQ-089 AC6 is the route-ownership class. The merged #212 file still labels the
describe block `AC4①` because that was REQ-103's numbering. The assertions are
the ones the baseline cites: hostile top-level segments never become new routes,
and the renderer has no dynamic registration API. Both passed on this HEAD.

## Gaps

- **No CODE ticket for #497 scope.** The bun matrix is green; remaining #322 live
  cells that disappeared are product hard-cuts already locked by ratchets, not
  defects.
- **Unrelated base fail-set on `origin/alpha` (blocks full `alpha-check` / pre-push,
  not this matrix):** `extension-seed-snapshot.test.ts` cross-pin catalog SHA
  drift; `boot-dangling-onboarding-wiring.test.ts` actual 2 tests vs gate registry
  1 (`#844` exact-count). Needs a separate CODE/registry fix, not #497.
- **L2 live Electron / CDP was not re-run.** Last live evidence is
  `docs/verification/2026-07-19-cap-session-surface/` on SHA `a5613686`. A new
  live pass would be another VERIFY (visual/packaged), not an implementation
  ticket. This issue's written exit is the bun matrix plus #212 AC6 coverage.
