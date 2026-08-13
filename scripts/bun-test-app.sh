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
#       文件从补丁退场(= 还原成纯上游)则自然退出清单。判据 = `Ran … across M files`
#       的 M 恰好等于清单数(删掉/改名一个 alpha 判据文件 ⇒ 过滤器少匹配一个 ⇒ 红;
#       整包地板 600 对 626−13 这种量级抓不到)且 0 fail、pass ≥ 清单数。
#       解析器自证:补丁里一条 `diff --git` 都解不出来 = 解析器退化或 SOT 搬家,
#       打「测量作废」而不是静默跳过这半边(观测手段先证明能测出已知的坏)。
#
# 已知未覆盖(如实声明,不假装):
#   · parity 那条红在本门永不执行(上游 skipIf 治它)⇒ 若有朝一日 alpha 去改 locale 文件,
#     打穿 parity 本门看不见 —— 今日补丁 delta 零 i18n 文件,该风险不成立即不预建闸;
#   · 在 alpha 测试外面包一层 skipIf(CI) 可以静默出门 —— 与任何包里 `.skip` 同类,
#     [b] 的文件数判据不吃这一招(文件还在),靠 review 补丁 diff 看住。
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
summary="$(grep -aoE 'Ran [0-9]+ tests? across [0-9]+ files?' "$log" | tail -1)"
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
expected_files="$(printf '%s\n' "$delta_tests" | grep -ac '' || true)"
set +e
# shellcheck disable=SC2086 — 逐行展开为多个路径参数正是本意(路径来自 git,无空白字符)。
run_bun_test $delta_tests
status=$?
set -e
summarize
files="$(grep -aoE 'Ran [0-9]+ tests? across [0-9]+ files?' "$log" | tail -1 | sed -E 's/.*across ([0-9]+) files?.*/\1/')"
pass_b="$(sed -n 's/^[[:space:]]*\([0-9][0-9]*\) pass$/\1/p' "$log" | tail -1)"
[ -z "$pass_b" ] && pass_b=0
if [ "${files:-0}" -ne "$expected_files" ]; then
  echo "::error::alpha 判据文件点名:补丁 delta 枚举出 ${expected_files} 个测试文件,bun 实际只匹配到 ${files:-0} 个 —— 有 alpha 判据文件被删/改名(整包地板抓不到单文件消失)。清单:"
  printf '   %s\n' $delta_tests
  exit 1
fi
if [ "$status" -ne 0 ] || [ "$pass_b" -lt "$expected_files" ]; then
  echo "::error::alpha 判据文件点名重跑失败(exit=${status},pass=${pass_b},文件 ${expected_files} 个)。"
  exit 1
fi
echo "✓ [b] alpha 判据文件 ${expected_files} 个逐个点名,${pass_b} 条真的执行了"
