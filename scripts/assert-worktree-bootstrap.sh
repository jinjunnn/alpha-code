#!/usr/bin/env bash
# assert-worktree-bootstrap.sh — `scripts/worktree-bootstrap.sh` 的**能力判据**(`#916`)。
#
# 判的不是「脚本在不在」「软链在不在」「文件里写没写 bun install」—— 那些按本仓自己的定义
# 是**假闸门**(断言产物 / 断言源码文本:把 `bun install` 那一行换成 `true`,它们照样全绿)。
# 这里判的是**能力**:真建一棵全新 worktree,在里面跑**真的** typecheck,断言它给得出可信结论。
#
# ── 五条(按执行顺序),各杀一个不同的错误实现 ────────────────────────────────────
#  [1/5] 反向(**本判据是否成立的唯一证明**):**没**经过 bootstrap 的全新 worktree
#      必须**仍然**产生 `Cannot find module 'bun:test'` 这一类错误。
#      少了这条,[2/5] 会**空对空地绿** —— 「这台机器碰巧哪里都能解析」和「bootstrap 起作用了」
#      在只看 [2/5] 时长得一模一样。先证明这个探针测得出已知的坏,再用它判未知的好。
#  [2/5] 正向:经 bootstrap 建出来的 worktree,ui-mac typecheck **exit 0 且零条模块解析错误**。
#      摘掉 bootstrap 里的 `bun install` ⇒ 这条转红(绕过实验已实跑,见 PR)。
#  [3/5] 不污染共享树:bootstrap 跑完,**共享** `.git/config` 的 `core.hooksPath` 必须没变。
#      根 package.json 的 `"prepare": "husky"` 会在每次 `bun install` 后把它改成 `.husky/_`,
#      而它是 repository-local 的 ⇒ 在 worktree 里 install 会改**所有 worktree 共用**的那份配置,
#      把 alpha 的 pre-push 换成上游那份(冻结偏斜下恒红)⇒ 下一个人 `--no-verify` ⇒ 七道真闸门
#      一起关掉。本条先把值**设成 `.githooks`** 再跑 —— 不设的话,机器上本来就漂成 `.husky/_` 时
#      「前后相等」会**恒真**,断言粒度比缺陷粗一格。`.githooks` 也是崩溃时的安全残留值
#      (REQ-015 要的就是它)。
#  [4/5] 幂等:对**已存在且已装好**的 worktree 重跑 bootstrap 必须 exit 0,且重跑之后
#      typecheck **仍然**绿 —— 只断言重跑的退出码会被「重跑时把树删了再报 0」满足。
#  [5/5] 失败要响,且不留半装的树:让 `bun install` 真的失败(PATH 里没有 bun —— 真实可达:
#      精简过的 cron/CI shell 就是这个形状),断言 bootstrap **非零退出**、**并且把它本次
#      创建的 worktree 整棵删掉**。只断非零退出,会被「报错但把半装的树留在那」满足,
#      而那正是票面点名「比没有更坏」的那个状态。
#
# 一条载重的实现事实:`.worktrees/` 就在主 checkout **内部**,而 `bun run` 找可执行文件是
# 逐级往上走父目录的 `node_modules/.bin` —— 所以未 bootstrap 的 worktree 仍能跑起 `tsgo`
# (借的是**共享主 checkout** 那一份),报出来的才是 TS2307 而不是 `command not found`。
# [1/5] 的指纹依赖这一点;真变成 `command not found` 时它会因「零条 TS2307」而红,不会假绿。
#
# 用法:bash scripts/assert-worktree-bootstrap.sh
# 退出 0 = 这台机器上「建 worktree ⇒ 能跑真闸门」这条能力成立。
set -uo pipefail

MAIN="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || {
  echo "✗ 不在一个 git 仓库里" >&2; exit 1
}
MAIN="${MAIN%/.git}"
# 被测的是**跑本脚本的这棵树**上的那份 bootstrap,不是主 checkout 那份 —— 否则在 worktree 里
# 跑 alpha-check 时,量到的是共享树上的旧版本(而本票的全部意义就是「别去量别人的树」)。
# `.worktrees/` 的落点仍由 bootstrap 自己从 git-common-dir 推出,恒为主 checkout 之下。
SELF_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
BOOTSTRAP="$SELF_ROOT/scripts/worktree-bootstrap.sh"
[ -f "$BOOTSTRAP" ] || { echo "✗ 找不到 $BOOTSTRAP" >&2; exit 1; }

# 探针树一律从 HEAD 建:判的是**当前这棵树上的**脚本与配置,不是某个远端 ref 的历史版本。
BASE_SHA="$(git rev-parse HEAD 2>/dev/null)" || { echo "✗ 读不到 HEAD" >&2; exit 1; }

