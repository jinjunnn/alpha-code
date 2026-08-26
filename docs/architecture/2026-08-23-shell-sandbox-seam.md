---
title: 工具执行要在哪一层围起来（勘破）
kind: architecture
status: active
owners:
  - alpha-code desktop maintainers
last_reviewed: 2026-08-26
review_after: 2026-11-26
---

# 三个候选接缝，只有一个不用收编上游

Alpha 在 `packages/ui-mac/src/shared/ext-capability-authorization.ts` 里声明了六种
能力，其中 `process:spawn`（本地 MCP 派生子进程）与 `engine:plugin`（在引擎进程内
执行 JS）是**授予即无约束**的：授权记录写进了 `ext-capability-grants`，但执行侧没有
任何一道机械边界。全仓 `grep -ril 'seatbelt\|landlock\|sandbox-exec\|bubblewrap'`
在 `packages/` 下**零命中**。

要补这道边界，先得回答一个只能靠**跑**回答的问题：**在这套引擎里，子进程的派生
到底能在哪一层拦住，而不必编辑上游文件？**

本仓记录在案最贵的返工形态是「手写一个别人文法的替身」，第二贵的是「前提为假的
闸门」——它不是少拦一个坏输入，是**拒载真实配置**。所以下面每条断言都来自本机
装着的那份代码的一次真实执行；凡未实跑的一律标「未验证」。

## 0. 测量口径

| | |
| --- | --- |
| 仓 | `alpha-code@fe2e042f1`（`origin/alpha`） |
| 宿主 | macOS 26.3.1 / Darwin 25.3.0 arm64（xnu-12377.91.3） |
| 运行时 | node v22.22.3；zsh 5.9 (arm64-apple-darwin25.0) |
| 被测对象 | `packages/core/src/shell.ts` 真模块（bun 直载）；`node:child_process.spawnSync`；`/usr/bin/sandbox-exec` |
| 观测面 | wrapper 收到的 argv、子进程 exit code、**探针文件是否真的落盘** |
| 日期 | 2026-08-23 |

取证脚本是一次性的，不入仓；结论以下面的原始输出为准。

## 1. 三个候选接缝

| | 接缝 | 覆盖面 | 收编代价 |
| --- | --- | --- | --- |
| C1 | `config` hook 改写 `cfg.shell` 为 wrapper | shell 工具 + prompt `!command` | **0** |
| C2 | `tool.execute.before` 改写 `args.command` | shell 工具 | 0，但见 §2.10 |
| C3 | 覆盖 `ChildProcessSpawner` layer | shell + MCP + LSP + 任何 spawn | **+1**，见 §2.9 |

## 2. 实跑事实

### 2.1 `Shell.acceptable()` 接受任意绝对路径

`packages/core/src/shell.ts` 的 `ok(file)` 是 `META[name(file)]?.deny !== true`——
未知名字查不到表项，`undefined?.deny !== true` 恒为真。实跑：

```
acceptable("<abs>/argv-probe.sh") = <abs>/argv-probe.sh
acceptable(undefined)             = /bin/zsh
acceptable("/nonexistent/xx")     = /bin/zsh
```

不存在的路径回落 `/bin/zsh`——**失败方向是安全的**（回落到真 shell，不是回落到空）。

### 2.2 Node `shell:<path>` 交给 wrapper 的 argv 恒为两项

```
argv[1]=-c
argv[2]=echo hello && pwd
argc=2
```

`packages/core/src/cross-spawn-spawner.ts` 把 `command.options.shell` 原样下传，
所以 wrapper 的契约只有一句：`$1` 恒是 `-c`，`$2` 恒是整条命令。

### 2.3 shell 工具**不**走 `Shell.args()`，但 prompt 的 `!command` 走

`Shell.args()` 在全仓只有一个调用点：`packages/opencode/src/session/prompt.ts:546`。
shell 工具走的是 `packages/opencode/src/tool/shell.ts` 的 `cmd()`，它用
`ChildProcess.make(command, [], { shell, ... })`——即 §2.2 的两项形状。

