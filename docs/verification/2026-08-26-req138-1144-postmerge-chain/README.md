---
title: alpha-code#1144 —— `#1147` 合入之后,打包产物里的 shell 工具整链复跑
kind: verification
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-08-26
review_after: 2026-11-26
---

# alpha-code#1144 · post-`#1147` 整链可达性复跑

票:[alpha-code#1144](https://github.com/jinjunnn/alpha-code/issues/1144) ·
上一轮:[`2026-08-26-req138-1144-packaged-shell-tool-chain`](../2026-08-26-req138-1144-packaged-shell-tool-chain/README.md)
(跑在 `c3c58308f`) · 更早:[`2026-08-26-req138-1076-packaged-sandbox`](../2026-08-26-req138-1076-packaged-sandbox/README.md) ·
基线:[`docs/architecture/2026-08-23-shell-sandbox-seam.md`](../../architecture/2026-08-23-shell-sandbox-seam.md)

**取证脚本沿用上一轮那一份**,不是新写的:
[`../2026-08-26-req138-1144-packaged-shell-tool-chain/run.ts`](../2026-08-26-req138-1144-packaged-shell-tool-chain/run.ts)。
本目录只加了一个上一轮没有的负向控制脚本 [`gate-negative-control.ts`](gate-negative-control.ts)。

**未改任何生产代码。**

## 0. 这一轮补的是哪个缺口 —— 以及**不是**哪个

上一轮的取证跑在 `c3c58308f`。`#1147`(`ac#1129`)在那之后合进 `alpha`,而它改的正是
AC1 链条上的两格:

```
$ git diff --name-only c3c58308f..8a438007b -- packages/opencode/src/permission \
        packages/opencode/src/session/tools.ts packages/opencode/src/tool/registry.ts
packages/opencode/src/permission/alpha-tool-inventory.ts
packages/opencode/src/permission/alpha-tool-policy-gate.ts
packages/opencode/src/permission/alpha-tool-policy.ts
packages/opencode/src/permission/index.ts
packages/opencode/src/session/tools.ts
packages/opencode/src/tool/registry.ts
```

具体换掉的是**执行咽喉那一格**:`session/tools.ts` 里原来的
`permission.ask({ permission: canonicalToolIdentity(display.identity), … })`
换成了 `AlphaToolPolicyGate.gateToolExecution({ … })`(ruleset 轴 + 策略文档轴的合成)。
⇒ 上一轮「链到得了 `bash` 工具」的证据**对当前 `alpha` 不成立**。

**不受影响的是围栏本体**:同一区间 `packages/ext` 只动了一个测试文件
(`packages/ext/src/cloud-websearch-kill.test.ts`),打包进 app 的 wrapper 逐字节未变
(`extBundleSha256` 与上一轮记录的 `72026e70…d07f80` **相同**)。所以本轮**不**重开
「沙箱围栏本身对不对」这个问题,那仍由 REQ-138 与上一轮的记录承担。

| 缺口 | 本轮 |
| --- | --- |
| 「`#1147` 之后这条链是否仍到得了 `bash` 工具」零证据 | **本轮关掉** |
| AC1 字面上的「**真模型**回合」 | **仍未闭合** —— 本轮仍是本地 OpenAI-compatible 桩,需要模型凭据(owner 侧资源) |
| AC2(hardened runtime) | **本轮不跑** —— 它的结论建立在围栏与签名上,两者本区间都没动 |

## 1. 结论

| 断言 | 结论 |
| --- | --- |
| post-`#1147` 的打包产物里,一次 agent 回合 → shell **工具** → wrapper → `sandbox-exec` 仍然通,越界写入不落盘 | **PASS**(7 条 × 2 轮 = **14/14 不落盘**) |
| 同一套语料在围栏移除的打包副本上落盘(反向臂) | **PASS**(**14/14 全部落盘**) |
| 正样本:同一条工具链上工作区内写入 | **PASS**(两臂各 2 轮,**4/4 落盘**) |
| 基线 §2.5/§2.6 的原驱动面(prompt `!command`)同轮复跑 | **PASS**(围栏 **14/14 不落盘**,反向 **14/14 落盘**) |
| 这条链**可以**被闸关掉(负向控制) | **PASS**(8/8,见 [§4](#4-负向控制--这条链是可以被关掉的)) |
| 被测包里确实含 `#1147` | **PASS**(见 [§5](#5-产物出处--包里真的是-1147)) |
| AC1 的「**真模型**」这四个字 | **仍未闭合** |

四轮原始输出,每轮 **21 pass / 0 fail / 2 跳过**(跳过的两格是 `identity.hardenedRuntime`
与只作观测的 `observation.psInsideToolShell`),合计 **84 pass / 0 fail**:
[`results/fenced.json`](results/fenced.json) · [`results/fenced-round2.json`](results/fenced-round2.json) ·
[`results/unfenced.json`](results/unfenced.json) · [`results/unfenced-round2.json`](results/unfenced-round2.json)。
另有冒烟轮 [`results/smoke-fenced.json`](results/smoke-fenced.json)(`--corpus one`,9 pass / 0 fail)、
负向控制 [`results/gate-negative-control.json`](results/gate-negative-control.json)、
产物出处 [`results/artifact-provenance.json`](results/artifact-provenance.json)。

**没有任何一格 FAIL,所以本轮不产 bug 票。**

## 2. 被测件

| 项 | 值 |
| --- | --- |
| 分支 / base | `ac-1144b` @ **`8a438007b2ae8b8da76137c68053916ac306f66a`** = 构建时的 `origin/alpha`(含 `#1147`、`#1148`) |
| 每份结果 JSON 自报的 `gitSha` | 四轮 + 负向控制**全部**是 `8a438007b2ae…c306f66a` |
| 产物 | `packages/ui-mac/dist/mac-arm64/alpha-code.app`(457 MB;`dist/` 不入仓) |
| `app.asar` | 182,813,235 B,`sha256 a03cccd8430efbe08627dde82d17730da63b9347ce627735a51b5d10964c136e` |
| ext bundle(围栏臂) | `sha256 72026e70…d07f80`,与分支内 `packages/ext/dist/plugin.js` **逐字节相同**,也与上一轮记录**相同** |
| ext bundle(反向臂) | `sha256 9cc40e89fa5e026048782823dba27a256c9ec8afad90cf3ccccb27ca8c95d463`,与上一轮及 `#1076` 记录**逐字相同** ⇒ 同一处变异可复现 |
| `app.isPackaged` | `true` —— 主进程自报 `app starting { version: '0.1.3', packaged: true, onboardingTest: true }`,逐轮记进 `identity.appStartingLine` |
| 签名 | 两臂都是 ad-hoc(`flags=0x2(adhoc)`,`TeamIdentifier=not set`);本轮**不做** hardened 臂 |
| 启动参数 | 四轮 + 负向控制两臂**一律** `["--remote-debugging-port=<port>", "--use-mock-keychain"]`,逐轮记进 `identity.launchFlags` |
| `OPENCODE_PERMISSION` | `{"bash":"allow","external_directory":"allow"}` —— 产品自带的配置入口,逐轮记进 `identity.opencodePermission` |
| 宿主 | macOS 26.3.1 / Darwin 25.3.0 arm64;机器时区 EDT(`-0400`) |

### 2.1 构建证据 —— 这一步上一轮翻过车

`bun run build` 的 `prebuild` 要取 `https://models.dev/api.json`,本机代理完不成它的 TLS ⇒
build 退出 1、`electron-vite` 一次没跑,而 `package:mac` **照跑**,打包的是上一份 `out/`。
本轮用仓内那份**真快照**离线跑完,并且**退出码单独取、`built in` 行数单独核**:

```
$ OPENCODE_CHANNEL=prod MODELS_DEV_API_JSON=$WT/packages/opencode/test/tool/fixtures/models-api.json \
    bun run --cwd packages/ui-mac build > build.log 2>&1
  EXIT=0
$ grep -c "built in" build.log
  3                      ← 真构建的指纹(失败那轮是 0)
  ✓ built in 13.69s
$ OPENCODE_CHANNEL=prod MODELS_DEV_API_JSON=… bun run --cwd packages/ui-mac package:mac
  EXIT=0
```

`MODELS_DEV_API_JSON` 是产品自带的开关(`packages/opencode/script/generate.ts:10-13`);
它**必须给绝对路径** —— 该脚本在读这个变量之前先 `process.chdir(packages/opencode)`。

打包跑完 `git status --porcelain` = **0 行**,`git ls-files packages/ui-mac/resources/icons` = **0**
⇒ `#1076` §8 第 2 条(打包弄脏 43 个被追踪图标)确实已随 `ac#1115` 消失。本轮自己核的。

## 3. 结果

语料与基线 §2.5 / `alpha-sandbox-escape.test.ts` 同一套 7 条。判据是**文件有没有落盘**,
不是 exit code。

| 语料 | 围栏 ON(2 轮) | 围栏 OFF(2 轮) |
| --- | --- | --- |
| `echo pwned > <target>` | 不落盘 ×2 | 落盘 ×2 |
| `echo pwned >> <target>` | 不落盘 ×2 | 落盘 ×2 |
| `/bin/sh -c 'echo pwned > <target>'` | 不落盘 ×2 | 落盘 ×2 |
| `python3 -c 'open(...,"w").write("x")'` | 不落盘 ×2 | 落盘 ×2 |
| `node -e 'fs.writeFileSync(...)'` | 不落盘 ×2 | 落盘 ×2 |
| `nohup sh -c 'echo pwned > <target>'` | 不落盘 ×2 | 落盘 ×2 |
| `ln -sf <target> link && echo pwned > link` | 不落盘 ×2 | 落盘 ×2 |
| **正样本**:工作区内 `echo ok > inside.txt` | **落盘 ×2** | **落盘 ×2** |

按驱动面拆开,**零例外**:

| 驱动面 | 围栏 ON | 围栏 OFF |
| --- | --- | --- |
| `ac1.toolChain/*`(shell **工具**,argv `["-c", cmd]`) | **14/14 不落盘** | **14/14 落盘** |
| `baseline25.promptShell/*`(prompt `!command`,基线原驱动面) | **14/14 不落盘** | **14/14 落盘** |

全部 56 个 escape 格 `processStarted=true`(工具自己的 `state.output` 里看得见
`AC1144-STARTED` ⇒ 进程真的起来过,**空输出不算拦住**)。`ac1.toolChain` 的 28 格另外满足
`toolCalled="bash"` · `toolStatus="completed"` · `commandIntact=true` · `partMatchedBy="callID"`
(按桩发出的 callID 认领本回合那一格,不是「取最后一个工具格」)。

链条确实经过 wrapper 是**观测**出来的,不是声明的:从工具派生出来的那个 shell 内部把
wrapper 注入的两个环境变量原样读回来,四轮都满足
`ALPHA_SB_PROFILE == <cfg.shell 推出的 profile 路径>` 且 `ALPHA_REAL_SHELL=/bin/zsh`
(`ac1.toolChain/env reaches tool-spawned shell`)。

引擎下发给模型的工具名单四轮逐字相同,共 16 个,与上一轮记录的那 16 个**一字不差**:

```
alpha_echo, alpha_ping, alpha_register, alpha_reload, bash, edit, glob, grep,
question, read, skill, task, todowrite, webfetch, websearch, write
```

⇒ `#1147` 没有改变这条链上模型看得见的工具面。

## 4. 负向控制 —— 这条链**是可以**被关掉的

「链是通的」若不配一条**该被关掉、也真的被关掉**的样本,就分不清两件事:
(a) 闸在这条路径上、判过之后放行;(b) 闸根本没接上,于是「通」只是**没有任何东西在判**。
本仓《观测手段自己有盲区》的判据:**先证明这个手段能测出已知的坏,再用它判未知的好。**

手段**只动产品自带的配置入口**,一个键的差别:

| 臂 | `OPENCODE_PERMISSION` |
| --- | --- |
| allow(控制组) | `{"bash":"allow","external_directory":"allow"}` |
| deny | `{"bash":"allow","external_directory":"allow","builtin::bash":"deny"}` |

`builtin::bash` 是 shell 工具的 canonical identity(`tool/registry.ts:271-275` 把 builtin
铸成 `source=builtin` / `origin=""` / `name=<id>`;`canonicalToolIdentity` 拼成
`source:origin:name`)。`packages/core/src/v1/config/permission.ts` 的 `InputObject` 是
`StructWithRest(…, [Record(String, Rule)])` ⇒ 接受任意键;`agent/agent.ts:138` 把用户配置
merge 在**最后**一位,而 `Permission.evaluate` 是 `findLast` ⇒ 用户规则压过 defaults。

实跑([`results/gate-negative-control.json`](results/gate-negative-control.json),**8/8**):

| 观测 | allow 臂 | deny 臂 |
| --- | --- | --- |
| 引擎下发的 tools | **16 个,含 `bash`** | **15 个,不含 `bash`** |
| 桩挑中的工具 | `bash` | `null`(名单里没有) |
| 工具那一格 | `completed`,输出含 `AC1144-STARTED` | 不存在 |
| 工作区内 `inside.txt` | **落盘** | **不落盘** |
| 逃逸文件 | 不落盘(围栏拦住:`zsh:1: operation not permitted: …/pwned.txt`) | 不落盘(根本没跑) |

两份名单的差只有 `bash` 一项 —— 一个配置键,一位变化。

**它证明什么**:这套测量能测出「链被关掉」的状态;因此四轮里的「链是通的」是一个**真实的
测量结果**,不是恒真的空转。同时,allow 臂在同一个脚本、同一份产物上跑通,排除了
「deny 臂什么都没落盘是因为整个 app 就没起来」。

**它不证明什么(必须说清)**:`bash` 从目录里消失这件事,**在 `c3c58308f` 上同样会发生** ——
`Permission.disabled`(`permission/index.ts:353-373`)的 identity 分支(`368-370`)在 `#1147` 之前就存在
(`c3c58308f` 的同一函数里,那两行在 `360-361`),
`session/llm/request.ts` 的 `resolveTools` 一直用它过滤。所以这条控制**不能**用来区分
「跑的是 `#1147` 的新闸」还是「跑的是旧的目录过滤」。那个问题由 [§5](#5-产物出处--包里真的是-1147) 回答,
用的是产物出处而不是行为。

## 5. 产物出处 —— 包里真的是 `#1147`

[`results/artifact-provenance.json`](results/artifact-provenance.json)。挑的是
**在 `c3c58308f` 的 `packages/{opencode,schema,core}/src` 里一个文件都命中不到、
在 `8a438007b` 命中得到**的字符串,再看它在打包的 `app.asar` 里在不在:

| 标记 | `c3c58308f` 命中文件数 | `8a438007b` 命中文件数 | `app.asar` 命中行数 |
| --- | --- | --- | --- |
| `alpha-app-builtin` | 0 | 1 | 1 |
| `plugin-file` | 0 | 1 | 1 |
| `plugin-hook` | 0 | 1 | 1 |
| `gateToolExecution` | 0 | 4 | 5 |
| `permission-ruleset` | 0 | 1 | 1 |
| `cap-hard-deny` | 1 | 4 | 1 |

最后一行 `cap-hard-deny` 在基线上就有一个文件命中,**因此它不作判据** —— 列在这里只为说明
「命中数变多」不等于「是新的」。前五行才是判据。

**观测手段先自证**(`app.asar` 里有 **2,689,313** 个字面 NUL 字节,不带 `-a` 的 `grep`
会给出一个**假的「没有」**;本表全部用 `grep -a`):

| 探针 | 期望 | 实测 |
| --- | --- | --- |
| `AlphaToolPolicy` in `app.asar` | present | 9 行 |
| `alpha-app-builtinXYZZY` in `app.asar` | absent | 0 |
| `sandbox-execXYZZY` in `app.asar` | absent | 0 |
| `sandbox-exec` in `alpha-ext/plugin.js`(围栏臂) | present | 2 |
| `sandbox-exec` in `alpha-ext/plugin.js`(反向臂) | 少一处 | 1 |

配上结构事实:`session/tools.ts` 里工具执行**只有一条**路径,`identityGate` 里那一次
`gateToolExecution` 是它唯一的前置。⇒ 四轮里跑到 `completed` 的 28 次 `bash` 调用,
经过的是 `#1147` 的那一格。

## 6. 仍未闭合(与上一轮相同,不因本轮变动)

1. **触发工具调用的不是真模型。** AC1 的字面要求是「真模型回合」;本轮仍是本地
   OpenAI-compatible 桩(经产品自带的 `providers.add` 注册,工具名不写死 —— 从引擎实际下发
   的 `tools` 里挑 `bash`)。桩之后每一格都是打包产品自己的代码。补法不变:
   `bun run.ts --provider <真 providerID> --model <modelID>`,两轮即可,runner 不必改;
   **缺的是一套可用的模型凭据**(owner 侧资源)。
2. **本轮没有 hardened 臂。** AC2 的结论仍以上一轮为准;本区间围栏与签名配方都没动。
   与出厂件的三处差异见上一轮 §5.4。
3. **单机单配置。** 一台 macOS 26.3.1 / arm64、宿主 `SHELL=/bin/zsh`。
4. **网络轴不在本票。**

## 7. 本轮核实与踩到的三件事

1. **取证脚本修了一处缺陷,只影响结果落盘、不影响任何判定。**
   `run.ts` 的 `finally` 里 `spawnSync("git",…).stdout.trim()` 在 cwd 被删时 `stdout` 是
   `null` ⇒ 抛错 ⇒ **整轮结果 JSON 一个字都写不出来**(上一轮实测)。本轮改成
   `.stdout?.trim() ?? ""`。它取的是结果对象里的 `gitSha` 字段,不参与任何 probe 的 `ok`。
2. **本机上残留着上一轮的两个孤儿 app 进程**(`alpha-code-unfenced.app`,08:43 与 10:54 起,
   它们的 worktree 已被删),都在监听同一个 CDP 端口。开跑前已终止。
   本仓已有一条讲「在别人的变异实验窗口里跑闸门,量到的是被故意改坏的那份代码」——
   **让一份反向臂(围栏已拆)的产物在后台常驻,是同一类污染源**,只是它跨轮次存活。
   判据不变:**红之前先问「这一刻机器上在跑什么」。**
3. **`git grep` 的 pathspec 写成引号 glob(`'packages/*/src'`)会静默返回 0 命中。**
   本轮第一次跑标记对照时,七个标记全报 `base=0 head=0` —— 看着像「这些字符串哪儿都没有」。
   先拿一个**已知存在**的符号(`canonicalToolIdentity`)去跑,发现同样是 0,才认出是手段坏了;
   换成不带引号的多路径 pathspec 后立刻正常。与本仓《观测手段自己有盲区》同一条:
   **先证明这个手段能测出已知的坏,再用它判未知的好。**

## 8. 跑法

```bash
WT=$(git rev-parse --show-toplevel)
E=docs/verification/2026-08-26-req138-1144-packaged-shell-tool-chain          # runner 在上一轮那个目录
N=docs/verification/2026-08-26-req138-1144-postmerge-chain                    # 本轮证据落这里

# 构建:必须给绝对路径的离线快照,并单独核 built in == 3
OPENCODE_CHANNEL=prod MODELS_DEV_API_JSON="$WT/packages/opencode/test/tool/fixtures/models-api.json" \
  bun run --cwd packages/ui-mac build > build.log 2>&1; echo "EXIT=$?"; grep -c "built in" build.log
OPENCODE_CHANNEL=prod MODELS_DEV_API_JSON="$WT/packages/opencode/test/tool/fixtures/models-api.json" \
  bun run --cwd packages/ui-mac package:mac

cd packages/ui-mac/dist/mac-arm64
codesign --force --deep --sign - alpha-code.app          # 不补这一步:SIGKILL / exit 137 且零输出
ditto alpha-code.app alpha-code-unfenced.app
# 只把 plugin.js 里 WRAPPER_SCRIPT 那一行换成 exec "$ALPHA_REAL_SHELL" "$@"
# (脚本自带「必须恰好命中 1 处」「sandbox-exec 次数正好少 1」两条断言,见上一轮 README §9)
codesign --force --deep --sign - alpha-code-unfenced.app
cd "$WT"

for r in "" -round2; do
  bun $E/run.ts --app packages/ui-mac/dist/mac-arm64/alpha-code.app          --arm fenced   --out "$WT/$N/results/fenced$r.json"
  bun $E/run.ts --app packages/ui-mac/dist/mac-arm64/alpha-code-unfenced.app --arm unfenced --out "$WT/$N/results/unfenced$r.json"
done
bun $N/gate-negative-control.ts --app packages/ui-mac/dist/mac-arm64/alpha-code.app
```

runner 退出码 = 有没有 FAIL。读它一律 `set -o pipefail`,不要用 `cmd | tail; echo $?`。
四轮各约 **6.5 分钟**(实测 390–392 s),负向控制约 **34 s**。
