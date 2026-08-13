#!/usr/bin/env bash
# assert-worktree-bootstrap.sh — `scripts/worktree-bootstrap.sh` 的**能力判据**(`#916`)。
#
# 判的不是「脚本在不在」「软链在不在」「文件里写没写 bun install」—— 那些按本仓自己的定义
# 是**假闸门**(断言产物 / 断言源码文本:把 `bun install` 那一行换成 `true`,它们照样全绿)。
# 这里判的是**能力**:真建一棵全新 worktree,在里面跑**真的** typecheck,断言它给得出可信结论。
#
# ── 退出码有三档(与 `#890` 的 assert-required-contexts.sh 同形)────────────────────
#   0  能力**已验证**
#   1  **真失守**:bootstrap 确实坏了 —— 拦住 push
#   2  **本次未验证**:装不上依赖的原因是环境(registry 不可达)⇒ 这道门这一跑什么都没证明。
#      **不拦 push**,但**不许报绿** —— 输出里必然出现「未验证」,聚合层的总结行也会跟着换掉。
#
# 为什么要有第 2 档(`#916` R2,owner 裁决):`bun install` **依赖网络**(实测:已装好的树
# 指向不可达 registry 也会 `failed to resolve`、exit 1),而这道门每次 push 都跑。不给豁免 ⇒
# 网络一抖就拦住 push,理由与本次改动无关 ⇒ 人会 `--no-verify` ⇒ **九道门一起关掉**。
# 那正是 `#890` 那条 lane 推理过并特意避开的形态。
#
# ── 豁免不许变成万能挡箭牌 ────────────────────────────────────────────────────────
# 如果「`bun install` 失败」一律归成网络,那 bootstrap 真坏掉的那天也会被归成网络 ⇒
# 这道门从此**永不失守** = 假门。所以判别依据必须是一件**独立于失败本身的环境事实**:
#
#   · 判据 = **单独探一次 registry 可达性**(curl),不是去解析 bun 的报错措辞。
#     解析别人的错误文法 = 本仓点名过的「手写一个别人文法的替身」,措辞一改就悄悄失效。
#   · 探测**不许用 bun** —— `[5/6]` 的故障注入正是「PATH 里没有 bun」,用 bun 探测会连带失败、
#     把一个**非网络**失败误判成网络,恰好打穿本节要立的那条判据。
#   · **拿不准一律倒向「拦住」**(fail-closed):registry 解析不出来(仓内/用户级
#     `.npmrc` / `bunfig.toml` 声明了我们没算进来的 registry)、没装 curl —— 都判 `real`。
#   · registry 可达却仍然失败 ⇒ `real` ⇒ 拦住。
#
# ── 六条,各杀一个不同的错误实现 ──────────────────────────────────────────────────
#  [1/6] 反向(**本判据是否成立的唯一证明**):**没**经过 bootstrap 的全新 worktree
#      必须**仍然**产生 `Cannot find module 'bun:test'` 这一类错误。少了这条,[2/6] 会**空对空地绿**
#      ——「这台机器碰巧哪里都能解析」和「bootstrap 起作用了」在只看 [2/6] 时长得一模一样。
#  [2/6] 正向:经 bootstrap 建出来的 worktree,ui-mac typecheck **exit 0 且零条模块解析错误**。
#      摘掉 bootstrap 里的 `bun install` ⇒ 这条转红。
#  [3/6] 不污染共享树:跑完**共享** `.git/config` 的 `core.hooksPath` 必须没变(husky 的
#      `prepare` 每次 install 都改它,而在 worktree 里改的是所有 worktree 共用的那份)。
#      本条先把值**设成 `.githooks`** 再跑 —— 不设的话,机器上本来就漂成 `.husky/_` 时
#      「前后相等」会**恒真**,断言粒度比缺陷粗一格。
#  [4/6] 幂等:对**已存在且已装好**的 worktree 重跑必须 exit 0,**且重跑之后 typecheck 仍绿**
#      —— 只断重跑的退出码会被「重跑时把树删了再报 0」满足。
#  [5/6] **非网络原因的失败必须仍然拦住**(owner 点名要补的那条)。让 `bun install` 真的失败
#      (PATH 里没有 bun —— 真实可达:精简过的 cron/CI shell 就是这个形状),断言三件事:
#      bootstrap **非零退出**、**把本次创建的 worktree 整棵删掉**(只断非零退出会被「报错但把
#      半装的树留在那」满足)、**且判别依据把它判成 `real` 而不是 `network`**。
#      少了最后半句,「一律算网络」这个错误实现能满足前两句。
#  [6/6] 判别依据**真的判别**,且网络档**不报绿**:
#      (a) registry 可达时必须判 `real`(直接杀掉「一律算网络」)。「可达」不许由**单发**探测
#          断言(`#941`:代理半通不通时,两发相隔几秒的 curl 会落在矛盾的两侧,健康仓库被硬红
#          成「判据失守」)——先对可达性取共识(可达要 3 发全成;非可达两发定局早退,R1 Minor:
#          挂起代理下第三发只花 8s 不改结论,门被拉长会抬高外层超时 SIGKILL 的概率 `#928`),
#          共识可达而判别依据说 'network' 时再复核
#          一轮(判别依据复测 + 再一轮共识)才许硬红;任何一处前后矛盾 ⇒ **本次测量作废**
#          (未验证档,exit 2),真离线 ⇒ 未验证。恒 'network' 的退化实现复测不会改口,
#          在健康网络下**确定性**仍然硬红 —— 两个方向都留着判据,[6/6] 不是摆设。
#      (b) registry 指向不可达地址时必须判 `network`(杀掉「一律算真失守」——那等于没有豁免);
#      (c) 报告契约:把整个探针**套跑一遍**并注入不可达 registry,断言它 **exit 2**、
#          输出里**有「未验证」**、且**没有**那句「新建 worktree 自己就能跑出可信 typecheck」。
#          嵌套跑靠 ALPHA_WT_PROBE_NESTED=1 断掉递归(只关掉 (c) 自己,不关任何真判据)。
#
# 一条载重的实现事实:`.worktrees/` 就在主 checkout **内部**,而 `bun run` 找可执行文件是
# 逐级往上走父目录的 `node_modules/.bin` —— 所以未 bootstrap 的 worktree 仍能跑起 `tsgo`
# (借的是**共享主 checkout** 那一份),报出来的才是 TS2307 而不是 `command not found`。
# [1/6] 的指纹依赖这一点;真变成 `command not found` 时它会因「零条 TS2307」而红,不会假绿。
#
# 用法:bash scripts/assert-worktree-bootstrap.sh
set -uo pipefail

