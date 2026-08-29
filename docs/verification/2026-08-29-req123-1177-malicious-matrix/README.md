# REQ-123 / alpha-code#1177 — malicious & boundary fixture matrix (real Chromium)

Verification evidence for **AC4** (extraction runs no macros / makes no network request /
loads no remote resource; out-of-bounds attempts blocked and observable) and **AC5** (large
/ deep / malformed / over-limit inputs give an honest degradation status — never blank,
faked, or a frozen UI). Parent requirement `#438`; scope from
`docs/design/2026-08-29-req123-office-extraction/baseline.md` § ④ (t4 exit conditions).

Base: worktree `verify-1177`, HEAD `18035c336` (the v0.1.5 release baseline). Nothing under
production code was changed; this ticket adds test + harness + evidence only.

## What is proven, and why real Chromium

The production runtime is **Electron 42.3.3 / Chromium 148**, not the `happy-dom` that
`bun test` preloads. The baseline records two facts that make grep / import-graph checks a
speed bump rather than proof:

1. renderer `fetch` is a global — an extractor can reach the network with **zero imports**,
   so "no `fetch` import" proves nothing about egress;
2. happy-dom and Chromium disagree on DOMParser entity behavior (happy-dom **rejects**
   internal entities, Chromium **expands** them), and — measured again this run — happy-dom
   reports `parsererror` on well-formed OOXML that Chromium parses cleanly. So any assertion
   that depends on real parsing / real network must run in Chromium.

Two independent, always-on network observers back the zero-egress verdict (`harness/main.cjs`):
a 127.0.0.1:38999 **sink** (records requests that actually land) and Chromium's
`session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] })` (records every attempted
outbound request, any scheme/host, success or not). A **positive control** — an explicit
`fetch` the probe issues last — must appear in **both** logs, which is what makes every zero
a true negative rather than a broken observer.

## Result 1 — AC4 zero egress (real Chromium)

`results/chromium-run.json` (identity: Electron 42.3.3, Chromium 148.0.7778.218). The
malicious corpus runs through the **actual** production chain
(`detectOoxmlContainer(bytes, { retainContentParts: true })` → `officeTextExtractionOf` /
`buildXlsxWorkbook` → `parseOoxmlContentPart` → DOMParser) — no re-implementation.

| Arm | Input | Observed |
| --- | --- | --- |
| `positive-control` | explicit `fetch(sink/positive-control)` | **sink HIT + webRequest HIT** — observer proven live |
| `production:xxe-file-entity` | docx whose `document.xml` has `<!ENTITY SYSTEM "file:///etc/passwd">` | extraction `failed / CONTENT_PART_FORBIDDEN_MARKUP`; **zero egress** |
| `production:xxe-http-entity` | external entity → `sink/xxe-http-entity` | `failed / CONTENT_PART_FORBIDDEN_MARKUP`; **zero egress** |
| `production:external-dtd` | `<!DOCTYPE … SYSTEM "sink/external-dtd">` | `failed / CONTENT_PART_FORBIDDEN_MARKUP`; **zero egress** |
| `production:url-in-text-and-rels` | URL in `w:t` text **and** a rels target = `sink/rels-external-target` (TargetMode=External) | **extracted** — URL rendered as inert text; rels target **never fetched**; **zero egress** |
| `production:xlsx-hostile-sheet` | worksheet part with external entity → `sink/xlsx-sheet-entity` | sheet degrades to `part-unreadable`; **zero egress** |
| `raw:raw-xxe-file` | gate **bypassed**, hostile XML straight to Chromium DOMParser | `parsererror:false`, text empty — Chromium does **not** read `file://` entity |
| `raw:raw-xxe-http` | gate bypassed | text empty — Chromium does **not** fetch http entity; **zero egress** |
| `raw:raw-external-dtd` | gate bypassed | parses, **zero egress** — Chromium does **not** fetch external DTD |
| `raw:raw-internal-entity` | gate bypassed, `<!ENTITY a "AAAAAAAAAA">` ×3 | **expands to 30 chars** — Chromium DOES expand internal entities (the billion-laughs vector the DOCTYPE gate exists to stop) |

