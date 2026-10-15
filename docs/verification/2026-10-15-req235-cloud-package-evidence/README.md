---
title: REQ-235 cloud package installation and production dispatch evidence
kind: verification
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-10-15
---

# REQ-235 E1: cloud HTML / image packages

Evidence for [alpha-code#1528](https://github.com/jinjunnn/alpha-code/issues/1528),
[alpha-work#114](https://github.com/jinjunnn/alpha-work/issues/114), baseline
[§2 / §3 / §4 E1 and W1-c](https://github.com/jinjunnn/alpha-code/blob/49dfbbe163dfee90b5b7d83f7560eeb7891fcb79/docs/design/2026-10-14-req235-cloud-capability-profile-baseline.md).
Documentation impact: evidence only; product code, contracts and publication state are unchanged.

## Inputs and installation

- Host: `alpha-code@026553ad0bbc52a1faf6a9205fd7a1898e36414c`, `packages/ui-mac` **0.1.20**.
- Declarations: `alpha-web@8458c49`, based on compiler commit `2b1e41be72f4aef9d0787de3597a1a851b609105`.
  Only `catalog-src/packages/package.cloud-{html,image}/1.0.0/{alpha-package.json,LICENSE.txt}` changed there.
- Declaration shape comes from alpha-web's actual `contracts/extension-package/artifact/input.cloud.valid.json`;
  license bytes come from `catalog-src/assets/skill.alpha-first/1.0.0/LICENSE.txt`.
- [prepare.ts](harness/prepare.ts) invokes the real `validate` and `preview` CLI. It serializes preview
  payloads with the producer's `canonicalJsonBytes`, checks the exact payloadRef length and SHA-256,
  and computes each package digest with the producer's `catalogRuntimeDigest`.
- The candidate-only catalog and payload bytes enter `runCatalogInstallWithPackagePreflight` via
  `loadVerifiedCatalog` / `installPackage` and the production coordinator's `installability.fetchPayload`.
  Production admission, authorization confirmation and `runExtensionTransaction` write real files in
  an isolated temporary global root. [install.json](results/install.json) captures that root, V3 ledger,
  both receipts, authorization previews and grants read back with production readers.
  The environment label is `dev` for this isolated local installation; cloud requests target production.
- Both receipts are `origin=catalog`, `desiredState=enabled`, transaction `committed`; both grants
  contain exactly `["cloud:dispatch"]`. Cloud installs have no asset files or engine configuration.

The snapshot digest used by dependency injection is the hash of the candidate wrapper, **not** a
published signed-channel snapshot. This is the baseline's pre-publication E1 seam. Signing, catalog
visibility and packaged application interaction are outside this evidence; W1-c must bind its final
emitted envelope to the recorded package digest through the existing publication gate.

## Live execution and negative controls

[live.ts](harness/live.ts) uses `https://alpha-cloud.tidelabs.click`; billing reads use the production
host constant `https://account.codepuppy.cn`. Credential identity is only `ak_EtFmJbPT`, expiry
`2026-10-16T03:39:57Z`. The harness reads the pointer file
`~/.claude/orchestration/alpha-platform/prod-test-account/keyfile-path.txt` at runtime. Its actual
format is `KEYFILE=~/…`; the code parses that format without evaluating shell. The key is used only
in Authorization headers, never passed to subprocesses or saved. Redirects and POST retries are disabled.

The positive envelope follows `cloud-form-box.tsx`'s `run()` byte ordering: fixed values first,
trimmed nonempty text fields next; `{autonomy:"pipeline",kind,input,constraints:{network:"restricted"}}`.
The production `guardCloudEnvelope` adds the schema, artifact policy and fresh idempotency key.
Request evidence includes the guarded envelope and prompt/idempotency-key SHA-256.

Input sources are the existing platform samples at
`alpha-platform@5fd4f03e509636d6cca17646407176d7e53ce138`:

- HTML: `packages/gateway/test/fixtures/document-generation-512/html/input.json`, the fictional
  松间咖啡 / 桂花燕麦拿铁 concept page prompt, copied verbatim.
- Image: `packages/gateway/test/fixtures/image-generation-508/harness.ts`'s request prompt,
  `A blue square`, copied verbatim. No provider response format is fabricated.

The payload negative flips exactly the final byte of the real compiled payload, preserving its
length and original payloadRef. Both attempts traverse the production installation entry point,
return `package-payload-integrity`, and leave no receipt/grant. See
[HTML](results/html-integrity.json) and [image](results/image-integrity.json).
The empty-prompt negative bypasses only the disabled UI button, still passes the guard, and reaches
the production jobs HTTP endpoint; its expected result is HTTP 400 `pipeline_input_invalid`.

Billing is read from actual `reservation_settled` and wallet debit facts, not from `holdUsd` or a
wallet balance difference. The public ledger omits job IDs: correlation requires a single new
reservation for the matching action after the pre-dispatch cursor, with serial execution. Ambiguous
reservations stop the harness. Usage/debt amounts are summed as CNY fen, separately from vendor USD.
The image job result also exposes `reservation_id`, which matches its ledger reservation directly.
It reports provider `openai`, model `gpt-image-2.5-flare`, input/output tokens 9/439; these are
server-reported observations. HTML exposes no corresponding usage fields. Neither card provides a
deployment commit or actual vendor USD cost, and this evidence makes no claim about those values.

## Run discipline and checks

The initial installation was prepared from the alpha-code worktree root:

```sh
bun docs/verification/2026-10-15-req235-cloud-package-evidence/harness/prepare.ts /Users/tide/app/alpha-web/.worktrees/270c-cloud-cards
```

The live harness is manual and **not in any gate**. The committed `live.ts` implements the
explicitly authorized continuation: GET the existing HTML job, then dispatch image only if it has
no saved acceptance. It exclusively creates `image-dispatch-started.json` before the paid POST;
a marker without acceptance stops a rerun. When acceptance exists, it resumes read-only against that
job and the original ledger cursor. Never remove either dispatch marker. Run with:

```sh
bun docs/verification/2026-10-15-req235-cloud-package-evidence/harness/live.ts
```

Observation uses 30-second waits, at most 15 minutes per card (image deadline remains anchored to
its original dispatch). HTML settlement still pending after that window does not prevent image.
A rejected dispatch or failed job stops paid work. Empty-prompt controls reach production and image's
control runs after artifact retrieval. The original HTML submission implementation remains in
commit `627399144d561477f24e63fb3ce761d054d6a80e`; it must not be rerun to dispatch HTML.

One local harness defect was observed before any key was read or any API call made: the initial
implementation treated `KEYFILE=~/…` as a bare path. It failed opening that path. The preserved
[record](results/credential-path-failure.json) reports **0 paid POSTs**. Parsing was corrected from
the actual handoff format before live execution; no paid job was retried.

Downloaded HTML is opened in Chromium with JavaScript disabled and network offline. The saved
[render](results/html-render.png) was visually checked: readable text, no visible clipping, and the
requested fictional coffee content. [Open check](results/html-open-check.json) records browser version
and rendered text. Artifact hashes are calculated from downloaded bytes, including when the server
descriptor itself reports `verification.status=unverified` and omits SHA-256.

Local checks: both declaration validations and previews passed; independent re-computation matched
both package digests and payload byte counts/hashes, and the downloaded HTML byte count/hash.
`git diff --check` passed. The documentation checker against these two worktrees reported 35 existing
`layout.role-alias` errors, all under `docs/evidence/2026-10-10-req229-230-visual/`; none concerns this
change. That protected, out-of-scope evidence was not modified. No alpha-web build was run.
The initial `gate run` attempt could not find `./bin/check`. The continuation brief clarified that
the repository gate is `bash scripts/alpha-check.sh` and explicitly exempts this docs-only branch
from the full gate. Only `git diff --check` and local Markdown link checks apply to this continuation;
no full gate pass is claimed.

## Observed outcome: both package-install pass/pass

| Card | Install / authorization | Paid dispatch | Terminal / artifact | Actual charged fen |
| --- | --- | --- | --- | --- |
| HTML | pass, `cloud:dispatch` | exactly one, `job_0493627afea0` | completed; HTML downloaded and opened | **95** |
| Image | pass, `cloud:dispatch` | exactly one, `job_ded0591ac3ea` | completed; PNG downloaded and opened | **20** |

Total actual settlement: **115 CNY fen**, charged to the approved alpha-platform#505 budget.
The continuation submitted only the image paid job; HTML was never resubmitted.

HTML: `text/html`, 4,566 bytes, SHA-256
`75ec886d8e073607e1caf31f56c84e37d2168c4f1ed390a64be785a24e6fdfa8`.
Its descriptor omits SHA-256; the value is calculated from the authenticated download.
[Settlement facts](results/html-followup-ledger.json) show wallet `usage_settled=-95` (seq 1568)
and `reservation_settled` (seq 1569) for `db89265d-e617-4cc5-ba05-6d7c7f87a406`.
The initial 1,500-fen hold was not the charge. The original finite timeout remains in
[failure.json](results/failure.json); it was superseded by this authorized read-only follow-up,
not hidden or treated as a permanent billing failure.

Image: `image/png`, 747,895 bytes, 1024×1024 RGB, SHA-256
`9ae48408b93d3a05fe8ab6afca49b68fb54d25475225959a536bb94633e9edaf`.
The download matches the server's byte count and hash. [Full decode](results/image-open-check.json)
passed; visual inspection of [the PNG](results/image-output.png) shows the requested blue square.
[Settlement facts](results/image-followup-ledger.json) show wallet `usage_settled=-20` (seq 1573)
and `reservation_settled` (seq 1574) for `533f70c4-09b7-47fa-99c8-ff9e99996a69`, also
reported in the job result.

The first image terminal events read threw an exception; arbitrary error details were deliberately
suppressed to avoid exposing request headers. [Interruption record](results/image-events-interruption.json)
and [initial statuses](results/image-initial-status.json) preserve the boundary. The harness resumed
from the saved acceptance with GETs only. Its bounded SSE reader then captured HTTP 200, replayed
completion events and no read error. Neither job's captured status/events/artifacts includes a final
charged-fen field; actual charges above come from the billing ledger. Raw views:
[HTML status](results/html-followup-status.json), [events](results/html-events.json),
[artifacts](results/html-followup-artifacts.json);
[image status](results/image-followup-status.json), [events](results/image-events.json),
[artifacts](results/image-followup-artifacts.json).

Both payload negatives returned `package-payload-integrity`. Both production empty-prompt requests
returned **400 `pipeline_input_invalid`**, detail `prompt / minChars`:
[HTML](results/html-empty-prompt.json), [image](results/image-empty-prompt.json).
The image negative ran after download. No frozen interface change was needed.

Continuation checks: `git diff --check` passed; all local Markdown links in this directory resolve
(0 existing failures, 0 newly introduced failures). No full gate was run, per the continuation brief.

## Runtime verification records (ready to copy)

The following two exact-version entries match [runtime-records.json](results/runtime-records.json)
and can be pasted into alpha-web's `catalog-src/intake/runtime-verification.json` object. This work
only supplies evidence; it does not write intake, curate, sign, promote or publish either card.

```json
{
  "package:cloud-html": {
    "version": "1.0.0",
    "digest": "febf20f52e0a06658bd06b18a94f7342597cbaa5ed5634e91889cf8e37bb5b41",
    "install": "pass",
    "use": "pass",
    "method": "package-install",
    "recordedAt": "2026-10-15",
    "key_id": "ak_EtFmJbPT",
    "receipt": {
      "id": "cloud:html",
      "transaction": "tx-mv99xr3f-ca9169ed",
      "desiredState": "enabled"
    },
    "authorization": [
      "cloud:dispatch"
    ],
    "job_id": "job_0493627afea0",
    "status": "completed",
    "dispatchedAt": "2026-10-15T08:28:12.891Z",
    "terminalObservedAt": "2026-10-15T08:29:46.463Z",
    "settlement": {
      "status": "settled",
      "charged_fen": 95,
      "reservation_id": "db89265d-e617-4cc5-ba05-6d7c7f87a406",
      "cursor": 1564,
      "seq": [
        1569,
        1568,
        1567,
        1566,
        1565
      ],
      "lastObservedAt": "2026-10-15T08:48:51.234Z",
      "correlation": "unique action reservation after pre-dispatch ledger cursor"
    },
    "artifacts": [
      {
        "id": "art_job_0493627afea0_0_5b05bdea",
        "mime": "text/html",
        "bytes": 4566,
        "sha256": "75ec886d8e073607e1caf31f56c84e37d2168c4f1ed390a64be785a24e6fdfa8",
        "downloadHttp": 200,
        "openCheck": "Chromium offline render and content check passed"
      }
    ],
    "negativeControls": {
      "payload": "package-payload-integrity",
      "emptyPromptHttp": 400,
      "emptyPromptCode": "pipeline_input_invalid"
    },
    "verifiedAt": "2026-10-15"
  },
  "package:cloud-image": {
    "version": "1.0.0",
    "digest": "55832e8fe38dd63c610822d5b8b18e345ba2de364daf4e74e86b9a8ebad2cf98",
    "install": "pass",
    "use": "pass",
    "method": "package-install",
    "recordedAt": "2026-10-15",
    "key_id": "ak_EtFmJbPT",
    "receipt": {
      "id": "cloud:image",
      "transaction": "tx-mv99xr5f-49dd3129",
      "desiredState": "enabled"
    },
    "authorization": [
      "cloud:dispatch"
    ],
    "job_id": "job_ded0591ac3ea",
    "status": "completed",
    "settlement": {
      "status": "settled",
      "charged_fen": 20,
      "reservation_id": "533f70c4-09b7-47fa-99c8-ff9e99996a69",
      "cursor": 1569,
      "seq": [
        1574,
        1573,
        1572,
        1571,
        1570
      ],
      "lastObservedAt": "2026-10-15T08:48:55.723Z",
      "correlation": "job result reservation_id matches unique action reservation after pre-dispatch ledger cursor",
      "jobResultReservationId": "533f70c4-09b7-47fa-99c8-ff9e99996a69"
    },
    "artifacts": [
      {
        "id": "art_job_ded0591ac3ea_0_12c4e619",
        "mime": "image/png",
        "bytes": 747895,
        "sha256": "9ae48408b93d3a05fe8ab6afca49b68fb54d25475225959a536bb94633e9edaf",
        "downloadHttp": 200,
        "openCheck": "Pillow full PNG decode 1024x1024 RGB passed; visual review shows a blue square"
      }
    ],
    "negativeControls": {
      "payload": "package-payload-integrity",
      "emptyPromptHttp": 400,
      "emptyPromptCode": "pipeline_input_invalid"
    },
    "dispatchedAt": "2026-10-15T08:46:59.825Z",
    "terminalObservedAt": "2026-10-15T08:47:37.030Z",
    "verifiedAt": "2026-10-15"
  }
}
```