MAIN="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || {
  echo "✗ 不在一个 git 仓库里" >&2; exit 1
}
MAIN="${MAIN%/.git}"
# ── 开跑前先清上一轮的残骸(`#928`)────────────────────────────────────────────────
# 本脚本的 `trap cleanup EXIT` 对**可捕获**的信号都有效(实测:TERM/INT/HUP 三者 EXIT trap
# 都跑、零残留),但 `SIGKILL` 结构上跑不了任何 trap —— 工具超时杀进程组就是这个形状。
# 实测复现:在 `bun install` 写盘的时刻对整组 `kill -KILL` ⇒ 留下一棵 **496M 半装**的
# worktree,**既注册在案又在盘上**,`git worktree prune` 清不掉。一晚四条 lane 跑五次门
# = 6.3 GB。所以清理不能只有「退出时清自己」这一条路径,还必须有「开跑时清上一轮」。
# 判「无主」的证据与「拿不准就留着」的方向在 scripts/worktree-probe-sweep.sh 里说明 ——
# 并发 lane 的探针树正活着,误删它等于让别人的门在与他改动无关的地方变红。
#
# 放在 `[ -f "$BOOTSTRAP" ]` 之前:清的是**这个仓遗留的共享状态**,与本次能力判据跑不跑得成
# 无关;把它挂在判据的前置条件后面,等于「前置不满足就不修上一轮的破坏」。
# 找不到就**拦住**,不是静默跳过:静默跳过等于「清扫被删掉之后一切照绿」,
# 而泄漏是不可见的(下一个人只会看见 `git worktree list` 越来越长)。
SWEEP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/worktree-probe-sweep.sh"
[ -f "$SWEEP" ] || { echo "✗ 找不到 $SWEEP —— 上一轮被杀留下的探针树没人清" >&2; exit 1; }
bash "$SWEEP"

# 被测的是**跑本脚本的这棵树**上的那份 bootstrap,不是主 checkout 那份 —— 否则在 worktree 里
# 跑 alpha-check 时,量到的是共享树上的旧版本(而本票的全部意义就是「别去量别人的树」)。
SELF_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
BOOTSTRAP="$SELF_ROOT/scripts/worktree-bootstrap.sh"
SELF="$SELF_ROOT/scripts/assert-worktree-bootstrap.sh"
[ -f "$BOOTSTRAP" ] || { echo "✗ 找不到 $BOOTSTRAP" >&2; exit 1; }

# 探针树一律从 HEAD 建:判的是**当前这棵树上的**脚本与配置,不是某个远端 ref 的历史版本。
BASE_SHA="$(git rev-parse HEAD 2>/dev/null)" || { echo "✗ 读不到 HEAD" >&2; exit 1; }

NESTED="${ALPHA_WT_PROBE_NESTED:-0}"
DEFAULT_REGISTRY="https://registry.npmjs.org"
UNREACHABLE_REGISTRY="http://127.0.0.1:9"