**两条执行路径，两种 argv 形状，但都从 `cfg.shell` 取 shell。**

### 2.4 wrapper 命名成真 shell 的 basename 后，meta 函数逐字节不可分辨

这是 §2.3 逼出来的：`Shell.args()` 按 `name()`（basename 小写）分支，未知名字落进
通用分支 `["-c", cmd]`，**会丢掉 rc-sourcing 与 `cd -- "$1"`**。把 wrapper 放在
`<userData>/bin/zsh` 之后实跑：

```
name(wrapper)  = zsh      posix(wrapper) = true      login(wrapper) = true
args(wrapper)  ≡ args(/bin/zsh)        ← 逐字节相同
```

于是一个 wrapper 同时覆盖两条路径，契约仍只有一行：

```sh
#!/bin/sh
exec /usr/bin/sandbox-exec -f "$ALPHA_SB_PROFILE" -D WORKDIR="$(pwd)" "$ALPHA_REAL_SHELL" "$@"
```

### 2.5 `sandbox-exec` 在 Darwin 25.3 可用，逃逸语料 4/4 拦住

profile：`(allow default)` + `(deny file-write*)` + 放行 `WORKDIR` / `/private/tmp` /
`/private/var/folders` / 若干 `/dev` 节点。

```
[A normal]        status=0   hello | <workdir>
[B write workdir] status=0   ok
[C escape $HOME]  status=1   zsh:1: operation not permitted: ~/Documents/…
[D escape /bin/sh]status=1   /bin/sh: …: Operation not permitted
[E escape python3]status=1   PermissionError: [Errno 1] Operation not permitted
[F escape nohup]  status=0   spawned          ← nohup 自己起来了
```

`nohup` 那条 exit 0 是 `nohup` 本身派生成功；**判据不是 exit code，是文件有没有落盘**：

```
clean: alpha-spike-e2e.txt   clean: alpha-spike-sh.txt
clean: alpha-spike-py.txt    clean: alpha-spike-nohup.txt
```

### 2.6 反向对照：撤掉围栏，同一套语料 4/4 落盘

同一个 runner、同一份语料，只把 wrapper 换成 `exec /bin/zsh "$@"`：

```
[C] status=0   [D] status=0   [E] status=0   [F] status=0
LEAKED: alpha-spike-e2e.txt    LEAKED: alpha-spike-sh.txt
LEAKED: alpha-spike-py.txt     LEAKED: alpha-spike-nohup.txt
```

**这一节是本文档里唯一能让 §2.5 成立的东西**：先证明这套语料能测出已知的坏，
§2.5 的全绿才是一个结论而不是一次空转。

### 2.7 登录形状（`-l -c <script> opencode <cwd>`）无回归

用 `Shell.args()` 真产出的 zsh 脚本（含 `.zshenv` / `.zshrc` source 与 `cd -- "$1"`）
跑，有围栏与无围栏输出一致、stderr 皆空：

```
status: 0   stdout: "RC-OK\n<workdir>\nopencode\n"   stderr: ""
```

### 2.8 误伤检查 7/7 通过

```
[OK] git init + commit      [OK] node 写 TMPDIR       [OK] 读仓库文件
[OK] curl（403 真响应）      [OK] mkdir -p 深目录       [OK] grep
[OK] which git node
```

### 2.9 C3 的替换管道存在，但没有外部入口

`packages/core/src/effect/layer-node.ts` 有完整的 `Replacements` 机制，
`packages/core/src/effect/app-node-builder.ts` 的 `build(root, replacements)` 暴露它。
但调用点全部在上游包内部：

```
packages/server/src/routes.ts:52
packages/opencode/src/server/server.ts:106
packages/opencode/src/effect/bootstrap-runtime.ts:15
```

Alpha 无处注入 ⇒ **C3 必须收编其中一个热文件**（`north-star-guard.sh` 的白名单
+1，且按 ADR-029 §3 须自带 ADR）。

