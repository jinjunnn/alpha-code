# Local-First Agent Harness Architecture

Date: 2026-06-19

Status: Draft design — reconciled; cloud control-plane sections migrated out (see Part 0 + migration note, 2026-06-22).

> **Review note (2026-06-22):** This document was reviewed against the actual
> alpha-code / opencode codebase and the project's North Star (upgrade-isolation
> health = 0 conflict files) and ADRs (esp. ADR-002 / 005 / 010 / 011 and
> NON_GOALS). **Part 0 immediately following is the reconciliation layer** — it
> records what must change before this plan is built. Where a later section
> conflicts with Part 0, **Part 0 wins.** Read Part 0 first.
>
> **Migration note (2026-06-22):** This file now keeps only the **governance +
> local-first thesis**. The **cloud control-plane design** (former §5, §10, §11,
> §13, §14, §15, §17, §20, §21, §22) has been **moved to
> `alpha-platform/docs/design.md`** and reconciled there (three-axis model per
> §0.3; dual-path ledger per ADR-013; untrusted-multi-tenant security per §0.6).
> Those section headers below now carry a `[MIGRATED → …]` stub. The remaining
> sections (§1–4, §6–9, §12, §16, §18, §19, §23–25) still describe the
> local/governance side and are governed by Part 0 by precedence — they have **not**
> yet been physically rewritten (that is the still-open "doc-debt" item (b)).

## Part 0. Architecture Review & Reconciliation (2026-06-22)

### 0.1 Verdict

This is a strong, internally consistent design — but it is written as if we are
building Claude Code from zero ("The local harness is the operating system,"
§25). alpha-code's thesis is the opposite: **do not rebuild the harness; layer
thin additions onto opencode and inherit every upstream upgrade** (ADR-005,
NON_GOAL #2/#3).

A source scan (2026-06-22) confirmed that **opencode already provides ~80% of the
"Local Harness" described here.** So the work is *not* "build this blueprint" — it
is "wire alpha seams onto existing opencode primitives, and build the three layers
this document omits: the cloud control plane, identity/billing, and
web/distribution."

### 0.2 Substrate principle — opencode IS the harness (do not rebuild)

The single biggest correction: Sections 2, 6, 7, 15, 17, 18 describe building a
harness, tool broker, permission system, provider router, session store, and
audit log. These are `@opencode-ai/core`'s job. Rebuilding them = the maintenance
hell ADR-005 and NON_GOAL #2 forbid. Confirmed mapping:

| This document proposes | opencode status | Key files | Correct action |
|---|---|---|---|
| §2.1 Local Harness main controller (planning/routing/auth/state/verify/audit) | ✅ already core | `core/src/session.ts`, `core/src/session/runner/` | **Do not build.** This is opencode |
| §7 Host Tool Broker (register/permission/approve/audit) | ✅ already exists | `plugin/src/tool.ts`, `core/src/permission.ts` + hooks `tool.execute.before/after`, `tool.definition`, `permission.ask` | **Do not build.** Layer policy via hooks |
| §6 Agent types (subagent / mode / permissions) | ✅ already exists | `core/src/agent.ts` (`mode: subagent/primary/all` + permission ruleset), `.opencode/agent/*.md` | **Reuse.** Do not invent a parallel `AgentSpec` registry |
| §15 Provider mapping / multi-provider routing | ✅ already exists | `llm/src/provider.ts`, `core/src/provider.ts` + hooks `chat.params`, `chat.headers` | **Do not build.** NON_GOAL: no second LLM orchestration layer |
| §18 Canonical API / SDK | ✅ OpenAPI auto-generated | `sdk/js/src/client.ts`, `server/src/api.ts` + SSE `/api/event` + PTY WS | **Do not start a new `/v1/*`.** Missing routes go in the sidecar (ADR-002) |
| §12 Skills / commands / MCP | ✅ full convention | `core/src/skill.ts`, `core/src/command.ts`, `core/src/config/mcp.ts`, `.opencode/{skill,command,agent}` | **Reuse.** Do not define a new skill format |
| §11 Jobs (local) | ⚠️ local version exists | `core/src/background-job.ts` (in-memory, no durability) | Fine locally; cloud durability is the new build |

Rule going forward: before adding any `type XxxSpec = {...}`, check whether
opencode already has an equivalent — it usually does.

### 0.3 Terminology fix — retire the overloaded "Cloud Tier"

This document's two scales (`Execution Mode 0–3` in §4 and `Cloud Tier 1–3` in
§5) collide with the ADRs and with each other:

- ADR-011 **already defines "Tier-1/2/3"** to mean *execution-environment weight*
  (in-process / ephemeral Box / persistent Box). This document's "Cloud Tier"
  reuses the same word for a different thing (autonomy/lifecycle). Same name,
  different meaning → guaranteed confusion.
- §2.2 claims Mode / Cloud Tier / Agent Type are orthogonal, but `Mode 3 = needs
  sandbox` and `Cloud Tier 2/3 = uses sandbox` are the same thing — not
  orthogonal. And "Cloud Tier" itself secretly bundles *autonomy* (advice vs
  worker) with *environment weight* (no sandbox vs persistent) — the two axes
  ADR-010/011 deliberately separated.

**Adopt the ADR's cleaner model — three axes, and delete the word "tier":**

| Axis | Values | Replaces |
|---|---|---|
| **Autonomy** (who decides the steps; ADR-010 litmus "can you write the steps now?") | `function` / `pipeline` / `bounded-agent` | the autonomy half hidden inside "Cloud Tier" |
| **Runtime weight** (what machinery) | `none` → `read-tools` → `brokered-tools` → `ephemeral-sandbox` → `persistent-sandbox` | this doc's `Mode 0–3` **+** ADR-011's `Tier-1/2/3`, merged into one axis |
| **Location** (deployment) | `local` / `cloud` | "cloud tier" as a standalone scale — location is a property, not a tier |

The doc's `Cloud Tier 1/2/3` then becomes *derived*, not foundational:
`Tier1 ≈ cloud + read-tools`, `Tier2 ≈ cloud + ephemeral-sandbox + bounded-agent`,
`Tier3 ≈ cloud + persistent-sandbox`. Agent role (research/code/review) stays as a
fourth, orthogonal specialization axis.

### 0.4 What is genuinely new — keep and invest here

These have no opencode equivalent and match ADR-010/011 closely. They are the
actual product, and the real work:

1. **Context Pack (§17.1)** — the explicit, auditable, previewable bundle sent to
   cloud, with redaction / exclusion / token estimate / privacy level. This is the
   "local-first privacy boundary" made concrete and the superset of ADR-010's task
   contract. **Top new-build item.**
2. **Run Ledger (§17.3) + Provenance (§17.5) + Verification Gates (§17.4)** —
   opencode does not verify results. "Verification is the moat" is correct; this is
   what you sell over a bare agent.
3. **Capability tokens (§17.2)** — short-TTL, min-scope, job/tool-bound — matches
   ADR-011's broker design exactly.
