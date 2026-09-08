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
# ── 这道门**只回答一半**,另一半在第 [13/14] 步(`#1288`)────────────────────────────
# 本门回答的是「**这个 PR 自己**有没有新增偏离」(基准 = origin/alpha,理由见下一节)。它按设计
# 答不了另外两个问题,而且这两个「答不了」都是结构性的、不是实现缺陷:
#   · 「我们今天**总共**偏离了多少」—— 下面 UPSTREAM_EXCLUDES 里的每一条都是一次**有意的收编**,
#     本门放行它们;放行是判决,不是「不存在」,于是白名单背后那堆行数对本门永远不可见。
#   · 「上一次跟上游对齐是多久以前」—— 本门只拿 origin/dev 判「这条路径是不是上游的」,从不看它的日期。
# 这两个量由 scripts/north-star-drift-metrics.sh(alpha-check 第 [13/14] 步)每次本地闸打印,
# **只量不拦**(先量后闸,不设阈值)。它消费本文件的 `--print-jurisdiction`,不另抄一份清单。
# CLAUDE.md 的北极星那一段与本段说的是同一件事 —— 两处措辞不一致本身就是缺陷(`#1288` 退出条件 3)。
# 一句话:**这道门今天绿 ≠ 我们没有偏离。**
#
# ── 比较基准 = `origin/alpha`,不是 `origin/dev`(`#889`)──────────────────────────
# 这道门要回答的是「**这个 PR 自己**改了上游文件吗」,所以基准只能是它的目标分支 ——
# alpha-ci 的 `on: push/pull_request: branches: [alpha]`,分支保护也挂在 alpha 上。
# 原来两处写死 `origin/dev`(上游纯镜像分支),那是一个与目标分支无关的字面常量:
#
#   · 实测(2026-08-10):`origin/dev` 与 `origin/alpha` 的 merge-base 停在 `347510a73`
#     (2026-07-23),alpha 领先 289 个提交、dev 领先 261 个且仍在动 ⇒ `origin/dev...HEAD`
#     的窗口是 550 commits / 2467 文件,而不是这个 PR 改了什么。
#   · 它是 `origin/alpha...HEAD` 的**超集窗口** ⇒ 不漏报真违规,但会**过报**:那个窗口当天
#     点名 47 个上游文件,全靠下面那张 UPSTREAM_EXCLUDES(本意是登记**有意的收编**)恰好
#     吸收掉,才在当天给出与 alpha 基准相同的结论(两种基准当天都是 0)。
#     ⚠️ 这一句刻意**不写**白名单有多少条(`#1288`)。原文写的是「44 条」,而 2026-09-08 实测
#     `grep -c "^  ':(exclude)" scripts/north-star-guard.sh` → **48** —— 散文里的计数会随下面
#     那张表每加一条就烂一次,而没有任何东西会因此变红(这一处是 `#1290` 的实现方核出来的)。
#     那个数唯一的活来源是本文件自己的 `${#UPSTREAM_EXCLUDES[@]}`:它经下面的
#     `--print-jurisdiction` 交给 scripts/north-star-drift-metrics.sh,每次本地闸第 [13/14] 步
#     以「收编面」打印出来。要知道今天有多少条就去看那一行,**不要在散文里再养一个副本**。
#   · ⇒ 任何一次不在 exclude 表里的**合法**上游改动(fork-sync、收编前的上游变更),
#     都会让这道门在**每个 PR** 上恒红 —— 包括没碰它的 PR。本文件下面那句
#     「Drift here is worse than no gate: a permanently-red local guard trains you to ignore it」
#     说的正是这个,而 `#754`(pre-push 恒假红 ⇒ 第一道门实际关着)已经演过一遍。
#
# 判据不在这段散文里:north-star-guard.test.ts 造一个「只在 dev 窗口里、不在 alpha 窗口里」
# 的上游改动,断言守卫**不**点名它 —— 把基准还原成 origin/dev,那一条当场红。
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

# ── `#1288`:只读模式 `--print-jurisdiction` —— 把辖区说出来,而不是让别人再抄一份 ────
# 漂移度量步(alpha-check 第 [13/14] 步,scripts/north-star-drift-metrics.sh)要回答的是
# 「我们现在**总共**偏离上游多少」。它需要的四样东西 —— 辖区、两张 carve-out、上游镜像 ref、
# 收编白名单有多长 —— 全都住在本文件里,而本文件是它们的**唯一真源**(`#889`)。
# 让度量步自己再写一份 = `#637` 那个已经咬过我们一次的形状:两份清单各自漂移,而没有任何
# 东西会变红。所以这里开一个只读模式:打印这些值然后退出,**一个 git 命令都不跑、一个字节
# 都不判**。无参数时的行为逐字不变(CI 与 alpha-check 都不带参数)。
GUARD_MODE=guard
case "${1:-}" in
  '') ;;
  --print-jurisdiction) GUARD_MODE=print-jurisdiction; shift ;;
  *) echo "✗ 未知参数:$1(本脚本只接受 --print-jurisdiction)" >&2; exit 2 ;;
