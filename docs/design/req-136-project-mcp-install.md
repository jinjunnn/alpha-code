---
title: REQ-136 project-scoped catalog MCP installation
kind: design
status: accepted
owners:
  - alpha-code product and security maintainers
last_reviewed: 2026-08-17
review_after: 2027-02-13
---

# REQ-136 project-scoped catalog MCP installation

Parent requirement: [jinjunnn/alpha-code#1013](https://github.com/jinjunnn/alpha-code/issues/1013).
Decision child: [jinjunnn/alpha-code#1014](https://github.com/jinjunnn/alpha-code/issues/1014).
This decision is pinned to `ab6c851bedb0dbf83fd9346cd91f8725217b8fb4`. It specifies the
solution boundary only; until the CODE children land, the checkout's broad project-install refusal
remains runtime truth.

## ① Ground truth

| Surface | Fact in this checkout |
| --- | --- |
| Intent and current admission | `InstallScope` already carries either global or an absolute `projectDir`, and the strict decoder preserves that wire shape (`packages/ui-mac/src/main/ext-install-planner.ts:178-198`, `packages/ui-mac/src/main/ext-install-planner.ts:283-294`). The authoritative `installCatalog` guard nevertheless rejects every project intent immediately after decode and before catalog or seed resolution (`packages/ui-mac/src/main/ext-install-planner.ts:1115-1125`). The renderer removes `scope` from its local catalog-install type and writes global at the MCP and common catalog exits (`packages/ui-mac/src/renderer/extensions/use-extensions.ts:111-124`, `packages/ui-mac/src/renderer/extensions/use-extensions.ts:451-456`, `packages/ui-mac/src/renderer/extensions/use-extensions.ts:890-907`). |
| Project root and discovery | Main's canonical project root is `<project>/.alpha`, with identity revalidation available for the write boundary (`packages/ui-mac/src/main/alpha-workdir.ts:88-99`). The extension plugin already receives the instance directory, reads `<directory>/.alpha/alpha.jsonc`, and merges it for that instance (`packages/opencode/src/plugin/index.ts:155-161`, `packages/ext/src/plugin.ts:101-125`). `alpha_register` calls `applyRegister` and atomically replaces that same file, so there is no second project-config filename to invent (`packages/ext/src/register.ts:28-66`, `packages/ext/src/plugin.ts:244-269`). |
| Consent, merge, and activation | Project MCP discovery is executable-code gated: absent, malformed, or non-granted `extensionsConsent` is false (`packages/ext/src/plugin.ts:109-128`, `packages/ext/src/plugin.ts:378-393`). The explicit native prompt writes the decision only after user acknowledgement (`packages/ui-mac/src/main/ext-ipc.ts:483-523`). When consent exists, `mergeNamed` adds project names only when the effective config does not already contain that name, so any pre-existing entry wins (`packages/ext/src/project-config.ts:135-142`, `packages/ext/src/project-config.ts:174-185`; regression evidence at `packages/ext/src/project-config.test.ts:22-27`). Its result currently reports only added or gated domains, not the collided names (`packages/ext/src/project-config.ts:110-115`, `packages/ext/src/project-config.ts:169-185`), while the activation helper reads MCP status by name and has no scope/provenance check (`packages/ui-mac/src/main/ext-mcp-activation.ts:26-69`). |
| Catalog MCP transaction | Once scope has resolved, the ordinary MCP planner already derives `mcpRoot` from that scope, targets `<mcpRoot>/alpha.jsonc`, records the receipt in that root, creates one `action: "config"` item, and gives it no staged payload (`packages/ui-mac/src/main/ext-install-planner.ts:1289-1331`, `packages/ui-mac/src/main/ext-install-planner.ts:1358-1363`). Config targets are confined to the transaction root (`packages/ui-mac/src/main/ext-transaction.ts:646-678`). A non-generation journal item receives placeholder `gen-000000-000000` and `files: item.files ?? []`; only generation actions materialize directories (`packages/ui-mac/src/main/ext-transaction.ts:1174-1187`, `packages/ui-mac/src/main/ext-transaction.ts:1460-1467`). |
| Seed MCP distinction | The preload contract still narrows seed intents to global even though planner's internal seed type carries `InstallScope` (`packages/ui-mac/src/preload/types.ts:841-865`, `packages/ui-mac/src/main/ext-install-planner.ts:196-198`). The seed path is also global-only and promotes the selected asset into shared CAS before branching on `asset.type` (`packages/ui-mac/src/main/ext-install-planner.ts:1994-2004`, `packages/ui-mac/src/main/ext-install-planner.ts:2054-2064`, `packages/ui-mac/src/main/ext-install-planner.ts:2122-2125`). Its MCP transaction is nevertheless config-only (`packages/ui-mac/src/main/ext-install-planner.ts:2164-2169`, `packages/ui-mac/src/main/ext-install-planner.ts:2217-2270`). The seed module already exposes a byte-complete, zero-write verifier separately from CAS promotion (`packages/ui-mac/src/main/ext-seed.ts:334-393`, `packages/ui-mac/src/main/ext-seed.ts:395-424`). |
| Recovery | Recovery options consistently consume their supplied root, and startup eagerly recovers only `alphaGlobalRoot()` (`packages/ui-mac/src/main/ext-ipc.ts:651-705`, `packages/ui-mac/src/main/ext-ipc.ts:706-707`). The reusable recovery gate is already per-root and revalidates root identity before mutation (`packages/ui-mac/src/main/ext-recovery-gate.ts:33-59`, `packages/ui-mac/src/main/ext-recovery-gate.ts:77-97`), but the catalog write-channel entry always selects the global root today (`packages/ui-mac/src/main/ext-write-channels.ts:66-77`, `packages/ui-mac/src/main/ext-write-channels.ts:100-109`). |
| Uninstall trap | Project uninstall currently admits only the legacy manageable kinds `skill` and `agent` (`packages/ui-mac/src/main/ext-install-planner.ts:772-790`, `packages/ui-mac/src/main/ext-install-planner.ts:2320-2335`). The MCP branch calls a no-root `removeMcpConfigInLock` seam (`packages/ui-mac/src/main/ext-install-planner.ts:2405-2433`); its production implementation resolves the global primary config and all global legacy paths (`packages/ui-mac/src/main/ext-config.ts:117-129`, `packages/ui-mac/src/main/ext-config.ts:821-854`). Recovery additionally throws for every non-global MCP artifact root (`packages/ui-mac/src/main/ext-ipc.ts:683-699`). Therefore adding `mcp` to the manageable set alone would take a project lock and delete the global leaf. |
| CAS/GC | GC marks digests from journal `files` and generation contents, while its production root set is only dev/prod/beta (`packages/ui-mac/src/main/ext-cas-gc.ts:147-154`, `packages/ui-mac/src/main/ext-cas-gc.ts:186-229`; scheduler wiring at `packages/ui-mac/src/main/ext-cas-gc-scheduler.ts:41-54`). Project-root GC is N/A only if every admitted project MCP path performs zero CAS writes, carries `files: []`, and creates no generation/prepared resource. The current direct catalog path meets that shape; the current seed path does not because of its pre-branch CAS promotion. |
| Hub and process scope | The Hub already derives the current project directory from the route and already renders separate global/project receipt groups (`packages/ui-mac/src/renderer/extensions/extension-hub.tsx:189-200`, `packages/ui-mac/src/renderer/extensions/extension-hub.tsx:962-968`, `packages/ui-mac/src/renderer/extensions/extension-hub.tsx:2673-2699`). Global alpha config is injected through process environment, and the engine merges both environment sources for instance config (`packages/ui-mac/src/main/alpha-config-injection.ts:72-87`, `packages/ui-mac/src/main/alpha-config-injection.ts:383-392`, `packages/opencode/src/config/config.ts:401-408`, `packages/opencode/src/config/config.ts:468-475`). Putting a project MCP in either `OPENCODE_CONFIG` or `OPENCODE_CONFIG_CONTENT` would therefore turn a per-instance fact into process-wide state. |
| Workspace mismatch owned elsewhere | This checkout still opens an installation-time workspace picker and still defines `~/Alpha/excel-workspace` for the current global Excel policy (`packages/ui-mac/src/renderer/extensions/extension-hub.tsx:1105-1123`, `packages/ui-mac/src/main/ext-mcp-policy.ts:25-29`). That is current truth, not the selected product. REQ-134 owns the separate migration to spawn-time `{workspace}` → `InstanceState.directory`; this decision neither edits nor reuses the Office/Excel policy. |

## ② Selected vs rejected

### Selected

1. **Admitted kind table.** The project carve-out applies only after main has resolved verified facts to
   MCP: (a) a standalone verified catalog entry with `entry.type === "mcp"`, or (b) a verified packaged
   seed asset and its bundled catalog entry that both resolve to MCP. Project skill and agent remain
   rejected. Project bundle, signed-package, plugin, cloud, and every unlisted shape remain rejected.
   A renderer-provided id prefix or claimed kind never satisfies this gate.
2. **Scope UX and authority.** Hub defaults every MCP catalog install to **Global**. When and only when
   the route supplies a current project directory D, Hub also offers **Current project**; it offers no
   arbitrary directory picker. Main re-decodes the intent, resolves verified entry/seed facts, and
   canonicalizes D. The control is UX, while the planner gate is authority (AC1, AC3).
3. **Project transaction.** For direct catalog MCP, `txRoot = D/.alpha`, the only config edit targets
   `D/.alpha/alpha.jsonc`, and the receipt is committed to that root's ledger. It is one config action,
   with placeholder generation id, `files: []`, no prepared resource, and no CAS operation. For seed
   MCP, main runs `verifySeedAsset` but does **not** call `promoteSeedAssetToCas`; it then creates the
   same config-only plan. Deterministic tests must prove zero CAS calls and an empty journal file list
   for both paths before GC is accepted as N/A (AC2, AC6).
4. **Discovery and activation.** No second project registry or session-switch writer is added. The
   existing per-instance extension config hook discovers D's file. Installation never changes
   `extensionsConsent`; it may invoke the existing explicit consent flow. Before grant the honest
   state is `installed — awaiting project consent`. After grant, dispose/reload and status lookup are
   directory-scoped to D. A session outside D has neither this config leaf nor this tool (AC2).
5. **Precedence and shadowing.** Preserve the existing merge: project MCP is add-if-absent, and any
   already-effective entry of the same name wins; the required global-vs-project case therefore leaves
   global active. Main owns a safe, directory-scoped activation probe: it checks the effective global
   config for the name and verifies that D's effective MCP leaf is the durable project leaf before it
   consults name-only MCP status. It returns only `active`, `shadowed`, or `unverifiable`—never config
   bytes. A global hit or effective-leaf mismatch is shadowed; an unreadable or provenance-ambiguous
   result is unverifiable and can never be reported connected. The existing project-aware installed
   read view carries only this safe verdict to Hub after install and on refresh. Hub labels the project
   row **Shadowed by global** (or **Activation unverifiable**) and never derives ownership from receipts
   or name-only status. Global and project receipts remain two
   independent rows. Removing the project row changes only D's config/ledger, and removing the global
   row changes only the global config/ledger. This chooses disclosure rather than collision refusal and
   closes the current silent-success gap (AC4).
6. **Recovery and removal.** Startup recovery stays global-only. A project write or uninstall lazily
   recovers exactly D's transaction root through the existing per-root gate. Global MCP cleanup keeps
   its existing legacy/secret behavior. Project MCP cleanup uses an explicit root-parametric primitive
   that edits only `<projectRoot>/alpha.jsonc`; it must never call global legacy-config or global-secret
   cleanup. `uninstallArtifacts` dispatches by the journal root and project replay is idempotent. The
   implementation must not add `mcp` to `LEGACY_PROJECT_MANAGEABLE_KINDS` until that root-parametric
   remove and recovery seam exist in the same change.
7. **Project safety subset.** An admitted project MCP has `requiredEnvVars.length === 0`, creates no
   secret version, and writes no secret or workspace grant. An entry recognized by the current
   workspace-policy classifier is rejected on the project channel. Installation does not create or
   imply consent. REQ-134, not this requirement, owns literal `{workspace}` persistence and substitution
   with the spawning `InstanceState.directory`; until that separate behavior lands, such entries stay
   fail-closed here (AC5 dependency).
8. **Configuration authority.** Project MCP is carried only by `D/.alpha/alpha.jsonc` and the existing
   per-instance hook. It is never copied into `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`, the global
   environment `alpha.jsonc`, or a Hub/session cache. Alpha is authoritative for its verified catalog
   fact, transaction, and receipt; it deliberately does not overwrite an earlier effective/global
   config name, so the Hub exposes the resulting precedence instead of pretending to own all engine
   configuration.

### Rejected

- A Hub-only switch with the main planner still rejecting project scope.
- An install-time project/workspace directory picker, `~/Alpha/excel-workspace`, or any other durable
  install-time workspace binding. REQ-134's spawn-time binding is the selected Office sandbox.
- Rewriting any `alpha.jsonc` when the user changes sessions or projects.
- Injecting project MCP through `OPENCODE_CONFIG` or `OPENCODE_CONFIG_CONTENT`.
- Wrapping MCP as a skill import, or reopening project catalog install for skill/agent.
- Project bundle/package admission, secret-bearing project MCP, current workspace-policy MCP, automatic
  consent, silent same-name success, eager scanning/recovery of every known project, or a project CAS/GC
  registry while the admitted plans remain provably CAS-free.

## ③ Security invariants

| Class boundary | Invariant and required gate |
| --- | --- |
| **C1 — Renderer intent → main facts** | Renderer may select `global` or current-project D and submit user confirmation. Main strictly decodes, resolves the signed/effective catalog or bundled seed entry, and admits project scope only when the verified resulting type is MCP. Unknown keys, unsupported kinds, and identity failures stop before writes. |
| **C2 — Project directory → transaction root** | Main derives and revalidates `D/.alpha`; the renderer never supplies `txRoot`, config target, receipt path, or journal path. Plan validation confines the only config target to `<txRoot>/alpha.jsonc`, with identity checked again immediately before mutation. |
| **C3 — MCP subset → side-effect classes** | Project MCP requires zero required env vars and is outside the current workspace-policy class. It may create only a config image, transaction journal, authorization record, and receipt beneath `txRoot`. It cannot create secret files, workspace directories/grants, CAS blobs, generations, prepared resources, plugin payloads, skills, or agents. Seed verification is read-only. |
| **C4 — Durable install → executable discovery** | A committed receipt is not execution authority. The project config hook remains gated by the explicit per-project `extensionsConsent`; install never writes that consent. Outcomes distinguish committed/awaiting-consent, shadowed, connected, disabled, failed, and reload-pending rather than collapsing them into success. |
| **C5 — Effective config → project merge** | Any already-effective same-name MCP wins; project only fills an absent name. The main-owned D-scoped probe checks effective global name presence and proves the final D leaf is the project leaf before reading name-only live status. It returns no config bytes; shadowed or unverifiable can never become connected. Hub consumes that verdict rather than inferring provenance from receipts. Each scoped uninstall leaves the other scope byte-for-byte intact. |
| **C6 — Journal root → recovery/removal** | Every write and uninstall is admitted through recovery for its exact root. Project artifact replay receives the verified project root and removes only that root's MCP leaf and grants. The global-only `removeMcpConfigInLock` and global secret/legacy cleanup are unreachable from a project journal. Failure leaves the journal non-terminal for retry. |
| **C7 — Project config → process boundary** | No project-derived bytes or paths enter either process-wide OpenCode config environment variable. Discovery and activation carry D as instance context; another directory cannot observe D's MCP through the Alpha project channel. Switching sessions performs no durable config rewrite. |
| **C8 — Config-only proof → GC conclusion** | GC is N/A, not merely omitted, only while tests prove direct and seed project MCP perform zero CAS writes, journal `files` is exactly empty, the placeholder generation id is used, and no generation/prepared directory is created. Any future project kind or MCP payload that breaks one premise requires a new GC design before admission. |
| **C9 — Workspace placeholder → REQ-134** | REQ-136 does not provision an install-time directory. Current workspace-policy MCP fails closed on the project channel. Only REQ-134 may make a literal `{workspace}` executable by substituting the spawning `InstanceState.directory`; that change must bring its own behavioral gate and must not be smuggled into these CODE tickets. |

## ④ Child split

The DECIDE child is this document plus the narrow ADR amendment. It closes
`jinjunnn/alpha-code#1014` only and references, but does not close, parent
`jinjunnn/alpha-code#1013`. The implementation split is exactly these two children.

### `[REQ-136][CODE] Admit project MCP transactions without cross-root effects`

- **Covers:** AC2 (project config/receipt root and directory isolation), AC3 (main planner kind gate for
  catalog and seed MCP), AC4 (scope-independent uninstall), AC6 (discovery/recovery and zero-CAS proof),
  plus the fail-closed half of AC5.
- **Boundary — exact files:**
  `packages/ui-mac/src/main/ext-install-planner.ts`,
  `packages/ui-mac/src/main/ext-install-planner.test.ts`,
  `packages/ui-mac/src/main/ext-write-channels.ts`,
  `packages/ui-mac/src/main/ext-write-channels.test.ts`,
  `packages/ui-mac/src/main/ext-config.ts`,
  `packages/ui-mac/src/main/ext-config.test.ts`,
  `packages/ui-mac/src/main/ext-ipc.ts`,
  `packages/ui-mac/src/main/ext-mcp-activation.ts`,
  `packages/ui-mac/src/main/ext-mcp-activation.test.ts`,
  `packages/ui-mac/src/preload/types.ts`,
  `packages/ui-mac/src/main/ext-recovery-gate.test.ts`,
  `packages/ui-mac/src/main/ext-seed-install.test.ts`,
  `packages/ui-mac/src/main/ext-transaction-config.test.ts`,
  `packages/ext/src/project-config.test.ts`, and
  `docs/contracts/extension-cas-seed.md`.
- **Out of scope:** Hub controls/copy, skill/agent/plugin/bundle/signed-package project admission,
  eager project scanning, CAS root registration, Office advisories, Excel policy, workspace spawning,
  and any v1/v2 engine-generation switch.
- **Exit condition:** Merged PR + `bin/check` green + documentation impact handled, with deterministic
  tests for the typed project-seed intent, verified-kind admission, direct and seed config-only plans
  (`files: []`, placeholder gen, zero CAS/prepared resources), D-only receipt/config, lazy D-root
  recovery, a D-scoped shadow/unverifiable verdict that cannot borrow name-only status, crash-replayed
  project uninstall, and byte-preserving global/project same-name removal.

### `[REQ-136][CODE] Make Hub default global and disclose project MCP state`

- **Covers:** AC1 (global default and cross-directory availability), AC2 (current-project option and
  honest activation), AC4 (two rows plus shadow label), and the REQ-136 side of AC5 (no picker; current
  workspace-policy entries remain blocked pending REQ-134).
- **Boundary — exact files:**
  `packages/ui-mac/src/renderer/extensions/use-extensions.ts`,
  `packages/ui-mac/src/renderer/extensions/extension-hub.tsx`,
  `packages/ui-mac/src/renderer/extensions/extension-hub.css`,
  `packages/ui-mac/src/renderer/extensions/install-scope-wiring.test.ts`,
  `packages/ui-mac/src/renderer/extensions/use-extensions-ipc.test.ts`,
  `packages/ui-mac/src/renderer/i18n/en.ts`,
  `packages/ui-mac/src/renderer/i18n/zh.ts`, and
  `packages/ui-mac/src/renderer/i18n/locale-regression.test.ts`.
- **Out of scope:** main admission/removal semantics, arbitrary directory selection, rewriting config on
  route changes, project enable toggles, Office advisories, Excel policy, REQ-134 spawn substitution,
  skill/agent project catalog install, and package/bundle scope.
- **Exit condition:** Merged PR + `bin/check` green + documentation impact handled, with tests proving
  Global is the default, Current project appears only for the route's D, no directory picker is called,
  consent-denied/awaiting-consent and reload-pending stay honest, project rows render main's
  shadowed/unverifiable verdict and never borrow name-only live status, and sessions outside D do not
  show the project MCP as connected.

Parent closure still requires REQ-134's independent literal-placeholder/spawn-time workspace evidence
for AC5. Neither CODE child may claim or close the parent requirement by itself.