4. **Local owns final apply/merge/verify; cloud returns only proposals
   (§2.1/§17.6)** — matches ADR-010 "agency local, determinism cloud."
5. **Cloud control plane = MCP gateway + dispatch ingress + Upstash orchestration**
   — the only genuinely new infrastructure (confirmed: `cloud.dispatch` contract,
   Upstash Workflow/QStash binding, tier router, Box integration, durable ledger
   are all unbuilt). This is the 6-month main effort, not anything opencode gives.

### 0.5 The missing layers — "web + backend" is THREE backends, not one

The product surface (desktop app + website/download + backend) maps to three
distinct backends. The document blurs them into one undifferentiated "backend."

| Backend | Runs where | Owns | Status / ADR |
|---|---|---|---|
| **A. Local sidecar** | inside ui-mac, Electron `utilityProcess` | local HTTP the desktop UI needs that opencode server lacks; websearch direct; alpha-secrets | ✅ exists (`ui-mac/src/main/server.ts`, `alpha-secrets.ts`), ADR-002/009 |
| **B. Cloud control plane + MCP tool gateway** | AWS ECS/Fargate | `cloud.dispatch` server-side validation, Upstash Workflow/QStash orchestration, tier router, **central MCP tool gateway (secrets + capability tokens)**, Box sandboxes, run ledger (Redis), **multi-tenant authn/quota/billing** | ❌ new, ADR-010/011 |
| **C. Distribution / website backend** | Vercel/Netlify + object store | marketing site (static), downloads, **electron auto-update feed**, license/activation, signup/login, billing portal | ❌ new, **not covered anywhere in this doc** |

Two corrections this implies:

- **§18.1 is wrong to define a fresh `127.0.0.1:8765/v1/*`** exposing
  sessions/tools/events. opencode's server already exposes those via the SDK. The
  sidecar should add only what opencode lacks: context-pack preview,
  `cloud.dispatch` ingress, run-ledger views. Everything else goes through
  `@opencode-ai/sdk` (CLAUDE.md hard constraint ②).
- **Identity is the missing foundation that spans A/B/C.** The doc has per-job /
  per-tool capability tokens but **no user/tenant identity layer**. "Pay-per-task
  outcomes" requires it: C issues identity, B verifies it for quota/billing/
  isolation. ADR-010 §7 lists these as unresolved (tenant isolation, authn/authz,
  quota/billing, **LLM key ownership: platform-pays vs BYOK**, abuse prevention).
  **LLM-key ownership must be decided first** — locally opencode uses the user's
  own keys, but who pays for the cloud Anthropic calls changes the entire billing
  architecture and the ledger schema.
- **Auto-update (C)** is the one non-trivial piece: electron-builder's updater
  needs a static feed (`latest-mac.yml`); this hangs directly off ADR-012's prod
  channel and `UPDATER_ENABLED`. Don't underestimate Mac signing/notarization.

### 0.6 Multi-tenant security correction

§10.7/§21 assume the local harness owns the root workflow and the cloud is a
constrained child that "emits an approval if it wants to exceed bounds." **That
holds for a single trusted user; it breaks for untrusted multi-tenant.** The cloud
gateway **cannot trust** the policy (budget/tier/network) the local harness claims
— the local machine is user-controlled and tamperable. ADR-010 §6/§3 already has
the right model: **`cloud.dispatch` is hard-validated server-side (skill is soft
guidance, the schema is the hard gate), and egress control is orthogonal to and
independent of admission audit.** Rewrite §10.7/§21 so the cloud is an
**independent trust domain**: policy from the local side is a *request*; the cloud
gateway *re-enforces* per-tenant quota/scope. Also add the known **Box egress
limitation** (ADR-011 security section) — the doc never mentions it, and it's why
the Tier-3 sandbox choice is deliberately *not* locked.

### 0.7 Conflicts with NON_GOALS / scope to cut

- **§19 Embeddability (Cursor/VS Code/JetBrains/Slack/Teams/GitHub/browser/CI)**
  ⟂ **NON_GOAL #6 (Mac desktop only; do not revive web/tui/console/enterprise
  forms).** Massive scope expansion that fights "thin customization, single
  maintainer." → Move the whole section to "Future / Out of Current Scope," or
  drop it. `[DRIFT]`
- **§12.3 Pack ecosystem + marketplace + third-party packs** — far future. MVP
  caps at 2–3 official packs (the doc says so itself); §23 Phase 4 schedules
  plugin format / pack registry / eval too early.
- **Ensemble tools + `web.search.ensemble` + multi-provider routing** — over-
  engineered. opencode already abstracts providers; ADR-009 already opens
  websearch. One logical `web.search` is enough for MVP; do not build six
  implementations plus an ensemble first.

### 0.8 Reranked MVP — aligned with G4 (supersedes §23 phases)

§23 Phase 1 = "build harness + broker + workflow engine + context pack + ledger +
policy + token + sandbox + model adapter." **~80% of that already exists.**
Rerank around G4 (one real non-coding task, end to end):

| Milestone | Content | New build |
|---|---|---|
| **M0** ✅ done | ext plugin + sidecar + alpha-secrets + websearch default on | exists |
| **M1 — Context Pack** | local builder + preview; one `.opencode/skill` produces a schema-constrained task contract (ADR-010) | small, local, zero upstream change |
| **M2 — Dispatch ingress** | MCP `cloud.dispatch(contract)` + sidecar Zod validation → returns `job_id` | small |
| **M3 — Minimal cloud plane** | **Tier-1 (in-process) only**: ECS endpoint + thin Upstash Workflow wrapper + direct Anthropic call; run ledger in Redis; **one real task (deep research)** | large but focused |
| **M4 — Return path** | `cloud.await/status` via poll first; result lands as a local artifact | small |

Resolve §0.9 (identity/billing/key ownership) **before M3**, or the ledger schema
gets reworked. Tier-2/3 sandboxes, pack ecosystem, embeddability, eval system, and
the full verification-gate suite are all **post-MVP**.

### 0.9 Open decisions to resolve before the cloud build (ADR-010 §7)

These are blocking and should be decided first (a one-page decision memo, then a
new ADR):

1. **LLM key ownership**: platform-pays vs BYOK vs hybrid. Drives billing + ledger.
2. **Tenant model**: per-user isolation only, or team/shared workspaces?
   (NON_GOALS leaves team collaboration "另议".)
3. **Identity system**: what issues/verifies user identity across A/B/C (the
   foundation under capability tokens).
4. **Billing unit**: per-task, per-token, subscription, or metered.
5. **Tier-3 sandbox**: stays deliberately open (Box egress limitation) — confirm
   v1 ships Tier-1/2 only.

### 0.10 Section-by-section disposition

How to treat each existing section when this draft is revised:

