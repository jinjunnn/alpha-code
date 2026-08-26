---
title: REQ-138 AC4 —— 打包 Electron sidecar 上复跑沙箱正反语料
kind: verification
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-08-26
review_after: 2026-11-26
---

# alpha-code#1076 · REQ-138 AC4 打包态取证

票:[alpha-code#1076](https://github.com/jinjunnn/alpha-code/issues/1076) ·
父需求:[alpha-code#1074](https://github.com/jinjunnn/alpha-code/issues/1074)(REQ-138)**AC4** ·
实现票:[alpha-code#1075](https://github.com/jinjunnn/alpha-code/issues/1075) ·
基线:[`docs/architecture/2026-08-23-shell-sandbox-seam.md`](../../architecture/2026-08-23-shell-sandbox-seam.md) §2.5 / §2.6 / §2.8 / §5

> **AC4.** 基线 §2.5/§2.6 的正反语料在**打包后的 Electron sidecar** 里复跑,结论一致。

**未改任何生产代码。** 本目录只有取证脚本、一个签名夹具与结果 JSON。

## 0. 判据

父票 #1074 的 **I3**:每一格只记「**文件是否落盘**」,不记 exit code —— 基线 §2.5 实测
`nohup` 那条 exit 0 而文件未落盘,本轮打包态**同样复现**(`m2b.toolArgv/nohup detach`
`exitCode=0` 且 `landed=false`)。

第二条判据来自本仓的《观测手段自己有盲区》:**空输出不算「拦住了」**。所以每条语料的第一句
都是 `echo AC1076-STARTED`,只有在输出里看见这个标记(= 进程真的起来过)才允许把
「文件没落盘」读成「被拦住了」。29 格里没有一格是靠空输出判的。

## 1. 结论

| 矩阵 | 断言 | 结论 |
| --- | --- | --- |
| **1** | 打包产物启动后 `cfg.shell` 指向 wrapper | **PASS** |
| **2** | 逃逸语料在打包 sidecar 下**文件不落盘** | **PASS**(7/7 × 两种 argv 形状 × 2 轮) |
| **3** | 反向对照:围栏移除的打包构建下**落盘** | **PASS**(7/7 × 两种 argv 形状 × 2 轮全部 LEAKED) |
| **4** | 误伤集在打包 sidecar 下全通 | **PASS**(9/9 × 2 轮,与反向臂逐格相同) |
| **5** | 会写盘的 rc 在写禁止下的表现 | **实跑完成**,结论见 [§6](#6-矩阵-5会写盘的-rc),已回写基线 §5 |

四轮原始输出:[`results/fenced.json`](results/fenced.json) ·
[`results/fenced-round2.json`](results/fenced-round2.json) ·
[`results/unfenced.json`](results/unfenced.json) ·
[`results/unfenced-round2.json`](results/unfenced-round2.json) ——
每轮 **29 pass / 0 fail / 1 观测项**。

**没有 FAIL,所以本票不产 bug 票。** 未闭合的面写在 [§7 未验证项](#7-未验证项),
其中一条是我尝试过并失败的(hardened runtime),失败原因与证据一并留下。

## 2. 被测件

| 项 | 值 |
| --- | --- |
| 分支 / base | `ac-1076` @ `8e30bdb77`(构建时的 `origin/alpha`) |
| 构建 | `OPENCODE_CHANNEL=prod bun run build && OPENCODE_CHANNEL=prod bun run package:mac` |
| 产物 | `packages/ui-mac/dist/mac-arm64/alpha-code.app`(453 MB) |
| 签名 | ad-hoc(`codesign --force --deep --sign -`)。**必须补这一步** —— 见 [§8 两个把人绊住的坑](#8-两个把人绊住的坑) |
| `CFBundleIdentifier` / 版本 | `com.tide.alphacode` / `0.1.3` |
| `app.isPackaged` | `true` —— 主进程自报,逐轮记进 `identity.appStartingLine`:`app starting { version: '0.1.3', packaged: true, onboardingTest: true }`(`identity.appIsPackaged`) |
| ext bundle | `Contents/Resources/alpha-ext/plugin.js`,`sha256 72026e70…d07f80`,与分支内 `packages/ext/dist/plugin.js` **逐字节相同** |
| 宿主 | macOS 26.3.1 / Darwin 25.3.0 arm64;zsh 5.9;node v22.22.3 |
| 隔离 | `OPENCODE_TEST_ONBOARDING=1` → `$TMPDIR/opencode-onboarding-<uuid>/`;引擎端口由 `OPENCODE_PORT` 钉死;工作区/逃逸目标/rc 夹具都是 `$HOME` 下的一次性 `mkdtemp`,跑完删除 |

**工作区故意不放在 `/private/tmp` 或 `/private/var/folders`。** 那两条前缀本来就在 profile 的
可写闭集里,把工作区放进去会让「工作区内可写」这一格恒真 —— 测不出 `-D WORKDIR="$(pwd)"`
在打包态到底解析成了什么。本轮工作区是 `/Users/tide/.ac1076-ws-XXXXXX`(不在闭集内),
`m4.benign/workspace write (WORKDIR)` 落盘 ⇒ **WORKDIR 参数在打包 sidecar 里解析正确**。

## 3. 驱动面 —— 哪条路径是产品自己的

引擎有两条到 `cfg.shell` 的通路(基线 §2.3):

| 通路 | argv 形状 | 本轮怎么驱动的 |
| --- | --- | --- |
| prompt `!command` | `["-l","-c",script,"opencode",cwd]`(`Shell.args`) | **打包产品自己的 HTTP 路由 `POST /session/:id/shell`**,由 sidecar 内的 `SessionPrompt.shellImpl` 真派生 |
| shell 工具 | `["-c", cmd]` | 见下,**没有**在 sidecar 里驱动 —— 它需要一次真模型回合 |

第一条上整条链都是打包产品的代码:runner 只负责起 app、发一个 HTTP 请求、看磁盘。
凭据经 CDP 从 `window.api.awaitInitialization()` 取(与 `2026-08-25-req105-1108-packaged-offline-xlsx`
同法),`model` 字段给一个占位 ref —— `shellImpl` 只把它写进消息元数据,不做任何 provider 查找,
所以整轮**不需要任何模型或凭据**。

第二条(shell 工具的 argv 形状)本轮用一个**退一步但不靠推理**的办法覆盖(`m2b.*`):

1. 先从打包 sidecar 的 shell 里把它继承到的两个环境变量原样读出来 ——
   `SBP=<globalRoot>/sandbox/alpha-shell.sb`、`RSH=/bin/zsh`。这一条本身就是
   「env 有没有传进被 spawn 的 shell」的**直接观测**(`m2b.envReachesSidecarShell`);
2. 再用**读到的那两个值** + 打包产物落下的那个 wrapper,以工具的 argv 形状
   (`spawnSync(cmd, [], { shell: <cfg.shell>, cwd, env })`)把同一套语料跑一遍。

**口径**:这一格的父进程是 runner,不是 sidecar。它证明的是「打包态产出的 wrapper/profile
在工具 argv 形状下同样成立」,**不是**「shell 工具在 sidecar 里跑过了」。差别写在 [§7](#7-未验证项)。

## 4. 矩阵 1:`cfg.shell` 指向 wrapper

`GET /config?directory=<ws>` 从打包 sidecar 读回:

```
cfg.shell = /private/var/folders/.../opencode-onboarding-<uuid>/alpha-code-state/env/prod/bin/zsh
```

该文件的**实际内容**(runner 直接读盘,不是从常量推的):

```sh
#!/bin/sh
exec /usr/bin/sandbox-exec -f "$ALPHA_SB_PROFILE" -D WORKDIR="$(pwd)" "$ALPHA_REAL_SHELL" "$@"
```

同目录 `../sandbox/alpha-shell.sb` 的内容与 `SEATBELT_PROFILE` 逐字相同(原文见结果 JSON 的
`identity.profileText`)。三件事因此同时成立:插件在打包态装载了、hook 跑到了、
落点是 `ALPHA_GLOBAL_DIR`(不是 `<userData>`,与基线 §7 一致)。

## 5. 矩阵 2/3/4:正反语料与误伤集

反向臂 = 同一份产物的副本,**只改一行**:把 `Contents/Resources/alpha-ext/plugin.js` 里
`WRAPPER_SCRIPT` 的

```sh
exec /usr/bin/sandbox-exec -f "$ALPHA_SB_PROFILE" -D WORKDIR="$(pwd)" "$ALPHA_REAL_SHELL" "$@"
```

换成

```sh
exec "$ALPHA_REAL_SHELL" "$@"
```

再 ad-hoc 重签(`sha256 9cc40e89…c95d463`)。这正是基线 §2.6 的同一处变异。
**变异只发生在 `dist/` 里的那个副本上,仓内一个字节都没动**(`git status` 全程只有本目录的新增文件)。
每轮 runner 都把「这一臂的 bundle 到底是哪一份」记进 `identity.armMatchesBundle`,
并把从盘上读回的 wrapper 原文记进 `identity.wrapperText` —— 臂别是**观测**出来的,不是声明的。

| 语料(基线 §2.5 / `alpha-sandbox-escape.test.ts` 同一套 7 条) | 围栏 ON | 围栏 OFF |
| --- | --- | --- |
| `echo pwned > <target>` | blocked | **LEAKED** |
| `echo pwned >> <target>` | blocked | **LEAKED** |
| `/bin/sh -c 'echo pwned > <target>'` | blocked | **LEAKED** |
| `python3 -c 'open(...,"w").write("x")'` | blocked | **LEAKED** |
| `node -e 'fs.writeFileSync(...)'` | blocked | **LEAKED** |
| `nohup sh -c 'echo pwned > <target>'` | blocked(**exit 0**) | **LEAKED** |
| `ln -sf <target> link && echo pwned > link` | blocked | **LEAKED** |

两种 argv 形状(`m2.escape/*` prompt 形状、`m2b.toolArgv/*` 工具形状)各 7 条,各 2 轮 ——
围栏 ON **28/28 blocked**,围栏 OFF **28/28 LEAKED**。内核层的真实回执长这样:

```
(eval):1: operation not permitted: /Users/tide/.ac1076-escape-XXXXXX/pwned.txt
/bin/sh: /Users/tide/.ac1076-escape-XXXXXX/pwned.txt: Operation not permitted
PermissionError: [Errno 1] Operation not permitted: '/Users/tide/.ac1076-escape-XXXXXX/pwned.txt'
Error: EPERM: operation not permitted, open '/Users/tide/.ac1076-escape-XXXXXX/pwned.txt'
```

误伤集(基线 §2.8 的 7 条 + 工作区写 + `/private/tmp` 写),两臂**逐格相同**:

| 探针 | 观测到的事实(两臂一致) |
| --- | --- |
| 工作区内写(WORKDIR) | `inside.txt` 落盘 |
| `/private/tmp` 写 | 落盘 |
| `git init` + commit | 落盘,`git rev-parse HEAD` 给出 40 位 sha |
| `node` 写 TMPDIR | 落盘 |
| 读仓库文件 | 读到 `package.json` 头部 |
| `curl https://example.com` | `CURL=200` |
| `mkdir -p d1/d2/d3/d4` | 落盘 |
| `grep` | 命中数 1 |
| `which git node` | `/usr/bin/git` / `/opt/homebrew/bin/node` |

`node` 解析到 `/opt/homebrew/bin/node` 说明 PATH 来自**产品自己的** shell-env 探测
(app log:`[server] Loaded shell environment with -il (21 vars)`),不是 runner 的环境。

## 6. 矩阵 5:会写盘的 rc

基线 §5 第二条要的是「`.zcompdump` / 历史文件这类**会写盘的 rc**,在写禁止下什么表现」。
§2.7 的宿主 zshrc 恰好不写盘,所以本轮用产品自带的 A6 逃生阀
`ALPHA_ENV_ALLOWLIST_EXTRA=ZDOTDIR`(`sidecar-env.ts` 的 `EXACT` 里就有它)把 `ZDOTDIR`
指到一份**故意会写盘**的 rc 夹具上 —— 于是**引擎自己那条** rc-source 行
(`Shell.args` zsh 分支的 `source "${ZDOTDIR:-$HOME}/.zshrc"`)读的就是它。

夹具 `.zshrc` 三处写 + 一个 env marker:

```zsh
autoload -Uz compinit
compinit -u -d "<rcHome>/.zcompdump"          # 典型的 .zcompdump 写
print -r -- "rc ran ..." >> "<rcHome>/.rc-history"   # 历史文件式追加
print -r -- ok > "<rcHome>/.rc-ran"           # marker:区分「rc 没跑」与「rc 跑了但写不进去」
export AC1076_RC_SOURCED=1                    # rc 跑到了最后一行才会有
```

`<rcHome>` 在 `$HOME` 下,**不在**可写闭集内。

**实测结论(围栏 ON,2 轮一致):**

1. **rc 照常跑完。** `AC1076_RC_SOURCED=1`、`AC1076_ZSHENV_SOURCED=1` 都读得到 ——
   写被拒**没有**中断 rc,也没有中断随后的命令(命令输出完整)。
2. **三处写全部落不了盘。** 一轮里有 19 次 shell 派生,每次都 source 一遍这份 rc;
   `<rcHome>` 目录**自始至终只有 `.zshenv` 和 `.zshrc`**(`rcHomeBefore`/`rcHomeAfter` 逐轮记录)。
3. **用户什么都看不见。** 引擎那行是 `source ... >/dev/null 2>&1 || true`,
   rc 的 stderr 全被吃掉。把同一份 rc 在同一个受围栏 shell 里**不加抑制**地再 source 一次
   (`m5.rcErrorsAsSeenByUser`),才看得到真实回执:

   ```
   <rcHome>/.zshrc:4: operation not permitted: <rcHome>/.rc-history
   <rcHome>/.zshrc:5: operation not permitted: <rcHome>/.rc-ran
   RC-AFTER-SOURCE-CONTINUED
   ```

   注意**只有两行**:第 3 行的 `compinit -u -d <dump>` 写不进去时是**静默失败**,一个字都不报。
4. **反向臂同一份 rc 三处写全部落盘**(`.zcompdump` / `.rc-history` / `.rc-ran` 都出现)——
   证明这份夹具确实能测出「写得进去」这个已知的好,ON 臂的「没落盘」才是结论。

**因此对用户的实际影响是一句话**:宿主 rc 里往 `$HOME` 写的那些东西(completion 缓存、
历史文件、各种 `.cache` 落点)在工具派生的 shell 里会**静默失效**;命令本身照常工作,
代价是每次派生都重算 completion 而缓存永远存不下。这不是崩溃面,是成本面。
引擎的 shell 是非交互 `-c` shell,zsh 本来就不写历史,所以历史那半边在生产上不产生额外损失。

## 7. 未验证项

1. **shell 工具没有在 sidecar 里被真的调用过。** 本轮驱动的是 prompt `!command` 通路;
   工具通路要一次真模型回合(还要处理 `tool/shell.ts` 的 `ask()` 权限询问)才发得动。
   已覆盖的是:①两条通路取的是**同一个** `cfg.shell`(§4 实测);②工具的 argv 形状在打包产物的
   wrapper 上同样 7/7 拦住(§3 的 `m2b.*`)。**没覆盖的是**「shell 工具的执行链本身在打包
   sidecar 里跑一遍」。要补这一格,得把 `2026-08-25-req105-1108-packaged-offline-xlsx/run.ts`
   的本地模型桩接过来。
2. **hardened runtime 没测成。** 出厂包是 `hardenedRuntime: true` +
   `resources/entitlements.plist`(只在 CI 或 `ALPHA_SIGN=1` 且有 Developer ID 证书时),
   本机 `bun run package:mac` 产出的是 `flags=0x2(adhoc)`,**没有** runtime 位。
   我试了两次,两次都被本机签名条件挡住,证据留在:
   - [`results/hardened-blocked-libval.json`](results/hardened-blocked-libval.json) ——
     出厂三键 entitlements + `--options runtime` + ad-hoc:dyld 直接拒
     `... not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs`
     (ad-hoc 签名没有 Team ID,hardened runtime 会开 library validation)。
   - [`results/hardened-blocked-keychain.json`](results/hardened-blocked-keychain.json) ——
     加一键 `disable-library-validation`([`fixture/entitlements-hardened-adhoc.plist`](fixture/entitlements-hardened-adhoc.plist),
     **取证夹具,不是出厂 entitlements**)之后 app 起得来了,但主线程停在
     `SecItemCopyMatching → SecKeychainItemCopyContent → ClientSession::decrypt → mach_msg`
     等 securityd 的钥匙串授权决定(重签换了代码身份 ⇒ 旧 ACL 不匹配 ⇒ 无人值守时永远等),
     **在 sidecar 起来之前就卡住了**,拿不到任何本票要的观测。
   两条都是**本机重签的产物**,不是接缝的性质;但「hardened runtime 会不会影响 sandbox-exec」
   这个问题本轮**没有答案**,不要把 §4/§5/§6 的绿读成已经答了。可以静态确认的只有一条:
   `resources/entitlements.plist` 里**没有** `com.apple.security.app-sandbox`(三键全文见该文件),
   所以基线 §5「不构成嵌套沙箱冲突」的**前提**为真。
3. **单机单配置。** 一台 macOS 26.3.1 / arm64、宿主 `SHELL=/bin/zsh`。真 shell 是 bash/fish
   的用户、Intel 机器、以及 `Shell.args` 的 bash 分支都没跑过。
4. **网络轴不在本票**(profile 是 `allow default`,§5 的 `curl` 200 正是它)。见
   [`2026-08-25-network-egress-seam.md`](../../architecture/2026-08-25-network-egress-seam.md) 与 #1077。

## 8. 两个把人绊住的坑

留在这里是因为下一个跑打包验证的人一定会踩:

1. **`bun run package:mac` 出来的 `.app` 直接跑会被 SIGKILL(exit 137),而且零输出。**
   `identity: null` ⇒ electron-builder 跳过签名,但它之后还跑了 `@electron/fuses` 改主二进制 ⇒
   linker-signed 的 ad-hoc 签名失效 ⇒ macOS 直接杀,**连一行日志都没有**,长得像 app 自己崩了。
   补一句 `codesign --force --deep --sign - <app>` 就好。本票第一轮在这里损失了一轮。
2. **跑打包构建会弄脏 43 个被追踪的图标文件。** `packages/ui-mac/resources/icons/` 是生成目录
   却被 git 追踪(`scripts/copy-icons.ts` 按频道 `rm -rf` + `cp -R`)。本轮实测:prod 构建后
   `git status` 恰好 43 个 ` M`,全在该目录下。**打包跑完只还原这一个路径**
   (`git checkout -- packages/ui-mac/resources/icons`),别 `git add -A`。存量与闸见
   [alpha-code#1115](https://github.com/jinjunnn/alpha-code/issues/1115)。

## 9. 跑法

```bash
cd packages/ui-mac
OPENCODE_CHANNEL=prod bun run build
OPENCODE_CHANNEL=prod bun run package:mac
cd ../.. && git checkout -- packages/ui-mac/resources/icons        # 坑 2
codesign --force --deep --sign - packages/ui-mac/dist/mac-arm64/alpha-code.app   # 坑 1

# 围栏臂
bun docs/verification/2026-08-26-req138-1076-packaged-sandbox/run.ts \
  --app packages/ui-mac/dist/mac-arm64/alpha-code.app --arm fenced

# 反向对照臂:副本 + 只改 wrapper 那一行 + 重签
cd packages/ui-mac/dist/mac-arm64
ditto alpha-code.app alpha-code-unfenced.app
python3 - <<'PY'
p = "alpha-code-unfenced.app/Contents/Resources/alpha-ext/plugin.js"
s = open(p, encoding="utf8").read()
old = 'exec /usr/bin/sandbox-exec -f "$ALPHA_SB_PROFILE" -D WORKDIR="$(pwd)" "$ALPHA_REAL_SHELL" "$@"'
assert s.count(old) == 1
open(p, "w", encoding="utf8").write(s.replace(old, 'exec "$ALPHA_REAL_SHELL" "$@"'))
PY
codesign --force --deep --sign - alpha-code-unfenced.app
cd ../../../.. && bun docs/verification/2026-08-26-req138-1076-packaged-sandbox/run.ts \
  --app packages/ui-mac/dist/mac-arm64/alpha-code-unfenced.app --arm unfenced
```

`dist/` 不入仓,四个 `.app` 副本跑完可以直接删。runner 退出码 = 有没有 FAIL
(`set -o pipefail`;不要用 `cmd | tail; echo $?` 读它)。
