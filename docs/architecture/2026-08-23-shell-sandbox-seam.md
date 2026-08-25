---
title: 工具执行要在哪一层围起来（勘破）
kind: architecture
status: active
owners:
  - alpha-code desktop maintainers
last_reviewed: 2026-08-23
review_after: 2026-11-23
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

- **未验证：Electron utilityProcess 内的行为。** §2.1–2.8 都在裸 node 下跑。
  `packages/ui-mac/resources/entitlements.plist` 只有 hardened-runtime 三项、**没有**
  `com.apple.security.app-sandbox`，因此不构成嵌套沙箱冲突；但「打包后的 sidecar 里
  同样成立」这句话本身尚未实跑。实现票必须在打包产物上复跑 §2.5 + §2.6。
- **未验证：会写盘的 rc 脚本。** §2.7 的宿主 zshrc 恰好不写盘。会写
  `.zcompdump` / 历史文件的 rc 在写禁止下的表现未测。
- **`sandbox-exec` 被 Apple 标记为 deprecated**，但仍随系统分发（§2.5 实跑），
  且 Chrome 与 codex 均在用。无替代 API 之前这是唯一可用面。

## 6. 用法

本文档是 P0-1 实现票**开工前**的对照物：实现与合并前 review 都以这里的
§2 为基准。任何与 §2 冲突的断言，先复跑再改文档，不要改实现去迁就散文。
§5 的三条未验证项在实现票里必须变成实跑结论或显式风险接受。
