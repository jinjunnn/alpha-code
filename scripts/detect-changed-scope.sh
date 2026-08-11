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

no_merge_base=0
if [ "$use_merge_base" = 1 ]; then
  # 显式 merge-base 而不是 `git diff base...head`:后者在没有共同祖先时直接 fatal,
  # 一步失败在这里等于「必需检查又不产生结论」——正是 `#717` 要消灭的状态。取不到分叉点就
  # fail-closed:回落到空树把 md 收全,并**把结论直接钉成 code=true**(见下面 `no_merge_base`)。
  if merge_base="$(git merge-base "$base" "$head" 2>/dev/null)" && [ -n "$merge_base" ]; then
    base="$merge_base"
  else
    echo "::warning::no merge base between $base and $head — everything counts as changed (code=true, full CI)"
    base="$(git hash-object -t tree /dev/null)"
    no_merge_base=1
  fi
fi

# `--no-renames` 不是风格偏好,是判据前提:git 默认开着 rename 检测(`diff.renames` 默认 true),
# 于是 `--name-only` 对一次重命名**只输出目标路径**,源路径完全不出现(git 2.50.1 实测)。
# 把一个真实源文件 `git mv` 到 docs/ 之下,分类器就只看见一个 docs 路径 ⇒ code=false ⇒ 上面
# 二十多个挂在 `code == 'true'` 上的步骤集体跳过,而这次变更真的动了代码。关掉 rename 检测,
# 一次重命名重新变回「删源 + 加目标」两条路径,两端都参与分类。
files="$(git diff --name-only --no-renames "$base" "$head")"
echo "changed files:"; echo "$files" | sed 's/^/  /'
code=false; md=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  # 分支顺序即优先级。原来这里的 `*/docs/*` 匹配的是**路径里任何位置**的 `docs/` 段,而
  # 「路径里有个 docs 段」和「这是文档」不是同一个集合:本仓真实存在
  # packages/console/app/src/routes/docs/index.ts 与 .../docs/[...path].ts —— 无歧义的
  # TypeScript 源码,改它们会被判成 docs-only,全部代码闸门跳过。
  # 换成两条各管一头、都不含通配中间段的判定:
  #   ① 源码扩展名躺在哪个目录下都算代码(对**新出现**的路径默认拒绝,不靠枚举跟上);
  #   ② 文档树只认锚定在仓根的显式前缀(`docs/` `.claude/rules/` `knowledge/`)。
  # 代价是显式的:`packages/docs/**` 与 `packages/web/src/content/docs/**` 的 .mdx 不再算
  # 文档、改它们会跑全量 CI。方向是保守的一侧(多跑闸门,不会少跑),要豁免请加显式前缀。
  case "$f" in
    *.md) md="$md $f" ;;                              # docs, and collect for link check
    *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.sh) code=true ;;  # 源码扩展名 → 无论住在哪都是代码
    docs/*|.claude/rules/*|knowledge/*) : ;;          # 仓根锚定的文档树(html/design/adr/证据)
    *) code=true ;;                                   # anything else → full CI
  esac
done <<< "$files"

# `#897`:**fail-closed 说的是结论,不是基准。** 上面把 base 换成空树,只保证**文件列表**是
# HEAD 的全部;分类器随后照跑同一套规则,于是一个纯文档的 orphan 分支仍然得到 code=false ——
# 在一个我们看不懂的形状上,把二十多道挂在 `code == 'true'` 上的闸门集体关掉,而 job 报绿。
# (`#717` 只做了换基准那一半,warning 里写着 everything counts as changed,输出却是 false。)
# 没有共同祖先时,「这次变更改了什么」本来就无从谈起,唯一安全的答案是「全都改了」。
if [ "$no_merge_base" = 1 ]; then
  code=true
fi

echo "code=$code" >> "$GITHUB_OUTPUT"
echo "md=$(echo $md | xargs)" >> "$GITHUB_OUTPUT"
echo "→ code=$code ; md=[$(echo $md | xargs)]"
