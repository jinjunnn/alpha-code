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
The public job/health responses do not promise actual route/model, provider usage or deployment commit;
this evidence does not substitute source constants or a health success for those observations.

## Run discipline and checks

Run from the alpha-code worktree root, with a fresh evidence directory:

```sh
bun docs/verification/2026-10-15-req235-cloud-package-evidence/harness/prepare.ts /Users/tide/app/alpha-web/.worktrees/270c-cloud-cards
bun docs/verification/2026-10-15-req235-cloud-package-evidence/harness/live.ts
```

These commands are manual and **not in any gate**. `prepare.ts` refuses an existing results directory;
`live.ts` exclusively creates `live-started.json` before any API call, and refuses a rerun. Do not
remove that marker to redispatch. Polling reads job state and settlement; it never resubmits a job.
Any rejection mismatch, failed job, missing artifact or missing settlement stops further paid work.

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
`gate run` was attempted on the clean committed alpha-code tree and could not start:
`FileNotFoundError: ./bin/check`; this worktree has neither that file nor a configured gate command.
No gate pass is claimed and no checker/configuration was added outside the permitted directory.

## Observed outcome: blocked on final settlement

| Card | Install | Paid dispatch | Terminal / artifact | Actual charged fen |
| --- | --- | --- | --- | --- |
| HTML | pass, `cloud:dispatch` | exactly one, `job_0493627afea0` | completed; HTML downloaded and opened | **unknown**, settlement not observed |
| Image | pass, `cloud:dispatch` | **not dispatched** | not run after HTML settlement timeout | no dispatch; no charge attributed |

HTML was submitted at `2026-10-15T08:28:12.891Z`, and observed completed at
`2026-10-15T08:29:46.463Z`. Artifact `art_job_0493627afea0_0_5b05bdea` is `text/html`,
4,566 bytes, SHA-256 `75ec886d8e073607e1caf31f56c84e37d2168c4f1ed390a64be785a24e6fdfa8`.
The server descriptor has no SHA-256; this is the hash of the authenticated download.

At the last ledger observation, `2026-10-15T08:34:39.125810Z`, reservation
`db89265d-e617-4cc5-ba05-6d7c7f87a406` still had only three `reservation_created` facts
(seq 1565–1567), including a **1,500-fen wallet hold**, and no settlement/debit facts.
The hold is not the actual charge. After 30 reads the harness exited 1 with
`settlement not observed; stop before next card`; [failure.json](results/failure.json)
records the observed stop. No further live work was performed. This finite observation does **not**
establish a permanent billing failure: the last read precedes the next nominal five-minute maintenance
boundary. A later read of the existing job/reservation is needed to determine final charges; do not
redispatch HTML to obtain them. Actual vendor cost/usage and deployed version were not exposed by the
captured public responses and are not claimed here.

Both package payload negatives returned `package-payload-integrity`. HTML's actual HTTP negative
returned **400 `pipeline_input_invalid`**, detail `prompt / minChars`; the image HTTP negative was
not reached. The two negative **classes** are demonstrated; no image HTTP result is fabricated.

## Runtime verification records (pending, not shelf admission evidence)

The JSON below and [runtime-records.json](results/runtime-records.json) contain the two exact-version
entries assembled from the saved observations. They may be copied as **pending** records; they are
**not** the requested `package-install` pass/pass proof, and the existing curation gate must reject
them. HTML's pending use verdict reflects missing final settlement, not a failed artifact download.

```json
{
  "package:cloud-html": {
    "version": "1.0.0",
    "digest": "febf20f52e0a06658bd06b18a94f7342597cbaa5ed5634e91889cf8e37bb5b41",
    "install": "pass",
    "use": "pending",
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
    "pending": "Job completed and artifact downloaded; final settlement not observed. Not package-install pass/pass.",
    "job_id": "job_0493627afea0",
    "status": "completed",
    "dispatchedAt": "2026-10-15T08:28:12.891Z",
    "terminalObservedAt": "2026-10-15T08:29:46.463Z",
    "settlement": {
      "status": "not-observed",
      "charged_fen": null,
      "reserved_fen": 1500,
      "reservation_id": "db89265d-e617-4cc5-ba05-6d7c7f87a406",
      "cursor": 1564,
      "lastObservedAt": "2026-10-15T08:34:39.125810+00:00",
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
    }
  },
  "package:cloud-image": {
    "version": "1.0.0",
    "digest": "55832e8fe38dd63c610822d5b8b18e345ba2de364daf4e74e86b9a8ebad2cf98",
    "install": "pass",
    "use": "pending",
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
    "pending": "Not dispatched: stopped after HTML settlement was not observed.",
    "job_id": null,
    "status": "not-dispatched",
    "settlement": {
      "status": "not-dispatched",
      "charged_fen": null
    },
    "artifacts": [],
    "negativeControls": {
      "payload": "package-payload-integrity",
      "emptyPromptHttp": null,
      "emptyPromptCode": "not-run"
    }
  }
}
```
