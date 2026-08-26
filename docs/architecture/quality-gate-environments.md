# 质量门 × 运行环境 —— 每道门在每个环境里的真实状态

> 勘破文档(`#777`)。这里写的每一格都是**跑出来的**,不是推断的;跑不出来的格子写「未测量」,
> 不写猜测。measurement 日期 2026-08-03,基线 `alpha@10daf61b`。
>
> 存在理由:一道**恒红**的门等于没有门 —— 大家会习惯性 `--no-verify` / `--admin`,真出问题时也没人看。
> 一道**假绿**的门更糟 —— 它主动告诉你「没事」。本仓在半个月里撞上同一形态四次
> (`#754` / `#769` / 本票原列的 `alpha-check` typecheck / 2026-08-02 起主线连红两天),
> 所以这里不再逐个修,而是把整类列出来并在咽喉点收口。

## 1. 这一类的共同前提

四个实例长得都不一样,共同前提只有一句:

> **门在运行时依赖某个环境事实,而这个事实从没有被任何地方声明过,于是没人能检查它对不对。**

| 实例 | 门 | 隐含的环境前提 | 前提不成立时发生什么 |
| --- | --- | --- | --- |
| `#754` | 本地 pre-push | 「`git -C` 决定跨仓 git 的仓库」 | `git push` 注入的 `GIT_DIR` 压过它 ⇒ **任何 push 恒红** ⇒ 人人 `--no-verify` |
| `#769` | CI 的 vendor lock 闸 | 「兄弟仓 `../alpha-web` 在」 | 裸 checkout 没有 ⇒ **CI 上恒红**,红的理由与它要验的漂移无关 |
| `#777`-A | `bun test` 的 31 条 host 用例 | 「机器快到 5 秒内能跑完一整套子 suite」 | 慢一点就超时 ⇒ 红,而红的理由与被验的行为无关 |
| `#777`-B | 生产安装闸的组件测试 | 「跑在本产品发布的平台上」 | ubuntu runner ⇒ 写盘前直接拒 ⇒ 门跑不起来 |
| `#916` | 本地 `alpha-check` 的 typecheck / 测试 | 「跑门的这棵树装着依赖」 | 全新 worktree 一个 `node_modules` 都没有 ⇒ **11627 条假红** ⇒ 唯一出路是去动**共享**主 checkout ⇒ 并行 lane 互相污染彼此的门测量 |

**咽喉的形状因此是确定的:让门的环境需求变成一处显式声明,新增的门默认拿到它,缺失时显式降级并自陈。**
枚举对新成员默认放行,咽喉对新成员默认拒绝 —— 优先咽喉。

## 2. 枚举方法(两条互相独立的检索轴)

单跑一个正则会给假的「没有」,所以每一类都用两条轴交叉:

| 枚举对象 | 轴 1 | 轴 2 | 结果一致? |
| --- | --- | --- | --- |
| CI 的代码步 | `.github/workflows/alpha-ci.yml` 里带 `run:` 的具名步骤 | `scripts/alpha-check.sh` 的 `CI_STEPS` 对照表 | 是(12 = 12,由 `local-gate-parity.test.ts` 持续判) |
| 子进程 host 测试 | `grep -ran -l "process.execPath" src` | `grep -ran -l "Bun.spawnSync" src` | 一致到 31 个文件 |
| host 的超时声明 | `grep -c "timeout"`(逐文件) | `grep -oE "\}, *[0-9_]+\)"`(数字第三参形态) | **否 —— 轴 1 漏了 6 个文件**。数字形态 `}, 180_000)` 不含 "timeout" 这个词 |
| 超时声明的**粒度** | 逐文件 | 逐 `test(...)` 声明 | **否 —— 逐文件会数错**。一个文件里可以既有带声明的又有不带的 |
| 上游守卫白名单 | `alpha-ci.yml` 的 `':(exclude)…'` | `alpha-check.sh` 的 `UPSTREAM_EXCLUDES` | 是(24 = 24,逐条同序) |
| alpha 自有的 opencode 测试 | 文件名 `alpha-*.test.ts` | `git cat-file -e origin/dev:<path>` 失败者 | 是(各 5 个,同一组) |

轴 1 与轴 2 在第三、四行**给出了不同答案**,而只跑轴 1 会得出「31 条 host 全都没声明超时」这个错结论 ——
这正是「观测手段自己有盲区」。`grep` 一律带 `-a`(字面 NUL 会让它对整个文件静默返回空,`#760`)。

## 3. 门 × 环境:真实状态表

环境有四个:**alpha-ci(ubuntu runner)** / **本地 `alpha-check.sh`(开发机 macOS)** /
**本地 pre-push 钩子**(= 同一个脚本)/ **开发者手跑 `bun test`**。

### 3.1 CI 的 12 个代码步(`#777` 当时的普查)

> 数字已变:`#895` 给四个必需 job 各加了一步 `Assert detect classified this diff`,
> 现在是 16 步(`scripts/alpha-check.sh` 的 `CI_STEPS` 是权威,它自己会打出来)。下表刻意保留
> `#777` 当时的 12 行 —— 它讲的是「修前/修后」那段历史,不是今天的清单。

| # | job | 步骤 | alpha-ci | alpha-check(修前) | alpha-check(修后) |
| --- | --- | --- | --- | --- | --- |
| 1 | upstream-guard | No literal NUL bytes | 真结果 | 有 | 有 |
| 2 | upstream-guard | Fail on any modification to upstream package files | 真结果 | 有(且是超集:含未提交改动) | 同 |
| 3 | typecheck | contracts-consumer | 真结果 exit 0 | 有 | 有 |
| 4 | typecheck | ext | 真结果 exit 0 | 有 | 有 |
| 5 | typecheck | ui-mac | 真结果 exit 0 | 有 | 有 |
| 6 | test | verify immutable Alpha contract vendor lock | **降级档**,自陈 `PROVENANCE NOT VERIFIED this run`(`#769`) | 有(开发机有兄弟仓 ⇒ 已验档,是超集) | 同 |
| 7 | test | bun test (contracts consumer fixtures) 下界 15 | 真结果 | **降级**:裸 `bun test`,无下界 | 走 `bun-test-floor.sh 15` |
| 8 | test | bun test (ext) 下界 100 | 真结果 | **降级**:同上 | 走 `bun-test-floor.sh 100` |
| 9 | test | bun test (ui-mac) 下界 3000 | **红**(见 §3.2) | **降级**:同上 | 走 `bun-test-floor.sh 3000` |
| 10 | test | assert gate files(77 个) | **连续两天 skipped**(见 §3.3) | **完全没有** | 有 |
| 11 | seed-assets | Assert seed/vendored resources present | 真结果 | **完全没有** | 有 |
| 12 | docs-gate | Relative-link validity in changed Markdown | 真结果 | **完全没有** | 有 |