ID="probe-$$-${RANDOM}"
NEG="wtboot-${ID}-neg"
POS="wtboot-${ID}-pos"
FAIL="wtboot-${ID}-fail"
HOOKS_ORIGINAL="$(git -C "$MAIN" config --local --get core.hooksPath 2>/dev/null || true)"

# ── 会写共享配置的子进程:登记、收割(`#945`,实测 bash 3.2.57,时序数据在票/PR)─────────
# · 本进程收到**未 trap 的 TERM/HUP** 时,EXIT trap **立即**执行(实测 ~9ms),正在跑的前台
#   子进程被**孤儿化**继续活。cleanup 先还原共享 core.hooksPath 再退出 ⇒ 孤儿化的 bootstrap
#   子进程(它的 HOOKS_BEFORE 是 [3/6] 前置之后的 `.githooks`)在还原**之后**才跑自己的
#   restore ⇒ 把还原好的值覆写回 `.githooks`。最后写的人赢,谁最后写取决于调度 ⇒ 负载越高
#   越容易命中(2026-08-12 两条 lane 的间歇红;时序实测:父还原先落盘且值正确,孤儿晚 2s 覆写)。
# · **pid 级 INT 被 bash 3.2 整个丢弃**(前台子进程正常退出后继续跑;`wait` 内建同样,连 trap
#   都不进)。子进程挪进独立进程组后,终端 Ctrl-C 只打到本进程 ⇒ 必须显式 trap INT,并用轮询
#   代替裸 `wait`,否则 Ctrl-C 变哑。
# 修法:每个**会写共享配置**的子进程(三次 bootstrap + 一次嵌套自跑)都跑在自己的进程组里并
# 登记 pid;cleanup 的第一步是收割它(TERM 整组 → 限时等死 → 兜底 KILL),**然后**才还原共享
# 配置、删探针树。顺序从此确定:子进程的 restore(若跑)永远落在父还原之前。
OWNED_PID=""
owned_group_alive() { [ -n "${OWNED_PID:-}" ] && pgrep -g "$OWNED_PID" >/dev/null 2>&1; }
reap_owned() {
  local i
  if owned_group_alive; then
    kill -s TERM -- "-$OWNED_PID" 2>/dev/null || kill -s TERM "$OWNED_PID" 2>/dev/null || true
    # 上限 10s:bootstrap 自己的 EXIT trap 还要先收割它的 install 进程组(≤7s)再还原。
    i=0; while [ "$i" -lt 200 ] && owned_group_alive; do sleep 0.05; i=$((i+1)); done
    if owned_group_alive; then
      kill -s KILL -- "-$OWNED_PID" 2>/dev/null || true
      i=0; while [ "$i" -lt 40 ] && owned_group_alive; do sleep 0.05; i=$((i+1)); done
    fi
  fi
  OWNED_PID=""
}
run_owned() {
  local rc
  set -m
  "$@" &
  OWNED_PID=$!
  set +m
  # 不用裸 `wait` 等:pid 级 INT 在 bash 3.2 的 `wait` 内建里连 trap 都进不去(实测)。
  # 轮询 + 事后取 rc(job 表在进程死后仍保留退出码);INT 最多迟 0.1s 就进 trap。
  while kill -0 "$OWNED_PID" 2>/dev/null; do sleep 0.1; done
  wait "$OWNED_PID"; rc=$?
  OWNED_PID=""
  return "$rc"
}

cleanup() {
  local n now
  # ★ 顺序有意义(`#928` + `#945`):**先收割飞行中的子写手**,**再**还原共享配置,**最后**删探针树。
  # 删一棵装好的探针树要动 2.8 GB,是 cleanup 里唯一的慢动作;共享 `.git/config` 只要一次
  # git 调用。反过来排(删树在前)的话,清理跑到一半再被杀,丢的就是**共享配置**那一半 ——
  # 而两件事里只有它会影响别人:下一个人 `git push` 撞上的会是 husky 那份恒红钩子。
  # 收割排最前:不收割的话,还原会被孤儿子进程的 restore 覆写掉(`#945` 的间歇红)。
  reap_owned
  now="$(git -C "$MAIN" config --local --get core.hooksPath 2>/dev/null || true)"
  if [ "$now" != "$HOOKS_ORIGINAL" ]; then
    if [ -n "$HOOKS_ORIGINAL" ]; then
      git -C "$MAIN" config --local core.hooksPath "$HOOKS_ORIGINAL" 2>/dev/null || true
    else
      git -C "$MAIN" config --local --unset core.hooksPath 2>/dev/null || true
    fi
  fi
  for n in "$NEG" "$POS" "$FAIL"; do
    [ -e "$MAIN/.worktrees/$n" ] || continue
    git -C "$MAIN" worktree remove --force "$MAIN/.worktrees/$n" 2>/dev/null || rm -rf "$MAIN/.worktrees/$n"
  done
  git -C "$MAIN" worktree prune 2>/dev/null || true
}
trap cleanup EXIT
trap 'echo "  ✗ 被 Ctrl-C 打断 —— 收割子进程并还原共享 core.hooksPath 后退出" >&2; exit 130' INT

