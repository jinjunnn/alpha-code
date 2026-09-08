#!/usr/bin/env bash
#
# 模块体积:棘轮 + 阈值告警(`#1289`)。**只量与告警,不拦 push**。
#
# ── 缺陷本体 ────────────────────────────────────────────────────────────────────────
# 2026-09-08 实测:packages/ui-mac/src/main 的非测试 TS 有 5.3 万行,其中
# ext-install-planner.ts 3,525 行、ext-transaction.ts 2,825 行,而**没有任何东西**会在它们
# 继续变大时说一句话。文件越大,改一次的风险越高、审阅越难、写错越不容易被发现;而这种债
# 每次只多一点点,等到必须拆的时候,拆的成本已经比当初拦住它贵很多倍。
#
# ── 两半,各治一种失明 ──────────────────────────────────────────────────────────────
#   ① **棘轮**(scripts/module-size-ratchet.tsv):点名的文件/目录只许降不许升。
#      目录那一行是关键:只钉单文件的话,把 800 行搬进一个新文件就能让 file 行全绿,而这一层
#      的总量一点没少 —— 那正是本票要治的形态。
#   ② **阈值告警**:本分支**新增/修改**的非测试 `.ts`/`.tsx`,超过 ${WARN_LINES} 行就点名,
#      要求在票面写明理由。默认 800 = codex harness 的口径(目标 <500,超 800 必须新开模块)。
#      辖区取守卫的 ALPHA_OWNED_PACKAGES(alpha 自己写的那几个包),不是自己再抄一份清单。
#      已在棘轮里的路径由 ① 管,这里不重复点名。
#
# ── 为什么**不**硬红(`#1289` out of scope 明写)────────────────────────────────────
# 先量后闸:今天全仓有 27 个非测试文件超过 800 行,把阈值做成硬红等于开局就恒红 —— 而本仓
# 已经演过一遍恒红门的结局(`#754`:门红 ⇒ `--no-verify` ⇒ 十几道门一起关掉)。棘轮的约束力
# 不在退出码,在**登记簿是静态的**:本脚本没有 `--update`、没有运行时写回,抬高基线只能发生
# 在人手写的 diff 里(与 scripts/known-fails.tsv 同一条纪律)。
#
# ── 退出码三档 ──────────────────────────────────────────────────────────────────────
#   0 = 棘轮全部在基线内,且本次改动没有超阈值的文件;
#   2 = **闸响了**(棘轮超基线 / 改动文件超阈值)。不拦 push,但消费方的总结行不许再说「全绿」;
#   1 = 本脚本或登记簿自己坏了(行格式非法、点名的路径不存在、度量算不出来)。测不到就说
#       测不到 —— 一个「读不出登记簿于是什么都不报」的实现在退出码上与真绿一模一样。
#
# 行为判据在 packages/ui-mac/src/main/module-size-ratchet.test.ts:它起真 git 仓、把**本脚本
# 本体**复制进去、把一个登记文件加长到超基线,断言闸真的响并点名(反向用例),并各带一个
# 控制组证明夹具测得出已知的坏。
#
# 用法:bash scripts/assert-module-size.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || { echo "✗ 进不去仓库根目录:$ROOT" >&2; exit 1; }
MANIFEST="$ROOT/scripts/module-size-ratchet.tsv"
GUARD="$ROOT/scripts/north-star-guard.sh"
WARN_LINES="${ALPHA_MODULE_WARN_LINES:-800}"
BASELINE_REF="origin/alpha"

[ -f "$MANIFEST" ] || { echo "    ✗ 模块体积登记簿缺失:$MANIFEST —— 本次度量作废"; exit 1; }

warned=0
checked=0
seen=""

# 非测试源码?判据只有一条,两半都用它,免得两处各写一份口径。
is_source_file() {
  case "$1" in
    *.test.ts|*.test.tsx|*.spec.ts|*.spec.tsx|*.cases.ts|*.cases.tsx) return 1 ;;
    *.ts|*.tsx) return 0 ;;
    *) return 1 ;;
  esac
}

count_lines() {
  local n
  n="$(wc -l < "$1" 2>/dev/null)" || return 1
  printf '%s' "${n//[[:space:]]/}"
}

# 目录合计:git 眼里的文件(已追踪 ∪ 未忽略的新文件)—— 用 find 会把 node_modules / 构建产物
# 一起数进来,那个数每台机器都不一样。
tree_files() {
  git ls-files --cached --others --exclude-standard -- "$1" 2>/dev/null
}

echo "    · ① 棘轮(scripts/module-size-ratchet.tsv,只许降不许升):"
while IFS=$'\t' read -r baseline kind target why || [ -n "${baseline:-}" ]; do
  case "${baseline:-}" in ''|\#*) continue ;; esac
  if [ -z "${kind:-}" ] || [ -z "${target:-}" ] || [ -z "${why:-}" ]; then
    echo "    ✗ 登记簿格式错误(四列缺一):${baseline} ${kind:-} ${target:-}"; exit 1
  fi
  case "$baseline" in ''|*[!0-9]*) echo "    ✗ 基线不是数字:${baseline}\t${target}"; exit 1 ;; esac
  [ "$baseline" -gt 0 ] || { echo "    ✗ 基线必须大于 0:${target} —— 0 行的棘轮是个假闸门"; exit 1; }
  case "$kind" in file|tree) ;; *) echo "    ✗ kind 只能是 file 或 tree:${kind}(${target})"; exit 1 ;; esac
  case "$seen" in *"|${target}|"*) echo "    ✗ 登记簿重复路径:${target} —— 路径必须唯一"; exit 1 ;; esac
  seen="${seen}|${target}|"

  if [ "$kind" = file ]; then
    [ -f "$target" ] || { echo "    ✗ 登记的文件不存在:${target} —— 登记簿在骗人(文件被删/改名了就把这一行一起改掉)"; exit 1; }
    is_source_file "$target" || { echo "    ✗ 登记的不是非测试 .ts/.tsx:${target}"; exit 1; }
    measured="$(count_lines "$target")" || { echo "    ✗ 数不出 ${target} 的行数 —— 本次度量作废"; exit 1; }
  else
    [ -d "$target" ] || { echo "    ✗ 登记的目录不存在:${target} —— 登记簿在骗人"; exit 1; }
    measured=0
    matched=0
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      is_source_file "$f" || continue
      [ -f "$f" ] || continue
      n="$(count_lines "$f")" || continue
      measured=$(( measured + n ))
      matched=$(( matched + 1 ))
    done <<TREE
