#!/usr/bin/env bash
#
# 逐个跑 scripts/gate-files.tsv 里登记的**闸门文件**,每个都断言「文件还在且真的跑了
# **恰好登记的那么多条**」(`#844`:精确条数,不再是留余量的下界)。
#
# 为什么不能只靠整包地板(本仓已犯过两次的错):
#   整包地板抓灾难性丢失,抓不到单个文件消失 —— 删掉一个 8 条用例的闸门,3085→3077 仍远高于
#   地板 3000,**全绿**;ext 删掉 26 条的 drift lock,132→106 仍高于地板 100,**全绿**。
# 为什么下界也不够(`#844`,第二次同类):
#   下界留 ~20% 余量时,**新加进闸门文件的用例可以被整段删掉而登记簿全绿** —— #828 加的
#   7 条闸删掉后 90→83 仍 ≥ 旧下界 74。实测 87 条登记里 35 条有余量(合计 131 条用例
#   处于可静默删除态),其中两条 guarantee 里明写「不留余量」的也已漂移。
#   等号修的是类:对新增的闸门默认保护,对删除默认拒绝。
# 三层各管各的:地板管灾难,本脚本管单点,精确条数管单点里的单条。
#
# `#1153`:平台条件闸与退出码三档(与 alpha-check 第 [2/10]/[9/10]/[10/10] 步同形):
#   0 = 全部适用行已验证;1 = 真失守(文件被删/条数偏离/标注与自报不符/登记簿坏),拦住;
#   2 = 门绿,但存在「本平台不适用」的平台条件行 —— 本次运行不构成那几行的证据,消费方记
#       「未验证」不拦(硬红会训练下一个人把 darwin-only 判据摘出登记簿,即 #1153 的病根)。
# guarantee 列的逐字 `[平台:darwin]`/`[平台:linux]` 标该行只在那个平台适用;不适用平台上
# **仍然真跑**该文件并要求它自报 0 条(bun 1.3.14 实测:整文件 describe.skip ⇒
# `0 pass … Ran N tests across 1 file` 且 exit 0)—— 标注不是免检牌:该跑的文件被误标
# ⇒ 本平台 >0 条当场红;文件被删 ⇒ 匹配 0 个文件当场红。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/scripts/gate-files.tsv"

usage() {
  cat <<'EOF'
用法:bash scripts/assert-gate-files.sh [--update|--help]

(无参数)  逐条跑登记簿,断言每个闸门文件「在位、绿、恰好跑了登记的条数」。
           条数少了 = 有用例被删/清空/skip;多了 = 新增用例未登记(未登记 = 可被静默
           删除)。两个方向都当场红。

--update   从实测**自动写回**登记簿:逐条跑,全部绿之后把每行的登记条数改成实测值
           (all-or-nothing:任何一条测试失败就一条都不写回)。幂等 —— 登记与实测
           一致时零改动。给闸门文件加/删用例后跑这一条即可,让评审读 TSV 的 diff。

例外语法:登记簿第 1 列写 `>=N`(而不是 `N`)= 该行退回下界语义。例外必须具名:
           该行 guarantee 列必须含完整且理由有非空白字符的 `[例外:<理由>]`,否则判红。
           --update 不改写例外行
           的数字(例外行由人维护)。当前登记簿零范围例外(#844 勘破实测,条数逐
           commit 确定);平台条件闸(见下)不算范围例外。

平台条件闸:guarantee 列含逐字 `[平台:darwin]` / `[平台:linux]`(至多一个,不与 `>=N` 叠加)
           = 该行只在那个平台适用(`#1153`)。适用平台照常精确条数;不适用平台仍真跑该文件
           并要求它**自报 0 条** —— 标注不是免检牌:该跑的文件被误标 ⇒ >0 条当场红;文件
           被删 ⇒ 匹配 0 个文件当场红。--update 在不适用平台对这类行只验证、不测量、不写回。

退出码三档:0 = 全部适用行已验证;1 = 真失守,拦住;2 = 门绿但存在「本平台不适用」行
           (本次运行不构成那几行的证据,消费方记「未验证」不拦;--help 与参数错误也用 2,
           仅人手可达 —— 门的调用方不带参数)。

文档:docs/runbooks/ci.md「闸门文件点名」一节。
EOF
}

MODE=check
case "${1:-}" in
  --help|-h) usage; exit 0 ;;
  --update) MODE=update; shift ;;
  '') ;;
  *) echo "::error::未知参数:$1" >&2; usage >&2; exit 2 ;;
esac
[ "$#" -eq 0 ] || { echo "::error::多余参数:$*" >&2; usage >&2; exit 2; }

[ -f "$MANIFEST" ] || { echo "::error::闸门登记簿缺失:$MANIFEST"; exit 1; }

failed=0
checked=0
updates="$(mktemp)"
countfile="$(mktemp)"
seenfile="$(mktemp)"
trap 'rm -f "$updates" "$countfile" "$seenfile"' EXIT

