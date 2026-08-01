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

## Removing a departing component: split by "can it still run?"

When an update drops a component, its removal is **not** one action. It is split by
whether the thing being removed can still *execute*, and the two halves land in
different places for reasons that are structural, not stylistic.

**The half that can still run — the config key — is an ordinary transaction plan
item.** `agent.<name>` and `mcp.<name>` are deleted by a normal `config` action
(`buildDepartingChildConfigItemsV1`), in the *same* transaction that installs the
new components. `ConfigEdit` already carries `value: undefined` as "delete this
key" (`ext-config.ts` names the idiom `ConfigLeafEdit`), and `prepareConfigTx`
collapses edits into whole-file pre/next images **in-process at planning time** —
the journal stores only digests, so `undefined` never has to survive JSON. Apply
happens at switch; rollback restores the before-image.

A skill contributes no config item: its activation surface is the derived
allow-list, which `writeLedgerFile` recomputes from records inside the same
`applyPackageMutation`. Emitting a config item for it would create a second source
of truth for one fact.

**The half that cannot run — content files, generation stores, capability grants —
is cleaned up after the transaction returns.** By then the engine has released the
bundle lock, and this path touches no configuration at all
(`removeFsInstallFilesOnly`, `skipConfig`), so it *cannot* re-enter
`withConfigWriteLock`. That matters: `withConfigWriteLock` takes the **same,
non-reentrant** bundle lock the transaction holds. An earlier version of this
contract put the whole cleanup inside `commitReceipt`, i.e. inside that lock —
which made agent/MCP cleanup fail every time, while the ledger was already durable
and the failure was swallowed into a warning that still reported success.

### Consequences, in full

| When it fails | Result |
| --- | --- |
| lock / precondition / staging / probe / switch / receipt commit / any crash point | config key restored from the before-image, file cleanup never ran — **all old** |
| the ledger mutation itself | throws → engine rolls back — **all old** |
| file cleanup, after the transaction committed | update **succeeds** with a named warning; the component is already unloadable (no config key, no record, not in the allow-list) and what remains is inert disk residue |

"All old or all new" is a statement about the board **after recovery**, not about
the instant of a crash: a crash between switch and receipt commit legitimately
leaves a non-terminal journal, and recovery resolves it in both directions. The
crash matrix therefore runs the real recovery before asserting.

A cleanup failure must never be reported as a failed update — the ledger already
says the new version is installed, and saying otherwise would tell the user the old
version is still there when it is not.

**This residue is not automatically retried.** The journal is terminal by then, so
nothing sweeps it. It is inert, and it is recorded here rather than described as
"recoverable", which an earlier version of this document incorrectly claimed.

## Uninstall keeps a different order, and cannot borrow this one

Uninstall has no transaction, so its sequence stays:

1. **decide** — read the ledger **once** and run the *same* checks the write path
   runs: `validateV3State` (inside `readPackageLedgerStateV1`) and
   `validatePackageMutationScopeV1`. Read-only.
2. **destroy** — remove the artifacts of the children judged `delete`. Idempotent.
3. **commit** — exactly one root `PackageLedgerMutationV1`.

Every ledger state `applyPackageMutation` would reject is therefore already
rejected in step 1, with zero artifact calls.

**Known residual window**, stated correctly: step 3 can still fail **without any
other process being involved** — `writeLedgerFile` shrinks the skill allow-list
before its atomic rename, and either write can fail on I/O or permissions. The
board is then *artifacts gone, old ledger intact*. An earlier version of this
document blamed a concurrent process; that was wrong.

The reverse order is still not the answer. Once the graph is gone there is nothing
left to compute the departing set from, and a surviving `mcp.<name>` key would keep
an unowned server running — turning "retry converges" into "stuck and running".
Update escapes this only because it has a transaction whose before-image covers the
config half. This is a structural difference between the two paths, not a rule one
of them forgot to follow.

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
| Update through real admission, transaction and ledger; planning-time conflict; the crash matrix under real recovery; and the **real production cleanup seam run while the bundle lock is held** (with the full seam's `config busy` failure as its discrimination proof) | `packages/ui-mac/src/main/package-update.test.ts` |
| User-reachable removal (hub card → detail → production main) | `packages/ui-mac/src/renderer/extensions/ext-package-detail-wiring.test.ts` |