**Observer totals:** `webRequestHits` = **2** (the `file://` page load + the positive
control). **None** of `xxe-http-entity`, `external-dtd`, `url-in-text`, `rels-external-target`,
`etc/passwd`, `xlsx-sheet-entity` appears in either observer. Verdict: **AC4 zero egress —
PASS**, positive control proven.

The `raw:` arms make the residual boundary a measured fact: even with the gate removed,
Chromium fetches no external entity/DTD, so the security boundary rests on **text-layer
DOCTYPE rejection (DoS) + only-text-nodes into the DOM + never following a rels target**, not
on defending external-entity file reads (which are structurally unreachable here). The
internal-entity arm shows why the DOCTYPE gate is load-bearing, not decorative.

## Result 2 — AC5 honest-failure matrix (six categories, real bytes)

`office-failure-matrix.test.ts` drives real malicious/boundary **bytes** through the same
presentation objects the workbench renders (`presentOfficeStructure` → office status card;
`officeTextExtractionOf` → pass-branch content / honest `[data-office-extract-failed]` card).
Each category is proven **red then discriminated**: a known-bad input produces the honest
failure surface, and a benign twin through the identical pipeline does not trip that surface.

| # | Category (ticket) | Real input | Layer | Code produced | Honest surface |
| --- | --- | --- | --- | --- | --- |
| 1 | 超预算容器 | >512 zip entries | container | `ZIP_ENTRY_LIMIT` | rejected card, category **safety-limit** |
| 2 | 损坏容器 | valid zip, deflate bytes flipped | container | `ZIP_DECOMPRESSION_FAILED` | rejected card, category **invalid-document** |
| 3 | 含 `<!DOCTYPE` | docx `document.xml` with DOCTYPE+ENTITY | content part | `CONTENT_PART_FORBIDDEN_MARKUP` | pass container, extraction **failed** card |
| 4 | UTF-16 DOCTYPE | genuine UTF-16LE `document.xml` bytes | content part | `CONTENT_PART_FORBIDDEN_MARKUP` (on the **decoded** string; byte-layer UTF-8 regex is asserted blind to it) | extraction **failed** card |
| 5 | 结构闸拒绝 | declared main part absent | container | `OOXML_MAIN_PART_MISSING` | rejected card, category **incomplete-structure** |
| 6 | 超 4 MiB 单 part | high-entropy `document.xml` > `maxPartParseBytes` | content part | `CONTENT_PART_PARSE_LIMIT` | extraction **failed** card |

All six honest cards keep Quick Look and gated external-open reachable, and never blank /
fake / freeze — asserted by the merged `office-preview.test.ts` (rejected + extract-failed
states expose the external-open + reveal buttons; `pass` + failed extraction still renders
the Quick Look button). Verdict: **AC5 — PASS**.

Two measured facts recorded here for the next lane (both cost time if unknown):
- category 6 needs **incompressible** filler — a `"x".repeat(...)` part trips the container
  ratio cap (`ZIP_DECLARED_RATIO_LIMIT`) long before the 4 MiB content cap;
- categories 3/4/6 rest on the **pre-DOMParser** text/byte gates, so bun is faithful; the
  "clean part extracts" GREEN is happy-dom-hostile and is owned by the Chromium harness
  (`production:url-in-text-and-rels` → `extracted`).

## Prove-it-can-go-red (mutation drills)

- **office-failure-matrix**: neutering `FORBIDDEN_MARKUP` in `ooxml-content.ts` (regex → a
  never-match) flips categories 3 and 4 **red** (`4 pass / 2 fail`); restored via
  `git checkout --` (git status was clean but for this ticket's new files first).
- **zero-egress observer**: the positive-control `fetch` lands in both the sink and
  webRequest logs — the observer catches a known hit before any zero is trusted.

## Reproduce

```bash
# from the worktree root
bun test packages/ui-mac/src/renderer/alpha-ui/artifact-workbench/renderers/office-failure-matrix.test.ts
bash docs/verification/2026-08-29-req123-1177-malicious-matrix/harness/run.sh \
  docs/verification/2026-08-29-req123-1177-malicious-matrix/results/chromium-run.json
```

`harness/run.sh` kills any stale probe listener on :38999 first, bundles `probe-entry.ts`
with the `@opencode-ai/app` vite plugin (the same one the merged office-preview test uses),
and runs it inside real Electron; the run records its own `identity` (electron/chrome
version + pid + bundle path) into the result JSON.