修前 = 12 步里跑了 9 步,其中 3 步是降级档 ⇒ **忠实镜像的只有 6 步**,而三处文档都写着「1:1」。

第 7/8/9 行的「降级」不是少验一点,是**闸门消失时全绿**。实测三种「跑了 0 条」的形态
(bun 1.3.14,`#777` 当场逐个跑的,不是转述):

| 形态 | 裸 `bun test` 的 exit | `bun-test-floor.sh` |
| --- | --- | --- |
| 文件在,但用例被清空 / 被条件注册成零条 | **0 —— 假绿** | 1(`只跑了 0 条断言,低于下界 N`) |
| 指定的测试文件不存在 | 1 | 1 |
| 整个目录零匹配 | 1 | 1 |

> 顺带更正一条仓内既有说法:`alpha-ci.yml` / `bun-test-floor.sh` 的注释把「指定的测试文件
> 根本不存在」也列进了「exit 0」那一档 —— 在 bun 1.3.14 上它 exit 1。**真正的假绿只有第一行**,
> 而第一行恰好正是「有人把闸门文件清空 / 把用例条件掉」的形状,所以下界该立还是要立。
> (这属于 `#777` 范围外的注释更正,本 PR 不动那两处文字,记在这里。)

### 3.2 `bun test (ui-mac)` 在 CI 上为什么红 —— 四条,全是环境不是缺陷

`alpha` 主线自 2026-08-02 起,凡带代码的 run 无一例外全红(实测 8 个 run id:
`30779269408` / `30754009329` / `30750696800` / `30745161428` / `30742164690` / `30739936324` /
`30739675979` / `30731715823`;只有纯文档 commit 因整体跳过而绿)。
同一棵树在开发机上:**3756 pass / 0 fail / Ran 3756 tests across 255 files**。

| 失败用例 | CI 上的真实报错 | 真因 | 属于哪个子形态 |
| --- | --- | --- | --- |
| `生产 ext-import-skill-folder 分流到本地插件预览…` | `TypeError: this.electron.ipcMain?.on is not a function` @ `electron-log/src/main/index.js:16` | 测试的 electron 桩缺 `ipcMain.on`,而 `electron-log` 在**模块顶层**就调它。开发机上 `electron` 这个 specifier 没落到桩上,CI 上落了 ⇒ **只在 CI 发作** | 依赖解析 |
| `真实 ext-install-catalog 返回值只含公开状态且不回显 canary` | `expected authorization pause, got {"ok":false,"reason":"platform linux not supported by this entry — refusing before any disk write"}` | 生产 `synthesizeManifest` 把 `compatibility.platforms` 写死 `["darwin","win32"]`(ADR-026);runner 是 ubuntu | 平台 |
| `默认关的真实 catalog MCP:提前返回分支…` | 同上 | 同上 | 平台 |
| `package safe view and admission traverse the production ExtensionHub…` | `[5035.75ms] ^ this test timed out after 5000ms` | host 没声明超时,拿 bun 默认 5s 去等一整套子 suite | 时长 |
| `REQ-128 Phase 3 第 1→9 跳…`(内含两条子用例) | `[5933.51ms]` / `[6447.61ms]` `^ timed out after 5000ms` | 同上,发生在**子进程内部** | 时长 |

`?.` 只挡 `ipcMain` 为空,挡不住 `ipcMain` 在而 `.on` 缺 —— 后者照样是 TypeError。
桩的补法是照 `node_modules` 里**装着的那个** `electron-log@5.4.4` 的
`src/main/ElectronExternalApi.js` 逐条枚举出来的(`app.{isReady,isPackaged,name,getName,getVersion,getPath,on,once,off}`、
`ipcMain.{on,handle}`、`dialog.showErrorBox`、`shell.openExternal`、`session.defaultSession`、
`webContents.getAllWebContents`、`BrowserWindow.getAllWindows`),不是凭记忆补的。

### 3.3 连带伤害:一步红,77 道门一起消失

失败发生在 `test` job 的第 9 步,而第 10 步 `assert gate files` 的条件是 GitHub 的默认
`success()` ⇒ **skipped**。登记簿里 77 个闸门中,`packages/llm` 1 个、`packages/core` 1 个、
`packages/opencode` 2 个**只在这一步执行**,别处再没有第二次机会。
即:「主线红」这一件坏事,自动升级成「主线红 + 77 道门连续两天一次都没跑」两件。
修法:`if: ${{ !cancelled() && … }}`(不用 `always()`,`cancel-in-progress` 取消的 run 不必再跑)。

### 3.4 子进程 host 测试的超时声明(基线实测:31 个文件 / 31 条)

粒度是**每条 `test(...)` 声明**,不是每个文件 —— 一个文件里可以既有带声明的又有不带的
(`package-admission.wiring.test.ts` 一个文件三条)。按文件数会数错。

| 声明 | 条数 | 结论 |
| --- | --- | --- |
| 显式 `120_000` | 6 | 有人在自己那格踩过坑,补了自己那一个 |
| 显式 `180_000` | 5 | 同上 |
| 显式 `300_000` | 1 | 同上 |
| **bun 默认 5000ms** | **19** | 从没声明过 —— CI 上已炸掉 2 条,其余 17 条是同一批潜伏成员 |

`local-package-renderer.test.ts` 的抬头甚至已经写着「bun 默认 5s 会把它变成一条**间歇性**红 ——
而间歇红比没有闸更贵」。**同一条规律只被应用了一次**,与 `#647` 当年「只给 ui-mac 加点名下界、
漏了 ext」是同一个错。这就是为什么本票要求整类收口。

### 3.5 分支保护 —— 这一类里最贵的一格(`#717` 已闭合)

2026-08-10 实读 `gh api repos/jinjunnn/alpha-code/branches/alpha/protection`,四条逐条对得上:

| 读者 | 要求的 context | 写者 | 实际产出的 job 名 | 对得上? |
| --- | --- | --- | --- | --- |
| `alpha` 分支保护 | `north-star guard (zero upstream edits)` | alpha-ci | 同名 | 是 |
| | `typecheck (alpha packages)` | | 同名 | 是 |
| | `unit tests (alpha packages)` | | 同名 | 是(曾经写着 `unit tests (ui-mac)`) |
| | `docs gate` | | 同名 | 是 |

**这一格当年怎么坏的**:job 名在 2026-07-22(`ebd29cda`)改掉,分支保护没跟。实测 PR `#802` / `#791`
的 `statusCheckRollup` 里**根本没有** `unit tests (ui-mac)` 这一项 —— 不是 docs-only 才缺,是**每个
PR 都缺**。于是每个 PR 在那一格永久 pending ⇒ 每次合并都得 `--admin` ⇒ 主线真红时也没有任何东西
挡住任何人。**「大家习惯性 --admin」不是纪律松懈,是分支保护自己造出来的。**
owner 已于 2026-08-03 直接改分支保护补上(`#717` 评论里有回滚值)。

