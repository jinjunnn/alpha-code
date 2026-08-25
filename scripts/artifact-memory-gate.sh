#!/usr/bin/env bash
# artifact-memory-gate — REQ-092 AC2 内存闸入口(#1114;alpha-work#1 AC2-a/AC2-b)。
#
# 判「100 MiB artifact 流式下载」在**出货运行时(Electron)**上的内存形态:
#   AC2-a 活内存(强制 GC)≤ 32 MiB · AC2-b 驻留高水位 ≤ 110 MiB ·
#   canary(整包 arrayBuffer 的已知坏形态)必须 > 110 —— 反例量不红 = 本次测量作废。
# 四条口径(Electron / 一臂一进程 / 标定过的独立裸 socket origin / 3 轮 + 离散度)缺一
# ⇒ 打印「本次测量作废」退出 3,不给数字。详见 scripts/artifact-memory-gate/run.ts 抬头。
#
# 不在 alpha-check 权威门内(单轮 ~20s,依赖本机 electron 二进制),与 engine-smoke.sh /
# req087-live-characterization.sh 同级:按需 / 改动传输路径(alpha-artifact-download.ts、
# artifact-service.ts 配额 finalizer)后 / 发布前人工执行。红 = 生产传输路径内存形态回退,
# 合并前必须排查。
#
# 本地:bash scripts/artifact-memory-gate.sh(需已 bun install;退出码 0=PASS 1=FAIL 3=作废)
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
exec bun run scripts/artifact-memory-gate/run.ts "$@"
