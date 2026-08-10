#!/usr/bin/env bash
#
# alpha-ci 的 `detect` 分类步:把一次变更分成「docs-only」还是「有代码」,并收集改过的
# Markdown 供 docs gate 用。`code` / `md` 两个输出决定 alpha-ci 里**几乎每一步跑不跑**
# (upstream-guard / typecheck / test / seed-assets 的全部步骤都挂在 `code == 'true'` 上,
# docs gate 的入参就是 `md`)。
#
# 为什么它是一个文件而不是 workflow 里的一段内联 shell(`#717`):
#   内联时它**没有任何判据**。断言 YAML 的文本按本仓定义是假闸门,而这段逻辑决定的是
#   「哪些闸门今天到底跑不跑」—— 它自己出错的后果比任何单道闸门都大。抽成文件的唯一
#   理由,就是让 packages/ui-mac/src/main/ci-diff-scope.test.ts 能真去跑**生产的这一份**,
#   在真 git 仓上驱动它,而不是去读 workflow 的字符串。workflow 那一步的 name/env 一个字没改。
#
# `#717` 修的缺陷:`pull_request` 事件上原来用的是**两点** diff `base..head`,而
# `github.event.pull_request.base.sha` 是**当下 alpha 的 tip**,不是分叉点。于是一个落后于
# alpha 的纯文档分支,会把别人已经合进 alpha 的代码算成自己的改动 ⇒ `code=true` ⇒ 跑全量 ⇒
# 继承主线的红,而这个 PR 里一行代码都没有。实证(`#717` owner 评论):同一个 commit,
# PR run 30756424959 判 code=true 并红在 `bun test (ui-mac)`,push run 30756431539 判
# code=false、全部 skipped。同一个 workflow 里的 north-star 守卫用的是三点
# `origin/dev...HEAD`,两者本来就不一致 —— 这里收口到三点(merge-base)口径。
#
# `push` 事件的 `before..sha` 是**两点且正确**:那对 SHA 本来就是同一条线上的前后两点,
# 语义是「这次 push 推进了什么」,没有分叉可言。刻意不动。
set -euo pipefail

# 输出写不出去 = 后面每一步都拿到空值 ⇒ 在 GitHub 上 `code` 既不是 'true' 也不是别的,
# 所有守卫步全跳过 ⇒ **假绿**。宁可当场炸。
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT must be set — 没有它这一步会静默把全部闸门关掉}"

# 输入全部走 env(alpha-ci 里从不把 ${{ }} 插进脚本文本),so nothing an attacker controls
# can be re-parsed as shell. SHAs are hex, but keep the pattern uniform.
if [ "${EVENT_NAME:-}" = "pull_request" ]; then
  base="${PR_BASE_SHA:-}"
  head="${PR_HEAD_SHA:-}"
  # PR 的 base.sha 是移动中的 alpha tip ⇒ 必须取分叉点,否则量的是「别人合了什么」。
  use_merge_base=1
else
  base="${PUSH_BEFORE:-}"
  head="${PUSH_HEAD:-}"
  use_merge_base=0
fi

# first push / unknown base → diff against the empty tree so every file counts as changed
if [ -z "$base" ] || ! git cat-file -e "$base^{commit}" 2>/dev/null; then
  base="$(git hash-object -t tree /dev/null)"
  use_merge_base=0
fi

if [ "$use_merge_base" = 1 ]; then
  # 显式 merge-base 而不是 `git diff base...head`:后者在没有共同祖先时直接 fatal,
  # 一步失败在这里等于「必需检查又不产生结论」——正是本票要消灭的状态。取不到分叉点就
  # fail-closed 回落到空树(⇒ 一切都算改动 ⇒ code=true ⇒ 跑全量),红也红在真闸门上。
  if merge_base="$(git merge-base "$base" "$head" 2>/dev/null)" && [ -n "$merge_base" ]; then
    base="$merge_base"
  else
    echo "::warning::no merge base between $base and $head — falling back to the empty tree (everything counts as changed)"
    base="$(git hash-object -t tree /dev/null)"
  fi
fi

files="$(git diff --name-only "$base" "$head")"
echo "changed files:"; echo "$files" | sed 's/^/  /'
code=false; md=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    *.md) md="$md $f" ;;                              # docs, and collect for link check
    docs/*|*/docs/*|.claude/rules/*|knowledge/*) : ;; # docs (html/design/adr), not code
    *) code=true ;;                                   # anything else → full CI
  esac
done <<< "$files"
echo "code=$code" >> "$GITHUB_OUTPUT"
echo "md=$(echo $md | xargs)" >> "$GITHUB_OUTPUT"
echo "→ code=$code ; md=[$(echo $md | xargs)]"
