#!/usr/bin/env bash
#
# `#890` —— 把 `.github/required-contexts.txt` 与 **GitHub 上今天真正生效的** required status
# checks 比一次。
#
# 大白话:决定「这个 PR 能不能合」的那份清单住在 GitHub 的分支保护设置里;仓库里那份是**手抄
# 的**。抄漏一条的后果是安静的 —— 那道检查从此不再必需,它红着的 PR 照样能合,而仓内测试
# **全绿**:`#717` 的两条断言只把手抄件与 alpha-ci 的 job 名对齐,两边一起错就一起自洽。
# 更远一层:`#895` 那两条(必需 job 必须带 `!cancelled()` + 跑 assert-detect-classified.sh)
# 遍历的也是这份手抄件 —— 手抄件漏一条,那条真必需的检查连 `#895` 的保护都没有。
#
# 为什么这道门只在本地跑,不在 CI 跑:读分支保护要带令牌,而 alpha-ci 触发在 `pull_request`
# —— fork PR **结构上**拿不到 secrets。在 CI 里加这一步,只会做出一个在 fork PR 上恒失败或
# 恒跳过的假门。有鉴权的地方是开发机,所以它挂在 scripts/alpha-check.sh 的最后一步。
#
# ── 退出码是三档,不是两档 ────────────────────────────────────────────────────
#   0  比对过了,逐条相同
#   1  比对过了,**不一致**(或手抄件本身不可用)—— 点名差在哪几条
#   2  **未比对**:真源没读到(没装 gh / 没登录 / 令牌无权限 / 网络不通)
#
# 第 2 档必须与第 0 档分开。把「读不到真源」吞成「通过」,就是又一个「看起来在测、其实没测」
# 的假门 —— 本仓已登记的形态。alpha-check.sh 收到 2 时不判红(这台机器到 api.github.com 走的
# 代理会间歇失败,让它拦 push 只会逼出 `--no-verify`,那是本仓栽过的更贵的形态),但它的**总结
# 行不许再说「全绿」**:未比对就是未比对。
#
# ── 真源怎么问:2026-08-11 实跑四种形状,不是读官方文档 ──────────────────────
# 问 `branches/<b>` 而不是 `branches/<b>/protection`。后者在**分支保护被整个关掉**时回 HTTP
# 404,在退出码上与「网络不通」分不开 ⇒ 最该变红的那一刻反而报「未比对」。实测(gh 2.88.1):
#   repos/jinjunnn/alpha-code/branches/alpha        → enabled=true  + 四行 context=…
#   repos/jinjunnn/alpha-code/branches/dev          → enabled=false + 零行 context(保护是关的)
#   repos/jinjunnn/alpha-code                       → enabled=null  + 零行 context(没有 protection 字段)
#   repos/…/branches/dev/protection                 → {"message":"Branch not protected"} + HTTP 404 + 非零退出
# 另一处同源的坑:`--jq '.required_status_checks.contexts[]'` 少了那个 `?`,字段为 null 时 jq
# 直接报 `cannot iterate over: null` 并非零退出 —— 同样把「一条必需检查都没有」这个灾难态
# 伪装成「读不到」。加上 `?` 它回空集,于是走进下面的比对、当场红。
#
# ── 判据在哪 ──────────────────────────────────────────────────────────────────
# packages/ui-mac/src/main/local-gate-parity.test.ts(`#890` 那几条):用假的 `gh`(PATH 注入,
# 生产代码里**没有**任何「真源从哪来」的开关 —— 那种开关自己就是绕过口)驱动这个脚本本体,
# 钉住三个方向各自的退出码与点名内容。不断言本文件的源码文本:那按本仓定义是假闸门。
set -uo pipefail
export LC_ALL=C

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SNAPSHOT_FILE="$ROOT/.github/required-contexts.txt"

# 这两行必须与 .github/required-contexts.txt 抬头写着的那条命令逐字一致 —— 人手对一次真源时
# 照抄的就是那条,上面那个测试会把两者比对(不一致即红:文档说的和门跑的不是一回事)。
API_PATH="repos/jinjunnn/alpha-code/branches/alpha"
API_JQ='"enabled=\(.protection.enabled)", (.protection.required_status_checks.contexts[]? | "context=\(.)")'