# `#1153`:平台条件闸的运行平台。词表 = process.platform 取值(登记标注用同一词表,
# 于是「登记的平台」与「测试文件自己 gate 的 process.platform」说的是同一种话)。
case "$(uname -s)" in
  Darwin) RUNTIME_PLATFORM=darwin ;;
  Linux)  RUNTIME_PLATFORM=linux ;;
  *)      RUNTIME_PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')" ;;
esac
na_count=0
na_names=""

while IFS=$'\t' read -r floor workdir path delegates guarantee || [ -n "${floor:-}" ]; do
  case "${floor:-}" in ''|\#*) continue ;; esac
  [ -n "${workdir:-}" ] && [ -n "${path:-}" ] || { echo "::error::登记簿格式错误:$floor $workdir $path"; failed=1; continue; }
  # delegates_to 默认拒:没有委派也必须显式写 `-`,留空即红。
  [ -n "${delegates:-}" ] || { echo "::error::$workdir/$path 的 delegates_to 列为空 —— 没有委派请显式写 '-'"; failed=1; continue; }

  # `(workdir,path)` 是登记簿主键。重复行会让 --update 的 awk 同时改写两行,甚至把人工维护的
  # `>=N` 例外静默改成精确数字;所有模式都先拒绝重复,写回保持 all-or-nothing。
  registry_key="${workdir}"$'\t'"${path}"
  if grep -Fqx -- "$registry_key" "$seenfile"; then
    echo "::error::登记簿重复路径:$workdir/$path —— (workdir,path) 必须唯一;否则 --update 会同时改写多行"
    failed=1
    continue
  fi
  printf '%s\n' "$registry_key" >> "$seenfile"

  # `#844`:`N` = 精确(默认);`>=N` = 具名例外(下界语义,理由必须写进 guarantee)。
  kind=exact
  spec="$floor"
  if [ "${floor#>=}" != "$floor" ]; then
    kind=range
    spec="${floor#>=}"
    if ! [[ "${guarantee:-}" =~ \[例外:([^][]*)\] ]] || ! [[ "${BASH_REMATCH[1]}" =~ [^[:space:]] ]]; then
      echo "::error::$workdir/$path 登记为范围例外($floor)但 guarantee 缺少完整且理由有非空白字符的 [例外:理由] —— 例外必须具名,不许静默退回下界"
      failed=1
      continue
    fi
  fi
  case "$spec" in
    ''|*[!0-9]*) echo "::error::$workdir/$path 的条数列非法:$floor"; failed=1; continue ;;
  esac
  if [ "$spec" -eq 0 ]; then
    echo "::error::$workdir/$path 的登记条数必须大于 0:$floor —— 空文件/零断言不能成为闸门"
    failed=1
    continue
  fi

  # `#1153`:平台条件标注。必须逐字合法且一行至多一个 —— 写歪不静默退化成普通行(默认拒:
  # 一个被打错的标注若被当普通行跑,在不适用平台上就是恒红;若被当不适用跳过,就是静默放行)。
  platform=""
  case "${guarantee:-}" in
    *"[平台"*)
      malformed=1
      if [[ "${guarantee:-}" =~ \[平台:(darwin|linux)\] ]]; then
        platform="${BASH_REMATCH[1]}"
        rest="${guarantee/\[平台:${platform}\]/}"
        case "$rest" in
          *"[平台"*) ;;
          *) malformed=0 ;;
        esac
      fi
      if [ "$malformed" -ne 0 ]; then
        echo "::error::$workdir/$path 的 [平台:…] 标注不合法 —— 只认逐字 [平台:darwin] / [平台:linux],且一行至多一个"
        failed=1
        continue
      fi
      if [ "$kind" = range ]; then
        echo "::error::$workdir/$path 同时登记了 [平台:$platform] 与范围例外($floor)—— 平台条件行只支持精确条数,不叠加下界语义"
        failed=1
        continue
      fi
      ;;
  esac

  checked=$((checked + 1))

  # `#1153`:登记了但本平台不适用。标注不是免检牌 —— 真跑该文件,要求它**自报 0 条**
  # (在位、恰好匹配 1 个文件、bun exit 0、0 pass;bun-test-floor.sh 的 =0 精确模式四者全断)。
  # 两个方向都抓:该跑的文件被误标 ⇒ 本平台 >0 条 ⇒ 红;文件被删 ⇒ 匹配 0 个文件 ⇒ 红。
  if [ -n "$platform" ] && [ "$platform" != "$RUNTIME_PLATFORM" ]; then
    echo "── [$checked] $workdir/$path (登记 $floor,[平台:$platform],本平台 $RUNTIME_PLATFORM)"
    if bash "$ROOT/scripts/bun-test-floor.sh" "=0" "$workdir" "$path"; then
      echo "   ⊘ 本平台不适用:文件在位且自报 0 条,与 [平台:$platform] 相符 —— 该行的保证本次未被验证"
      na_count=$((na_count + 1))
      na_names="${na_names:+$na_names, }$workdir/$path"
    else
      echo "::error::$workdir/$path 的 [平台:$platform] 标注与实测不符:要么该文件在本平台($RUNTIME_PLATFORM)真的会跑(>0 条 —— 摘掉标注并跑 --update 登记真实条数),要么文件被删/坏了(见上方输出)。标注不是免检牌。"
      if [ "$MODE" = update ]; then
        echo "::error::--update 中止:平台标注与实测不符 —— all-or-nothing,一条都不写回"
        exit 1
      fi
      failed=1
    fi
    continue
  fi

  if [ "$MODE" = update ]; then
    # 例外行照旧判下界(--update 不放松任何既有判定);精确行只要求绿,量到多少写多少。
    run_spec="0"
    [ "$kind" = range ] && run_spec="$spec"
    echo "── [$checked] measure $workdir/$path (登记 $floor)"
    : > "$countfile"
    if ! ALPHA_TEST_COUNT_FILE="$countfile" bash "$ROOT/scripts/bun-test-floor.sh" "$run_spec" "$workdir" "$path"; then
      echo "::error::--update 中止:$workdir/$path 测试失败 —— all-or-nothing,一条都不写回"
      exit 1
    fi
    measured="$(cat "$countfile")"
    case "$measured" in
      ''|*[!0-9]*) echo "::error::--update 中止:$workdir/$path 没量到条数(ALPHA_TEST_COUNT_FILE 空)"; exit 1 ;;
    esac
    if [ "$measured" -eq 0 ]; then
      echo "::error::--update 中止:$workdir/$path 实测 0 条 —— 文件被清空/路径写歪不允许被写回成 0"
      exit 1
    fi
    if [ "$kind" = exact ] && [ "$measured" != "$spec" ]; then
      printf '%s\t%s\t%s\n' "$workdir" "$path" "$measured" >> "$updates"
      echo "   ↳ 将写回:$spec → $measured"
    fi
    continue
  fi

  call_spec="=$spec"
  [ "$kind" = range ] && call_spec="$spec"
  echo "── [$checked] $workdir/$path (登记 $floor, 委派 ${delegates}) — ${guarantee:-}"
  if ! bash "$ROOT/scripts/bun-test-floor.sh" "$call_spec" "$workdir" "$path"; then
    echo "::error::闸门文件失守:$workdir/$path — ${guarantee:-}"
    failed=1
  fi
