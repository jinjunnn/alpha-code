---
title: alpha-code#1144 —— 打包产物里由 agent 回合驱动的 shell 工具整链,以及 hardened runtime 下复跑
kind: verification
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-08-26
review_after: 2026-11-26
---

# alpha-code#1144 · shell 工具整链 + hardened runtime

票:[alpha-code#1144](https://github.com/jinjunnn/alpha-code/issues/1144) ·
前一轮:[alpha-code#1076](https://github.com/jinjunnn/alpha-code/issues/1076)
([取证目录](../2026-08-26-req138-1076-packaged-sandbox/README.md)) ·
基线:[`docs/architecture/2026-08-23-shell-sandbox-seam.md`](../../architecture/2026-08-23-shell-sandbox-seam.md)
§2.2 / §2.5 / §2.6 / §5 / §7

> **AC1.** 打包产物里,由**真模型回合**触发一次 shell 工具调用,越界写入的判据仍是「文件是否落盘」,
> 且反向对照(围栏移除)同一语料落盘。
> **AC2.** 在**开启 hardened runtime 的签名产物**上复跑基线 §2.5/§2.6 的正反语料,结论与未开时一致。

**未改任何生产代码。** 本次改动 = 本目录(取证脚本 + 结果 JSON)+ 基线 §5/§7 的回写
+ `docs/README.md` 的一行索引,三处都是文档。

## 0. 判据

三条,都不是自己发明的:

1. **只记「文件是否落盘」,不记 exit code。** 基线 §2.5 实测 `nohup` 那条 exit 0 而文件未落盘。
   本轮 `observation.psInsideToolShell` 又复现了一次同型:命令里 `| head -c 120` 之后 `$?` 取的是
   `head` 的,两臂都报 `EXIT=0`,而两臂的**实际结果相反**。
2. **空输出不算「拦住了」。** 每条语料第一句是 `echo AC1144-STARTED`,只有在**工具自己的
   `state.output`** 里看见这个标记(= 被 spawn 的进程真的起来过)才允许把「没落盘」读成「被拦住」。
   全部 escape 格的 `processStarted` 都是 `true`。
3. **臂别是观测出来的,不是声明的。** 每轮从盘上把 `cfg.shell` 指向的 wrapper 原文读回来记进
   `identity.wrapperText`,并与 `--arm` 交叉断言(`identity.armMatchesBundle` /
   `m1.wrapperMatchesArm`);hardened 臂另外从 `codesign -dv` 观测 runtime 位与 Team ID
   (`identity.hardenedRuntime`)。

外加一条正样本:同一条工具链上跑一句**该落盘**的命令(工作区内 `echo ok > inside.txt`),
**两臂都必须落盘**。缺它,「没落盘」分不清是「被拦住」还是「这条链根本没跑」。

## 1. 结论

| AC | 断言 | 结论 |
| --- | --- | --- |
| **AC1**(整链) | 打包产物里,一次 agent 回合 → shell **工具** → wrapper → `sandbox-exec`,越界写入不落盘 | **PASS**(7 条 × 4 轮 = **28/28 不落盘**) |
| **AC1**(反向对照) | 同一套语料,围栏移除的打包副本上落盘 | **PASS**(**28/28 全部落盘**) |
| **AC1**(「**真模型**」这四个字) | 决定去调 shell 工具的是真模型 | **未闭合** —— 用的是本地 OpenAI-compatible 桩,见 [§3.2](#32-provider-是一个本地桩--它不是真模型) 与 [§7](#7-未闭合与未验证项) |
| **AC2** | hardened runtime + Developer ID 签名产物上,§2.5/§2.6 正反语料结论与未开时一致 | **实跑完成,结论一致**;与出厂件仍有三处已具名差异,是否据此关闭由 owner 裁,见 [§5](#5-ac2--hardened-runtime) |

**AC1 因此是「实质满足、字面未闭合」,不要写成 PASS。** 缺的那一步只有一件事:
桩换成一个真 provider(`--provider <id> --model <id>`),两轮即可 —— 需要一个可用凭据。

**所有格子都没有 FAIL,所以本票不产 bug 票。** 三件跑出来、值得留下的事实分别在
[§6 观测项](#6-观测项setuid-二进制在围栏内不可-exec)、[§5.1 前置为假](#51-票面写的前置是假的)
与 [§8 三个坑](#8-三个把人绊住的坑)。

八轮原始输出(四臂 × 2 轮)。ad-hoc 两臂每轮 **21 pass / 0 fail / 2 跳过**,hardened 两臂每轮
**22 pass / 0 fail / 1 跳过**(多出的那一格是 `identity.hardenedRuntime`);合计 **172 pass / 0 fail**:
[`results/fenced.json`](results/fenced.json) · [`results/fenced-round2.json`](results/fenced-round2.json) ·
[`results/unfenced.json`](results/unfenced.json) · [`results/unfenced-round2.json`](results/unfenced-round2.json) ·
[`results/hardened.json`](results/hardened.json) · [`results/hardened-round2.json`](results/hardened-round2.json) ·
[`results/hardened-unfenced.json`](results/hardened-unfenced.json) ·
[`results/hardened-unfenced-round2.json`](results/hardened-unfenced-round2.json)。

## 2. 被测件

| 项 | 值 |
| --- | --- |
| 分支 / base | `ac-1144` @ `c3c58308f`(构建时的 `origin/alpha`) |
| 构建 | `OPENCODE_CHANNEL=prod bun run build && OPENCODE_CHANNEL=prod bun run package:mac`(在 `packages/ui-mac` 下) |
| 产物 | `packages/ui-mac/dist/mac-arm64/alpha-code.app`(457 MB) |
| `CFBundleIdentifier` / 版本 | `com.tide.alphacode` / `0.1.3` |
| `app.isPackaged` | `true` —— 主进程自报,逐轮记进 `identity.appStartingLine` |
| ext bundle | `Contents/Resources/alpha-ext/plugin.js` `sha256 72026e70…d07f80`,与分支内 `packages/ext/dist/plugin.js` **逐字节相同**(`identity.branchExtBundleSha256`) |
| 宿主 | macOS 26.3.1 / Darwin 25.3.0 arm64;zsh 5.9;node v22.22.3;bun 1.3.14 |
| 隔离 | `OPENCODE_TEST_ONBOARDING=1` → `$TMPDIR/opencode-onboarding-<uuid>/`;引擎端口由 `OPENCODE_PORT` 钉死;工作区与逃逸目标都是 `$HOME` 下的一次性 `mkdtemp`,跑完删除 |

四个 `.app` 副本(`dist/` 不入仓,跑完可删):

| 副本 | 怎么来的 | wrapper | 签名 |
| --- | --- | --- | --- |
| `alpha-code.app` | 直接构建 + `codesign --force --deep --sign -` | 带围栏 | ad-hoc,`flags=0x2(adhoc)` |
| `alpha-code-unfenced.app` | `ditto` 副本,只把 `plugin.js` 里 `WRAPPER_SCRIPT` 那一行换成 `exec "$ALPHA_REAL_SHELL" "$@"`,再 ad-hoc 重签 | 无围栏 | ad-hoc,ext sha `9cc40e89…c95d463` |
| `alpha-code-hardened.app` | `alpha-code.app` 的 `ditto` 副本,用**本机的 Developer ID** + `--options runtime` + **出厂 entitlements** 自底向上逐个 Mach-O 重签 | 带围栏 | `flags=0x10000(runtime)`,`TeamIdentifier=RQX6X6A635` |
| `alpha-code-hardened-unfenced.app` | `alpha-code-unfenced.app` 的同法重签 | 无围栏 | 同上 |

反向臂的变异**只发生在 `dist/` 里的那个副本上**;仓内一个字节都没动。那一行的替换脚本自带
「必须恰好命中 1 处」「`sandbox-exec` 出现次数必须正好少 1」两条断言,重算出的 ext bundle
`sha256 9cc40e89fa5e026048782823dba27a256c9ec8afad90cf3ccccb27ca8c95d463` 与 `#1076` 记录的
**逐字相同** —— 同一处变异可复现。

**工作区故意不放 `/private/tmp` 或 `/private/var/folders`**(与 `#1076` 同口径):那两条前缀本来
就在 profile 的可写闭集里,放进去会让「工作区内可写」恒真、测不出 `-D WORKDIR="$(pwd)"` 在打包态
解析成了什么。本轮工作区是 `$HOME/.ac1144-ws-XXXXXX`,正样本落盘 ⇒ WORKDIR 解析正确。

## 3. 驱动面 —— 缺的就是这一格

基线 §2.3:引擎有两条到 `cfg.shell` 的通路,argv 形状不同。

| 通路 | argv 形状 | `#1076` | 本轮 |
| --- | --- | --- | --- |
| prompt `!command` | `["-l","-c",script,"opencode",cwd]` | ✅ 驱动过 | ✅ 也跑(`baseline25.promptShell/*`,给 AC2 做同驱动面的对照) |
| shell **工具** | `["-c", cmd]` | ❌ 只在 runner 自己 spawn 的形状上跑过 | ✅ **由 agent 回合驱动**(`ac1.toolChain/*`) |

这一轮的链条是:

```
用户消息 → 引擎回合 → provider(见下)回一个 tool_call
        → 工具注册表解出 bash 工具 → tool/shell.ts 解码参数
        → collect() 扫出工作区外路径 → ask() 求值 permission ruleset
        → Shell.acceptable(cfg.shell) → ChildProcess.make(shell, ["-c", cmd])
        → ALPHA_GLOBAL_DIR/bin/zsh(wrapper)→ /usr/bin/sandbox-exec -f <profile> -D WORKDIR=...
```

runner 自己**不 spawn 任何 shell**:它只起 app、注册一个 provider、发一条会话消息、看磁盘。
工具那一格是从引擎回读的 transcript 里按 **callID** 认领的(`detail.partMatchedBy: "callID"`),
不是「取最后一个工具格」—— 后者在第二个回合起会读到上一回合的结果(本轮第一版 runner 就踩了
这一条,详见 [§8](#8-三个把人绊住的坑))。

### 3.1 `ask()` 怎么解决的 —— 没有改生产代码

`tool/shell.ts:283-284` 的 `ctx.ask({ permission: ShellID.ToolID, ... })`(`ShellID.ToolID === "bash"`)
在无人值守时会挂在 `Deferred.await` 上。本轮用的是**产品自带的配置入口**:

- `packages/opencode/src/config/config.ts:550` 读 `Flag.OPENCODE_PERMISSION`,把 JSON merge 进
  `cfg.permission`;
- `packages/core/src/v1/config/permission.ts` 的 `InputObject` 里 `bash` 与 `external_directory`
  都是已声明的键;
- `packages/ui-mac/src/main/sidecar-env.ts:100` 的 `PREFIXES` 含 `OPENCODE_`,该变量本身不触发
  credential-name veto ⇒ 原样传进 sidecar。

于是启动时带 `OPENCODE_PERMISSION={"bash":"allow","external_directory":"allow"}` 即可。
逐轮记进 `identity.opencodePermission`。

### 3.2 provider 是一个本地桩 —— **它不是真模型**

`--provider stub`(默认)起一个 loopback 的 OpenAI-compatible 桩,经**产品自带的**
`window.api.providers.add({ compat:"openai", baseURL:"http://127.0.0.1:<port>/v1", ... })` 注册
(与 [`2026-08-25-req105-1108-packaged-offline-xlsx`](../2026-08-25-req105-1108-packaged-offline-xlsx/README.md)
同法)。桩只决定「调哪个工具、参数是什么」,而且**工具名不写死** —— 它从引擎实际发过来的
`tools` 列表里挑 `bash`,挑不到就如实记下引擎给了什么。逐轮记录的 `exposedToolNames` 是:

```
alpha_echo, alpha_ping, alpha_register, alpha_reload, bash, edit, glob, grep,
question, read, skill, task, todowrite, webfetch, websearch, write
```

**这个桩不是真模型。** 桩之后的每一格都是打包产品自己的代码,但「模型自己决定去调 shell 工具」
这一步没有被验证。AC1 的字面要求是「真模型回合」,所以本轮**没有完全满足 AC1 的字面**;
差在哪、怎么补,写在 [§7](#7-未闭合与未验证项)。runner 已经接好真 provider 的入口:
`--provider <已注册的 providerID> --model <modelID>` 即可,不需要改脚本。

## 4. AC1 结果

语料与基线 §2.5 / `alpha-sandbox-escape.test.ts` 是同一套 7 条,只是这次由**工具**发出。
每格记的是「文件有没有落盘」。

| 语料 | 围栏 ON(`ac1.toolChain/*`) | 围栏 OFF |
| --- | --- | --- |
| `echo pwned > <target>` | blocked | **LEAKED** |
| `echo pwned >> <target>` | blocked | **LEAKED** |
| `/bin/sh -c 'echo pwned > <target>'` | blocked | **LEAKED** |
| `python3 -c 'open(...,"w").write("x")'` | blocked | **LEAKED** |
| `node -e 'fs.writeFileSync(...)'` | blocked | **LEAKED** |
| `nohup sh -c 'echo pwned > <target>'` | blocked | **LEAKED** |
| `ln -sf <target> link && echo pwned > link` | blocked | **LEAKED** |
| **正样本**:工作区内 `echo ok > inside.txt` | **落盘** | **落盘** |

按驱动面拆开(四轮 = fenced ×2 + hardened ×2,反向同),**零例外**:

| 驱动面 | 围栏 ON | 围栏 OFF |
| --- | --- | --- |
| `ac1.toolChain/*`(shell 工具,argv `["-c", cmd]`) | **28/28 不落盘** | **28/28 落盘** |
| `baseline25.promptShell/*`(prompt `!command`,= 基线 §2.5/§2.6 原驱动面) | **28/28 不落盘** | **28/28 落盘** |

全部 112 个 escape 格 `processStarted=true`、
`toolStatus="completed"`、`commandIntact=true`(引擎收到的 `state.input.command` 与桩发出去的
逐字相同)。内核层的真实回执:

```
zsh:1: operation not permitted: /Users/tide/.ac1144-escape-XXXXXX/pwned.txt
/bin/sh: /Users/tide/.ac1144-escape-XXXXXX/pwned.txt: Operation not permitted
PermissionError: [Errno 1] Operation not permitted: '/Users/tide/.ac1144-escape-XXXXXX/pwned.txt'
Error: EPERM: operation not permitted, open '/Users/tide/.ac1144-escape-XXXXXX/pwned.txt'
zsh:1: operation not permitted: link
```

链条确实经过 wrapper 也是观测出来的:从**工具派生出来的那个 shell 内部**把 wrapper 注入的两个
环境变量读回来,`ALPHA_SB_PROFILE` 与从 `cfg.shell` 推出的 profile 路径逐字相等、
`ALPHA_REAL_SHELL=/bin/zsh`(`ac1.toolChain/env reaches tool-spawned shell`)。

## 5. AC2 —— hardened runtime

### 5.1 票面写的前置是假的

`#1144` 与 `#1076` 都写着「本机无 Developer ID,只能 ad-hoc 签」。**实读这台机器:**

```
$ security find-identity -v -p codesigning
  1) …… "Apple Development: <个人开发者> (…)"
  2) …… "iPhone Distribution: Beijing yuanyuji Technology Co.,Ltd (RQX6X6A635)"
  3) …… "Developer ID Application: Beijing yuanyuji Technology Co.,Ltd (RQX6X6A635)"   ← 就是这一张
     3 valid identities found
```

第 3 条正是 `electron-builder.config.ts:157` 在 `ALPHA_SIGN=1` 时要找的那一种。
`#1076` 的两条死路都是**「没有 Developer ID」这个前提**的推论 —— 前提为假,推论作废。
(这正是本仓《勘破先于闸门设计》说的那一类:一条没跑过的全称事实同时决定了结论与后续动作,
而证伪它只需要跑一条命令。)

### 5.2 实际做了什么

对 `alpha-code.app` / `alpha-code-unfenced.app` 各做一份 `ditto` 副本,用上面那个
Developer ID + `--options runtime` + **出厂 `resources/entitlements.plist`(三键,不含
`disable-library-validation`)** 重签,然后跑同一套语料。签完观测到:

```
CodeDirectory v=20500 size=446 flags=0x10000(runtime) hashes=3+7 location=embedded
TeamIdentifier=RQX6X6A635
Runtime Version=26.2.0
codesign --verify --deep --strict  →  rc=0
codesign -d --entitlements -       →  allow-jit / allow-unsigned-executable-memory / device.audio-input
```

`#1076` 的第二条死路(必须加 `disable-library-validation` 才起得来)**在有 Team ID 之后不再存在**:
本轮签的是出厂三键,library validation 开着,app 照常启动。

### 5.3 结论

**hardened runtime 下,结论与未开时逐格一致。** 两个驱动面各 7 条、各 2 轮:

| 驱动面 | hardened + 围栏 ON | hardened + 围栏 OFF |
| --- | --- | --- |
| shell 工具(`ac1.toolChain/*`) | 14/14 不落盘 | 14/14 落盘 |
| prompt `!command`(`baseline25.promptShell/*`,= 基线 §2.5/§2.6 的原驱动面) | 14/14 不落盘 | 14/14 落盘 |

### 5.4 与出厂件仍然不同的三处(不要读成"等于出厂签名")

1. **`--timestamp=none`** —— 本轮不联网签,没有安全时间戳。出厂签名有,且公证要求有。
   时间戳关的是吊销判定,不改 hardened runtime 的运行期语义。
2. **未公证、未 staple。** 出厂件走公证;本轮没有。Gatekeeper 的首次评估路径因此不同
   (本轮是从终端直接执行二进制,产物从未被隔离标记)。
3. **签名工具/顺序不同。** 出厂是 electron-builder 的签名过程;本轮是自己按「所有 Mach-O
   自底向上 → 嵌套 bundle → 外层 app」逐个 `codesign`(`codesign --deep` 会漏掉
   `Electron Framework.framework/Versions/A/Libraries/*.dylib`,见 [§8](#8-三个把人绊住的坑))。
   内容相同,签名过程不同。

### 5.5 一条必须说清的反面

静态确认 `resources/entitlements.plist` 里没有 `com.apple.security.app-sandbox`
**不构成 AC2 的证据**。它只说明「不构成嵌套沙箱冲突」这个**前提**为真。
AC2 要的是在开着 hardened runtime 的签名产物上**真的把正反语料跑一遍** —— §5.3 是那一跑,
§5.4 是它与出厂件的差距。**是否据此关闭 AC2 由 owner 裁**,本文件不替它下结论。

## 6. 观测项:setuid 二进制在围栏内不可 exec

**这一格不判 PASS/FAIL** —— 围栏本身的行为按票面属于 Out of scope(REQ-138 已验收)。
但它是本轮跑出来的事实,记下来免得丢:

工具派生的 shell 里跑 `/bin/ps`,围栏臂给 `zsh:1: operation not permitted: /bin/ps`,
反向臂正常打印 pid。直接对同一份 profile 文本做的定性([`results/setuid-exec-observation.json`](results/setuid-exec-observation.json)):

| 二进制 | mode | setuid | 围栏内 exec | 无围栏对照 |
| --- | --- | --- | --- | --- |
| `/bin/ps` | `0o4755` | 是 | **拒绝** | 通过 |
| `/usr/bin/top` | `0o4555` | 是 | **拒绝** | 通过 |
| `/usr/bin/su` | `0o4755` | 是 | **拒绝** | 通过 |
| `/bin/ls` | `0o755` | 否 | 通过 | 通过 |
| `/usr/bin/wc` | `0o755` | 否 | 通过 | 通过 |
| `/usr/bin/git` | `0o755` | 否 | 通过 | 通过 |

profile 只写了 `(allow default)` + `(deny file-write*)`,所以这不是本仓 profile 的规则造成的 ——
是 macOS seatbelt 对**沙箱进程 exec setuid 二进制**的固有拒绝。
**用户可观察的后果**:agent 在工具里跑 `ps` / `top` 会拿到 `Operation not permitted`。
`#1076` 的误伤集 9 条里没有覆盖这一类。要不要把它登记为已知代价、或加进误伤集,由 owner 裁。

## 7. 未闭合与未验证项

1. **触发工具调用的不是真模型。** AC1 的字面要求是「真模型回合」;本轮是本地 OpenAI-compatible
   桩(§3.2)。桩之后的整条链都是产品代码,唯一没被验证的是「模型自己会不会决定调 shell 工具」——
   那是模型行为,不是本接缝的性质。补法:`bun run.ts --provider <真 providerID> --model <modelID>`,
   两轮(围栏臂 + 反向臂)即可,runner 不必改。本轮**没有**跑真模型:需要一个可用凭据,
   而那属于 owner 侧资源。
2. **AC2 与出厂件的三处差异**(§5.4)。
3. **公证后的产物没跑过。** 公证会 staple 一张票据并改变 Gatekeeper 首次评估;本轮无。
4. **单机单配置。** 一台 macOS 26.3.1 / arm64、宿主 `SHELL=/bin/zsh`。真 shell 是 bash/fish 的
   用户、Intel 机器、`Shell.args` 的 bash 分支都没跑过(与 `#1076` 同)。
5. **网络轴不在本票。** profile 是 `allow default`;见
   [`2026-08-25-network-egress-seam.md`](../../architecture/2026-08-25-network-egress-seam.md) 与 #1077。

## 8. 三个把人绊住的坑

1. **ad-hoc 重签的副本会卡在钥匙串 ACL 上,而症状是「没有 CDP page」。**
   反向臂是 `ditto` 副本 + 改一行 + ad-hoc 重签 ⇒ 代码身份变了 ⇒ Electron `safeStorage` 在
   原身份下建的钥匙串项 ACL 不匹配 ⇒ securityd 弹授权框 ⇒ 无人值守时主线程**永远**停在
   `SecItemCopyMatching → SecKeychainItemCopyContent → ClientSession::decrypt → mach_msg`,
   卡在**窗口创建与 sidecar fork 之前**。日志停在 `startup-timeline seq 1`,看起来像变异把 app 改坏了。
   证据(含 `sample` 主线程 43 帧原文、三组对照):[`results/keychain-acl-hang.json`](results/keychain-acl-hang.json)。
   **这与 `#1076` 那条 hardened 死路是同一个东西**,只是那边被归因给了 hardened runtime。
   解法:启动时加 Chromium 自带的 `--use-mock-keychain`,**并且四个臂一律带同一份启动参数**
   (逐轮记进 `identity.launchFlags`)。它只换 safeStorage 的托管后端,不碰 `cfg.shell` / wrapper /
   `sandbox-exec`。[`results/fenced-no-mock-keychain.json`](results/fenced-no-mock-keychain.json)
   是加这个开关**之前**的围栏臂(runner 的早期版本,还没有 `baseline25.promptShell` 那一组),
   逃逸 7/7 结论相同 —— 开关不改判定。
2. **`codesign --force --deep` 漏掉 `Electron Framework.framework/Versions/A/Libraries/*.dylib`。**
   带 `--options runtime` 时,那几个 dylib 保留旧签名 ⇒ library validation 拒:
   `libffmpeg.dylib … not valid for use in process: mapping process and mapped file (non-platform)
   have different Team IDs`,app 起不来。**注意这条报错和 `#1076` 记的那条字面几乎一样,
   但成因不同** —— 那边是「ad-hoc 没有 Team ID」,这边是「有 Team ID,但嵌套 dylib 没被重签」。
   解法:所有 Mach-O 自底向上逐个签 → 嵌套 `.framework` / `.app` → 外层 app。本轮 19 个 Mach-O。
3. **`#1076` §8 的第 2 条(打包会弄脏 43 个被追踪的图标文件)已经不成立。**
   本轮实测:`git ls-files packages/ui-mac/resources/icons` 返回 **0** 个文件,prod 打包跑完
   `git status --porcelain` 是 **0 行**。[alpha-code#1115](https://github.com/jinjunnn/alpha-code/issues/1115)
   已把该目录移出版本控制。**不要照抄旧结论,自己 `git status` 核一遍。**

顺带:`#1076` §8 第 1 条(不补 ad-hoc 重签 ⇒ SIGKILL/exit 137 且零输出)本轮**没有再复验** ——
直接照它的做法补了 `codesign --force --deep --sign -`,所以本轮不构成对那一条的新证据。

## 9. 跑法

```bash
cd packages/ui-mac
OPENCODE_CHANNEL=prod bun run build
OPENCODE_CHANNEL=prod bun run package:mac
cd ../..
codesign --force --deep --sign - packages/ui-mac/dist/mac-arm64/alpha-code.app   # 坑 1(#1076 §8)

# 反向对照臂:副本 + 只改 wrapper 那一行 + 重签
cd packages/ui-mac/dist/mac-arm64
ditto alpha-code.app alpha-code-unfenced.app
python3 - <<'PY'
p = "alpha-code-unfenced.app/Contents/Resources/alpha-ext/plugin.js"
old = 'exec /usr/bin/sandbox-exec -f "$ALPHA_SB_PROFILE" -D WORKDIR="$(pwd)" "$ALPHA_REAL_SHELL" "$@"'
s = open(p, encoding="utf8").read()
assert s.count(old) == 1
s2 = s.replace(old, 'exec "$ALPHA_REAL_SHELL" "$@"')
assert s2.count("sandbox-exec") == s.count("sandbox-exec") - 1
open(p, "w", encoding="utf8").write(s2)
PY
codesign --force --deep --sign - alpha-code-unfenced.app
cd ../../../..

# 四臂各跑一轮(hardened 两臂需要先按 §5.2 用 Developer ID + --options runtime 逐个 Mach-O 重签)
E=docs/verification/2026-08-26-req138-1144-packaged-shell-tool-chain
bun $E/run.ts --app packages/ui-mac/dist/mac-arm64/alpha-code.app                   --arm fenced
bun $E/run.ts --app packages/ui-mac/dist/mac-arm64/alpha-code-unfenced.app          --arm unfenced
bun $E/run.ts --app packages/ui-mac/dist/mac-arm64/alpha-code-hardened.app          --arm hardened
bun $E/run.ts --app packages/ui-mac/dist/mac-arm64/alpha-code-hardened-unfenced.app --arm hardened-unfenced
```

runner 退出码 = 有没有 FAIL。读它一律 `set -o pipefail`,不要用 `cmd | tail; echo $?`。
`--corpus one` 只跑第一条语料(冒烟用);`--provider <id> --model <id>` 换成真 provider。
