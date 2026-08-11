#!/usr/bin/env bash
# worktree-bootstrap.sh — 建一个**能跑真闸门**的 worktree,一步到位(`#916`)。
#
#   bash scripts/worktree-bootstrap.sh <name> [-b <branch>|--detach] [--base <ref>]
#
# 建在主 checkout 的 `.worktrees/<name>`(治理规定的唯一位置),建完立刻 `bun install`。
# 退出 0 = 这棵 worktree 自己就能给出可信的 typecheck / 测试结论,**不需要去碰共享主 checkout**。
#
# ── 为什么是 `bun install` 而不是「补齐各包 node_modules 软链」(`#916` 勘破,实测)──────
# 票面与外部笔记原本设想的修法是软链。实测推翻了它:
#   · 全新 worktree:`node_modules` **一个都没有** ⇒ `bun run --cwd packages/ui-mac typecheck`
#     exit 2、**11627 条 `error TS`**,首条 `Cannot find module 'bun:test'`;
#   · 把主 checkout 里 29 个 `node_modules` 逐个软链过去 ⇒ 只降到 **8694 条**,**仍然 exit 2**。
#     原因是 bun 的隔离式布局:真包在**根** `node_modules/.bun/` 里
#     (`ghostty-web` 实际住在 `node_modules/.bun/ghostty-web@github+…/node_modules/ghostty-web`),
#     各包 `node_modules` 放的只是指进 store 的链 —— **逐包软链重建不出这张图**;
#   · 而且软链有害:`packages/{app,desktop,ui-mac}/tsconfig.json` 的 `outDir` 是
#     `node_modules/.ts-dist`。把 `node_modules` 链到主 checkout ⇒ 每条 lane 的 typecheck
#     都往**共享树**写构建产物 —— 本票要消灭的交叉污染换个地方发生。
#   · `bun install`:exit 0 / 4694 packages / **9.5 秒**,随后 ui-mac typecheck **exit 0 / 0 条 / 3 秒**,
#     `node_modules` 与 `.ts-dist` 都是 worktree 本地真目录,不与任何人共享。
# 判据不写在这段散文里 —— 它在 `scripts/assert-worktree-bootstrap.sh`(alpha-check 第 [8/9] 步),
# 那里真建 worktree、真跑 typecheck,并且**先证明没 bootstrap 的树确实会红**再判 bootstrap 过的树绿。
#
# ── 为什么要救 `core.hooksPath`(`#916` 勘破,实测)──────────────────────────────────
# 根 `package.json` 有 `"prepare": "husky"`,于是**每一次 `bun install` 都把 `core.hooksPath`
# 重置成 `.husky/_`**。`core.hooksPath` 是 repository-local 的 ⇒ 在 worktree 里跑 install,
# 写的是**所有 worktree 共享的 `.git/config`**。实测(2026-08-11,本仓):
#     git config --local core.hooksPath .githooks   # 主 checkout 设成 alpha 的门
#     (cd .worktrees/X && bun install)              # 3.5s,exit 0
#     git config --local --get core.hooksPath       # → .husky/_      ← 共享配置被改了
# 后果不是「少跑一道门」,是**换了一道门**:`.husky/pre-push` 是上游那份,在 ADR-020 冻结偏斜下
# 恒红 ⇒ 下一个人 `git push` 被一个与他改动无关的红拦住 ⇒ `--no-verify` ⇒ alpha 的八道真闸门
# 一起关掉(`#754` 那个形态)。所以本脚本在 install 前后存/还原它;还原是**无条件**的,
# install 失败也还原。
set -uo pipefail

usage() {
  cat <<'EOF'
用法:bash scripts/worktree-bootstrap.sh <name> [-b <branch>|--detach] [--base <ref>]

  <name>          worktree 目录名,建在主 checkout 的 .worktrees/<name>(不许带 /)
  -b <branch>     新建并检出的分支名(默认 = <name>)
  --detach        不建分支,直接 detach 到 <ref>(与 -b 互斥)
  --base <ref>    基线 ref(默认 origin/alpha)

幂等:<name> 已经是一棵注册在案的 worktree 时跳过创建,只重跑 `bun install`
      (bun install 本身幂等;实测已装好的树重跑 3.5s / exit 0,不破坏它)。

失败:任何一步失败都**非零退出并说清楚**。若 worktree 是**本次**创建的,失败时把它
      整棵删掉 —— 半装的 worktree 比没有更坏(人会以为装好了,然后把 8694 条假红
      当成「基线既有」)。若 worktree 是**之前就有**的(可能装着没提交的活),不删,
      但明说它的依赖解析现在不可信。
EOF
}

NAME=""
BRANCH=""
DETACH=0
BASE="origin/alpha"

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    -b) [ "$#" -ge 2 ] || { echo "✗ -b 缺少参数" >&2; exit 2; }; BRANCH="$2"; shift 2 ;;
    --detach) DETACH=1; shift ;;
    --base) [ "$#" -ge 2 ] || { echo "✗ --base 缺少参数" >&2; exit 2; }; BASE="$2"; shift 2 ;;
    -*) echo "✗ 未知参数:$1" >&2; usage >&2; exit 2 ;;
    *)
      [ -z "$NAME" ] || { echo "✗ 多余参数:$1(只接受一个 <name>)" >&2; exit 2; }
      NAME="$1"; shift ;;
  esac
done

