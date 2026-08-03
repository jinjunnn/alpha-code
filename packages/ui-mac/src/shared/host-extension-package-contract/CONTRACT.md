---
title: HostExtensionPackageV1 contract
kind: contract
status: active
owners:
  - alpha-code
last_reviewed: 2026-08-03
review_after: 2027-01-26
---

# HostExtensionPackageV1

This directory is the host-owned contract artifact for
`AlphaPackageEnvelopeV1`. A consumer pins the repository commit, artifact path,
and aggregate `artifactSha256`, then verifies the paths, byte counts, and
per-file SHA-256 values in
`host-extension-package-artifact.v1.json`.

## Envelope

`alpha-package-envelope-v1.schema.json` defines a bounded, shallow header. A
package carries `1..16` components and names exactly one of them in the
required `root` field. Each component carries only identity, required/optional
disposition, its dependency list, profile gate data, compiler-derived
capabilities, and a content-addressed `payloadRef`.

`payloadRef` is exactly `{sha256, bytes, mediaType, url}`. `sha256` is 64
lowercase hexadecimal characters, `bytes` is the exact positive payload byte
count, `mediaType` must match the selected profile registry entry, and `url`
must be a canonical HTTPS URL without userinfo credentials: its bytes must
equal `new URL(url).href` exactly, including a lowercase hostname and the
trailing slash on a bare origin. Inline payload content is not a legal envelope
field. Canonicalization is the producer's responsibility (including the
alpha-web compiler); package authors should not see this transport constraint.

The prelude is exactly `{packageId, version}`. Its canonical bytes are UTF-8
for the following JSON, with this fixed member order, no insignificant
whitespace, and one trailing LF:

```text
{"packageId":"<packageId>","version":"<version>"}\n
```

## Component graph

A legal graph is stated as an equality, not as a traversal, so there is no
"one more traversal rule" to patch later. All four conditions must hold:

1. `root` names a component of this envelope, and that component is `required`;
2. the root's `dependencies` are exactly the set of every non-root component
   id — no duplicate, no omission, no id from outside the envelope, and no
   self-reference;
3. every non-root component declares an empty `dependencies` array;
4. component ids are globally unique.

Together these already imply acyclic, depth 1, no orphan, and exactly one root.
An envelope that omits a non-root id from the root's dependencies declares an
orphan and is refused, even though every other property holds.

## Profiles and capabilities

`host-extension-package.registry.v1.json` is the static registry: profiles,
capability vocabulary, and every numeric limit the decoder enforces. The v1
profiles are exactly `agent`, `mcp-local`, `mcp-remote`, `opencode-plugin`, and
`skill`, all at profile version 1. Each registry entry binds a profile/version
pair to one strict payload schema and one media type.

The capability vocabulary contains exactly:

- `alpha.connection.v1`
- `alpha.mcp-oauth.v1`
- `alpha.secret-prerequisite.v1`
- `engine:config`
- `engine:plugin`

A capability token is honoured because it appears in this registry, never
because of how it is spelled: there is no namespace rule, and the decoder's
token grammar is a length/character bound rather than an admission gate. The
last two tokens are therefore not new words invented for packages — they are the
spellings the desktop authorization surface already uses for a sideloaded
plugin, promoted unchanged so that a managed package discloses the same two
facts as the legacy path for the same effect.

The compiler, not an author declaration, derives component capabilities from
the strict payload behavior. Payload decoding checks the same derivation rule
again after fetching. `capabilities` and each payload's `requiredSecrets` must
be unique and sorted in byte order.

`envelope.capabilities` is the sorted, unique union over **every** component,
skipped ones included: it is the producer's signed fact and does not depend on
what this host happens to support. It can therefore legitimately contain a
token this host does not know, which is why it is not narrowed to the
vocabulary above.

## Remote MCP authorization

`profiles/mcp-remote.v1.schema.json` freezes the whole authorization payload
shape, not just a capability token. `behavior.auth` is a discriminated union,
not a string enum: either the literal `"none"`, or an object whose `kind`
selects the arm and whose own `required` list names every field that arm needs.
Each arm refuses unknown properties, so there is exactly one legal spelling per
kind.

| `auth` | required fields | optional | derived capability |
| --- | --- | --- | --- |
| `"none"` | — | — | — |
| `{kind: "mcp-oauth"}` | `prerequisiteId`, `required` | `label` | `alpha.mcp-oauth.v1` |
| `{kind: "alpha-connection"}` | `prerequisiteId`, `required`, `connectionHandlerId` | `label` | `alpha.connection.v1` |

`prerequisiteId` and `connectionHandlerId` both match `^[a-z][a-z0-9-]{0,63}$`.

Five cross-field invariants belong to the decoder, and main must not restate
them:

