---
title: REQ-106 unsigned Windows manual-download baseline
kind: design
status: accepted
owners:
  - alpha-code maintainers
last_reviewed: 2026-09-29
review_after: 2026-12-29
---

# REQ-106: unsigned Windows manual-download baseline

## Ground truth

The Windows GitHub Actions workflow builds an x64 NSIS installer on a Windows
runner and records Authenticode facts from the final `.exe`. It intentionally
produces an unsigned artifact while no publisher certificate is configured.
The release-manifest producer currently refuses that artifact for `beta` and
`prod`, and requires an updater feed for every platform. The web consumer only
redirects to artifacts named by a verified Ed25519-signed manifest; it has no
Windows installer presentation today.

The trust boundary is therefore split deliberately:

- Authenticode identifies the Windows executable publisher to Windows.
- The release-manifest signature identifies the release metadata producer and
  binds the filename, exact size, and digests to the final GitHub Release file.
- Neither control substitutes for the other. A signed manifest must never be
  presented as an Authenticode-signed executable.

## Decision

For REQ-106 only, a `prod` manifest may carry a Windows x64 installer whose
`manualDownloadOnly` flag is `true` and whose Authenticode facts are exactly
`signed:false`, `status:"NotSigned"`, `publisher:null`, and `thumbprint:null`.
The producer accepts that shape only when its explicit
`allowUnsignedWindowsManualDownload` policy input is true. The artifact stays
in the normal signed manifest, retains size and digest binding, and is uploaded
to the same GitHub Release as the macOS release.

A manual-only artifact has no Windows updater feed. This keeps it out of
electron-updater and makes the exception observable to the consumer instead of
silently turning an unsigned executable into a normal update candidate.

## Rejected alternatives

1. Upload the `.exe` without a manifest: rejected because the website would
   have to invent a URL and loses the existing verification boundary.
2. Add it to `latest.yml`: rejected because automatic update is a materially
   stronger distribution promise than the authorized manual-download exception.
3. Mark the package as signed or add a placeholder publisher: rejected because
   it would make a false security claim.
4. Change the normal `beta`/`prod` Authenticode gate globally: rejected because
   the exception must be narrow, explicit, and mechanically detectable.

## Security invariants

- The manifest and detached signature remain mandatory and are verified by the
  website before any Windows link is rendered.
- Only a Windows x64 installer may use `manualDownloadOnly`; malformed facts,
  non-`prod` use, or a missing explicit policy input fail the producer.
- The website displays the unsigned status before the user can download and
  does not claim Authenticode, SmartScreen reputation, or automatic updates.
- macOS installer, notarization, and updater behavior are unchanged.

## Implementation cut

- `alpha-code#1468`: producer policy, CLI opt-in, manifest invariant tests,
  contract/runbook/changelog, and the v0.1.17 release assets.
- `alpha-web#251`: manifest consumer, fail-closed Windows redirect, download
  presentation/warning, contract/tests, and deployment.
- `alpha-code#1469`: package, manifest, GitHub asset, public-route, and macOS
  regression verification after both implementation changes are live.

## Pre-development consultation

The release is intentionally limited to a manifest-verified manual download.
Keeping the existing manifest signature and digest binding while withholding an
updater feed is the smallest design that makes the unsigned status honest
without creating an unverified alternate distribution path.
