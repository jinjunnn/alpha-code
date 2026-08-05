#!/usr/bin/env bash
#
# 跑 `bun test`,并断言**实际执行的用例数**符合给定期望。期望有两种形态(`#844`):
#   · `N`  —— 下界:pass ≥ N。整包地板专用(3000/100/15 这类刻意留大余量的灾难闸)。
#   · `=N` —— 精确:pass == N,且本次运行必须恰好跑了 1 个文件。闸门登记簿
#             (scripts/gate-files.tsv)专用 —— 下界留余量时,新加进闸门文件的用例
#             可以被整段删掉而登记簿全绿(#844 实测 35/87 条有余量);精确条数让
#             「删一条」与「加一条没登记」都当场红。
#
# 存在理由(#647 codex 第 1 轮 Major ②):`bun test` 对「文件被清空 / 用例被条件注册成零条 /
# 指定的测试文件根本不存在」都会打印 `Ran 0 tests` 并**退出 0**。只看退出码的 CI 步骤因此在
# 闸门消失时全绿 —— 一个跑 0 个用例还报绿的步骤,比没有这一步更坏:它会训练所有人相信
# 「绿 = 验过了」。退出码只证明「没有失败」,不证明「真的验了什么」。
#
# 用法:bash scripts/bun-test-floor.sh <下界|=精确条数> <工作目录> <bun test 参数...>
#
# 下界怎么取:
#   · 整套 suite → 取一个**不随正常增删漂移**的地板(如 3000 对 3085)。会漂移的阈值早晚被
#     调松或删掉,那又是一个自毁的闸门。这一层抓的是**灾难性丢失**(suite 加载失败、成片删除、
#     runner 配错),抓不到「少了几条」。
#   · 单个闸门文件 → 单独一步、取该文件的固定用例数下界。这一层才抓得到「某个闸门文件被删掉」。
#     两层都要有:地板管灾难,点名管单个闸门。
set -euo pipefail

# 参数可以只有 floor + workdir(整包跑,等价于原来的裸 `bun test`),也可以再带 bun test 的过滤参数。
if [ "$#" -lt 2 ]; then
  echo "usage: $0 <floor|=exact-count> <workdir> [bun test args...]" >&2
  exit 2
fi

floor="$1"
workdir="$2"
shift 2

# `#844`:`=N` = 精确模式(闸门登记簿);裸 `N` = 下界模式(整包地板,语义与输出不变 ——
# gate-environment.test.ts:74-79 以裸数字直接调本脚本并逐字断言输出行,不许动)。
exact=""
if [ "${floor#=}" != "$floor" ]; then
  exact=1
  floor="${floor#=}"
fi
case "$floor" in
  ''|*[!0-9]*) echo "::error::非法的条数参数:${exact:+=}${floor}" >&2; exit 2 ;;
esac

# ── 每条用例的默认超时(`#777` 的环境咽喉)──────────────────────────────────────
# bun 默认 5000ms。本仓有 31 条 host 用例在子进程里跑**一整套** `.cases.ts`,5 秒对它们
# 不是超时,是**机器速度在替断言下判决**:2026-08-02 起 alpha 主线 `unit tests (alpha packages)`
# 连红两天,其中三条就是这个(host 5035.75ms / 子用例 5933.51ms、6447.61ms),
# 而同一棵树在开发机上 0 fail。这种红最贵 —— 它会被读成「间歇性 flaky」,一道真闸被当噪声。
#
# 为什么闸门在这里、而不是每个测试文件各写一遍:所有**闸门**运行(CI 的三条 test 步、
# assert-gate-files.sh 的逐条点名、alpha-check.sh 的 [4/7])都经过本脚本 —— 一处声明,
# 新增的门默认拿到。单条用例仍可显式覆盖(显式值恒胜,已实测)。
#
# 为什么是 CLI flag 而不是别的(bun 1.3.14,全部实测,不是推断):
#   · bunfig.toml 的 `[test] timeout` **不被读取** —— 写了照样 5000ms 被杀;
#   · BUN_TEST_TIMEOUT / BUN_TIMEOUT / BUN_TEST_TIMEOUT_MS 全部无效;
#   · preload 里 `setDefaultTimeout()` **只对一次运行的第一个文件生效** —— 单文件跑得通,
#     `bun test src`(257 个文件)从第二个文件起就退回 5000ms。**单文件探针会给你一个假的通过**;
#   · preload 里 `beforeAll(() => setDefaultTimeout(...))` 同样无效;
#   · `bun test --timeout N` 跨全部文件生效 —— 只有这一条成立。
# 取值 120s:与仓内已显式声明超时的那批同档(最慢的正当 host 在 CI 上实测 37.7s)。
# 超时不是断言:卡死的用例仍会在 120s 内判红,而 5s 的代价是让真闸在慢机器上恒假红。
ALPHA_TEST_TIMEOUT_MS="${ALPHA_TEST_TIMEOUT_MS:-120000}"