$(tree_files "$target")
TREE
    # 零命中 = 观测手段瞎了(路径写歪 / git 认不出这棵树),不是「这层没有代码」。
    [ "$matched" -gt 0 ] || { echo "    ✗ ${target} 下一个非测试 .ts/.tsx 都没数到 —— 本次度量作废,不是「0 行」"; exit 1; }
  fi

  checked=$(( checked + 1 ))
  if [ "$measured" -gt "$baseline" ]; then
    warned=1
    echo "        ⚠ 超基线:${target} 实测 ${measured} 行 > 基线 ${baseline}(+$(( measured - baseline )))"
    echo "          → 要么拆到基线以下;要么在票面写明这一次为什么必须变长,并在同一个 PR 里人手改"
    echo "            scripts/module-size-ratchet.tsv 那一行(基线只能靠人手写的 diff 抬高,评审看得见)。"
  elif [ "$measured" -lt "$baseline" ]; then
    echo "        ↓ 可收紧:${target} 实测 ${measured} 行 < 基线 ${baseline} —— 把那一行改成 ${measured}(棘轮只许降)"
  else
    echo "        ✓ ${target} ${measured} 行(= 基线)"
  fi
done < "$MANIFEST"

# 空登记簿 / 解析全挂 = 本脚本自己变成空闸门。显式判红(与 assert-gate-files.sh 同一条)。
[ "$checked" -ge 3 ] || { echo "    ✗ 只读到 ${checked} 条棘轮(至少应有 3 条)—— 登记簿被清空或解析失败"; exit 1; }

# ── ② 阈值告警:本分支改动的文件 ────────────────────────────────────────────────────
if ! jurisdiction="$(bash "$GUARD" --print-jurisdiction 2>/dev/null)"; then
  echo "    ✗ 读不出守卫的 alpha 自有包清单 —— 阈值告警这一半无从划定辖区,本次度量作废"
  exit 1
fi
alpha_pkgs="$(printf '%s\n' "$jurisdiction" | awk -F'\t' '$1 == "ALPHA_OWNED_PACKAGES" { print $2 }')"
upstream_paths="$(printf '%s\n' "$jurisdiction" | awk -F'\t' '$1 == "UPSTREAM_PATHS" { print $2 }')"
[ -n "$alpha_pkgs" ] && [ -n "$upstream_paths" ] || { echo "    ✗ 守卫辖区里读不到 ALPHA_OWNED_PACKAGES / UPSTREAM_PATHS —— 本次度量作废"; exit 1; }

SCOPE=()
for pkg in $alpha_pkgs; do SCOPE+=("${upstream_paths}/${pkg}"); done

window_note=""
committed=""
if git rev-parse --verify --quiet "$BASELINE_REF" >/dev/null; then
  committed="$(git diff --no-renames --diff-filter=ACMR --name-only "${BASELINE_REF}...HEAD" -- "${SCOPE[@]}" 2>/dev/null || true)"
else
  window_note="(比较基准 ${BASELINE_REF} 取不到 —— 本次只看未提交改动)"
fi
worktree="$(git diff --no-renames --diff-filter=ACMR --name-only HEAD -- "${SCOPE[@]}" 2>/dev/null || true)"
untracked="$(git ls-files --others --exclude-standard -- "${SCOPE[@]}" 2>/dev/null || true)"
changed="$(printf '%s\n%s\n%s\n' "$committed" "$worktree" "$untracked" | sed '/^$/d' | sort -u)"

oversized=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  is_source_file "$f" || continue
  [ -f "$f" ] || continue
  case "$seen" in *"|${f}|"*) continue ;; esac   # 已被棘轮点名的由 ① 报,不重复
  n="$(count_lines "$f")" || continue
  [ "$n" -gt "$WARN_LINES" ] || continue
  oversized="${oversized}        ⚠ 超阈值:${f} ${n} 行 > ${WARN_LINES}
"
done <<CHANGED
$changed
CHANGED

if [ -n "$oversized" ]; then
  warned=1
  echo "    · ② 本分支新增/修改、且超过 ${WARN_LINES} 行的非测试源码 ${window_note}:"
  printf '%s' "$oversized"
  echo "          → 这不是硬红:要么这一次顺手把它拆小,要么在**票面**写明为什么这一版必须这么长。"
  echo "            (阈值口径 = codex harness:模块目标 <500 行,超 800 行必须新开模块。)"
else
  echo "    · ② 本分支新增/修改的非测试源码里没有超过 ${WARN_LINES} 行的 ${window_note}"
fi

if [ "$warned" -ne 0 ]; then
  echo "    ⚠ 模块体积有告警(见上)—— 不拦 push,但这次运行不能算「全绿」(先量后闸,#1289)。"
  exit 2
fi
exit 0