| Sections | Disposition |
|---|---|
| §1 Goal; §2.3/2.4 (shared/logical tools); §2.6 (workflow boundary); §8–§10, §13–§14, §16, §22 | **Keep** (workflow durability = Upstash per ADR-011) |
| §2.1 (main controller); §6 (agent types); §7 (tool broker); §15 (providers); §17 broker/policy parts; §18 (API); §24 (interfaces) | **Remap** onto existing opencode primitives (see 0.2); stop describing them as new |
| §2.2 (orthogonal dims); §4 (Modes); §5 (Cloud Tiers) | **Supersede** with the three-axis model (0.3); delete "tier" as a standalone scale |
| §17.1 Context Pack; §17.2 tokens; §17.3 ledger; §17.4 gates; §17.5 provenance | **Keep + prioritize** — the genuinely new value (0.4) |
| §0.5 backends; identity layer; web/distribution (C) | **Add** — missing from the original (0.5) |
| §10.7, §20, §21 | **Augment** with multi-tenant re-validation + Box egress (0.6) |
| §19 Embeddability; §12.3 marketplace; ensemble tools | **Defer / cut** — conflicts with NON_GOALS (0.7) `[DRIFT]` |
| §23 MVP phases | **Supersede** with the M0–M4 rerank (0.8) |
| §25 "local harness is the OS" | **Reword**: opencode is the harness; alpha is the control-plane skin + the cloud plane |

---

## 1. Goal

Build a general-purpose, local-first agent harness similar in spirit to Claude Code:

- Use cheap local models for routine work.
- Escalate hard problems to cloud expert agents.
- Let cloud agents run isolated tasks when useful.
- Let cloud agents handle long-running jobs when local execution is inefficient.
- Keep the local harness in control of tools, permissions, audit, merging, and final verification.
- Support multiple providers, including OpenAI, Claude, local models, self-hosted tools, MCP servers, and custom skills.

The system should not be tightly coupled to any single model vendor. Providers are implementation backends. The stable product boundary is the local harness, tool broker, job protocol, and agent contracts.

## 2. Core Decisions

### 2.1 Local Harness Is the Main Controller

The local harness owns:

- Task planning and routing.
- Tool authorization.
- Local workspace state.
- Patch application.
- Final verification.
- Audit logs.
- Budget and latency policy.
- Escalation decisions.

Cloud agents can advise, execute in isolated sandboxes, or run long jobs, but they should not directly mutate the user's real local workspace.

### 2.2 Execution Mode, Cloud Tier, and Agent Type Are Orthogonal

> **[Superseded by Part 0.3]** These are not truly orthogonal, and "Cloud Tier"
> collides with ADR-011's `Tier-1/2/3`. Use the three-axis model in §0.3.

Use three independent dimensions:

- Execution mode: how much machinery the request needs, from pure API to sandbox/job.
- Cloud tier: cloud escalation depth, autonomy, lifecycle, and permissions.
- Agent type: specialization, tool set, input/output contract, and quality bar.

For example:

- A simple explanation can use Mode 0 with no cloud tier.
- A current-events lookup can use Mode 1 with hosted read tools.
- A Research Agent can run in Mode 1 as a Tier 1 expert, or in Mode 3 as a Tier 3 long research job.
- A Code Agent can run in Mode 2 for patch generation, Mode 3 for test execution, Tier 2 for one isolated cloud patch, or Tier 3 for a multi-hour migration.

### 2.3 Host Tools Are Shared Infrastructure

Host tools are not only for cloud agents. They are shared by:

- Local harness.
- Local model.
- Cloud Tier 1 expert.
- Cloud Tier 2 worker.
- Cloud Tier 3 long-running agent.
- UI, CLI, SDK, and automation jobs.

Different callers receive different permissions through the Host Tool Broker.

### 2.4 Expose Logical Tools, Hide Provider Implementations

Agents should see logical tools such as:

- `web.search`
- `web.fetch`
- `repo.read_file`
- `repo.search`
- `sandbox.exec`
- `artifact.upload`
- `job.start`

The broker can route a logical tool to one of many implementations:

- OpenAI hosted tool.
- Claude hosted tool.
- Self-hosted service.
- Remote MCP server.
- Local implementation.
- Ensemble implementation.

Do not expose three competing `websearch` tools directly to normal agents. Expose one logical `web.search`; route behind the scenes.

### 2.5 API Is the Core Contract

Use:

- API as the canonical protocol.
- SDK for developer ergonomics.
- CLI for human use, CI, scripts, and debugging.
- MCP as an interoperability adapter for tools.

The CLI should not be the only internal protocol. The local harness and remote jobs should communicate using structured APIs and schemas.

### 2.6 Workflows Are the Product Boundary

A workflow is a reusable task state machine. It turns a user goal into ordered steps, each with its own execution mode, agent type, tools, cloud tier, approval policy, success criteria, and artifact policy.

Workflows are where the product creates durable value beyond raw model calls:

- They make tasks repeatable.
- They provide checkpoints, retries, and resumability.
- They decide when to stay local and when to escalate.
- They define verification and acceptance criteria.
- They collect artifacts and audit records.
- They can run locally, partly in the cloud, or fully as a cloud job.

The local harness should create and own the root workflow instance. Cloud workers may execute delegated workflow steps or run a child workflow, but they remain constrained by the workflow policy passed by the local harness.

## 3. High-Level Architecture

```mermaid
flowchart TD
  U["User"] --> H["Local Harness"]
  H --> LM["Cheap Local Model"]
  H --> WE["Workflow Engine"]
  H --> B["Host Tool Broker"]
  H --> MR["Execution Mode Router"]
  H --> CR["Cloud Tier Router"]

  WE --> MR
  WE --> CR
  WE --> B

  B --> LT["Local Tools"]
  B --> LS["Local Sandbox"]
  B --> MCP["MCP Servers"]
  B --> HT["Hosted Tool Endpoints"]
  B --> PT["Provider Native Tools"]

  MR --> M0["Mode 0: Pure API"]
  MR --> M1["Mode 1: Hosted Read Tools"]
  MR --> M2["Mode 2: Host Tools"]
  MR --> M3["Mode 3: Sandbox / Job"]

  M1 --> B
  M2 --> B
  M3 --> B

  CR --> T1["Cloud Tier 1: Expert"]
  CR --> T2["Cloud Tier 2: Worker"]
  CR --> T3["Cloud Tier 3: Long Job"]

  T1 --> B
  T2 --> B
  T3 --> B

  T2 --> RS["Remote Sandbox"]
  T3 --> RWS["Persistent Remote Workspace"]

  T1 --> H
  T2 --> H
  T3 --> H

  H --> V["Local Verify / Merge / Continue"]
```

## 4. Execution Mode Model

Execution mode answers: what does this request need to touch?

It is decided before, or alongside, cloud escalation. Many requests never need a cloud tier at all.