log="$(mktemp)"
trap 'rm -f "$log"' EXIT

set +e
(cd "$workdir" && bun test --timeout "$ALPHA_TEST_TIMEOUT_MS" "$@") 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
set -e

pass="$(sed -n 's/^[[:space:]]*\([0-9][0-9]*\) pass$/\1/p' "$log" | tail -1)"
[ -z "$pass" ] && pass=0

if [ -n "$exact" ]; then
  echo "── bun exit=${status} · 实际通过 ${pass} 条 · 登记精确条数 ${floor} · (${workdir}: $*)"
else
  echo "── bun exit=${status} · 实际通过 ${pass} 条 · 下界 ${floor} · (${workdir}: $*)"
fi

if [ "$status" -ne 0 ]; then
  echo "::error::${workdir} $* —— 测试失败"
  exit 1
fi

# `#844`:供 assert-gate-files.sh --update 收集实测条数。写在断言之前:--update 需要的是
# 「测试绿时的实测值」,与当前登记值是否相符无关(它就是来修登记值的)。
if [ -n "${ALPHA_TEST_COUNT_FILE:-}" ]; then
  printf '%s\n' "$pass" > "$ALPHA_TEST_COUNT_FILE"
fi

if [ -n "$exact" ]; then
  # 精确模式一次只能点名一个文件:bun test 的参数是路径**过滤器**,一个写歪的路径可以
  # 匹配到 0 个或多个文件,条数碰巧凑对就是假绿。取最后一行 summary(host 内嵌子进程的
  # summary 在前,外层最后打印)。
  files="$(grep -aoE 'Ran [0-9]+ tests? across [0-9]+ files?' "$log" | tail -1 | sed -E 's/.*across ([0-9]+) files?.*/\1/')"
  if [ "${files:-0}" -ne 1 ]; then
    echo "::error::${workdir} $* —— 精确模式要求恰好点名 1 个文件,实际匹配了 ${files:-0} 个(路径写歪/文件被删/过滤器过宽)。"
    exit 1
  fi
  if [ "$pass" -lt "$floor" ]; then
    echo "::error::${workdir} $* —— 实际 ${pass} 条 < 登记 ${floor} 条:有用例被删除/清空/skip 掉了。若是刻意移除,跑 bash scripts/assert-gate-files.sh --update 并让评审读到这个 diff。"
    exit 1
  fi
  if [ "$pass" -gt "$floor" ]; then
    echo "::error::${workdir} $* —— 实际 ${pass} 条 > 登记 ${floor} 条:新增用例还没登记,现在它们可以被静默删掉(#844 的类缺陷)。跑 bash scripts/assert-gate-files.sh --update 写回实测条数。"
    exit 1
  fi
elif [ "$pass" -lt "$floor" ]; then
  echo "::error::${workdir} $* —— 只跑了 ${pass} 条断言,低于下界 ${floor}。用例被删除/清空/条件注册成零条时,bun 会打印 Ran 0 tests 并退出 0,只看退出码的步骤会全绿。"
  exit 1
fi

echo "✓ ${pass} 条断言真的执行了(${workdir}: $*)"
