---
name: cloud-dispatch
description: Dispatch tasks to the alpha-code cloud platform (research, code review, docs, sandboxed office/data/code jobs) and fetch their results. Use when the user asks to run something "in the cloud" (云端/云上跑), offload a long research or analysis task, review a diff server-side, or create/list/delete a scheduled cloud job.
license: MIT (alpha-code original)
---

# Cloud dispatch

You dispatch bounded jobs to the alpha-code cloud platform and bring results back. The cloud
tools come from the **`cloud` connector** — in your tool list they carry its prefix (search your
tools for `cloud_`): dispatch, status, await, artifacts, schedule_create / schedule_list /
schedule_delete, web_search.

## Availability — check first, never pretend

The cloud connector is only wired when the user is **logged in with platform-pays** (登录即代付).
If no `cloud_*` tools appear in your tool list:

- say so honestly — cloud dispatch is not available right now;
- guide the user to log in from the account menu (BYOK-only and logged-out sessions have model
  access but **no** cloud dispatch);
- do NOT simulate a dispatch or fabricate results.

## Data boundary — read before any dispatch (ADR-021)

Everything you put in an envelope **leaves the user's machine**. Rules:

1. **Diff-only for code.** Never send a whole repository or directory. For code-review, send the
   relevant `git diff` output only (the pipeline truncates around ~12k chars anyway).
2. **No secrets.** Never include contents of `.env*`, `*.pem`, key files, tokens, or anything from
   `.alpha/` or `.git/`. If a diff contains a credential, redact it and tell the user.
3. Dispatches from the Extension Hub additionally pass a hard local guard (256 KiB envelope cap +
   secrets scan). Session dispatches through these tools rely on server-side schema validation
   plus **your** discipline — the two rules above are on you.
4. **Do not send `constraints.denied_paths`.** A cloud job runs arbitrary code inside the sandbox,
   so a path blocklist cannot be enforced there — the platform refuses the whole dispatch with
   `denied_paths_unenforceable_for_execution_form` rather than pretend it works. Rule 2 is the
   protection; a blocklist in the envelope is not.

## The envelope (`cloud_dispatch`)

Two autonomy modes:

- `autonomy: "pipeline"` — fixed server-side pipeline; requires `kind` + `input`.
- `autonomy: "bounded-agent"` — requires `objective` **and** `constraints.allowed_tools`
  (+ optional `capabilities`). Heavier; prefer a pipeline when one fits.

**`constraints.allowed_tools` is mandatory for `bounded-agent`.** An omitted or empty tool list is
read server-side as *no tools at all*: the job starts, burns budget, and finishes having done
nothing. Name the tools the objective actually needs — e.g. `["web"]` for research, or the coding
tools (`["Write", "Bash"]`) for a `code_exec` / `file_mutation` job. If you cannot name them, say so
instead of dispatching.

Pipeline kinds and their `input`:

| kind | input | notes |
|---|---|---|
| `research` | `{question, search?: "native"\|"tavily"\|"brave"}` | web-grounded research with citations |
| `code-review` | `{diff}` | diff-only (see boundary above) |
| `docs` | `{code, type?: "readme"\|…}` | doc generation from code |
| `office-report` | sandboxed | produces .docx/.pptx/.xlsx artifacts |
| `data-analysis` | sandboxed | pandas/matplotlib → charts + report |
| `bugfix` / `migration` | sandboxed | patch/refactor pipelines |

Budget (optional, but set it explicitly for anything nontrivial):
`budget: {max_iter?, max_tokens?, max_wall_clock_sec?}` — defaults 25 iterations / 300k tokens /
600s; hard caps 50 / 500k / 1800s. These are enforced server-side per job.

Example — research dispatch:

```json
{
  "autonomy": "pipeline",
  "kind": "research",
  "input": { "question": "…the user's question, self-contained…" },
  "budget": { "max_tokens": 150000, "max_wall_clock_sec": 300 }
}
```

## Workflow

1. `cloud_dispatch` → returns `{job_id, status: "queued"}` (schema-invalid envelopes are rejected
   with details — fix and retry, don't loop blindly).
2. `cloud_await` with the `job_id` — it polls **at most ~25s per call**; for longer jobs call it
   again (or `cloud_status` for a single snapshot). Terminal states: `completed` / `failed` /
   `cancelled`.
3. `cloud_artifacts` — lists artifact ids + the inline result. Present the result to the user;
   if they want it as a file, write it to disk yourself (their stated path, the current project,
   or `~/Alpha` conventions when no project applies).

Honest reporting: if a job fails or times out, relay the actual status and error — never
summarize a failed job as if it produced results.

## Schedules (recurring cloud jobs)

`cloud_schedule_create {name, cron, tz?, envelope, enabled?}` — the envelope is a normal dispatch
envelope. Limits: minimum interval 5 minutes, max 10 schedules per tenant, tighter budget caps
than one-off jobs. `cloud_schedule_list` shows next fire time and breaker state (3 consecutive
failures trips a breaker); `cloud_schedule_delete {schedule_id}` stops future fires. Runs fired
by schedules are pulled back into the project's `.alpha/runs/` on app launch.

## Where records live

- Hub- and schedule-originated runs leave local audit records under `<project>/.alpha/runs/<runId>/`.
- Session dispatches (these tools) return results inline — nothing is written to disk unless you
  write it. `.alpha/` itself is engine/harness territory; don't create files there.