fail=0
unverified=0
red() { echo "    ✗ $*" >&2; fail=1; }

# ── 判别依据 ──────────────────────────────────────────────────────────────────────
# bun 会用哪个 registry。**任何一处声明了我们没算进来的 registry ⇒ 返回 1**(⇒ 不给豁免)。
# 这不是假设而是**被检查的前提**:仓内/用户级 `.npmrc`、`bunfig.toml` 将来长出 registry 声明时,
# 这里会退回 fail-closed 并逼人来更新,而不是继续拿一个已经不成立的全称命题发豁免。
resolve_registry() {
  local f
  for f in "$SELF_ROOT/.npmrc" "$SELF_ROOT/bunfig.toml" "$HOME/.npmrc" "$HOME/.bunfig.toml"; do
    [ -f "$f" ] || continue
    grep -aqE '^[[:space:]]*"?registry"?[[:space:]]*=' "$f" && return 1
  done
  printf '%s' "${BUN_CONFIG_REGISTRY:-$DEFAULT_REGISTRY}"
}

# 打印 `network` 或 `real`。拿不准一律 `real`(fail-closed:宁可拦住,不可放行)。
classify_bootstrap_failure() {
  local url
  url="$(resolve_registry)" || { printf 'real'; return 0; }
  # 刻意不用 bun 探测:[5/6] 的注入就是「没有 bun」,用 bun 探会把非网络失败误判成网络。
  command -v curl >/dev/null 2>&1 || { printf 'real'; return 0; }
  if curl -sS -o /dev/null --max-time 8 --head "$url" >/dev/null 2>&1; then
    printf 'real'
  else
    printf 'network'
  fi
}

# 独立于 `classify_bootstrap_failure` 的可达性探针。存在的理由:[5/6]/[6/6] 要分开
# 「判别依据坏了」和「这台机器真的离线」两件事 —— 拿判别依据自己的答案去判它自己,
# 是本仓点名过的**自指等价链**(一起改错就一起自洽)。返回 0 = registry 这一刻确实可达。
live_registry_reachable() {
  local url
  url="$(resolve_registry)" || return 1
  command -v curl >/dev/null 2>&1 || return 1
  curl -sS -o /dev/null --max-time 8 --head "$url" >/dev/null 2>&1
}

# ── `#941`:单发探测不构成「网络没问题」的地面真相 ─────────────────────────────────
# 2026-08-11 夜实测:同一台机器几分钟内,`curl registry.npmjs.org` 一次 0.9s 成、一次 7.2s 成,
# 同窗 `git fetch` 撞 SSL_ERROR_SYSCALL、`gh` 两次 EOF —— 代理**半通不通**时,两发相隔几秒的
# curl 会落在矛盾的两侧。而 [5/6]/[6/6](a) 原本拿**一发** `live_registry_reachable` 当真相,
# 再拿它硬红判别依据 ⇒ 一个健康的仓库被判成「判据失守」(exit 1),训练人 `--no-verify`
# (`#754` 的形态)。「判别依据退化成恒 'network'」与「网络在抖」在单次采样下**不可分**,
# 所以判决前先把「可达性」这一个事实测多次取一致;测不出一致 ⇒ **本次测量作废**(未验证档),
# 不给判决 —— 与本仓「观测手段自己有盲区」那张表同一条判据。
#
# 对「registry 此刻可达吗」串行采样(间隔 1s,把采样窗摊开)。打印一个词:
#   reachable   — 3 发全成。唯一会给硬红开门的共识(degraded 硬红与 note 的 real 硬红都以它
#                 为前提),样本量**不降** —— `#941` 的地基就是「单发不构成地面真相」,两发同理。
#   unreachable — 前两发全败,**两发定局早退**(`#941` R1 Minor)。挂起代理(accept 后不回
#                 数据,非 connection-refused)下每发吃满 --max-time 8s,恒 3 发 = 26s/轮,
#                 整道门 +50s(实测 2026-08-13,本机挂起端口:69.9s → ~52s)。省掉的第三发
#                 不砍任何判据:unreachable 与 unstable 在**全部**消费点同义(都落未验证、
#                 都不发硬红许可),它只花 8s 不改任何结论。门被拉长的真实代价不是等待,是
#                 抬高被外层工具超时 SIGKILL 打进 bun install 窗口的概率(`#928`/`#945` 那条
#                 竞态的触发条件)。
#   unstable    — 两发矛盾即定局(半通不通;unanimity 下第三发翻不了案,早退零语义变化)⇒
#                 这一刻不存在可信的地面真相;或前两发全成而第三发矛盾。
registry_reachability_consensus() {
  local a b
  live_registry_reachable; a=$?
  sleep 1
  live_registry_reachable; b=$?
  if [ "$a" -ne "$b" ]; then printf 'unstable'; return 0; fi
  if [ "$a" -ne 0 ]; then printf 'unreachable'; return 0; fi
  sleep 1
  if live_registry_reachable; then printf 'reachable'; else printf 'unstable'; fi
}

