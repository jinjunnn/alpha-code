#!/usr/bin/env bash
#
# `#976` —— packages/{app,ui} 的 round-trip 闸:**HEAD 的那两棵树,必须能由 pin + SOT 补丁
# 逐字重建出来**。
#
# 这道门守的是什么(大白话):ADR-034 起 `packages/{app,ui}` 不是 alpha 自己的代码,而是
# 「上游 pin(frontend/frontend-pin.lock)+ 一份补丁(frontend/alpha-patches/alpha-frontend.patch)」
# 的**投影**。两个地方会把这个投影**当真**并据此重写那两个目录:
#   ① .github/workflows/sync-upstream.yml 的 `apply_alpha_frontend_delta` ——
#      `rm -rf packages/app packages/ui` → `git checkout $PIN --` → `git apply` 补丁;
#   ② frontend/README.md 的月更 bump 块 1 —— `git checkout $NEWPIN -- packages/app packages/ui`。
# 也就是说:**改了 packages/{app,ui} 而没把改动重生进补丁,那份改动会被静默删除** ——
# 不是报错,是下一次 sync 之后它就不在了。
#
# 这不是理论风险,已合并历史上真的发生过:f420fe2bb / cea23d639 / 0061eec19 / 7281627ed
# (2026-07-24→07-26)四个提交上,补丁里没有 `packages/app/vendor/opencode-ai-client-1.17.13.tgz`
# 而树里有,存活约两天,当时没有任何门变红。没出事只因为 sync 那阵子一直红着没跑到还原步。
#
# 为什么判据必须比**内容**而不是比清单(`#976` 勘破实测):
#   仓里此前唯一读这份补丁的可执行处是 scripts/bun-test-app.sh 的两轴交叉,它比的是
#   `*.test.ts` 的**文件名集**。改一行 packages/app/src/context/terminal.tsx 不重生补丁 ⇒
#   两轴仍是 5 == 5,**绿**;把过滤放宽到全部文件(票面建议的口径)⇒ 46 == 46,**仍然绿**。
#   名字集比较对内容漂移结构性失明。所以这里消费 **git 自己的对象模型**:
#     临时 GIT_INDEX_FILE → git read-tree $PIN → git apply --cached --binary 补丁 → git write-tree
#   再把重建出来的 `rt:packages/app|ui` 与 `HEAD:packages/app|ui` 的 **tree sha** 直接比。
#   tree sha 一次覆盖内容、文件模式、增、删、改与两个包 —— 不用自己写一个补丁语法的替身。
#
# 锚点是 **HEAD**,不是「HEAD ∪ 工作树」:sync 与月更 bump 重建的正是 HEAD 那棵树,而本脚本
# 跑在 pre-push(该提交的都提交了)。代价是开发中途跑门时工作树里的 app/ui 改动不计入 ——
# 所以下面无论红绿都会把 dirty 清单打出来,不让「这一跑量的是什么」变成隐含知识。
#
# 三档结局(与 alpha-check 第 [9/10]/[10/10] 步同形):
#   0 = 已比对,一致;
#   1 = 红(真漂移 / 补丁贴不上 / 本次测量作废);
#   2 = **未比对**(pin 对象本地取不到:浅克隆或没 fetch)。刻意不判红 —— 主 checkout 本身
#       就是浅克隆(.git/shallow 在),硬红会制造与本次改动无关的红 ⇒ `--no-verify` ⇒ 把十道门
#       一起关掉(`#754` 形态)。CI 侧没有这一档:设 ROUNDTRIP_REQUIRE_PIN=1 后同一状态硬红,
#       因为 CI 自己控制 checkout 深度,取不到 pin 就是接线坏了。
#
# 行为判据在 packages/ui-mac/src/main/frontend-patch-roundtrip.test.ts(起真 git 仓、造真的
# 漂移、跑**本脚本本体**)。不要用「grep 到脚本里写着 write-tree」这类断言 —— 按本仓定义那是
# 假闸门(脚本被换成 `exit 0` 时它照样绿)。
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$ROOT" ]; then
  echo "::error::不在 git 仓库里,packages/{app,ui} 的 round-trip 判据无从谈起 —— 本次测量作废。"
  exit 1
fi
cd "$ROOT" || exit 1