**这个值的数据模型问题(`#717` 收的口)**:它同时活在**仓外的 GitHub 分支保护**与**仓内 alpha-ci.yml
的 job `name:`** 两处,而两处都没声明自己是真源,也没有任何东西比对它们 —— 所以 `ebd29cda` 改名当天
无一处变红。现在仓内有一份手抄快照 [`.github/required-contexts.txt`](../../.github/required-contexts.txt),
`packages/ui-mac/src/main/local-gate-parity.test.ts` 两条断言把它接上:记录里的每个 context 必须等于
某个 job 的 `name:`;每个 job 要么在记录里、要么在 `NOT_REQUIRED_JOBS` 里写明为什么不必需(新 job 默认拒)。

⚠️ **诚实边界,别写成「已防漂」**:真源在仓外,CI 结构上够不着它(本仓 public、读分支保护要令牌,而
workflow 触发在 `pull_request`,fork PR 拿不到 secrets)。这份记录**抓得住** workflow 侧改名/删 job
(即 `ebd29cda` 那一类,真正咬过我们的那一类),**抓不住**「只改 GitHub 设置」,更抓不住「两侧一起
改错」—— 那时它与 workflow 自洽,测试照绿。这是减速带,不是闸门;核对真源仍是人的动作。

`#717` 票面把成因写成「docs-only path 没发布该 context」,与实测不符 —— 改名是全量的。票剩下的另一半
(`pull_request` 上的 diff 基准)见 §3.7。

### 3.6 无人执行的门

| 门 | 谁跑它 | 状态 |
| --- | --- | --- |
| `packages/opencode/test/tool/alpha-websearch-failure.test.ts` | 只有 `assert-gate-files.sh` | 登记在册;`#777` 之前该步在 CI 上连续两天 skipped、本地根本没有 |
| `packages/opencode/test/permission/alpha-ask-deadline.test.ts` | 同上 | 同上 |
| `packages/opencode/test/tool/alpha-mcp-websearch-gate.test.ts` | **无** | `#649` 未决(本地 23.45s,且打印 `Bun.serve` 10 秒超时告警) |
| `packages/opencode/test/mcp/alpha-cloud-mcp-multisource.test.ts` | **无** | `#649` 未决 |
| `packages/opencode/test/mcp/alpha-cloud-mcp-revival.test.ts` | **无** | `#649` 未决 |

`#649` 是本类的**极端成员**:门假设的环境是「某个 CI」,而那个环境**不存在**。
本票不处置它(逐份取舍要付 CI 时间的账,归 `#649`),但把它归类记在这里。

### 3.7 `detect` 的 diff 基准 —— 决定「今天哪些门跑」的那一格(`#717`)

本节记的是**同一类里的上游**:3.1~3.6 讲的是某道门在某个环境里真不真;这一格讲的是
**这些门今天到底跑不跑**。alpha-ci 里 upstream-guard / typecheck / test / seed-assets 的
**全部**步骤都挂在 `needs.detect.outputs.code == 'true'` 上,docs gate 的入参就是 `detect` 输出的
`md`。**一个布尔值算错,当天所有门的开关就一起错。**

坏在哪(`#717` 剩下的那一半):`pull_request` 事件上用的是**两点** diff `base..head`,而
`github.event.pull_request.base.sha` 给的是**当下 alpha 的 tip**,不是分叉点。于是一个落后于 alpha
的纯文档分支,会把别人已经合进 alpha 的代码算成自己的改动 ⇒ `code=true` ⇒ 跑全量 ⇒ 继承主线的红,
而这个 PR 里一行代码都没有。实证(`#717` owner 评论):同一个 commit,PR run `30756424959` 判
`code=true` 并红在 `bun test (ui-mac)`,push run `30756431539` 判 `code=false`、全部 skipped。
**同一个 workflow 里的 north-star 守卫用的一直是三点 `origin/dev...HEAD`** —— 两者本来就不一致。
(`#889` 已把守卫基准改成 `origin/alpha`,见 §3.8;`detect` 这一格不变。)

| 事件 | 基准 | 口径 | 为什么 |
| --- | --- | --- | --- |
| `pull_request` | `merge-base(base.sha, head.sha)` → `head.sha` | 三点 | `base.sha` 是移动中的 tip,只有分叉点才回答「这个 PR 自己改了什么」 |
| `push` | `before` → `sha` | **两点(不动)** | 这对 SHA 本来就是同一条线上的前后两点,语义是「这次 push 推进了什么」,没有分叉可言 |
| 空 base / base 不可达 | 空树,分类照跑 | — | 「这次推进了什么」无从谈起,拿空树把文件列表收全 |
| 无共同祖先 | 空树,**且结论直接钉成 `code=true`** | — | fail-closed:一切都算改动 ⇒ 跑全量。反向(算成 docs-only)= 在看不懂的形状上把所有门关掉 |

**`#897` 修的正是这最后一行:fail-closed 说的是结论,不是基准。** `#717` 只做了换基准那一半 ——
把 base 换成空树,只保证**文件列表**是 HEAD 的全部,不保证**结论**是 `code=true`;分类器随后照跑
同一套规则,于是一条**纯文档的 orphan 分支**仍然得到 `code=false`,二十多道挂在 `code == 'true'`
上的门在一个我们看不懂的形状上被集体关掉,而 job 报绿。脚本当时同时打印 `everything counts as
changed` 与 `code=false`,自相矛盾。上面那条判据此前也测不出这件事:`git checkout --orphan`
**只换 HEAD,不动索引与工作树**,夹具残留的 `.ts` 让用例拿到 `code=true` —— 它验的是残留文件,
不是 fail-closed(清树后在修复前的实现上当场红)。
**倒数第二行(空 base / base 不可达)刻意不动**:那是另一个条件,且本仓 HEAD 恒含 `.ts`,
走不到「全量文件列表却分类成 docs-only」这个状态。

逻辑因此从 workflow 的内联 shell 搬进 [`scripts/detect-changed-scope.sh`](../../scripts/detect-changed-scope.sh)。
**唯一的理由是让它有判据** —— 内联时它一个判据都没有,而断言 YAML 文本按本仓定义是假闸门。
行为闸 `packages/ui-mac/src/main/ci-diff-scope.test.ts` 起真 git 仓、造真的「落后于 base 的纯文档
分支」、跑生产脚本本体,断言它写进 `$GITHUB_OUTPUT` 的实际值;八条各钉一个方向(含「分支自己改代码
必须 `code=true`」——否则「永远返回 false」也能满足这道门)。workflow 那一步的 `name:` 与 `env:`
一个字没改,所以 §3.1 的 CI_STEPS 对照表不受影响。

#### 3.7.1 同一格的另一半:**谁算代码**

