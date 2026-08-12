#!/usr/bin/env bash
# worktree-probe-sweep.sh — 清掉**上一轮跑门被杀**时留在共享主 checkout 里的探针 worktree(`#928`)。
#
# ── 为什么 trap 不够(2026-08-11 实测,不是推断)────────────────────────────────────
# `scripts/assert-worktree-bootstrap.sh` 用 `trap cleanup EXIT` 清自己建的三棵探针树。
# 把那一跑用 `bash -x` 全程录下来:正常结束时 `+ cleanup` 确实出现、`git worktree remove` 确实
# 执行、跑完零残留。**trap 本身没坏。** 再逐个信号测这台机器上的 bash(3.2.57):
#
#     信号        EXIT trap 跑了吗     真探针(2.8G 已装好)跑完的残留
#     TERM        跑了                 无
#     INT         跑了                 无
#     HUP         跑了                 无
#     KILL        **跑不了**           **有**
#
# 对整个 process group 发 `kill -KILL`、且落在 `bun install` 正在写盘的时刻,复现出的正是票面
# 记录的那个状态:一棵 **496M 半装的** worktree,**既注册在案又留在盘上**,`git worktree prune`
# 清不掉(prune 只摘目录已消失的登记)。票面观察到的四棵大小是 533M/1.0G/2.1G/2.7G,而装完整
# 是 2.8G —— 它们全是**半装**的,即那几次都是在 install 中途被杀,`-neg` 早已删除、`-fail` 尚未
# 创建,所以只剩 `-pos`。**「trap 没在起作用」这句观察是对的,但原因不是 trap 写错了,
# 而是 SIGKILL 结构上跑不了任何 trap。**
#
# ⇒ 修法只能是**下一次跑门时把上一轮的无主残骸清掉**。这就是本脚本。
#
# ── 唯一的危险是清过头 ───────────────────────────────────────────────────────────
# 四条 lane 并行跑门时,别人的探针树正**活着**。把它删掉 = 让别人的门在与他改动无关的地方
# 变红 ⇒ `--no-verify` ⇒ 九道门一起关掉。所以判「无主」必须有证据,拿不准一律**留着**:
#
#   · 名字里读不出 pid            ⇒ 删(没有主人可言)
#   · `kill -0 <pid>` 失败        ⇒ 删(进程确实不在了)
#   · pid 活着、`ps` 说它就是探针  ⇒ **留**(并发 lane 正在用)
#   · pid 活着、`ps` 说是别的程序  ⇒ 删(pid 复用,不是探针的主人)
#   · pid 活着、`ps` 问不出来      ⇒ **留**(证不了它是残骸 —— 宁可多留一轮,不可误删)
#
# 前缀匹配严格钉在 `.worktrees/wtboot-probe-` 上:别的 lane 的 worktree、以及名字只是长得像
# (`wtboot-keepme`)的,一律不碰。
#
# 用法:bash scripts/worktree-probe-sweep.sh   (无参数;在主 checkout 或任意 worktree 里跑都一样)
# 退出码:恒 0 —— 这是**修复**动作,不是判据。清不掉的东西不该拦住调用方的门。
set -uo pipefail

COMMON_DIR="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || exit 0
MAIN="${COMMON_DIR%/.git}"
[ -d "$MAIN" ] || exit 0

PREFIX="$MAIN/.worktrees/wtboot-probe-"

# 名字形状:wtboot-probe-<pid>-<rand>-{neg,pos,fail}
owner_pid_of() {
  local rest="${1#wtboot-probe-}"
  printf '%s' "${rest%%-*}"
}

# 0 = 有主(留着);1 = 无主(可以删)
owner_alive() {
  local pid="$1" cmd
  case "$pid" in "" | *[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  # 进程活着 —— 还要问它是不是探针本人(pid 会复用)。
  cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  if [ -z "$cmd" ]; then
    # ps 问不出来:证不了它是残骸 ⇒ 留着。
    return 0
  fi
  case "$cmd" in *assert-worktree-bootstrap.sh*) return 0 ;; *) return 1 ;; esac
}

swept=0
kept=0

# ── 注册在案的残骸 ────────────────────────────────────────────────────────────────
while IFS= read -r line; do
  case "$line" in "worktree "*) ;; *) continue ;; esac
  path="${line#worktree }"
  case "$path" in "$PREFIX"*) ;; *) continue ;; esac
  name="${path##*/}"
  if owner_alive "$(owner_pid_of "$name")"; then
    kept=$((kept + 1))
    continue
  fi
  git -C "$MAIN" worktree remove --force "$path" >/dev/null 2>&1 || rm -rf "$path"
  swept=$((swept + 1))
  echo "  · 清掉上一轮跑门留下的无主探针 worktree:.worktrees/$name"
done < <(git -C "$MAIN" worktree list --porcelain 2>/dev/null)

# ── 只在盘上、没登记的残骸(被杀的时刻落在 `git worktree add` 之前/之后都可能)──────
for path in "$PREFIX"*; do
  [ -e "$path" ] || continue          # glob 没匹配上时 path 是字面量,这一行把它挡掉
  name="${path##*/}"
  # 有主的在上面那轮已经计过一次 kept,这里不再重复计数。
  owner_alive "$(owner_pid_of "$name")" && continue
  rm -rf "$path"
  swept=$((swept + 1))
  echo "  · 清掉上一轮跑门留下的无主探针目录(未登记):.worktrees/$name"
done

if [ "$swept" -gt 0 ]; then
  git -C "$MAIN" worktree prune >/dev/null 2>&1 || true
fi
if [ "$kept" -gt 0 ]; then
  echo "  · 保留 $kept 棵**有主**的探针 worktree(并发 lane 正在跑门 —— 删掉它等于让别人的门假红)"
fi
exit 0
