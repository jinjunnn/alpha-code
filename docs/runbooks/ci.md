# CI 规范(alpha-code)

> 一句话:**本地先跑,CI 兜底**。CI 不是你第一次看到失败的地方——它是 merge 前的强制关卡。
> 权威触发定义在 `.github/workflows/alpha-ci.yml`;北极星守卫语义见 ADR-004,fork 纪律见 ADR-005。

## 0. TL;DR — push 前一条命令

```bash
bash scripts/alpha-check.sh
```

绿了再 push。它跑的是 `alpha-ci` 的**全部 16 个代码步**,并在末尾打印一张逐步对照表
(`MIRRORED` / `SUPERSET:<理由>` / `DEGRADED:<理由>`)。

> 再加一步 CI **结构上跑不了**的(`#890`,第 `[8/8]` 步):把 `.github/required-contexts.txt`
> 与 GitHub 分支保护里那份真的 required status checks 比一次。读分支保护要带令牌,而 alpha-ci
> 触发在 `pull_request` —— fork PR 拿不到 secrets,所以它只能落在有鉴权的开发机上。
> 这一步有**三档**结局:一致 / 漂移(红,点名差在哪条)/ **未比对**(没装 `gh`、没登录、
> 网络不通)。未比对不拦 push,但总结行会从 `✅ all local gates green` 换成一句明说
> 「本次未比对」的话 —— 把「没检查」读成「检查过了」正是这道门要消掉的东西。

> `#777` 起,「与 alpha-ci 1:1」不再是散文。2026-08-03 实读:此前这句话写在三处
> (本文件、`CLAUDE.md`、`scripts/alpha-check.sh` 抬头),而脚本实际只跑了 12 步里的 9 步 ——
> 缺 `assert-gate-files.sh`(登记闸门里 llm / core / opencode 那几个**只在这一步执行**)、
> 缺 `assert-seed-assets.sh`、缺 `check-doc-links.py`;而且三条测试用的是裸 `bun test`
> (跑 0 条照样 exit 0 —— CI 早在 `#647` 修掉的假绿形态,本地原样留着)。
> **「本地绿 ⇒ 可以合」这条铁律的全部依据就是这句 1:1**,所以它现在由
> `packages/ui-mac/src/main/local-gate-parity.test.ts` 双向核对:CI 加一步而对照表没登记即红,
> CI 改一个步骤名而对照表没跟也即红。

## 1. 为什么 local-first(优先本地跑)

- **快**:本地三关秒级;CI 往返一轮 = 排队 + 起机 + 装依赖 + 跑,分钟级。
- **省往返**:把 CI 当"第一次跑"= 每个错都要等一轮红了才知道 → 慢、烦、还堵别人的队。
- **CI 的真正职责**是①**强制门禁**(branch protection:不绿不让 merge,挡手滑)②**中立环境兜底**(抓"在我机器上是好的"那类环境差异)——不是给你当调试台用的。
- 所以顺序永远是:**本地 `alpha-check` 绿 → push → CI 复核 → merge**。

## 2. 八关是什么(逐步对照见 `alpha-check.sh` 的 `CI_STEPS`)

