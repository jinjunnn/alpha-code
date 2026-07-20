---
title: Session permission contract
kind: contract
status: active
owners:
  - alpha-code
last_reviewed: 2026-07-20
review_after: 2027-01-16
---

# Session permission contract

This contract governs admission decisions for tools executing inside a Session.
It does not define or reuse the extension capability vocabulary or grant ledger
owned by REQ-212.

## Public DTOs

`PermissionV2.Request` is immutable after admission and exposes:

- `id` and a lowercase SHA-256 `fingerprint`;
- `sessionID` and `subject: { kind: "agent", id }` for the executing agent;
- the tool `action` and ordered string `resources`;
- `scope`, currently emitted as `{ kind: "session", sessionID }`;
- `expiresAt`, currently `null` because pending Session tool requests do not
  expire automatically; and
- optional `save`, `metadata`, and tool-call `source` facts.

Admission decodes those facts into JSON wire values, makes a service-owned
copy, and recursively freezes that copy before fingerprinting or evaluation.
`metadata` accepts only JSON primitives, arrays, and plain string-keyed JSON
objects; host objects such as `Date`, functions, `undefined`, symbols,
non-finite numbers, and cyclic values are rejected fail-closed. Events and all
service reads return detached copies rather than the internal snapshot.

The fingerprint covers every request fact except `id`: Session, subject,
action, resources, scope, expiry, save candidates, metadata, and source.
Object keys are recursively sorted before hashing; array order is retained.
The hash is computed from the actual frozen public-wire snapshot and is checked
again immediately before a decision commits. Request ID and fingerprint
therefore form the immutable idempotency identity.

`PermissionV2.DecisionCommand` contains `requestFingerprint`, `decisionID`,
`decision`, and optional correction `message`. It is a discriminated union:
`once` and `reject` forbid grant fields, while `always` requires both
`grantScope: { kind: "project", projectID }` and an explicit
`grantExpiresAt: null`. The current saved-rule engine supports only a permanent
grant for the active project; a different project or an `always` request
without `save` resources fails closed.

`PermissionV2.DecisionReceipt` contains the request and Session identities,
request fingerprint, decision ID and value, committed time, optional grant
facts, and `resolvedRequestIDs`. The receipt is the durable authority returned
by the reply endpoint.

The create endpoint returns one of three explicit states:

- `evaluated`: policy allowed or denied without prompting;
- `pending`: the full public request awaits a decision; or
- `decided`: an exact retry found the persisted receipt.

The reply endpoint returns `{ data: DecisionReceipt }`; it no longer returns an
empty 204 response.

## State machine and idempotency

```text
new request -> evaluated allow/deny
            -> pending -> committed receipt -> decided

same request ID + same fingerprint:
  evaluated -> original allow/deny outcome
  pending -> same pending request
  decided -> original receipt

same request ID + different fingerprint -> Conflict
```

An exact reply retry must match request fingerprint, decision ID, decision,
message, grant scope, and grant expiry. It returns the original receipt and
does not publish another reply event, write another saved rule, or settle the
tool twice. Reuse of either request ID or decision ID with different decision
facts returns `Conflict` and preserves the first committed fact.

`reject` settles only its target request. Other pending requests in the same
Session remain pending.

## Explicit `always` batch

An `always` decision atomically writes the project saved rule and resolves its
target. It then has one explicitly bounded batch: the snapshot of other pending
requests owned by the same Location service instance at commit time. Each
candidate is independently re-evaluated against its executing agent's
configured rules, existing saved rules, and the new saved rule. A configured
deny always wins. A candidate resolves only when every one of its resources is
now allowed.

Each resolved candidate receives its own generated decision ID and persisted
receipt; it does not reuse the user's reply or decision ID. The primary receipt
lists the request IDs actually resolved by that transaction. Requests outside
the Location snapshot, requests still requiring approval, configured denies,
missing Sessions, and unrelated actions/resources remain pending.

## Persistence and recovery

Every create result is admitted to `permission_request` before it is returned.
The row stores request ID, fingerprint, the immutable public request snapshot,
and the original `allow`, `deny`, or `ask` outcome. Exact retries therefore
replay evaluated outcomes even if policy changes, while reuse of an ID with a
different fingerprint conflicts.

Receipts live in `permission_decision`, with unique constraints on decision ID
and request ID. For `always`, the primary receipt, saved-rule inserts, derived
receipts, and the primary `resolvedRequestIDs` are one SQLite transaction. A
failed grant write therefore leaves no success receipt and keeps the request
pending.

A process crash before that transaction commits has no success fact and remains
fail-closed. After commit, rebuilding the Permission service reads the receipt;
an exact create/assert retry returns or applies the original decision without
repeating side effects. Pending ownership and waiting fibers remain
process-local; after rebuilding the service, an exact create retry rehydrates
the pending request from its durable admission fact before it can be replied
to. A reply without that re-admission remains not found and fail-closed.

## HTTP errors

| Status | Code                      | Meaning                                                                                 |
| ------ | ------------------------- | --------------------------------------------------------------------------------------- |
| 400    | `InvalidRequestError`     | The command does not satisfy the public schema.                                         |
| 404    | `SessionNotFoundError`    | The Session path does not resolve.                                                      |
| 404    | `PermissionNotFoundError` | Neither a pending request nor an accessible receipt matches the Session and request ID. |
| 409    | `ConflictError`           | A request ID or decision ID was reused with different immutable facts.                  |

Cross-Session receipt lookup is reported as not found rather than exposing the
existence of another Session's decision.