| Mode | Name | Needs Tool? | Needs Sandbox? | Typical Use |
|---|---|---:|---:|---|
| Mode 0 | Pure API | No | No | Explanation, translation, summarization, small code snippets |
| Mode 1 | API + Hosted Read Tools | Yes, read-only | No local sandbox | Web search, web fetch, retrieval, file search, citations |
| Mode 2 | API + Host Tools | Yes | Usually no sandbox | Repo search, read files, draft patch, inspect logs, route tools through broker |
| Mode 3 | Sandbox / Job | Yes | Yes | Run code, edit files, build, test, generate artifacts, long-running work |

### 4.1 Mode 0: Pure API

Purpose:

- Answer simple requests with a model call only.

Execution boundary:

- No tools.
- No filesystem access.
- No sandbox.
- No remote workspace.

Typical tasks:

- Explain a concept.
- Translate or rewrite text.
- Summarize provided content.
- Generate a small code snippet.
- Provide a high-level design opinion from supplied context.

### 4.2 Mode 1: API + Hosted Read Tools

Purpose:

- Let the model use hosted read-only capabilities without touching the local environment.

Execution boundary:

- Uses tools such as `web.search`, `web.fetch`, retrieval, or file search.
- No local command execution.
- No local file mutation.
- No sandbox unless the provider's hosted read tool internally uses one.

Typical tasks:

- Search current documentation.
- Fetch and summarize a URL.
- Query a vector store.
- Compare public sources.
- Answer with citations.

### 4.3 Mode 2: API + Host Tools

Purpose:

- Let the model or harness use brokered host tools while keeping execution controlled.

Execution boundary:

- Tools are called through the Host Tool Broker.
- Can read repo files, search logs, inspect artifacts, or draft patches.
- Write actions are usually represented as proposed patches, not directly applied.
- No arbitrary command execution unless routed to a controlled executor.

Typical tasks:

- Search a codebase.
- Read selected files.
- Produce a patch proposal.
- Inspect existing logs.
- Ask an expert with repo context.
- Use custom business tools through MCP or HTTP.

### 4.4 Mode 3: Sandbox / Job

Purpose:

- Run real commands, mutate files in an isolated workspace, generate artifacts, or perform long-running work.

Execution boundary:

- Uses local sandbox, remote sandbox, or job runner.
- Can execute commands under policy.
- Can write files in an isolated workspace.
- Can return patches, logs, artifacts, and checkpoints.
- Final application to the real local workspace remains controlled by the local harness.

Typical tasks:

- Run tests or builds.
- Execute scripts.
- Modify code and validate it.
- Generate Word, Excel, PowerPoint, PDF, images, or reports.
- Run a long migration job.

### 4.5 Mode and Cloud Tier Mapping

Mode is not the same as cloud tier.

| Execution Mode | Common Cloud Tier |
|---|---|
| Mode 0 | None, or Cloud Tier 1 for stronger reasoning |
| Mode 1 | None, or Cloud Tier 1/Tier 3 for research |
| Mode 2 | None, Cloud Tier 1 for advice, Cloud Tier 2 for isolated patch work |
| Mode 3 | Local sandbox, Cloud Tier 2 worker, or Cloud Tier 3 long job |

## 5. Cloud Tier Model

> **[MIGRATED → `alpha-platform/docs/design.md` §4]** The cloud-tier content moved to
> the cloud control-plane design (Backend B) and was reconciled per Part 0.3: the
> standalone "Cloud Tier" scale is **retired** in favor of the runtime-weight tiers
> Tier-1/2/3 per ADR-011. Authoritative version lives in alpha-platform.

## 6. Agent Types

Agent type defines specialization, tools, and output format. Execution mode defines the required runtime machinery. Cloud tier defines remote autonomy and lifecycle.

### 6.1 Recommended MVP Agent Types

| Agent | Primary Role | Common Cloud Tiers | Default Permissions |
|---|---|---|---|
| `research-agent` | Search, summarize, compare sources, cite evidence | Tier 1, Tier 3 | Read/network |
| `architect-agent` | Design, decompose tasks, evaluate tradeoffs | Tier 1 | Read-only |
| `code-agent` | Implement scoped code changes and return patches | Tier 2, Tier 3 | Sandbox write |
| `review-agent` | Find bugs, regressions, security risks, missing tests | Tier 1, Tier 2 | Usually read-only |
| `docs-office-agent` | Create/edit docs, spreadsheets, presentations, PDFs | Tier 2, Tier 3 | Artifact write |

### 6.2 Additional Agent Types Later

| Agent | Primary Role |
|---|---|
| `debug-agent` | Reproduce failures, inspect logs, isolate root cause |
| `test-agent` | Add tests, run test matrices, improve coverage |
| `security-agent` | Dependency audit, secret scanning, risky permission analysis |
| `data-agent` | CSV, Excel, notebooks, charts, statistical analysis |
| `release-agent` | Changelog, release notes, versioning, deployment checklist |

### 6.3 Agent Spec

```ts
type AgentSpec = {
  name: string
  role: string
  allowedTools: string[]
  defaultMode: "mode0" | "mode1" | "mode2" | "mode3"
  defaultCloudTier?: "tier1" | "tier2" | "tier3"
  maxBudgetUsd: number
  maxRuntimeSec: number
  inputContract: JSONSchema
  outputContract: JSONSchema
  canWrite: boolean
  requiresSandbox: boolean
}
```

Example:

```ts
const codeAgent: AgentSpec = {
  name: "code-agent",
  role: "Implement scoped code changes and return a verified patch.",
  allowedTools: [
    "repo.read_file",
    "repo.search",
    "sandbox.exec",
    "patch.create",
    "artifact.upload"
  ],
  defaultMode: "mode3",
  defaultCloudTier: "tier2",
  maxBudgetUsd: 2,
  maxRuntimeSec: 1800,
  inputContract: codeTaskInputSchema,
  outputContract: patchResultSchema,
  canWrite: true,
  requiresSandbox: true
}
```

## 7. Host Tool Broker

The Host Tool Broker is the capability layer for the whole system.

Responsibilities:

- Register tools.
- Route logical tools to concrete implementations.
- Enforce permissions.
- Apply risk policy.
- Handle approvals.
- Track budget and usage.
- Normalize outputs.
- Write audit logs.
- Hide secrets from models.
- Keep provider-specific details out of agent prompts.

### 7.1 Tool Spec

```ts
type ToolSpec = {
  name: string
  description: string
  inputSchema: JSONSchema
  outputSchema: JSONSchema
  risk: "read" | "write" | "network" | "destructive" | "credentialed"
  execution: "local" | "cloud" | "hybrid"
  transport: "local" | "http" | "mcp" | "provider_native" | "job"
  provider?: "local" | "openai" | "claude" | "mcp" | "custom"
  endpoint?: string
  skill?: string
  requiresApproval?: boolean
}
```

### 7.2 Tool Invocation Envelope

All tool calls should carry caller identity, policy, and task context.

