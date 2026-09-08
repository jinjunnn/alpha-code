#!/usr/bin/env bash
#
# north-star 漂移度量(`#1288`)——「我们现在**总共**偏离上游多少」,以及「上一次跟上游对齐
# 是多久以前」。**只量,不拦**。
#
# ── 为什么需要它(缺陷本体)────────────────────────────────────────────────────────────
# scripts/north-star-guard.sh 的比较基准是 `origin/alpha`(`#889` 的既定裁决,本脚本**不动**
# 它)。那个基准回答的问题只有一个:「**这个 PR 自己**有没有新增偏离」。它结构上答不了另外
# 两个问题:
#   · 「我们今天总共偏离了多少」—— 收编白名单里的每一条,守卫都按设计**放行**,于是白名单
#     背后的那堆行数对守卫永远不可见;
#   · 「上一次跟上游对齐是多久以前」—— 守卫连 `origin/dev` 的日期都不看(它只用镜像判「这条
#     路径是不是上游的」)。
# 后果是那种「每次只多一点点」的债:偏离一点一点长大,而**没有任何一次 push 会提示**。账在
# 某一次 sync 时一次性付 —— 2026-08 那次积到四周 / 375 个提交,冲突面直接变成一张大票(`#1248`)。
#
# ── 本脚本**不是**闸门(`先量后闸`)────────────────────────────────────────────────────
# 它不设阈值、不拦 push、没有「太大了」这个判断。三档结局只区分「量到了」与「没量到」:
#   0 = 三个量都量到并打印了;
#   2 = 上游镜像/merge-base 取不到 ⇒ **未测量**(不是 0,更不是「零漂移」)。消费方记
#       「未验证」不拦 —— 一个网络/ref 问题不该拦住与它无关的 push(`#754` 形态)。
#   1 = 本脚本自己坏了(守卫的辖区读不出来、git diff 算不出来)。测不到就说测不到,不给数字。
# 什么时候该给它加阈值:等这三个量有了历史读数、能说出「多少算多」之后,那是另一张票。
#
# ── 三个量各自的定义(判据在 packages/ui-mac/src/main/north-star-drift-metrics.test.ts)──
#   ① 收编面 = 守卫 UPSTREAM_EXCLUDES 的**条目数**。它是「我们显式登记过、有 ADR 背书的接管
#      面」有多大。定义刻意与守卫同源:值由 `north-star-guard.sh --print-jurisdiction` 给出,
#      本脚本一个字都不解释(抄一份 = `#637` 那个已经咬过我们一次的形状)。
#   ② 上游漂移 = 从 `merge-base(<上游镜像>, HEAD)` 到 HEAD,**辖区内**被改/删的上游文件数与
#      行数。辖区 = 守卫的 UPSTREAM_PATHS 减两张 carve-out,与守卫逐字同源。
#      · `--diff-filter=DMR` 与守卫同一条:merge-base 那棵树就是上游那棵树 ⇒ 落进 DMR 的每条
#        路径按定义都在上游存在过,alpha 自己新增的文件(`A`)结构上不会混进来。
#      · `--no-renames` 也与守卫同一条:改名被压成一条 `R` 时 `--numstat` 会把它算成「全删+
#        全加」,一次纯改名能把这个数推高上千行。
#      · **收编白名单里的文件照样计入**——那正是本票的缺陷:守卫按设计放行它们,于是它们
#        的漂移今天没有任何一处读数。放行是判决,不是「不存在」。
#   ③ merge-base 年龄 = 那个 merge-base 提交距今多少天。它就是「上一次跟上游对齐是多久以前」。
#      本地 `origin/dev` 陈旧时这个数只会**偏大**(merge-base 只会更早),方向是报警不是安心。
#
# 用法:bash scripts/north-star-drift-metrics.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || { echo "✗ 进不去仓库根目录:$ROOT" >&2; exit 1; }
GUARD="$ROOT/scripts/north-star-guard.sh"

[ -f "$GUARD" ] || { echo "    ✗ 找不到守卫脚本 $GUARD —— 本次度量作废"; exit 1; }

# 辖区来自守卫本体,不是本文件的常量。守卫那一侧是只读模式:不跑 git、不判字节。
if ! jurisdiction="$(bash "$GUARD" --print-jurisdiction 2>&1)"; then
  echo "    ✗ 读不出守卫的辖区(north-star-guard.sh --print-jurisdiction 失败)—— 本次度量作废,不是「零漂移」"
  printf '%s\n' "$jurisdiction" | sed 's/^/      /'
  exit 1
fi

UPSTREAM_PATHS=""
ALPHA_OWNED_PACKAGES=""
ROUNDTRIP_PACKAGES=""
UPSTREAM_MIRROR=""
UPSTREAM_EXCLUDES_COUNT=""
while IFS=$'\t' read -r key value; do
  case "$key" in
    UPSTREAM_PATHS) UPSTREAM_PATHS="$value" ;;
    ALPHA_OWNED_PACKAGES) ALPHA_OWNED_PACKAGES="$value" ;;
    ROUNDTRIP_PACKAGES) ROUNDTRIP_PACKAGES="$value" ;;
    UPSTREAM_MIRROR) UPSTREAM_MIRROR="$value" ;;
    UPSTREAM_EXCLUDES_COUNT) UPSTREAM_EXCLUDES_COUNT="$value" ;;
  esac
done <<JURISDICTION
$jurisdiction
JURISDICTION