# 判别依据说了 'network' 之后的复核:是判别依据退化,还是网络在抖?打印一个词:
#   degraded — 前后两轮独立探测(各 3 次)registry **全部**可达,且判别依据**复测仍**说
#              'network' ⇒ 只能是判别依据退化成恒 'network'(硬红 —— 这道门永不失守的那个形态)。
#   offline  — 独立探测一致不可达 ⇒ 真离线,real/network 本来就分不开 ⇒ 未验证。
#   unstable — 任何一处前后矛盾(探测结果不一,或判别依据复测改口)⇒ 半通不通,
#              本次测量作废 ⇒ 未验证。
# 「恒 'network'」的退化实现在健康网络下**确定性**落到 degraded(它复测还是 'network',
# 而 6 发独立探测全成);健康判别依据在抖动网络下落到 offline/unstable(不冤枉判红)。
adjudicate_network_verdict() {
  local c1 v2 c2
  c1="$(registry_reachability_consensus)"
  case "$c1" in
    unreachable) printf 'offline'; return 0 ;;
    unstable)    printf 'unstable'; return 0 ;;
  esac
  # 独立探测一致可达 —— 结论不稳时再探一次再下判断:让判别依据自己复测,并再取一轮共识。
  v2="$(classify_bootstrap_failure)"
  c2="$(registry_reachability_consensus)"
  if [ "$v2" != real ] && [ "$c2" = reachable ]; then
    printf 'degraded'
  else
    printf 'unstable'
  fi
}

note_bootstrap_failure() {
  local verdict url
  verdict="$(classify_bootstrap_failure)"
  if [ "$verdict" = network ]; then
    url="$(resolve_registry 2>/dev/null || printf '%s' '<解析不出>')"
    unverified=1
    echo "    ⚠️  未验证:registry 不可达($url)—— bun install 这次装不上,本步什么都没证明。"
    echo "        这**不是绿**:worktree bootstrap 能力本次未被验证;网络恢复后重跑。"
  elif ! resolve_registry >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
    # fail-closed 的 `real`(registry 解析不出 / 没装 curl):这不是网络状态,是「判别依据的
    # 前提不成立」—— 没有豁免可谈,照旧拦住。**不许**把它送进下面的可达性共识:那两种前提下
    # `registry_reachability_consensus` 结构上恒返回 `unreachable`(它与判别依据同样解析不出 /
    # 同样没 curl),一律降未验证 = 这种机器上这道门永远 exit 2 永不失守,文件头点名的
    # 「豁免变万能挡箭牌」原样复活。
    red "$1"
  else
    # `#941` 正方向(与 [6/6](a) 的反方向对称):verdict='real' 也可能是「install 被抖死 +
    # 单发探测恰好落在成功那一侧」—— bun install 要拉几千个包,网络暴露面比一发 8s HEAD 大
    # 得多,半通不通时两者常落矛盾的两侧(2026-08-13 实测:call#1 成、其后 17 发全败)。
    # 硬红之前对可达性取一次共识:一致可达 ⇒ 网络是好的,失败是真的,照旧红(不放松真失守);
    # 否则(共识不稳,或共识不可达 = 与刚成功的那一发正面矛盾)⇒ 这一刻不存在可信的地面
    # 真相 —— 本次测量作废,落未验证档,不硬红。
    case "$(registry_reachability_consensus)" in
      reachable)
        red "$1"
        ;;
      *)
        unverified=1
        echo "    ⚠️  未验证:bootstrap 非零退出,判别依据说 real,但可达性共识与那一发探测矛盾"
        echo "        (网络半通不通)—— 本次测量作废,本步什么都没证明;网络恢复后重跑。"
        ;;
    esac
  fi
}

typecheck_in() {
  (cd "$MAIN/.worktrees/$1" && bun run --cwd packages/ui-mac typecheck 2>&1)
}
# 「模块解析假红」这一类的指纹。按**错误码**枚举(TS2307 = Cannot find module)而不是按字面串 ——
# 按字面串枚举对新成员默认放行。
missing_module_lines() { grep -ac "error TS2307" <<<"$1" 2>/dev/null || true; }

echo "  · 探针 id=$ID,base=$BASE_SHA${NESTED:+ ,nested=$NESTED}"