1. `alpha-connection` requires `connectionHandlerId` (enforced by the schema).
2. `mcp-oauth` forbids an `Authorization` entry in `headersTemplate`,
   case-insensitively. Token injection belongs to the engine's token store, so a
   publisher shipping its own `Authorization` template is routing around it —
   and because HTTP header names are case-insensitive, `authorization` is the
   same bypass spelled differently.
3. Within one component, the authorization `prerequisiteId` may not collide with
   a `requiredSecrets` entry after folding case and `_`/`-`. Two prerequisites
   that render as the same row in the approval list are not distinguishable to
   the person approving them.
4. Every `{VAR}` placeholder in `headersTemplate` must appear in
   `requiredSecrets`, for all three auth kinds alike. A name that cannot be
   spelled in `requiredSecrets` therefore cannot be declared at all, so this one
   rule also refuses a malformed placeholder — there is no parallel grammar rule
   for placeholders, and main does not restate either.
5. A non-`none` `auth` does **not** exempt `requiredSecrets`. OAuth plus an
   extra API key is legitimate, and both prerequisites are collected.

`connectionHandlerId`'s grammar lives in the decoder and nowhere else. Main is
only ever allowed to look a finished id up in a static allowlist — never to
re-derive meaning from its prefix, segments, or namespace.

`mcp-local` has no `auth` field: a local subprocess has no OAuth semantics.

## Managed OpenCode Plugin

`profiles/opencode-plugin.v1.schema.json` carries exactly one thing: a
content-addressed script asset, `{sha256, bytes, mediaType, url}` with
`mediaType` fixed to `text/javascript` and `bytes` bounded by the registry's own
`maxScriptAssetBytes`. There is no install target, no argv, and no environment
in the payload — where the bytes land and how the engine is pointed at them are
host decisions, not producer declarations.

`mediaType` is a discriminant, not a label. Widening it to a free string would
not add script support; it would give the host two meanings for
`text/markdown`, and the markdown asset path already has host-side parsers bound
to that one meaning.

The derived capability set for this profile is unconditionally
`engine:config` **and** `engine:plugin`, because both facts are unconditionally
true: the engine evaluates the shipped JavaScript in its own process, and the
host has to write an engine configuration entry pointing at it. Deriving only
the first would tell the person approving the install less than a sideloaded
plugin already tells them.

**Stated limitation.** The three properties in *Decoder order* below —
fail-closed routing, loud stubs, and parser staleness — do not extend to script
assets. A markdown asset has host-side parsers that a staleness gate can watch;
a script asset has no host-side parser at all, because the host never
interprets those bytes. This contract does not invent one, and no gate here
should be read as claiming otherwise.

## Decoder order

`decoder.ts` performs header byte/depth/node/string/control-character and
prototype-key limits first, then strict envelope decoding, then the component
graph, then static per-component profile/version/capability/media-type lookup.
No payload bytes are requested by that pure decoder.

An unsupported **required** component blocks the whole package. An unsupported
**optional** component is `skipped`, with exactly one reason token from:

- `component-profile-unsupported`
- `component-capability-unsupported`
- `component-media-type-mismatch`

Because the root must be `required`, an unsupported root is always a blocked
package and never a skipped component. A skipped component reaches no payload
fetch, no payload decoder, no secret stage, and no planner — this is executable
in `synthetic-decoder.ts` through the caller's own call counters, not asserted
in prose.

`synthetic-decoder.ts` is the executable ordering corpus. Per supported
component — the root first, then each supported leaf in envelope order — it
calls its injected stages only in this order:

1. decode and limit the envelope header, the graph, and every component's
   profile/version/capability;
2. fetch and verify exact payload bytes and SHA-256;
3. dispatch the selected strict payload decoder;
4. invoke the required synthetic secret stage;
5. invoke the synthetic planner.

Header or support failure returns before every injected payload, secret, or
planner stage.

## Artifact generation

Run from this directory:

```sh
bun generate-artifact.ts
bun generate-artifact.ts --check
```

The first command regenerates the canonical decoder corpus and artifact
manifest. `--check` performs no writes and fails when either generated file or
any published file path/hash has drifted. Generated JSON bytes recursively sort
object keys by UTF-8 byte order, use two-space indentation and LF line endings,
and end with exactly one LF. `artifactSha256` is SHA-256 over the canonical JSON
bytes of `{artifactPath, files}` and therefore has no self-hash.

## Exclusions

This artifact contains no production Catalog wiring, Electron/IPC code,
network or disk implementation, legacy projection/oracle, same-ID shadow
policy, nested (depth > 1) graphs, or version solving. It defines the
`opencode-plugin` profile's *shape* only: asset retrieval, the install
transaction, the engine wrapper, and uninstall live in the host and are not part
of this artifact.