[ -f "$SNAPSHOT_FILE" ] || {
  echo "::error::找不到手抄快照:$SNAPSHOT_FILE"
  exit 1
}

# 手抄件的解析口径与 local-gate-parity.test.ts 的 parseRequiredContexts 同构:去掉整行注释、
# 去掉首尾空白、丢弃空行。两处若漂开,「记录 N 条」那个数会与测试里的解析对不上而变红。
snapshot="$(grep -av '^[[:space:]]*#' "$SNAPSHOT_FILE" |
  sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' |
  grep -av '^$' | sort -u)"
snapshot_n=0
[ -n "$snapshot" ] && snapshot_n="$(printf '%s\n' "$snapshot" | wc -l | tr -d ' ')"
if [ "$snapshot_n" -eq 0 ]; then
  echo "::error::$SNAPSHOT_FILE 解析出 0 条 context —— 文件被清空,或它的格式被改坏了。"
  echo "         空清单与任何真源比都恒「一致」,那是把这道门换成一句空话。"
  exit 1
fi

stderr_file="$(mktemp)"
trap 'rm -f "$stderr_file"' EXIT

if ! raw="$(gh api "$API_PATH" --jq "$API_JQ" 2>"$stderr_file")"; then
  reason="$(tr '\n' ' ' <"$stderr_file" | sed -e 's/  */ /g' -e 's/^ //' -e 's/ $//' | cut -c1-400)"
  echo "⚠️  未比对:读不到 GitHub 上的分支保护真源(没装 gh / 没登录 / 令牌无权限 / 网络不通)"
  echo "    gh api $API_PATH → ${reason:-<无输出>}"
  echo "    ⇒ 本次**没有任何证据**说明 $SNAPSHOT_FILE 与真源一致 —— 它只是没被检查。"
  exit 2
fi

enabled="$(printf '%s\n' "$raw" | sed -n 's/^enabled=//p' | head -n1)"
case "$enabled" in
true) ;;
false)
  echo "::error::alpha 的分支保护是**关的**(protection.enabled=false)—— 一条必需检查都没有,"
  echo "         任何 PR 都能合。仓内 $SNAPSHOT_FILE 记着 $snapshot_n 条,全部落空。"
  exit 1
  ;;
*)
  echo "⚠️  未比对:真源回来的 JSON 里读不到 protection(enabled=[${enabled:-<缺这一行>}])。"
  echo "    令牌可能没有读分支保护的权限,或这个 API 的形状变了 —— 两种都不能当成「一致」。"
  exit 2
  ;;
esac

truth="$(printf '%s\n' "$raw" | sed -n 's/^context=//p' |
  sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' |
  grep -av '^$' | sort -u)"

emit() {
  [ -n "$1" ] && printf '%s\n' "$1"
  return 0
}
only_snapshot="$(comm -23 <(emit "$snapshot") <(emit "$truth"))"
only_truth="$(comm -13 <(emit "$snapshot") <(emit "$truth"))"

if [ -n "$only_snapshot" ] || [ -n "$only_truth" ]; then
  echo "::error::.github/required-contexts.txt 与 alpha 分支保护**不一致**(真源在 GitHub 那边,不是这个文件)"
  if [ -n "$only_snapshot" ]; then
    echo "  ▸ 仓内记录有、真源**没有** —— 这几道检查其实不必需:它们红着的 PR 照样能合,而仓内全绿"
    printf '%s\n' "$only_snapshot" | sed 's/^/      - /'
  fi
  if [ -n "$only_truth" ]; then
    echo '  ▸ 真源有、仓内记录**没有** —— 这几道真必需的检查在仓内没人登记:#717 会把它当成'
    echo '    「不必需」放过,#895 的 !cancelled() + assert-detect-classified.sh 也不覆盖它'
    printf '%s\n' "$only_truth" | sed 's/^/      - /'
  fi
  echo "  修法:先定哪一边是对的。改真源是 owner 的动作(gh api --method PUT …);改记录就直接编辑"
  echo "        那个文件 —— 两件事必须在同一轮里做完,否则下一次 push 还会红在这里。"
  exit 1
fi

echo "✓ required contexts 与 alpha 分支保护逐条相同(记录 $snapshot_n 条)"