上面那张表管的是「拿哪两个点做 diff」。分类器还有第二个决定 —— 拿到文件列表之后,**哪些文件算
代码**。这一半原来有两个绕过口,都能让真实的代码变更被判成 docs-only ⇒ 二十多个挂在
`code == 'true'` 上的步骤集体跳过 ⇒ **假绿**。两个都是实测复现,不是推演:

| 绕过口 | 原来的行为 | 实测事实 | 修法 |
| --- | --- | --- | --- |
| 路径**中间段**的 `docs/` | 分类分支写的是 `*/docs/*`,而 `*` 吃 `/` ⇒ 匹配路径里**任何位置**的 `docs/` 段 | 本仓真实存在 `packages/console/app/src/routes/docs/index.ts` 与 `.../docs/[...path].ts` —— 无歧义的 TypeScript 源码;仓内 `/docs/` 段下的非 `.md` 文件共 639 个 | 拆成两条都不含通配中间段的判定:**① 源码扩展名**(`.ts .tsx .js .jsx .mjs .cjs .sh`)住在哪都算代码;**② 文档树只认仓根锚定的显式前缀**(`docs/` `.claude/rules/` `knowledge/`) |
| 跨分类 **rename** | `git diff --name-only` | git 默认开着 rename 检测(`diff.renames` 默认 true)⇒ 一次重命名**只输出目标路径**,源路径一个字都不出现(git 2.50.1 实测) | 加 `--no-renames`:重命名重新变回「删源 + 加目标」两条路径,两端都参与分类 |

①的**代价是显式的**:`packages/docs/**` 与 `packages/web/src/content/docs/**` 的 `.mdx`(13 + 614 =
627 个文件)不再算文档,改它们会跑全量 CI。这是保守的一侧(多跑闸门,永远不会少跑);要豁免,请加一条
仓根锚定的显式前缀,不要把通配中间段放回去。同理,`docs/**` 下的 43 个 `.ts`/`.tsx`/`.mjs`/`.sh`
(验证与审计的 harness)从此算代码 —— 分类器无法区分 `docs/verification/x/probe.ts` 与
`packages/console/.../docs/index.ts`,唯一稳的规则是「源码扩展名一律算代码」。

判据各自独立可证伪:①用 `.ts` + 同目录 `.css` 两个输入(`.ts` 被两半同时覆盖,`.css` 只被显式前缀
那一半覆盖);②的 rename 目标刻意取 `.md`(修好后目标路径**仍**算文档,于是这条只由 `--no-renames`
决定)。两条各自单独还原,对应用例当场转红。

### 3.8 north-star 守卫的比较基准 —— 「相对**谁**」的那一格(`#889`)

§3.7 讲的是「今天哪些门跑」;这一格讲的是**一道门在拿什么当参照物**。north-star 守卫问的是
「这个 PR 改了上游文件吗」,而它此前把参照物写死成 `origin/dev`(上游纯镜像分支)——
一个与「这个 PR 的目标分支」无关的字面常量。

实测(2026-08-10,`origin/dev` 与 `origin/alpha`):

| 量 | 值 |
| --- | --- |
| merge-base | `347510a73`(2026-07-23) |
| alpha 领先 / dev 领先 | 289 / 261(dev 今天仍在动) |
| `origin/dev...HEAD` 的窗口 | **550 commits / 2467 文件** |
| 该窗口点名的上游文件(不应用 excludes) | **47** |
| 该窗口点名的上游文件(应用 44 条 `UPSTREAM_EXCLUDES`) | **0** |
| `origin/alpha...HEAD` 同口径 | **0** |

**所以两种基准今天结论相同,守卫没有在给错答案。** 缺陷是形态,不是当天的输出:

1. `origin/dev...HEAD` 是 `origin/alpha...HEAD` 的**超集窗口** ⇒ 不会漏报真违规,但会**过报**;
2. 它今天绿,只是因为那 44 条 exclude(本意是登记**有意的收编**)恰好吸收了三周的无关漂移;
3. ⇒ **任何一次不在 exclude 表里的合法上游改动,都会让守卫在每个 PR 上恒红**,包括没碰它的 PR。
   守卫脚本自己写着「Drift here is worse than no gate: a permanently-red local guard trains you
   to ignore it」,而 `#754`(pre-push 恒假红 ⇒ 第一道门实际关着)已经演过一遍。

修法两条,都在收窄「这个值有几个家」:

- **基准 = 这个 workflow 服务的那条分支**(`on: push/pull_request: branches: [alpha]`)。
  防漂断言的锚点取 workflow 自己的触发分支,不是把两个可以一起改错的值互相比对(自指等价链)。
- **守卫本体搬进 [`scripts/north-star-guard.sh`](../../scripts/north-star-guard.sh)**,CI 与本地
  `alpha-check.sh` 跑**同一份字节**。此前 `UPSTREAM_PATHS` + 44 条收编白名单在两处各有一份内联
  副本,靠 `local-gate-parity.test.ts` 逐行比对维持(`#637` 咬过一次:ADR-033 落地只同步了 paths、
  白名单漏了 ⇒ 干净 alpha 上本地恒假红、人人 `--no-verify`)。**枚举比对对新成员默认放行**,
  共用一份让那一类漂移在结构上不存在;防漂断言随之改成「workflow 必须调用它,且不得留第二份副本」。

行为判据在 [`packages/ui-mac/src/main/north-star-guard.test.ts`](../../packages/ui-mac/src/main/north-star-guard.test.ts)
—— 与 §3.7 同一条纪律:起真 git 仓、造真的上游改动、跑**生产脚本本体**,断言它**真的点名了那个文件**。
断言脚本源码文本按本仓定义是假闸门(守卫被整段注释掉时照样绿)。其中基准那一条自带**控制组**:
同一条用例里把生产脚本复制一份、只把基准换成 `origin/dev` 跑一遍,先证明夹具测得出已知的坏 ——
否则「守卫没点名它」会空对空地绿。

顺带修掉一个**本地独有的 fail-open**:原来是 `git diff … origin/dev…HEAD … 2>/dev/null || true`,
基准 ref 取不到时 git 报错被吞、`|| true` 把它变成空串 ⇒「已提交改动」那半边守卫**静默消失**而这一步
报 ✓。现在取不到基准当场红并说「本次守卫作废(不是通过)」。

#### 3.8.1 fetch 失败时的降级 —— 「基准取到没取到」也必须说出来(`#913`)

上面那一格定的是「基准该是**谁**」。这一格是它的续:**基准取回来了吗,取到的那一份有多旧。**

守卫开跑前的 `git fetch --no-tags origin alpha` **间歇失败**(实测两个独立来源:`#889` 实现方
约 3 次 1 次、主 session 复验时 3 次撞到 1 次,手跑同一条命令 exit 0 —— 与 CLAUDE.md 记的
`api.github.com` 代理抖动同形)。失败时守卫**按设计降级**:用本地上一次拿到的 `origin/alpha`
当基准继续跑。