ID="probe-$$-${RANDOM}"
NEG="wtboot-${ID}-neg"
POS="wtboot-${ID}-pos"
FAIL="wtboot-${ID}-fail"
HOOKS_ORIGINAL="$(git -C "$MAIN" config --local --get core.hooksPath 2>/dev/null || true)"

cleanup() {
  local n
  for n in "$NEG" "$POS" "$FAIL"; do
    [ -e "$MAIN/.worktrees/$n" ] || continue
    git -C "$MAIN" worktree remove --force "$MAIN/.worktrees/$n" 2>/dev/null || rm -rf "$MAIN/.worktrees/$n"
  done
  git -C "$MAIN" worktree prune 2>/dev/null || true
  # 还原本脚本在 [5] 里动过的共享配置。崩溃时的残留值是 `.githooks` —— 正是 REQ-015 想要的那个,
  # 所以这里失手也不会让别人的门变松。
  local now
  now="$(git -C "$MAIN" config --local --get core.hooksPath 2>/dev/null || true)"
  if [ "$now" != "$HOOKS_ORIGINAL" ]; then
    if [ -n "$HOOKS_ORIGINAL" ]; then
      git -C "$MAIN" config --local core.hooksPath "$HOOKS_ORIGINAL" 2>/dev/null || true
    else
      git -C "$MAIN" config --local --unset core.hooksPath 2>/dev/null || true
    fi
  fi
}
trap cleanup EXIT

fail=0
red() { echo "    ✗ $*" >&2; fail=1; }

# ui-mac 的 typecheck 是这道能力的**被测读者**:它是 alpha-check 第 [3/9] 步真正跑的那条命令。
typecheck_in() {
  (cd "$MAIN/.worktrees/$1" && bun run --cwd packages/ui-mac typecheck 2>&1)
}
# 「模块解析假红」这一类的指纹。`bun:test` 与 `@types/bun` 是票面点名的两个,
# 但按**错误码**枚举才不会漏(TS2307 = Cannot find module)——按字面串枚举对新成员默认放行。
missing_module_lines() { grep -ac "error TS2307" <<<"$1" 2>/dev/null || true; }

echo "  · 探针 id=$ID,base=$BASE_SHA"

# ── [1/5] 反向:没 bootstrap 的全新 worktree 必须仍然假红 ──────────────────────────
echo "  · [1/5] 反向:未 bootstrap 的全新 worktree 必须产生模块解析错误"
if ! git -C "$MAIN" worktree add --detach -q "$MAIN/.worktrees/$NEG" "$BASE_SHA" 2>/dev/null; then
  echo "    ✗ 建不出反向探针 worktree —— **本次测量作废**,不要把它读成绿" >&2
  exit 1
fi
neg_out="$(typecheck_in "$NEG")"; neg_rc=$?
neg_missing="$(missing_module_lines "$neg_out")"
if [ "$neg_rc" -eq 0 ]; then
  red "未 bootstrap 的 worktree 竟然 typecheck 通过(rc=0)—— 这台机器哪里都能解析,[2] 于是空对空;本判据不成立"
fi
if [ "${neg_missing:-0}" -lt 1 ]; then
  red "未 bootstrap 的 worktree 没产生任何 TS2307 —— 探针测不出已知的坏,[2] 的绿没有含义"
else
  echo "    ✓ 未 bootstrap:rc=$neg_rc,TS2307 ${neg_missing} 条(探针测得出已知的坏)"
fi
if ! grep -aq "Cannot find module 'bun:test'" <<<"$neg_out"; then
  red "未 bootstrap 的 worktree 没有出现票面点名的 \`Cannot find module 'bun:test'\`"
fi
git -C "$MAIN" worktree remove --force "$MAIN/.worktrees/$NEG" 2>/dev/null || true

# ── [3/5] 的前置:把共享 core.hooksPath 设成一个**确定**的值,再跑 [2/5] ────────────
git -C "$MAIN" config --local core.hooksPath .githooks 2>/dev/null || true

# ── [2/5] 正向:bootstrap 一步建出来的 worktree 必须能给出可信 typecheck ────────────
echo "  · [2/5] 正向:bootstrap 建出的 worktree 必须 typecheck 干净"
if ! bash "$BOOTSTRAP" "$POS" --detach --base "$BASE_SHA" >/dev/null 2>&1; then
  red "bootstrap 自己非零退出 —— 建不出可用的 worktree"
else
  pos_out="$(typecheck_in "$POS")"; pos_rc=$?
  pos_missing="$(missing_module_lines "$pos_out")"
  if [ "$pos_rc" -ne 0 ] || [ "${pos_missing:-0}" -ne 0 ]; then
    red "bootstrap 过的 worktree 仍然假红:rc=$pos_rc,TS2307 ${pos_missing} 条"
    grep -a "error TS2307" <<<"$pos_out" | head -3 >&2
  else
    echo "    ✓ bootstrap 后:rc=0,TS2307 0 条"
  fi
