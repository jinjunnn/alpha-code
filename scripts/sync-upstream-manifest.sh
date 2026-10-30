#!/usr/bin/env bash
# `#1567`(SEC):推送阶段读取候选清单 `manifest.env` 的唯一入口 —— 只解析,不执行。
#
# `sync-upstream-push.yml` 持有推送凭据,而 `manifest.env` 来自候选阶段的 artifact。此前那一步
# `source` 它:谁能改 artifact,谁就能在持有推送凭据的 job 里跑任意 shell(`$(…)`、额外语句)。
# 这里逐行按固定键名匹配,值必须是 40 位小写十六进制 sha(候选阶段写的四个值全是
# `git rev-parse` 的输出,见 `sync-upstream.yml`「Build sync bundle artifact」);
# 任何多余行、未知键、重复键、缺键、格式不符 ⇒ 非零退出。
#
# 用法:bash scripts/sync-upstream-manifest.sh <manifest.env> <key>  → stdout 打印该键的值
#
# 报错**不回显**被拒的行:那是不可信内容,原样打进 Actions 日志会被当作 `::` 工作流命令解释。
set -euo pipefail

file="$1"
want="$2"
keys="old_dev new_dev old_alpha new_alpha"
seen=" "
value=""
n=0

while IFS= read -r line || [ -n "$line" ]; do
  n=$((n + 1))
  if [[ ! "$line" =~ ^(old_dev|new_dev|old_alpha|new_alpha)=([0-9a-f]{40})$ ]]; then
    echo "::error::候选清单第 $n 行不是「<键>=<40 位十六进制 sha>」(键只能是 $keys)—— artifact 可能被篡改。Aborting." >&2
    exit 1
  fi
  key="${BASH_REMATCH[1]}"
  case "$seen" in
    *" $key "*)
      echo "::error::候选清单里 $key 出现不止一次 —— artifact 可能被篡改。Aborting." >&2
      exit 1
      ;;
  esac
  seen="$seen$key "
  if [ "$key" = "$want" ]; then value="${BASH_REMATCH[2]}"; fi
done <"$file"

for k in $keys; do
  case "$seen" in
    *" $k "*) ;;
    *)
      echo "::error::候选清单缺少 $k —— artifact 不完整。Aborting." >&2
      exit 1
      ;;
  esac
done

if [ -z "$value" ]; then
  echo "::error::sync-upstream-manifest.sh 被要求读取未知键「$want」(只认 $keys)。" >&2
  exit 1
fi
printf '%s\n' "$value"
