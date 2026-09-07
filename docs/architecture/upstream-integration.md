---
title: Alpha Code upstream integration
kind: architecture
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-09-06
review_after: 2026-12-06
---

# Upstream integration

## Branch and synchronization model

The repository is a fork. The `dev` lineage is the upstream integration base;
Alpha delivery occurs on the Alpha branch. The
[`sync-upstream.yml`](../../.github/workflows/sync-upstream.yml) workflow and
[`alpha-ci.yml`](../../.github/workflows/alpha-ci.yml) are the executable source
of truth for protected paths and synchronization gates.

`#899` (SEC): the daily sync is split across two trust domains.
[`sync-upstream.yml`](../../.github/workflows/sync-upstream.yml) is the untrusted
candidate — `permissions: contents: read`, no reference to `secrets.SYNC_TOKEN`
anywhere in the file, every `actions/checkout` uses `persist-credentials: false`.
It merges upstream `dev` into `alpha`, runs every guard/tripwire and the engine
smoke test, and only on success packages the resulting commits into an immutable
git-bundle artifact. [`sync-upstream-push.yml`](../../.github/workflows/sync-upstream-push.yml)
is the privileged half — `permissions: contents: write`, triggered by
`workflow_run` only when the candidate reports `success` — and only downloads,
verifies (exact commit-sha match), and pushes that bundle. It never executes any
code from the merged tree, so the push token is never in the same process as
code sourced from `anomalyco/opencode`.

`packages/app` and `packages/ui` are not ordinary upstream mirrors. Under
ADR-034 (B: monthly pin + patch) they are a **projection** of the upstream pin
recorded in [`frontend/frontend-pin.lock`](../../frontend/frontend-pin.lock)
plus the single Alpha SOT patch
[`frontend/alpha-patches/alpha-frontend.patch`](../../frontend/alpha-patches/alpha-frontend.patch).
After every merge, `apply_alpha_frontend_delta` rebuilds them
(`rm -rf` → `git checkout <pin> --` → `git apply --3way`) and must preserve the
typed `AppSurfaces` seam, the REQ-088 narrow export, and the vendored client
tarball; each is a loud-fail. The frontend only moves forward through the
monthly bump described in [`frontend/README.md`](../../frontend/README.md).

### Step order on the conflict path is load-bearing (`#1272`)

`packages/session-ui/package.json` depends on the vendored client tarball
directly (`"@opencode-ai/client": "file:../app/vendor/<name>.tgz"`), and that
binary exists **only inside the SOT patch** — the pin has no
`packages/app/vendor` at all (measured 2026-09-06:
`git ls-tree 849c2598 packages/app/vendor` prints nothing). So any `bun install`
that runs before `apply_alpha_frontend_delta` re-applies the patch is looking at
a tree where the file it needs is absent, and it dies with
`… failed to resolve`.

Until `#1272` the conflict branch did exactly that — it resolved conflicts by
checking out the bare pin, then ran `bun install`, and only afterwards re-applied
the patch. That path was therefore **structurally unusable**, and the
`VENDORED` loud-fail written for precisely this case (it names the exact file and
points at `git diff --binary` / the monthly bump) never got the chance to print.
The judgement was right; the order was wrong.

The order is now: conclude the merge → `apply_alpha_frontend_delta` → `bun install`
→ commit the regenerated `bun.lock`. The lockfile step is not optional: the
conflict branch resolves `bun.lock` with `--theirs`, i.e. upstream's copy, which
does not contain Alpha's workspace packages; only an install that runs against
the final tree regenerates a lockfile that matches what gets pushed.

The gate is
[`packages/ui-mac/src/main/sync-upstream-merge-order.test.ts`](../../packages/ui-mac/src/main/sync-upstream-merge-order.test.ts).
It parses that step's `run` body out of the workflow with `Bun.YAML`, executes it
with `bash -e` (what Actions uses for a `run:` with no `shell:` key) against a
real throwaway git repository, and observes a stub `bun` that records whether the
vendored asset was on disk at the moment install was called. Two of its nine
cases are **mutation arms**: they swap the two lines back to the pre-`#1272`
order and assert the same fixture dies with `failed to resolve` and prints no
`::error::` at all — the gate is proven to detect the known-bad before it is
trusted about the unknown-good.

