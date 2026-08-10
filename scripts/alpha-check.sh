#!/usr/bin/env bash
# alpha-check — run the exact gates alpha-ci enforces, LOCALLY, before you push.
#
# Standard: local-first (see docs/runbooks/ci.md). CI is the enforcing backstop, not the place
# you first discover a failure.
#
#   bash scripts/alpha-check.sh
#
# Exit 0 = safe to push (CI will mirror this). Non-zero = fix before pushing.
#
# ── 「与 alpha-ci 1:1」是一条**可检查的断言**,不是一句自我介绍(`#777`)────────────
# 这句话此前写在三处(本文件抬头、CLAUDE.md、docs/runbooks/ci.md),而实际只跑了
# alpha-ci 十二个代码步里的九个,其中三个还是降级档(裸 `bun test`:跑 0 条照样 exit 0,
# 正是 `#647` 在 CI 上修掉的那个假绿形态)。「本地绿 ⇒ 可以合」这条铁律的全部依据就是
# 这句 1:1 —— 它是散文的时候,那条铁律没有地基。
#
# 现在:下面的 CI_STEPS 是本脚本对 alpha-ci 的**逐步对照表**,脚本结束时会把它打出来;
# packages/ui-mac/src/main/local-gate-parity.test.ts 反过来从 .github/workflows/alpha-ci.yml
# 里枚举出全部代码步,与这张表比对 —— CI 新增一步而这里没登记,即红。
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

# 每行:<alpha-ci job>|<alpha-ci step name>|<本地档位>
# 档位只有三种:MIRRORED(跑同一条命令)、SUPERSET(本地还多验了东西)、
# DEGRADED:<理由>(跑不了/跑的是降级档 —— 必须写清降级了什么)。没有第四种。
CI_STEPS=(
  "upstream-guard|No literal NUL bytes in version-controlled files|MIRRORED"
  "upstream-guard|Fail on any modification to upstream package files|SUPERSET:committed delta ∪ 未提交工作树改动"
  "typecheck|typecheck @alpha-code/contracts-consumer|MIRRORED"
  "typecheck|typecheck @alpha-code/ext|MIRRORED"
  "typecheck|typecheck ui-mac|MIRRORED"
  "test|verify immutable Alpha contract vendor lock|SUPERSET:开发机有兄弟仓 ⇒ 跑的是 provenance 已验档,CI 是降级档(#769)"
  "test|bun test (contracts consumer fixtures)|MIRRORED"
  "test|bun test (ext)|MIRRORED"
  "test|bun test (ui-mac)|MIRRORED"
  "test|assert gate files (逐个点名,整包地板抓不到单文件消失)|MIRRORED"
  "seed-assets|Assert seed/vendored resources present (B7)|MIRRORED"
  "docs-gate|Relative-link validity in changed Markdown|MIRRORED"
)

# REQ-015 self-heal(2026-07-05):husky 的 prepare 在每次 `bun install` 后把 core.hooksPath
# 重置回 .husky/_(其全量 turbo typecheck 在 ADR-020 冻结偏斜下因 session-ui 恒红)。
# 此处仅在值偏离时重挂 alpha 门,使 .githooks/pre-push(= 本脚本)成为默认 push 门,同时
# 让一次健康的 pre-push 连共享 .git/config 的文件身份都不改。逃生:ALPHA_HOOKS_DISABLE=1。
if [ "${ALPHA_HOOKS_DISABLE:-}" != "1" ]; then
  current_alpha_hooks_path="$(git config --local --get core.hooksPath 2>/dev/null || true)"
  if [ "$current_alpha_hooks_path" != ".githooks" ]; then
    git config --local core.hooksPath .githooks 2>/dev/null || true
  fi
  unset current_alpha_hooks_path
fi