# 解析退化必须当场红:一份读不出辖区的解析器会让下面每个数都空对空地「成立」。
for required in UPSTREAM_PATHS ALPHA_OWNED_PACKAGES ROUNDTRIP_PACKAGES UPSTREAM_MIRROR UPSTREAM_EXCLUDES_COUNT; do
  if [ -z "${!required}" ]; then
    echo "    ✗ 守卫辖区里读不到 ${required} —— 本次度量作废(解析器坏了,不是「零漂移」)"
    exit 1
  fi
done
case "$UPSTREAM_EXCLUDES_COUNT" in
  ''|*[!0-9]*) echo "    ✗ 收编白名单条数不是数字:${UPSTREAM_EXCLUDES_COUNT} —— 本次度量作废"; exit 1 ;;
esac

echo "    · ① 收编面(守卫白名单条目数):${UPSTREAM_EXCLUDES_COUNT} 条(scripts/north-star-guard.sh 的 UPSTREAM_EXCLUDES;每条都是一次有 ADR 背书的接管,守卫按设计放行它们)"

# ── ②③ 都建在 merge-base 上。取不到镜像 ⇒ 未测量(exit 2),**不打 0** ────────────────
# 刻意不在这里 `git fetch`:alpha-check 第 [1/14] 步的守卫刚刚 fetch 过 origin/dev,再来一次
# 只是多一趟网络;而独立跑时本地镜像陈旧只会把 merge-base 推得更早 ⇒ 年龄偏大、漂移偏多,
# 方向是报警不是安心。
if ! git rev-parse --verify --quiet "$UPSTREAM_MIRROR" >/dev/null; then
  echo "    ⊘ 取不到上游镜像 ${UPSTREAM_MIRROR} —— ②上游漂移 与 ③merge-base 年龄 本次**未测量**(不是 0)"
  echo "      → 先 \`git fetch origin dev\`;拿不到镜像时这两个量无从计算,给一个 0 会被读成「零漂移」。"
  exit 2
fi
if ! merge_base="$(git merge-base "$UPSTREAM_MIRROR" HEAD 2>/dev/null)" || [ -z "$merge_base" ]; then
  echo "    ⊘ 算不出 merge-base(${UPSTREAM_MIRROR} 与 HEAD 无共同祖先?)—— ②③ 本次**未测量**(不是 0)"
  exit 2
fi

# 辖区 = UPSTREAM_PATHS − 两张 carve-out,与守卫同源(值由守卫给,本脚本只拼 pathspec)。
CARVEOUT_PATHSPECS=()
for pkg in $ALPHA_OWNED_PACKAGES $ROUNDTRIP_PACKAGES; do
  CARVEOUT_PATHSPECS+=(":(exclude)${UPSTREAM_PATHS}/${pkg}")
done

# shellcheck disable=SC2086
if ! numstat="$(git diff --no-renames --diff-filter=DMR --numstat "$merge_base" HEAD -- $UPSTREAM_PATHS "${CARVEOUT_PATHSPECS[@]}" 2>/dev/null)"; then
  echo "    ✗ 算不出与 merge-base 的差 —— 本次度量作废(不是「零漂移」)"
  exit 1
fi

# 二进制文件的 numstat 是 `-`:计文件、不计行(把 `-` 当 0 会静默,当数字会报错)。
drift="$(printf '%s\n' "$numstat" | awk -F'\t' '
  NF < 3 { next }
  { files += 1; if ($1 != "-") added += $1; if ($2 != "-") deleted += $2 }
  END { printf "%d %d %d", files + 0, added + 0, deleted + 0 }')"
drift_files="${drift%% *}"
drift_rest="${drift#* }"
drift_added="${drift_rest%% *}"
drift_deleted="${drift_rest##* }"

mirror_sha="$(git rev-parse --short "$UPSTREAM_MIRROR" 2>/dev/null || echo '?')"
base_sha="$(git rev-parse --short "$merge_base" 2>/dev/null || echo '?')"
base_date="$(git log -1 --format=%cd --date=short "$merge_base" 2>/dev/null || echo '?')"
base_epoch="$(git log -1 --format=%ct "$merge_base" 2>/dev/null || echo '')"
case "$base_epoch" in
  ''|*[!0-9]*)
    echo "    ⊘ 读不出 merge-base ${base_sha} 的提交时间 —— ③merge-base 年龄 本次**未测量**(不是 0)"
    exit 2 ;;
esac
age_days=$(( ( $(date +%s) - base_epoch ) / 86400 ))
[ "$age_days" -ge 0 ] || age_days=0

drift_lines=$(( drift_added + drift_deleted ))
echo "    · ② 上游漂移:${drift_files} 个文件 / ${drift_lines} 行(${drift_added} 增 / ${drift_deleted} 删)(辖区 ${UPSTREAM_PATHS}/ 全树 − alpha 自有包 [${ALPHA_OWNED_PACKAGES}] − roundtrip 包 [${ROUNDTRIP_PACKAGES}];窗口 merge-base ${base_sha} → HEAD;收编白名单里的文件**照样计入**)"
echo "    · ③ merge-base 年龄:${age_days} 天(${UPSTREAM_MIRROR} @ ${mirror_sha};merge-base ${base_sha},${base_date})"
echo "    ⓘ 三个量只做记录,不设阈值、不拦 push(先量后闸,#1288)。数字变大不等于变坏 —— 它等于「下一次 sync 要付的账」在变大。"
exit 0
