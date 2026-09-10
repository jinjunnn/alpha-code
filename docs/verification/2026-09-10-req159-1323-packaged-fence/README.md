---
title: REQ-159 U3 —— 出货形态下装上全量可写集,引擎还活着(alpha-code#1323)
kind: verification
status: active
owners:
  - alpha-code desktop maintainers
last_reviewed: 2026-09-10
---

# alpha-code#1323 · REQ-159 U3 出货形态合成取证

票:[alpha-code#1323](https://github.com/jinjunnn/alpha-code/issues/1323) ·
父需求:[alpha-code#1286](https://github.com/jinjunnn/alpha-code/issues/1286)(REQ-159)·
实现票:[alpha-code#1321](https://github.com/jinjunnn/alpha-code/issues/1321)(围栏落地,PR #1327)·
基线:[`docs/design/2026-09-09-req159-process-fence-baseline.md`](../../design/2026-09-09-req159-process-fence-baseline.md) §四 U3 / §五 子票 5 ·
落地形状:[`docs/architecture/2026-09-09-req159-process-fence.md`](../../architecture/2026-09-09-req159-process-fence.md) §1 / §2 / §4 / §7 ·
可写集:[`2026-09-08-derived-process-spawn-paths.md`](../../architecture/2026-09-08-derived-process-spawn-paths.md) §8.2(W1–W19)·
同形先例:[`2026-08-26-req138-1076-packaged-sandbox/README.md`](../2026-08-26-req138-1076-packaged-sandbox/README.md)

> **U3.** 打包产物 + Developer ID 签名 + hardened runtime + `utilityProcess` 的 node 运行时,装上 §8.2 全量可写集之后,
> 引擎起得来、连接器装得上、终端开得出、shell 工具跑得完、配置写得进、多工作区并集内全可写 —— 而集合外一个字节都写不进。

**未改任何生产代码。** 本目录只有取证脚本 [`run.ts`](run.ts)、反向臂补丁 [`fixture/unfenced-arm.patch`](fixture/unfenced-arm.patch)
(只存在于实验分支,**不合入**)与结果 JSON / 日志摘录。

## 0. 判据

- 每一格只记「**探针文件到底落没落盘**」,由 runner 进程 `existsSync` 实读;不记 HTTP 状态码,不记有没有报错。
- 每条会派生进程的探针命令第一句都是 `echo AC1323-STARTED`,输出里看不见这个标记就不许把「没落盘」读成「被拦住了」
  (本仓《观测手段自己有盲区》)。
- **反向臂先跑**:同一 runner、同一工作负载、同一探针,只换成拆掉围栏那一步的对照包 ⇒ 每个 escape 目标都必须落盘。
  它 32/32 绿之后,正向臂的 0 落盘才是结论。
- 「装载成功」不看 `rc`,看 sidecar 自己那行 `process fence applied: addon=<buildId> … profile=<N>B`(它在 `sandbox_init`
  之后还做了集合外写不进 / cwd 写得进的双向自证才打出来,见落地形状 §1)。

## 1. 结论

| 格 | 正向臂(fenced,出货产物) | 反向臂(unfenced,同签名对照包) | 关键 W 行 |
| --- | --- | --- | --- |
| 1 冷启动 | **PASS** health 200;`process fence planned: workspaces=1 … profile=2068B, compile attempts=1`;sidecar `process fence applied: addon=fence-20260910T021625526Z libsandbox=/usr/lib/libsandbox.1.dylib profile=2068B`;`GET /config` 的 `shell` 为 `null`(不指向 REQ-138 wrapper) | health 200;server.log 只有 `AC1323-UNFENCED: process fence deliberately skipped` | W3/W4/W5/W6(4 行致命项) |
| 2 装一个连接器 | **PASS** `POST /mcp` → `{"ac1323probe":{"status":"connected"}}`;探针在工作区落盘、在 esc **不落盘**;两处 provider 目录都真装出 **26 个顶层包 / 62 636 KB**,`<HOME>/.npm/_cacache` 在,`opencode.log` 里 0 条 `background dependency install failed` | connected;两处都落盘;两处目录同样 26 包 / 62 636 KB | W7 `~/.npm`、W6、W3 |
| 3 开终端 | **PASS** `POST /pty`(缺省)200 → `/bin/zsh -l`,`status:"running"`;经 ticket + WebSocket 在**登录 shell 里**敲一条命令:界内落盘,界外 `zsh: operation not permitted: <ISO>/esc/pty-default-fenced.txt`,命令跑到 `AC1323-PTY-DONE`;`POST /pty` 带 `command` 200,同样界内落 / 界外不落 | 两种 PTY 都 200,四个探针全落盘 | W15 `/dev/ptmx` `^/dev/ttys`、W13/W14 |
| 4 shell 工具 | **PASS** `POST /session/:id/shell` 200;输出 `AC1323-STARTED` … `done` … `(eval):1: operation not permitted: <ISO>/esc/shelltool-fenced.txt`(zsh 自己报的,**不是** `sandbox_apply` 的 exit 71 零执行);界内落盘 | 200,无 `not permitted`,界内 / 界外全落盘 | W1 |
| 5 写项目配置 | **PASS** `<alphaGlobalRoot>/alpha.jsonc` 在且 mtime 晚于本次启动;`<userDataPath>/alpha-engine-config/` 有 `opencode.json(c)` / `models.json` / `node_modules` / `package(-lock).json`;main.log 0 条 injection 失败;`GET /experimental/tool/ids` 含 `alpha_reload / alpha_register / alpha_echo / alpha_ping`(ext 确实装进了被围栏的 sidecar);`<workspace>/.code-puppy/ac1323-fenced.json` 落盘 | 同样全在 | W2 `<alphaGlobalRoot>`、W3、W1 |
| 6 多工作区 | **PASS** 经产品 store IPC 写入两个 draft tab → SIGKILL sidecar → 产品 crash self-heal 1 s 后 respawn → 第二代 `process fence planned: workspaces=3 (candidates=3, excluded=0, dropped=0), profile=2250B` + `process fence applied … profile=2250B`;`ws-a` / `ws-b` / `~/code-puppy` 三处全落盘;**集合外** `ws-c`(盘上存在、不在 store)`(eval):1: operation not permitted: <ISO>/ws-c/multi-fenced.txt`,以 `ws-c` 为会话目录写 `./multi-cwd-fenced.txt` 同样 `operation not permitted` | 第二代同样 `workspaces=3`;`ws-a` / `ws-b` / `~/code-puppy` / `ws-c` 四处全落盘 | W1 并集 |

**escape 目录终态(runner `readdirSync` 实读)**:fenced `[]`;unfenced `[mcp-unfenced.txt, pty-cmd-unfenced.txt, pty-default-unfenced.txt, shelltool-unfenced.txt]`。
onboarding 根的兄弟目录(`<ISO>/tmp/`)终态:fenced 只有根目录本身;unfenced 多一个 `outside-root-unfenced.txt` —— 这一条证明
W2/W3 是靠自己那两行放行的,**不是**靠 W12(见 §2.3)。

两臂各 **32 pass / 0 fail / 1 obs**;原始输出 [`results/fenced.json`](results/fenced.json) / [`results/unfenced.json`](results/unfenced.json),
两臂各自的 `main.log` / `server.log` / `utility.log`(路径已脱敏成 `<ISO>` / `<REAL_HOME>`)在 [`results/log-excerpts/`](results/log-excerpts/)。

**U3 闭合。** 没有一格红,所以本票不产 bug 票;没测的如实列在 [§5](#5-没测的如实记账)。

## 2. 测量口径

| | |
| --- | --- |
| 树 | `.worktrees/ac-1323`(`bash scripts/worktree-bootstrap.sh ac-1323` 建),base = `origin/alpha` `48f2d50a5`(含 `c55e89601`,PR #1327 = `#1321` 围栏落地) |
| 被测产物 | `packages/ui-mac/dist/mac-arm64/Code Puppy.app`,`com.tide.alphacode` **0.1.11**,487 MB。构建:`OPENCODE_CHANNEL=prod bun run --cwd packages/ui-mac build` → exit 0、**3 行 `✓ built in`**、`Loaded models.dev snapshot`;打包:同 U1 §7 的发版命令,只用 CLI 覆盖关掉公证 / 换 `dir` target(`-c.mac.notarize=false -c.mac.target=dir`),**没有改配置文件里的任何签名项** |
| 签名读数 | app:`Identifier=com.tide.alphacode` · `CodeDirectory … flags=0x10000(runtime)` · `Authority=Developer ID Application: Beijing yuanyuji Technology Co.,Ltd (RQX6X6A635)` · `TeamIdentifier=RQX6X6A635`;`Contents/Resources/alpha-fence/alpha_fence.node`:`flags=0x10000(runtime)` · `TeamIdentifier=RQX6X6A635`;`lipo -archs` = **`x86_64 arm64`**;`codesign --verify --deep --strict` **exit 0**(`valid on disk` / `satisfies its Designated Requirement`) |
| buildId | 正向臂 `.node` 烤进的 `fence-20260910T021625526Z`,与 sidecar 日志 `process fence applied: addon=fence-20260910T021625526Z` 逐字相同;反向臂包里是 `fence-20260910T022549262Z`(那一臂根本不 apply,只作身份记录) |
| 被测字节的标记检索 | `app.asar`(含字面 NUL,一律 `grep -a`):正向臂 `process fence applied` ×1 / `process fence plan FAILED` ×1 / `AC1323-UNFENCED` ×0;反向臂 `AC1323-UNFENCED` ×1 / `process fence applied` ×0(打包器把实验补丁 `return` 之后的死代码整段删掉了);两臂对照针 `AC1323-NONEXISTENT-NEEDLE` 都是 0(证明 grep 不会幻觉命中)。`alpha-ext/plugin.js` 两臂 sha256 逐字相同 `458fe90a…66c4c` |
| 运行时 | `navigator.userAgent` 读回 `Electron/42.3.3 Chrome/148.0.7778.218`;sidecar = `utilityProcess`(`--utility-sub-type=node.mojom.NodeService`,即 U1 §6.6 P1 那个落点)。Electron 内嵌 node 的版本**本轮没有重新量**(出货二进制的 `runAsNode` fuse 关着,`ELECTRON_RUN_AS_NODE` 无效),U1 §0 用同一个 `electron@42.3.3` 包量到 `node 24.15.0 / modules 146` |
| 宿主 | macOS Darwin 25.3.0 arm64;`/bin/zsh`;runner 跑在 bun 1.3.14 |
| 隔离 | 见 §2.1–§2.3;两臂各一棵一次性 `~/.ac1323-<arm>-XXXXXX/`,跑完删除;两臂前后各读一次真 HOME 的六个哨兵(prod userData / `alpha-code-state/env/prod` / `~/.npm` / `~/.config/opencode` / `~/.local/share/opencode` / `~/code-puppy` 的 mtime)**逐字相同** |
| 残留进程 | 两臂 `ps` 实读 **0**(按 app 路径 + CDP 端口两条轴);owner 的 `/Applications/Code Puppy.app` 全程未碰(见 §6.3) |

### 2.1 布局

```
~/.ac1323-<arm>-XXXXXX/                    ← 整棵树在真 HOME 之下(勘破 §7.4 括注:不能放 /private/tmp 或 $TMPDIR)
├── home/                                  ← 给 app 的 HOME;产品自己在这里建 code-puppy/(W1 默认工作区)、.npm/(W7)、.zsh_history(W8)
│   └── .zshrc                             ← 夹具,两行(§2.2)
├── tmp/                                   ← 启动时的 TMPDIR ⇒ 产品把 onboarding 根建在这里
│   └── opencode-onboarding-<uuid>/
│       ├── desktop/                       ← userData(W3;含 alpha-engine-config/、engine-scratch-cwd/、logs/)
│       ├── alpha-code-state/env/prod/     ← alphaGlobalRoot(W2;alpha.jsonc 落这里)
│       ├── data/ cache/ config/ state/    ← XDG 四根(W4 / W5 / W6 / state)
│       └── opencode-home/ session/
├── ws-a/  ws-b/                           ← 格 6 经 store IPC 进并集的两个工作区(各 git init)
├── ws-c/                                  ← 盘上存在、不在 store 里(集合外)
└── esc/                                   ← escape 目录,与 home 平级,不在任何一行 W 之下
```

### 2.2 为什么不是「给 app 设 HOME」—— 第一版布局被产品自己推翻

第一版照 `process-fence-engine.test.ts` 的形状只覆盖 `HOME`。跑完实读:隔离 `home/` 里除了我种下的 store 一个字节都没有,
而真 HOME 的 prod userData 多了一个 logs run、`alpha-code-state/env/prod/alpha.jsonc` 被重写、`~/.local/share/opencode/opencode.db`
多了四个会话。两条互相独立的原因,缺一不可:

1. **Electron 的 `app.getPath("appData")` 不看 `$HOME`**(按 passwd 家目录取)。`index.ts:509` 把 userData 定成 `<appData>/ai.opencode.desktop`,
   `alpha-environment.ts` 把 alphaGlobalRoot 定成 `<appData>/alpha-code-state/env/<env>` —— 两个根都落在真 HOME。
2. **产品会把 `HOME` 改回去。** `server.ts:211 preferAppEnv` 命中真 prod userData 里的登录 shell env 缓存 `alpha-shell-env.json`
   (它记着 `HOME=/Users/tide`),`Object.assign(process.env, cached)` ⇒ main 的 `process.env.HOME` 在计划围栏、fork sidecar 之前
   就被覆盖 ⇒ `os.homedir()` 派生的 `~/code-puppy` / `~/.npm` / XDG 四根也全部回到真 HOME,sidecar env 白名单再把它原样带下去。

所以根只能靠产品自己的 `OPENCODE_TEST_ONBOARDING=1` 改道(`index.ts:479-497`:userData / alpha 根 / XDG 四根 / `OPENCODE_DB=:memory:`
全部落到 `os.tmpdir()/opencode-onboarding-<uuid>`)。它的坑正是票面点名的那个:根在 `$TMPDIR` = `/private/var/folders` 之下,而那是 W12,
W2/W3/W4/W5/W6 那几格会恒绿。解法两步,都是产品自己的机制:

- 启动时 `TMPDIR=<ISO>/tmp`,让 onboarding 根落在真 HOME 之下(`os.tmpdir()` 读它);
- 隔离 HOME 的 `.zshrc` 写一行 `export TMPDIR="<生产的 /var/folders/…/T/>"` —— `preferAppEnv` 在新 userData 里没有缓存,
  会同步探测登录 shell 并按「真 export 赢」合并,于是 **sidecar 看到的 `$TMPDIR` 仍是出货那个 W12 路径**,与用户机器一致。
  `HOME` 这次没人改:探测用的最小 env 里 `HOME` 就是隔离值,`.zshrc` 不动它。

两臂都实读了 sidecar 的 env(shell 工具 `echo $HOME $TMPDIR $XDG_CONFIG_HOME`):
`HOME=<ISO>/home` · `TMPDIR=/var/folders/9m/…/T/` · `XDG_CONFIG_HOME=<ISO>/tmp/opencode-onboarding-<uuid>/config`。
main.log 同时记着 `Loaded shell environment with -il (12 vars)` + `req047: rebuilt shell env cache after successful probe`。

### 2.3 证明 W2/W3/W7 没落进 W12

- onboarding 根 `<ISO>/tmp/opencode-onboarding-<uuid>` 以 `~/.ac1323-…` 开头,不以 `/private/var/folders` 或 `/private/tmp` 开头(runner 断言);
- 格 4 的第三个 escape 目标 `<ISO>/tmp/outside-root-<arm>.txt` 是 **onboarding 根的兄弟**:正向臂 `operation not permitted` 不落盘、
  反向臂落盘。若 `<ISO>/tmp` 整棵在可写集里,这一格在正向臂会落盘;
- W7 = `<ISO>/home/.npm`,与根不同枝;正向臂里它被真的写出 `_cacache`。

顺带:`OPENCODE_TEST_ONBOARDING` 让引擎的 sqlite 走 `:memory:`,所以 W4 之下 `*.db / -wal / -shm` 这一小段本轮**没有被写过**
(`log/opencode.log` 仍在 W4 下真写);记进 §5。

## 3. 反向臂:同签名对照包

补丁 [`fixture/unfenced-arm.patch`](fixture/unfenced-arm.patch)(4 行,只加不删)在 `sidecar.ts` 的 `installProcessFence` 顶部
`console.warn("AC1323-UNFENCED: …")` + `return`,其余逐字不变;照同一条构建 + 同一条发版命令(只多 `-c.directories.output=dist-unfenced`)
再打一份,签名读数与正向臂逐项相同(`runtime` / `RQX6X6A635` / fat / verify exit 0)。围栏在出货形态是 fail-closed 的
(AC4:`start` 命令缺 `fence` 拒起、profile 不带 `(deny file-write*)` 拒起),所以反向臂只能从源码这一步跳过,不能像 #1076 那样改 `dist/` 里的文件
(`sidecar.js` 在 asar 完整性校验之内)。补丁打完即 `git checkout -- packages/ui-mac/src/main/sidecar.ts` 还原,`git diff` 为空。

## 4. 每格怎么驱动的(与产品路径的关系)

| 格 | 驱动 | 是不是产品自己的路径 |
| --- | --- | --- |
| 1 | 起 `Contents/MacOS/Code Puppy --remote-debugging-port=<p> --use-mock-keychain`,CDP 里 `window.api.awaitInitialization()` 取引擎 url / 口令(与 #1076 同法),`GET /global/health` | 是。口令是 main `randomUUID()` 经 `OPENCODE_SERVER_PASSWORD` 给 sidecar 的那个 |
| 2 | `POST /mcp` 起 [`packages/ui-mac/test-fixtures/process-fence/mcp-probe.mjs`](../../../packages/ui-mac/test-fixtures/process-fence/mcp-probe.mjs)(与 `process-fence-engine.test.ts` 同一个探针);provider 安装是引擎 config 装载时自己发起的后台 npm 安装,runner 只轮询两处 `node_modules/@opencode-ai/plugin/package.json` | 是。引擎经 `@npmcli/arborist` 在 sidecar 进程内安装 |
| 3 | `POST /pty`(缺省登录 shell)→ `POST /pty/:id/connect-token`(`x-opencode-ticket: 1`)→ `GET /pty/:id/connect?ticket=` 升级 WebSocket → 发一行命令 → `exit` → `DELETE /pty/:id`;另 `POST /pty` 带 `command:/bin/sh` | 是。与桌面终端面板同一组路由(`routes/instance/httpapi/groups/pty.ts`) |
| 4 | `POST /session` + `POST /session/:id/shell`,payload 显式给 `model`(`shellImpl` 不发 LLM 请求,勘破 §8.3 同一条) | 是;但**没有经过模型回合**,与 #1076 / #1321 同一条口径 |
| 5 | W2/W3 = sidecar 起来时自己跑的 `injectAlphaConfig`(在围栏之后);ext 装载 = `GET /experimental/tool/ids`;`<ws>/.code-puppy/…` 用 shell 工具 `mkdir -p .code-puppy && echo > …` | 前两条是;第三条**不是 `alpha_register`**(它要模型回合),只证明 W1 那条前缀下 `.code-puppy` 写得进 |
| 6 | CDP 里 `window.api.storeSet("opencode.global.dat","tabs", …)` 写两个 draft tab(与 tab 栏落盘同一条 IPC,读回逐字相同)→ `kill -9` sidecar 的 utilityProcess → main `sidecar exited { code: 9 }` → `sidecar self-heal scheduled { delayMs: 1000, attempt: 1 }` → `respawning sidecar { reason: 'structural' }` → 新一代 `spawnLocalServer` 重新计划(读 store)| 并集来源与计划器都是产品的;「让它重新计划」用的是产品的 crash self-heal,**不是**用户「重启 app」那条路(那条路在 onboarding 隔离下不可重现:根每次启动都换 uuid) |

## 5. 没测的(如实记账)

1. **没有发过一次真的模型请求。** shell 工具经 `POST /session/:id/shell` 直驱;`alpha_register` 没有经模型回合触发,格 5 的 `.code-puppy` 写入走的是 shell 工具。
   「模型 → 工具 → 写盘」那一段与 #1144 / 勘破 §8.8 同一条,不在本票。
2. **公证 / staple 没做**(owner 授权范围只到本机签名;U1 §4.1 同一条)。`spctl` 会判 `Unnotarized Developer ID`,那是预期读数。
3. **x86_64 那一片没有被执行过**(本机与 Electron 都是 arm64;判据止于 `lipo -archs` 两片都在)。
4. **W4 下的 sqlite 文件没被写过**(`OPENCODE_TEST_ONBOARDING` 强制 `OPENCODE_DB=:memory:`);W4 的 `log/opencode.log` 真写了。
5. **W10 / W16 / W17 / W18 / W19 没有被单独走到**(与 §8.2「未证伪 ≠ 可删」同一条);隔离 `.zshrc` 不跑 `compinit`,所以 W19 无观测。
6. **`~/.bash_history` 不在可写集**,本轮宿主 shell 是 zsh,没测 bash / fish。
7. **Electron 内嵌 node 的版本没有在出货二进制里重新量**(fuse 关着),引 U1 §0 的读数。
8. **单机单配置**:一台 arm64 Mac、一份签名身份、一个用户。
9. **格 6 的「并集重算」靠 SIGKILL 触发 self-heal**,没有走用户「打开新文件夹 → 下次启动」那条(U2 §2.4 描述的可观察面归子票 4)。

## 6. 这一轮把人绊住的坑(下一个跑打包验证的人一定会踩)

1. **`HOME` 覆盖会被产品自己改回去,而且不报错**(§2.2)。指纹:隔离 home 里空空如也、真 HOME 的 prod userData 多了一个 logs run。
   第一版布局就这样跑了一整臂,escape 探针「全落盘」看起来像仪器活着,其实是测错了树。判据只有一条:**先实读 sidecar 的 `$HOME`,再谈落盘。**
2. **第一版那一臂把四个会话写进了真 HOME 的 prod 引擎库**(`~/.local/share/opencode/opencode.db`,标题 `ac1323 unfenced`)、往 prod store
   的 `notification.list` 记了 4 条通知、把 prod `project` 表 `global` 行的 `worktree` 改成了隔离目录、并在 prod userData 留下一个 logs run。
   已逐项还原(会话 / message / part 各 4 / 8 / 8 行删除、4 条通知删除、`worktree` 回 `/`、logs run 删除),两份文件改前都留了副本;
   `alpha-code-state/env/prod/alpha.jsonc` 被产品自己的 reconcile 重写过一次(内容是产品生成的,不是我的数据),未回滚。
   `~/.npm` / `~/.config/opencode` / `~/code-puppy` 的 mtime 前后相同。
3. **owner 的 `/Applications/Code Puppy.app` 在本轮期间退出了**:它自己的 `utility.log` 记着 `22:28:56 sidecar exited { code: 0 }`(优雅退出),
   比本轮第一次起包(22:31:29)早 2.5 分钟;两臂 runner 开跑时读到的 `/Applications` 进程数都是 0。本轮的三种 kill(按 worktree `dist` 路径、
   按自己 app pid 的子进程、按自己的 CDP 端口)都匹配不到它,但**为什么退出本轮没有答案**,记在这里。
4. **打包器会把实验补丁 `return` 之后的代码整段删掉**,于是反向臂的 asar 里 `process fence applied` 是 0 —— 判「这一臂是哪份字节」只能靠
   补丁自己的标记(`AC1323-UNFENCED`),不能靠「原来的字符串还在不在」。
5. **`ps … | grep -c <pattern>` 会数到 grep 自己和 `zsh -c` 那一行**,读成「还有 2 个残留」;判残留用 `pgrep -f`。
6. 交互式 zsh 在没有任何 rc 文件的 HOME 里会起 `zsh-newuser-install` 向导并等键盘,PTY 里发的命令会被它吃掉 —— 隔离 HOME 至少要有一个空 `.zshrc`。

## 7. 跑法

```bash
# 构建 + 打包(正向臂)
OPENCODE_CHANNEL=prod bun run --cwd packages/ui-mac build              # 核对 3 行 `✓ built in`
cd packages/ui-mac && OPENCODE_CHANNEL=prod ALPHA_SIGN=1 \
  ./node_modules/.bin/electron-builder --mac -c.mac.notarize=false -c.mac.target=dir --config electron-builder.config.ts
# 先证明它是出货形态:codesign -dv 对 app 与 Resources/alpha-fence/alpha_fence.node 都要读到 flags=0x10000(runtime) 与
# TeamIdentifier=RQX6X6A635;lipo -archs 读到 x86_64 arm64;codesign --verify --deep --strict exit 0。

# 反向臂:实验分支上打补丁 → 同样构建 + 打包到 dist-unfenced → 立刻还原
git apply docs/verification/2026-09-10-req159-1323-packaged-fence/fixture/unfenced-arm.patch
OPENCODE_CHANNEL=prod bun run --cwd packages/ui-mac build
cd packages/ui-mac && OPENCODE_CHANNEL=prod ALPHA_SIGN=1 ./node_modules/.bin/electron-builder --mac \
  -c.mac.notarize=false -c.mac.target=dir -c.directories.output=dist-unfenced --config electron-builder.config.ts
git checkout -- packages/ui-mac/src/main/sidecar.ts

# 先反向臂,再正向臂(runner 退出码 = 有没有 FAIL;不要用 `cmd | tail; echo $?` 读它)
bun docs/verification/2026-09-10-req159-1323-packaged-fence/run.ts --app "packages/ui-mac/dist-unfenced/mac-arm64/Code Puppy.app" --arm unfenced
bun docs/verification/2026-09-10-req159-1323-packaged-fence/run.ts --app "packages/ui-mac/dist/mac-arm64/Code Puppy.app" --arm fenced
```

`dist/` 不入仓,`dist-unfenced/` 跑完删掉(它不在 `.gitignore` 里)。每臂约 3–4 分钟(冷启动 + 后台 provider 安装要网络 + 一次 self-heal respawn)。
