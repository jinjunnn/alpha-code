---
title: HostExtensionPackageV1 artifact index
kind: contract
status: active
owners:
  - alpha-code
last_reviewed: 2026-08-03
review_after: 2027-01-26
---

# HostExtensionPackageV1 artifact index

HostExtensionPackageV1 is the host-owned, fail-closed Phase 1 package envelope,
profile, capability, and strict-decoder contract.

The authoritative self-contained copy is
[`packages/ui-mac/src/shared/host-extension-package-contract/CONTRACT.md`](../../packages/ui-mac/src/shared/host-extension-package-contract/CONTRACT.md).
Its current aggregate artifact SHA-256 is
`11d6c02624abcbeb121f3c1c6ffc08314398948e6d006514416aef14fd62ca73`.

This value is republished prose, not a checked pin: nothing in the repository
compares it against
`host-extension-package-artifact.v1.json`. It was last correct at `284916c7`
(`#729`), went stale at `74af30d1` (`#749`, contract v2) and stayed stale until
`#807` — the whole time, every gate was green. Re-read it from the manifest
rather than trusting it.

The v1 host profiles are `agent`, `mcp-local`, `mcp-remote`, and `skill`; the
capability vocabulary is `alpha.connection.v1`, `alpha.mcp-oauth.v1`, and
`alpha.secret-prerequisite.v1`. `#807` briefly registered a fifth profile
(`opencode-plugin`) with two more capabilities (`engine:config`,
`engine:plugin`); ADR-040 rejected it and `#830` withdrew all three.

The `alpha-web#95` consumer pins an immutable `alpha-code` commit, the fixed
artifact path `packages/ui-mac/src/shared/host-extension-package-contract`, and
that aggregate SHA. It then verifies the manifest's exact paths, byte counts,
and per-file SHA-256 values before compiling packages.

## Producer artifact pin

The Desktop consumer separately pins the producer corpus published by
`jinjunnn/alpha-web` at commit
`9fcd83d66ea8f5b13081f434ace150e739a0536e`, path
`contracts/extension-package/artifact`, and aggregate SHA-256
`2a36d9cb8a0c7632eb6f4c9415d1e7b00acba55dc4f01004ce025c05834bf389`.
The artifact intentionally does not embed its containing Git commit. The
consumer lock supplies that commit and the vendor check must resolve and read
the exact Git object; an unavailable checkout or commit is a failure, not a
skipped provenance check.

Like the aggregate above, these three values are republished prose. Nothing
reads this file — every SHA comparison in the repository runs between the
manifest, the vendored bytes, and
`packages/alpha-contracts-consumer/alpha-web-extension-package.lock.json`. The
producer pin recorded here was last correct at `alpha-web@b7174810` and stayed
stale across `#759` (`alpha-web@6e0db57d`) with every gate green, exactly as the
host aggregate did. Re-read both from the lock and the manifest.

The byte lock is not a semantic oracle. Consumer tests additionally execute the
published declaration schema against the published negative vectors, and assert
the profile/capability closure as an exact set. Alpha Connection is a registered
capability — it was promoted in `#749` — and `cloud` remains excluded.

⚠️ **The vendored producer closure is one hop behind the host registry.** `#830`
withdrew `opencode-plugin` / `engine:config` / `engine:plugin` from the host
side above, but the producer artifact vendored here still publishes five
profiles and five capabilities, and still leaves `managed-plugin` out of the
exclusion list — `#807`/`#811` put it there and only an `alpha-web` republish
plus a re-vendor can take it back out. Until that hop lands, the consumer's
byte-identity check against the live host artifact is expected to fail; that is
the cross-repository pin being mid-flight, not a defect in either side.

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

## Beyond the first install

Update, uninstall, shared-child claims and the planning-time exact-digest
conflict gate are stated in
[`extension-package-lifecycle.md`](extension-package-lifecycle.md).
