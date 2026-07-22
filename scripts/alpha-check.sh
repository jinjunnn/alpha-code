#!/usr/bin/env bash
# alpha-check — run the exact gates alpha-ci enforces, LOCALLY, before you push.
#
# Standard: local-first (see docs/runbooks/ci.md). CI is the enforcing backstop, not the place
# you first discover a failure. This mirrors alpha-ci's three jobs 1:1 and runs in seconds.
#
#   bash scripts/alpha-check.sh
#
# Exit 0 = safe to push (CI will mirror this). Non-zero = fix before pushing.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

# REQ-015 self-heal(2026-07-05):husky 的 prepare 在每次 `bun install` 后把 core.hooksPath
# 重置回 .husky/_(其全量 turbo typecheck 在 ADR-020 冻结偏斜下因 session-ui 恒红)。
# 此处幂等重挂 alpha 门,使 .githooks/pre-push(= 本脚本)成为默认 push 门。逃生:ALPHA_HOOKS_DISABLE=1。
if [ "${ALPHA_HOOKS_DISABLE:-}" != "1" ]; then
  git config core.hooksPath .githooks 2>/dev/null || true
fi

# Keep in lockstep with .github/workflows/alpha-ci.yml (env.UPSTREAM_PATHS) and ADR-004.
# ADR-020(REQ-017 修):packages/{app,ui} 已冻结(frontend-freeze-base-2,ADR-027),相对 dev 的 diff 是冻结本意
# → 移出守卫,与 alpha-ci.yml env.UPSTREAM_PATHS 恢复 1:1(此前本地恒假红)。
UPSTREAM_PATHS="packages/opencode packages/core packages/server packages/tui packages/sdk"
fail=0

echo "▶ [1/3] north-star guard (zero upstream edits)"
git fetch --no-tags origin dev --quiet 2>/dev/null || echo "    (warn: could not fetch origin/dev — comparing against last-known origin/dev)"
# committed delta (mirrors CI) ∪ working-tree edits (earlier local feedback)
committed="$(git diff --diff-filter=DMR --name-only origin/dev...HEAD -- $UPSTREAM_PATHS 2>/dev/null || true)"
worktree="$(git diff --diff-filter=DMR --name-only HEAD -- $UPSTREAM_PATHS 2>/dev/null || true)"
changed="$(printf '%s\n%s\n' "$committed" "$worktree" | sed '/^$/d' | sort -u)"
if [ -n "$changed" ]; then
  echo "    ✗ upstream files modified/deleted/renamed (fork-sync would conflict):"
  echo "$changed" | sed 's/^/      /'
  echo "      → revert; extend via alpha files (packages/ext, packages/ui-mac) or seams (ADR-002/005)."
  fail=1
else
  echo "    ✓ zero upstream package edits"
fi

echo "▶ [2/3] typecheck (alpha packages: contracts-consumer + ext + ui-mac)"
# REQ-027:flag 必须在 `run` 之后 —— `bun --cwd X run Y` 在 bun 1.3.x 打印 usage 后静默退出 0(不执行脚本)。
if bun run --cwd packages/alpha-contracts-consumer typecheck \
  && bun run --cwd packages/ext typecheck \
  && bun run --cwd packages/ui-mac typecheck; then
  echo "    ✓ typecheck"
else
  echo "    ✗ typecheck failed"; fail=1
fi

echo "▶ [3/3] contract lock + unit tests (contracts-consumer + ext + ui-mac)"
# REQ-062:ext 测试入门 —— 其中 prompt-rebrand drift 锁逐条断言转写子串仍在上游底座原文,
# 上游 sync 改写底座即红(ADR-015 合并验证的机械化)。
if bun run --cwd packages/alpha-contracts-consumer check:vendor \
  && (cd packages/alpha-contracts-consumer && bun test) \
  && (cd packages/ext && bun test) \
  && bun run --cwd packages/ui-mac test; then
  echo "    ✓ tests"
else
  echo "    ✗ tests failed"; fail=1
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "✅ all local gates green — safe to push (alpha-ci will mirror this in ~40s)."
else
  echo "❌ local gates failed — fix before pushing (alpha-ci would fail the same way)."
fi
exit $fail
