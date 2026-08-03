#!/usr/bin/env bash
# worktree-link-deps.sh — 给一个 git worktree 装上「真隔离」的依赖解析。
#
# 为什么需要它:bun workspace 在包内放的是**相对**软链
# (`packages/ui-mac/node_modules/@opencode-ai/app -> ../../../app`)。若把整个
# `node_modules` 目录软链到主 checkout,相对链会相对**主 checkout**解析 —— worktree
# 于是拿主 checkout 的 `packages/*` 源码在编译。后果两条,都真实发生过(2026-07-28):
#   ① 别的 session 在主 checkout 的未提交改动会变成本 worktree 的假红/假绿;
#   ② worktree 往 `node_modules` 里写的缓存(tsbuildinfo/.ts-dist)会落进主 checkout。
#
# 修法:每个包的 `node_modules` 建成**真目录**,第三方依赖逐条软链到主 checkout(省磁盘),
# 而工作区自有包(@opencode-ai/*、@alpha-code/*)指回**本 worktree** 的 packages。
#
# 用法: bash scripts/worktree-link-deps.sh <worktree-path> [main-checkout-path]
#       路径可以是相对的(见下)。
set -euo pipefail

WT="${1:?usage: worktree-link-deps.sh <worktree-path> [main-checkout]}"
[ -d "$WT" ] || { echo "worktree not found: $WT" >&2; exit 1; }
# 入参先规范化成**绝对物理路径**(#796)。相对路径不规范化会**静默**生成坏软链:
#   ① 下面 `ln -sfn "$WT/…"` 写出的是**相对**目标,而相对目标是相对**软链自己所在的
#      目录**解析的 ⇒ 得到 `…/node_modules/@opencode-ai/.worktrees/foo/packages/app`
#      这种鬼路径;
#   ② `$MAIN` 若相对,则工作区自有包的前缀判定(下面 `== "$MAIN/packages/"*`)拿它跟
#      realpath 的输出比 —— 后者恒为绝对物理路径 ⇒ 判定恒假,自有包被指回主 checkout。
# 症状极具误导性:**不报错,只是测试跑得少**。#796 修复轮在同一棵 base 树上正反各测一次:
# 相对路径 ⇒ 615 条链里 80 条是坏的,`bun test src`(ui-mac)跑出 2256 条 / 102 fail;
# 换成绝对路径 ⇒ 0 条坏链,同样 255 个文件跑出 3756 条 / 0 fail。看着像「主线红了」。
# `pwd -P` 对本来就绝对的入参是恒等变换。
WT="$(cd "$WT" && pwd -P)"
MAIN="${2:-$(git -C "$WT" rev-parse --path-format=absolute --git-common-dir | sed 's#/\.git$##')}"

[ -d "$MAIN/node_modules" ] || { echo "main checkout has no node_modules: $MAIN" >&2; exit 1; }
MAIN="$(cd "$MAIN" && pwd -P)"
[ "$WT" != "$MAIN" ] || { echo "refusing to run against the main checkout itself" >&2; exit 1; }

LINKED=0
DANGLING=0
DIRS=0

link_one() {
  # $1 = 软链目标(必须绝对), $2 = 软链自身路径
  ln -sfn "$1" "$2"
  LINKED=$((LINKED + 1))
  # 自检:坏软链不会让 ln 失败,只会让解析悄悄少一块 —— 建完立刻 stat 一次(#796)
  [ -e "$2" ] || { echo "  ✗ 坏软链 $2 -> $1" >&2; DANGLING=$((DANGLING + 1)); }
}