done < "$MANIFEST"

# 空登记簿 / 解析全挂 = 本脚本自己变成空闸门。显式判红。
if [ "$checked" -lt 25 ]; then
  echo "::error::只检查了 $checked 个闸门文件(至少应有 25 个)——登记簿被清空或解析失败"
  exit 1
fi

if [ "$MODE" = update ]; then
  # `#844` R3(Codex 三审):行级校验红(格式坏行/委派列空/例外无理由/条数列非法)以前只置
  # failed=1 就 continue,而本分支在写回/报成功前从不看它 —— 非法行被静默跳过、其余行照写照
  # 报 exit 0,破 all-or-nothing。校验红 = 登记簿本身坏了,一条都不许写回。
  if [ "$failed" -ne 0 ]; then
    echo "::error::--update 中止:登记簿存在非法行(见上方 ::error::)—— 先修登记簿,all-or-nothing,一条都不写回"
    exit 1
  fi
  if [ ! -s "$updates" ]; then
    if [ "$na_count" -gt 0 ]; then
      echo "✓ 登记簿与实测一致($((checked - na_count)) 条;另 $na_count 条平台条件闸本平台不适用 —— 已验证自报 0 条,未测量、未改动),零改动"
    else
      echo "✓ 登记簿与实测一致($checked 条),零改动"
    fi
    exit 0
  fi
  awk -F'\t' -v OFS='\t' '
    NR == FNR { m[$1 FS $2] = $3; next }
    /^[[:space:]]*#/ || NF < 3 { print; next }
    { key = $2 FS $3; if (key in m) $1 = m[key]; print }
  ' "$updates" "$MANIFEST" > "$MANIFEST.tmp"
  mv "$MANIFEST.tmp" "$MANIFEST"
  echo "✓ 已按实测写回 $(wc -l < "$updates" | tr -d ' ') 行;重跑 bash scripts/assert-gate-files.sh 复核,并让评审读 TSV 的 diff"
  exit 0
fi

[ "$failed" -eq 0 ] || exit 1
if [ "$na_count" -gt 0 ]; then
  # `#1153` 第三档:门绿,但平台条件行的保证本次未被验证 —— 总结行不许说「全部」,退出码 2
  # 供消费方(alpha-check [6/10] / alpha-ci 的 assert gate files 步)记「未验证」不拦。
  echo "⚠️  $((checked - na_count)) 个闸门文件在位且真的跑过(条数与登记精确一致);另 $na_count 个为平台条件闸,本平台($RUNTIME_PLATFORM)不适用 —— 已验证其自报 0 条与标注相符,但其保证本次未被验证:$na_names"
  exit 2
fi
echo "✓ $checked 个闸门文件全部在位且真的跑过(条数与登记精确一致)"