## Sovereignty ladder

ADR-029 defines the only supported ways to change upstream behavior:

| Level | Mechanism | Rule |
|---|---|---|
| L0 | Alpha-owned seam | default; add through plugin/tool/MCP/sidecar/config/owned package |
| L1 | Build/runtime transform | upstream source stays byte-identical |
| L2 | Mechanical patch | apply in build/restore; failure must block loudly |
| L3 | Frozen takeover | named path exits sync and accepts full maintenance cost |

There is no direct-edit level for a still-synchronized file. Moving a path to
L2 or L3 requires an accepted ADR naming scope, guard, rollback, and ownership.

## Shell-level registrations when Alpha replaces an upstream leaf

Upstream keeps command registrations (`command.register`) inside the page leaves
and inside the legacy layout. `command.trigger(id)` is
`optionMap.get(id)?.onSelect?.()` — an **unregistered id returns silently**. So
when Alpha takes over a leaf (REQ-085/086/125 replaced `home`, `new-session` and
`session`), every shell-level registration that leaf carried disappears, and any
entry still pointing at it becomes a control that does nothing and reports
nothing. The failure surface is **per route**: the same entry can work on one
route and be dead on another.

**Rule.** Replacing an upstream leaf requires an explicit decision for every
shell-level registration it carried — inherit (re-register in the Alpha shell),
retire (delete the entry as well), or restore. Alpha's UI must not contain a
clickable entry pointing at an unregistered command. The judgement is enumerated
**per entry**, not per command — but that enumeration is a **hand-maintained list
of known entries**, not something the gates derive. Nothing here discovers a new
non-menu UI entry on its own: the Settings shortcut table (the 11th class) was
found by a human reading the code, not by a gate going red. Adding a UI control
that points at a command means adding it to the table below and to the gate.

Current disposition (REQ-126 AC7):

| Entry | Command | Disposition |
|---|---|---|
| Sidebar account menu → Settings | `settings.open` | Inherited: calls the Alpha settings surface directly, route-independent |
| Sidebar search | `command.palette` | Inherited: registered once by `AlphaSessionSearch` on the shell |
| Settings → Shortcuts list | `settings.open`, `command.palette`, `project.open`, `session.new` | Kept, but only ids the Alpha shell registers: upstream applies a custom keybind **only to a registered option**, so a retired id left in that table would be editable, saveable and inert |
| Sidebar new chat / open project / collapse | `session.new`, `project.open`, `sidebar.toggle` | Inherited: registered once by `AlphaSidebar` on the shell, so the desktop menu and its accelerators reach the same handlers on every route |
| Empty-project state → Open project | `project.open` | Re-wired to Alpha's own directory picker (upstream's command only fed upstream's project list) |
| Sidebar back / forward buttons | — | Kept as-is. They never went through the command bus (`navigate(±1)` directly), so they work on every route; they are the entry for this capability |
| Floating terminal / review toggles | `terminal.toggle`, `review.toggle` | Retired with the buttons; the session workspace top bar owns the live equivalents |
| Composer permission tier "full auto" | `permissions.autoaccept.*` | Retired; the ids never existed upstream and the submit layer only branches on `readonly` |
| Desktop menu: terminal / file tree / previous·next session / previous·next project | `terminal.toggle`, `fileTree.toggle`, `session.previous`, `session.next`, `project.previous`, `project.next` | Retired from the published menu (`packages/ui-mac/src/shared/desktop-menu-policy.ts`); reviving them needs an Alpha-owned ordering model or panel handle, i.e. a new capability |
| Desktop menu: Back / Forward | `common.goBack`, `common.goForward` | Retired from the published menu. Upstream's Titlebar registers the same ids and wins on home / new-session (`AppInterface` renders injected children before the route shell, and a duplicate id keeps the first registration), and it drives a **private** history whose stack is `["/"]` after returning from a session — so the menu item was a no-op on some routes and someone else's handler on others. Reviving it means taking over that private history first |
| Upstream titlebar `home.toggle` / `tab.*` | — | Not inherited. They are upstream's own controls, registered by the component that renders them, and Alpha adds no entry of its own: home is the sidebar brand button and the tab strip is hidden |