```json
{
  "caller": {
    "type": "local_harness|local_model|cloud_agent|job_worker",
    "tier": "tier1|tier2|tier3",
    "agent": "code-agent",
    "task_id": "task_123"
  },
  "tool": "sandbox.exec",
  "input": {
    "command": "npm test"
  },
  "policy": {
    "timeout_ms": 120000,
    "max_cost_usd": 0.25,
    "network": "disabled",
    "approval_required": false
  }
}
```

### 7.3 Permission Model

| Caller | Suggested Permissions |
|---|---|
| Local Harness | Highest permission, can apply patches and merge results |
| Local Model | Read repo, run low-risk commands, request patches |
| Tier 1 Expert | Mostly read-only, selected context only |
| Tier 2 Worker | Read/write inside isolated sandbox, return diff |
| Tier 3 Agent | Persistent sandbox with budget, checkpoint, and approval limits |

Example policy:

```ts
if (caller.tier === "tier1" && tool.risk !== "read" && tool.risk !== "network") {
  deny()
}

if (tool.risk === "destructive" || tool.risk === "credentialed") {
  requireHumanApproval()
}

if (caller.type === "local_harness") {
  allowWithAudit()
}
```

## 8. Tool Routing

Expose one logical capability to agents; route to implementations internally.

### 8.1 Example: `web.search`

Logical tool:

```ts
web.search(query, options)
```

Possible implementations:

- `web.search.self`
- `web.search.openai`
- `web.search.claude`
- `web.search.brave`
- `web.search.tavily`
- `web.search.ensemble`

Routing policy:

```ts
if (task.requiresCompliance) use("web.search.self")
else if (task.requiresCrossCheck) use("web.search.ensemble")
else if (caller.provider === "openai" && nativeToolsAllowed) use("web.search.openai")
else if (caller.provider === "claude" && nativeToolsAllowed) use("web.search.claude")
else use(defaultSearchProvider)
```

### 8.2 Search vs Fetch

Keep search and fetch separate:

- `web.search`: discover candidate sources.
- `web.fetch`: read a known URL.
- `web.extract`: extract structured content from a page/document.

Do not use search when the URL is already known.

## 9. Hosted Tool Implementations

A hosted tool can be registered locally while implemented remotely.

The local registry stores:

- Name.
- Description.
- Input/output schemas.
- Risk level.
- Transport.
- Endpoint or provider adapter.
- Auth policy.
- Timeout and budget policy.

The implementation may live behind:

- HTTP endpoint.
- MCP server.
- Provider-native hosted tool.
- Async job API.
- Queue worker.

### 9.1 HTTP Tool Example

```http
POST https://tools.example.com/v1/tools/web.search/invoke
Authorization: Bearer <capability_token>
Content-Type: application/json
```

```json
{
  "caller": {
    "type": "local_harness",
    "task_id": "task_123"
  },
  "input": {
    "query": "OpenAI hosted shell docs",
    "domains": ["developers.openai.com"],
    "freshness": "latest"
  },
  "policy": {
    "max_cost_usd": 0.05,
    "timeout_ms": 15000
  }
}
```

Response:

```json
{
  "ok": true,
  "result": {
    "items": [
      {
        "title": "string",
        "url": "https://example.com",
        "snippet": "string"
      }
    ]
  },
  "usage": {
    "cost_usd": 0.003,
    "latency_ms": 820
  }
}
```

### 9.2 Provider-Native Tool Example

For OpenAI or Claude native hosted tools, the broker calls the provider API and enables the relevant tool in that request.

The agent still sees:

```ts
web.search()
```

The broker may route to:

```ts
web.search.openai()
web.search.claude()
web.search.self()
```

Provider-specific tool names and request structures stay inside adapters.

## 10. Workflow Model · 11. Jobs

> **[MIGRATED → `alpha-platform/docs/design.md` §5 (Workflow) + §6 (Jobs)]** Workflow
> spec/step/instance and the job system moved to the cloud control-plane design,
> reconciled per Part 0: `mode`/`cloudTier` fields → `autonomy`/`capabilities`/
> `location`; durability = Upstash Workflow; runs are tenant-scoped; external contract
> = MCP (`cloud.dispatch`/`status`/`await`), the `/v1/jobs` routes are internal.

## 12. Skills and Plugins

### 12.1 Skill

A skill is reusable expertise packaged as:

- Instructions.
- Scripts.
- Assets.
- Examples.
- Workflow rules.

Use skills for repeated workflows:

- Bug fixing.
- Code migration.
- API documentation.
- PowerPoint generation.
- Excel analysis.
- Word document editing.
- Security review.
- Release note generation.

Skill example:

```text
skills/
  bugfix/
    SKILL.md
    scripts/
      collect_logs.sh
      summarize_failures.py
    references/
      testing-policy.md
```

### 12.2 Plugin / Capability Pack

A plugin bundles multiple capabilities:

- Skills.
- MCP servers.
- Hosted tool registrations.
- Auth configuration.
- UI metadata.
- Provider adapters.

Use plugins when distributing a capability pack across projects or teams.

Example plugin:

```text
office-plugin/
  plugin.json
  skills/
    docx/
    xlsx/
    pptx/
  tools/
    office.render
    office.validate
  assets/
```

### 12.3 Workflow Packs

The core harness should not hard-code workflows for every industry, but it must support preset workflow packs.

Use this product rule:

```text
Core harness provides the generic workflow engine.
Vertical scenarios are delivered through workflow packs and plugins.
Start with a few high-value official packs.
Later allow users, teams, and third parties to create and share their own packs.
```

A workflow pack can include:

- Workflow templates.
- Skills.
- Tool registrations.
- MCP server definitions.
- Input forms.
- Artifact schemas.
- Style guides.
- Platform rules.
- Approval policies.
- Budget presets.
- Example outputs.

Example content creator pack:

```text
content-pack/
  workflows/
    xiaohongshu-post.workflow.yaml
    short-video-script.workflow.yaml
    content-calendar.workflow.yaml
  skills/
    title-style/
    hook-writing/
    platform-compliance/
  tools/
    trend.search
    image.generate
```

Example ecommerce pack:

```text
ecommerce-pack/
  workflows/
    product-listing.workflow.yaml
    competitor-research.workflow.yaml
    ad-copy.workflow.yaml
    keyword-research.workflow.yaml
  skills/
    seo-copywriting/
    product-photo-brief/
  tools/
    shopify.api
    amazon.keyword.search
```

Example video pack:

```text
video-pack/
  workflows/
    video-script.workflow.yaml
    storyboard.workflow.yaml
    subtitle.workflow.yaml
    thumbnail.workflow.yaml
  skills/
    shot-planning/
    voiceover/
  tools/
    video.render
    image.generate
    speech.generate
```

Recommended packaging levels:

| Level | Examples | Purpose |
|---|---|---|
| Core workflows | Research, bugfix, review, docs, data analysis | Prove the engine and serve broad tasks |
| Official packs | Content, ecommerce, video, office | Serve concrete user segments |
| User/team packs | Internal SOPs, team workflows, private tools | Create long-term stickiness |
| Third-party packs | Marketplace capabilities | Expand beyond the core team |

