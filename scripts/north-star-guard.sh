#!/usr/bin/env bash
#
# north-star 守卫 —— 「alpha 不改上游包」那道门(ADR-004 / 硬约束 B10)。
# 本仓是 opencode 的 fork:上游包只读,能力靠**新增** alpha 文件与接缝实现。改了上游文件,
# 下一次 fork-sync 就冲突。这道门是那条铁律唯一的机械判据。
#
# ── 为什么它是一个文件,而不是 alpha-check.sh 里的一段内联 shell(`#889`)────────────
# 与 `#717` 把 detect 分类步抽成 scripts/detect-changed-scope.sh 是**同一个理由**:内联时
# 它没有任何判据。断言 shell 源码文本按本仓定义是假闸门 —— 守卫被整段注释掉时,那种断言
# 照样绿。抽成文件的唯一目的,是让 packages/ui-mac/src/main/north-star-guard.test.ts 能起
# 真 git 仓、造真的上游改动、跑**生产的这一份**,断言它**真的点名了那个文件**。
#
# ── 比较基准 = `origin/alpha`,不是 `origin/dev`(`#889`)──────────────────────────
# 这道门要回答的是「**这个 PR 自己**改了上游文件吗」,所以基准只能是它的目标分支 ——
# alpha-ci 的 `on: push/pull_request: branches: [alpha]`,分支保护也挂在 alpha 上。
# 原来两处写死 `origin/dev`(上游纯镜像分支),那是一个与目标分支无关的字面常量:
#
#   · 实测(2026-08-10):`origin/dev` 与 `origin/alpha` 的 merge-base 停在 `347510a73`
#     (2026-07-23),alpha 领先 289 个提交、dev 领先 261 个且仍在动 ⇒ `origin/dev...HEAD`
#     的窗口是 550 commits / 2467 文件,而不是这个 PR 改了什么。
#   · 它是 `origin/alpha...HEAD` 的**超集窗口** ⇒ 不漏报真违规,但会**过报**:那个窗口里
#     点名 47 个上游文件,全靠下面 44 条 UPSTREAM_EXCLUDES(本意是登记**有意的收编**)
#     恰好吸收掉,才在今天给出与 alpha 基准相同的结论(两种基准当天都是 0)。
#   · ⇒ 任何一次不在 exclude 表里的**合法**上游改动(fork-sync、收编前的上游变更),
#     都会让这道门在**每个 PR** 上恒红 —— 包括没碰它的 PR。本文件下面那句
#     「Drift here is worse than no gate: a permanently-red local guard trains you to ignore it」
#     说的正是这个,而 `#754`(pre-push 恒假红 ⇒ 第一道门实际关着)已经演过一遍。
#
# 判据不在这段散文里:north-star-guard.test.ts 造一个「只在 dev 窗口里、不在 alpha 窗口里」
# 的上游改动,断言守卫**不**点名它 —— 把基准还原成 origin/dev,那一条当场红。
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

