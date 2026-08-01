---
title: Alpha Connection record lifetime
kind: architecture
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-31
review_after: 2027-01-27
---

# Alpha Connection record lifetime

## Why this document exists

A registered Alpha Connection is the first durable object in this app whose
lifetime belongs to none of the things that normally own durable state. Every
other record here dies with something: an `installs.json` entry dies with its
`(kind, name)`, and `<root>/ext-store/<key>/` is deleted wholesale by
`uninstallExtension`.

A connection cannot work that way, because the durable side effect it represents
is not local. It is consent recorded at a *provider*. Deleting a local file
neither revokes that consent nor tells the provider anything, so a host that
throws the record away has not "cleaned up" — it has forgotten a grant that is
still live, and the user's next install will be asked to authorise all over
again.

The rule below therefore has to be stated somewhere a refactor will trip over,
because the natural place to store this record is exactly the wrong one.

## The rule

**Connection records live outside the extension transaction root, and nothing
except an explicit user disconnect may remove one.**

| Fact | Where |
| --- | --- |
| Store location | `<userData>/alpha-connections/records.json` (0600, atomic whole-file write) |
| Independence guard | `assertAlphaConnectionStoreIndependenceV1` in `packages/ui-mac/src/main/alpha-connection-store.ts` |
| Only deletion path | `removeAlphaConnectionRecordV1`, reached only from the coordinator's `disconnect` |
| Uninstall behaviour | `releaseAlphaConnectionBindingsV1` — drops the component from `packageBindings`, keeps the record |

The guard refuses every read and write when the resolved store directory is
inside the extension root. That is not defensive decoration: a store under that
root is not "stored badly", it is *scheduled for deletion* by the next uninstall
of anything, and the failure would be silent and total.

`packageBindings` reaching zero means "no installed package needs this right
now". It is not a delete trigger, and it never becomes one — a user who wants
their provider access back gets it through the explicit disconnect action, which
is allowed even while packages are still bound. Those packages then report
unavailable rather than pretending to work.

## Handler ids are looked up, never parsed

`connectionHandlerId`'s grammar belongs to the package decoder
(`^[a-z][a-z0-9-]{0,63}$`, frozen in
`shared/host-extension-package-contract/decoder.ts`). Main's only permitted
operation on that string is an exact-key lookup in the static allowlist
`ALPHA_CONNECTION_HANDLERS_V1`. No prefix test, no namespace split, no "ids
shaped like this are ours".

This is the class documented in
[`host-extension-package-contract-boundary.md`](host-extension-package-contract-boundary.md):
one place decides what a token may look like, everyone downstream consumes that
decision. A second opinion about the same grammar is a second thing to drift.

An id that is not in the table is `update-required`, decided in the browse/detail
evaluator before any handler runs, any browser opens, or any store write happens.
The table is empty in the current build, so today every `alpha-connection`
package resolves that way — that is the shipped fail-closed default, not a stub.

## Handler output is untrusted input

A handler is App code, but it speaks to a third party, so what it returns is
decoded through an exact key allowlist
(`decodeAlphaConnectionResultV1`) before any of it reaches a record. Unknown keys
are refused rather than dropped: dropping would let a handler ship a credential
that this build happens not to persist and a later one does. The record can carry
a service id, an account label, a reuse key and an expiry, and there is no field
in it for a token.

## Evidence

`packages/ui-mac/src/main/package-alpha-connection.test.ts`, registered in
`scripts/gate-files.tsv`. It pins the production allowlist as an exact key set,
asserts the unknown-handler answer costs zero handler calls, drives the real
admission coordinator to prove a required connection that is not ready reaches
the transaction zero times, and asserts the shared boundary: releasing one
package's binding leaves the record `ready` and never calls `disconnect`.