# ── [1/6] 反向:没 bootstrap 的全新 worktree 必须仍然假红 ──────────────────────────
echo "  · [1/6] 反向:未 bootstrap 的全新 worktree 必须产生模块解析错误"
if ! git -C "$MAIN" worktree add --detach -q "$MAIN/.worktrees/$NEG" "$BASE_SHA" 2>/dev/null; then
  echo "    ✗ 建不出反向探针 worktree —— **本次测量作废**,不要把它读成绿" >&2
  exit 1
fi
neg_out="$(typecheck_in "$NEG")"; neg_rc=$?
neg_missing="$(missing_module_lines "$neg_out")"
if [ "$neg_rc" -eq 0 ]; then
  red "未 bootstrap 的 worktree 竟然 typecheck 通过(rc=0)—— 这台机器哪里都能解析,[2/6] 于是空对空;本判据不成立"
fi
if [ "${neg_missing:-0}" -lt 1 ]; then
  red "未 bootstrap 的 worktree 没产生任何 TS2307 —— 探针测不出已知的坏,[2/6] 的绿没有含义"
else
  echo "    ✓ 未 bootstrap:rc=$neg_rc,TS2307 ${neg_missing} 条(探针测得出已知的坏)"
fi
if ! grep -aq "Cannot find module 'bun:test'" <<<"$neg_out"; then
  red "未 bootstrap 的 worktree 没有出现票面点名的 \`Cannot find module 'bun:test'\`"
fi
git -C "$MAIN" worktree remove --force "$MAIN/.worktrees/$NEG" 2>/dev/null || true

# ── [3/6] 的前置:把共享 core.hooksPath 设成一个**确定**的值,再跑 [2/6] ──────────────
git -C "$MAIN" config --local core.hooksPath .githooks 2>/dev/null || true

# ── [2/6] 正向:bootstrap 一步建出来的 worktree 必须能给出可信 typecheck ──────────────
echo "  · [2/6] 正向:bootstrap 建出的 worktree 必须 typecheck 干净"
pos_ready=0
if ! run_owned bash "$BOOTSTRAP" "$POS" --detach --base "$BASE_SHA" >/dev/null 2>&1; then
  note_bootstrap_failure "bootstrap 自己非零退出 —— 建不出可用的 worktree"
else
  pos_ready=1
  pos_out="$(typecheck_in "$POS")"; pos_rc=$?
  pos_missing="$(missing_module_lines "$pos_out")"
  if [ "$pos_rc" -ne 0 ] || [ "${pos_missing:-0}" -ne 0 ]; then
    red "bootstrap 过的 worktree 仍然假红:rc=$pos_rc,TS2307 ${pos_missing} 条"
    grep -a "error TS2307" <<<"$pos_out" | head -3 >&2
  else
    echo "    ✓ bootstrap 后:rc=0,TS2307 0 条"
  fi
fi

# ── [3/6] 共享 .git/config 没被 husky 改掉 ──────────────────────────────────────────
# 这条**永不豁免**:它不需要 registry 可达,install 失败与否都该成立。
echo "  · [3/6] 不污染共享树:core.hooksPath 必须还是 .githooks"
hooks_now="$(git -C "$MAIN" config --local --get core.hooksPath 2>/dev/null || true)"
if [ "$hooks_now" != ".githooks" ]; then
  red "bootstrap 改掉了**共享** .git/config 的 core.hooksPath:.githooks → ${hooks_now:-(unset)}(husky 的 prepare);下一个人的 git push 会撞上上游那份恒红钩子,然后 --no-verify"
else
  echo "    ✓ core.hooksPath 仍是 .githooks"
fi

# ── [4/6] 幂等:对已装好的 worktree 重跑,不破坏它 ──────────────────────────────────
echo "  · [4/6] 幂等:对已装好的 worktree 重跑 bootstrap"
if [ "$pos_ready" -eq 0 ]; then
  echo "    ⚠️  跳过:[2/6] 没能装出可用的 worktree(见上),幂等这一条本次无从判起"
elif ! run_owned bash "$BOOTSTRAP" "$POS" --detach --base "$BASE_SHA" >/dev/null 2>&1; then
  note_bootstrap_failure "对已存在且已装好的 worktree 重跑 bootstrap 非零退出 —— 不幂等"
else
  again_out="$(typecheck_in "$POS")"; again_rc=$?
  again_missing="$(missing_module_lines "$again_out")"
  if [ "$again_rc" -ne 0 ] || [ "${again_missing:-0}" -ne 0 ]; then
    red "重跑之后 typecheck 反而坏了:rc=$again_rc,TS2307 ${again_missing} 条 —— 重跑破坏了这棵树"
  else
    echo "    ✓ 重跑 exit 0,且重跑后 typecheck 仍然 rc=0 / TS2307 0 条"
  fi