**这不是假绿**,方向是安全的:陈旧基准 ⇒ 比较窗口更宽 ⇒ 过报,不会漏报真违规(与 §3.8 里
`origin/dev` 那个超集窗口同理)。坏的是**可见性**:

- 那行 `(warn: could not fetch …)` 混在一整屏门输出里极易被略过;
- 陈旧到什么程度原来没有任何提示 —— **落后 1 个提交和落后 3 周,输出长得一模一样**;
- ⇒「守卫今天绿」这句话的含义,取决于一个没人看得见的量。

修法是让「我量的是什么」出现在输出里 —— 降级时多报一行基准的**身份与年龄**:

```
    (warn: could not fetch origin/alpha — comparing against last-known origin/alpha)
      baseline: last-known origin/alpha @ 41c5f4b — dated 2026-06-27 (6 weeks ago); window origin/alpha..HEAD = 3 commits
```

报的三个量**只能是本地可知的**:fetch 都失败了,真实远端领先多少条无从得知,所以这里是
基准提交自己的 sha / 日期,加上 `origin/alpha..HEAD` 的条数(= 比较窗口有多宽,也就是过报的量)——
**不是**「落后远端 N 条」。

- **CI 不走这条路**:`alpha-ci.yml` 的 `Ensure origin/alpha is available` 是一条裸 `git fetch`,
  失败即 job 红。降级只属于本地档。
- **本票只做可见性,不加阈值**(「超过 N 条就转红」是独立判断:先让它可见,再谈要不要拦)。
- 判据在 `north-star-guard.test.ts` 的三条:造「fetch 拿不到 + last-known 陈旧」的树,断言基准
  sha 与陈旧程度读得出**且跟着树变**(同一条用例跑两棵陈旧程度不同的树作控制组 —— 只断一棵树
  时「印一句写死的年龄」也能全绿);fetch 正常时这一段**不许出现**(缺这条,「无条件永远打印」
  能满足前者);降级路径**仍然把门跑完**(陈旧基准下改上游文件依然红且点名 —— 降级是降级,
  不是弃权)。

**本票不改的一条边界(明写,不是漏网)**:`--diff-filter=DMR` **不含 `A`** ⇒ 在上游路径下**新增**
文件不被守卫点名。这是有意的 —— fork-sync 冲突来自 M/D/R,而 ADR-035 与 ADR-038 都明写依赖它
(「新增闸门文件落 alpha 自有的 `alpha-*.test.ts`,新增文件不触发 `--diff-filter=DMR`,无需 exclude」)。
`north-star-guard.test.ts` 把这句散文变成判据:有人顺手加上 `A`,那两条 ADR 的前提当场失效并变红。
代价也明写:上游包内**新增**一个 alpha 文件不受守卫管,靠 review 与 ADR 纪律拦。

### 3.9 跑门的那棵树装没装依赖 —— worktree 这一格(`#916`)

> 实测 2026-08-11,基线 `alpha@510f50ff5`,本机 macOS / bun 1.3.14。

前八格问的都是「门在什么环境里跑」;这一格问的是**门跑在哪棵树上**,而答案曾经只能是
「共享主 checkout」——于是**两条并行 lane 会量到彼此的树**。

| 树 | `bun run --cwd packages/ui-mac typecheck` | 耗时 |
|---|---|---|
| 主 checkout(装着依赖) | exit 0 / 0 条 | 3.0s |
| 全新 worktree,`node_modules` 一个都没有 | exit 2 / **11627 条 `error TS`**(TS2307 1462 条),首条 `Cannot find module 'bun:test'` | 0.5s |
| 同一棵 worktree,把主 checkout 的 **29** 个 `node_modules` 逐个软链过去 | exit 2 / **8694 条** —— 降了,**仍然不可用** | — |
| 同一棵 worktree,`bun install`(4694 packages / 9.5s) | **exit 0 / 0 条** | 3.0s |

三条只有跑过才说得出来的事实:

1. **逐包软链结构性地修不好。** bun 是隔离式布局,真包在**根** `node_modules/.bun/` 下
   (`ghostty-web` 住在 `node_modules/.bun/ghostty-web@github+…/node_modules/ghostty-web`),
   各包 `node_modules` 里放的只是指进 store 的链。软链重建不出这张图 —— 这也是为什么
   「补齐各包软链」这条写在票面和外部笔记里的修法是**错的**,证伪它只需要跑一次。
2. **软链还会反向污染。** `packages/{app,desktop,ui-mac}/tsconfig.json` 的 `outDir` 是
   `node_modules/.ts-dist`;`node_modules` 一旦链向主 checkout,每条 lane 的 typecheck 就都往
   **共享树**写构建产物 —— 要消灭的交叉污染换了个地方发生。
3. **没装依赖的 worktree 会借用共享树的工具链,而且不吭声。** `.worktrees/` 在主 checkout
   **内部**,`bun run` 逐级往上找 `node_modules/.bin` ⇒ 未装依赖的 worktree 照样跑得起 `tsgo`,
   借的是主 checkout 那一份。报出来的是 `Cannot find module` 而不是 `command not found`,
   于是**看起来像代码坏了**。这是本文件反复讲的那件事:观测手段自己有盲区。

**这道门自己也踩在同一类前提上(`#916` R2)**:它靠 `bun install`,而 `bun install` **依赖网络** ——
实测把 registry 指向不可达地址,**连已经装好的树**也会 `failed to resolve` / exit 1(3s)。
一道每次 push 都跑、网络一抖就恒红的门,正是本文件开头那句「恒红的门等于没有门」。
所以它取 `#890` 的三档形状:0 已验证 / 1 真失守(拦住)/ **2 本次未验证**(不拦 push,但**不报绿**)。
豁免的判别依据是**独立于失败本身的环境事实** —— 单独探一次 registry 可达性(`curl`,**不用 bun**:
`[5/6]` 的注入就是「没有 bun」),拿不准一律倒向拦住;并且判别依据自己被两条判据钉着
(非网络失败必须仍判 `real`、判别依据必须双向可分且网络档不报绿),否则「一律算网络」
会让这道门**永不失守** = 假门。分辨「判别依据坏了」与「机器真离线」用的是一条**独立**探针,
不是判别依据自己的答案(自指等价链)。

咽喉:[`scripts/worktree-bootstrap.sh`](../../scripts/worktree-bootstrap.sh) —— 建 worktree 与
`bun install` 合成一步,失败即非零退出并把**本次**创建的半装树整棵删掉。
判据是**能力**不是产物([`scripts/assert-worktree-bootstrap.sh`](../../scripts/assert-worktree-bootstrap.sh),
`alpha-check` 第 `[8/9]` 步):真建 worktree、真跑 typecheck,且**先证明未 bootstrap 的树确实会红**
再判 bootstrap 过的树绿 —— 少了反向那条,「这台机器碰巧哪里都能解析」会让正向断言空对空地绿。

