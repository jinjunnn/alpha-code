---
title: 引擎到底从哪些地方派生出会落盘的进程(勘破)
kind: architecture
status: active
owners:
  - alpha-code desktop maintainers
last_reviewed: 2026-09-08
review_after: 2026-12-08
---

# 票面写的两条路里,有一条的机理是错的

[`#1286`](https://github.com/jinjunnn/alpha-code/issues/1286)(REQ-159)开工前要回答四问。
本文档是那四问的**实跑**答案,以及一张比票面更宽的通路枚举。

票面的现状坐标里有一句需要更正:MCP stdio **不是**「经 `@opencode-ai/core/cross-spawn-spawner`
派生」。`packages/opencode/src/mcp/index.ts:241` 取到的 `ChildProcessSpawner` 只用在
`:459` 的 `pgrep`;真正派生 MCP server 的是 `:381` 的 `new StdioClientTransport(...)`,
它在 SDK 内部**直接** `cross-spawn`,与 effect 的服务层没有任何关系(§2.2 正反两臂实测)。
这条更正是决定性的:它把候选方案 C3(覆盖 `ChildProcessSpawner` layer)从「一次罩住两条」
降为「一条都罩不住」。

本仓记录在案最贵的返工形态是「手写一个别人文法的替身」,第二贵的是「前提为假的闸门」。
所以下面每条断言都来自本机装着的那份代码的一次真实执行,**并且每一条「没抓到」的结论都带一个
证明探针抓得到的正样本**;凡未实跑的一律标「未验证」。

## 0. 测量口径

| | |
| --- | --- |
| 仓 | `alpha-code@d240c79d7`(= `origin/alpha`,worktree `.worktrees/ac-1286-recon`) |
| 宿主 | Darwin 25.3.0 arm64(xnu-12377.91.3),macOS 26.3 |
| 运行时 | bun 1.3.14(`bun test`);node v22.22.3 |
| `effect` | **`4.0.0-beta.83`** —— 逐包读符号链接确认:`packages/core/node_modules/effect` 与 `packages/opencode/node_modules/effect` 都指向 `node_modules/.bun/effect@4.0.0-beta.83`。树里**同时装着** `effect@4.0.0-beta.74`,`bun why effect` 显示它的来源是 `hono-openapi@1.1.2 → @standard-community/standard-openapi → standard-json`(即 `@opencode-ai/enterprise` 那条链),**不在引擎派生路径上**。 |
| `@modelcontextprotocol/sdk` | `1.29.0` |
| `cross-spawn` | `7.0.6` |
| 被测对象 | 生产模块直载:`MCP.node` / `Pty.node` / `lsp/launch.ts` / `Config.Service` / `CrossSpawnSpawner.node`;真 `/usr/bin/sandbox-exec`;真子进程 |
| 观测面 | 被注入的记录型 spawner 收到的命令、MCP 协议回报的子进程自述(cwd/argv)、**探针文件是否真的落盘** |
| 日期 | 2026-09-08 |

取证脚本是一次性的,不入仓;结论以下面的原始输出为准。跑法:worktree 由
`bash scripts/worktree-bootstrap.sh ac-1286-recon` 建;探针放在 `packages/{opencode,core}/test/` 下
(需要 `@/` 与 workspace 别名),`cd packages/<pkg> && bun test <file>`(仓根跑 `bun test` 会撞
`do-not-run-tests-from-root`)。

## 1. 四问,各一句

1. **`ChildProcessSpawner` 这个 layer 能不能被外部覆盖?**
   机制本身可用(§2.1),但 **alpha 侧没有注入点**(§2.6,`build(root, replacements)` 的调用点
   19 处全在上游包内,`packages/ext` / `packages/ui-mac` **零命中**)。更要命的是:
   **就算注入进去也没用** —— MCP stdio(§2.2)、LSP(§2.3)、PTY(§2.4)**三条都不经过它**。
   **C3 出局,不是因为收编代价,而是因为覆盖面为零。**
2. **收编代价:** `packages/opencode/src/mcp/index.ts` 已在 ADR-041 白名单内 ⇒ 改它 **0 新 ADR**
   (实测守卫仍绿);`packages/opencode/src/lsp/launch.ts` **不在**白名单 ⇒ 改它当场判红,要
   **+1 条 ADR**(§2.7 四组实测,含控制臂)。
3. **版本:** 见 §0。第三方行为读的是 `node_modules` 里装的那份 `@modelcontextprotocol/sdk@1.29.0`
   的 `dist/esm/client/stdio.js`,并由 §2.2 的运行时实测交叉验证。
4. **对照臂:** §2.1 记录了一次**真实的假阴** —— 第一版探针的正样本臂也是空的,原因是测试夹具
   `withTmpdirInstance` 自己又 `Effect.provide` 了一份**未被替换**的 `CrossSpawnSpawner`。
   没有那条正样本臂,这份文档会以「MCP 不经 spawner」这个**正确结论**配上一个**坏掉的探针**发出去。

**另外三件票面没提、但同属「派生进程会落盘」的事:**

- **PTY 终端是第三条路,而且它已经被 REQ-138 的围栏罩住了**(`input.command` 缺省时)——
  `packages/core/src/pty.ts:167` 读 `Shell.preferred(cfg.shell)`。实测:cfg.shell 指向一个
  REQ-138 形状的 sandbox-exec wrapper 时,PTY 里的越界写**落不了盘**;同一 wrapper 去掉
  sandbox-exec 那一行,**落盘**(§2.4 ARM C/D)。
- **但 `pty.create` 接受调用方直接给的 `command`**,给了就**完全不读 `cfg.shell`**(§2.4 ARM B),
  而 `POST /pty` 是产品自己的 HTTP 面(`server/routes/instance/httpapi/groups/pty.ts`)。
- **`MCP.add`(`POST /mcp`)也绕开 config** —— `mcp/index.ts:681` 直接拿调用方给的
  `ConfigMCPV1.Info` 去连,不回读配置(§2.5)。这决定了「在 config hook 里改写 `cfg.mcp`」
  这条 0 收编的路**有洞**,而 `connectLocal` 是没洞的那个咽喉点。

## 2. 实跑事实

### 2.1 层替换机制可用 —— 以及第一版探针给出的假阴

`packages/core/src/effect/layer-node.ts` 的 `compile(root, replacements)` 按**节点名**替换
(`replacementMapFrom` → `resolve: (node) => replacementMap.get(node.name) ?? node`),
替换物可以是 `Node` 也可以是裸 `Layer`。用 `makeGlobalNode({ service: ChildProcessSpawner, ... })`
造的替身与 `CrossSpawnSpawner.node` **同名同 tag**:

```
NAMES {"source":"effect/process/ChildProcessSpawner","repl":"effect/process/ChildProcessSpawner",
       "sourceTag":"global","replTag":"global"}
MIN   {"out":"MIN-CONTROL","isProbe":true,"seen":["/bin/echo MIN-CONTROL"]}
```

`isProbe:true` = 从 context 拿到的就是替身;`seen` 非空 = 它确实在记录。**机制成立。**

**但第一版 MCP 探针的正样本臂是空的:**

```
PROBE-1 {"controlOut":"POSITIVE-CONTROL","recordedAfterControl":[], ... }
```

`/bin/echo` 真的跑了,而记录器一条都没收到。根因不在被测对象,在夹具:
`packages/opencode/test/fixture/fixture.ts:211`

```ts
}).pipe(Effect.provide(testInstanceStoreLayer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node)))
```

`withTmpdirInstance` 自己又提供了一份**没被替换**的 `CrossSpawnSpawner`,而它是更内层的
`provide` ⇒ 测试体里 `yield* ChildProcessSpawner` 拿到的是夹具那份,不是 `MCP.Service` 手上那份。
**这正是《本机验证陷阱》里「空输出 / 零命中 —— 观测手段自己瞎了」那一类**,而它唯一的暴露方式
就是那条正样本臂。§2.2 因此改成用 **MCP 自己代码里的 spawner 调用**当正样本。

### 2.2 MCP stdio 不经 `ChildProcessSpawner`(正反两臂,同一次编译)

探针:`LayerNode.compile(MCP.node, [[CrossSpawnSpawner.node, recorderNode]])`,起一个**真**的
本地 stdio MCP server(`test/fixture/mcp-lifecycle-stdio.ts`,与上游 lifecycle 测试同一份夹具)。

- **正样本臂**取自 MCP 自己的代码:`mcp/index.ts:459` 的 `spawner.spawn(pgrep -P <pid>)`,
  它在 layer 的 finalizer 里对每个 stdio client 跑一次。它出现在记录里 ⇒ 记录器**确实是**
  `MCP.Service` 手上那个 spawner。
- **子进程真的起来了**:它通过 MCP 协议把自己的 `cwd` 和 `argv` 报了回来。

```
PROBE-1-INSIDE {
  "mcpToolKeys": ["alpha1286_current_directory","alpha1286_command_arguments"],
  "childReportedCwd": "/private/var/folders/.../opencode-test-avijlx7y2kd",
  "childReportedArgv": "[\"ALPHA-1286\"]",
  "recordedDuringTest": []
}
PROBE-1-AFTER   {"recorded":["pgrep -P 93075"]}
PROBE-1-VERDICT {"sawPgrep":true,"sawMcpCommand":false}
```

**结论:MCP server 的派生一次都没经过被替换的 spawner。** 机理见本机装着的
`@modelcontextprotocol/sdk@1.29.0` 的 `dist/esm/client/stdio.js`:第 1 行
`import spawn from 'cross-spawn'`,第 65 行 `this._process = spawn(command, args, {...})` ——
SDK 自己派生,不经任何可注入的服务。

### 2.3 LSP 不经 `ChildProcessSpawner`(同一次运行里两臂)

同一个测试里先跑正样本、再跑生产的 `packages/opencode/src/lsp/launch.ts` 的 `spawn`:

```
PROBE-2 {
  "controlOut": "SEAM-CONTROL",
  "recordedAfterControl": ["/bin/echo SEAM-CONTROL"],
  "lspOut": "LSP-LAUNCH-PROBE",
  "recordedAfterLsp": ["/bin/echo SEAM-CONTROL"],
  "newlyRecordedByLsp": []
}
```

子进程真的跑了(`lspOut` 是它的 stdout),而记录器没多一条。链路:
`lsp/launch.ts:11 → Process.spawn`(`packages/opencode/src/util/process.ts:63`)`→ cross-spawn`。
`lsp/launch.ts` 是 LSP 全部派生的**唯一**咽喉:`lsp/server.ts` 里 10 处、`lsp/lsp.ts:174` 一处,
全部走它。

### 2.4 PTY:不经 spawner;缺省读 `cfg.shell`(⇒ 已被 REQ-138 罩住),给了 `command` 就不读

`packages/core/src/pty.ts:167`

```ts
const command = input.command || Shell.preferred(Config.latest(yield* config.entries(), "shell"))
```

四臂一次跑完(记录器的正样本臂在同一次编译里):

```
PROBE-3 {
  "runtimeImplUsed": "pty.bun.ts (bun-pty)",
  "controlOut": "SEAM-CONTROL",
  "recordedAfterControl": ["/bin/echo SEAM-CONTROL"],
  "armA": { "command": ".../bin/zsh", "args": ["-l"] },
  "armB": { "command": ".../bin/direct-probe", "args": ["ARM-B"] },
  "armC_fenced": { "escapeFileLanded": false, "insideWriteLanded": true },
  "armD_bare":   { "escapeFileLanded": true,  "insideWriteLanded": true },
  "observedFile": [
    "STUB-SHELL argv0=.../bin/zsh args=-l",
    "DIRECT argv0=.../bin/direct-probe args=ARM-B",
    "FENCED-WRAPPER argv0=.../bin/fenced-zsh args=",
    "BARE-WRAPPER argv0=.../bin/bare-zsh args="
  ],
  "recordedByEffectSpawnerAtEnd": ["/bin/echo SEAM-CONTROL"]
}
```

四句读法:

1. **ARM A** —— 不给 `input.command` 时,PTY **逐字**用 `cfg.shell` 当命令,并按
   `Shell.login()` 补 `-l`。这就是 C1 wrapper 生效所需的全部结构条件。
2. **ARM B** —— 给了 `input.command`,`cfg.shell` 一次都没被读。`Pty.CreateInput`
   (`packages/schema/src/pty.ts:40`)允许 `command` / `args` / `env`,而 `POST /pty` 是产品
   自己的 HTTP 面 ⇒ 这条路**结构上不可能**被 C1 罩住。
3. **ARM C/D** —— cfg.shell 指向一份 REQ-138 形状的 wrapper(`exec /usr/bin/sandbox-exec -f <profile>
   -D WORKDIR=<dir> …`,profile 逐字取自 `packages/ext/src/shell-sandbox.ts` 的 `SEATBELT_PROFILE`)时,
   写 `$HOME` 的那次**落不了盘**、写 WORKDIR 的那次落得了;把 wrapper 里 sandbox-exec 那一行去掉,
   **同一次写落盘**。反向臂证明这套夹具测得出「写得进去」,所以 ARM C 的绿是结论不是空转。
4. **记录器**自始至终只有正样本那一条 ⇒ PTY 的派生**不经** `ChildProcessSpawner`
   (`pty.ts:183` 走 `#pty` 条件导出)。

### 2.5 `cfg.mcp` 可以在 config hook 里改写 —— 但 `MCP.add` 绕开它

`Config.Service.get()` 返回的是 `InstanceState` 里缓存的**同一个对象**
(`packages/opencode/src/config/config.ts:611`),而 `mcp/index.ts:528` 与
`packages/opencode/src/plugin/index.ts:254` 的 `config` hook 读/写的是同一个 `get()`。实测:

```
PROBE-4a {"toolKeys":[]}                            ← 控制臂:不改 cfg.mcp 时无此 server
PROBE-4b {
  "sameObject": true,
  "toolKeys": ["alpha1286_current_directory","alpha1286_command_arguments"],
  "childReportedArgv": "[\"VIA-WRAPPER\"]",
  "wrapperLog": ["MCP-WRAPPER args=/Users/tide/.bun/bin/bun .../mcp-lifecycle-stdio.ts VIA-WRAPPER"]
}
```

把 `cfg.mcp["x"].command` 前置一个 wrapper,MCP **真的**经 wrapper 起了 server,子进程自述的
argv 与 wrapper 自己的日志两边对得上。**这条路在生产里已经在跑**:`packages/ext/src/plugin.ts:113`
的 config hook 已经通过 `mergeProjectConfig`(`project-config.ts:138`)往 `cfg.mcp` 写项目级条目。

**洞在 `mcp/index.ts:681`:**

```ts
const add = Effect.fn("MCP.add")(function* (name: string, mcp: ConfigMCPV1.Info) {
  const s = yield* InstanceState.get(state)
  s.config[name] = mcp
  yield* createAndStore(name, mcp)      // ← 用调用方给的 command,不回读 cfg
```

它的调用方是 `POST /mcp`(`server/routes/instance/httpapi/handlers/mcp.ts:17`,payload 里带
`config`)。所以「只改 config」的方案**对 UI 新增 MCP 这条路无效**;`connectLocal`
(`mcp/index.ts:375`)才是配置驱动与 `add` 驱动共同的唯一咽喉。

### 2.6 C3 依旧没有外部入口

`build(root, replacements)` / `LayerNode.compile` 在 `packages/*/src` 下的**全部** 19 个调用点:

```
core/src/location-services.ts:98,106   core/src/npm.ts:257
core/src/effect/app-node-builder.ts:16 server/src/routes.ts:52
cli/src/tui.ts:18                      cli/src/commands/handlers/serve.ts:43
sdk-next/src/opencode.ts:14            opencode/src/config/tui.ts:264
opencode/src/plugin/tui/runtime.ts:1086 opencode/src/effect/bootstrap-runtime.ts:15
opencode/src/effect/app-node-builder-v1.ts:9 opencode/src/server/server.ts:106
opencode/src/installation/index.ts:330 opencode/src/cli/cmd/run/variant.shared.ts:139,200
opencode/src/cli/cmd/debug/scrap.ts:12 opencode/src/cli/tui/layer.ts:7
opencode/src/acp/service.ts:581,588
```

`grep -rn "AppNodeBuilder.build\|LayerNode.compile" packages/ext packages/ui-mac` → **零命中**。
与 [`2026-08-23-shell-sandbox-seam.md`](2026-08-23-shell-sandbox-seam.md) §2.9 的结论一致
(路径已按当前 HEAD 更新)。

### 2.7 north-star 守卫白名单:实读,四组,带控制臂

在干净 worktree 上逐条跑 `bash scripts/north-star-guard.sh`:

| 改动 | 守卫 | 输出 |
| --- | --- | --- |
| (基线,干净树) | **exit 0** | `✓ zero upstream package edits` |
| 改 `packages/opencode/src/mcp/index.ts` | **exit 0** | 同上(ADR-041 白名单第 129 行) |
| 改 `packages/opencode/src/lsp/launch.ts` | **exit 1** | `✗ upstream files modified … packages/opencode/src/lsp/launch.ts` |
| 改 `packages/opencode/src/util/process.ts` + `packages/core/src/process.ts` | **exit 1** | 两条都被点名 |

ADR-043 的结构性谓词(新增 alpha 自有文件)也实测了,**带控制臂** —— 两个文件都先 commit 再改,
让它们真的进 `DMR`:

```
    · alpha 自有(住在上游包里,但 origin/dev 从来没有过这条路径)—— 不算上游改动:
      packages/opencode/src/lsp/alpha-1286-probe.ts
    ✗ upstream files modified/deleted/renamed (fork-sync would conflict):
      packages/opencode/src/lsp/plain-1286-probe.ts
```

`alpha-` 前缀的豁免、无前缀的被点名 ⇒ 谓词测得出已知的坏。
(第一次测量是把新文件留成 untracked 就跑守卫 —— 那次的绿是**假绿**:untracked 文件根本不在
`git diff` 里,守卫压根没看见它。记在这里以免下一个人重犯。)

**与上游镜像的实际偏离**(`git diff origin/dev HEAD -- <file>`):

```
packages/opencode/src/mcp/index.ts   : 已偏离(+74 −4)
packages/opencode/src/lsp/launch.ts  : 与 origin/dev 逐字节相同
packages/opencode/src/util/process.ts: 与 origin/dev 逐字节相同
packages/core/src/process.ts         : 与 origin/dev 逐字节相同
```

## 3. 到达「派生进程真正落盘」的全部通路

判据是**进程从哪里被创建**,不是它叫什么。下表按创建原语分组;`packages/*/src` 下逐条实读,
CLI-only 与构建脚本单列。

| # | 通路 | 创建原语 | 今天被 C1(cfg.shell wrapper)罩住? | agent / 用户可达 |
| --- | --- | --- | --- | --- |
| 1 | shell 工具 | `tool/shell.ts:484` → `ChildProcessSpawner` | **是**(`cfg.shell`) | 是(工具调用) |
| 2 | prompt `!command`(shellImpl) | `session/prompt.ts:607` → `ChildProcessSpawner` | **是**(`prompt.ts:564` 读 `cfg.shell`) | 是 |
| 3 | command 模板里的 `!`…`!` 展开 | `session/prompt.ts:1446` → `Process.text` → cross-spawn | **是**(`:1442` 读 `cfg.shell`) | 是 |
| 4 | **MCP stdio(local)** | `mcp/index.ts:381` → MCP SDK → cross-spawn | **否**(§2.2) | 是(配置 + `POST /mcp`) |
| 5 | **LSP server** | `lsp/launch.ts:11` → `util/process.ts:63` → cross-spawn | **否**(§2.3) | 是(打开文件即触发) |
| 6 | **PTY 终端(缺省)** | `core/src/pty.ts:183` → `#pty`(node-pty / bun-pty) | **是**(§2.4 ARM A/C) | 是(终端面板) |
| 7 | **PTY 终端(`input.command`)** | 同上 | **否**(§2.4 ARM B) | 是(`POST /pty` payload) |
| 8 | **formatter** | `format/index.ts:86` → `AppProcess` → `ChildProcessSpawner` | **否**(直接 exec 二进制,不经 shell) | 是(write/edit 之后自动跑) |
| 9 | ripgrep(grep/glob 工具) | `core/src/ripgrep.ts:109`、`ripgrep/binary.ts:39` → `ChildProcessSpawner` | 否(固定二进制,只读用途) | 是 |
| 10 | git(project 探测) | `opencode/src/project/project.ts:119` → `ChildProcessSpawner` | 否(固定 `git`) | 间接 |
| 11 | MCP 子进程收割 | `mcp/index.ts:459` `pgrep` → `ChildProcessSpawner` | 否(固定 `pgrep`) | 间接 |
| 12 | IDE 扩展安装 | `ide/index.ts:40` → `Process.run` → cross-spawn | 否 | 用户动作 |
| 13 | managed config 读取 | `config/managed.ts:60` `plutil` → cross-spawn | 否(固定 `plutil`) | 间接 |
| 14 | formatter 能力探测 | `format/formatter.ts:225,243` → `Process.text/run` | 否(固定 `--help`) | 间接 |
| 15 | `killTree`(win32) | `core/src/shell.ts:37` `taskkill` → `node:child_process` | n/a(非 darwin) | 间接 |
| — | CLI-only(`cli/cmd/{db,github.handler,plug,pr,providers,session,uninstall}.ts`) | cross-spawn / `child_process` | 否 | **alpha 不发 CLI** |
| — | Electron main(`ui-mac/src/main/*`) | `execFile` / `spawnSync` / `utilityProcess.fork` | 不在本接缝辖区 | 产品自身 |

本文档**本次实测**的是第 4/5/6/7 行(§2.2–§2.4)。第 1/2 行的「是」继承自
[`2026-08-23-shell-sandbox-seam.md`](2026-08-23-shell-sandbox-seam.md) §2.2–§2.4 与
[`#1144`](https://github.com/jinjunnn/alpha-code/issues/1144) 的打包实测;**第 3 行的「是」是读源码得出的**
(`prompt.ts:1442` 取 `Shell.preferred(cfg.shell)`,`:1446` 把它当 `shell:` 选项交给 cross-spawn),
**本次没有实跑**。第 8–15 行只做了 import 点实读,没有跑围栏语料。

**「单一权威」应该建在哪一层(AC1)。** 上表是**读**出来的,不是判据。要让它成为 AC1 要求的
单一权威,判据必须键在**创建原语**上,而不是在文件清单上 —— 理由与 ADR-043/ADR-044 相同:
清单对新成员默认放行,谓词对新成员默认覆盖。可用的结构性事实,全部在本次实读里成立:

- 引擎侧能创建 OS 进程的原语只有四类:`cross-spawn` 的默认导出、`node:child_process` 的
  `spawn/spawnSync/exec/execFile/fork`、`#pty` 条件导出、以及 `ChildProcessSpawner.spawn`。
- 前三类在 `packages/{core,opencode,server}/src` 下的 import 点是**有限且可枚举**的
  (§3 表右列即为当前全集)。
- 反向用例(AC1 明确要求)因此有现成形状:**新增一个未登记的 import 点必须判红** ——
  与 `north-star-guard.test.ts` 造「已知该红的输入」同一套做法。

这只是判据落点的建议;把它实现成什么样属于实现票,**本文档不替它裁决**。

## 4. 候选接缝逐条定价

| | 接缝 | 覆盖 §3 的哪几条 | 收编代价 | 状态 |
| --- | --- | --- | --- | --- |
| C3 | 覆盖 `ChildProcessSpawner` layer | **4/5/6/7 一条都不覆盖**;只覆盖 1/2/8/9/10/11 | +1 热文件 + 1 ADR,且 ext 侧无注入点(§2.6) | **出局**(§2.2/2.3/2.4) |
| C1′ | 在 ext 的 `config(cfg)` hook 里改写 `cfg.mcp[*].command` | 4(配置驱动的那半) | **0** | 有洞:`POST /mcp` 的 `MCP.add` 绕开(§2.5) |
| C5 | 在 `mcp/index.ts:381`(`connectLocal`)包住 `command`/`args` | 4(全部) | **0 新 ADR** —— 已在 ADR-041 白名单(§2.7) | 咽喉点;`add` 与配置两条都必过它 |
| C6 | 在 `lsp/launch.ts:11` 包住 `cmd`/`args` | 5 | **+1 ADR**(实测判红,§2.7) | 唯一咽喉(`server.ts` 10 处 + `lsp.ts` 1 处全走它) |
| C7 | `pty.ts:167` 对 `input.command` 也过围栏 | 7 | **+1 ADR**(`core/src/pty.ts` 不在白名单) | 6 已被 C1 罩住,只差 7 |
| C8 | `format/index.ts:86` | 8 | **+1 ADR** | 本票 out of scope,但属同一族 |

一条随之而来的观察:**没有任何一个单点能同时罩住 4/5/6/7** —— 它们分别经 MCP SDK、cross-spawn、
node-pty 三种互不相干的创建原语。所以「一次罩住」不是选项,方案基线只能在
「逐条收编」与「换一层更低的机制(profile 级 / 进程级)」之间选,而后者本文档**没有勘破**。

## 5. 未验证 / 残余风险

- **PTY 的实测跑在 `pty.bun.ts`(bun-pty),而出货的 sidecar 是 node。**
  `packages/core/package.json` 的 `imports["#pty"]` 是条件导出:`bun → pty.bun.ts`、`node → pty.node.ts`;
  出货 sidecar 由 `packages/ui-mac/src/main/server.ts:295` 的 `utilityProcess.fork` 起,是 **node** ⇒
  跑的是 `pty.node.ts`(`@lydell/node-pty`)。§2.4 里**与运行时无关**的部分是 `pty.ts:167` 那行
  shell 选择(纯 JS,两条运行时同一份);**未验证**的是 node-pty 对 wrapper 的 exec 行为是否与
  bun-pty 逐格一致。要闭合就得在打包产物上跑,同 [`#1076`](https://github.com/jinjunnn/alpha-code/issues/1076) 的形态。
- **未验证:真实插件 `config` hook 与 MCP state 物化的时序。** §2.5 的 `cfg.mcp` 改写是在测试体里做的,
  时机由我控制;生产里 hook 跑在插件加载(`plugin/index.ts:254`),而 MCP 的 `InstanceState` 是
  **首次使用时**才物化。两者的先后没有实测。C1′ 若被选中,这是必须先跑的一格。
- **未验证:MCP `environment` 与 `cwd` 的相互作用。** §2.2/2.5 用的都是默认 cwd(instance directory);
  `ConfigMCPV1.Info` 允许 `cwd`,围栏的 `-D WORKDIR` 取哪个值没有勘破。
- **未验证:非 darwin。** 本文档全部测量在 macOS 上;`sandbox-exec` 只有 darwin 有(AC4 要求的是
  「如实声明」,不是等价围栏)。
- **未勘破:比逐条收编更低的那一层。** 例如给整个 sidecar 进程套一层 seatbelt、或用 profile 级
  继承让子进程自动受限。它可能一次解决 4/5/7/8,也可能连引擎自己都起不来(REQ-138 §5 已记
  set-ID exec 那一类固有代价)。**本文档没有跑过它,不要拿这段当依据。**
- `sandbox-exec` 仍被 Apple 标记 deprecated(与 REQ-138 同一条残余风险)。

## 6. 用法

本文档是 REQ-159 方案基线(`docs/design/`)与其实现票**开工前**的对照物。三条纪律:

1. §2 是基准。任何与它冲突的断言,**先复跑再改文档**,不要改实现去迁就散文。
2. §1 里那条更正(MCP 不经 `ChildProcessSpawner`)推翻了票面的现状坐标 —— 基线里凡是从
   「C3 一次罩住两条」推出来的选项,前提已不成立。
3. §5 的每一条,在实现票里必须变成实跑结论或显式的风险接受。