Gates are runtime, not source text.
`packages/ui-mac/src/renderer/sidebar/shell-commands.test.ts` mounts the real
shell (production `AlphaSidebar` + `AlphaSettings` + `AlphaSessionSearch`) and,
for **some** of the entries above, clicks the real control and asserts an
observable result — settings surface in the DOM, the directory picker actually
called, the real router moving, the retired DOM absent while its container is
still present. Which entries get a click, and which only get a weaker assertion,
is listed below rather than left to be assumed.
`packages/ui-mac/src/main/desktop-menu-publication.test.ts` builds the real
native menu and clicks **every** item, asserting the set of command ids it can
emit is exactly the published set.

Known not covered by those gates, stated rather than implied:

- A **new** UI entry pointing at a command is not discovered by anything. The
  shell gate walks a hand-written list of known entries; a control added
  elsewhere in Alpha's UI is simply absent from it and stays green.
- The sidebar back / forward buttons have **no behavioural case**. The gate only
  asserts the top-left toolbar exists with its three buttons; nothing clicks
  them and observes navigation. (An earlier attempt was removed: upstream's
  persisted tab state leaks across test files, so the route it navigated to
  bounced back to `/` depending on which tests ran before it.)
- Keyboard accelerators are asserted only as registration (a registered option
  carries the keybind); no gate presses the physical chord end to end.
- The desktop-menu gate stops at `deps.trigger(id)` in the main process. The IPC
  hop to the renderer (`sendMenuCommand` → `command.trigger`) is not exercised.
- The Settings shortcut table is asserted for its **contents** (no retired id,
  every listed id registered); saving a custom keybind and observing it take
  effect is not exercised.
- "Every published menu id is registered" does not say **whose** registration
  answers it — an upstream registration satisfies it too. That is why an id
  upstream also registers (Back/Forward) is judged by reading which registration
  wins, and retired outright, rather than by that assertion.

## Colliding global declarations: `window.api` (#932)

`ui-mac` compiles Alpha source and upstream `packages/app` in **one TypeScript
program**, and both declare the same global property:

| Declared in | Shape |
|---|---|
| `packages/ui-mac/src/renderer/env.d.ts` (Alpha) | `api: ElectronAPI` — the full preload surface, ~160 renderer call sites |
| `packages/app/src/app.tsx` (upstream), reaching `ui-mac` as the project-reference output `.ts-dist/src/app.d.ts` | `api?: { setTitlebar?; exportDebugLogs? }` — minimal, wholly optional |

Both declaration sites are `.d.ts` inside `ui-mac`'s program, so `skipLibCheck:
true` swallows the `TS2717` that the merge conflict would otherwise report at
one of them. **Nothing goes red at the declaration.** The merged
`Window["api"]` simply takes whichever declaration entered the program first.

Measured on 2026-08-11/12: adding a single `import type … from
"@opencode-ai/app"` anywhere that enters the program before `env.d.ts` flips the
winner to upstream and produces **381 `error TS`** at unrelated renderer
`window.api` call sites (`TS2339` + `TS18048` + `TS7006`). The fingerprint is
"huge error count, concentrated in code the change never touched" — it reads as
if the author broke the renderer. `#926` could only route around it.

Two things pin it down:

1. `packages/ui-mac/tsconfig.json` lists `"files": ["src/renderer/env.d.ts"]`.
   `files` entries are expanded ahead of `include`, so the Alpha declaration is
   always root file #0 and always wins the merge.
2. `packages/ui-mac/src/main/tabs-preclean-contract.ts` reproduces the hazard on
   purpose (it genuinely imports the upstream root export for the tab-shape
   drift gate) and asserts what the merge actually produced —
   `Window["api"]` still assignable to `ElectronAPI`, still non-optional, and
   still carrying Alpha-only keys. Those assertions must stay in a `.ts` file;
   inside a `.d.ts` `skipLibCheck` would swallow them too.

`compilerOptions.types` is **not** an alternative lever: type reference
directives are processed *after* root files, so moving the declaration into a
`typeRoots` package leaves upstream winning (measured: still red).

## Verification

Run the repository synchronization/CI gates and:

```bash
bash scripts/verify-freeze-restore.sh
bash scripts/alpha-check.sh
```

Do not infer protected paths from old plans or design documents.