Early MVP should not include dozens of vertical packs. Pick two or three high-value packs and polish them deeply.

Good candidates:

- Developer pack: `bugfix`, `code-review`, `migration`, `docs`.
- Creator pack: `xiaohongshu-post`, `short-video-script`, `thumbnail-brief`, `content-calendar`.
- Business/office pack: `research-report`, `ppt-deck`, `excel-analysis`, `weekly-brief`.
- Ecommerce pack: `product-listing`, `competitor-research`, `ad-copy`, `keyword-research`.

### 12.4 Skill vs Tool vs Plugin

| Concept | Meaning | Example |
|---|---|---|
| Tool | Executable atomic capability with schema | `sandbox.exec`, `web.search`, `repo.read_file` |
| Skill | Reusable instructions/scripts/resources for a workflow | `pptx`, `bugfix`, `migration` |
| Workflow Pack | Preset workflow templates plus supporting skills/tools/policies | Creator pack, ecommerce pack |
| Plugin | Distribution bundle for tools, skills, MCP, metadata, and workflow packs | GitHub plugin, Office plugin |

## 13. Remote Execution Patterns · 14. Workspace Transfer Strategies · 15. Provider Mapping

> **[MIGRATED → `alpha-platform/docs/design.md` §4.1–4.4 + §8]** Remote execution
> patterns, workspace transfer, and provider mapping moved to the cloud control-plane
> design. Provider mapping was reframed as the **cloud model proxy** under ADR-013
> (no second LLM orchestration layer — opencode already abstracts providers locally).

## 16. Optimal Design Goals

The optimal system is not the one with the strongest model or the largest number of tools. It is the one that balances five goals at once:

```text
Highest useful quality
Lowest practical cost
Smallest necessary privacy exposure
Most verifiable results
Most reusable workflows
```

The product should optimize for reliable completed outcomes, not raw conversations.

### 16.1 Optimal Execution Loop

The optimal execution path is a controlled loop:

```text
Workflow Engine
-> decide whether a workflow is needed
-> select execution mode
-> try local model first
-> use Host Tool Broker for controlled tools
-> run verification gates
-> escalate to cloud tier only on failure, low confidence, or explicit need
-> receive patch, artifact, or report from cloud
-> verify, merge, archive, and record provenance locally
```

This loop keeps the local harness in control while still allowing cloud experts, cloud workers, and cloud jobs to improve outcome quality when needed.

### 16.2 Five Product Layers

The system should be designed as five product layers:

| Layer | Responsibility |
|---|---|
| Local Control Plane | Local state, permissions, context, approvals, artifacts, workflow runs |
| Workflow Engine | Static templates, dynamic plans, dynamic execution |
| Capability Layer | Tools, skills, MCP, provider-native tools, hosted endpoints |
| Cloud Execution Layer | Tier 1 experts, Tier 2 workers, Tier 3 workflow jobs |
| Pack Ecosystem | Developer, content, office, ecommerce, video, and team packs |

This framing prevents the system from becoming only a model router or only a tool runner.

### 16.3 Local and Cloud Strengths

The local harness should be strongest at:

| Capability | Why It Matters |
|---|---|
| Local context selection | Users trust the system not to upload unnecessary files |
| Permissions and approvals | Risk is controlled before tools or cloud agents act |
| Workflow state | Tasks become resumable and auditable |
| Tool broker | Every tool call is authorized, routed, and logged |
| Artifact store | Outputs become manageable assets |
| Git/workspace awareness | Code tasks operate on the real local state |
| Cost router | Cheap local models are used before expensive cloud models |
| Pack runtime | Vertical workflows can be added without changing the core harness |
| Local eval and verification | Results are checked, not only generated |

The cloud side should be strongest at:

| Capability | Why It Matters |
|---|---|
| Strong model experts | Complex reasoning, architecture, and deep debugging |
| Isolated sandboxes | Independent attempts do not pollute local state |
| Long-running runners | Multi-hour and batch work can run away from the local machine |
| Provider-native skills | Claude Office skills, OpenAI hosted tools, and similar native capabilities |
| High-concurrency jobs | Team and batch workloads can scale |
| Cloud workflow runner | Delegated child workflows can execute remotely |
| Artifact generation | Heavy PPT, Excel, video, report, and media work can be offloaded |
| Cross-provider routing | The system can choose OpenAI, Claude, local, or self-hosted providers by task |

### 16.4 Why Users Stay

Users will not stay only because the product can call OpenAI or Claude. They will stay because:

- It understands their workspace.
- It does not upload unnecessary private context.
- It starts with low-cost local execution.
- It knows when a cloud expert is worth using.
- It verifies work before presenting it as done.
- It leaves reusable workflows behind.
- It generates real deliverables, not only text answers.
- It turns each successful task into a team asset.

The positioning should be:

```text
A local-first AI workflow control plane that turns cheap local models
and expensive cloud agents into reliable, auditable, pay-per-task outcomes.
```

### 16.5 Optimization Principles

Use these as system-level design constraints:

- Local-first, cloud-when-needed.
- Workflow-first, chat-second.
- Policy-bounded dynamic workflows.
- One logical tool, many implementations.
- Cloud agents never own final authority.
- Every result has provenance.
- Verification is a core product feature, not an optional add-on.

### 16.6 Local-First, Cloud-When-Needed

Default to the cheapest and most private path:

```text
Mode 0 direct answer
-> local model
-> local host tools
-> local sandbox
-> Cloud Tier 1 expert
-> Cloud Tier 2 worker
-> Cloud Tier 3 long job
```

Cloud escalation should require a reason:

- Local model failed.
- Confidence is low.
- Strong reasoning is needed.
- Current external information is required.
- Independent sandbox execution is useful.
- Long-running work should leave the local machine.
- Provider-native skills are required.

### 16.7 Workflow-First, Chat-Second

Simple requests can remain direct chat/API calls.

Any request involving tools, files, artifacts, verification, approvals, retries, cloud escalation, or repeatability should become a workflow run.

This creates the product distinction:

```text
Chat products return answers.
The harness returns verified workflow outcomes.
```

### 16.8 Verification Is the Moat

The system should not only produce outputs; it should verify them.

Verification examples:

| Domain | Verification Gate |
|---|---|
| Code | Patch applies, tests pass, lint passes, build succeeds |
| Docs | Links valid, references present, formatting renders |
| Office | File opens, slides render, formulas calculate, layout checks pass |
| Research | Sources cited, sources cross-checked, dates verified |
| Ecommerce | Required fields present, platform rules checked |
| Video/content | Script length, platform format, asset availability |

The verification result should become part of the artifact provenance and run ledger.

### 16.9 Cost and Latency Optimizer

Cost control is a product feature.

The router should optimize:

- Cheapest viable model first.
- Local execution before cloud execution.
- Read-only hosted tools before sandbox jobs.
- Tier 1 advice before Tier 2 execution.
- Tier 2 short worker before Tier 3 long job.
- Budget-aware context packing.
- Early stopping when success criteria are met.

