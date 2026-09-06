---
title: REQ-155 Alpha Office connector installs follow the running instance
kind: design
status: accepted
owners:
  - alpha-code product and security maintainers
last_reviewed: 2026-09-06
review_after: 2027-03-06
---

# REQ-155 Alpha Office connector installs follow the running instance

Parent requirement: [jinjunnn/alpha-code#1235](https://github.com/jinjunnn/alpha-code/issues/1235).
Decision authority: [`req-153-output-capability.md`](req-153-output-capability.md) §1.8 and §3.6
(owner ruling 2026-09-06). Implementation child: [jinjunnn/alpha-code#1244](https://github.com/jinjunnn/alpha-code/issues/1244).
This file records the mechanism that CODE child chose inside that ruling; it does not widen it.

## Ground truth

Measured on the owner's machine on 2026-09-04 against the running `Code Puppy.app` 0.1.9 (dev
channel). The app had switched from the prod channel to the dev channel. The dev root
`installs.json` was `{"receipts":[],"records":[]}` and the dev `alpha.jsonc` (171 bytes) had no
`mcp` key. The prod root still held four committed `mcp:alpha-*` records, and the prod `alpha.jsonc`
commands pointed at `/Applications/alpha-code.app/Contents/Resources/office-mcp/server.py`, a path
that no longer exists. The `office-docs` skill was live, so the model received instructions for four
tools that were not present.

Two facts had been frozen into durable state although both belong to the running instance:

- the bundled server path. [REQ-133](req-133-office-four-format-hub.md) has main replace
  `{alphaResources}` with the packaged resource root **at install time** (`ext-mcp-policy`), so the
  realpath of that day's bundle becomes the durable command. Renaming, moving, or updating the bundle
  leaves it dangling. The engine never sees `{alphaResources}`; unlike `{workspace}`
  ([REQ-134](req-134-mcp-workspace-follows-instance.md)) there is no spawn-time substitution to lean on.
- the channel root. REQ-098 keeps `env/{prod,beta,dev}` as sibling roots with no dual-read. A channel
  switch therefore starts from an empty ledger and an empty `mcp` key.

The only durable fact is the user's intent: the bundled Word/Excel/PowerPoint/PDF connector is
installed and enabled or disabled.

## Selected mechanism

`packages/ui-mac/src/main/alpha-office-instance.ts` runs once per boot in main, before the connect
timeout reconcile, the `{workspace}` marker reconcile, and the first sidecar fork. It performs two
narrowing, idempotent operations and nothing else:

1. **Re-anchor.** An Alpha Office `mcp.<name>` leaf in the current root whose command matches the
   pinned template token for token, except that the server slot names a different absolute
   `…/office-mcp/server.py`, has that slot rewritten to the current bundle's canonical server path.
   The workspace slot may still be a legacy concrete directory; the marker reconcile that runs next
   restores it, and it needs the current server path to recognise the template. The ledger is not
   touched: the record's identity facts did not change.
2. **Adopt.** A connector with no record at all in the current root (neither a v2 record nor a v1
   receipt) but a committed, catalog-origin, global-scope v2 record in a sibling channel root, together
   with that sibling's config leaf, is written into the current root through the same write policy an
   install uses (`applyMcpWritePolicy`: canonical server, `{workspace}` marker, REQ-133 safety checks,
   content digest of the bytes that will run). `desiredState` and the capability grant are copied; the
   transaction id is fresh; `environment` is the current one. When two siblings hold the connector, the
   record with the latest `updatedAt ?? installedAt` wins.

Sibling roots are read only: never written, never quarantined (side-effect-free ledger reads).
Everything else is preserved byte for byte and reported in the boot log: custom MCPs, non-Office
catalog MCPs, drifted templates, connectors absent from every root (the user uninstalled them),
non-committed records, and corrupt ledgers.

Rejected: resolving `{alphaResources}` at spawn time. That would move the substitution into the
engine's upstream `mcp/index.ts` (an upstream file) or require main to rewrite config on every
instance switch, and it would still not answer the channel-root question.

Rejected: auto-installing the four bundled connectors into every fresh channel root. A fresh root
cannot distinguish "never installed" from "uninstalled", so the reconcile would resurrect connectors
the user removed. Adoption copies what the user actually had.

## Security and migration invariants

- REQ-133's write policy stays the single choke point for a durable Office command. Adoption never
  writes a leaf the policy did not canonicalize and pass; re-anchoring rewrites only the server slot
  of a command that already matches the pinned template.
- No half state. Adoption probes the ledger for writability, writes the record, then writes the leaf;
  a failed leaf write rolls the record back. A connector is either fully adopted or absent.
- Cross-root reads only. The reconcile reads sibling roots and writes exclusively to the current root's
  `installs.json`, `alpha.jsonc`, and `ext-store/<key>/grants.json`.
- When an escape variable moves the MCP config target away from the environment root truth file
  (`ALPHA_LEGACY_INSTALL_ROOT`, `ALPHA_JSONC_TRUTH_DISABLE`) or the bundled server cannot be resolved,
  the reconcile does nothing and says so.
- `payloadDigest` is recorded at adoption time and, as before REQ-155, does not track later bundle
  updates. That is unchanged behaviour and is not part of this decision.

## Ownership and evidence

`alpha-office-instance.test.ts` seeds the measured on-disk shapes (prod root with four committed
records, stale bundle path, and grants; empty dev root) and asserts adoption, inventory activation for
all four cards, config leaf shape, ledger facts, grant copy, sibling immutability, idempotence,
disabled-state projection, latest-sibling precedence, template-drift refusal, corrupt-ledger refusal,
config-write rollback, and the boot ordering anchor. A no-op mutation of the reconcile turns 12 of the
18 cases red. The packaged channel-switch matrix belongs to the VERIFY child named on the parent.
