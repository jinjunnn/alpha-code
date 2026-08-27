#!/usr/bin/env bash
# alpha-check — run the exact gates alpha-ci enforces, LOCALLY, before you push.
#
# Standard: local-first (see docs/runbooks/ci.md). CI is the enforcing backstop, not the place
# you first discover a failure.
#
#   bash scripts/alpha-check.sh
#
# Exit 0 = safe to push (CI will mirror this). Non-zero = fix before pushing.
#
# ── 「与 alpha-ci 1:1」是一条**可检查的断言**,不是一句自我介绍(`#777`)────────────
# 这句话此前写在三处(本文件抬头、CLAUDE.md、docs/runbooks/ci.md),而实际只跑了
# alpha-ci 十二个代码步里的九个,其中三个还是降级档(裸 `bun test`:跑 0 条照样 exit 0,
# 正是 `#647` 在 CI 上修掉的那个假绿形态)。「本地绿 ⇒ 可以合」这条铁律的全部依据就是
# 这句 1:1 —— 它是散文的时候,那条铁律没有地基。
#
# 现在:下面的 CI_STEPS 是本脚本对 alpha-ci 的**逐步对照表**,脚本结束时会把它打出来;
# packages/ui-mac/src/main/local-gate-parity.test.ts 反过来从 .github/workflows/alpha-ci.yml
# 里枚举出全部代码步,与这张表比对 —— CI 新增一步而这里没登记,即红。
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

# 每行:<alpha-ci job>|<alpha-ci step name>|<本地档位>
# 档位只有三种:MIRRORED(跑同一条命令)、SUPERSET(本地还多验了东西)、
# DEGRADED:<理由>(跑不了/跑的是降级档 —— 必须写清降级了什么)。没有第四种。
CI_STEPS=(
  # `#895`:四个 required job 各自的第一步 —— 证明 alpha-ci 的分类步 detect 真的给出了结论。
  # 本地没有这个状态可言:alpha-check 一律跑全部十步,没有 docs-only 快路径、没有分类步,
  # 所以「分类步失败 ⇒ 闸门集体静默跳过」在本地结构上到不了 —— 本地严格更强,故 SUPERSET。
  "upstream-guard|Assert detect classified this diff (#895)|SUPERSET:本地无条件跑全部闸门,不存在分类步 ⇒ 无「分类失败则闸门静默跳过」这一状态"
  "typecheck|Assert detect classified this diff (#895)|SUPERSET:同上"
  "test|Assert detect classified this diff (#895)|SUPERSET:同上"
  "docs-gate|Assert detect classified this diff (#895)|SUPERSET:同上"
  "upstream-guard|No literal NUL bytes in version-controlled files|MIRRORED"
  "upstream-guard|Fail on any modification to upstream package files|SUPERSET:committed delta ∪ 未提交工作树改动"
  # `#976`:本地与 CI 跑同一个脚本,但**档位不同** —— 主 checkout 本身是浅克隆(.git/shallow 在),
  # pin 对象取不到时本地判「未比对」(exit 2)只记 unverified、不拦 push;CI 侧 ROUNDTRIP_REQUIRE_PIN=1,
  # 同一状态硬红(CI 自己控制 checkout 深度,取不到 pin 是接线坏了)。登记成 MIRRORED 会让
  # 「本地绿 ⇒ CI 会绿」的依据变假 —— 那正是 `#777` 治的病。
  "upstream-guard|Assert packages/app + packages/ui == pinned upstream + SOT patch (#976)|DEGRADED:本地 pin 取不到时判「未比对」(exit 2)不拦 push;CI 侧 ROUNDTRIP_REQUIRE_PIN=1,同一状态硬红"
  "typecheck|typecheck @alpha-code/contracts-consumer|MIRRORED"
  "typecheck|typecheck @alpha-code/ext|MIRRORED"
  "typecheck|typecheck ui-mac|MIRRORED"
  "typecheck|typecheck opencode (alpha 自有判据住在上游包里)|MIRRORED"
  "test|verify immutable Alpha contract vendor lock|SUPERSET:开发机有兄弟仓 ⇒ 跑的是 provenance 已验档,CI 是降级档(#769)"
  "test|bun test (contracts consumer fixtures)|MIRRORED"
  "test|bun test (ext)|MIRRORED"
  "test|bun test (ui-mac)|MIRRORED"
  "test|bun test (app rolling pin, alpha 判据入门)|MIRRORED"
    # `#1153`:同一脚本、两个平台档 —— darwin-only 平台条件闸(真 sandbox-exec 语料)只在本地
  # (darwin)真执行;CI(ubuntu)对那几行按「本平台不适用」(exit 2)消费为不拦。本地严格更强。
  "test|assert gate files (逐个点名,整包地板抓不到单文件消失)|SUPERSET:darwin-only 平台条件闸只在本地(darwin)真执行,CI(ubuntu)对它们判「本平台不适用」(exit 2 不拦,#1153)"
  "seed-assets|Assert seed/vendored resources present (B7)|MIRRORED"
  "docs-gate|Relative-link validity in changed Markdown|MIRRORED"
)

