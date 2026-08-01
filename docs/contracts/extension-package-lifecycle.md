---
title: Extension package lifecycle — update, uninstall, and shared-child claims
kind: contract
status: active
owners:
  - alpha-code
last_reviewed: 2026-08-01
review_after: 2027-02-01
---

# Extension package lifecycle — update, uninstall, and shared-child claims

A package (Bundle) is installed as **one graph**: a root component plus every
leaf this host will actually install. This document states what happens the
**second** time — when the same package arrives at a different exact version,
and when the user removes it — and why a child can survive its package.

The install half is [`host-extension-package-v1.md`](host-extension-package-v1.md);
the ledger's V3 shape (`packageGraphs` / `claims` / owner tokens) is
[`extension-install-ledger.md`](extension-install-ledger.md).

## Identity: exact digests only

A change is computed from exact values and nothing else. There is no semver
resolution anywhere in this path; a version string is compared for equality and
otherwise carried as opaque text.

A child's identity is `(kind, name)` — the key of its install record and of its
claim. For each such position the diff yields exactly one of:

| Change | Judged by |
| --- | --- |
| `added` | the position exists only in the new graph |
| `removed` | the position exists only in the old graph |
| `replaced` | `manifestDigest` **or** `componentId` differs |
| `optional-changed` | content is byte-identical, only `required` flipped |
| `unchanged` | all three are equal |

A component id that changes while `(kind, name)` stays put is **`replaced`**, not
"one removed plus one added": treating it as two events would release the child's
claim and re-acquire it, and in the gap its owner set is empty — for a child that
never left the package.

Two graphs with different `packageId` are a caller error and fail loudly. They
are never aligned positionally.

## Ownership: the owner token moves with the root

A package's owner token is `bundle:<packageId>@<root manifestDigest>`. Updating
the root's content therefore **changes the token**, and every surviving child has
to be transferred: release the old token, acquire the new one. The mutation lists
**all releases before all acquires** — the ledger applies set algebra in array
order, so the other order would drop the token it had just taken.

Failing to release the old token is not a cosmetic defect: the stale token becomes
an *orphan owner* (a claim naming a graph this ledger no longer holds) and the
whole write is refused. Before this contract landed, installing a second version
of a package was structurally impossible for exactly that reason.

## Removal: three conditions, all required

A child that leaves a package is deleted **only** when all three hold:

1. **the owner set is empty** after this package's owner is released;
2. **it is managed** — the ledger holds a v2 install record for it;
3. **no legacy protection** — `legacy-protected` is an owner, so it keeps the set
   non-empty; it is called out separately because "another package still uses it"
   and "this predates package tracking" are two different sentences to the user.

Otherwise the child is **retained** with a named reason
(`shared-with-package` / `user-installed` / `legacy-protected` / `unmanaged`),
and not one artifact is touched.

## Order: destroy is always the last thing, never the first

The rule both paths obey is **destruction happens after the last check that could
still change the decision** — not "both use the same sequence". They do not, and
they must not, because only one of them has a transaction.

**Uninstall** (no transaction):

1. **decide** — read the ledger **once** and run the *same* checks the write path
   runs: `validateV3State` (inside `readPackageLedgerStateV1`) and
   `validatePackageMutationScopeV1`. Read-only.
2. **destroy** — remove the artifacts of the children judged `delete`. Idempotent.
3. **commit** — exactly one root `PackageLedgerMutationV1`.

Every ledger state `applyPackageMutation` would reject is therefore already
rejected in step 1, with zero artifact calls. A failure in 1 or 2 leaves the
ledger byte-for-byte unchanged and the user's retry converges.

**Update** (has a transaction): the departing children's artifacts are removed
inside `commitTransactionLedger`, **after** the ledger mutation succeeds.

The engine can still `rollbackAll` at the pre-switch probe and at receipt commit;
only once receipt commit has succeeded does it cross into forward-only territory
(`ext-transaction.ts`: "receipt 已 durable = 越过可回滚点"). Removing before the
transaction — as the first version of this contract did — produces the state this
whole design exists to prevent: the update reports failure, the old graph, claims
and records are all intact, **and the departing component's files are gone**.

Consequences, in full:

| When it fails | Result |
| --- | --- |
| lock / precondition / staging / probe / switch / any crash point | seam never reached — **zero deletion**, ledger old |
| the ledger mutation itself | throws → engine rolls back — **zero deletion**, ledger old |
| cleanup, after the ledger is durable | update **succeeds** with a named warning; a residual file remains |
| crash between the mutation and the cleanup | journal is non-terminal → recovery re-runs `commitTransactionLedger` → mutation replays exactly, cleanup repeats idempotently |

A cleanup failure must never be reported as a failed update: the ledger already
says the new version is installed, and claiming otherwise would tell the user the
old version is still there when it is not. That is also why the cleanup seam is
never allowed to throw — throwing would roll the live tree back to a state the
durable ledger no longer describes.

Uninstall cannot use the update ordering. Once the graph is gone there is nothing
left to compute the departing set from; update gets away with it only because the
journal still carries `childRemovals`. Uninstall has no journal, so a residual
would go from "retry converges" to "stuck".

**Known residual window**, recorded rather than hidden: if another *process*
changes the ledger between uninstall's steps 1 and 3, step 3 can still refuse
after step 2 has deleted. In-process this path is serialised by the gated-write
per-root mutex; cross-process the exposure is identical to today's
`uninstallByKey`, i.e. a pre-existing class rather than something introduced here.

## Conflicts refused at planning time

Two packages may share a child — that is a supported arrangement — **provided both
name byte-identical content**. If another package's graph already holds the same
`(kind, name)` at a different `manifestDigest`, installation is refused while
planning, before the confirmation screen. Letting it through would overwrite the
first package's content while its graph still points at the old digest.

One `packageId` has at most one graph, so two versions are never active at once.

## What a package does not own

* **enable / disable** — a Bundle claims installation, not the user's switches;
  desired-state changes pass through the V3 section untouched.
* **capability grants** — re-authorisation is decided by the committed grant
  ledger (`grants.json`) versus this attempt's request set. Expanding capabilities
  therefore requires confirmation by construction, not by a separate flag.
* **Alpha Connections** — a connection is shared and revoked at the provider.
  Uninstall releases this component's *binding* and never disconnects or revokes;
  a release failure is reported, never fatal.

## The update preview

Before confirming, the user is shown, per component: the change above, the
prerequisites that will be collected, and the capability delta against the
committed grant. Departing components appear too, carrying the capabilities they
are giving up. Claim decisions are listed with their named retain reasons, so
"why is that skill still here?" has an answer on screen rather than in a log.

## Recovery and generations

A transaction that has not committed, or whose candidate probe fails, rolls back
to the before-image immediately — the existing engine behaviour, unchanged. After
commit there is **no multi-generation package retention**: the ledger holds the
current graph for a `packageId` and nothing else. Skill generations remain a
per-child mechanism and are not a package rollback channel.

## Evidence

| Guarantee | Gate |
| --- | --- |
| Diff, claim transfer, removal verdicts, conflicts; fixed-seed bounded model test | `packages/ui-mac/src/main/ext-package-lifecycle.test.ts` |
| Canonical permutations, ordering, tampered/dangling/overreaching mutations | `packages/ui-mac/src/main/ext-package-lifecycle-permutations.test.ts` |
| Update through real admission, transaction and ledger; planning-time conflict | `packages/ui-mac/src/main/package-update.test.ts` |
| User-reachable removal (hub card → detail → production main) | `packages/ui-mac/src/renderer/extensions/ext-package-detail-wiring.test.ts` |