fi

# ── [5/6] 非网络原因的失败:非零退出 + 不留半装的树 + **判成 real 而不是 network** ────
echo "  · [5/6] 非网络失败必须仍然拦住(bun 缺失:非零退出 + 不留半装树 + 判成 real)"
BUN_BIN="$(command -v bun 2>/dev/null || true)"
if [ -z "$BUN_BIN" ]; then
  echo "    ✗ 这台机器上找不到 bun —— **本次测量作废**" >&2
  exit 1
fi
BUN_DIR="${BUN_BIN%/*}"
# 从 PATH 里摘掉 bun 所在目录(只摘它,别的工具照旧可用 —— git/curl 还得能跑)。
# 按 `IFS=':'` 分词而不是 `read -d ':'`:后者在 herestring 末尾会多读出一个换行字段,
# 于是 RESTRICTED 末尾挂上一个空/换行目录项(不报错,只是悄悄多一段)。
RESTRICTED=""
_saved_ifs="$IFS"
set -f            # 关掉 glob:路径项里的 * ? [ 不许被展开
IFS=':'
for p in $PATH; do
  [ -n "$p" ] || continue
  [ "$p" = "$BUN_DIR" ] && continue
  RESTRICTED="${RESTRICTED:+$RESTRICTED:}$p"
done
IFS="$_saved_ifs"
set +f
unset _saved_ifs
# 先证明这个故障注入真的注进去了。bun 若在别处还能解析到,下面那条就变成「测了个寂寞」——
# 那时必须**打印本次测量作废**,而不是给一个绿。
if PATH="$RESTRICTED" command -v bun >/dev/null 2>&1; then
  echo "    ✗ 摘掉 $BUN_DIR 之后 bun 仍可解析 —— 故障注入无效,**本条测量作废**" >&2
  fail=1
elif ! PATH="$RESTRICTED" command -v git >/dev/null 2>&1; then
  echo "    ✗ 受限 PATH 里连 git 都没有 —— 夹具构造错了,**本条测量作废**" >&2
  fail=1
else
  run_owned env "PATH=$RESTRICTED" bash "$BOOTSTRAP" "$FAIL" --detach --base "$BASE_SHA" >/dev/null 2>&1
  boot_rc=$?
  if [ "$boot_rc" -eq 0 ]; then
    red "bun 缺失时 bootstrap 仍然 exit 0 —— 它会静默留下一棵装不上依赖的树"
  elif [ -e "$MAIN/.worktrees/$FAIL" ]; then
    red "bun install 失败后,本次创建的 worktree 还留在 .worktrees/$FAIL —— 半装的树比没有更坏"
  else
    # ★ owner 点名要补的那半:这是一个**非网络**失败,判别依据必须说 `real`。
    #   少了它,「一律算网络」这个错误实现能满足上面两条 ⇒ 豁免变成万能挡箭牌 ⇒ 这道门永不失守。
    verdict_real="$(classify_bootstrap_failure)"
    if [ "$verdict_real" = real ]; then
      # `${FAIL}` 必须带花括号:紧跟其后的是 CJK 顿号,UTF-8 locale 下 bash 会把那几个字节
      # 一起当成变量名 ⇒ `FAIL<0xe3><0x80><0x81>: unbound variable`(set -u 下当场炸)。
      echo "    ✓ 非零退出(rc=$boot_rc)、没留下 .worktrees/${FAIL}、且判成 real(会拦住)"
    else
      # 判别依据把一个**非网络**失败说成 network。硬红之前先复核(`#941`):单发探测在代理
      # 半通不通时会与判别依据落在矛盾的两侧,拿它当真相会把健康的仓库判成「判据失守」。
      case "$(adjudicate_network_verdict)" in
        degraded)
          # 前后两轮独立探测全可达、判别依据复测仍说 network ⇒ 豁免成了万能挡箭牌:
          # bootstrap 真坏掉的那天也会被当成网络放行,这道门从此永不失守。
          red "非网络失败(bun 缺失)被判别依据归成 'network' 且复测不改口,而前后两轮独立探测 registry 全可达 —— 判别依据退化,豁免成了万能挡箭牌"
          ;;
        offline)
          # 这台机器这一刻真的连不上 registry:`real` 与 `network` 本来就分不开(判别依据只有
          # 可达性这一个输入)。如实降级,不许当绿,也不冤枉判红。
          unverified=1
          echo "    ⚠️  未验证:registry 这一刻不可达,本条分不出 real / network(判别依据只看可达性)"
          ;;
        *)
          unverified=1
          echo "    ⚠️  未验证:可达性探测前后矛盾(网络半通不通)—— 本次测量作废,本条分不出 real / network"
          ;;
      esac
    fi
  fi
fi