# REQ-015 self-heal(2026-07-05):husky 的 prepare 在每次 `bun install` 后把 core.hooksPath
# 重置回 .husky/_(其全量 turbo typecheck 在 ADR-020 冻结偏斜下因 session-ui 恒红)。
# 此处仅在值偏离时重挂 alpha 门,使 .githooks/pre-push(= 本脚本)成为默认 push 门,同时
# 让一次健康的 pre-push 连共享 .git/config 的文件身份都不改。逃生:ALPHA_HOOKS_DISABLE=1。
if [ "${ALPHA_HOOKS_DISABLE:-}" != "1" ]; then
  current_alpha_hooks_path="$(git config --local --get core.hooksPath 2>/dev/null || true)"
  if [ "$current_alpha_hooks_path" != ".githooks" ]; then
    git config --local core.hooksPath .githooks 2>/dev/null || true
  fi
  unset current_alpha_hooks_path
fi

fail=0
# `#890`:「本次没能比对真源」是**第三种**结局,不是绿也不是红 —— 见第 [10/10] 步。
unverified=0

echo "▶ [1/10] north-star guard (zero upstream edits)"
# `#889`:守卫本体住在 scripts/north-star-guard.sh —— 内联时它一个判据都没有(断言 shell
# 源码文本按本仓定义是假闸门:守卫被整段注释掉时那种断言照样绿)。真判据 =
# packages/ui-mac/src/main/north-star-guard.test.ts,它起真 git 仓、造真的上游改动、跑
# **那个脚本本体**,断言它真的点名了那个文件。UPSTREAM_PATHS 与 ADR-033 收编白名单也随之
# 搬过去,与 alpha-ci.yml 两处逐条相同仍由 local-gate-parity.test.ts 判(`#637`)。
if bash scripts/north-star-guard.sh; then
  echo "    ✓ zero upstream package edits"
else
  fail=1
fi

echo "▶ [2/10] packages/{app,ui} == pin + SOT 补丁(round-trip,#976)"
# `#976`:ADR-034 起 packages/{app,ui} 是「上游 pin + frontend/alpha-patches/alpha-frontend.patch」
# 的投影。sync-upstream 的还原步(`rm -rf` → `checkout $PIN --` → `git apply`)与月更 bump 的
# 第一块都会**据此重写那两个目录** ⇒ 改了它们而没重生补丁,改动会被**静默删除**(不是报错)。
# 这在已合并历史上真的发生过:f420fe2bb…7281627ed 四个提交补丁缺 vendored `.tgz`,存活两天、
# 零变红;没出事只因为 sync 那阵子一直红着没跑到还原步。
#
# 判据本体在 scripts/assert-frontend-patch-roundtrip.sh —— 它比的是 **git tree sha**
# (临时 index → read-tree pin → apply --cached --binary 补丁 → write-tree),不是文件名集:
# 名字集比较对内容漂移结构性失明(实测:改一行 packages/app 源码不重生补丁,bun-test-app.sh
# 的两轴交叉 5 == 5 绿,扩到全部文件 46 == 46 仍绿)。行为判据 =
# packages/ui-mac/src/main/frontend-patch-roundtrip.test.ts(起真 git 仓、造真的漂移、跑那个脚本本体)。
# 三档结局(与 [9/10]/[10/10] 同形):0 一致 / 1 真漂移或测量作废(拦住)/ 2 未比对(浅克隆
# 取不到 pin —— 不拦 push,但总结行不许再说「全绿」)。实测 0.2s。
bash scripts/assert-frontend-patch-roundtrip.sh
frontend_roundtrip_rc=$?
case "$frontend_roundtrip_rc" in
0) ;; # 脚本自己打了 ✓
2) unverified=1 ;; # 脚本自己打了「未比对」
*) echo "    ✗ packages/{app,ui} 与 SOT 补丁不一致 —— 下一次 sync/月更 bump 会把上面点名的改动静默删掉"; fail=1 ;;
esac
unset frontend_roundtrip_rc