# Keep in lockstep with .github/workflows/alpha-ci.yml (env.UPSTREAM_PATHS + the guard's excludes)
# and ADR-004. Drift here is worse than no gate: a permanently-red local guard trains you to ignore it.
# ADR-020(REQ-017 修):packages/{app,ui} 已冻结(frontend-freeze-base-2,ADR-027),相对上游镜像的
# diff 是冻结本意 → 移出守卫,与 alpha-ci.yml env.UPSTREAM_PATHS 恢复 1:1(此前本地恒假红)。
# ADR-033(#456):守卫盲区补全 —— permission wire 契约的 SOT 有一半在 protocol/schema/client。
UPSTREAM_PATHS="packages/opencode packages/core packages/server packages/tui packages/sdk packages/protocol packages/schema packages/client"
# 被接管/生成文件的例外,与 alpha-ci.yml 的 `excludes=()` 逐条对齐。新增收编须自己的 ADR,
# 不得静默加 exclude(ADR-029 §3)。两处逐条相同由 local-gate-parity.test.ts 判(`#637`)。
UPSTREAM_EXCLUDES=(
  # ADR-033 §1 被接管 permission 表面(L3)
  ':(exclude)packages/core/src/permission.ts'
  ':(exclude)packages/core/src/permission'
  ':(exclude)packages/server/src/handlers/permission.ts'
  ':(exclude)packages/opencode/src/server/routes/instance/httpapi/public.ts'
  ':(exclude)packages/core/test/permission.test.ts'
  ':(exclude)packages/core/test/database-migration.test.ts'
  ':(exclude)packages/opencode/test/server/httpapi-exercise'
  ':(exclude)packages/opencode/test/server/httpapi-public-openapi.test.ts'
  # ADR-033 §4 生成/快照(SOT = alpha 拥有的迁移/协议/schema;静态 diff 会误报)
  ':(exclude)packages/core/schema.json'
  ':(exclude)packages/core/src/database/migration.gen.ts'
  ':(exclude)packages/core/src/database/schema.gen.ts'
  ':(exclude)packages/sdk/js/src/v2/gen/sdk.gen.ts'
  ':(exclude)packages/sdk/js/src/v2/gen/types.gen.ts'
  # ADR-033 §守卫盲区(#456 裁决)
  ':(exclude)packages/protocol/src/groups/permission.ts'
  ':(exclude)packages/schema/src/permission.ts'
  ':(exclude)packages/schema/src/agent.ts'
  ':(exclude)packages/schema/test/contract-hygiene.test.ts'
  ':(exclude)packages/client/src/generated/client.ts'
  ':(exclude)packages/client/src/generated-effect/client.ts'
  ':(exclude)packages/client/src/generated/types.ts'
  # ADR-035(#489):E7 web search 失败诚实所需的两文件接管(L3)。上游
  # test/tool/websearch.test.ts **不**接管(#223 修复轮):新增失败测试落 alpha 自有的
  # test/tool/alpha-websearch-failure.test.ts(新增文件不触发 --diff-filter=DMR,无需 exclude)。
  ':(exclude)packages/opencode/src/tool/websearch.ts'
  ':(exclude)packages/opencode/src/tool/mcp-websearch.ts'
  # ADR-035 §1 追加(#223 R3 Blocker 1,2026-07-26):打包 sidecar 同时挂载 V2 Location 服务,
  # core 的 BuiltInTools 里是**第二份已挂载的同名 websearch 注册**。主权最终闸必须覆盖每一份
  # 执行副本,故同类叶子再收一个;接管面仅 execute 首行的闸。
  ':(exclude)packages/core/src/tool/websearch.ts'
  # ADR-038(#668,2026-07-28):v1 审批请求的应答期限。上游 `Permission.ask` 的
  # `Deferred.await` 无超时 ⇒ 无人应答即无限期挂起(ADR-036 把会话发送退回 v1 后成为
  # 高频路径)。期限只能落在 Deferred 所在的这一处;L0 接缝只能改判定、壳侧看门狗会连带
  # 拒绝同会话全部 pending、L1/L2 无法 loud-fail 承载安全语义(逐条证据见 ADR-038 §2)。
  # 接管面刻意压到这一个文件;新增闸门落 alpha 自有的
  # test/permission/alpha-ask-deadline.test.ts(新增文件不触发 --diff-filter=DMR)。
  ':(exclude)packages/opencode/src/permission/index.ts'
  # ADR-041(#878,2026-08-09):工具身份与不可变显示快照。来源信息在这些注册/聚合/
  # 权限/首次写入咽喉之后结构性丢失,L0-L2 无法从 alias 诚实反推。仅逐文件接管;
  # 新的 alpha-tool-identity 闸门是新增文件,无需 exclude。permission/index.ts 已由
  # ADR-038 接管,不重复列。
  ':(exclude)packages/schema/src/v1/session.ts'
  ':(exclude)packages/sdk/js/src/gen/types.gen.ts'
  ':(exclude)packages/opencode/src/mcp/index.ts'
  # REQ-134 #1011: argv observation for `{workspace}` → InstanceState.directory must live next to
  # connectLocal. New files under packages/opencode/test would still be DMR-modified siblings.
  ':(exclude)packages/opencode/test/mcp/lifecycle.test.ts'
  ':(exclude)packages/opencode/test/fixture/mcp-lifecycle-stdio.ts'
  ':(exclude)packages/opencode/src/plugin/index.ts'
  ':(exclude)packages/opencode/src/tool/registry.ts'
  ':(exclude)packages/opencode/src/tool/code-mode.ts'
  ':(exclude)packages/opencode/src/session/tools.ts'
  ':(exclude)packages/opencode/src/session/processor.ts'
  ':(exclude)packages/opencode/src/session/llm.ts'
  ':(exclude)packages/opencode/src/session/llm/request.ts'
  ':(exclude)packages/opencode/src/session/prompt.ts'
  ':(exclude)packages/opencode/test/session/compaction.test.ts'
  ':(exclude)packages/opencode/test/session/processor-effect.test.ts'
  ':(exclude)packages/opencode/test/session/prompt.test.ts'
  ':(exclude)packages/opencode/test/provider/transform.test.ts'
  ':(exclude)packages/opencode/test/tool/code-mode-integration.test.ts'
  ':(exclude)packages/opencode/test/tool/code-mode.test.ts'
  ':(exclude)packages/opencode/test/tool/registry.test.ts'
  ':(exclude)packages/core/src/tool/application-tools.ts'
  ':(exclude)packages/core/src/tool/registry.ts'
  # ADR-042(#1047): OAuth loopback success/error HTML is product chrome; ADR-007
  # Vite brand transform never reaches engine-served callback pages.
  ':(exclude)packages/core/src/oauth/page.ts'
  ':(exclude)packages/core/test/oauth-page.test.ts'
)

