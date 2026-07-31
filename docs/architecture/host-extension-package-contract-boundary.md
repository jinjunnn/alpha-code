---
title: Host extension package contract boundary
kind: architecture
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-31
review_after: 2027-01-27
---

# Host extension package contract boundary

## Authority and scope

`packages/ui-mac/src/shared/host-extension-package-contract/decoder.ts` is the
runtime authority for `HostExtensionPackageV1`. Host code may consume that
decoder's result or reject an input without interpreting it. It must not copy
the package grammar into a second decoder.

This inventory covers Electron host decisions reached from a signed Catalog
package. The JSON Schemas, registry, decoder corpus, artifact manifest, and
vendored producer pin are contract artifacts rather than host-side shadows.
Legacy catalog, manifest, curation, seed, transaction, receipt, filesystem, and
secret-store formats remain separate authorities even where their token
languages happen to look identical.

## Reproducible discovery

The inventory was taken at base `bbff1ea8` with four independent axes:

1. raw-byte searches for length fragments such as `{0,31}`, `{0,63}`, and
   `{0,127}`;
2. symbol searches for `SAFE_*`, `*_RE`, and `MAX_*` declarations and uses;
3. consumption searches for the decoder's four decision functions:
   `canonicalPackagePreludeBytesV1`, `decodePackageEnvelopeHeaderV1`,
   `decodePackageProfilePayloadV1`, and `derivePayloadCapabilitiesV1`;
4. refusal-text searches for `invalid packageId/version binding`,
   `cannot be installed safely`, and
   `cannot be represented by the existing MCP secret store`.

The byte axis matters. A normal text-mode search reports the 15 files described
in the original incident, while `rg -a` reports two more production files:
`alpha-builtin-policy.ts` and `ext-manifest-v2.ts`. Both files contain NUL bytes
outside the name rule, so a text-mode tool may classify them as binary and
silently omit them. The literal axis also finds two unnamed copies:
`ext-config.ts:1125` and `ext-ipc.ts:667`; a file-level comparison against named
constants exposes only the latter because `ext-config.ts` also has a named
copy.

## Direct package decision inventory

| Host location at `bbff1ea8` | Rule being repeated | Drift | Direction | Disposition |
| --- | --- | --- | --- | --- |
| `src/main/package-installability.ts:20-25,367-386` | Envelope prelude exact keys, package ID, version, and control-character grammar from `decoder.ts:94-95,112-113,120,283-300` | Yes | Host package ID accepts only `package:*`; the contract accepts any valid namespace | Consume `decodePackageEnvelopeHeaderV1`; delete the local prelude decoder |
| `src/main/package-installability.ts:26,424-444` | Registry `maxPayloadBytes = 1048576` | No at this revision | Same value, but independently mutable | Use the registry value for the declared and actual response-byte bound |
| `src/main/package-installability.ts:231,250,396` | Renderer `catalogId` and package-channel routing are treated as though they were a package ID to decode | Yes | Same hard-coded `package:*` narrowing sends other contract namespaces to the legacy planner | Route on the package admission protocol's `attemptId`; correlate the string with decoder-produced package identities |
| `src/main/package-admission.ts:51,627-638` | Renderer `catalogId` is treated as though it were a package ID to decode | Yes | Same hard-coded `package:*` narrowing | Stop interpreting it; correlate the string with decoder-produced package identities |
| `src/shared/package-secret-prerequisite.ts:72,105,131,277-286` | Payload `requiredSecrets` name and sort grammar from `decoder.ts:117,514-519,546-550,607-623` | No at this revision | Equal duplicate | Consume the already decoded payload; delete the repeated grammar check |
| `src/shared/package-secret-prerequisite.ts:103-107,129-154` | Payload/profile and derived-capability agreement from `decodePackageProfilePayloadV1` | No at this revision | Equal duplicate | Consume the decoded discriminant and derived capability decision; retain only secret-projection semantics absent from the package decoder |
| `src/main/package-admission.ts:54,293-299` | No package rule: component suffix must fit existing skill/agent/config/transaction names | Yes relative to the package grammar | Host representation is narrower: 64 characters versus the package suffix's 128 | Keep as a host constraint, but decide installability before exposing an enabled action |
| `src/shared/package-secret-prerequisite.ts:71,95-128` | No package rule: MCP component suffix becomes an existing secret-store server directory | Yes relative to the package grammar | Host representation is narrower: 64 characters versus the package suffix's 128 | Keep as a secret-store constraint; it applies even when `requiredSecrets` is empty |
| `src/main/package-admission.ts:56,618-624` | Markdown asset decoder's 5 MiB declared limit | No at this revision | Same number, different observation | Retain the actual HTTP response allocation bound as a host I/O constraint; the signed ref was already decoded |

The remaining schema-string branches in admission and prerequisite projection
consume decoded discriminants; they do not parse an unknown package shape.
Package/legacy routing consumes the package admission protocol's `attemptId`
marker, not a package-ID prefix.

