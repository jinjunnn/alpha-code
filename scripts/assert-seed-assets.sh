#!/usr/bin/env bash
# B7 — assert alpha's seed / vendored resources are present before packaging.
#
# electron-builder.config.ts ships these via `extraResources`; a silent deletion (a refactor, an
# upstream sync, a bad merge) would otherwise produce a package that is broken at runtime (missing
# vendored agent/plugin, no builtin skills) or LICENSE-NON-COMPLIANT (missing NOTICE.txt, B15) —
# and neither typecheck nor unit tests catch it. This guard fails loud instead.
#
# Source-tracked assets ONLY. Build outputs (packages/ext/dist → alpha-ext/) are produced by the
# build step, not committed, so they are asserted by the build itself, not here.
#
# Used by alpha-ci (seed-assets job) and safe to call from the release pipeline (package:mac) too.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
res="$root/packages/ui-mac/resources"
fail=0

# GitHub Actions renders `::error::` as an annotation; harmless plain text locally.
miss() {
  echo "::error::seed asset missing/empty: ${1#"$root"/}"
  fail=1
}
need_file() { [ -s "$1" ] || miss "$1"; }
need_dir() { { [ -d "$1" ] && [ -n "$(ls -A "$1" 2>/dev/null)" ]; } || miss "$1"; }

need_dir "$res/skills"                    # builtin skills (installable via 定制中心)
need_file "$res/skills/skill-creator/SKILL.md"       # REQ-036 出厂技能(skills.paths 原位引用)
# 出厂技能基线(REQ-082 时点 = 7 件,与 factory-skills.ts FACTORY_SKILL_IDS 一致;skill-creator 在上面)
for fs in agent-creator customize-alpha integrate-project alpha-workspace cloud-dispatch office-docs; do
  need_file "$res/factory-skills/$fs/SKILL.md"
done
need_file "$res/agents/code-reviewer.md"  # REQ-023 vendored agent (zero-network install)
need_dir "$res/plugins/opencode-notify"   # REQ-023 vendored plugin (self-contained JS)
need_file "$res/NOTICE.txt"               # B15 MIT / third-party attribution — license compliance
need_file "$res/entitlements.plist"       # mac signing entitlements
need_file "$res/icons/icon.icns"          # mac app icon

if [ "$fail" = 0 ]; then
  echo "✓ seed/vendored resources present"
else
  echo "Fix: restore the deleted asset (git checkout), or update electron-builder.config.ts + this guard together if the layout changed on purpose."
  exit 1
fi