# Keep in lockstep with .github/workflows/alpha-ci.yml (env.UPSTREAM_PATHS + the guard's excludes)
# and ADR-004. Drift here is worse than no gate: a permanently-red local guard trains you to ignore it.
# ADR-020(REQ-017 修):packages/{app,ui} 已冻结(frontend-freeze-base-2,ADR-027),相对 dev 的 diff 是冻结本意
# → 移出守卫,与 alpha-ci.yml env.UPSTREAM_PATHS 恢复 1:1(此前本地恒假红)。
# ADR-033(#456):守卫盲区补全 —— permission wire 契约的 SOT 有一半在 protocol/schema/client。
UPSTREAM_PATHS="packages/opencode packages/core packages/server packages/tui packages/sdk packages/protocol packages/schema packages/client"
# 被接管/生成文件的例外,与 alpha-ci.yml 的 `excludes=()` 逐条对齐。新增收编须自己的 ADR,
# 不得静默加 exclude(ADR-029 §3)。此前本地脚本**没有**这张表,自 ADR-033 起对 16 个文件恒报假红。
UPSTREAM_EXCLUDES=(
  # ADR-033 §1 被接管 permission 表面(L3)
  ':(exclude)packages/core/src/permission.ts'
  ':(exclude)packages/core/src/permission'
  ':(exclude)packages/server/src/handlers/permission.ts'
  ':(exclude)packages/opencode/src/server/routes/instance/httpapi/public.ts'
  ':(exclude)packages/core/test/permission.test.ts'
  ':(exclude)packages/core/test/database-migration.test.ts'
  ':(exclude)packages/opencode/test/server/httpapi-exercise'
  ':(exclude)packages/opencode/test/server/httpapi-public-openapi.test.ts'
  # ADR-033 §4 生成/快照(SOT = alpha 拥有的迁移/协议/schema;静态 diff 会误报)
  ':(exclude)packages/core/schema.json'
  ':(exclude)packages/core/src/database/migration.gen.ts'
  ':(exclude)packages/core/src/database/schema.gen.ts'
  ':(exclude)packages/sdk/js/src/v2/gen/sdk.gen.ts'
  ':(exclude)packages/sdk/js/src/v2/gen/types.gen.ts'
  # ADR-033 §守卫盲区(#456 裁决)
  ':(exclude)packages/protocol/src/groups/permission.ts'
  ':(exclude)packages/schema/src/permission.ts'
  ':(exclude)packages/schema/src/agent.ts'
  ':(exclude)packages/schema/test/contract-hygiene.test.ts'
  ':(exclude)packages/client/src/generated/client.ts'
  ':(exclude)packages/client/src/generated-effect/client.ts'
  ':(exclude)packages/client/src/generated/types.ts'
  # ADR-035(#489):E7 web search 失败诚实所需的两文件接管(L3)。上游
  # test/tool/websearch.test.ts **不**接管(#223 修复轮):新增失败测试落 alpha 自有的
  # test/tool/alpha-websearch-failure.test.ts(新增文件不触发 --diff-filter=DMR,无需 exclude)。
  ':(exclude)packages/opencode/src/tool/websearch.ts'
  ':(exclude)packages/opencode/src/tool/mcp-websearch.ts'
  # ADR-035 §1 追加(#223 R3 Blocker 1,2026-07-26):打包 sidecar 同时挂载 V2 Location 服务,
  # core 的 BuiltInTools 里是**第二份已挂载的同名 websearch 注册**。主权最终闸必须覆盖每一份
  # 执行副本,故同类叶子再收一个;接管面仅 execute 首行的闸。
  ':(exclude)packages/core/src/tool/websearch.ts'
  # ADR-038(#668,2026-07-28):v1 审批请求的应答期限。上游 `Permission.ask` 的
  # `Deferred.await` 无超时 ⇒ 无人应答即无限期挂起(ADR-036 把会话发送退回 v1 后成为
  # 高频路径)。期限只能落在 Deferred 所在的这一处;L0 接缝只能改判定、壳侧看门狗会连带
  # 拒绝同会话全部 pending、L1/L2 无法 loud-fail 承载安全语义(逐条证据见 ADR-038 §2)。
  # 接管面刻意压到这一个文件;新增闸门落 alpha 自有的
  # test/permission/alpha-ask-deadline.test.ts(新增文件不触发 --diff-filter=DMR)。
  ':(exclude)packages/opencode/src/permission/index.ts'
  # ADR-041(#878,2026-08-09):工具身份与不可变显示快照。来源信息在这些注册/聚合/
  # 权限/首次写入咽喉之后结构性丢失,L0-L2 无法从 alias 诚实反推。仅逐文件接管;
  # 新的 alpha-tool-identity 闸门是新增文件,无需 exclude。permission/index.ts 已由
  # ADR-038 接管,不重复列。
  ':(exclude)packages/schema/src/v1/session.ts'
  ':(exclude)packages/sdk/js/src/gen/types.gen.ts'
  ':(exclude)packages/opencode/src/mcp/index.ts'
  ':(exclude)packages/opencode/src/plugin/index.ts'
  ':(exclude)packages/opencode/src/tool/registry.ts'
  ':(exclude)packages/opencode/src/tool/code-mode.ts'
  ':(exclude)packages/opencode/src/session/tools.ts'
  ':(exclude)packages/opencode/src/session/processor.ts'
  ':(exclude)packages/opencode/src/session/llm.ts'
  ':(exclude)packages/opencode/src/session/llm/request.ts'
  ':(exclude)packages/opencode/src/session/prompt.ts'
  ':(exclude)packages/opencode/test/session/compaction.test.ts'
  ':(exclude)packages/opencode/test/session/processor-effect.test.ts'
  ':(exclude)packages/opencode/test/session/prompt.test.ts'
  ':(exclude)packages/opencode/test/tool/code-mode-integration.test.ts'
  ':(exclude)packages/opencode/test/tool/code-mode.test.ts'
  ':(exclude)packages/opencode/test/tool/registry.test.ts'
  ':(exclude)packages/core/src/tool/application-tools.ts'
  ':(exclude)packages/core/src/tool/registry.ts'
)
fail=0

