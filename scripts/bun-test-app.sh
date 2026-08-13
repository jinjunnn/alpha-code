#!/usr/bin/env bash
#
# `#946`:packages/app 的测试入合并门 —— 在一个滚动 pin 的包里,只让 alpha 拥有的判据挡路。
#
# 为什么不能直接 `bun-test-floor.sh 600 packages/app src`(天真整包):
#   packages/app 走滚动 pin(ADR-034),上游测试随 pin 一起来。pin 849c2598 上
#   src/i18n/parity.test.ts 本身就是红的(上游 locale 键滞后,alpha 的补丁 delta 零 i18n 文件,
#   这条红与本仓任何改动无关)⇒ 整包塞进门,本地门当天恒红 ⇒ 人人 --no-verify ⇒
#   九道门一起关掉(`#754` 已经演过一遍的形态)。
#
# 为什么不用按名字的忽略清单:那是枚举,对下一条上游红默认放行/默认拒之间只能选一头,
#   而且清单会漂。勘破发现上游自己已经把口子开好了:整包唯一按 CI 分支的测试就是
#   parity 的 `describe.skipIf(!!process.env.CI)`(两轴 grep 实测,仅此一处)—— 上游自己的
#   CI 就是这么跑绿的。所以本门显式钉 `CI=1`,与 GitHub runner 上的行为**逐字节同口径**
#   (MIRRORED 不再是两套 fail-set):上游既有红不进门,而任何**新**红(alpha 打穿的、
#   或下次 bump 带来的)默认拒 —— bump 是人门禁 PR,红在那里正是要给人看的反馈。
#   实测(2026-08-13,pin 849c2598):CI=1 下 623 pass / 4 skip / 0 fail,
#   温缓存 ×12、冷 transpiler 缓存 ×6、8 路 CPU 饥饿 ×4 全部一致。
#
# 两层判据(与 gate-files.tsv 的「地板管灾难、点名管单点」同构):
#   [a] 整包:exit 0 且 pass ≥ FLOOR(`#647`:bun 对「跑 0 条」退出 0,只看退出码会在
#       suite 被清空时全绿)。
#   [b] alpha 判据文件逐个点名重跑:文件清单**运行时**从 frontend/alpha-patches/
#       alpha-frontend.patch(ADR-034 唯一 SOT)解析,不手抄 —— 手抄的清单会漂;
#       文件从补丁退场(= 还原成纯上游)则自然退出清单(登记表行随之删,反向核对钉住)。
#       判据(#946 R1)= 每个文件**单独**重跑:恰好匹配 1 个文件(删掉/改名 ⇒ 红;
#       整包地板 600 对 626−13 这种量级抓不到)且 pass **恰好等于**脚本内登记的精确条数
#       (#844 同款语义)。R1 前的判据是 pass ≥ 文件数 —— 「每文件至少一条」,粒度比它要
#       防的缺陷粗一格:skipIf(CI) 包住 12 条的文件后汇总行文件数不变、40 ≥ 4 照样绿。
#       解析器自证:补丁里一条 `diff --git` 都解不出来 = 解析器退化或 SOT 搬家,
#       打「测量作废」而不是静默跳过这半边(观测手段先证明能测出已知的坏)。
#
# 已知未覆盖(如实声明,不假装):
#   · parity 那条红在本门永不执行(上游 skipIf 治它)⇒ 若有朝一日 alpha 去改 locale 文件,
#     打穿 parity 本门看不见 —— 今日补丁 delta 零 i18n 文件,该风险不成立即不预建闸。
#   (R1 前第二条「skipIf(CI) 可静默出门」已被 [b] 的逐文件精确条数关掉:skip 不计入
#   pass,包住即红。)
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

WORKDIR="packages/app"
PATCH="frontend/alpha-patches/alpha-frontend.patch"
# 地板语义与 ui-mac 的 3000/3085 同款:抓灾难性丢失,刻意留大余量(当前 CI=1 实测 623)。
FLOOR=600
# 每条用例默认超时与 bun-test-floor.sh 同一个环境咽喉(`#777`):慢机器上 5s 默认值
# 会让机器速度替断言下判决。
ALPHA_TEST_TIMEOUT_MS="${ALPHA_TEST_TIMEOUT_MS:-120000}"

