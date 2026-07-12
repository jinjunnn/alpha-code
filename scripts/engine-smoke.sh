#!/usr/bin/env bash
# engine-smoke — 引擎运行时最小冒烟(S39 复盘病灶 2:ADR-020 预警的「运行时契约漂移,
# typecheck 测不全」此前无机械兜底;每日 sync 后引擎行为变化只能等真机撞见)。
#
# 做三件事:① 无头启动合并后的引擎;② 打关键端点(/config/providers,弹窗/composer 的
# 取数面);③ 硬杀后同端口重启再打一遍(respawn 族覆盖 —— REQ-083 verified 当天 stage5
# 曾在 sync 后的引擎上僵死)。任一步失败 → 退出非零(sync 工作流红 = 引擎运行时冒烟破,
# 发布前必须人工排查;见 sync-upstream.yml 对应 step)。
#
# 本地:bash scripts/engine-smoke.sh(需已 bun install)
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
PORT="${ENGINE_SMOKE_PORT:-4573}"
LOG="${TMPDIR:-/tmp}/engine-smoke.log"
ENGINE_PID=""

cleanup() { [ -n "$ENGINE_PID" ] && kill -9 "$ENGINE_PID" 2>/dev/null; wait "$ENGINE_PID" 2>/dev/null || true; }
trap cleanup EXIT

probe() { # $1 = label;15s 超时 —— 悬挂(连接被接受但响应不来)与失败同判(异步四态纪律)
  local code
  code="$(curl -s -m 15 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/config/providers" || echo "curl:$?")"
  if [ "$code" != "200" ]; then
    echo "  ✗ $1: /config/providers → $code"
    tail -25 "$LOG" 2>/dev/null
    return 1
  fi
  echo "  ✓ $1: /config/providers 200"
}

boot() { # $1 = label
  bun run packages/opencode/src/index.ts serve --port "$PORT" --hostname 127.0.0.1 >"$LOG" 2>&1 &
  ENGINE_PID=$!
  for _ in $(seq 1 60); do
    if curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/config/providers"; then return 0; fi
    if ! kill -0 "$ENGINE_PID" 2>/dev/null; then
      echo "  ✗ $1: engine process died during boot"
      tail -25 "$LOG"
      return 1
    fi
    sleep 1
  done
  echo "  ✗ $1: engine not reachable within 60s"
  tail -25 "$LOG"
  return 1
}

echo "▶ engine smoke: boot #1"
boot "boot#1" || exit 1
probe "boot#1" || exit 1

echo "▶ hard-kill engine (respawn-family coverage)"
kill -9 "$ENGINE_PID"
wait "$ENGINE_PID" 2>/dev/null || true
ENGINE_PID=""
sleep 1

echo "▶ engine smoke: boot #2 (same port, post-kill)"
boot "boot#2" || exit 1
probe "boot#2" || exit 1

echo "✅ engine smoke green"