esac
[ "$#" -eq 0 ] || { echo "✗ 多余参数:$*" >&2; exit 2; }

# ── 辖区 = `packages/` 全树 −(两张显式 carve-out)。ADR-044 / `#1247` ────────────────
#
# 缺陷(2026-09-06 实测):辖区原本是一张 8 个包的枚举
# `packages/{opencode,core,server,tui,sdk,protocol,schema,client}`,而上游镜像 `origin/dev`
# 当天有 **32** 个包(`git ls-tree --name-only origin/dev packages/ | wc -l` → 32)。
# 24 个包在辖区外;其中 `app`/`ui` 由 ADR-034 的 roundtrip 门盖住,**其余 22 个零机制**:
# 往 `packages/plugin/src/index.ts`(**Hooks 契约本体**)与 `packages/llm/src/index.ts` 各写一行,
# 这道门报 `✓ zero upstream package edits` 且 `exit 0`。它是 alpha 分支保护上的必需 context,
# 于是「北极星绿」这句话对一大半地盘什么都没说,而下一次 fork-sync 照样冲突。
#
# 根因是**数据模型**,不是某一行写错:枚举对**新成员默认放行** —— 上游每加一个包就多一个盲区,
# 而没有任何东西会变红。ADR-043(`#1079` owner CHOICE=2)在**文件**那一层已经因为同一条理由
# 否掉过逐文件清单、改用结构性谓词。这里把同一条纪律搬到**包**这一层:辖区是整棵 `packages/`,
# **例外**才是清单 —— 例外默认拒,新成员默认覆盖。
#
# 行为判据在 packages/ui-mac/src/main/north-star-guard.test.ts 的 `#1247` 那一节:每一类包各造
# 一个已知该红的输入,并各带一个控制组(辖区换回 8 包 / 抹掉 carve-out),先证明夹具测得出
# 已知的坏。防漂断言在 packages/ui-mac/src/main/local-gate-parity.test.ts。
UPSTREAM_PATHS="packages"

# carve-out ①:alpha 自有的 workspace 包 —— `origin/dev` 里**根本没有**这三条路径
# (ADR-004 后果②:新增 workspace 包必然改写根 bun.lock;ADR-016 前端接管;REQ-224 契约消费者)。
# 为什么是整包豁免、而不是走 ADR-043 的逐文件谓词:那个谓词要求每个文件**自报家门**
# (`alpha-*` 命名或写一行 marker),而这三个包里成千上万个文件全是 alpha 写的 —— 逐文件登记
# 只会把「改自己的代码」变成一道恒红门。
# **这张清单由下面的运行期自检逐条对着上游镜像验一遍**:把一个真上游包写进来,是绕开整道门
# 最便宜的一步(一行配置换一整个包的豁免),它不能只靠人看。
ALPHA_OWNED_PACKAGES="ext ui-mac alpha-contracts-consumer"

# carve-out ②:由 ADR-034 的 pin + SOT 补丁 roundtrip 盖住的前端包。
# 它们**不是** alpha 自有(`origin/dev` 里有,alpha 也确实在改),但覆盖它们的不是本门:
#   · 无空档 —— `scripts/assert-frontend-patch-roundtrip.sh` 判的是「HEAD 的这两棵树必须能由
#     `frontend/frontend-pin.lock` 的 pin + `frontend/alpha-patches/alpha-frontend.patch`
#     **逐字节重建**」(比 tree sha),它比本门**更强**:连「改了但没重生补丁」都当场红,
#     而本门只判「有没有改」。它跑在 alpha-ci 的同一个 job 里,且刻意用 `if: !cancelled()`。
#   · 无重复 —— 本门若也盖它们,ADR-034 明写的日常工作流(改 seam = 改补丁 + 重生那两棵树)
#     每一次都会被判成破北极星 ⇒ 恒红门 ⇒ `--no-verify` ⇒ 十道门一起关掉(`#754` 形态)。
# 两处清单相同由 local-gate-parity.test.ts 判(有人把 roundtrip 门的 PACKAGES 改小 = 空档,即红)。
ROUNDTRIP_PACKAGES="app ui"

# 两张 carve-out 落成 pathspec。刻意**不**并进下面的 UPSTREAM_EXCLUDES:那张表的语义是
# 「ADR-033/035/038/041/042 逐文件**收编**」,与「这个包根本不归本门管」不是一回事,混在
# 一起会让「新增收编须自己的 ADR」这条纪律在阅读时失焦。
CARVEOUT_PATHSPECS=()
for pkg in $ALPHA_OWNED_PACKAGES $ROUNDTRIP_PACKAGES; do
  CARVEOUT_PATHSPECS+=(":(exclude)packages/$pkg")