附带修掉的一格:`bun install` 会触发根 `package.json` 的 `"prepare": "husky"`,把
`core.hooksPath` 改成 `.husky/_`。它是 repository-local 的 ⇒ **在 worktree 里 install,写的是
所有 worktree 共享的 `.git/config`**,受害的是下一个在别的 lane 里 `git push` 的人
(撞上游那份在 ADR-020 冻结偏斜下恒红的钩子 ⇒ `--no-verify` ⇒ 八道真闸门一起关掉)。
bootstrap 在 install 前后夹住并还原它。

### 3.1 这道门自己会往共享树上泄漏(`#928`)

它在**共享主 checkout** 里真建三棵探针 worktree(`-neg` / `-pos` / `-fail`),其中 `-pos` 装完
依赖有 **2.8 GB**。实测 2026-08-11:一晚四条 lane 跑五次门,`git worktree list` 里多出 **4 棵、
6.3 GB**;另一次三跑剩三棵 8 GB。泄漏体是**注册在案的** worktree —— `git worktree prune` 清不掉
(prune 只摘目录已消失的登记),下一个人看那张表会以为有别的 lane 在跑。

勘破(跑出来的,不是读代码推断的):

| 结束方式 | `trap cleanup EXIT` 跑了吗 | 真探针(2.8 GB 已装好)的残留 |
|---|---|---|
| 正常退出 | 跑了(`bash -x` 全程录到 `+ cleanup`) | 无 |
| `TERM` / `INT` / `HUP`(发给进程或整个 process group) | **都跑了** | 无 |
| `KILL`(整组) | **结构上跑不了** | **有** |

对整组 `kill -KILL`、且落在 `bun install` 写盘的时刻,复现出的正是上面那个状态:一棵 **496M
半装**的树,既注册在案又留在盘上。票面记录的四棵是 533M / 1.0G / 2.1G / 2.7G,而装完整是
2.8G ⇒ **它们全是半装的**,即那几次都是在 install 中途被杀(`-neg` 早已删除、`-fail` 尚未创建,
所以只剩 `-pos`)。**「trap 没在起作用」这句观察是对的,原因却不是 trap 写错了。**

⇒ 清理不能只有「退出时清自己」这一条路径,还必须有「**开跑时清上一轮**」——那是唯一对 SIGKILL
生效的路径:[`scripts/worktree-probe-sweep.sh`](../../scripts/worktree-probe-sweep.sh),由探针脚本
在任何判据开跑之前调用一次。唯一的危险是**清过头**:并发 lane 的探针树正活着,删掉它等于让别人的
门在与他改动无关的地方变红 ⇒ `--no-verify` ⇒ 九道门一起关掉。所以判「无主」要有证据(名字里的
pid 死了、或 pid 活着但 `ps` 说那不是探针本人 —— pid 会复用),**拿不准一律留着**。
另外 cleanup 里的顺序也是载重的:**先**还原共享 `core.hooksPath`(一次 git 调用),**再**删探针树
(要动 2.8 GB,是唯一的慢动作)—— 反过来排的话,清理跑到一半再被打断,丢的就是共享配置那一半,
而两件事里只有它会影响别人。

### 3.11 门覆盖到的**包**是哪些 —— `packages/opencode` 这一格(`#1134`)

3.1~3.10 问的是「某道门在某个环境里真不真」。这一格问的是更上游的一句:
**这道门跑到哪些包**。答案此前是一份没有任何东西对照的手抄清单。

**实测(2026-08-25,`alpha@82bf5d152`)**:`bun run --cwd packages/opencode typecheck`
**exit 2 / 15 条 `error TS`** —— 13 条在 `test/tool/alpha-725-policy-chokepoints.cases.ts`
(`TS2345`,`#1123` 带入),各 1 条在 `alpha-websearch-failure.test.ts`(`TS2345`)与
`alpha-mcp-websearch-gate.test.ts`(`TS2352`)。**CI 与本地都没有任何一步跑这个包的 typecheck**:
`alpha-ci.yml` 的 typecheck job 与 `alpha-check.sh` 第 [4/10] 步当时都只列 contracts-consumer /
ext / ui-mac 三个包。后果不是「少一道门」,是**主动骗人**:主 session 当天在 `#319` 上把这片红
当成自己引入的,查了一轮才排除。

#### 为什么 alpha 的判据会住在一个**上游**包里

ADR-043 的结构性谓词(不在 `origin/dev` 里 ∧ 自报家门)。两条独立检索轴,`alpha@8e30bdb77` 实测:

| 轴 | 命令 | 结果 |
| --- | --- | --- |
| 轴 1:命名 | `git ls-files -- packages/opencode` 中 basename 匹配 `alpha-*` | 17 |
| 轴 2:出身 | 同一批里 `git cat-file -e origin/dev:<path>` **失败**者 | 18 |

差集只有一条,而且方向是对的:`src/session/tool-display.ts` 不叫 `alpha-*`,靠文件首行的
`north-star:alpha-owned` marker 自报家门(ADR-041)。⇒ **18 个 alpha 自有文件住在 `packages/opencode`
里,其中 14 个在 `test/` 下,1 个是 `.cases.ts`。** 它们全都被该包的 tsconfig 收进 typecheck,
而 typecheck 从没跑过。

#### 口径裁决:`.cases.ts` / `.test.ts` 在 `packages/opencode` 里**收进** typecheck

立票时的观察是两个包不一致:

| 包 | tsconfig 对 `.test.ts` / `.cases.ts` | 谁拥有这个 tsconfig |
| --- | --- | --- |
| `packages/ui-mac` | `exclude: ['src/**/*.test.ts', 'src/**/*.cases.ts', …]` | alpha |
| `packages/opencode` | **不排除**(整个文件没有 `include`/`exclude`)⇒ 收进 | **上游**(`origin/dev` 里有这条路径) |

裁决是**收进**,理由两条,都不是偏好:

1. **反方向做不到,而且是负收益。** 要让 opencode 也排除,得改
   `packages/opencode/tsconfig.json` —— 它在 `origin/dev` 里,是 north-star 守卫下的上游文件,
   动它要走 ADR-033 收编白名单(owner 级)。而它换来的是**更少**的检查:那 14 个 alpha 判据文件
   跑在 bun 上,bun 直接剥类型 ⇒ typecheck 是它们唯一的编译期检查。
2. **「让 ui-mac 也收进」不是这张票能装下的**,而且这句话本身要有数字才算勘破。本机实测
   (`alpha@8e30bdb77`,把 exclude 项摘掉后跑 `tsgo --noEmit -p <探针 tsconfig>`):

   | ui-mac 探针 | `error TS` 条数 |
   | --- | --- |
   | 摘掉 `*.test.ts` + `*.cases.ts` 两条 exclude(311 + 9 个文件) | **1264** |
   | 只摘掉 `*.cases.ts` 一条(9 个文件) | **129** |

   两种都不是「修几个类型」——首条就是 `Cannot find module 'bun:test'`(ui-mac 的
   `compilerOptions.types` 是 `["vite/client","node","electron"]`,没有 bun 的类型)。
   这是一张独立的票,不是本票的一部分。

