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

Admission first copies untrusted input exactly once from own property
descriptors into prototype-free objects and arrays, then recursively freezes
that snapshot. It passes the frozen snapshot to the Effect Schema decoder only
for an accept/reject result and discards every object or array returned by the
decoder. Fingerprinting, evaluation, persistence, reply comparison, and event
payload construction use only the first snapshot or a prototype-free object
built from it. Accessors, sparse arrays, custom prototypes, symbols, host
objects such as `Date`, functions, `undefined`, non-finite numbers, negative
zero, non-canonical array properties, and cyclic values are rejected
fail-closed. Metadata is limited to 256 total enumerable entries, including
nested array elements, and 16 nested containers; either overflow is rejected
before admission.

The applicable schemas perform no accepted authorization-relevant conversion
that must be replayed after validation. Permission validation sets
`onExcessProperty: "error"`, so a Struct never accepts an input whose decoder
output would need unknown-key stripping. Branded IDs and fingerprints add
checks but do not change strings; literal unions, integer bounds, arrays, JSON
records, and struct fields only validate shape and values; optional keys remain
absent or retain their supplied value, with no default; and there is no type
coercion or normalization. Defaults and derived facts belong to the service,
not the decoder: an omitted `agent` selects the Session agent, an omitted
request `id` is generated only while constructing the final prototype-free
request, and the service supplies `subject` from the selected agent, Session
`scope`, and `expiresAt: null` before the prototype-free request-facts snapshot
is taken.

Service reads return detached response copies. Permission event data and its
event envelope, including `location`, metadata, and durable routing fields, are
instead deeply frozen so every sequential listener and stream consumer
observes the same facts and must clone before mutation.

### Prototype-boundary inventory

Every container-creation point on the permission path has one of two roles:
transport or output scratch that is never an authorization fact source (a), or
a permission-owned container whose prototype is removed before indexed or
named property assignment (b).

| Point | Classification and boundary |
| --- | --- |
| UI, SDK, generated-client request bodies, HTTP JSON parsing, protocol decoding, and handler DTO construction | (a) These are transport containers. Their object identity and decoder-produced containers are never admitted, fingerprinted, evaluated, or persisted directly. The Permission service reads only own data descriptors into its first `wireSnapshot`; that snapshot is the authorization boundary. JSON parsing itself defines own properties rather than invoking inherited assignment setters. |
| `Object.getOwnPropertyDescriptors`, individual descriptors, and `Reflect.ownKeys` arrays | (a) These native-created ordinary inspection containers are read-only scratch. Permission code never assigns authorization fields into them and never retains their identity; it accepts only checked own enumerable data descriptors and copies their primitive or recursively visited values into `wireSnapshot`. |
| `wireSnapshot` for create/assert and reply input | (b) Objects start as `Object.create(null)`. Arrays have their prototype removed before `length` or any index is assigned. The complete tree is frozen before schema validation. |
| Effect decoders for `AssertInput`, `ReplyInput`, internal `RequestFacts`, and DB-restored `Request` | (a) Decoders may create ordinary structs and arrays with normal assignments. Their output is validation scratch only and is discarded; rejection still fails closed. Strict excess-property rejection and the identity-only checks enumerated above mean no accepted decoder conversion must be replayed. |
| Internal request-fact and public-request construction | (b) Derived facts are copied through `wireSnapshot` before validation. The final request target is `Object.create(null)` before `id`, `fingerprint`, and the validated facts are assigned. |
| Fingerprint canonicalization | (b) Canonical object-key and merge-sort scratch stores are created with `Object.create(null)` before assignment. Canonical arrays must already be prototype-free; only primitive strings and numbers are accumulated. |
| Persistence insert envelopes and JSON serialization | (a) They are sinks populated from the frozen request/command facts after authorization checks, not a new source of authorization facts. Object-literal property creation does not invoke inherited assignment setters. |
| SQLite/Drizzle row envelopes and JSON deserialization | (a) Raw row and `JSON.parse` containers are transport scratch, not admitted facts. A restored request is first rebuilt and frozen by `wireSnapshot`, then schema-validated with decoder output discarded, and its row IDs and recomputed fingerprint must agree before it can re-enter pending authorization state. Persisted receipt columns are compared to the already-snapshotted reply command before a retry is accepted. |
| Receipt, saved-rule, batch, and event construction | (a) Their ordinary container identities are orchestration or output scratch, not authorization facts. Batch candidates retain references to already frozen requests and are independently re-evaluated from those request facts; saved-rule values are derived from the checked request and command. Event payload data is independently rebuilt through `wireSnapshot` and frozen, and the generic event envelope is frozen before listeners run. |
| `structuredClone` service/SDK response containers and client response decoding | (a) These are outward detached copies after authorization or replay selection. Mutating or setter-influencing them cannot change pending requests, fingerprints, persisted rows, or execution decisions. |

The fingerprint covers every request fact except `id`: Session, subject,
action, resources, scope, expiry, save candidates, metadata, and source.
Object keys are recursively sorted before hashing; array order is retained. A
purpose-built deterministic JSON serializer emits by string concatenation,
stores sortable keys only in prototype-free indexed objects, and uses a
deterministic O(n log n) merge sort. It visits array elements by checked own
indices and never invokes `toJSON`, an inherited array method, or another
value-controlled method. The hash is computed from the actual frozen
public-wire snapshot and is checked again immediately before a decision
commits. Request ID and fingerprint therefore form the immutable idempotency
identity.

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

Databases created before `permission_request` may contain receipts without a
matching admission row. Admission checks such a receipt before consulting
current rules and replays it only when its Session and stored fingerprint match
the current request exactly. Before returning the receipt it writes the missing
`permission_request` fact with the original prompted (`ask`) outcome. A receipt
whose fingerprint is missing, unusable, or different is not an exact replay:
admission returns `Conflict` and the caller must use a new request ID. A receipt
owned by another Session also conflicts without exposing its contents.

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

Create/admission retries against a receipt owned by another Session return
`Conflict`. Reply lookup for a receipt outside the supplied Session returns
`PermissionNotFoundError` rather than exposing that decision's contents.
