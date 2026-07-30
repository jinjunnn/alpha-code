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
`c3c53e0580782884d441ed04064e31020949bef87ae01b4a0403f8576e3fd483`.

The `alpha-web#95` consumer pins an immutable `alpha-code` commit, the fixed
artifact path `packages/ui-mac/src/shared/host-extension-package-contract`, and
that aggregate SHA. It then verifies the manifest's exact paths, byte counts,
and per-file SHA-256 values before compiling packages.
