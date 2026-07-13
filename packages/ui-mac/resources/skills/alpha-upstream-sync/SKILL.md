---
name: alpha-upstream-sync
description: Sync opencode upstream into the alpha fork and re-validate alpha's prompt/agent overrides against the refreshed base. Use when pulling upstream, after `git merge dev`, or before shipping a build that includes an upstream bump.
---

# Upstream sync + override re-validation (alpha-code)

alpha-code is a fork of opencode with a zero-edit discipline: own code is *added*, upstream files
are never modified. The North Star is "conflict files = 0" after every sync. This skill walks the
sync and the one check CI cannot do for you.

## 1. Pull upstream into the mirror, then merge
- `gh repo sync jinjunnn/alpha-code --branch dev` — fast-forward the read-only `dev` mirror.
- `git checkout alpha && git merge dev` — bring it into the product branch.
- If git reports a conflict inside any `packages/opencode/**` file, STOP: an upstream file was
  edited locally at some point, which breaks the fork discipline. Fix it by moving the local change
  to a seam (a new file, a plugin, config), not by editing upstream.

## 2. Review the contract diff
A legitimate upgrade only touches two contracts. Diff them across the bump and adapt alpha consumers
only where they changed:
- `git diff <old-dev>..<new-dev> -- packages/sdk/openapi.json packages/plugin/src/index.ts`

## 3. Re-validate prompt/agent overrides — the silent-drift check (ADR-015)
alpha layers behavior on top of opencode's base prompt via *new* files (`alpha-behavior.md`,
`alpha-identity.ts`, `.opencode/agent/*.md`). Drift here produces NO git conflict, so the file-diff
guard is blind to it. Run:
- `git diff <old-dev>..<new-dev> -- packages/opencode/src/session/prompt packages/opencode/src/agent`

If the base prompt or any upstream agent prompt changed, open alpha's override files and reconcile by
hand: does any override now contradict, duplicate, or fight the new base? Tighten or drop it.

## 4. Typecheck + record
- `bun turbo typecheck`
- Record adapted lines and override-reconciliation evidence in the owning PR
  and GitHub Issue.

## Done when
`git diff` of `alpha` vs `dev` contains only added files (plus `bun.lock`); typecheck is green; the
overrides were reconciled against the new base and the outcome is logged.
