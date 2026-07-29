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
# 用法: bash scripts/worktree-link-deps.sh <worktree-abs-path> [main-checkout-abs-path]
set -euo pipefail

WT="${1:?usage: worktree-link-deps.sh <worktree-path> [main-checkout]}"
MAIN="${2:-$(git -C "$WT" rev-parse --path-format=absolute --git-common-dir | sed 's#/\.git$##')}"

[ -d "$WT" ] || { echo "worktree not found: $WT" >&2; exit 1; }
[ -d "$MAIN/node_modules" ] || { echo "main checkout has no node_modules: $MAIN" >&2; exit 1; }
[ "$WT" != "$MAIN" ] || { echo "refusing to run against the main checkout itself" >&2; exit 1; }

link_dir() {
  # $1 = 相对仓根的目录(如 "" 或 "packages/ui-mac")
  local rel="$1"
  local src="$MAIN/${rel:+$rel/}node_modules"
  local dst="$WT/${rel:+$rel/}node_modules"
  [ -d "$src" ] || return 0

  # 旧的整目录软链要先摘掉,否则下面会写进主 checkout
  [ -L "$dst" ] && rm "$dst"
  mkdir -p "$dst"

  local entry name
  for entry in "$src"/*; do
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
            ln -sfn "$WT/${target#"$MAIN"/}" "$dst/$name/$sname"
          else
            ln -sfn "$target" "$dst/$name/$sname"
          fi
        done
        ;;
      *)
        ln -sfn "$entry" "$dst/$name"
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
echo -n "  @opencode-ai/app → "
python3 -c "import os,sys;print(os.path.realpath(sys.argv[1]))" "$WT/packages/ui-mac/node_modules/@opencode-ai/app" 2>/dev/null || echo "(absent)"
