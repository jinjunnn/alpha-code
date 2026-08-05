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
           该行 guarantee 列必须含 `[例外:<理由>]`,否则判红。--update 不改写例外行
           的数字(例外行由人维护)。当前登记簿零例外 —— 87 个文件全部零平台/环境
           条件注册(#844 勘破实测),条数逐 commit 确定。

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
trap 'rm -f "$updates" "$countfile"' EXIT

while IFS=$'\t' read -r floor workdir path delegates guarantee || [ -n "${floor:-}" ]; do
  case "${floor:-}" in ''|\#*) continue ;; esac
  [ -n "${workdir:-}" ] && [ -n "${path:-}" ] || { echo "::error::登记簿格式错误:$floor $workdir $path"; failed=1; continue; }
  # delegates_to 默认拒:没有委派也必须显式写 `-`,留空即红。
  [ -n "${delegates:-}" ] || { echo "::error::$workdir/$path 的 delegates_to 列为空 —— 没有委派请显式写 '-'"; failed=1; continue; }

  # `#844`:`N` = 精确(默认);`>=N` = 具名例外(下界语义,理由必须写进 guarantee)。
  kind=exact
  spec="$floor"
  if [ "${floor#>=}" != "$floor" ]; then
    kind=range
    spec="${floor#>=}"
    case "${guarantee:-}" in
      *"[例外:"*) ;;
      *) echo "::error::$workdir/$path 登记为范围例外($floor)但 guarantee 缺少 [例外:理由] —— 例外必须具名,不许静默退回下界"; failed=1; continue ;;
    esac
  fi
  case "$spec" in
    ''|*[!0-9]*) echo "::error::$workdir/$path 的条数列非法:$floor"; failed=1; continue ;;
  esac

  checked=$((checked + 1))

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
    echo "✓ 登记簿与实测一致($checked 条),零改动"
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
echo "✓ $checked 个闸门文件全部在位且真的跑过(条数与登记精确一致)"