Every escalation should record:

- Reason.
- Expected value.
- Cost estimate.
- Runtime estimate.
- Privacy impact.

### 16.10 Trust and Preview

Users should be able to see and understand:

- What context will be sent to cloud.
- Which files are included.
- Which files are excluded.
- Which tools are allowed.
- Which provider will be used.
- Maximum budget.
- Maximum cloud tier.
- What approval gates exist.

For sensitive workflows, the harness should provide a preflight preview before cloud execution.

### 16.11 Outcome Over Model Choice

Provider choice should be an implementation detail unless the user explicitly asks.

The product should optimize for:

- Task completion.
- Verification.
- Cost.
- Privacy.
- Latency.
- Artifact quality.

The user should not need to know whether a step used OpenAI, Claude, a local model, a self-hosted runner, or a custom tool.

## 17. Control Plane Primitives

> **[MIGRATED → `alpha-platform/docs/design.md` §7]** Context Pack, policy & capability
> tokens, run ledger, verification gates, artifact provenance, and the sync/merge model
> moved to the cloud control-plane design. The **run ledger is now dual-path** per
> ADR-013; the eval system (§17.7) and pack ecosystem (§17.8) are **deferred post-MVP**
> (Part 0 §0.7).

## 18. API, SDK, and CLI

### 18.1 Canonical API

> **[See Part 0.2 / 0.5]** Do not build a fresh `/v1/*` for sessions/tools/events
> — `@opencode-ai/sdk` already exposes them. The sidecar adds only the missing
> routes (context-pack preview, `cloud.dispatch` ingress, run-ledger views).

The API is the stable contract between:

- Local harness.
- Tool broker.
- Remote tools.
- Remote agent workers.
- Job runner.
- UI.
- CLI.
- SDKs.

Example local API:

```http
POST http://127.0.0.1:8765/v1/tools/invoke
POST http://127.0.0.1:8765/v1/tasks
POST http://127.0.0.1:8765/v1/workflows/runs
GET  http://127.0.0.1:8765/v1/workflows/runs/:id
GET  http://127.0.0.1:8765/v1/workflows/runs/:id/events
POST http://127.0.0.1:8765/v1/workflows/runs/:id/delegate
POST http://127.0.0.1:8765/v1/context-packs
GET  http://127.0.0.1:8765/v1/context-packs/:id/preview
GET  http://127.0.0.1:8765/v1/runs/:id/ledger
POST http://127.0.0.1:8765/v1/verification-gates/run
GET  http://127.0.0.1:8765/v1/artifacts/:id
GET  http://127.0.0.1:8765/v1/jobs/:id/events
GET  http://127.0.0.1:8765/v1/jobs/:id/result
```

### 18.2 SDK

SDKs wrap the API for application developers.

Example:

```ts
await harness.tools.invoke("web.search", { query })

const run = await harness.workflows.run("bugfix.workflow", {
  objective: "Fix failing auth tests",
  workspace: "current"
})

await harness.tasks.delegate({
  mode: "mode3",
  cloudTier: "tier2",
  agent: "code-agent",
  objective: "Fix failing auth tests"
})
```

Recommended SDKs:

- TypeScript first.
- Python second.

### 18.3 CLI

CLI is for people, scripts, CI, and debugging.

Example:

```bash
agentctl tool invoke web.search --query "OpenAI hosted shell docs"
agentctl workflow run bugfix.workflow "fix failing tests"
agentctl task run --mode mode3 --cloud-tier tier2 --agent code-agent "fix failing tests"
agentctl job watch job_123
```

The CLI should call the same API as the SDK and UI.

## 19. Embeddability and Plugin Distribution

> **[DRIFT — see Part 0.7]** Embedding into Cursor/VS Code/JetBrains/Slack/Teams/
> GitHub/browser/CI conflicts with NON_GOAL #6 (Mac desktop only). Defer this
> whole section to "Future / Out of Current Scope."

The harness should not only work through its own UI or CLI. It should be embeddable into other host applications such as Cursor, Workbuddy, VS Code, JetBrains IDEs, Slack, Teams, GitHub, browsers, Raycast, and CI systems.

This expands the product from an app into a workflow backend:

```text
Host app
-> collects host-specific context
-> calls harness API or SDK
-> creates a workflow run
-> streams events and artifacts
-> applies approved results back into the host
```

### 19.1 Core Principle

Plugins should be thin.

```text
Host apps collect context.
Harness owns workflow execution.
Plugins display progress and apply results.
```

Do not reimplement agents, workflow routing, cloud escalation, budget policy, or tool permissions separately inside each plugin.

### 19.2 Embedding Architecture

```mermaid
flowchart TD
  C["Cursor Plugin"] --> API["Harness API / SDK"]
  W["Workbuddy Plugin"] --> API
  V["VS Code Extension"] --> API
  J["JetBrains Plugin"] --> API
  S["Slack / Teams Bot"] --> API
  G["GitHub App"] --> API
  B["Browser Extension"] --> API
  CI["CI Adapter"] --> API

  API --> H["Harness Core"]
  H --> WF["Workflow Engine"]
  H --> TB["Tool Broker"]
  H --> CP["Context Pack Builder"]
  H --> PR["Policy Router"]
  H --> CR["Cloud Router"]
  H --> AS["Artifact Store"]
  H --> RL["Run Ledger"]
```

### 19.3 Integration Surfaces

Provide three access layers:

| Surface | Primary Users | Purpose |
|---|---|---|
| Local API | IDE plugins, CLI, Raycast, local tools | Call the local harness daemon |
| Cloud API | Workbuddy, Slack, GitHub App, web app, teams | Run cloud-hosted workflows and jobs |
| SDK / Plugin Kit | Third-party developers | Build integrations without reimplementing protocol details |

Example:

```http
POST http://127.0.0.1:8765/v1/workflows/runs
POST https://api.example.com/v1/workflows/runs
GET  /v1/workflows/runs/:id/events
GET  /v1/artifacts/:id
```

### 19.4 Host Context Contract

Host applications should pass structured context instead of raw unbounded data.

```ts
type HostContext = {
  host: "cursor" | "vscode" | "jetbrains" | "workbuddy" | "slack" | "github" | "browser" | "ci"
  workspace?: WorkspaceRef
  currentFile?: FileRef
  selection?: TextSelection
  diagnostics?: Diagnostic[]
  gitDiff?: string
  issue?: IssueRef
  pullRequest?: PullRequestRef
  conversation?: ConversationRef
  files?: FileRef[]
  userIntent: string
}
```

The harness converts host context into a context pack, applies policy, and decides whether the run stays local or escalates to cloud.

### 19.5 Plugin Responsibilities

Plugins should handle:

- Context collection from the host.
- Workflow run creation.
- Event streaming UI.
- Approval prompts.
- Artifact previews.
- Patch/diff display.
- Applying approved changes back to the host.

