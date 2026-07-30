---
title: HostExtensionPackageV1 contract
kind: contract
status: active
owners:
  - alpha-code
last_reviewed: 2026-07-30
review_after: 2027-01-26
---

# HostExtensionPackageV1

This directory is the host-owned Phase 1 contract artifact for
`AlphaPackageEnvelopeV1`. A consumer pins the repository commit, artifact path,
and aggregate `artifactSha256`, then verifies the paths, byte counts, and
per-file SHA-256 values in
`host-extension-package-artifact.v1.json`.

## Envelope

`alpha-package-envelope-v1.schema.json` defines a bounded, shallow header.
Phase 1 packages contain exactly one component. The component has an empty
`dependencies` array and carries only identity, required/optional disposition,
profile gate data, compiler-derived capabilities, and a content-addressed
`payloadRef`.

`payloadRef` is exactly `{sha256, bytes, mediaType, url}`. `sha256` is 64
lowercase hexadecimal characters, `bytes` is the exact positive payload byte
count, `mediaType` must match the selected profile registry entry, and `url`
must be a canonical HTTPS URL without userinfo credentials: its bytes must
equal `new URL(url).href` exactly, including a lowercase hostname and the
trailing slash on a bare origin. Inline payload content is not a legal envelope
field. Canonicalization is the producer's responsibility (including the
`alpha-web#95` compiler); package authors should not see this transport
constraint.

The prelude is exactly `{packageId, version}`. Its canonical bytes are UTF-8
for the following JSON, with this fixed member order, no insignificant
whitespace, and one trailing LF:

```text
{"packageId":"<packageId>","version":"<version>"}\n
```

## Profiles and capabilities

`host-extension-package.registry.v1.json` is the static registry. The v1
Phase 1 profiles are exactly `agent`, `mcp-local`, `mcp-remote`, and `skill`,
all at profile version 1. Each registry entry binds a profile/version pair to
one strict payload schema and one media type.

The Phase 1 capability vocabulary contains exactly:

- `alpha.secret-prerequisite.v1`

Any profile or capability absent from this registry is blocked fail-closed.

The compiler, not an author declaration, derives component capabilities from
the strict payload behavior. The envelope package capability list must be the
sorted, unique union of component capabilities. Because Phase 1 has one
component, the package and component lists are byte-for-byte equal. Payload
decoding checks the same derivation rule again after fetching. `capabilities`
and each payload's `requiredSecrets` must be unique and sorted in byte order.

## Decoder order

`decoder.ts` performs header byte/depth/node/string/control-character and
prototype-key limits first, then strict envelope decoding, then static
profile/version/capability lookup. No payload bytes are requested by that pure
decoder.

`synthetic-decoder.ts` is the executable ordering corpus. It calls its injected
stages only in this order:

1. decode and limit the envelope header;
2. gate profile/version and every capability;
3. fetch and verify exact payload bytes and SHA-256;
4. dispatch the selected strict payload decoder;
5. invoke the required synthetic secret stage;
6. invoke the synthetic planner.

An unsupported required component is `blocked`; an unsupported optional
component is exactly `skipped`. Header or support failure returns before every
injected payload, secret, or planner stage.

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
policy, Bundle semantics, or managed OpenCode Plugin profile.
