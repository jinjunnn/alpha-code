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

### 3.1 CI 的 12 个代码步

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

| 事件 | 基准 | 口径 | 为什么 |
| --- | --- | --- | --- |
| `pull_request` | `merge-base(base.sha, head.sha)` → `head.sha` | 三点 | `base.sha` 是移动中的 tip,只有分叉点才回答「这个 PR 自己改了什么」 |
| `push` | `before` → `sha` | **两点(不动)** | 这对 SHA 本来就是同一条线上的前后两点,语义是「这次 push 推进了什么」,没有分叉可言 |
| 空 base / base 不可达 / 无共同祖先 | 空树 | — | fail-closed:一切都算改动 ⇒ 跑全量。反向(算成 docs-only)= 在看不懂的形状上把所有门关掉 |

逻辑因此从 workflow 的内联 shell 搬进 [`scripts/detect-changed-scope.sh`](../../scripts/detect-changed-scope.sh)。
**唯一的理由是让它有判据** —— 内联时它一个判据都没有,而断言 YAML 文本按本仓定义是假闸门。
行为闸 `packages/ui-mac/src/main/ci-diff-scope.test.ts` 起真 git 仓、造真的「落后于 base 的纯文档
分支」、跑生产脚本本体,断言它写进 `$GITHUB_OUTPUT` 的实际值;六条各钉一个方向(含「分支自己改代码
必须 `code=true`」——否则「永远返回 false」也能满足这道门)。workflow 那一步的 `name:` 与 `env:`
一个字没改,所以 §3.1 的 CI_STEPS 对照表不受影响。

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
| ADR 新增收编而只改了 CI 一侧 | 同上(`#637` 退出条件 3) |
| `assert gate files` 又被条件掉 | 同上(断言该步带 `!cancelled()`) |
| 新增闸门文件没登记 | `src/main/gate-file-registry.test.ts`(既有) |

两条解析自检钉在 `local-gate-parity.test.ts` 里(`ciSteps ≥ 12`、`ciExcludes ≥ 20`):
一份退化成解析不出东西的解析器会让每条断言空对空地全绿 —— 先证明手段能测出已知的坏,
再用它判未知的好。

## 6. 已知不修(留痕)

- **`bun test src` 手跑仍是 5s 默认**?不是 —— preload 对手跑也生效(同一份 bunfig)。
  但**手跑不判下界**,`Ran 0 tests` 仍会 exit 0。判据只有一条:门要走
  `scripts/bun-test-floor.sh`,手跑只是看看。
- **CI 仍跑在 ubuntu**。换 macOS runner 能让平台那一格从「模拟」变成「真验」,代价是 10 倍
  Actions 分钟数。本票不做,记在这里;真要做是一张独立票。
- **`#649` 的三份 opencode 测试仍无人执行**。逐份取舍要付 CI 时间的账,归 `#649`。
- ~~**分支保护的幽灵 context** 归 `#717`~~ —— **已闭合**(§3.5)。owner 2026-08-03 改掉分支保护设置,
  `#717` 补上仓内记录 [`.github/required-contexts.txt`](../../.github/required-contexts.txt) 与两条防漂断言。
  **残余缺口(有意留着,不假装闭合)**:真源是仓外的 GitHub 设置,CI 够不着 ⇒ 「只改 GitHub 设置」
  或「两侧一起改错」都不会红。那份记录是手抄快照 + 减速带,不是闸门。