The harness should handle:

- Workflow planning and execution.
- Mode and cloud tier routing.
- Context packing and redaction.
- Tool authorization.
- Provider routing.
- Cost control.
- Verification.
- Run ledger.
- Artifact provenance.

### 19.6 Example: Cursor Plugin

```text
Cursor Plugin
-> collect current file, selection, diagnostics, git diff
-> call local harness API
-> create bugfix.workflow or code-review.workflow
-> stream workflow events
-> show proposed patch and verification result
-> apply patch only after user approval
```

### 19.7 Example: Workbuddy Plugin

```text
Workbuddy Plugin
-> collect team task, document, conversation, or project context
-> call cloud workflow API
-> run research, office-report, or project-summary workflow
-> stream events to the workspace
-> return artifacts such as report.md, deck.pptx, or summary doc
```

### 19.8 Host-Specific Risk

Each host has different risks and must still use the same policy and capability-token system.

| Host | Main Risk |
|---|---|
| Cursor / VS Code / JetBrains | Local source code and filesystem access |
| Workbuddy | Enterprise documents and team data |
| Slack / Teams | Message privacy and multi-user approvals |
| GitHub App | Repository permissions and PR write access |
| Browser extension | Page injection and account/session data |
| CI adapter | Secrets, deploy permissions, and production access |

Plugins must not bypass the Host Tool Broker, policy engine, context pack preview, run ledger, or approval gates.

### 19.9 Product Expansion

The standalone harness can serve individual users. Embeddable plugins expand usage to wherever work already happens.

This turns the product into:

```text
AI workflow backend for other AI tools and work surfaces.
```

## 20. Policy Router · 21. Security and Governance · 22. Artifacts

> **[MIGRATED → `alpha-platform/docs/design.md` §9, §10, §11]** Policy router, security
> & governance, and artifacts moved to the cloud control-plane design. Security was
> **rewritten for an untrusted multi-tenant trust domain** (Part 0 §0.6) — the cloud
> re-enforces policy rather than trusting the local side — and the **Box egress
> limitation** (ADR-011) was added. Policy router was rewritten off the three-axis model.

## 23. Suggested MVP

### Phase 1: Local Harness, Workflow Engine, and Tool Broker

Build:

- Local daemon/API.
- Workflow spec registry.
- Workflow run state store.
- Basic workflow runner.
- Context pack builder and preview.
- Run ledger.
- Policy and capability token model.
- Tool registry.
- Tool invocation envelope.
- Permission model.
- Audit log.
- Local repo tools.
- Local sandbox executor.
- One local model adapter.

### Phase 2: Cloud Tier 1 Expert

Build:

- `ask_expert` tool.
- OpenAI expert adapter.
- Claude expert adapter.
- Context packer.
- Structured response parser.
- Budget and provider routing.

### Phase 3: Cloud Tier 2 Worker

Build:

- Repo snapshot packer.
- Remote executor interface.
- Ephemeral sandbox runner.
- Patch result contract.
- Verification gates.
- Sync, merge, and conflict handling.
- Local apply-and-verify flow.

### Phase 4: Skills and Plugins

Build:

- Skill registry.
- Skill loader.
- Workflow pack registry.
- One or two official workflow packs.
- Basic workflow pack eval cases.
- Office/document skill integration.
- Plugin/capability-pack format.
- MCP adapter.

### Phase 5: Embeddability and Plugin Kit

Build:

- Host context contract.
- Local API client for plugins.
- Event streaming SDK.
- Approval UI hooks.
- Artifact preview hooks.
- Patch/diff application hooks.
- One IDE plugin prototype.
- One collaboration or web plugin prototype.

### Phase 6: Cloud Tier 3 Jobs

Build:

- Job API.
- Event stream.
- Persistent remote workspace.
- Checkpoints.
- Approval callbacks.
- Resume/cancel.

## 24. Key Interfaces

### 24.1 Workflow Runner

```ts
interface WorkflowRunner {
  createRun(spec: WorkflowSpec, input: unknown, policy: WorkflowPolicy): Promise<WorkflowRunId>
  startRun(runId: WorkflowRunId): Promise<void>
  getRun(runId: WorkflowRunId): Promise<WorkflowInstance>
  streamEvents(runId: WorkflowRunId): AsyncIterable<WorkflowEvent>
  delegateStep(runId: WorkflowRunId, stepId: string, target: DelegationTarget): Promise<JobId | WorkflowRunId>
  cancelRun(runId: WorkflowRunId): Promise<void>
}
```

### 24.2 Remote Executor

```ts
interface RemoteExecutor {
  createWorkspace(snapshot: WorkspaceSnapshot): Promise<WorkspaceId>
  runTask(workspaceId: WorkspaceId, task: TaskSpec): Promise<TaskResult>
  streamEvents(jobId: JobId): AsyncIterable<JobEvent>
  downloadArtifacts(jobId: JobId): Promise<Artifact[]>
  destroyWorkspace(workspaceId: WorkspaceId): Promise<void>
}
```

### 24.3 Expert Adapter

```ts
interface ExpertAdapter {
  ask(input: ExpertRequest): Promise<ExpertResponse>
}
```

### 24.4 Tool Router

```ts
interface ToolRouter {
  invoke(toolName: string, input: unknown, context: ToolCallContext): Promise<ToolResult>
}
```

### 24.5 Agent Runner

```ts
interface AgentRunner {
  run(agent: AgentSpec, task: TaskSpec, context: RunContext): Promise<AgentResult>
}
```

### 24.6 Host Integration Adapter

```ts
interface HostIntegrationAdapter {
  host: "cursor" | "vscode" | "jetbrains" | "workbuddy" | "slack" | "github" | "browser" | "ci"
  collectContext(): Promise<HostContext>
  createWorkflowRun(context: HostContext, workflow?: string): Promise<WorkflowRunId>
  streamEvents(runId: WorkflowRunId): AsyncIterable<WorkflowEvent>
  requestApproval(action: ApprovalRequest): Promise<ApprovalDecision>
  previewArtifact(artifact: Artifact): Promise<void>
  applyResult(result: WorkflowResult): Promise<void>
}
```

## 25. Final Architecture Principle

The local harness is the operating system.

Workflows are the user-facing task layer.

Workflow packs are how vertical scenarios are delivered without hard-coding industries into the core harness.

Context packs are the privacy and relevance boundary.

Policies and capability tokens are the permission boundary.

Agents are replaceable workers.

Tools are brokered capabilities.

Skills are reusable expertise.

Plugins are distribution bundles.

Jobs are durable remote executions.

Cloud jobs are one way to run workflow instances remotely.

Host application plugins are entry points, not separate agent systems.

The run ledger is the system memory for audit, billing, replay, and trust.

Verification gates and artifact provenance turn model output into reliable outcomes.

Providers are backend implementations, not product architecture.

The product promise is reliable, auditable, pay-per-task outcomes from local-first workflows and cloud escalation when needed.