LOCK="frontend/frontend-pin.lock"
PATCH="frontend/alpha-patches/alpha-frontend.patch"
PACKAGES="packages/app packages/ui"

echo "▸ round-trip 判据:HEAD 的 packages/{app,ui} == pin + ${PATCH}(锚在 **HEAD**,不含未提交改动)"

# ── 前置自检:先证明这次测量的材料齐备,再谈结论 ───────────────────────────────
# 「测不到」必须说「测量作废」,不能因为比较步没红就报绿(`#890`/`#946` 同款语义)。
if [ ! -f "$LOCK" ]; then
  echo "::error::${LOCK} 不存在 —— ADR-034 的 pin 搬家了而本门没跟,本次测量作废。"
  exit 1
fi
PIN="$(sed -n 's/^pin=\([0-9a-f]\{7,40\}\).*$/\1/p' "$LOCK" | head -1)"
if [ -z "$PIN" ]; then
  echo "::error::${LOCK} 里读不出 pin=<sha> —— 本次测量作废。"
  exit 1
fi
if [ ! -f "$PATCH" ]; then
  echo "::error::${PATCH} 不存在 —— ADR-034 的 SOT 搬家了而本门没跟,本次测量作废。"
  exit 1
fi
# 补丁被清空/截断成 0 个 hunk 时,下面的 apply 会「成功」而重建出来的就是**纯 pin 树** ——
# 那种情况下比较步给出的红是真的,但原因完全不同(不是漂移,是 SOT 没了)。先在这里分流。
patch_files="$(grep -ac '^diff --git a/' "$PATCH" || true)"
if [ "${patch_files:-0}" -lt 1 ]; then
  echo "::error::${PATCH} 里一条 diff --git 都没解析到(补丁为空/被截断,或解析器退化)—— 本次测量作废。"
  echo "::error::  这不是「没有漂移」:空补丁重建出来的是纯 pin 树,任何结论都不成立。"
  exit 1
fi

if ! git rev-parse --verify --quiet HEAD >/dev/null; then
  echo "::error::HEAD 解析不出(仓里还没有提交)—— 本判据锚在 HEAD,本次测量作废。"
  exit 1
fi

# pin 对象取不到 = 环境缺失(浅克隆),不是漂移。本地给第三档,CI 硬红。
if ! git cat-file -e "${PIN}^{commit}" 2>/dev/null; then
  if [ "${ROUNDTRIP_REQUIRE_PIN:-}" = "1" ]; then
    echo "::error::pin ${PIN} 的对象取不到,而 ROUNDTRIP_REQUIRE_PIN=1 —— CI 自己控制 checkout 深度(fetch-depth: 0),"
    echo "::error::  取不到 pin 说明接线坏了(job 换了、深度被改浅),不是环境缺失。判红。"
    exit 1
  fi
  echo "⚠️  未比对:pin ${PIN} 的对象本地取不到(浅克隆/未 fetch)—— packages/{app,ui} 的 round-trip **本次没有比对**。"
  echo "    要在本地补齐:git fetch --no-tags origin ${PIN}(或 git fetch --deepen=<n>)。"
  exit 2
fi
# pin 里必须真的有这两个目录 —— 否则 read-tree 出来的基底根本不是这道门要比的东西,
# 「重建树 != HEAD 树」会以一个看似有意义的形式红出来,而真正的原因是 lock 指错了提交。
for p in $PACKAGES; do
  if ! git cat-file -e "${PIN}:${p}" 2>/dev/null; then
    echo "::error::pin ${PIN} 里没有 ${p} —— lock 指向的提交不是一个能当基底的上游前端提交,本次测量作废。"
    exit 1
  fi
done

# ── 重建:全程只写一个临时 index,不碰仓库 index / 工作树 / 当前分支 ──────────────
TMP_INDEX="$(mktemp -u "${TMPDIR:-/tmp}/alpha-roundtrip-index-XXXXXX")"
cleanup() { rm -f "$TMP_INDEX"; }
trap cleanup EXIT
export GIT_INDEX_FILE="$TMP_INDEX"

if ! git read-tree "$PIN"; then
  echo "::error::git read-tree ${PIN} 失败 —— 本次测量作废。"
  exit 1
