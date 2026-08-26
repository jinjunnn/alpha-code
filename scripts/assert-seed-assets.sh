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
# `#1115`:频道图标是**生成物** —— scripts/copy-icons.ts 在 prebuild 里把
# icons/<channel>/ 铺进 $res/icons,内容随 OPENCODE_CHANNEL 变,已移出版本控制。
# CI 的 seed-assets job 跑的是裸 checkout(不构建)⇒ 本守卫只能断言它的**输入**。
icons_src="$root/packages/ui-mac/icons"
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
# `#1115`:此处原为 `need_file "$res/icons/icon.icns"`,而那份字节是 copy-icons.ts 的产物。
# 移出版本控制后它在裸 checkout 上不存在,断言产物会让这道门恒红;改断言**输入**,
# 并按频道逐个点名 —— 原来只罩得住「碰巧躺在 resources/ 里的那一个频道」。
for ch in dev beta prod; do
  need_file "$icons_src/$ch/icon.icns"    # mac app icon(electron-builder.config.ts mac.icon)
done

# ── REQ-105 (#197) / REQ-135 (#1012) Office retirement guard ───────────────────────────────
# Word/PPT MCP 上游已归档(2026-03-03,不再维护 → 供应链风险):归档连接器不得以任何形态回流
# 离线 seed(内置 catalog 快照)或出厂 office-docs 技能的推荐面。社区 Excel 不再有审计锁定安装路径:
# Desktop 的随包退役事实必须在场,出厂技能必须明说不可安装。签名快照在 alpha-web#155
# 落地前可以如实保留 mcp:excel 字节;快照只能由 sync-catalog-snapshot.mjs 刷新,本守卫不改写它。
seed_catalog="$root/packages/ui-mac/src/renderer/extensions/alpha-catalog.json"
office_skill="$res/factory-skills/office-docs/SKILL.md"
advisories_ts="$root/packages/ui-mac/src/shared/office-advisories.ts"
need_file "$seed_catalog"
need_file "$advisories_ts"
need_file "$res/office-mcp/server.py"     # REQ-133 bundled Alpha office stdio server

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

# REQ-135:随包表是退役拒绝事实,不是兼容性钉版。签名快照仍如实包含旧条目时,
# 不得因此复活 EXCEL_MCP_PIN 安装路径。
if grep -qF 'export const EXCEL_MCP_PIN' "$advisories_ts"; then
  echo "::error::REQ-135: retired community Excel audit pin reappeared in office-advisories.ts"
  fail=1
fi
for fact in 'catalogId: "mcp:excel"' 'name: "excel-mcp-server"' 'kind: "retired"'; do
  if ! grep -qF -- "$fact" "$advisories_ts"; then
    echo "::error::REQ-135: bundled community Excel retirement fact missing: $fact"
    fail=1
  fi
done
if ! grep -qF 'connector is retired and is not an install option' "$office_skill"; then
  echo "::error::REQ-135: factory skill no longer says community Excel is retired and unavailable"
  fail=1
fi

if [ "$fail" = 0 ]; then
  echo "✓ seed/vendored resources present"
else
  echo "Fix: restore the deleted asset (git checkout), or update electron-builder.config.ts + this guard together if the layout changed on purpose."
  exit 1
fi
