#!/usr/bin/env bash
# B7 — assert alpha's seed / vendored resources are present before packaging.
#
# electron-builder.config.ts ships these via `extraResources`; a silent deletion (a refactor, an
# upstream sync, a bad merge) would otherwise produce a package that is broken at runtime (missing
# vendored agent, no builtin skills) or LICENSE-NON-COMPLIANT (missing NOTICE.txt, B15) —
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
need_file "$res/NOTICE.txt"               # B15 MIT / third-party attribution — license compliance
need_file "$res/entitlements.plist"       # mac signing entitlements
need_file "$res/icons/icon.icns"          # mac app icon

# ── REQ-105 (#197) Office 纠偏守卫 ───────────────────────────────────────────────────────────
# Word/PPT MCP 上游已归档(2026-03-03,不再维护 → 供应链风险):归档连接器不得以任何形态回流
# 离线 seed(内置 catalog 快照)或出厂 office-docs 技能的推荐面;Excel 连接器只允许审计锁定的
# 精确版本(单一真源 = src/shared/office-advisories.ts 的 EXCEL_MCP_PIN,这里机械提取防双写漂移)。
seed_catalog="$root/packages/ui-mac/src/renderer/extensions/alpha-catalog.json"
office_skill="$res/factory-skills/office-docs/SKILL.md"
advisories_ts="$root/packages/ui-mac/src/shared/office-advisories.ts"
need_file "$seed_catalog"
need_file "$advisories_ts"

# ADR-040 / #841:engine plugin 已从线上货架与离线快照成对退休。随包字节和 catalog id
# 任一回流都会让离线路径重新展示一个只能被 planner 拒绝的条目。
if [ -e "$res/plugins/opencode-notify" ]; then
  echo "::error::ADR-040: retired opencode-notify bytes reappeared in packaged resources"
  fail=1
fi
for banned in '"plugin:opencode-notify"' 'opencode-notify'; do
  if grep -qF -- "$banned" "$seed_catalog"; then
    echo "::error::ADR-040: retired engine plugin reappeared in the offline catalog: $banned"
    fail=1
  fi
done

for banned in office-word-mcp-server office-powerpoint-mcp-server '"mcp:word"' '"mcp:powerpoint"'; do
  if grep -qF -- "$banned" "$seed_catalog"; then
    echo "::error::REQ-105: archived office connector reappeared in the offline seed catalog: $banned"
    fail=1
  fi
done
# 出厂技能不得再推荐归档连接器(installed-user 处置在 Hub advisory,不在技能文本)
if grep -qE 'office-(word|powerpoint)-mcp-server' "$office_skill" 2>/dev/null; then
  echo "::error::REQ-105: factory skill office-docs recommends an archived connector again"
  fail=1
fi

# Excel 精确锁版:seed catalog 里出现的每一处 excel-mcp-server 引用都必须逐字 = 审计钉版。
# 唯一豁免:`"name"/"displayName": "excel-mcp-server"`(条目名字段本来就不带版本);命令行等
# 其余一切出现处(uvx 参数、mirrorCommand…)裸包名 = uvx 拉 latest,同样按漂移拒绝。
excel_pin="$(grep -oE 'pinnedSpec: "excel-mcp-server@[^"]+"' "$advisories_ts" | head -1 | cut -d'"' -f2)"
if [ -z "$excel_pin" ]; then
  echo "::error::REQ-105: cannot extract EXCEL_MCP_PIN.pinnedSpec from office-advisories.ts (audit record missing?)"
  fail=1
elif grep -q 'excel-mcp-server' "$seed_catalog"; then
  while IFS= read -r ref; do
    if [ "$ref" != "$excel_pin" ]; then
      echo "::error::REQ-105: excel-mcp-server in the seed catalog is not the audited pin ($excel_pin): $ref"
      fail=1
    fi
  done < <(grep -vE '"(name|displayName)"[[:space:]]*:[[:space:]]*"excel-mcp-server"' "$seed_catalog" | grep -oE 'excel-mcp-server[@<>=]?[^" ]*')
fi

if [ "$fail" = 0 ]; then
  echo "✓ seed/vendored resources present"
else
  echo "Fix: restore the deleted asset (git checkout), or update electron-builder.config.ts + this guard together if the layout changed on purpose."
  exit 1
fi