fi

# ── [3/5] 共享 .git/config 没被 husky 改掉 ──────────────────────────────────────────
echo "  · [3/5] 不污染共享树:core.hooksPath 必须还是 .githooks"
hooks_now="$(git -C "$MAIN" config --local --get core.hooksPath 2>/dev/null || true)"
if [ "$hooks_now" != ".githooks" ]; then
  red "bootstrap 改掉了**共享** .git/config 的 core.hooksPath:.githooks → ${hooks_now:-(unset)}(husky 的 prepare);下一个人的 git push 会撞上上游那份恒红钩子,然后 --no-verify"
else
  echo "    ✓ core.hooksPath 仍是 .githooks"
fi

# ── [4/5] 幂等:对已装好的 worktree 重跑,不破坏它 ──────────────────────────────────
echo "  · [4/5] 幂等:对已装好的 worktree 重跑 bootstrap"
if ! bash "$BOOTSTRAP" "$POS" --detach --base "$BASE_SHA" >/dev/null 2>&1; then
  red "对已存在且已装好的 worktree 重跑 bootstrap 非零退出 —— 不幂等"
else
  again_out="$(typecheck_in "$POS")"; again_rc=$?
  again_missing="$(missing_module_lines "$again_out")"
  if [ "$again_rc" -ne 0 ] || [ "${again_missing:-0}" -ne 0 ]; then
    red "重跑之后 typecheck 反而坏了:rc=$again_rc,TS2307 ${again_missing} 条 —— 重跑破坏了这棵树"
  else
    echo "    ✓ 重跑 exit 0,且重跑后 typecheck 仍然 rc=0 / TS2307 0 条"
  fi
fi

# ── [5/5] install 失败要响,且不留半装的树 ─────────────────────────────────────────
echo "  · [5/5] bun install 失败时:非零退出 + 不留半装的 worktree"
BUN_BIN="$(command -v bun 2>/dev/null || true)"
if [ -z "$BUN_BIN" ]; then
  echo "    ✗ 这台机器上找不到 bun —— **本次测量作废**" >&2
  exit 1
fi
BUN_DIR="${BUN_BIN%/*}"
# 从 PATH 里摘掉 bun 所在目录(只摘它,别的工具照旧可用 —— git 还得能跑)。
# 按 `IFS=':'` 分词而不是 `read -d ':'`:后者在 herestring 末尾会多读出一个换行字段,
# 于是 RESTRICTED 末尾挂上一个空/换行目录项(不报错,只是悄悄多一段)。
RESTRICTED=""
_saved_ifs="$IFS"
set -f            # 关掉 glob:路径项里的 * ? [ 不许被展开
IFS=':'
for p in $PATH; do
  [ -n "$p" ] || continue
  [ "$p" = "$BUN_DIR" ] && continue
  RESTRICTED="${RESTRICTED:+$RESTRICTED:}$p"
done
IFS="$_saved_ifs"
set +f
unset _saved_ifs
# 先证明这个故障注入真的注进去了。bun 若在别处还能解析到,下面那条就变成「测了个寂寞」——
# 那时必须**打印本次测量作废**,而不是给一个绿。
if PATH="$RESTRICTED" command -v bun >/dev/null 2>&1; then
  echo "    ✗ 摘掉 $BUN_DIR 之后 bun 仍可解析 —— 故障注入无效,**本条测量作废**" >&2
  fail=1
elif ! PATH="$RESTRICTED" command -v git >/dev/null 2>&1; then
  echo "    ✗ 受限 PATH 里连 git 都没有 —— 夹具构造错了,**本条测量作废**" >&2
  fail=1
else
  PATH="$RESTRICTED" bash "$BOOTSTRAP" "$FAIL" --detach --base "$BASE_SHA" >/dev/null 2>&1
  boot_rc=$?
  if [ "$boot_rc" -eq 0 ]; then
    red "bun 缺失时 bootstrap 仍然 exit 0 —— 它会静默留下一棵装不上依赖的树"
  elif [ -e "$MAIN/.worktrees/$FAIL" ]; then
    red "bun install 失败后,本次创建的 worktree 还留在 .worktrees/$FAIL —— 半装的树比没有更坏"
  else
    echo "    ✓ 非零退出(rc=$boot_rc)且没留下 .worktrees/$FAIL"
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo "    ✗ worktree bootstrap 能力判据失守" >&2
  exit 1
fi
echo "    ✓ 新建 worktree 自己就能跑出可信 typecheck(不必碰共享主 checkout)"
exit 0
