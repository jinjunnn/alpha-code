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

## Order: decide, then destroy, then commit once

Both update and uninstall run in this order, and the order is the contract:

1. **decide** — read the ledger once, compute every claim verdict. Read-only.
2. **destroy** — remove the artifacts of the children judged `delete`. Idempotent.
3. **commit** — exactly one root `PackageLedgerMutationV1`: claim transfer,
   departing records, and the graph itself, in one validated write.

Any failure in 1 or 2 leaves the ledger **byte-for-byte unchanged**; the user
retries and the operation converges (every removal is idempotent and the plan is
recomputed from the ledger, which still holds the graph).

The reverse order is wrong here and not merely riskier: once the graph is gone
there is no way left to compute which children should have been removed, and a
leftover MCP configuration keeps a server running that the ledger no longer knows
about.

Package uninstall deliberately does **not** use the engine's per-key uninstall
journal. That engine holds the bundle lock while removing artifacts, and the agent
and MCP configuration writers take the *same*, non-reentrant lock — a whole-package
uninstall would fail with `config busy`. Wrapping each child in its own journalled
uninstall reinstates the shape V3 removed: one lock, one journal and one ledger
write per child. The replacement invariant is the one stated above: the ledger is
the recovery point.

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