⇒ **写下来的口径**:*`.test.ts` / `.cases.ts` 是否进 typecheck,由拥有该 tsconfig 的一方决定;
但凡一个包的 tsconfig 把它们收进来了,该包的 typecheck 就必须在门里。*
今天的取值:`packages/opencode` **收进 + 在门里**(本节);`packages/ui-mac` **不收**
(存量成本 1264 / 129 条,登记在 §6「已知不修」)。

#### 门与防漂

| 想让它红的东西 | 谁判红 |
| --- | --- |
| 有人往 `packages/opencode` 的 alpha 判据文件里写错类型 | `alpha-ci.yml` 的 `typecheck opencode …` 步 + `alpha-check.sh` 第 [4/10] 步(本机实测该包 typecheck **4 秒**) |
| 有人把 CI 那一步删掉/改名,而本地没跟(或反过来) | `src/main/local-gate-parity.test.ts` —— 双向比对,档位只允许 `MIRRORED`/`SUPERSET:`/`DEGRADED:` |
| 有人只把 `alpha-check.sh` 里那条命令删掉(CI 步与 `MIRRORED` 登记都留着) | 同上文件的**第十六条**(`#1134` 新增)。**在它之前这是个洞**:变异实测 15 pass / 0 fail,而本地那半道门已经不存在 —— 而本 portfolio 的合并路径是「本地判绿 ⇒ `--admin` 合」,CI 那一格恰恰是被绕过的那道,假绿的正是真正在用的那一半 |

**诚实边界(不假装闭合)**:这一步跑的是**整个** `packages/opencode`,不只是那 18 个 alpha 文件 ——
tsgo 的项目单位就是 tsconfig,而那个 tsconfig 是上游的、不能改。⇒ 一次把上游源码带红的 fork-sync
会让这一步红在与 PR 无关的地方(`#754` 形态)。今天不成立(修完本票该包 exit 0 / 0 条),所以
**不预先造逃生门**;真撞上时的处置是给它一份像 `scripts/known-fails.tsv` 那样的静态放行清单,
或退回只跑 alpha 文件的独立 tsconfig,而不是把这一步删掉。

## 4. 咽喉:两处声明,覆盖仓内真实存在的两种运行形状

仓内的 `bun test` 只有两种形状,咽喉必须两种都盖住:

### 4.1 超时:两处声明,覆盖两种运行形状

| 形状 | 谁是这个形状 | 声明在哪 | 机制 |
| --- | --- | --- | --- |
| **A 单文件** | 31 条 host 用例用 `Bun.spawnSync([bun, "test", <一个绝对路径>])` 起的子进程 —— host 自己拼 argv,传不进 CLI flag | `packages/ui-mac/scripts/test-preload.ts` | `setDefaultTimeout(120_000)` |
| **B 多文件** | CI 的三条 test 步、`assert-gate-files.sh` 的 77 次点名、`alpha-check.sh` 的 `[4/7]` —— **所有闸门运行的唯一入口** | `scripts/bun-test-floor.sh` | `bun test --timeout 120000` |

preload 此前已经承担过一次同类职责(把 UI locale 钉成 `zh`,因为 happy-dom 的 navigator 让
`detectLocale()` 落到 `en`)—— **同一个位置,同一个问题形态**。

### 4.2 平台:检测与自陈是全局的,**钉桩是 opt-in 的**

| 角色 | 落点 | 行为 |
| --- | --- | --- |
| 检测 + 自陈 | `scripts/test-preload.ts` | host 不是发布平台时打印 `PLATFORM DEGRADED this run: …must opt in via pinShippedPlatform()` |
| 钉桩(声明「这道门需要发布平台」) | `test-component/pin-shipped-platform.ts` 的 `pinShippedPlatform()` | 把 `process.platform` 钉到 `darwin` 并打印 `PLATFORM SIMULATED this run; genuinely <host>-specific behaviour is NOT covered.` |
| 目前的调用方 | `test-component/ext-install-catalog-result.cases.ts` | 它跑生产 `ext-install-catalog` 全链,里面有 ADR-026 的平台闸 |

> **为什么不是全局钉 —— 这是在真环境里量出来的,不是设计品味。**
> 本票第一版把钉桩放进 preload(全局)。alpha-ci 上实测:14 个 renderer 测试文件整片挂在
> `error: Cannot find module @rollup/rollup-darwin-x64` —— vite/rollup 按 `process.platform`
> 选原生可选依赖,而 linux runner 上装的是 linux 那一份。`3752 pass` 掉到 `3625 pass`。
> **为了修 2 条而弄坏 14 个文件,是把一处假红换成一片真红。**
> 全局改环境的代价,必须在**真环境**里量过才算知道 —— 开发机上这一版全绿。

### 候选机制全部实测(bun 1.3.14)—— 其中一条把本票自己骗过一次

| 候选 | 实测结果 |
| --- | --- |
| `bunfig.toml` 的 `[test] timeout = 9000` | **不被读取** —— 6 秒用例照样 `timed out after 5000ms` |
| `BUN_TEST_TIMEOUT` / `BUN_TIMEOUT` / `BUN_TEST_TIMEOUT_MS` | 全部无效(`strings $(which bun)` 里也只有 `BUN_CONFIG_HTTP_IDLE_TIMEOUT`) |
| preload 里 `beforeAll(() => setDefaultTimeout(…))` | 无效 |
| preload 里 `setDefaultTimeout()` | **只对一次运行的第一个文件生效** —— 单文件跑得通,`bun test src`(257 个文件)从第二个文件起退回 5000ms |
| `bun test --timeout N` | **跨全部文件生效**;单条用例的显式超时仍恒胜(两个方向都实测过) |

> **本票自己踩了第四行。** 第一版把 preload 当成唯一咽喉,证据是「单文件探针 6 秒用例通过」——
> 而闸门跑的是 257 个文件。这个假绿是被**新加的那道门自己**在全量里抓出来的
> (`(fail) 环境咽喉对子进程也生效 [5005.06ms]`),不是靠人复查。
> 教训与本文 §2 同源:**先证明这个手段能测出已知的坏,再用它判未知的好** ——
> 而「已知的坏」必须用**真实形状**去测,单文件探针测不出多文件的坏。
> 现在的行为闸让慢用例**排在第二个文件**,占位文件 `gate-environment-first.cases.ts` 就是为此存在:
> 让慢的当第一个文件,验的会是形状 A(本来就成立),给出假绿。

### 取值与代价