# ── UPSTREAM_PATHS 里住着的 alpha 自有文件:结构性谓词,不是逐文件清单(`#1085` / ADR-043)──
#
# 缺陷(`#971` 实测):我们有一批**自己写的**文件住在上游包目录里(闸门测试、`tool-identity.ts`
# 本体、ADR-033 的两条迁移…)。落地那一次是 `A`,`--diff-filter=DMR` 不点名 —— ADR-041 第 72 行
# 据此写下「新增文件因 guard 的 DMR 策略不需要排除」。**那个豁免只在落地那一刻成立**:文件进了
# `origin/alpha` 之后,任何一次修改都是 `M`,守卫当场红。于是「给自己写的判据补一条用例」要先走
# 一轮 owner 级 ADR 修订,而门红时最省事的反应是 `--no-verify` —— 那会把**所有**门一起关掉。
#
# owner 裁决(`#1079` CHOICE=2):走**结构性谓词**,不走逐文件 exclude 清单。清单对新成员默认
# 放行(每来一个新人都要再走一轮收编),谓词对新成员默认覆盖。
#
# 谓词 = 两个因子的**合取**,缺一不豁免:
#   ① 出身:这条路径在上游镜像 `origin/dev` 里**不存在**。dev 是上游纯镜像(ADR-005),
#      真上游文件按定义在它里面 ⇒ 这一条单独就挡住了「把真上游改动放行」的绝大部分。
#   ② 自报家门:basename 以 `alpha-` 开头,**或**文件里写着 `north-star:alpha-owned`。
#
# 为什么必须是合取,而不是任一条单独成立:
#   · 只有①:`origin/dev` 是个会陈旧的 ref。fetch 失败(实测 3 次 1 次)+ 上游在这段窗口里
#     新增一个文件并被 sync 合进 alpha ⇒ 那个**真上游**文件在本地 dev 里查不到 ⇒ 被放行。
#   · 只有②:上游哪天新增一个 `alpha-*.ts`(或正文里恰好出现那个 token),就自动获得豁免。
#   合取之后,要骗过它得同时满足「dev 陈旧到看不见它」和「它叫 alpha-* / 带着我们的 token」——
#   把 token 抄进一个真上游文件不管用,因为①会否掉它(dev 里有这条路径)。
#
# ② 的内容取**改动后**的版本(工作树 → HEAD → 基准,取第一个取得到的)。这不是漏洞:伪造
# marker 只在①也成立时才有效,而①对真上游文件不成立。
#
# 边界(诚实登记,不谎称穷尽):
#   · `origin/dev` 整个 ref 取不到 ⇒ 豁免**整体停用**(fail-closed),回到本谓词之前的行为:
#     UPSTREAM_PATHS 下的每一处改动都算上游改动。方向安全(过报,不漏报)。
#   · 上游**删掉**、而 alpha 留着的文件,①成立 ⇒ 它要拿到豁免仍需②(得有人显式标记)。
#   · 谓词判的是**路径**,不是内容:它回答「这条路径是不是上游的」,不回答「这次改动对不对」。
UPSTREAM_MIRROR="origin/dev"
ALPHA_OWNED_MARKER="north-star:alpha-owned"

# 因子①:上游镜像里有没有这条路径。
mirror_has() { git cat-file -e "${UPSTREAM_MIRROR}:$1" 2>/dev/null; }

