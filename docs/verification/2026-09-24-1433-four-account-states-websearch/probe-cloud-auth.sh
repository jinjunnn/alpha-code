#!/usr/bin/env bash
# alpha-code#1433 —— 云腿凭证面的三臂探针。**不需要任何凭证**,也因此测不到 402。
#   bash docs/verification/2026-09-24-1433-four-account-states-websearch/probe-cloud-auth.sh
set -euo pipefail
URL="https://alpha-cloud.tidelabs.click/mcp"
BODY='{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
probe() { # $1=label $2=extra header (may be empty)
  local code body
  body=$(mktemp)
  if [ -n "$2" ]; then
    code=$(curl -sS -m 20 -o "$body" -w '%{http_code}' -X POST -H 'content-type: application/json' \
      -H 'accept: application/json, text/event-stream' -H "$2" --data "$BODY" "$URL")
  else
    code=$(curl -sS -m 20 -o "$body" -w '%{http_code}' -X POST -H 'content-type: application/json' \
      -H 'accept: application/json, text/event-stream' --data "$BODY" "$URL")
  fi
  printf '%s\thttp=%s\t%s\n' "$1" "$code" "$(head -c 200 "$body")"
  rm -f "$body"
}
probe "no-auth       " ""
probe "bogus-bearer  " "authorization: Bearer not-a-real-token"
probe "empty-bearer  " "authorization: Bearer "