echo "▶ [1/7] north-star guard (zero upstream edits)"
git fetch --no-tags origin dev --quiet 2>/dev/null || echo "    (warn: could not fetch origin/dev — comparing against last-known origin/dev)"
# committed delta (mirrors CI) ∪ working-tree edits (earlier local feedback)
committed="$(git diff --diff-filter=DMR --name-only origin/dev...HEAD -- $UPSTREAM_PATHS "${UPSTREAM_EXCLUDES[@]}" 2>/dev/null || true)"
worktree="$(git diff --diff-filter=DMR --name-only HEAD -- $UPSTREAM_PATHS "${UPSTREAM_EXCLUDES[@]}" 2>/dev/null || true)"
changed="$(printf '%s\n%s\n' "$committed" "$worktree" | sed '/^$/d' | sort -u)"
if [ -n "$changed" ]; then
  echo "    ✗ upstream files modified/deleted/renamed (fork-sync would conflict):"
  echo "$changed" | sed 's/^/      /'
  echo "      → revert; extend via alpha files (packages/ext, packages/ui-mac) or seams (ADR-002/005)."
  fail=1
else
  echo "    ✓ zero upstream package edits"
fi

echo "▶ [2/7] no literal NUL bytes in version-controlled files"
# #760:字面 NUL 不会让运行时出错,它坏的是**验证手段** —— BSD grep / rg / file(1) 看到 NUL 就把
# 整个文件判成二进制并静默返回空,于是「我 grep 过了,没有」变成假话。本仓 CLAUDE.md 要求
# 「大文件 Edit 后 grep + git show 双验」,而在这些文件上 grep 会安静地说「没有」。
# 已实证四次(#737 枚举被修正两次、#704 一轮两个实例、建 #760 时命令又混进一个、
# alpha-web#109 差点据零命中断定「测试被删了」)。枚举对新成员默认放行,所以这里立的是咽喉。
if python3 scripts/assert-no-nul-bytes.py; then
  echo "    ✓ no literal NUL bytes"
else
  echo "    ✗ literal NUL bytes found"; fail=1
fi

echo "▶ [3/7] typecheck (alpha packages: contracts-consumer + ext + ui-mac)"
# REQ-027:flag 必须在 `run` 之后 —— `bun --cwd X run Y` 在 bun 1.3.x 打印 usage 后静默退出 0(不执行脚本)。
if bun run --cwd packages/alpha-contracts-consumer typecheck \
  && bun run --cwd packages/ext typecheck \
  && bun run --cwd packages/ui-mac typecheck; then
  echo "    ✓ typecheck"
else
  echo "    ✗ typecheck failed"; fail=1
fi

