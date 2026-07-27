#!/usr/bin/env bash
#
# 跑 `bun test`,并断言**实际执行的用例数**不低于给定下界。
#
# 存在理由(#647 codex 第 1 轮 Major ②):`bun test` 对「文件被清空 / 用例被条件注册成零条 /
# 指定的测试文件根本不存在」都会打印 `Ran 0 tests` 并**退出 0**。只看退出码的 CI 步骤因此在
# 闸门消失时全绿 —— 一个跑 0 个用例还报绿的步骤,比没有这一步更坏:它会训练所有人相信
# 「绿 = 验过了」。退出码只证明「没有失败」,不证明「真的验了什么」。
#
# 用法:bash scripts/bun-test-floor.sh <下界> <工作目录> <bun test 参数...>
#
# 下界怎么取:
#   · 整套 suite → 取一个**不随正常增删漂移**的地板(如 3000 对 3085)。会漂移的阈值早晚被
#     调松或删掉,那又是一个自毁的闸门。这一层抓的是**灾难性丢失**(suite 加载失败、成片删除、
#     runner 配错),抓不到「少了几条」。
#   · 单个闸门文件 → 单独一步、取该文件的固定用例数下界。这一层才抓得到「某个闸门文件被删掉」。
#     两层都要有:地板管灾难,点名管单个闸门。
set -euo pipefail

if [ "$#" -lt 3 ]; then
  echo "usage: $0 <floor> <workdir> <bun test args...>" >&2
  exit 2
fi

floor="$1"
workdir="$2"
shift 2

log="$(mktemp)"
trap 'rm -f "$log"' EXIT

set +e
(cd "$workdir" && bun test "$@") 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
set -e

pass="$(sed -n 's/^[[:space:]]*\([0-9][0-9]*\) pass$/\1/p' "$log" | tail -1)"
[ -z "$pass" ] && pass=0

echo "── bun exit=${status} · 实际通过 ${pass} 条 · 下界 ${floor} · (${workdir}: $*)"

if [ "$status" -ne 0 ]; then
  echo "::error::${workdir} $* —— 测试失败"
  exit 1
fi

if [ "$pass" -lt "$floor" ]; then
  echo "::error::${workdir} $* —— 只跑了 ${pass} 条断言,低于下界 ${floor}。用例被删除/清空/条件注册成零条时,bun 会打印 Ran 0 tests 并退出 0,只看退出码的步骤会全绿。"
  exit 1
fi

echo "✓ ${pass} 条断言真的执行了(${workdir}: $*)"