echo "▶ [3/10] no literal NUL bytes in version-controlled files"
# #760:字面 NUL 不会让运行时出错,它坏的是**验证手段** —— BSD grep / rg / file(1) 看到 NUL 就把
# 整个文件判成二进制并静默返回空,于是「我 grep 过了,没有」变成假话。本仓 CLAUDE.md 要求
# 「大文件 Edit 后 grep + git show 双验」,而在这些文件上 grep 会安静地说「没有」。
# 已实证四次(#737 枚举被修正两次、#704 一轮两个实例、建 #760 时命令又混进一个、
# alpha-web#109 差点据零命中断定「测试被删了」)。枚举对新成员默认放行,所以这里立的是咽喉。
if python3 scripts/assert-no-nul-bytes.py; then
  echo "    ✓ no literal NUL bytes"
else
  echo "    ✗ literal NUL bytes found"; fail=1
fi

echo "▶ [4/10] typecheck (alpha packages: contracts-consumer + ext + ui-mac + opencode)"
# REQ-027:flag 必须在 `run` 之后 —— `bun --cwd X run Y` 在 bun 1.3.x 打印 usage 后静默退出 0(不执行脚本)。
# `#1134`:opencode 也在这里。它是上游包,但 alpha 自有的判据文件(ADR-043 谓词:不在 origin/dev
# 里 ∧ 自报家门)住在它的 test/ 下,而该包的 tsconfig **不排除** *.test.ts / *.cases.ts ⇒ 那些文件
# 是被 typecheck 的;此前没有任何门跑这个包的 typecheck,于是 15 条真红在 alpha 上活了一整天,
# 还让别的 lane 误以为是自己引入的。口径与实测见 docs/architecture/quality-gate-environments.md §3.11。
if bun run --cwd packages/alpha-contracts-consumer typecheck \
  && bun run --cwd packages/ext typecheck \
  && bun run --cwd packages/ui-mac typecheck \
  && bun run --cwd packages/opencode typecheck; then
  echo "    ✓ typecheck"
else
  echo "    ✗ typecheck failed"; fail=1
fi

echo "▶ [5/10] contract lock + unit tests (contracts-consumer + ext + ui-mac + app)"
# REQ-062:ext 测试入门 —— 其中 prompt-rebrand drift 锁逐条断言转写子串仍在上游底座原文,
# 上游 sync 改写底座即红(ADR-015 合并验证的机械化)。
#
# `#777`:三条测试从裸 `bun test` 换成 scripts/bun-test-floor.sh —— 与 CI 同一条命令、
# 同一个下界。裸 `bun test` 对「文件被清空 / 用例被条件注册成零条 / 指定文件不存在」都会
# 打印 `Ran 0 tests` 并**退出 0**(`#647` 已实测)。CI 早在 #647 就修掉了这个假绿,
# 而本地这道门原样留着 —— 于是「本地绿」在闸门被清空时也成立。
# `#946`:packages/app(滚动 pin,ADR-034)不能裸进 bun-test-floor —— pin 849c2598 自带一条
# 上游红(i18n parity),整包硬塞 = 恒红门(#754 形态);完全不跑 = 写在那个包里的 alpha
# 判据「合并前跑不到」(#933:一处真红瞒过一整轮)。scripts/bun-test-app.sh 以 CI=1 钉
# 上游自己的 CI 口径(既有红被上游 skipIf 治住、新红默认拒),并把 alpha-frontend.patch
# 里的 alpha 判据文件逐个点名重跑、逐文件判精确条数(删文件/删用例/skipIf 包住都当场红,
# 整包地板抓不到)。
# `#1086`:ui-mac 全量带 base fail-set 棘轮 —— scripts/known-fails.tsv(静态、人手维护、
# 逐测试点名)里的已知红放行,**清单外的红拦住并点名**,无法逐测试归因的失败一律拦住
# (判官 = scripts/known-fails-compare.py;junit 为权威、console 双轴交叉,轴打架即测量作废)。
# 此前这里对「基线既有红」一票否决 ⇒ 每条 lane 只能手工重导基线,不导的默认动作是
# `--no-verify`(一次关掉全部十道门,#754 演过)。与 CI 的 `bun test (ui-mac)` 同一条命令、
# 同一份清单。注意清单只罩这一条全量;[6/10] 登记簿的逐文件精确点名**不**吸收已知红。
if bun run --cwd packages/alpha-contracts-consumer check:vendor \
  && bash scripts/bun-test-floor.sh 15 packages/alpha-contracts-consumer \
  && bash scripts/bun-test-floor.sh 100 packages/ext \
  && ALPHA_KNOWN_FAILS_FILE=scripts/known-fails.tsv bash scripts/bun-test-floor.sh 3000 packages/ui-mac src \
  && bash scripts/bun-test-app.sh; then
  echo "    ✓ tests"