# 因子②:命名约定,或文件里显式写着 marker。内容按 工作树 → HEAD → 基准 取第一个取得到的版本
# (被删掉的文件在工作树里没有内容,但它仍要判得出来)。
#
# **刻意不用管道**(`… | grep -qF`)。本脚本开着 `pipefail`,而 `grep -q` 命中即退出、写端拿到
# SIGPIPE ⇒ 整条管道的退出码是 141 —— 文件一大就把「找到了 marker」读成「没找到」。实测:
#   $ bash -c 'set -uo pipefail; cat big.txt | grep -qF token; echo $?'   → 141
# 方向是 fail-closed(误判成上游 ⇒ 假红)而不是放行,但它取决于文件多大、marker 在第几行,
# 是那种「今天绿明天红」的不可复现门。命令替换没有这个问题。
declares_alpha_owned() {
  case "${1##*/}" in alpha-*) return 0 ;; esac
  local body
  body="$(cat "$1" 2>/dev/null || git show "HEAD:$1" 2>/dev/null || git show "origin/alpha:$1" 2>/dev/null)" || return 1
  case "$body" in *"$ALPHA_OWNED_MARKER"*) return 0 ;; esac
  return 1
}

is_alpha_owned() {
  [ "$mirror_ok" -eq 1 ] || return 1
  mirror_has "$1" && return 1
  declares_alpha_owned "$1"
}

# ── fetch 失败时的降级,以及它为什么必须自报家门(`#913`)───────────────────────────
# 这条 fetch **间歇失败**(实测:`#889` 实现方约 3 次 1 次、主 session 复验 3 次撞到 1 次,
# 手跑同一条命令 exit 0 —— 与 CLAUDE.md 记的 `api.github.com` 代理抖动同形)。失败时守卫按
# 设计降级到「本地上一次拿到的 origin/alpha」继续跑,**方向是安全的**:陈旧基准只会把比较
# 窗口撑得更宽 ⇒ 过报,不会漏报真违规。
# 真正的问题是**可见性**:那行 warn 混在一整屏门输出里极易被略过,而「落后 1 个提交」与
# 「落后 3 周」原来长得一模一样 ⇒「守卫今天绿」这句话的含义,取决于一个没人看得见的量。
# 所以降级时把基准的身份与年龄一并报出来(在基准 ref 确认存在之后的那一段)。
# CI 不走这条路:alpha-ci.yml 的 `Ensure origin/alpha is available` 步是裸 fetch,失败即 job
# 红。降级只属于本地档。
fetched=1
if ! git fetch --no-tags origin alpha --quiet 2>/dev/null; then
  fetched=0
  echo "    (warn: could not fetch origin/alpha — comparing against last-known origin/alpha)"
fi

# 上游镜像只用来判「这条路径是不是上游的」,**不参与比较基准**(基准仍是 origin/alpha,`#889`)。
# 取不到不致命:用本地上一次拿到的 origin/dev,并把它的身份与年龄报出来(同 `#913` 的纪律)。
mirror_fetched=1
git fetch --no-tags origin dev --quiet 2>/dev/null || mirror_fetched=0

# 基准取不到就**当场红**,不是静默放行(`#889`)。原来的写法是
# `git diff … origin/dev…HEAD … 2>/dev/null || true`:ref 不存在时 git 报错被吞掉、
# `|| true` 把它变成空串 ⇒ 「已提交改动」那半边守卫**静默消失**而这一步报 ✓。
# 一道给出结论、而结论不再回答我们以为它在回答的那个问题的门,比没有门更贵。
if ! git rev-parse --verify --quiet origin/alpha >/dev/null; then
  echo "    ✗ 比较基准 origin/alpha 取不到 —— 本次守卫作废(不是通过)。"
  echo "      → 先 \`git fetch origin alpha\`;拿不到基准时这道门无法回答「这个分支改了哪些上游文件」。"
  exit 1
fi

# `#913`:降级时把「这一跑到底量的是什么」写进输出 —— 基准的身份(sha)、它有多旧、以及
# 比较窗口因此有多宽。窗口宽度 = 有多少条提交落进了 `origin/alpha...HEAD`,也就是过报的量。
# 注意这里报的都只能是**本地可知**的量:fetch 都失败了,真实远端领先多少条无从得知,所以
# 报的是基准提交自己的日期与 `origin/alpha..HEAD` 的条数,**不是**「落后远端 N 条」。
# 判据不在这段散文里:north-star-guard.test.ts 造「fetch 拿不到 + last-known 陈旧」的情形,
# 断言输出里读得出基准 sha 与陈旧程度,并且 fetch 正常时这一段**不出现**(否则一个「无条件
# 永远打印一句年龄」的实现也能满足前者)。
if [ "$fetched" -eq 0 ]; then
  base_sha="$(git rev-parse --short origin/alpha 2>/dev/null || echo '?')"
  base_date="$(git log -1 --format=%cd --date=short origin/alpha 2>/dev/null || echo '?')"
  base_age="$(git log -1 --format=%cr origin/alpha 2>/dev/null || echo 'unknown age')"
  base_window="$(git rev-list --count origin/alpha..HEAD 2>/dev/null || echo '?')"
  echo "      baseline: last-known origin/alpha @ ${base_sha} — dated ${base_date} (${base_age}); window origin/alpha..HEAD = ${base_window} commits"