120s 与已显式声明的那批同档(本包最慢的**正当** host 在 CI 上实测 37.7s)。
判据是「不让机器速度决定结论」,不是「越小越严」——**超时不是断言**:一条卡死的用例仍会在
120s 内判红,而 5s 的代价是让真闸在慢机器上恒假红。
**代价要说清**:一条本来 0.1 秒、退化成 60 秒的用例不会再被超时抓到 ——
这一格换来的是「慢机器上不假红」,失去的是「性能退化的顺带发现」。需要把时长当断言的用例
(如 `artifact-quota.test.ts` 的 `}, 1000)`)照旧显式写。

### 平台钉桩是**模拟**,不是覆盖

在 linux 内核上跑 darwin 分支,凡真正依赖 host 内核行为的东西这一轮没有验到。
所以那行 `PLATFORM SIMULATED this run` 必须打出来 —— 一道门可以降级,**不许静默降级**。
只钉 `darwin` 不钉 `win32`:`node:path` 在加载时按 `process.platform` 选分支,
darwin 与 linux 同为 posix,钉 `win32` 会把路径语义改坏。

### 自陈必须真的到达运行输出

`PLATFORM SIMULATED` / `[gate-environment]` 是**子进程**打的,而 host 把子进程 stdout 吃进变量、
只在失败时抛出来 —— 于是「这次降级了什么」在**绿的那一次反而看不见**,而那正是需要它的时候。
实测:第一版在 alpha-ci 全绿的 run 里 `grep` 不到任何一行自陈。
现在 `gate-environment.test.ts` 在成功路径上把子进程的自陈行转述出来;
运行级的那句(`PLATFORM DEGRADED this run: … must opt in via pinShippedPlatform()`)
由 preload 直接打在每个测试进程的 stdout 上,不经转述。

### 还有一条只有真环境才说得出来的

行为闸的形状 B 要经 `bash scripts/bun-test-floor.sh`,而那个脚本里写的是裸 `bun`。
第一版在 alpha-ci 上直接挂在 `bun-test-floor.sh: line 55: bun: command not found` ——
从 bun 进程 spawn 出去的 bash 拿到的 `PATH` 里没有 runner 装的那个 bun。
开发机上 `bun` 在 PATH 里,所以本地怎么跑都看不到。
修法是把**正在跑本测试的那个 bun**所在目录前置进子进程 PATH:既修好,也顺带保证父子跑同一个二进制。

## 5. 新增一道门时,忘记处理环境会被什么挡住

| 忘了什么 | 谁判红 |
| --- | --- |
| 新 host 没声明超时 | 不需要声明 —— 咽喉默认给到。**咽喉本身**被删掉时,`src/main/gate-environment.test.ts` 当场红(它跑一条 6 秒、不写超时的用例) |
| 新门走到生产平台闸、忘了 opt-in | preload 在非发布平台上打出 `PLATFORM DEGRADED this run: … must opt in via pinShippedPlatform()`;门本身会红在 `platform … not supported by this entry`(**具名**,不是超时那种莫名其妙的红) |
| `pinShippedPlatform()` 被改坏 | `src/main/gate-environment.test.ts` —— 子用例按 `os.platform()` **自陈这一半本次跑没跑到**(开发机跑不到、alpha-ci 跑得到),不会让本地的绿被误读 |
| CI 加了一步而本地没跟 | `src/main/local-gate-parity.test.ts` —— 双向比对,CI 改名也红 |
| 本地某一步被悄悄降级 | 同上:档位只能是 `MIRRORED` / `SUPERSET:<理由>` / `DEGRADED:<理由>`,**没有「静默不跑」这一档** |
| ADR 新增收编而只改了 CI 一侧 | **结构上不可能了**(`#889`):清单只有 `scripts/north-star-guard.sh` 一份,CI 与本地都调用它;`local-gate-parity.test.ts` 守住「workflow 必须调用它、且不得留第二份副本」 |
| north-star 的比较基准被改成别的 ref | `src/main/north-star-guard.test.ts` —— 造一个只落在 dev 窗口里的上游改动,断言守卫不点名它(§3.8) |
| `assert gate files` 又被条件掉 | 同上(断言该步带 `!cancelled()`) |
| 新增闸门文件没登记 | `src/main/gate-file-registry.test.ts`(既有) |
| 往 `packages/opencode` 的 alpha 判据文件里写错类型 | `typecheck opencode …` 那一步(`#1134`,§3.11)。此前**无人判红** —— 门的清单里根本没有这个包 |
| 只把 `alpha-check.sh` 里某条 typecheck 命令删掉,登记与 CI 都不动 | `local-gate-parity.test.ts` 第十六条(`#1134`)。此前**无人判红**:上面三条 CI_STEPS 断言比的全是步骤名,`MIRRORED` 只是一句登记,不是一条断言 |

解析自检钉在 `local-gate-parity.test.ts` 里(`ciSteps ≥ 12`、守卫脚本的 `UPSTREAM_PATHS ≥ 8`
与收编白名单 `≥ 20`、`jobNames ≥ 6`、`required ≥ 4`、`#1134` 的 typecheck 命令 `≥ 4`):一份退化成解析不出东西的解析器会让每条
断言空对空地全绿 —— 先证明手段能测出已知的坏,再用它判未知的好。

## 6. 已知不修(留痕)

- **`bun test src` 手跑仍是 5s 默认**?不是 —— preload 对手跑也生效(同一份 bunfig)。
  但**手跑不判下界**,`Ran 0 tests` 仍会 exit 0。判据只有一条:门要走
  `scripts/bun-test-floor.sh`,手跑只是看看。
- **CI 仍跑在 ubuntu**。换 macOS runner 能让平台那一格从「模拟」变成「真验」,代价是 10 倍
  Actions 分钟数。本票不做,记在这里;真要做是一张独立票。
- **`#649` 的三份 opencode 测试仍无人执行**。逐份取舍要付 CI 时间的账,归 `#649`。
- **`packages/ui-mac` 的 `*.test.ts` / `*.cases.ts` 仍在 typecheck 之外**(§3.11)。实测代价
  1264 条(含 test)/ 129 条(只含 cases),首条是 `Cannot find module 'bun:test'` —— 要先给
  ui-mac 的 `compilerOptions.types` 加 bun 类型再逐条收。`#1134` 不做,记在这里;真要做是一张
  独立票。**在那之前,ui-mac 的 `.cases.ts` 写错类型不会有任何东西变红。**
- ~~**分支保护的幽灵 context** 归 `#717`~~ —— **已闭合**(§3.5)。owner 2026-08-03 改掉分支保护设置,
  `#717` 补上仓内记录 [`.github/required-contexts.txt`](../../.github/required-contexts.txt) 与两条防漂断言。
  **残余缺口(有意留着,不假装闭合)**:真源是仓外的 GitHub 设置,CI 够不着 ⇒ 「只改 GitHub 设置」
  或「两侧一起改错」都不会红。那份记录是手抄快照 + 减速带,不是闸门。