fi
if ! git apply --cached --binary --whitespace=nowarn "$PATCH"; then
  echo "::error::SOT 补丁在 pin ${PIN} 上**贴不上**(不是内容漂移,是补丁与 pin 已经对不齐)。两种原因:"
  echo "::error::  ① pin 与补丁漂移 —— 与 sync-upstream 的 3-way loud-fail 同因。处置:跑 frontend/README.md 的月更 bump"
  echo "::error::     (升 pin + 重生补丁),不是在这里重生补丁 —— 重生只会把「贴不上」变成「贴上了但基底是旧 pin」。"
  echo "::error::  ② 补丁**没带二进制**(重生时漏了 --binary)—— 普通 git diff 只写一行「Binary files … differ」,"
  echo "::error::     git apply 拒绝它。packages/app/vendor/*.tgz 被 packages/session-ui 以 file: 直接依赖,漏了装不上。"
  exit 1
fi
rt="$(git write-tree)"
# 临时 index 的活儿到此为止。**必须立刻取消导出** —— 否则下面那条 `git status` 会拿这个
# 只装着 pin+补丁的假 index 当基准,把整个 frontend/ 报成「已删除」(实测:第一版就这样,
# 一份**假的** dirty 清单,而它正是用来说明「这一跑量的是什么」的那句话)。
unset GIT_INDEX_FILE
if [ -z "$rt" ]; then
  echo "::error::git write-tree 没给出树对象 —— 本次测量作废。"
  exit 1
fi

# ── 比较:两个包各自的 tree sha,逐字 ────────────────────────────────────────────
drift=0
for p in $PACKAGES; do
  rebuilt="$(git rev-parse --verify --quiet "${rt}:${p}" || true)"
  head_tree="$(git rev-parse --verify --quiet "HEAD:${p}" || true)"
  if [ -z "$head_tree" ]; then
    echo "::error::HEAD 里没有 ${p} —— 整个目录被删掉了(ADR-034 的投影没了),本次测量作废。"
    drift=1
    continue
  fi
  if [ -z "$rebuilt" ]; then
    echo "::error::pin + 补丁重建不出 ${p} —— 补丁把整个目录删掉了,或 pin 基底不对。"
    drift=1
    continue
  fi
  if [ "$rebuilt" = "$head_tree" ]; then
    echo "    ✓ ${p}  pin+patch == HEAD  (${head_tree})"
    continue
  fi
  drift=1
  echo "::error::${p} 漂移:pin+patch 重建出 ${rebuilt},HEAD 是 ${head_tree}"
  named="$(git diff-tree -r --name-status "$rebuilt" "$head_tree" | awk -v pkg="$p" -F'\t' 'NF>=2 { print "::error::    " $1 "\t" pkg "/" $2 }')"
  if [ -z "$named" ]; then
    # tree sha 不等而逐路径 diff 一条都没有 = 观测手段自己坏了,别给一个看似有意义的清单。
    echo "::error::    (两棵树的 sha 不同,而 diff-tree 一条路径都没点名 —— 本次点名作废,请手工比对)"
  else
    printf '%s\n' "$named"
  fi
done

dirty="$(git --no-optional-locks status --porcelain -- packages/app packages/ui frontend/alpha-patches frontend/frontend-pin.lock 2>/dev/null || true)"
if [ -n "$dirty" ]; then
  echo "    注:下列文件有**未提交**改动,本判据锚在 HEAD ⇒ 它们不在本次比较里:"
  printf '%s\n' "$dirty" | sed 's/^/      /'
fi

if [ "$drift" -ne 0 ]; then
  echo "::error::packages/{app,ui} 与 SOT 不一致 —— 下一次 sync-upstream(rm -rf + checkout pin + apply patch)"
  echo "::error::  或月更 bump 会把上面点名的改动**静默删掉**。"
  echo "::error::  修法(frontend/README.md 块 4,与源码改动放在**同一个提交**里):"
  echo "::error::    git diff --binary ${PIN} -- packages/app packages/ui > ${PATCH}"
  echo "::error::  --binary 不可省:packages/app/vendor/*.tgz 被 packages/session-ui 以 file: 直接依赖,"
  echo "::error::  普通 git diff 不携带二进制内容 ⇒ 补丁看似完整实则重建不出可安装的树。"
  exit 1
fi

echo "    ✓ round-trip:packages/{app,ui} 恒等于 pin ${PIN} + ${PATCH}(补丁覆盖 ${patch_files} 个文件)"
exit 0
