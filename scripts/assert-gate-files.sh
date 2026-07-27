#!/usr/bin/env bash
#
# 逐个跑 scripts/gate-files.tsv 里登记的**闸门文件**,每个都断言「文件还在且真的跑了 ≥ 下界 条」。
#
# 为什么不能只靠整包地板(本仓已犯过两次的错):
#   整包地板抓灾难性丢失,抓不到单个文件消失 —— 删掉一个 8 条用例的闸门,3085→3077 仍远高于
#   地板 3000,**全绿**;ext 删掉 26 条的 drift lock,132→106 仍高于地板 100,**全绿**。
#   两层都要有:地板管灾难,本脚本管单点。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/scripts/gate-files.tsv"

[ -f "$MANIFEST" ] || { echo "::error::闸门登记簿缺失:$MANIFEST"; exit 1; }

failed=0
checked=0

while IFS=$'\t' read -r floor workdir path guarantee || [ -n "${floor:-}" ]; do
  case "${floor:-}" in ''|\#*) continue ;; esac
  [ -n "${workdir:-}" ] && [ -n "${path:-}" ] || { echo "::error::登记簿格式错误:$floor $workdir $path"; failed=1; continue; }
  checked=$((checked + 1))
  echo "── [$checked] $workdir/$path (下界 $floor) — ${guarantee:-}"
  if ! bash "$ROOT/scripts/bun-test-floor.sh" "$floor" "$workdir" "$path"; then
    echo "::error::闸门文件失守:$workdir/$path — ${guarantee:-}"
    failed=1
  fi
done < "$MANIFEST"

# 空登记簿 / 解析全挂 = 本脚本自己变成空闸门。显式判红。
if [ "$checked" -lt 15 ]; then
  echo "::error::只检查了 $checked 个闸门文件(至少应有 15 个)——登记簿被清空或解析失败"
  exit 1
fi

[ "$failed" -eq 0 ] || exit 1
echo "✓ $checked 个闸门文件全部在位且真的跑过"