log="$(mktemp)"
trap 'rm -f "$log"' EXIT

run_bun_test() {
  # CI=1 的理由见抬头;--preload 与上游 package.json 的 test:unit 同款。
  (cd "$WORKDIR" && CI=1 bun test --timeout "$ALPHA_TEST_TIMEOUT_MS" --preload ./happydom.ts "$@") >"$log" 2>&1
}

summarize() {
  grep -aE '^\(fail\)|^ *[0-9]+ (pass|fail|skip)$|^Ran [0-9]+ tests? across' "$log" || true
}

# ── [a] 整包 ──────────────────────────────────────────────────────────────────
set +e
run_bun_test src
status=$?
set -e
summarize
# `|| true`:bun 崩溃/被杀时没有汇总行,grep 空手而归 —— pipefail+set -e 会让脚本死在
# 这一行,「测量作废」的诊断永远打不出来(与 [b] 同类,实验 3 实测)。
summary="$(grep -aoE 'Ran [0-9]+ tests? across [0-9]+ files?' "$log" | tail -1 || true)"
if [ -z "$summary" ]; then
  echo "::error::${WORKDIR} —— bun 没跑到汇总行(崩溃/挂起被杀),本次测量作废,不构成任何方向的证据。完整输出:"
  cat "$log"
  exit 1
fi
pass="$(sed -n 's/^[[:space:]]*\([0-9][0-9]*\) pass$/\1/p' "$log" | tail -1)"
[ -z "$pass" ] && pass=0
if [ "$status" -ne 0 ]; then
  echo "::error::${WORKDIR} 整包测试红(上面 (fail) 逐条点名)。CI=1 口径下上游既有红不在门内 —— 这是**新**红:要么本分支打穿了它(#933 的形态),要么 pin bump 带来了新的上游红(在 bump PR 里处置,不许静默放行)。"
  exit 1
fi
if [ "$pass" -lt "$FLOOR" ]; then
  echo "::error::${WORKDIR} 只跑了 ${pass} 条 < 地板 ${FLOOR} —— suite 加载失败/成片删除/runner 配错(bun 跑 0 条也退出 0,#647)。"
  exit 1
fi
echo "✓ [a] ${WORKDIR} 整包 ${pass} 条真的执行了(CI=1 口径,地板 ${FLOOR})"

# ── [b] alpha 判据文件逐个点名 ────────────────────────────────────────────────
if [ ! -f "$PATCH" ]; then
  echo "::error::${PATCH} 不存在 —— ADR-034 的 SOT 搬家了而本门没跟,测量作废。"
  exit 1
fi
all_delta="$(grep -a '^diff --git a/' "$PATCH" | sed 's|^diff --git a/||; s| b/.*$||' | sort -u)"
if [ -z "$all_delta" ]; then
  echo "::error::${PATCH} 里一条 diff --git 都没解析到 —— 补丁为空或解析器退化,本次测量作废。"
  exit 1
fi
delta_tests="$(printf '%s\n' "$all_delta" | grep -aE '^packages/app/.*\.test\.(ts|tsx)$' | sed 's|^packages/app/||' || true)"
if [ -z "$delta_tests" ]; then
  # 解析器已被上面的非空自检证活;补丁确实没有 app 测试文件时这半边合法为空。
  echo "✓ [b] 补丁 delta 里没有 packages/app 测试文件(解析器自检已过),点名半边本次为空。"
  exit 0