## The 64-character lookalike class

The raw-byte axis finds the same base token language in 17 production files.
Sixteen instances govern extension names or an extension name embedded in an
asset key. They are one host-owned representation rule and should consume one
host predicate. `alpha-automations.ts` governs a persisted automation task ID;
it is a separate constraint that merely has the same current spelling and must
not be coupled to extension naming.

| Location at `bbff1ea8` | Observed input/use | Package-contract shadow? | Disposition |
| --- | --- | --- | --- |
| `src/main/alpha-bridge.ts:28` | bridged extension name | No; local extension representation | Consume the host extension-name predicate |
| `src/main/alpha-builtin-policy.ts:68` | governed built-in agent/skill name | No; local extension representation | Consume the host extension-name predicate |
| `src/main/alpha-installs.ts:21` | installed extension receipt name | No; local extension representation | Consume the host extension-name predicate |
| `src/main/alpha-mcp-secrets.ts:18` | MCP server directory | No; secret-store/filesystem constraint | Consume the host extension-name predicate |
| `src/main/alpha-migrate.ts:19,197` | migrated extension name and `skills/<name>` asset key | No; migration/filesystem constraint | Consume the host predicate for the name segment |
| `src/main/ext-agent-install.ts:36` | agent install/config name | No; local extension representation | Consume the host extension-name predicate |
| `src/main/ext-config.ts:44,1125` | MCP/agent/provider/plugin config key | No; local config representation | Consume the host extension-name predicate, including the inline plugin check |
| `src/main/ext-fs-installer.ts:32,271-273` | extension name and skill/agent/plugin asset keys | No; filesystem and packaged-asset representation | Consume the host predicate for each name segment |
| `src/main/ext-import-validate.ts:5` | imported skill/plugin declared name | No; import/filesystem representation | Consume the host extension-name predicate |
| `src/main/ext-install-planner.ts:281` | planned extension name | No; planner/transaction representation | Consume the host extension-name predicate |
| `src/main/ext-ipc.ts:667` | generated skill name | No; IPC to filesystem representation | Consume the host extension-name predicate; this is the unnamed copy missed by the symbol axis |
| `src/main/ext-manifest-v2.ts:76` | legacy extension manifest name | No; legacy manifest contract | Consume the host extension-name predicate |
| `src/main/ext-receipt-v2.ts:82` | extension receipt name | No; receipt contract | Consume the host extension-name predicate |
| `src/main/ext-skill-generations.ts:36` | skill generation name | No; generation-store representation | Consume the host extension-name predicate |
| `src/main/package-admission.ts:54` | decoded component suffix before local install | No; local extension representation | Move the decision to installability and consume the host predicate there |
| `src/shared/package-secret-prerequisite.ts:71` | decoded MCP suffix before secret-store projection | No; secret-store/filesystem constraint | Consume the host extension-name predicate while preserving the MCP-specific observable refusal |
| `src/main/alpha-automations.ts:14` | persisted automation task ID | No; automation storage contract | Keep independent; equal syntax is not shared authority |

## Observed behavior and reachability

The base behavior was executed, not inferred:

- With `packageId = "skill:demo-package"`, the contract decoder returns
  `ok=true, status=accepted`; `evaluatePackageForHost` returns
  `catalogId=package:invalid, verdict=blocked`.
- With a 65-character component suffix, contract decoding accepts all four
  profiles. Installability returns `compatible, enabled=true` for `skill` and
  `agent`, but `blocked, enabled=false` for `mcp-local` even when
  `requiredSecrets=[]`.

These inputs are not reachable through the current first-party producer:
`alpha-web` currently requires a `package:` package ID and caps component IDs at
64 characters. This is therefore a gate-quality defect, not a known production
incident. Phase 3 local import bypasses that producer, which is why the host
boundary must be sound before that path exists.

## Executable evidence

The current claims are enforced by behavioral cases in:

- `src/shared/host-extension-package-contract/package-envelope-v1.test.ts` for
  the authoritative accepted/rejected grammar;
- `src/main/package-installability.test.ts` for contract-to-host agreement,
  namespace-independent package routing, installability-stage skill/agent
  refusal, and the MCP secret-store refusal;
- `src/main/package-installability.wiring.test.ts` for the executable
  package-intent-to-host-consumer map and verified-Catalog re-evaluation;
- `src/main/package-admission.test.ts` for the decoded package identity reaching
  the real coordinator without a second package-ID grammar;
- `src/main/catalog-channels.test.ts` for rejecting a contract-invalid prelude
  before publishing either a new candidate or a historical LKG;
- `src/shared/package-secret-prerequisite.test.ts` for MCP projection behavior;
- `src/main/ext-import-validate.test.ts` for the shared host extension-name
  predicate's positive and negative boundary.

The cases execute production functions and assert observable results. A type
alias or compile-only exhaustiveness check is not treated as a security gate.
