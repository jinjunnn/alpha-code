#!/usr/bin/env bash
#
# `#895` —— alpha-ci 每个 **required** job 的第一步:证明 `detect` 真的给出了一个可用的分类。
#
# 它挡的是什么(大白话):alpha-ci 里四道必需检查的每一步,条件都是
# `needs.detect.outputs.code == 'true'`。detect 一旦没给出结论,那个值就是空串 ——
# 于是每一步都判假、一步不跑,而这一格照样报「通过」。也就是说**一道闸门都没真跑,PR 也能合**。
#
# 2026-08-11 在 PR #908 上实测过这个状态(不是推断,不是读官方文档):
#   detect changes                        → failure
#   north-star guard / typecheck / unit tests / docs gate → **全部 skipped**
#   PR:mergeable=true,mergeStateStatus=**UNSTABLE**(= 可合;required 那侧没拦)
#   同一个 commit,在四格还没上报时 mergeStateStatus 是 BLOCKED,四格变成 skipped 之后
#   转成 UNSTABLE —— 也就是 GitHub 把 **skipped 记成「已满足」**。
# 证据全文:docs/verification/2026-08-11-detect-failure-required-checks.md
#
# 为什么不能只给那四个 job 加 `if: !cancelled()` 就完事(这是本修复最大的陷阱):
#   detect 失败时 `needs.detect.outputs.code` 是空串 ⇒ job 里挂在 `== 'true'` 上的步骤仍然
#   一步不跑,但 job 本身会**零步骤报 success**。那是把灰色的谎话换成绿色的谎话,更坏。
#   docs-gate 更隐蔽:它那一步无条件跑,MD 为空时打印「no Markdown changed」直接绿。
#   所以 `!cancelled()` 必须与**这一步**成对出现:让 job 跑起来,只为了让它诚实地红。
#
# 为什么是一个文件而不是 workflow 里的一段内联 shell(与 `#717` 把 detect 抽成脚本同源):
#   内联时它没有任何判据 —— 断言 YAML 文本按本仓定义是假闸门。抽成文件,
#   packages/ui-mac/src/main/local-gate-parity.test.ts 才能真去跑**生产的这一份**,
#   用真实的 result/outputs 组合驱动它。
#
# 入参走 env(alpha-ci 从不把 ${{ }} 插进脚本文本):
#   DETECT_RESULT — `needs.detect.result`:success / failure / cancelled / skipped
#   DETECT_CODE   — `needs.detect.outputs.code`:'true' / 'false' / 空串
set -uo pipefail

result="${DETECT_RESULT-}"
# `code` 合法地可以是空串,所以这里用 ${VAR-} 而不是 ${VAR:?} —— 空串正是要判红的那个值,
# 它必须走到下面的 case 里被具名拒绝,而不是被参数展开顺手炸掉(错误信息会指错方向)。
code="${DETECT_CODE-}"

echo "detect: result=[${result}] outputs.code=[${code}]"

if [ "$result" != "success" ]; then
  echo "::error::alpha-ci 的分类步 detect 没有成功(result=[${result}])—— 本 job 的闸门步骤全部挂在 needs.detect.outputs.code 上,继续跑等于一步不跑还报绿。先修 detect。"
  exit 1
fi

case "$code" in
  true | false) ;;
  *)
    echo "::error::detect 成功了,但 needs.detect.outputs.code=[${code}] 既不是 'true' 也不是 'false' —— 每个 \`== 'true'\` 条件都会判假,本 job 会零步骤报绿。scripts/detect-changed-scope.sh 必须往 \$GITHUB_OUTPUT 写 code=true|false。"
    exit 1
    ;;
esac

echo "✓ detect 给出了可用的分类(code=${code})—— 本 job 的闸门步骤按它跑"