else
  echo "    ✗ tests failed"; fail=1
fi

# `#777`:下面三步此前**本地完全没有**,而 CI 有。缺 [6/10] 尤其贵 —— 登记闸门里
# llm / core / opencode 那几个只在这一步执行,别的步骤一条都不覆盖它们。
echo "▶ [6/10] assert gate files (逐个点名;整包地板抓不到单个闸门文件消失)"
# `#1153`:三档结局(与 [2/10]/[9/10]/[10/10] 同形):0 全部适用行已验证 / 1 真失守拦住 /
# 2 门绿但存在「本平台不适用」的平台条件行(darwin-only 的 sandbox-exec 语料在非 darwin 上
# 自报 0 条,登记簿验证标注相符后记「未验证」)。本机是 darwin 而今天登记的平台条件行全是
# darwin ⇒ 本地到不了第 2 档;到得了的是 CI(ubuntu),那边同一脚本同样按三档消费。
bash scripts/assert-gate-files.sh
gate_files_rc=$?
case "$gate_files_rc" in
0) echo "    ✓ gate files" ;;
2) unverified=1 ;; # 脚本自己打了「本平台不适用」清单;不拦 push,但总结行不许再说「全绿」
*) echo "    ✗ gate files failed"; fail=1 ;;
esac
unset gate_files_rc

echo "▶ [7/10] seed assets present (B7)"
if bash scripts/assert-seed-assets.sh; then
  echo "    ✓ seed assets"
else
  echo "    ✗ seed assets missing"; fail=1
fi

echo "▶ [8/10] docs gate (relative-link validity in changed Markdown)"
# CI 只查**这次改动过的** Markdown(detect job 收集)。本地口径同构:相对 origin/alpha 的
# 提交 delta ∪ 未提交工作树改动,再滤成 *.md。一个都没有 ⇒ 与 CI 一样是 no-op。
md_committed="$(git diff --name-only --diff-filter=d origin/alpha...HEAD -- '*.md' 2>/dev/null || true)"
md_worktree="$(git diff --name-only --diff-filter=d HEAD -- '*.md' 2>/dev/null || true)"
md_untracked="$(git ls-files --others --exclude-standard -- '*.md' 2>/dev/null || true)"
md_list="$(printf '%s\n%s\n%s\n' "$md_committed" "$md_worktree" "$md_untracked" | sed '/^$/d' | sort -u)"
if [ -z "$md_list" ]; then
  echo "    ✓ no Markdown changed — docs gate is a no-op (与 CI 同)"
else
  # shellcheck disable=SC2086
  if python3 scripts/check-doc-links.py $md_list; then
    echo "    ✓ docs links ($(echo "$md_list" | wc -l | tr -d ' ') 个 Markdown)"
  else
    echo "    ✗ broken relative links"; fail=1
  fi
fi