# ── [6/6] 判别依据真的判别 + 网络档不报绿 ───────────────────────────────────────────
echo "  · [6/6] 判别依据双向可分 + 网络档不报绿"
# (b) 不可达 registry 必须判 network —— 杀掉「一律算 real」(那等于没有豁免,网络一抖就拦 push)
verdict_net="$(export BUN_CONFIG_REGISTRY="$UNREACHABLE_REGISTRY"; classify_bootstrap_failure)"
if [ "$verdict_net" != network ]; then
  red "registry 指向 $UNREACHABLE_REGISTRY 时判别依据仍说 '$verdict_net' —— 豁免形同虚设,网络一抖就拦住 push"
else
  echo "    ✓ 不可达 registry ⇒ network"
fi
# (a) 可达 registry 必须判 real —— 直接杀掉「一律算网络」。
# `#941`:「可达」不许由单发探测断言(半通不通时它与判别依据各落矛盾一侧,健康仓库被硬红)。
# 先对可达性取共识;共识可达而判别依据仍说 network 时,再复核一轮才许硬红。
live_registry="$(resolve_registry 2>/dev/null || true)"
case "$(registry_reachability_consensus)" in
  reachable)
    verdict_live="$(classify_bootstrap_failure)"
    if [ "$verdict_live" = real ]; then
      echo "    ✓ 可达 registry($live_registry)⇒ real"
    else
      case "$(adjudicate_network_verdict)" in
        degraded)
          red "registry($live_registry)前后两轮独立探测全可达,判别依据复测仍说 'network' —— 判别依据退化,一律算网络 = 这道门永不失守"
          ;;
        *)
          # 复核期间结论翻了(判别依据改口 real,或独立探测不再一致可达)⇒ 网络在抖,
          # 不存在可信的地面真相 —— 本次测量作废,不给判决。
          unverified=1
          echo "    ⚠️  未验证:可达性结论前后矛盾(网络半通不通)—— 本次测量作废,'可达 ⇒ real' 这一半证不了"
          ;;
      esac
    fi
    ;;
  unreachable)
    # 本机这一刻真的连不上 registry:判别力这一条**证不了**,如实降级,不许当绿。
    unverified=1
    echo "    ⚠️  未验证:registry 这一刻不可达,'可达 ⇒ real' 这一半本次证不了"
    ;;
  *)
    unverified=1
    echo "    ⚠️  未验证:可达性探测结果前后不一(半通不通)—— 本次测量作废,'可达 ⇒ real' 这一半证不了"
    ;;
esac
# (c) 报告契约:套跑一遍并注入不可达 registry —— 必须 exit 2 + 说「未验证」+ 不说那句全绿话
if [ "$NESTED" = "1" ]; then
  echo "    · 嵌套运行:跳过报告契约自检(断递归)"
else
  # 嵌套自跑也是一个会写共享配置的子进程(它自己的 cleanup 会还原到**它**看到的基线)——
  # 一样要登记收割,否则父被打断时它就是下一个晚到的覆写者。输出改走临时文件(run_owned
  # 走后台进程组,命令替换接不到)。
  nested_tmp="$(mktemp "${TMPDIR:-/tmp}/alpha-wt-nested.XXXXXX")"
  run_owned env ALPHA_WT_PROBE_NESTED=1 BUN_CONFIG_REGISTRY="$UNREACHABLE_REGISTRY" bash "$SELF" >"$nested_tmp" 2>&1
  nested_rc=$?
  nested_out="$(cat "$nested_tmp" 2>/dev/null)"
  rm -f "$nested_tmp"
  if [ "$nested_rc" -ne 2 ]; then
    red "注入不可达 registry 后整个探针的退出码是 $nested_rc,应为 2(0=谎报绿;1=网络一抖就拦 push)"
  elif ! grep -aq "未验证" <<<"$nested_out"; then
    red "网络档没有在输出里说「未验证」—— 把「没验成」读成「验过了」正是这一档要消掉的东西"
  elif grep -aq "新建 worktree 自己就能跑出可信 typecheck" <<<"$nested_out"; then
    red "网络档仍然打印了那句全绿结论 —— 不许报绿"
  else
    echo "    ✓ 网络档:exit 2、说「未验证」、不报绿"
  fi
fi

# ── 结局 ──────────────────────────────────────────────────────────────────────────
if [ "$fail" -ne 0 ]; then
  echo "    ✗ worktree bootstrap 能力判据失守" >&2
  exit 1
fi
if [ "$unverified" -ne 0 ]; then
  echo "    ⚠️  worktree bootstrap 能力**本次未验证**(见上面的未验证行)—— 不拦 push,但这一跑不构成证据"
  exit 2
fi
echo "    ✓ 新建 worktree 自己就能跑出可信 typecheck(不必碰共享主 checkout)"
exit 0