fi
# `#946` R1(对抗审计 Major):旧判据 pass_b ≥ 文件数,即「每个文件至少一条」—— 粒度比它
# 要防的缺陷粗一格:给 12 条的 permission-auto-respond.test.ts 包一层
# `describe.skipIf(!!process.env.CI)`(绕过口正是本门自己钉的 CI=1)后,汇总行的文件数
# 不变(skip 的文件仍计入 across M files)、40 ≥ 4 照样绿 —— #946 立票那句「判据可被
# 无声移除」在门后依然成立。改成逐文件登记**精确条数**(#844 同款语义:少 = 用例被删/
# 清空/skip;多 = 新增未登记,可被静默删掉 —— 两个方向都当场红)。
#
# 为什么条数不进 gate-files.tsv:那条路径经 bun-test-floor.sh,既不钉 CI=1 也不带
# `--preload ./happydom.ts`,packages/app 的判据在那个口径下跑不起来;条数登记在本文件,
# 与 CI=1 钉在同一处。改动 alpha 判据用例后把下表改成实测值,让评审读这一行 diff。
# 表与补丁 delta **双向核对**:补丁里有而表里没有 = 红(新增判据文件必须登记);
# 表里有而补丁里没有 = 红(文件退场必须删行)—— 哪个方向都不许静默漂移。
REGISTERED_COUNTS="
src/components/prompt-input/submit.test.ts 8
src/context/permission-auto-respond.test.ts 12
src/pages/layout/helpers.test.ts 22
src/utils/session-route.test.ts 10
"

lookup_registered() {
  printf '%s\n' "$REGISTERED_COUNTS" | awk -v f="$1" '$1 == f { print $2 }'
}

# 反向核对:登记了但已从补丁退场的行必须删掉,否则表漂成第二个假 SOT。
while read -r reg_file reg_count; do
  [ -n "$reg_file" ] || continue
  if ! printf '%s\n' "$delta_tests" | grep -Fqx -- "$reg_file"; then
    echo "::error::REGISTERED_COUNTS 里的 ${reg_file}(${reg_count} 条)已不在补丁 delta 里 —— 文件退场必须同步删登记行,不许留一条对着空气的判据。"
    exit 1
  fi
done <<EOF
$REGISTERED_COUNTS
EOF

checked=0
total_pass=0
# 逐行展开正是本意(路径来自 git,无空白字符)。
for t in $delta_tests; do
  expected="$(lookup_registered "$t")"
  case "$expected" in
    ''|*[!0-9]*)
      echo "::error::补丁 delta 里的 ${t} 没在本脚本 REGISTERED_COUNTS 登记精确条数 —— 未登记的判据可以被静默删掉(#844 的类缺陷)。实测条数后加一行再来。"
      exit 1 ;;
  esac
  set +e
  run_bun_test "$t"
  status=$?
  set -e
  # `|| true`:文件被删时 bun 不打汇总行,grep 空手而归 —— pipefail+set -e 会让脚本在这行
  # **无诊断地**静默死掉(实验 3 实测),红要落到下面带 bun 原话的分支,不许哑巴退出。
  files="$(grep -aoE 'Ran [0-9]+ tests? across [0-9]+ files?' "$log" | tail -1 | sed -E 's/.*across ([0-9]+) files?.*/\1/' || true)"
  pass_b="$(sed -n 's/^[[:space:]]*\([0-9][0-9]*\) pass$/\1/p' "$log" | tail -1)"
  [ -z "$pass_b" ] && pass_b=0
  if [ "$status" -ne 0 ]; then
    summarize
    echo "::error::alpha 判据文件 ${t} 点名重跑失败(exit=${status})。bun 输出:"
    cat "$log"
    exit 1
  fi
  if [ "${files:-0}" -ne 1 ]; then
    summarize
    echo "::error::alpha 判据文件 ${t}:点名要求恰好匹配 1 个文件,实际 ${files:-0} 个 —— 文件被删/改名(整包地板抓不到单文件消失)。"
    exit 1
  fi
  if [ "$pass_b" -ne "$expected" ]; then
    summarize
    echo "::error::alpha 判据文件 ${t}:实测 ${pass_b} 条 ≠ 登记 ${expected} 条。少 = 用例被删/清空/skip(本门钉 CI=1,skipIf(CI) 包住即掉 pass);多 = 新增未登记。刻意改动请更新 REGISTERED_COUNTS 并让评审读这行 diff。"
    exit 1
  fi
  checked=$((checked + 1))
  total_pass=$((total_pass + pass_b))
  echo "   · ${t}:${pass_b} 条 = 登记精确条数"
done
echo "✓ [b] alpha 判据文件 ${checked} 个逐个点名,${total_pass} 条逐文件精确匹配登记条数"