link_dir() {
  # $1 = 相对仓根的目录(如 "" 或 "packages/ui-mac")
  local rel="$1"
  local src="$MAIN/${rel:+$rel/}node_modules"
  local dst="$WT/${rel:+$rel/}node_modules"
  [ -d "$src" ] || return 0
  DIRS=$((DIRS + 1))

  # 旧的整目录软链要先摘掉,否则下面会写进主 checkout
  [ -L "$dst" ] && rm "$dst"
  mkdir -p "$dst"

  local entry name
  # `"$src"/*` 的 glob **不匹配点开头的条目**,而 `.bin` 正是点开头 ⇒ 整个 `.bin` 漏链,
  # 新 worktree 里 electron-vite / electron-builder / tsgo 全部 command not found(#796;
  # `#783` 的打包真机 L2 为此手工补链了 150+ 个 bin 条目)。跑 bun 的门不需要 `.bin`,
  # 所以日常 typecheck / unit 全绿,这个洞一直藏着。
  #
  # 点开头的条目按**白名单**补,不用 `dotglob` 全收。主 checkout 里其余的点条目:
  #   · `.bun`      bun 的隔离 store。顶层每个包的软链都从 `$MAIN/node_modules` 相对指进去,
  #                 逐条链完即可解析,不必再链一次(实测本 worktree 一直如此跑通)。
  #   · `.cache` / `.vite` / `.vite-temp` / `.ts-dist`
  #                 **可写缓存**。链过去 = 让 worktree 的写落进主 checkout,正是本文件抬头
  #                 说的坑 ②。
  # 白名单也是 fail-closed 的:将来主 checkout 冒出新的点条目,最坏是「少了、立刻响」
  # (末尾自检会把条数打出来),而不是「悄悄往主 checkout 写」。
  for entry in "$src"/* "$src"/.bin; do
    [ -e "$entry" ] || continue
    name="$(basename "$entry")"
    case "$name" in
      @opencode-ai|@alpha-code)
        # 作用域目录:逐条处理,工作区自有包指回本 worktree
        mkdir -p "$dst/$name"
        local scoped sname target
        for scoped in "$entry"/*; do
          [ -e "$scoped" ] || continue
          sname="$(basename "$scoped")"
          target="$(cd "$(dirname "$scoped")" && python3 -c "import os,sys;print(os.path.realpath(sys.argv[1]))" "$scoped")"
          if [[ "$target" == "$MAIN/packages/"* ]]; then
            # 工作区自有包 → 指回本 worktree 的同一相对位置
            link_one "$WT/${target#"$MAIN"/}" "$dst/$name/$sname"
          else
            link_one "$target" "$dst/$name/$sname"
          fi
        done
        ;;
      *)
        link_one "$entry" "$dst/$name"
        ;;
    esac
  done
}

link_dir ""
# 走**任意深度**,不是只走 packages/*/ 一层:仓里真实存在两层的包
# (packages/sdk/js、packages/console/*、packages/stats/*)。只走一层会让这些包在
# worktree 里没有 node_modules,于是 tsconfck 解析不到 @tsconfig/* ,报成
# `TSConfckParseError` —— 看上去像 4 条测试真红,实为环境缺失(2026-07-28 实际踩到)。
# `-not -path "*/node_modules/*"` 是为了不进 node_modules 内部再找嵌套的 node_modules。
while IFS= read -r nm; do
  rel="${nm#"$MAIN"/}"
  link_dir "${rel%/node_modules}"
done < <(find "$MAIN/packages" -type d -name node_modules -not -path "*/node_modules/*" | sort)

echo "linked: $WT"
# ── 自检(#796)。本脚本的两个洞都**不报错、只是链少了/链坏了**,而后果要到几百条测试
# 少跑一半时才显形。条数与坏链数当场打出来 + 判红,是这一类坑最便宜的解药。
echo "  node_modules dirs: $DIRS, entries: $LINKED"
if [ -d "$MAIN/node_modules/.bin" ] && [ ! -d "$WT/node_modules/.bin" ]; then
  echo "  ✗ node_modules/.bin 没链上 —— worktree 里跑不了任何 bin 脚本(tsgo / electron-vite / electron-builder)" >&2
  exit 1
fi
if [ "$DANGLING" -ne 0 ]; then
  echo "  ✗ $DANGLING 条坏软链(见上)—— 依赖解析不完整,不要拿它跑测试" >&2
  exit 1
fi
echo -n "  @opencode-ai/app → "
python3 -c "import os,sys;print(os.path.realpath(sys.argv[1]))" "$WT/packages/ui-mac/node_modules/@opencode-ai/app" 2>/dev/null || echo "(absent)"