fi

# 镜像 ref 取不到 ⇒ alpha 自有豁免整体停用,而不是「反正查不到就当 alpha 自有」。后者会把
# 每一次上游改动都放行,是这道门能犯的最贵的错。
mirror_ok=1
if ! git rev-parse --verify --quiet "$UPSTREAM_MIRROR" >/dev/null; then
  mirror_ok=0
  echo "    (warn: 取不到上游镜像 ${UPSTREAM_MIRROR} — alpha 自有豁免本跑整体停用(fail-closed):UPSTREAM_PATHS 下每一处改动都按上游改动处理)"
fi
if [ "$mirror_ok" -eq 1 ] && [ "$mirror_fetched" -eq 0 ]; then
  echo "      mirror: last-known ${UPSTREAM_MIRROR} @ $(git rev-parse --short "$UPSTREAM_MIRROR") — dated $(git log -1 --format=%cd --date=short "$UPSTREAM_MIRROR") ($(git log -1 --format=%cr "$UPSTREAM_MIRROR"))"
fi

# committed delta (mirrors CI) ∪ working-tree edits (earlier local feedback)
# 同一条理由:diff 本身失败也是「测不到」,不是「没有改动」。宁可当场红。
# `--no-renames` 是**判据的一部分**,不是风格(`#1085`)。默认开着的改名检测会把一次改名压成
# 一条 `R`,而 `--name-only` 对 `R` 只印**目的路径** —— 于是「把上游文件改名成 alpha-foo.ts」
# 在下面的谓词里两个因子全中,被当成 alpha 自有放行,而上游那条路径其实已经消失(fork-sync
# 照样冲突)。关掉改名检测后,同一次改名回到 `D`(旧路径)+ `A`(新路径):`D` 落进 DMR 被点名,
# 点的还正好是真正受害的那条路径。north-star-guard.test.ts 里有一条专钉这个形状。
if ! committed="$(git diff --no-renames --diff-filter=DMR --name-only origin/alpha...HEAD -- $UPSTREAM_PATHS "${UPSTREAM_EXCLUDES[@]}")"; then
  echo "    ✗ 算不出与 origin/alpha 的提交差 —— 本次守卫作废(不是通过)。"; exit 1
fi
if ! worktree="$(git diff --no-renames --diff-filter=DMR --name-only HEAD -- $UPSTREAM_PATHS "${UPSTREAM_EXCLUDES[@]}")"; then
  echo "    ✗ 算不出工作树差 —— 本次守卫作废(不是通过)。"; exit 1
fi
changed="$(printf '%s\n%s\n' "$committed" "$worktree" | sed '/^$/d' | sort -u)"

# 分类:被点名的每一条路径,按上面那个两因子谓词判「上游」还是「alpha 自有」。
flagged=""
exempt=""
while IFS= read -r path; do
  [ -n "$path" ] || continue
  if is_alpha_owned "$path"; then
    exempt="${exempt}${path}
"
  else
    flagged="${flagged}${path}
"
  fi
done <<CHANGED
$changed
CHANGED

# 豁免必须**说出来**。一次静默的放行与一次没跑的门在输出上长得一模一样,而这道门的整个价值
# 就在于「它今天绿」这句话有确定含义(`#913` 同一条纪律)。
if [ -n "$exempt" ]; then
  echo "    · alpha 自有(住在上游包里,但 ${UPSTREAM_MIRROR} 从来没有过这条路径)—— 不算上游改动:"
  printf '%s' "$exempt" | sed 's/^/      /'
fi
if [ -n "$flagged" ]; then
  echo "    ✗ upstream files modified/deleted/renamed (fork-sync would conflict):"
  printf '%s' "$flagged" | sed 's/^/      /'
  echo "      → revert; extend via alpha files (packages/ext, packages/ui-mac) or seams (ADR-002/005)."
  echo "      → 它其实是 alpha 自有文件?命名成 alpha-*,或在文件里写一行 '${ALPHA_OWNED_MARKER}'(ADR-043)。"
  exit 1
fi
echo "✓ zero upstream package edits (baseline origin/alpha; ADR-033 收编白名单 + ADR-043 alpha 自有谓词除外)"