[ -n "$NAME" ] || { echo "✗ 缺少 <name>" >&2; usage >&2; exit 2; }
[ "$DETACH" -eq 0 ] || [ -z "$BRANCH" ] || { echo "✗ --detach 与 -b 互斥" >&2; exit 2; }
# `<name>` 只做目录名。放行 `/` 或 `..` 就等于放行「建到 .worktrees/ 之外」——
# 治理规定 worktree 一律在仓内 `.worktrees/`,这里对新形态默认拒。
case "$NAME" in
  */*|*..*|.|"") echo "✗ <name> 只能是一个目录名(不许含 / 或 ..):$NAME" >&2; exit 2 ;;
esac
[ "$DETACH" -eq 1 ] || [ -n "$BRANCH" ] || BRANCH="$NAME"

# 主 checkout 的根:从**共享** .git 反推,所以在主 checkout 里跑和在任意一棵 worktree 里跑
# 得到的是同一个答案(`git rev-parse --show-toplevel` 不行 —— 在 worktree 里它给的是那棵树)。
COMMON_DIR="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || {
  echo "✗ 不在一个 git 仓库里" >&2; exit 1
}
MAIN="${COMMON_DIR%/.git}"
[ -d "$MAIN" ] || { echo "✗ 解析不出主 checkout:$COMMON_DIR" >&2; exit 1; }
TARGET="$MAIN/.worktrees/$NAME"

# 已经注册在案的 worktree?`--porcelain` 的 `worktree <abs path>` 行是权威 —— 不靠「目录在不在」
# 判断:崩溃后留下的目录会「在」而没注册,那时 `git worktree add` 必失败,与其让它报一句
# 难懂的 git 错误,不如这里就说清楚。
ALREADY=0
while IFS= read -r line; do
  case "$line" in
    "worktree $TARGET") ALREADY=1; break ;;
  esac
done < <(git -C "$MAIN" worktree list --porcelain 2>/dev/null)

CREATED_HERE=0
if [ "$ALREADY" -eq 1 ]; then
  echo "▶ .worktrees/$NAME 已注册 —— 跳过创建,只重跑 bun install(幂等)"
else
  if [ -e "$TARGET" ]; then
    echo "✗ $TARGET 已存在,但**不是**一棵注册在案的 worktree。" >&2
    echo "  多半是上一次崩溃留下的残骸。先 \`git -C $MAIN worktree prune\`,再删掉该目录,然后重跑。" >&2
    exit 1
  fi
  echo "▶ git worktree add .worktrees/$NAME (base=$BASE)"
  if [ "$DETACH" -eq 1 ]; then
    git -C "$MAIN" worktree add --detach "$TARGET" "$BASE" || {
      echo "✗ git worktree add 失败(base=$BASE 存在吗?)—— 没有创建任何东西" >&2; exit 1
    }
  else
    git -C "$MAIN" worktree add -b "$BRANCH" "$TARGET" "$BASE" || {
      echo "✗ git worktree add 失败(分支 $BRANCH 已存在?base=$BASE 存在吗?)—— 没有创建任何东西" >&2; exit 1
    }
  fi
  CREATED_HERE=1
fi

# ── install 前后夹住共享的 core.hooksPath(理由见抬头)────────────────────────────────
HOOKS_BEFORE="$(git -C "$MAIN" config --local --get core.hooksPath 2>/dev/null || true)"
restore_hooks_path() {
  local now
  now="$(git -C "$MAIN" config --local --get core.hooksPath 2>/dev/null || true)"
  [ "$now" = "$HOOKS_BEFORE" ] && return 0
  if [ -n "$HOOKS_BEFORE" ]; then
    git -C "$MAIN" config --local core.hooksPath "$HOOKS_BEFORE" 2>/dev/null || true
  else
    git -C "$MAIN" config --local --unset core.hooksPath 2>/dev/null || true
  fi
  echo "  · 已还原共享 .git/config 的 core.hooksPath:$now → ${HOOKS_BEFORE:-(unset)}(husky 的 prepare 会改它)"
}

echo "▶ bun install(worktree 本地依赖;CI 跑的是同一条命令)"
# 刻意**不**在创建 worktree 之前预检 `bun` 在不在:那样失败就永远发生在「还没建东西」的时刻,
# 下面这段回滚路径就永远不会被执行,而判据只要断言「失败时非零退出」就照样绿。
# (本仓点名过的形态:断言粒度比缺陷粗一格。)
INSTALL_RC=0
# 注意别写成 `if (…); then … fi` 再取 `$?`:`if` 没有 else 分支时,条件为假**整条语句仍返回 0**,
# 于是 rc 恒为 0、失败分支拿不到真实退出码。显式接住。
(cd "$TARGET" && bun install) || INSTALL_RC=$?

if [ "$INSTALL_RC" -eq 0 ]; then
  restore_hooks_path
  echo "✓ .worktrees/$NAME 就绪 —— 在里面跑 bash scripts/alpha-check.sh 是可信结论,不必碰共享主 checkout"
  echo "$TARGET"
  exit 0
fi

restore_hooks_path
echo "✗ bun install 失败(rc=$INSTALL_RC)——**依赖没装上**。" >&2
echo "  不要在这棵树上跑 typecheck/测试:它会给出成千上万条与你的改动无关的 \`Cannot find module\` 假红," >&2
echo "  而那些红看起来跟「基线既有」一模一样。" >&2
if [ "$CREATED_HERE" -eq 1 ]; then
  echo "  本次创建的 worktree 已整棵删除 —— 半装的 worktree 比没有更坏。" >&2
  git -C "$MAIN" worktree remove --force "$TARGET" 2>/dev/null || rm -rf "$TARGET"
  git -C "$MAIN" worktree prune 2>/dev/null || true
else
  echo "  .worktrees/$NAME 是之前就存在的(可能装着没提交的活),因此**没有**删除它。" >&2
  echo "  修好 bun 之后重跑本脚本即可 —— 它是幂等的。" >&2
fi
exit 1