echo "▶ [9/10] worktree bootstrap 能力(新建 worktree 自己就能跑出可信 typecheck)(#916)"
# 这一步在 alpha-ci 里**没有对应**,所以它不进 CI_STEPS(那张表是 CI 步骤的对照表)——
# 与第 [10/10] 步同为「只能落在本地」的门,但理由不同:CI 的每个 job 都是一次全新
# `actions/checkout` + `bun install`,**结构上不存在 worktree**;这道门守的是本机多 lane
# 并行时的那条能力。缺了它的世界长这样(`#916` 票面记录的实证):worktree 里拿不到真
# typecheck ⇒ 每条 lane 为了下结论都得去动**共享**主 checkout ⇒ 谁先跑谁量到别人的树。
# 那正是 2026-08-02 把一道**真闸门**误诊成「1/5 间歇性 flaky」的同一形态。
#
# 判据本体在 scripts/assert-worktree-bootstrap.sh —— 它**不**断言「脚本在」「软链在」
# 「文件里写着 bun install」(按本仓定义那是假闸门),而是真建 worktree、真跑 typecheck,
# 并且**先证明没 bootstrap 的树确实会红**,再用同一个探针判 bootstrap 过的树绿。
# 代价:本机实测约 40s(3 棵探针树 + 一次 `bun install` 9.5s + 三次 ui-mac typecheck)。
# 退出码三档(与第 [10/10] 步同形):0 已验证 / 1 真失守拦住 / 2 本次未验证不拦。
# 第 2 档的理由(owner 裁决,`#916` R2):`bun install` **依赖网络**(实测:已装好的树指向
# 不可达 registry 也会 `failed to resolve` / exit 1),而这一步每次 push 都跑 ⇒ 不给豁免的话
# 网络一抖就拦住 push,理由与本次改动无关 ⇒ 人会 `--no-verify` ⇒ **十道门一起关掉**。
# 豁免不许变成万能挡箭牌:判别依据是**独立探一次 registry 可达性**(不解析 bun 的报错措辞),
# 拿不准一律倒向「拦住」;而且脚本自己有两条判据钉着它 —— 非网络失败必须仍判 real(`[5/6]`)、
# 判别依据必须双向可分且网络档不报绿(`[6/6]`)。
bash scripts/assert-worktree-bootstrap.sh
worktree_bootstrap_rc=$?
case "$worktree_bootstrap_rc" in
0) echo "    ✓ worktree bootstrap" ;;
2) unverified=1 ;;  # 脚本自己打了「未验证」;不拦 push,但下面的总结行不许再说「全绿」
*) echo "    ✗ worktree bootstrap 失守 —— 新建 worktree 仍然只能去共享主 checkout 才能跑真 typecheck"; fail=1 ;;
esac
unset worktree_bootstrap_rc

echo "▶ [10/10] required contexts vs GitHub 分支保护真源 (#890)"
# 这一步在 alpha-ci 里**没有对应**,所以它不进 CI_STEPS(那张表是 CI 步骤的对照表)。
# 理由:读分支保护要带令牌,而 alpha-ci 触发在 `pull_request` —— fork PR 结构上拿不到
# secrets。有鉴权的地方是这台机器,所以这道门只能落在本地。放最后,因为它是九步真闸门跑完
# 之后的一次网络往返。
bash scripts/assert-required-contexts.sh
required_contexts_rc=$?
case "$required_contexts_rc" in
0) ;; # 脚本自己打了 ✓
2)
  # 未比对:没装 gh / 没登录 / 令牌无权 / 网络不通。刻意**不**判红 —— 这台机器到
  # api.github.com 走的代理会间歇失败,让它拦 push 只会逼出 `--no-verify`,那会连带关掉
  # 上面七道真闸门(本仓已经栽过这个形态)。代价是下面的总结行不许再说「全绿」。
  unverified=1
  ;;
*) fail=1 ;;
esac
unset required_contexts_rc

# ── 覆盖自陈(`#777`)──────────────────────────────────────────────────────────
# 「和 CI 1:1」以前是散文。现在这张表由脚本自己打出来,并由
# packages/ui-mac/src/main/local-gate-parity.test.ts 反向核对(CI 加了步而这里没登记即红)。
echo
echo "── 本脚本对 alpha-ci 的覆盖(${#CI_STEPS[@]}/${#CI_STEPS[@]} 个代码步)──────────────────────"
for row in "${CI_STEPS[@]}"; do
  printf '   %-14s %-58s %s\n' "${row%%|*}" "$(echo "$row" | cut -d'|' -f2)" "${row##*|}"
done
echo "   注:MIRRORED = 同一条命令;SUPERSET = 本地还多验了;DEGRADED = 降级,理由在同一行。"

echo
if [ "$fail" -ne 0 ]; then
  echo "❌ local gates failed — fix before pushing (alpha-ci would fail the same way)."
elif [ "$unverified" -ne 0 ]; then
  # `#890`:门都绿了,但**有一步这次没验成**(第 [9/10] 的 registry 不可达,或第 [10/10] 的
  # 分支保护真源读不到)。说「全绿」会把
  # 「没检查」读成「检查过了」—— 那正是这道门要消掉的形态,所以这里换一句话。
  echo "⚠️  local gates passed, but **有一步这次没验成**(见上面标了「未验证 / 未比对」的那一步)。"
  echo "    可以 push;但本次运行不构成那一步的证据 —— 第 [9/10] 未验证 = worktree bootstrap 能力"
  echo "    这次没被验证(registry 不可达);第 [10/10] 未比对 = 仓内记录与 alpha 分支保护是否一致没读到真源。"
else
  echo "✅ all local gates green — safe to push (alpha-ci will mirror this)."
fi
exit $fail