echo "▶ [4/7] contract lock + unit tests (contracts-consumer + ext + ui-mac)"
# REQ-062:ext 测试入门 —— 其中 prompt-rebrand drift 锁逐条断言转写子串仍在上游底座原文,
# 上游 sync 改写底座即红(ADR-015 合并验证的机械化)。
#
# `#777`:三条测试从裸 `bun test` 换成 scripts/bun-test-floor.sh —— 与 CI 同一条命令、
# 同一个下界。裸 `bun test` 对「文件被清空 / 用例被条件注册成零条 / 指定文件不存在」都会
# 打印 `Ran 0 tests` 并**退出 0**(`#647` 已实测)。CI 早在 #647 就修掉了这个假绿,
# 而本地这道门原样留着 —— 于是「本地绿」在闸门被清空时也成立。
if bun run --cwd packages/alpha-contracts-consumer check:vendor \
  && bash scripts/bun-test-floor.sh 15 packages/alpha-contracts-consumer \
  && bash scripts/bun-test-floor.sh 100 packages/ext \
  && bash scripts/bun-test-floor.sh 3000 packages/ui-mac src; then
  echo "    ✓ tests"
else
  echo "    ✗ tests failed"; fail=1
fi

# `#777`:下面三步此前**本地完全没有**,而 CI 有。缺 [5/7] 尤其贵 —— 登记闸门里
# llm / core / opencode 那几个只在这一步执行,别的步骤一条都不覆盖它们。
echo "▶ [5/7] assert gate files (逐个点名;整包地板抓不到单个闸门文件消失)"
if bash scripts/assert-gate-files.sh; then
  echo "    ✓ gate files"
else
  echo "    ✗ gate files failed"; fail=1
fi

echo "▶ [6/7] seed assets present (B7)"
if bash scripts/assert-seed-assets.sh; then
  echo "    ✓ seed assets"
else
  echo "    ✗ seed assets missing"; fail=1
fi

echo "▶ [7/7] docs gate (relative-link validity in changed Markdown)"
# CI 只查**这次改动过的** Markdown(detect job 收集)。本地口径同构:相对 origin/alpha 的
# 提交 delta ∪ 未提交工作树改动,再滤成 *.md。一个都没有 ⇒ 与 CI 一样是 no-op。
md_committed="$(git diff --name-only --diff-filter=d origin/alpha...HEAD -- '*.md' 2>/dev/null || true)"
md_worktree="$(git diff --name-only --diff-filter=d HEAD -- '*.md' 2>/dev/null || true)"
md_untracked="$(git ls-files --others --exclude-standard -- '*.md' 2>/dev/null || true)"
md_list="$(printf '%s\n%s\n%s\n' "$md_committed" "$md_worktree" "$md_untracked" | sed '/^$/d' | sort -u)"
if [ -z "$md_list" ]; then
  echo "    ✓ no Markdown changed — docs gate is a no-op (与 CI 同)"
else
  # shellcheck disable=SC2086
  if python3 scripts/check-doc-links.py $md_list; then
    echo "    ✓ docs links ($(echo "$md_list" | wc -l | tr -d ' ') 个 Markdown)"
  else
    echo "    ✗ broken relative links"; fail=1
  fi
fi

# ── 覆盖自陈(`#777`)──────────────────────────────────────────────────────────
# 「和 CI 1:1」以前是散文。现在这张表由脚本自己打出来,并由
# packages/ui-mac/src/main/local-gate-parity.test.ts 反向核对(CI 加了步而这里没登记即红)。
echo
echo "── 本脚本对 alpha-ci 的覆盖(${#CI_STEPS[@]}/${#CI_STEPS[@]} 个代码步)──────────────────────"
for row in "${CI_STEPS[@]}"; do
  printf '   %-14s %-58s %s\n' "${row%%|*}" "$(echo "$row" | cut -d'|' -f2)" "${row##*|}"
done
echo "   注:MIRRORED = 同一条命令;SUPERSET = 本地还多验了;DEGRADED = 降级,理由在同一行。"

echo
if [ "$fail" -eq 0 ]; then
  echo "✅ all local gates green — safe to push (alpha-ci will mirror this)."
else
  echo "❌ local gates failed — fix before pushing (alpha-ci would fail the same way)."
fi
exit $fail
