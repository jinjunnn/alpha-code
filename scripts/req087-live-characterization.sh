#!/usr/bin/env bash
# req087-live-characterization — REQ-087/REQ-088 C2 真引擎 characterization 套件入口。
#
# 覆盖 req087-characterization.test.ts 原六项 live-engine test.todo(AC4/5/6/7 + 焦点返回),
# 真实面:真引擎(packages/opencode serve,隔离 XDG 目录)+ 冻结 packages/app renderer
# (vite dev)+ 真实 Chromium(Playwright channel "chrome")+ 真实 PTY/SSE/权限机;
# 唯一脚本化的是模型 token 端点(OpenAI-compatible SSE fixture)。
#
# 不在 alpha-check 权威门内(依赖本机 Chrome 与较长运行时),与 engine-smoke.sh 同级:
# 按需/发布前人工执行,红 = legacy 行为面漂移,进入 REQ-088 前必须排查。
#
# 本地:bash scripts/req087-live-characterization.sh(需已 bun install)
# 可调:REQ087_LIVE_PORT_BASE(默认 14700)、REQ087_LIVE_HEADFUL=1(有头调试)
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

if [ "$(uname -s)" = "Darwin" ] && [ ! -d "/Applications/Google Chrome.app" ]; then
  echo "✗ 需要 Google Chrome(Playwright channel \"chrome\",不额外下载浏览器)" >&2
  exit 1
fi

echo "▶ REQ-087 live-engine characterization (6 items)"
bun run --cwd packages/ui-mac test:live:req087
status=$?
if [ "$status" -eq 0 ]; then
  echo "✅ live characterization green — legacy 行为面基线成立(基线数值见 packages/ui-mac/test-live/req087/baselines/legacy-baseline.json)"
else
  echo "❌ live characterization failed — legacy 行为面漂移或环境前提缺失,REQ-088 激活前必须排查" >&2
fi
exit "$status"