### 2.10 C2 会污染权限扫描

`packages/opencode/src/session/tools.ts:116` 把 `{ args }` 交给 hook，`:123` 用**同一个
对象**执行 ⇒ 改写 `args.command` 确实生效。但 `tool.execute.before` 在 `execute`
**之前**，而权限扫描 `ask()`（`tool/shell.ts:263`）在 `execute` **之内** ⇒ 扫描会看到
被包裹后的命令，现有 `git push` 一类规则全部失配。

## 3. 裁决

**C1。** C3 被 §2.9 否掉（收编热文件），C2 被 §2.10 否掉（污染权限扫描）。

§2.3/2.4 推翻了两处原设计：

1. wrapper **必须**命名成真 shell 的 basename，不能叫 `alpha-shell`；
2. `config` hook 必须**包住用户的 `cfg.shell`**，不是替换它——`shell` 是合法 config 键
   （`packages/opencode/src/config/config.ts:174`），但不在任何 Settings UI 里，
   所以只有手改配置文件这一条 fail-open 路径；hook 每次配置加载都跑，天然重新断言。

## 4. 本接缝结构上管不到的面

| 面 | 状态 | 理由 |
| --- | --- | --- |
| shell 工具子进程 | 覆盖 | §2.2 |
| prompt `!command` | 覆盖 | §2.4 |
| `write`/`edit`/`read` | **不覆盖** | 进程内 FS（`packages/opencode/src/tool/write.ts:64`），子进程围栏管不到 |
| MCP stdio | 不覆盖 | `packages/opencode/src/mcp/index.ts:229` 独立 spawn；该文件已在收编白名单内（ADR-041）⇒ 在那里加围栏新增收编为 0 |
| LSP | 不覆盖 | `packages/opencode/src/lsp/launch.ts:11` 独立 spawn；**未收编** ⇒ +1 |
| 网络 | 不覆盖 | 本 profile `allow default`，§2.8 的 curl 通。网络轴勘破见 [`2026-08-25-network-egress-seam.md`](2026-08-25-network-egress-seam.md) |
| Windows | 不覆盖 | 无对应实现 |

## 5. 未验证 / 残余风险

