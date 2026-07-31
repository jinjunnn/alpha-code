---
title: HostExtensionPackageV1 artifact index
kind: contract
status: active
owners:
  - alpha-code
last_reviewed: 2026-07-30
review_after: 2027-01-26
---

# HostExtensionPackageV1 artifact index

HostExtensionPackageV1 is the host-owned, fail-closed Phase 1 package envelope,
profile, capability, and strict-decoder contract.

The authoritative self-contained copy is
[`packages/ui-mac/src/shared/host-extension-package-contract/CONTRACT.md`](../../packages/ui-mac/src/shared/host-extension-package-contract/CONTRACT.md).
Its current aggregate artifact SHA-256 is
`1ed320e4ccf455576b41d30f4fbba22b5cafb37563c56cee55e40b8c574ff2bb`.

The `alpha-web#95` consumer pins an immutable `alpha-code` commit, the fixed
artifact path `packages/ui-mac/src/shared/host-extension-package-contract`, and
that aggregate SHA. It then verifies the manifest's exact paths, byte counts,
and per-file SHA-256 values before compiling packages.

## Producer artifact pin

The Desktop consumer separately pins the producer corpus published by
`jinjunnn/alpha-web` at commit
`b71748103ce65f97e3e5c8ac03f08152a0a1456f`, path
`contracts/extension-package/artifact`, and aggregate SHA-256
`ae9f43cc2a7cf279ff06d2846ff45f39cbb0fdd2fd0c4c5d91718968692e4887`.
The artifact intentionally does not embed its containing Git commit. The
consumer lock supplies that commit and the vendor check must resolve and read
the exact Git object; an unavailable checkout or commit is a failure, not a
skipped provenance check.

The byte lock is not a semantic oracle. Consumer tests additionally execute the
published declaration schema against the published negative vectors, and assert
the Phase 1 profile/capability closure (four profiles, one capability, `cloud`
and Alpha Connection absent).

The **runtime host decoder** judgement is not in the consumer package — it cannot
import across packages. It is delegated to `packages/ui-mac/src/main/package-installability.test.ts`
(evaluator behaviour) and `packages/ui-mac/src/shared/host-extension-package-contract/package-envelope-v1.test.ts`
(decoder negatives). Note also that some producer-side rules — HTTPS and
credential rejection among them — are enforced by the alpha-web compiler
(`E_URL_HTTPS` / `E_URL_CREDENTIALS`) rather than by the published schema, so the
schema alone accepts those negative vectors.

## Desktop consumption

The signed Catalog may contain a sibling `packages[]` array of shallow
`AlphaPackageEnvelopeV1` values. A package prelude must decode to one bounded
`package:` identity and version, and identities must be unique. If a prelude
cannot be decoded safely, or two package roots have the same identity and
version, the candidate Catalog is rejected before it can replace the
last-known-good snapshot.

`evaluatePackageForHost()` in main is the single compatibility authority. It
orders work as:

1. bounded envelope/header and static profile/capability support;
2. exact payload byte count and SHA-256;
3. the selected strict profile decoder;
4. the host-owned secret prerequisite decoder;
5. a bounded renderer-safe projection.

An unsupported profile/version/capability returns before payload fetch,
payload decode, secret handling, planning, or disk work. Catalog startup
refresh, browse IPC, detail IPC, and package install preflight all use that
same evaluator. Install preflight reloads the verified Catalog and evaluates
the selected raw envelope again; a renderer-provided verdict, action, reason,
payload, or target has no accepted input field.

The Phase 1 renderer wire is exactly a `CatalogPackageViewV1`: a
`compatible | update-required | blocked` verdict; a main-owned action and
reason code; `ready | required-action` prerequisite status with bounded
summaries; and bounded presentation. Raw envelopes, payload references, URLs,
commands, header templates, secret values, and secret injection targets do
not cross the IPC boundary. Phase 1 has one required component, so the wire
does not reserve optional-child or Alpha Connection states.