| 关 | 本地步骤 | CI job | 失败含义 |
|---|---|---|---|
| **北极星守卫**(零改上游) | `[1/8]` `scripts/north-star-guard.sh`;等价 `git diff --diff-filter=DMR --name-only origin/alpha...HEAD -- <上游 8 包>` 必须空 | `north-star guard (zero upstream edits)` | 改了上游文件 → 下次 fork-sync 冲突,破北极星 |
| **NUL 字节闸** | `[2/8]` `scripts/assert-no-nul-bytes.py` | 同上 job | 字面 NUL 让 `grep` 对整个文件静默失明(`#760`) |
| **typecheck**(三个 alpha 包) | `[3/8]` contracts-consumer + ext + ui-mac | `typecheck (alpha packages)` | 类型不过 |
| **契约锁 + 单元测试** | `[4/8]` `check:vendor` + `bun-test-floor.sh` × 3(15 / 100 / 3000) | `unit tests (alpha packages)` | vendored hash、producer/consumer fixture 或运行时守卫回归 |
| **闸门文件点名** | `[5/8]` `scripts/assert-gate-files.sh`(全量见 `scripts/gate-files.tsv`) | 同上 job | 某个闸门文件被删/被清空/条数偏离登记 —— 整包地板抓不到。`#844` 起逐条判**精确条数**(少=删了用例,多=新增未登记);改动闸门文件后跑 `bash scripts/assert-gate-files.sh --update` 从实测写回登记簿(all-or-nothing、幂等),例外语法与理由要求见 TSV 抬头或脚本 `--help` |
| **seed assets** | `[6/8]` `scripts/assert-seed-assets.sh` | `seed assets present` | 打包资源被静默删除(B7/B15) |
| **docs gate** | `[7/8]` `scripts/check-doc-links.py <改动的 md>` | `docs gate` | Markdown 相对链接断了 |
| **required contexts 对真源**(`#890`) | `[8/8]` `scripts/assert-required-contexts.sh` | **无 —— CI 结构上跑不了**(读分支保护要令牌,fork PR 拿不到 secrets) | 仓内 [`.github/required-contexts.txt`](../../.github/required-contexts.txt) 与 GitHub 分支保护里那份真的对不上:漏一条 ⇒ 那道检查其实不必需(红着也能合),而仓内测试全绿。三档结局:一致 / 漂移(红,点名差在哪条,含「分支保护被整个关掉」)/ **未比对**(没 `gh`、没登录、网络不通 —— 不拦 push,但总结行不再说「全绿」) |

- **上游包** = `packages/{opencode,core,server,tui,sdk,protocol,schema,client}`(**8 个**;`app`/`ui`
  已按 ADR-020 移出守卫,`protocol`/`schema`/`client` 按 ADR-033 补入)。这份清单与 ADR-033 收编
  白名单的**唯一真源**是 [`scripts/north-star-guard.sh`](../../scripts/north-star-guard.sh) ——
  CI 与本地 `alpha-check.sh` 调用的是同一份字节(`#889`;此前是两份内联副本靠 `local-gate-parity.test.ts`
  逐行比对维持,`#637` 咬过一次)。workflow 里再出现第二份副本即红,同样由该文件判。
- **比较基准 = `origin/alpha`**(`#889`)。这道门要回答的是「**这个 PR 自己**改了上游文件吗」,
  基准只能是它的目标分支(alpha-ci 的 `on: push/pull_request: branches: [alpha]`)。此前写死
  `origin/dev`(上游纯镜像):实测 2026-08-10 两条 ref 的 merge-base 停在 2026-07-23,窗口是
  550 commits / 2467 文件,窗口内点名的 47 个上游文件全靠 44 条收编白名单恰好吸收才没红 ——
  任何一次不在白名单里的合法上游改动,都会让这道门在**每个 PR** 上恒红(`#754` 那一类)。
  行为判据(造真的上游改动、跑守卫本体、断言它真的点名)在
  `packages/ui-mac/src/main/north-star-guard.test.ts`。
- **本地跑时看到 `(warn: could not fetch origin/alpha …)` 怎么读**(`#913`)。守卫开跑前那条
  `git fetch` 会间歇失败(实测约 3 次 1 次,手跑同一条命令 exit 0);失败时它降级用**本地上一次
  拿到的** `origin/alpha` 当基准继续跑。**这不是假绿** —— 陈旧基准只把比较窗口撑得更宽 ⇒ 过报,
  不漏报。紧跟着的那一行会告诉你这一跑到底量的是什么:
  `baseline: last-known origin/alpha @ <sha> — dated <日期> (<多久以前>); window origin/alpha..HEAD = <N> commits`。
  窗口越宽 = 越多与本分支无关的提交被算了进来;真要一个准的结论,`git fetch origin alpha` 成功后重跑。
  CI 不走这条路:`Ensure origin/alpha is available` 是裸 fetch,失败即 job 红。