- ~~未验证：Electron utilityProcess 内的行为。~~ **2026-08-26 在打包产物上实跑，结论一致**
  （[`#1076`](https://github.com/jinjunnn/alpha-code/issues/1076)，取证见
  [`docs/verification/2026-08-26-req138-1076-packaged-sandbox/`](../verification/2026-08-26-req138-1076-packaged-sandbox/README.md)）。
  prod 频道打包、`app.isPackaged=true` 的 sidecar 里：`cfg.shell` 指向 `ALPHA_GLOBAL_DIR/bin/zsh`，
  该文件内容与 `WRAPPER_SCRIPT` 逐字相同；§2.5 的 7 条语料**全部落不了盘**，同一套语料在
  **只把 wrapper 那一行换成 `exec "$ALPHA_REAL_SHELL" "$@"`** 的打包副本上**全部落盘**；
  §2.8 误伤集 9/9 通过，两臂逐格相同。两种 argv 形状各跑，各 2 轮，每轮 29 pass / 0 fail。
  该轮留下的两小块，**2026-08-26 由 [`#1144`](https://github.com/jinjunnn/alpha-code/issues/1144)
  各推进一步**（取证见
  [`docs/verification/2026-08-26-req138-1144-packaged-shell-tool-chain/`](../verification/2026-08-26-req138-1144-packaged-shell-tool-chain/README.md)）：

  1. **shell 工具的执行链在打包 sidecar 里跑通了。** 由一次 agent 回合触发
     （消息 → tool_call → 工具注册表 → `tool/shell.ts` → `ask()` → `cfg.shell` → wrapper →
     `sandbox-exec`），runner 自己不 spawn 任何 shell。`ask()` 用产品自带的 `OPENCODE_PERMISSION`
     解决，未改生产代码。§2.5 的 7 条语料在**工具通路**上 **28/28 不落盘**、反向臂 **28/28 落盘**
     （四轮 = 未开 hardened ×2 + 开 hardened ×2）。
     **仍未闭合的是「真模型」那一步**：决定去调 shell 工具的是一个本地 OpenAI-compatible 桩，
     不是真模型。桩之后的每一格都是产品代码；没被验证的是模型自己会不会选这个工具。
  2. **hardened runtime 测成了，结论与未开时逐格一致。** `#1076` 写的前提「本机无 Developer ID」
     **是错的** —— `security find-identity -v -p codesigning` 实读到一张
     `Developer ID Application: … (RQX6X6A635)`。用它 + `--options runtime` + **出厂三键 entitlements**
     重签（`flags=0x10000(runtime)`、`TeamIdentifier=RQX6X6A635`、`codesign --verify --deep --strict` 通过），
     两个驱动面各 7 条 × 2 轮：围栏 ON **28/28 不落盘**，围栏 OFF **28/28 落盘**。
     `#1076` 那两条「死路」都是前提为假的推论：加 `disable-library-validation` 不再必要；
     卡在钥匙串 ACL 的那条其实与 hardened runtime 无关，是**任何 ad-hoc 重签副本**都会撞的
     代码身份变更（`--use-mock-keychain` 可绕，两臂同参）。
     与出厂件仍有三处具名差异：无安全时间戳（`--timestamp=none`）、未公证未 staple、
     签名由 `codesign` 自底向上逐个 Mach-O 完成而非 electron-builder。是否据此关闭 AC2 由 owner 裁。
  - **静态确认 `packages/ui-mac/resources/entitlements.plist` 没有
    `com.apple.security.app-sandbox`**，只说明「不构成嵌套沙箱冲突」这个**前提**为真，
    **不构成** hardened runtime 那一条的证据。
- **新增残余（`#1144` 实测）：沙箱进程不能 exec setuid 二进制。** profile 只写
  `(allow default)` + `(deny file-write*)`，但 macOS seatbelt 固有地拒绝沙箱进程 exec setuid 程序：
  `/bin/ps`（`0o4755`）、`/usr/bin/top`（`0o4555`）、`/usr/bin/su` 在围栏内全部
  `Operation not permitted`，`/bin/ls`、`/usr/bin/wc`、`/usr/bin/git` 正常
  （无围栏对照全部通过，见该目录 `results/setuid-exec-observation.json`）。
  **用户可观察的后果**：agent 在 shell 工具里跑 `ps` / `top` 会拿到 `Operation not permitted`。
  §2.8 的误伤集没有覆盖这一类；要不要把它登记为已知代价、或补进误伤集，尚未裁决。
- ~~未验证：会写盘的 rc 脚本。~~ **2026-08-26 实跑**（同上目录 §6）。用产品自带的
  `ALPHA_ENV_ALLOWLIST_EXTRA=ZDOTDIR` 把引擎自己那条 `source "${ZDOTDIR:-$HOME}/.zshrc"`
  指到一份**故意会写盘**的 rc 上（`compinit -d` 写 `.zcompdump` + 历史式追加 + 一个 marker，
  三处写全在可写闭集外）。三句结论：
  1. **rc 照常跑到最后一行**（它 export 的变量在命令里读得到）；写被拒**不中断** rc，
     也不中断随后的命令。
  2. **三处写一次都没落盘** —— 一轮 19 次 shell 派生、每次都 source 一遍，rc 目录自始至终
     没多出任何文件；反向臂同一份 rc 三处写全部落盘，证明这份夹具能测出「写得进去」。
  3. **用户什么都看不见** —— `Shell.args` 那行是 `source ... >/dev/null 2>&1 || true`。
     把同一份 rc 不加抑制地再 source 一次才看得到真实回执：普通重定向报
     `operation not permitted`，而 **`compinit` 写不进去时是静默失败，一个字都不报**。

  **实际影响是成本面不是崩溃面**：宿主 rc 里往 `$HOME` 写的东西（completion 缓存这类）
  在工具派生的 shell 里静默失效，命令本身照常工作，代价是每次派生都重算 completion 而缓存
  永远存不下；引擎的 shell 是非交互 `-c` shell，zsh 本来就不写历史，历史那半边不产生额外损失。
- **`sandbox-exec` 被 Apple 标记为 deprecated**，但仍随系统分发（§2.5 实跑），
  且 Chrome 与 codex 均在用。无替代 API 之前这是唯一可用面。

## 6. 用法

本文档是 P0-1 实现票**开工前**的对照物：实现与合并前 review 都以这里的
§2 为基准。任何与 §2 冲突的断言，先复跑再改文档，不要改实现去迁就散文。
§5 的三条未验证项在实现票里必须变成实跑结论或显式风险接受。

## 7. 实现落地（文件轴，收编 0）

C1 选定后，文件轴按下述落地。此节校正 §2.4 里那处 spike 用的 `<userData>/bin`
路径假设——它在 spike 里成立，但**不是**实现的落点：

- **wrapper 与 profile 落在 `ALPHA_GLOBAL_DIR` 下**，即
  `ALPHA_GLOBAL_DIR/bin/<真 shell 的 basename>` 与
  `ALPHA_GLOBAL_DIR/sandbox/alpha-shell.sb`，**不落 `<userData>`**。原因是结构性的：
  C1 的 `config(cfg)` hook 跑在 `@alpha-code/ext` 包内，而 `app.getPath("userData")`
  只在 Electron **main** 里拿得到；`ext` 手上唯一能解析并 canonical 校验的 alpha 自有
  可写根就是 `ALPHA_GLOBAL_DIR`（`= <appData>/alpha-code-state/env/<environment>`，
  已被 `requireAlphaGlobalRoot()` 校验）。走它 = 保持 ext-only、收编 0；要落
  `<userData>` 反而得把路径经 sidecar-env 白名单从 main 透传过来，扩面且多改文件。
- **可写闭集（I2）= §2.5 那份**，登记为 `packages/ext/src/shell-sandbox.ts` 的
  `SEATBELT_PROFILE` 常量（单一权威；新增前缀改这里，`alpha-sandbox-seam.test.ts`
  逐 token 全等挡住拓宽）。
- **fail-closed（I1）**：wrapper/profile 装不上时 `cfg.shell` 被顶成 deny stub
  （`ALPHA_GLOBAL_DIR/bin/alpha-shell-denied`，可读拒绝 + exit 78），deny stub 也落不下
  时退到 `/usr/bin/false`——**任何情况都不回落裸 shell**。
- **§5 未验证项的状态**：§2.5/§2.6 的正反语料已实现为 darwin-only 单测
  （`alpha-sandbox-escape.test.ts`，真 `sandbox-exec`，CI/ubuntu 上 skip、本机 macOS 真跑），
  外加类边界探针（重定向 `>`/`>>`、`sh`/`python3`/`node` 解释器、`nohup` 脱离、
  指向工作区外的 symlink）。**§5 前两条已由 [`#1076`](https://github.com/jinjunnn/alpha-code/issues/1076)
  在打包产物上实跑闭合**（取证见
  [`docs/verification/2026-08-26-req138-1076-packaged-sandbox/`](../verification/2026-08-26-req138-1076-packaged-sandbox/README.md)）；
  它留下的两小块由 [`#1144`](https://github.com/jinjunnn/alpha-code/issues/1144) 接着跑
  （[取证目录](../verification/2026-08-26-req138-1144-packaged-shell-tool-chain/README.md)）——
  shell **工具**的执行链在打包 sidecar 里由 agent 回合驱动跑通、hardened runtime 下结论一致，
  仍未闭合的只剩「触发工具调用的是真模型」这一步与出厂签名形态的三处差异，均记在 §5。
- **本接缝结构上管不到的面**不变（§4）：进程内 FS 工具、MCP stdio、LSP、网络（#1077）、
  Windows。实现未声称超出该清单的保护。