done
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

# `#1288` 只读模式的落点:上面五个值全部定义完、而**任何** git 命令都还没跑。放在这里是判据
# 的一部分 —— 度量步在拿不到 origin/dev 时要自己判「未测量」,它不能先被守卫的 fetch/降级
# 逻辑改写状态。行为判据在 packages/ui-mac/src/main/north-star-drift-metrics.test.ts:那里把
# 本脚本复制一份、只删掉三条 exclude,断言度量步打印的条数**跟着变**(杀掉「印一个写死的数」)。
if [ "$GUARD_MODE" = print-jurisdiction ]; then
  printf 'UPSTREAM_PATHS\t%s\n' "$UPSTREAM_PATHS"
  printf 'ALPHA_OWNED_PACKAGES\t%s\n' "$ALPHA_OWNED_PACKAGES"
  printf 'ROUNDTRIP_PACKAGES\t%s\n' "$ROUNDTRIP_PACKAGES"
  printf 'UPSTREAM_MIRROR\t%s\n' "$UPSTREAM_MIRROR"
  printf 'UPSTREAM_EXCLUDES_COUNT\t%s\n' "${#UPSTREAM_EXCLUDES[@]}"
  exit 0
fi

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

# ── ALPHA_OWNED_PACKAGES 的运行期自检(ADR-044 / `#1247`)────────────────────────────
# 辖区变成「整棵 packages/ 减 carve-out」之后,**那张 carve-out 清单就是这道门的软肋**:往
# ALPHA_OWNED_PACKAGES 里加一个词,就把一整个上游包移出辖区,而其余每一条断言照样绿。
# 所以它必须有机械判据 —— 判据现成:alpha 自有包按定义在上游镜像里**查无此路径**。
# 镜像取不到时跳过(上面已经因此发过警告);那一档只是「这一跑没验」,不是放行,因为辖区
# 本身不依赖镜像。
if [ "$mirror_ok" -eq 1 ]; then
  forged=""
  for pkg in $ALPHA_OWNED_PACKAGES; do
    if mirror_has "packages/$pkg"; then forged="${forged} packages/$pkg"; fi
  done
  if [ -n "$forged" ]; then
    echo "    ✗ ALPHA_OWNED_PACKAGES 里有上游镜像 ${UPSTREAM_MIRROR} 里就存在的包:${forged}"
    echo "      → 上游有的包不是 alpha 自有。把它写进那张清单等于给整个包发豁免,本次守卫作废(不是通过)。"
    echo "      → 真要接管上游文件,走 ADR-029 的阶梯并逐文件登记进 UPSTREAM_EXCLUDES,不要动包级 carve-out。"
    exit 1
  fi
fi

# committed delta (mirrors CI) ∪ working-tree edits (earlier local feedback)
# 同一条理由:diff 本身失败也是「测不到」,不是「没有改动」。宁可当场红。
# `--no-renames` 是**判据的一部分**,不是风格(`#1085`)。默认开着的改名检测会把一次改名压成
# 一条 `R`,而 `--name-only` 对 `R` 只印**目的路径** —— 于是「把上游文件改名成 alpha-foo.ts」
# 在下面的谓词里两个因子全中,被当成 alpha 自有放行,而上游那条路径其实已经消失(fork-sync
# 照样冲突)。关掉改名检测后,同一次改名回到 `D`(旧路径)+ `A`(新路径):`D` 落进 DMR 被点名,
# 点的还正好是真正受害的那条路径。north-star-guard.test.ts 里有一条专钉这个形状。
if ! committed="$(git diff --no-renames --diff-filter=DMR --name-only origin/alpha...HEAD -- $UPSTREAM_PATHS "${UPSTREAM_EXCLUDES[@]}" "${CARVEOUT_PATHSPECS[@]}")"; then
  echo "    ✗ 算不出与 origin/alpha 的提交差 —— 本次守卫作废(不是通过)。"; exit 1
fi
if ! worktree="$(git diff --no-renames --diff-filter=DMR --name-only HEAD -- $UPSTREAM_PATHS "${UPSTREAM_EXCLUDES[@]}" "${CARVEOUT_PATHSPECS[@]}")"; then
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
# 绿也要说清「这一跑量的是什么」(`#913` 同一条纪律):辖区不再是读者背得出来的 8 个包,
# 而是「整棵 packages/ 减两张 carve-out」—— 不把 carve-out 打出来,「今天绿」就又变成隐含知识。
echo "✓ zero upstream package edits (辖区 = packages/ 全树 − alpha 自有包 [${ALPHA_OWNED_PACKAGES}] − ADR-034 roundtrip 包 [${ROUNDTRIP_PACKAGES}];baseline origin/alpha;ADR-033 收编白名单 + ADR-043 alpha 自有谓词除外)"