- **bun 版本钉 `1.3.14`**(与 CI 一致,根 `package.json` 的 `packageManager`)。本机版本不同先对齐。
- 根 `bun test` 被故意禁用(`do not run tests from root`)——测试按包跑,别在根跑。
- Alpha Platform wire pin 不使用 `bun.lock`。`check:vendor` 要求
  `alpha-platform-contract.lock.json` 的 repo/commit/file set 与每个正式
  vendored 文件 SHA-256 一致；staged 源存在时还会逐文件与 staged bytes
  对比。固定命名测试 `contract lock resolves to the exact immutable
  alpha-platform commit` 与 `contract source lock matches vendored artifact
  hashes` 是 CI 证据。
- **`check:vendor` 在 CI 上跑的是「降级」档,而且它自己会说出来(#769)。**
  CI 是裸 checkout,兄弟仓 `../alpha-web` / `.upstream-*` 都不存在,所以
  「vendored 字节确实来自那个 commit」这一条**证不了**。以前那里是硬失败 ⇒
  `verify immutable Alpha contract vendor lock` 这一步**恒红**,红的理由与
  漂移无关。现在改成降级,并在 stdout 打出 `PROVENANCE NOT VERIFIED this run`
  (GitHub Actions 上另发一条 workflow 注解)。判读法:
  - 有 `verified N contract artifacts from <repo>@<sha>` = 三方比对成立
    (lock ↔ vendored 字节 ↔ 上游字节),只有开发机/pre-push 会到这一档;
  - 有 `PROVENANCE NOT VERIFIED this run` = 本次只验了本仓侧,commit 归属没验。
    **这是 CI 的常态,不是故障**;要真验 provenance 就在本机 `bun run --cwd
  packages/alpha-contracts-consumer check:vendor`(旁边有 `../alpha-web` checkout)。
  - 降级档仍然是一道**真闸**:除 lock ↔ vendored 字节外,还把 producer manifest
    的 35 条哈希锚在 `artifactSha256` 上 —— 那是**源码里的人工评审常量**,
    `vendor` 从不回写它,所以「拿错目录跑一次 vendor 把字节和 lock 一起改写」
    这种自洽伪造照样红。
- **写盘侧不降级**:`vendor`(重写 lock)缺兄弟仓仍硬失败。没有 provenance 就
  落盘一份自洽的 lock,等于给后续每一次 `--check` 发一张伪证。

## 3. GitHub 上只跑两个 workflow(其余上游的已禁用)

本仓是 opencode 的 fork,继承了 ~26 个上游 workflow。它们要上游订阅的 **Blacksmith 自建 runner**(如 `runs-on: blacksmith-4vcpu-ubuntu-2404`),本 fork 没有这种机器 → 一触发就永久 `queued` 挂死。**这是历史上"CI 一直卡 / 连不通"的真因**(不是 API、不是限流、不是 alpha-ci)。

2026-07-03 已 `gh workflow disable` 全部上游 workflow,**只保留**:

| workflow | 作用 | 触发 |
|---|---|---|
| **`alpha-ci`** | 本仓 CI(上面三关) | `push` / `pull_request` → `alpha`;也可 `workflow_dispatch` |
| **`sync-upstream`** | 每日上游 `dev → merge alpha` 同步 | 定时 + 手动 |

- **分支保护 required contexts —— 幽灵 context 已消,记录落在仓内**(`#717`,2026-08-10 复核)。
  `alpha` 保护当前要求四个 context,与真实 job 名逐条对得上:
  `north-star guard (zero upstream edits)` / `typecheck (alpha packages)` /
  `unit tests (alpha packages)` / `docs gate`。
  历史:那一格曾经写着 `unit tests (ui-mac)`,而 job 早在 2026-07-22(`ebd29cda`)就改名了 ⇒
  **没有任何 PR 会产出那个 context**,code PR 也不会 ⇒ 每个 PR 在那一格永久 pending ⇒ 每次合并都得
  `--admin`。**「大家习惯性 --admin」当时不是纪律松懈,是分支保护自己造出来的。**
  owner 已于 2026-08-03 直接改分支保护修掉那一半。
  `#717` 的票面把成因写成「docs-only path 没发布该 context」,与实测不符:改名是全量的。
  现在这份列表在仓内有一份手抄快照 [`.github/required-contexts.txt`](../../.github/required-contexts.txt),
  由 `packages/ui-mac/src/main/local-gate-parity.test.ts` 断言「记录里的每个 context 都等于某个 job 的
  `name:`」+「每个 job 要么在记录里、要么显式登记为不必需」。
- **手抄件与真源之间现在有判据了**(`#890`,2026-08-11)。上一条那两个断言只把手抄件与 workflow
  的 job 名对齐 —— 两边一起错就一起自洽,而真正决定「PR 能不能合」的那份清单在 GitHub 的分支保护
  设置里,此前没有任何东西比对它。现在 `alpha-check.sh` 第 `[8/8]` 步跑
  [`scripts/assert-required-contexts.sh`](../../scripts/assert-required-contexts.sh),
  把两者逐条比一次,不一致就点名差在哪条。**边界照旧诚实**:CI 里跑不了(fork PR 拿不到
  secrets),没鉴权的那次 push 也跑不了 —— 那时它报「未比对」而不是静默放行。
  两条实跑得出的事实(不是推断,也别按记忆改回去):
  ①问的是 `repos/<repo>/branches/alpha` 而**不是** `…/branches/alpha/protection` —— 后者在
  分支保护被整个**关掉**时回 HTTP 404,退出码与网络不通一样,最该变红的一刻反而报「未比对」;
  前者两种状态都回 200(保护关着时是 `enabled=false` + 零个 context ⇒ 当场红)。
  ②`--jq` 里那个 `?` 不能删:`.required_status_checks.contexts[]` 在字段为 null 时 jq 报
  `cannot iterate over: null` 并非零退出,同样把灾难态伪装成读不到。
- **必需检查不会因为 `detect` 失败而静默放行**(`#895`,2026-08-11 实测)。四个必需 job 都
  `needs: detect`;从前 `detect` 一红,它们被折成 `skipped`,而 **GitHub 把 `skipped` 当成
  「已满足」** ⇒ 四道闸门一道没跑,PR 照样可合(实测 `mergeStateStatus=UNSTABLE`)。现在它们带
  job 级 `if: ${{ !cancelled() }}`,并以
  [`scripts/assert-detect-classified.sh`](../../scripts/assert-detect-classified.sh) 开头 ——
  `detect` 的 `result` 不是 `success`、或它的 `outputs.code` 不是 `true`/`false`,这一格就红。
  **只加 `!cancelled()` 而不加这一步会更坏**:`code` 为空时每一步都判假,job 零工作量报
  **绿**(实测)。`seed assets present` 刻意不在此列 —— 它不是必需 context。
  测量与反例:[`docs/verification/2026-08-11-detect-failure-required-checks.md`](../verification/2026-08-11-detect-failure-required-checks.md)。
- 其它 workflow 一律**不影响 merge**(PR 上若看到别的 check = 历史残留,忽略)。
- **不要盲目 `gh workflow enable`** 上游那些——除非你真给 fork 接了对应 runner。要恢复某个:`gh workflow enable <name>.yml`(可逆,文件没删)。

## 4. 提交纪律

1. push 前 `bash scripts/alpha-check.sh` **必须绿**。
2. 需要新增能力 → 走 alpha 自有文件(`packages/ext`、`packages/ui-mac`)或接缝(tool/plugin/MCP/sidecar,ADR-002/005),**绝不改上游 7 包**(改了北极星守卫本地就红)。
3. 短命 `feat/*` / `fix/*` 分支 → PR → squash 合回 `alpha` → **合后即删分支**(ADR-005)。
4. 想把 local-first 变**强制** → 装 §6 的 pre-push 钩子。

## 5. CI 卡住了怎么办(排查手册)

1. **先分清谁卡**:`gh run list` 看是哪个 workflow。`alpha-ci` 卡 = 真问题;别的 = 已禁用的僵尸,忽略/取消。
2. **queued(排队) vs in_progress(在跑但慢)**:
   - 一直 `queued` = 等 runner(无匹配 runner / Actions 额度耗尽 / 并发上限);
   - `in_progress` 慢 = job 本身慢(装依赖 / 测试)——那才是 REQ-009 缓存优化的场景。
3. **命令**:`gh run cancel <id>` 取消 · `gh run watch <id>` 盯 · `gh run rerun <id>` 重跑 · `gh run list --workflow=alpha-ci.yml` 只看本仓 CI。
4. **别被堵**:本地八步已绿 = 代码没问题。`#717` 之前这里写着「required 里有一个永远不会上报的
   context,真急可 `--admin`」—— **那条已经过时,别再照它办**。四个 required context 现在都会产出
   结论(§3),`--admin` 回到「例外」而不是「结构性必需」。
   ⚠️ 「产出结论」这句话在 `#895` 之前是**半真的**:`detect changes` 一失败,四格产出的结论叫
   **`skipped`**,而 GitHub 把 `skipped` 记成「已满足」—— 2026-08-11 在 PR #908 上实测:四格全
   `skipped`、`mergeable=true`、`mergeStateStatus=UNSTABLE`(**可合**),一道闸门都没真跑。
   现在四个必需 job 带 job 级 `!cancelled()`,第一步跑
   [`scripts/assert-detect-classified.sh`](../../scripts/assert-detect-classified.sh):`detect`
   没给出可用分类时,**四格各自变红**,`mergeStateStatus=BLOCKED`。所以现在在这四格看到 red 的
   第一件事是往上看 `detect changes` —— 真因常常在那里。
   全部测量(含「只加 `!cancelled()` 会让四格从灰变**绿**」那条反例):
   [`docs/verification/2026-08-11-detect-failure-required-checks.md`](../verification/2026-08-11-detect-failure-required-checks.md)。
   **PR 还是卡着不动时先问这两个**:①`gh pr view <n> --json statusCheckRollup` 里是哪一格 pending /
   failure?②那一格是不是真的红了 —— 一个**落后于 alpha 的纯文档分支**曾经会被 `detect` 误判成
   有代码改动、跑全量、继承主线的红(`#717` 修的就是这个;现在走 merge-base 三点口径,行为闸在
   `packages/ui-mac/src/main/ci-diff-scope.test.ts`)。**真红就修,不要用 `--admin` 盖过去。**

## 6. pre-push 钩子 —— local-first 强制(2026-07-05 REQ-015 起默认开启)

`.githooks/pre-push` = 跑 `scripts/alpha-check.sh`(覆盖 alpha-ci 全部 16 个代码步 + 一步 CI 跑不了的
`#890` required contexts 对真源,末尾自陈对照表)。**默认开启**:`alpha-check.sh` 每次运行都会检查 `core.hooksPath`,只在偏离时重挂 `.githooks`；健康值不重写共享 `.git/config`。

`#815` 起,钩子会先保存当前工作树根,再按 `git rev-parse --local-env-vars` 的**Git 自有清单**
清掉全部 repository-local `GIT_*` 变量,最后才启动 `alpha-check`。这是被测对象完整性边界:
linked worktree 的 `git push` 会把 `GIT_DIR` 注入钩子,而它压过测试夹具的 cwd 与 `git -C`；不清理时,
夹具本想写临时仓的空提交、`Test <test@opencode.test>` 与 `core.bare` 会落进正在推送的分支和
所有 worktree 共享的 `.git/config`。清单不手写,因为 Git 新增一个 repository-local 变量时枚举会
默认放行。`pre-push-git-env.test.ts` 在隔离的 linked worktree 里真 push 五次,并复用生产
`alpha-check` 的自愈块,同时钉住反向污染与 shipped hook 的 HEAD/config 文件身份零变化。

为什么不能用上游 husky 门(此前「配置过又失效」的根因,REQ-015):
- `.husky/pre-push` 跑**全量** `bun turbo typecheck`,在 ADR-020 冻结偏斜下 `session-ui` 恒红(上游叶子包,alpha 不 ship,权威门 alpha-ci 不含)→ 逼出 `--no-verify` 习惯;
- husky 的 `prepare` 在每次 `bun install` 后把 `core.hooksPath` 重置回 `.husky/_` → 手动 `git config` 一次性开启会被静默冲掉。alpha-check 的自愈重挂即对策;残余窗口(install 后、首次 alpha-check 前直接 push)会撞上游红门 → 跑一次 alpha-check 即恢复,**永不劣于旧状**。

```bash
# 逃生:
git push --no-verify                                # 单次绕过
git config --unset core.hooksPath                   # 关闭(需配合 export ALPHA_HOOKS_DISABLE=1,否则下次 alpha-check 重挂)
```
