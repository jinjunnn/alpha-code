---
title: 引擎到底从哪些地方派生出会落盘的进程(勘破)
kind: architecture
status: active
owners:
  - alpha-code desktop maintainers
last_reviewed: 2026-09-09
review_after: 2026-12-09
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
| 6 | **PTY 终端(缺省)** | `core/src/pty.ts:183` → `#pty`(node-pty / bun-pty) | ~~**是**(§2.4 ARM A/C)~~ → **否**,见 **§7.7**(§2.4 证到的是结构条件,真实产品接线下 PTY 读不到插件改写的 `cfg.shell`) | 是(终端面板) |
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
node-pty 三种互不相干的创建原语。所以在**这一层**上「一次罩住」不是选项,方案基线只能在
「逐条收编」与「换一层更低的机制(profile 级 / 进程级)」之间选。**后者已在 §6 勘破**
(第二轮,2026-09-08):它确实一次罩住全部通路,代价换成了「落点」与「与 REQ-138 互斥」两件事。

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
- **~~未勘破~~:比逐条收编更低的那一层 —— 已在 §6 跑完(2026-09-08 第二轮)。** 结论:seatbelt
  **由子进程继承**,一次罩住 §3 表全部 15 行,而且引擎在围栏下起得来、真实工作负载跑得通;
  但落点不是票面写的 `sidecar.ts`,`utilityProcess.fork` 无法被 `sandbox-exec` 前缀(§6.6),
  且它与 REQ-138 的 `cfg.shell` 层**互斥而非叠加**(§6.5)。**以 §6 为准,不要再引用本条旧文。**
- `sandbox-exec` 仍被 Apple 标记 deprecated(与 REQ-138 同一条残余风险)。

## 6. 第二轮勘破:整进程围栏 / profile 继承(2026-09-08)

第一轮把「比逐条收编更低的那一层」明确记为**没跑**(旧 §5 倒数第二条)。本节把它跑了。
结论分两半,必须一起读:

- **机制这一半全部成立** —— seatbelt 由子进程继承,MCP / LSP / PTY / shell / formatter
  **一次全被罩住**,而且引擎在围栏下能正常起来、能跑真实工作负载;
- **落点这一半不成立于票面所写的那个位置** —— sidecar **不是**被 `sidecar.ts` 启动的,
  它由 `packages/ui-mac/src/main/server.ts:295` 的 `utilityProcess.fork` 起,而
  `utilityProcess.fork` 的 `ForkOptions` **没有任何指定可执行文件的字段**,所以
  「在启动点前面加一个 `sandbox-exec`」这条最省事的路**结构上不存在**(§6.6)。

### 6.0 测量口径(第二轮)

| | |
| --- | --- |
| worktree | `.worktrees/ac-1286-fence`,由 `bash scripts/worktree-bootstrap.sh ac-1286-fence -b recon/1286-process-fence --base origin/recon/1286-spawn-seam` 建(`4729 packages installed [9.02s]`) |
| 宿主 | macOS 26.3.1(build 25D2128),Darwin 25.3.0 arm64,xnu-12377.91.3 |
| 运行时 | node **v22.22.3**;bun **1.3.14**;Electron **42.3.3**(其内 node v24.15.0) |
| PTY | `@lydell/node-pty` **1.2.0-beta.12**(prebuild `darwin-arm64`);`bun-pty` **0.4.8** |
| 其它包 | `cross-spawn` **7.0.6**;`@modelcontextprotocol/sdk` **1.29.0** |
| 出货二进制 | `/Applications/Code Puppy.app` v**0.1.11**,`Identifier=com.tide.alphacode`,`flags=0x10000(runtime)`,`TeamIdentifier=RQX6X6A635` |
| profile | 逐字取自 `packages/ext/src/shell-sandbox.ts` 的 `SEATBELT_PROFILE`,`sha256 b0e86694ffa71d250835c439f3ff659581194c9a8e746fc3e62c9010ed6b323d` |
| 判据 | **探针文件到底落没落盘**。exit code / stderr 只作旁证 |
| 对照臂 | 每一条「没落盘」的结论都配一条**同一探针、同一路径、只去掉 `sandbox-exec` 那一段**的正样本臂 |

取证脚本一次性,不入仓;下面贴的是原始输出。

### 6.1 四问,各一句

1. **继承成不成立?** 成立,而且比预期宽:cross-spawn / `node:child_process.spawn` / 孙进程(深度 2)/
   `detached` 新会话组 / node-pty **五条全部继承**(§6.2)。
2. **引擎在围栏下还能不能工作?** 能 —— 冷启动、真实工作负载(会话、bash 工具派生、MCP 连上、
   LSP 派生、PTY 起、运行时 npm 装 26 个 provider 包 61MB)在围栏里全部跑通,同一批越界写全部
   落不了盘(§6.3)。**但可写集合必须含 `~/.npm` 与 `<XDG_CONFIG>/opencode`,后者装着引擎自己的
   config 文件 —— 这是一个尚未收窄的自洞。**
3. **出货形态(node + `@lydell/node-pty`)?** 已在 node 上取到:**用现行生产 profile 时 PTY
   根本创建不出来**(`posix_openpt failed: Operation not permitted`),要加 `/dev/ptmx` 与
   `^/dev/ttys` 两条才活;加上之后 PTY 正常且受围栏(§6.4)。bun-pty 同样失败,两条运行时一致。
4. **与既有围栏的关系?** **只能替换,不能叠加。** 嵌套 `sandbox-exec` 只在**编译后策略完全相同**
   时通过;策略只要不同(哪怕更松或只差两行),内层直接 `sandbox_apply: Operation not permitted`
   / exit 71 / **零执行**(§6.5)。REQ-138 的 wrapper 每次带 `-D WORKDIR="$(pwd)"`,一般与外层
   不同 ⇒ 外层围栏一旦存在,**每一次 shell 工具调用都会 exit 71**。

### 6.2 Q1:围栏由子进程继承(五条原语,正反两臂)

探针 `packages/core/alpha1286-runner.mjs`(放在 `packages/core/` 以解析到该包的
`cross-spawn@7.0.6` 与 `@lydell/node-pty@1.2.0-beta.12`),对每条原语做两次写:
一次写 `$HOME/alpha1286-fence/escape/`(**越界**,既不在 WORKDIR 也不在 `/private/tmp`
或 `/private/var/folders`),一次写 WORKDIR。

```
# 反向臂(正样本):同一条命令,不带 sandbox-exec
cd packages/core && node alpha1286-runner.mjs bare  "$ESC" "$WORK"
# 围栏臂:同一条命令,只在最前面加 sandbox-exec
cd packages/core && /usr/bin/sandbox-exec -f "$PROFILE" -D WORKDIR="$WORK" \
    "$(which node)" alpha1286-runner.mjs fenced "$ESC" "$WORK"
```

| 创建原语 | 无围栏 escapeLanded | 围栏 escapeLanded | 围栏 insideLanded | 围栏下的错误 |
| --- | --- | --- | --- | --- |
| 进程自身 `fs.writeFileSync` | **true** | **false** | true | `EPERM` |
| `cross-spawn@7.0.6`(MCP SDK / `util/process.ts` / effect spawner 共用) | **true** | **false** | true | `sh: …: Operation not permitted` |
| `node:child_process.spawn` | **true** | **false** | true | 同上 |
| 孙进程(cross-spawn → sh → sh,深度 2) | **true** | **false** | true | 同上 |
| `detached:true`(新会话组) | **true** | **false** | true | 同上 |
| `@lydell/node-pty`(node 运行时) | **true** | **false** | **false** | `posix_openpt failed: Operation not permitted` ⇒ 见 §6.4 |

反向臂原始输出(节选,`tag:"bare"`):`"crossspawn":{"escapeLanded":true,…}`、
`"grandchild":{"escapeLanded":true,…}`、`"detached":{"escapeLanded":true,…}`、
`"nodepty":{"escapeLanded":true,…}` —— **六条全落盘**,证明探针抓得到已知的正样本。
围栏臂同一批全部 `escapeLanded:false`,`ls escape/` 为空目录。

**这一条一次性覆盖第一轮 §3 表的全部 15 行**:表右列里除 PTY 之外的每一条,底层要么是
cross-spawn、要么是 `node:child_process`,两者都已在上表证明继承。

### 6.3 Q2:引擎在围栏下能不能工作(本轮最贵的一问)

#### 6.3.1 先枚举:引擎在一次真实工作负载里合法写了哪里

隔离一个模拟用户家目录(`$H/home`,四个 XDG 变量全指进去)与一个工作区(`$H/ws`,真 git 仓),
**无围栏**冷启动引擎并跑一遍工作负载,然后列出它创建的一切:

```
cd packages/opencode && bun run --conditions=browser ./src/index.ts serve --port 43186 --hostname 127.0.0.1
→ opencode server listening on http://127.0.0.1:43186
→ GET /global/health  {"healthy":true,"version":"local"}   HTTP=200
```

工作负载(全部 HTTP 200):`GET /project/current` → `POST /session` → `POST /session/{id}/shell`
(真派生 bash,写工作区内文件)→ `GET /file?path=.` → `POST /pty`(返回真 pid)。

写入集(排除 bun 自身的 transpiler 缓存;`node_modules` 折成一行):

```
<ISOHOME>/.cache/opencode/bin
<ISOHOME>/.cache/opencode/models.json
<ISOHOME>/.config/opencode/.gitignore
<ISOHOME>/.config/opencode/opencode.jsonc
<ISOHOME>/.config/opencode/package.json
<ISOHOME>/.config/opencode/package-lock.json
<ISOHOME>/.config/opencode/node_modules/          ← 26 个顶层包 / 61M(运行时真装)
<ISOHOME>/.local/share/opencode/log/opencode.log
<ISOHOME>/.local/share/opencode/opencode-local.db
<ISOHOME>/.local/share/opencode/opencode-local.db-shm
<ISOHOME>/.local/share/opencode/opencode-local.db-wal
<ISOHOME>/.local/share/opencode/repos
<ISOHOME>/.local/state/opencode/locks
$TMPDIR/opencode/
$HOME/.npm/_cacache/                              ← @npmcli/arborist 的包缓存(不受 XDG 影响)
```

三件反直觉、但**决定 profile 能不能写对**的事:

1. **引擎在运行时真的装包。** `core/src/npm.ts` 用**进程内**的 `@npmcli/arborist`(不派生 npm)
   把 provider SDK 装进 `<XDG_CONFIG>/opencode/node_modules`,本次 26 个包 61MB,
   同时写 `$HOME/.npm/_cacache`。这两处不放行 ⇒ provider 装不上。
2. **`~/.npm` 不随 XDG 走。** 它按真实 `os.homedir()` 解析,所以它**不在**任何 XDG 隔离里。
3. **围栏建不出自己的父目录。** `(subpath "<X>/.local/share/opencode")` 放行的是该目录**之下**;
   若 `<X>/.local/share` 还不存在,fenced 进程 `mkdir -p` 会在父层 EPERM。
   ⇒ **父目录必须由未被围栏的一方(main 进程)预先建好。**

#### 6.3.2 再实测:同一条路径,只在最前面加 `sandbox-exec`

候选 profile(生产 `SEATBELT_PROFILE` + 上面枚举出的位置 + `/dev/ptmx` `^/dev/ttys`):

```
(version 1)
(allow default)
(deny file-write*)
(allow file-write*
  (subpath (param "WORKDIR"))
  (subpath "<ISOHOME>/.local/share/opencode")
  (subpath "<ISOHOME>/.local/state/opencode")
  (subpath "<ISOHOME>/.cache/opencode")
  (subpath "<ISOHOME>/.config/opencode")
  (subpath "<ISOHOME>/.cache/bun")          ; bun 运行时产物,出货的 node sidecar 不需要
  (subpath "$HOME/.npm")
  (subpath "/private/tmp")
  (subpath "/private/var/folders")
  (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr")
  (literal "/dev/tty") (regex #"^/dev/fd/")
  (literal "/dev/ptmx") (regex #"^/dev/ttys")
)
```

**冷启动**(隔离家目录先 `rm -rf`,只预建四个 XDG 父目录):

```
/usr/bin/sandbox-exec -f engine-fence.sb -D WORKDIR="$WS" "$(which bun)" \
  run --conditions=browser ./src/index.ts serve --port 43187 --hostname 127.0.0.1
→ opencode server listening on http://127.0.0.1:43187
→ GET /global/health  {"healthy":true,"version":"local"}   HTTP=200
```

围栏下的真实工作负载,逐条:

| 动作 | 结果 |
| --- | --- |
| `GET /project/current` | 200,`worktree` 正确,`vcs:"git"` |
| `POST /session` | 200,`ses_f8060e343ffeZf64pMq7arSUGJ` |
| `POST /session/{id}/shell` 写**工作区内** | `output:"rc=0"`,`ws/fenced-in.txt` **落盘** |
| `POST /session/{id}/shell` 写**工作区外** | `output:"(eval):1: operation not permitted: …/escape/…"`,**未落盘** |
| `POST /pty` | 200,`status:"running"`,`pid:71360` |
| 运行时 npm 安装 | **在围栏里完成**,`node_modules` 顶层 26 个包 |
| `<ISOHOME>/.local/share/opencode/log/opencode.log` | 无 `EPERM/EACCES/not permitted/ENOENT` |

**MCP,正反两臂**(探针 server 起来第一件事就是各写一次界内界外,再把结果经 tool description 报回):

```
# 围栏臂(引擎跑在 sandbox-exec 里)
POST /mcp {"name":"alpha1286probe","config":{"type":"local","command":["<node>","…/alpha1286-mcp-probe.mjs"],…}}
→ {"alpha1286probe":{"status":"connected"}}   HTTP=200
   ws/fenced-mcp-inside.txt   落盘
   escape/fenced-mcp-escape.txt  **未落盘**

# 反向臂(同一 payload、同一探针,引擎不带 sandbox-exec)
→ {"alpha1286probe":{"status":"connected"}}   HTTP=200
   escape/bare-mcp-escape.txt **落盘**
```

**LSP,正反两臂**(用 `cfg.lsp` 注册一个自定义 server,`extensions:[".txt"]`,经真
`lsp/launch.ts` 派生;触发器是 `debug lsp diagnostics <file>`):

```
# 反向臂
(. env; OPENCODE_CONFIG_CONTENT=…; bun … src/index.ts debug lsp diagnostics "$WS/probe.txt")
   escape/bare-lsp-escape.txt  **落盘**;ws/bare-lsp-inside.txt 落盘

# 围栏臂(同一条命令,只在最前面加 sandbox-exec)
/usr/bin/sandbox-exec -f engine-fence.sb -D WORKDIR="$WS" "$(which bun)" … debug lsp diagnostics …
   escape/fenced-lsp-escape.txt **未落盘**;ws/fenced-lsp-inside.txt **落盘**(证明 LSP 子进程真起来了)
```

⇒ **AC2 与 AC3 的形态,在整进程围栏下同时成立,且上游 0 行改动。**

#### 6.3.3 这一问答出来的两个新坑

- **`<XDG_CONFIG>/opencode` 必须可写,而引擎自己的 config 文件就住在那里**
  (`opencode.jsonc` 与 `node_modules` 同目录)。被围栏的 MCP/LSP 子进程因此**能改引擎的配置**。
  只放行 `node_modules` + `package*.json`、把 config 文件挪出去,**本轮没测**。
- **`~/.npm` 是家目录下的一个通用缓存**,放行它等于给子进程开了一个家目录内的可写口子。
  能否改成 `npm_config_cache` 指进 app 数据目录,**本轮没测**。

### 6.4 Q3:出货形态(node)上的 PTY

驱动的是出货那一支本身 —— `packages/core/src/pty/pty.node.ts`(`#pty` 的 node 分支 →
`@lydell/node-pty@1.2.0-beta.12`),用 `node --experimental-strip-types` 真执行:

| 臂 | 结果 |
| --- | --- |
| node,无围栏 | `{"spawnError":null,"escapeLanded":true,"insideLanded":true}` ← 正样本 |
| node,**现行生产 profile**(`SEATBELT_PROFILE` 原文) | `{"spawnError":"posix_openpt failed: Operation not permitted","escapeLanded":false,"insideLanded":false}` |
| node,生产 profile **+ `/dev/ptmx` + `^/dev/ttys`** | `{"spawnError":null,"escapeLanded":false,"insideLanded":true}` |
| bun(`pty.bun.ts` / bun-pty 0.4.8),无围栏 | `{"spawnError":null,"escapeLanded":true,…}` |
| bun,**现行生产 profile** | `{"spawnError":"PTY spawn failed","escapeLanded":false,"insideLanded":false}` |

两条运行时**行为一致**:第一轮 §5 记的「node-pty 与 bun-pty 是否逐格一致」这条残余风险,
**在整进程围栏这个用法下已闭合**;而 §6.3.2 里围栏引擎的 `POST /pty` 返回 `running`,是同一结论
在真引擎上的第三次交叉。

**这一格如果漏掉,后果不是少拦一个坏输入,是终端面板整个不可用** —— 与 CLAUDE.md 记的
「前提为假的闸门比没有闸门更贵」同一形态。

### 6.5 Q4:与 REQ-138 既有围栏的关系 —— 只能替换,不能叠加

嵌套 `sandbox-exec`(`/usr/bin/sandbox-exec` 本身 `-rwxr-xr-x root:wheel`,非 set-ID):

| # | 外层 profile | 内层 profile | 结果 |
| --- | --- | --- | --- |
| 1 | 生产+pty,`WORKDIR=A` | 同一文件,`WORKDIR=B` | `sandbox_apply: Operation not permitted`,**exit 71,内层零执行** |
| 2 | 纯 `(allow default)` | 生产+pty,`WORKDIR=B` | 同上(内层更**紧**也照样拒) |
| 3 | 生产+pty,`WORKDIR=A` | 同一文件,`WORKDIR=A` | **通过**,内层写 A 成功 |
| 5 | 纯 `(allow default)` | 纯 `(allow default)` | **通过** |
| 6 | 生产+pty,`WORKDIR=A` | 纯 `(allow default)`(更松) | 拒,exit 71 |
| 7 | 生产+pty,`WORKDIR=A` | **另一份同内容拷贝**,`WORKDIR=A` | **通过** |
| 8 | 生产+pty,`WORKDIR=A` | 生产原版(少两行 pty 节点),`WORKDIR=A` | 拒,exit 71 |
| 9 | 生产+pty,`WORKDIR=A` | 同语义**多一行注释**,`WORKDIR=A` | **通过** |
| 10 | 生产+pty,`WORKDIR=A` ×3 层 | 同上 | **通过**,三层深仍可写 A |

规律(实测归纳,非文档推断):**嵌套只在「编译后的策略完全相同」时放行**(注释被剥离不算差异,
参数代入后不同就算差异);其余一律 `sandbox_apply: Operation not permitted` + exit 71 + 零执行。
**由此还得到一条设计上的硬约束:围栏一旦套上就不能再加宽** —— 想扩可写集只能换新进程。

**对本票的直接后果:** REQ-138 的 wrapper 是
`exec /usr/bin/sandbox-exec -f "$ALPHA_SB_PROFILE" -D WORKDIR="$(pwd)" "$ALPHA_REAL_SHELL" "$@"`。
外层若已有整进程围栏,`$(pwd)` 逐次不同 ⇒ 命中第 1 行 ⇒ **每一次 shell 工具调用 exit 71、零执行**。
整进程围栏与 REQ-138 的 `cfg.shell` 层**互斥**:选前者就要把后者拆掉(`wrapEngineShell` 不再包
`cfg.shell`),而不是两层并存。

### 6.6 落点:`sidecar.ts` 不是启动点,`utilityProcess.fork` 也接不上 `sandbox-exec`

派工书里的前提是「引擎 sidecar 的启动点在 `packages/ui-mac/src/main/sidecar.ts`」。
**实读推翻它**:`sidecar.ts` 是**被 fork 出来的那个进程自己跑的入口模块**(顶层就
`getParentPort()`);真正的创建点是 `packages/ui-mac/src/main/server.ts:295`:

```ts
const child = (options.fork ?? utilityProcess.fork)(sidecar, [], {
  cwd: ensureEngineScratchCwd(options.userDataPath),
  env: createSidecarEnv(),
  serviceName: SIDECAR_SERVICE_NAME,
  stdio: "pipe",
})
```

`electron@42.3.3` 的 `ForkOptions` 全字段实读(`electron.d.ts:21353`):
`env` / `execArgv` / `cwd` / `session` / `partition` / `stdio` / `serviceName` /
`allowLoadingUnsignedLibraries` / `respondToAuthRequestsFromMainProcess`。
**没有 `execPath`,没有任何指定可执行文件的字段** —— utilityProcess 由浏览器进程经 Mojo 拉起
Electron 自己的 helper,`sandbox-exec` 插不进去。出货进程的实况(2026-09-08 实机 `pgrep`):

```
Code Puppy Helper.app/…/Code Puppy Helper --type=utility \
  --utility-sub-type=node.mojom.NodeService --service-sandbox-type=none …
```

于是「零收编」要落地,只剩三条路,逐条定价(全部在 alpha 自有文件里,north-star 守卫**实测 exit 0**,
控制臂 `packages/opencode/src/lsp/launch.ts` **exit 1** 并被点名):

| | 做法 | 实测证据 | 代价 |
| --- | --- | --- | --- |
| **P1** | **进程内自打沙箱**:`sidecar.ts` 在 `import("virtual:opencode-server")` **之前**调 `sandbox_init_with_parameters()`(`sandbox-exec` 自己用的那条 SPI) | **跑通了。** 用 bun:ffi 直连真 `/usr/lib/libsandbox.1.dylib`:`rc=0`,随后本进程越界写 `EPERM`、界内写成功,**且 `spawnSync` 出的子进程同样界外落不了盘、界内落得了盘**。控制臂(同一脚本、不调该函数)六项全落盘 | node **没有内置 FFI** ⇒ 需要一个原生 `.node` 附加模块(约 20 行)。**打包链已经在处理原生模块**:出货包里已带 `pty.node` / `watcher.node` / `msgpackr` 三个 prebuild。`sandbox_init*` 是 Apple 标记 deprecated 的 SPI(与 REQ-138 同一条既有风险) |
| **P2** | 改用普通 `child_process` 拉起 `ELECTRON_RUN_AS_NODE=1` 的 Electron 二进制,前面加 `sandbox-exec` | 开发版 Electron 上**跑通**(围栏臂 escape `EPERM`、界内落盘;反向臂落盘)。**出货二进制上跑不通** —— 实测它忽略 `ELECTRON_RUN_AS_NODE` 直接把整个 app 起了起来 | `electron-builder.config.ts:140` 的 C27 决定 `runAsNode:false`(与 `enableNodeOptions*` / `enableNodeCliInspect*` 一起关的注入原语)。P2 = **反转一条既有安全决定**,且要把 `parentPort` IPC 换掉 |
| **P3** | 逐条收编(第一轮 §4 的 C5/C6/C7/C8) | 第一轮已定价 | MCP 0 ADR;LSP/PTY/formatter 各 +1 ADR |

### 6.7 一个 sidecar 服务 N 个工作区 —— 围栏的 WORKDIR 装不下

引擎按请求头 `x-opencode-directory` 分实例;`spawnLocalServer` 的 respawn 触发条件是登录/登出、
代理开关、崩溃自愈、runaway,**不含「用户打开了另一个文件夹」**。实机佐证(2026-09-08,出货
v0.1.11 的一次真实启动):同一个 sidecar 同时挂着两组 Office MCP 子进程,cwd 分别是

```
/Applications/Code Puppy.app/Contents/Resources/office-mcp/server.py word  /Users/tide/code-puppy
/Applications/Code Puppy.app/Contents/Resources/office-mcp/server.py word  /Users/tide/app/alpha-code
```

而 REQ-138 的 wrapper 是**每次调用**取 `-D WORKDIR="$(pwd)"`,天然跟着实例走。
整进程围栏只有**一份**可写集,且 §6.5 证明**装上之后不能加宽**。所以 P1/P2 还要回答:
可写集取「本次 generation 已知的全部工作区之并」,还是「打开新目录就 respawn sidecar」?
**这一问本轮没有实测**,它是 P1/P2 落地前必须先跑的一格。

> **已裁决(2026-09-09,`#1317`):取启动时并集,不把「打开新目录」接成 respawn 触发器。**
> 定价、五工作区实跑、65 535 那道硬天花板、respawn 的 10.087 s 与三条在途损失,见
> [`2026-09-09-multi-workspace-fence-decision.md`](2026-09-09-multi-workspace-fence-decision.md)。

### 6.8 第二轮的未验证(如实记账)

- **围栏下的一次真正的模型往返没有跑。** 本轮跑通的是会话、工具派生、MCP、LSP、PTY、
  运行时装包与 DB/WAL 落盘;**没有**用真凭据发一次 LLM 请求(隔离家目录里没有 auth,且不愿花
  owner 的额度)。网络在 `(allow default)` 下不受限,provider 包的安装路径也已实跑,残余风险小,
  但**它是没跑的**。
- **隔离家目录不是生产路径。** 本轮用 `$H/home` + 四个 XDG 变量模拟用户家目录;生产里 sidecar
  只把 `XDG_STATE_HOME` 指向 `userDataPath`,data/cache/config 仍在真 `~/.local/share`、`~/.cache`、
  `~/.config`。**形状**一致(工作区之外的固定应用目录),**绝对路径**不同。
- **~~alpha 自己那部分写入集没有枚举完~~ —— 已在 §7 跑完(第三轮,2026-09-08),分上下界两级。以 §7.6 为准。**
  (以下为第二轮原文,保留以便追溯)
- **alpha 自己那部分写入集没有枚举完。** 本轮跑的是 `bun … serve` 的上游引擎,**没有**装载
  `@alpha-code/ext`、没有 `injectAlphaConfig`。静态实读可见 ext 插件在 sidecar 里还会写
  `<alphaGlobalRoot>/sandbox/`、`<alphaGlobalRoot>/bin/`(`shell-sandbox.ts:201-216`)与项目级
  `alpha.jsonc`(`plugin.ts:320-329`);catalog / 模型缓存 / ext-store / ext-tx 未逐条实跑。
  **P1/P2 落地前必须把这一段补齐**,漏一条 ⇒ sidecar 起不来。
- **P1 只在 bun:ffi 上验过机制,没有写原生附加模块**,因此「node 侧真能调通 + 能签名 + 能在
  hardened runtime 下加载」是**推断**(依据:出货包已带三个 prebuild `.node`),不是实测。
- **出货 sidecar 的 node 运行时没有跑过整进程围栏下的引擎。** §6.3 的引擎跑在 bun;§6.4 的 PTY
  跑在 node。两者未合成一次「node 运行时 + 打包产物 + 围栏」的实跑。
- **非 darwin 仍未测**(与第一轮同)。`sandbox_init*` 与 `sandbox-exec` 同属 Apple 标记 deprecated。

### 6.9 与第一轮的冲突记录

| 第一轮/票面的说法 | 本轮实测 |
| --- | --- |
| 旧 §5「未勘破:比逐条收编更低的那一层……可能连引擎自己都起不来」 | 引擎**起得来**,且真实工作负载跑通(§6.3)。这条已闭合 |
| 派工书前提「引擎 sidecar 的启动点在 `sidecar.ts`(alpha 自有,245 行)」 | `sidecar.ts` 是被 fork 的子进程入口;创建点在 `server.ts:295` 的 `utilityProcess.fork`,而它**无法指定可执行文件**(§6.6) |
| 派工书前提「整进程围栏若成立,两层会叠加」 | **不会叠加,会互斥**:嵌套异策略 ⇒ exit 71 零执行(§6.5) |
| 第一轮 §5「node-pty 对 wrapper 的 exec 行为未验证」 | 已在 node 上验:与 bun-pty 行为一致,且暴露出生产 profile 缺 `/dev/ptmx` `^/dev/ttys`(§6.4) |

## 7. 第三轮勘破:alpha 自己在 sidecar 进程里的写入面(2026-09-08)

第二轮把这一条明确记为**没跑**(§6.8 第三条):「本轮跑的是 `bun … serve` 的上游引擎,**没有**装载
`@alpha-code/ext`……P1/P2 落地前必须把这一段补齐,漏一条 ⇒ sidecar 起不来」。本节把它跑了。

一句话结论:**alpha 自己的写入面收得住**,而且**只有一条前缀随工作区变化**(`<workspace>/`);
但这份枚举有**上下界两级**,写围栏时必须按上界写,除非逐条证明够不着(§7.6 B 段)。

### 7.0 测量口径(第三轮)

| | |
| --- | --- |
| 仓 | `alpha-code@3089f8ce8`(= `origin/alpha`),worktree `.worktrees/ac-1286-writes`,由 `bash scripts/worktree-bootstrap.sh ac-1286-writes -b recon/1286-alpha-write-surface --base origin/alpha` 建(`4729 packages installed [10.56s]`) |
| 宿主 | macOS **26.3.1**,Darwin 25.3.0 arm64 |
| 运行时 | bun **1.3.14**(dev 引擎);node **v22.22.3** |
| 被测的 alpha 产物 | `packages/ext/dist/plugin.js`(`bun run --cwd packages/ext build`,828 655 B,未压缩);`packages/ui-mac/out/main/sidecar.js` + 它 import 的 `chunks/ext-bundle-lock-*.js`、`chunks/sidecar-stop-*.js`(`bun run --cwd packages/ui-mac build`) |
| 出货二进制 | `/Applications/Code Puppy.app` v**0.1.11**(§7.5 冷启动交叉验证) |
| 观测面 | **两台仪器**:① 内核 seatbelt 报告面(`(allow file-write* (with report))` + `log stream`)——每一次写操作一条带全路径的内核日志;② 盘上快照(`find`)。两者交叉,任一单用都会骗人(§7.2) |
| 判据 | 路径**实际被写**(内核报告)+ 文件**实际在盘上**。源码推断只用于归属,不用于判定 |
| 日期 | 2026-09-08 |

取证脚本一次性,不入仓;下面贴的是原始输出。

### 7.1 四问,各一句

1. **alpha 自己在 sidecar 里写哪些地方?** 冷启动 + 真实工作负载实跑落盘 **13 条**(§7.6 A 段),
   全部落在三个固定根(`<alphaGlobalRoot>`、`<userDataPath>`、`<workspace>/.code-puppy`)之下。
2. **哪些随工作区变化?** alpha 自己只有 `<workspace>/.code-puppy/**` 一处;算上上游引擎与工具,
   随工作区变化的全部路径都在 **`<workspace>/` 这一条前缀**之下 ⇒ 围栏每多服务一个工作区
   只需要多一条 `(subpath <workspace>)`。
3. **这份清单能不能从代码里长出来?** 能,而且必须从**出货产物**长(§7.3)。源码侧手写扫描
   本轮当场漏了一个模块(多行 import 没被正则吃到,漏 `alpha-mcp-secrets.ts` 的 19 处写盘);
   产物侧派生 + 反向臂四条,新增/改名一处写盘都判红。
4. **有没有推翻前两轮的东西?** 有一条,而且是**减覆盖**方向:§3 表第 6 行「PTY 缺省已被
   REQ-138 罩住」在**真实产品接线下不成立**(§7.7)。

### 7.2 观测手段先自证:它有两处会骗你

**手段本身。** seatbelt 的 `(allow file-write* (with report))` 让内核为**每一次**写操作打一条带完整
路径的日志。它不改变行为(全放行),因此可以罩着真实工作负载跑。反向的 `(deny … (with report))`
**不合法**,sandbox-exec 当场拒:

```
$ /usr/bin/sandbox-exec -f deny-with-report.sb /bin/sh -c 'echo hi > /private/tmp/x'
sandbox-exec: report modifier does not apply to deny action
```

规则是**后匹配优先**,所以可以把已知的高噪音子树静音(实测:`(allow file-write* (with report))`
之后再写一条 `(allow file-write* (subpath "<quiet>"))`,`<quiet>` 下的写**零报告**、其它照常报告)。

**骗你的第一处:`log show` 只看得到持久化那一份,而这些是 Debug 级消息。** 正样本臂——
在一个 sandbox 里写 800 个**互不相同**的文件:

```
盘上:800   log show 捞到:161   log stream --level debug 捞到:795
stream 自己打了一行:=== Messages dropped during live streaming (use `log show` to see what they were)
```

⇒ 必须用 `log stream --level debug`,**并且必须读那行 dropped 标记**(它是这台仪器唯一会
自己承认丢数据的地方)。

**骗你的第二处:同一时刻,同一条命令,换个可执行文件就整个不报告。** 同一窗口、同一 profile、
各写 5 个新文件:

```
bun  报告 0 / 落盘 5
node 报告 5 / 落盘 5
sh   报告 5 / 落盘 5
```

同一台机器稍后再测,`bun` 又变成 5/5(原 binary、拷贝的 binary、`bun run` 三种形态都 5/5)。
即 **报告面会静默漏,漏法随时间变**。这正是《本机验证陷阱》里「空输出 / 零命中 —— 观测手段
自己瞎了」那一类,而它**不会**给你 dropped 标记。

**所以配第二台仪器。** 本轮主实跑结束后,把隔离树整棵列出来与报告面对账:

```
盘上条目 8441   报告面覆盖 8382   盘上有、报告面没有 59
```

59 条里 57 条是**本次跑之前**就存在的(我自己 `git init` 的 `.git/**`、预建的目录);真正在窗口内
被漏掉的是 2 条,都由 MCP 子进程(bun)写出:`<ws>/mcp-child-inside.txt`、
`<HOME>/alpha1286-mcp-escape.txt`。**两条都落在已经枚举到的桶里,所以桶级枚举不受影响** ——
但「报告面 = 全集」这个说法是假的,本节所有「它不写这里」的话都只在两台仪器都没看见时才说。

### 7.3 单一权威:从**出货产物**派生写盘调用点(AC1 的形状)

**为什么不能是源码清单。** 本轮先写了一个源码侧的 import 闭包扫描器,它给出 79 个文件 / 140 处
写盘。把它的 import 正则从「`import … from` 必须同一行」改成「任何 `from "…"`」之后,
**同一棵树变成 99 个文件 / 186 处** —— 多出来的里就有 `alpha-mcp-secrets.ts`(19 处写盘,
目标是 `<userDataPath>/alpha-mcp-secrets/<server>/<verId>/<VAR>`),它被漏掉的唯一原因是
`ext-config.ts:27` 用了**多行** import。**这是「手写一个别人文法的替身」的又一例**,而它是靠
比对出货产物才暴露的:产物里明明有 `fs.rmSync(serverDir(userDataPath, server), …)`。

**判据键在写原语上,不在文件清单上。** 工具做三件事:

1. 在每个产物里解析 `node:fs` / `node:fs/promises` 的 import,拿到**本地绑定名**
   (bundler 会改名,产物里实测有 `readFileSync as readFileSync3`、`join as join4`),
   namespace import(`import * as fs`)一并处理;
2. 只用这些绑定名找调用点(所以「把 `writeFileSync` 改名再调」抓得到,朴素 grep 抓不到);
3. 与登记簿(TSV:`次数 / 产物 / fs API / 归一化后的调用行`)逐条比对,多一条少一条都 exit 1。

**输入 = alpha 自己在 sidecar 里的四个产物**,`sidecar.js` 的相对 import 自动跟进:

```
packages/ext/dist/plugin.js                       ← 引擎装载的 ext bundle
packages/ui-mac/out/main/sidecar.js               ← utilityProcess 的入口
packages/ui-mac/out/main/chunks/ext-bundle-lock-*.js
packages/ui-mac/out/main/chunks/sidecar-stop-*.js
  · 显式豁免(上游引擎 bundle,非 alpha 写入面):node-CcYBHQH2.js
```

那条豁免是 AC1 要求的「在闸上被显式点名并写明理由」:`chunks/node-*.js` 33 MB,就是
`virtual:opencode-server`(上游引擎自己),它的派生与写入通路在 §3 表里,不在 alpha 的写入面。

**当前读数:70 条签名 / 85 个调用点。**

| 产物 | 签名 | 调用点 |
| --- | --- | --- |
| `plugin.js`(ext) | 6 | 6 |
| `sidecar.js` | 10 | 10 |
| `chunks/ext-bundle-lock.js` | 15 | 18 |
| `chunks/sidecar-stop.js` | 39 | 51 |

**四臂(正反都跑):**

| 臂 | 做了什么 | 结果 |
| --- | --- | --- |
| A | 干净树比对 | `✓ … 一致(70 条签名 / 85 个调用点)` **exit 0** |
| B | **不改代码**重建 `packages/ext/dist/plugin.js` 再比对 | **exit 0** —— 签名跨构建稳定(不键在行号 / chunk hash 上) |
| C | 在 `shell-sandbox.ts` 加一处 `appendFileSync(...)`,重建 | **exit 1**:`✗ 未登记的写盘调用点: 1 plugin.js appendFileSync appendFileSync(join(globalRoot, …))` |
| D | 把 `writeFileSync` **改名**成 `sneaky` 再调用(= bundler 别名的同形态),重建 | **exit 1** 并点名;而同一产物里 `grep -c "writeFileSync("` **读数不变(5)** ⇒ 朴素 grep 会漏,本判据不会 |
| — | 还原 C/D 后重建 | 回到 **exit 0** |

**两条已知缺陷,留给实现票:**

- 签名归一化会把标识符尾部的数字剥掉(为了吃掉 bundler 的 `join4`),**字符串字面量里的数字
  也一起被剥**。不影响判红,但签名是有损的(ARM C 的输出里 `alpha1286-new-write-point.log`
  被显示成 `alpha-new-write-point.log`)。
- **本轮这套判据没有入仓、没有接进 `scripts/alpha-check.sh`。** 只入仓不接闸 = 安慰剂闸
  (`#1292` 的形态),所以这里只交出「它成立、四臂都验过」,落地形态归实现票。

### 7.4 实跑:装了 `@alpha-code/ext` 的 sidecar,冷启动 + 真实工作负载

按 `sidecar.ts` 的真实顺序驱动:先 `injectAlphaConfig(userDataPath, extPluginPath, "dev")`
(它自己就落盘),再起引擎;整条链跑在 `sandbox-exec -f trace.sb` 里,报告面全程 `log stream`。

```
HOME=<ISO>/home  XDG_{CONFIG,DATA,CACHE,STATE}_HOME=<ISO>/home/…  ALPHA_GLOBAL_DIR=<ISO>/alpha-state/env/dev
cd packages/ui-mac && /usr/bin/sandbox-exec -f trace.sb "$(which bun)" run ./alpha1286-driver.ts
  → ALPHA1286-INJECT {"ok":true}
  → ALPHA1286-OPENCODE_CONFIG <ISO>/alpha-state/env/dev/alpha.jsonc
  → ALPHA1286-CONTENT-PLUGIN [".../packages/ext/dist/plugin.js"]
  → opencode server listening on http://127.0.0.1:43290
  → [@alpha-code/ext] engine shell fenced: cfg.shell=<ISO>/alpha-state/env/dev/bin/zsh
       real=/bin/zsh profile=<ISO>/alpha-state/env/dev/sandbox/alpha-shell.sb
```

工作负载,逐条:

| 动作 | 结果 |
| --- | --- |
| `GET /global/health` | `HTTP=200` |
| `GET /project/current` | 200,`worktree=<ISO>/ws`,`vcs:"git"` |
| `POST /session` | 200,`ses_f7febb2d8ffeAT7rwxUnEvo8DH` |
| `POST /mcp`(**装一个连接器**) | 200,`{"alpha1286probe":{"status":"connected"}}`,子进程真起来并真写盘 |
| `POST /pty`(**开一个终端**) | 200,`status:"running"`,`pid:44246` |
| `alpha_register` 工具(**写一次 `alpha.jsonc`**) | `command "alpha1286probe" registered in .code-puppy/alpha.jsonc`,文件真落盘 |
| `POST /session/{id}/shell`(**跑一次 shell 工具**) | **没跑成** —— `HTTP=500`,引擎日志 `ProviderNoProvidersError: No providers are available`(隔离家目录里没有任何凭据)。**与围栏无关,如实记账**;这一格未闭合 |

`alpha_register` 那条走的是**直接装载出货 bundle 真执行**(`import(packages/ext/dist/plugin.js)` →
`hooks.tool.alpha_register.execute(...)`),因为它需要模型回合才会经会话触发。落盘实证:

```
<ISO>/ws/.code-puppy/alpha.jsonc    { "command": { "alpha1286probe": { "template": "echo hi" } } }
报告面同时记到:  <WS>/.code-puppy  、 <WS>/.code-puppy/alpha.jsonc.tmp 、 <WS>/.code-puppy/alpha.jsonc
```

**报告面按桶折叠(8 627 条唯一路径):**

```
  3933  <userDataPath>/*                     e.g. alpha-identity.md / alpha-engine-config/…
  3923  <XDG_CONFIG>/opencode/node_modules/** 运行时装 provider 包
   556  $HOME/.npm/**                        npm cacache(不随 XDG)
   138  <XDG_CACHE>/bun/**                   bun 运行时(出货 node sidecar 不需要)
    34  <isolated HOME>/… 其它                .zsh_history / .zsh_sessions / Library/Caches/bun
    11  <XDG_STATE>/opencode/*               locks
     8  <XDG_DATA>/opencode/*                log / *.db / -wal / -shm / repos
     4  <XDG_CACHE>/opencode/*               bin / models.json
     4  <XDG_CONFIG>/opencode/*              .gitignore / package.json / package-lock.json
     3  <workspace>/.code-puppy/*
     2  <alphaGlobalRoot>/bin/*
     2  <alphaGlobalRoot>/sandbox/*
     2  $TMPDIR(/private/var/folders)/**
     1  <alphaGlobalRoot>/alpha.jsonc
     1  <workspace>/.git/**                  .git/opencode
     1  <ISO>/positive-control.txt           ← 正样本臂(证明这台仪器这一刻是活的)
```

**两处反直觉、且会直接弄死产品的:**

1. **provider 包被装了两份。** 第二轮跑裸引擎时只看到 `<XDG_CONFIG>/opencode/node_modules`;
   装了 alpha 之后 `injectAlphaConfig` 把 `OPENCODE_CONFIG_DIR` 指到
   `<userDataPath>/alpha-engine-config`,于是**两处各装一份**,实测各 26 个顶层包 / 61 MB
   (`du -sh` 两处都是 61M)。真机同样两处都在(`~/.config/opencode/node_modules` 24 个、
   `~/Library/Application Support/ai.opencode.desktop/alpha-engine-config/node_modules` 26 个)。
   **围栏漏掉任一处 ⇒ provider 装不上。**
2. **`POST /pty` 起的是登录 shell(`-l`),它会写 `$HOME/.zsh_history`、`$HOME/.zsh_history.LOCK`
   与 `$HOME/.zsh_sessions/**`。** 这几条在家目录里、不在任何应用目录下,漏掉的后果不是少拦
   一个坏输入,是**终端面板一开就报错**。

**顺带把 §6.5 的互斥在真实产品接线上重跑了一遍**(profile 与 wrapper 都是本次 ext 运行时**自己
写出来的**那两个文件,不是手抄的复制品):

```
ARM 1 控制臂(只有 REQ-138 wrapper,= 今天的生产形态):
  <root>/bin/zsh -c 'echo IN > <ws>/wrap-in.txt; echo ESCAPE > ~/alpha1286-escape-probe.txt'
  → zsh:1: operation not permitted: /Users/tide/alpha1286-escape-probe.txt   exit=1
  → in=landed  escape=no                     ← 围栏今天是好的

ARM 2(外层整进程围栏 + 内层 REQ-138 wrapper,= 路一的形态):
  /usr/bin/sandbox-exec -f trace.sb <root>/bin/zsh -c 'echo IN > <ws>/wrap-in.txt'
  → sandbox-exec: sandbox_apply: Operation not permitted   exit=71
  → in=no                                    ← 零执行
```

(第一次跑 ARM 1 时探针写的是 `<ISO>/home/…`,而 `<ISO>` 在 `/private/tmp` 下、正好落在
生产 profile 的 `(subpath "/private/tmp")` 放行段里 —— 那次的「escape landed」是我的布局问题,
不是围栏缺陷。换成真实 `$HOME` 下的路径后结论如上。记在这里以免下一个人误读。)

### 7.5 出货形态交叉验证:打包 app 的真 sidecar(node / utilityProcess)

同一台仪器罩着**出货二进制**跑一次冷启动:

```
/usr/bin/sandbox-exec -f trace.sb "/Applications/Code Puppy.app/Contents/MacOS/Code Puppy"
ps → 52489 52441 …/Code Puppy Helper --type=utility --utility-sub-type=node.mojom.NodeService …
```

该 sidecar pid 的报告(全部 19 条,已折叠;整窗口有 **34 次 dropped**,所以这份**不完整**):

```
~/Library/Application Support/ai.opencode.desktop/alpha-identity.md
~/Library/Application Support/ai.opencode.desktop/alpha-behavior.md
~/Library/Application Support/ai.opencode.desktop/alpha-engine-config/opencode.json   (data/mode/owner)
~/Library/Application Support/ai.opencode.desktop/alpha-engine-config/opencode.jsonc
~/Library/Application Support/ai.opencode.desktop/opencode/locks/<hash>.lock/{heartbeat,meta.json}
~/.local/share/opencode/log/opencode.log
~/.local/share/opencode/opencode.db{,-wal,-shm}
```

三件由此**确定下来的生产坐标**(第二轮 §6.8 记的「隔离家目录不是生产路径」这一条到此闭合):

- `userDataPath` = `~/Library/Application Support/**ai.opencode.desktop**`(不是 `Code Puppy`);
- `XDG_STATE_HOME` 被 `sidecar.ts:166` 指向 `userDataPath` ⇒ locks 落在 userData 之下;
- `XDG_DATA` / `XDG_CACHE` / `XDG_CONFIG` **仍是真家目录**(`~/.local/share`、`~/.cache`、`~/.config`)。

第二台仪器(`find -newermt <窗口起点>`)在同一窗口补到的 alpha 状态根:

```
~/Library/Application Support/alpha-code-state/env/prod/{skills-enabled.json, ext-tx/}
~/Library/Application Support/ai.opencode.desktop/{alpha-live-models.json, alpha-shell-env.json,
      alpha-secrets/ZHIPU_API_KEY, catalog-channel-state.json, logs/<ts>/, alpha-engine-config/…}
```

生产 `alphaGlobalRoot`(`env/prod`)的实况目录清单:

```
alpha.jsonc  bin/zsh  sandbox/alpha-shell.sb  ext-store/  ext-tx/
installs.json  skills-enabled.json  ecosystem-import.json
```

`bin/zsh` 与 `sandbox/alpha-shell.sb` 的 mtime 是 2026-09-07(上一次真正开过会话时写的),
本次冷启动没有重写它们 —— **ext 的 `config` 钩子要到某个实例真的加载配置时才跑**,
只启动不开工作区不会碰这两个文件。

### 7.6 写入面枚举表

**A 段 —— 本轮实跑真的落盘(下界)。** 「谁写的」给 `file:line`;`<…>` 是根变量,生产取值见 §7.5。

| # | 路径 | 谁写的 | 什么时机 | 随工作区变化 |
| --- | --- | --- | --- | --- |
| 1 | `<alphaGlobalRoot>/alpha.jsonc` | `ui-mac/src/main/alpha-config-injection.ts:80,82`(sidecar 进程 start 第一步) | 每次 start;缺失才 seed | 否 |
| 2 | `<userDataPath>/alpha-identity.md` | 同上 `:111,115` | 每次 start | 否 |
| 3 | `<userDataPath>/alpha-behavior.md` | 同上 `:111,115` | 每次 start | 否 |
| 4 | `<userDataPath>/alpha-engine-config/`(mkdir `0700`) | 同上 `:513` | 每次 start | 否 |
| 5 | `<userDataPath>/alpha-engine-config/opencode.jsonc`(`0600`) | 同上 `:537` | 每次 start | 否 |
| 6 | `<userDataPath>/alpha-engine-config/opencode.json` | 同上 `:516`(拷 `alpha.jsonc`)/ `:518`(清陈尸) | 每次 start | 否 |
| 7 | `<userDataPath>/alpha-engine-config/models.json`(`0600`) | 同上 `:557` / `:560` | 每次 start | 否 |
| 8 | `<userDataPath>/alpha-engine-config/{package.json,package-lock.json,node_modules/**}` | 上游引擎的运行时 npm;**落点由 alpha 的 `OPENCODE_CONFIG_DIR` 决定** | 首次 / 缺包(实测 26 包 61 MB) | 否 |
| 9 | `<alphaGlobalRoot>/sandbox/alpha-shell.sb` | `ext/src/shell-sandbox.ts:201-202`(`config` 钩子) | **每次配置加载**(每实例、每次 dispose 重建) | 否 |
| 10 | `<alphaGlobalRoot>/bin/<真 shell 的 basename>`(+`chmod 0755`) | `ext/src/shell-sandbox.ts:203-205` | 同上 | 否 |
| 11 | `<workspace>/.code-puppy/`(mkdir) | `ext/src/plugin.ts:316` | `alpha_register` 工具 | **是** |
| 12 | `<workspace>/.code-puppy/alpha.jsonc.tmp` | `ext/src/plugin.ts:320` | 同上 | **是** |
| 13 | `<workspace>/.code-puppy/alpha.jsonc`(rename) | `ext/src/plugin.ts:325` | 同上 | **是** |

**同一个进程里,上游引擎与它派生的进程还会写这些 —— 围栏同样必须放行,漏一条同样起不来:**

| # | 路径 | 谁写的 | 什么时机 | 随工作区变化 |
| --- | --- | --- | --- | --- |
| 14 | `<XDG_DATA>/opencode/{log/,*.db,*-wal,*-shm,repos/}`(生产 = 真 `~/.local/share`) | 上游引擎 | 常驻 | 否 |
| 15 | `<XDG_STATE>/opencode/locks/**`(生产 = `<userDataPath>/opencode/locks`) | 上游引擎 | 常驻 | 否 |
| 16 | `<XDG_CACHE>/opencode/{bin/,models.json}` | 上游引擎 | 启动 | 否 |
| 17 | `<XDG_CONFIG>/opencode/{package.json,package-lock.json,node_modules/**}` | 上游 npm(**第二份** 26 包 61 MB) | 首次 / 缺包 | 否 |
| 18 | `$HOME/.npm/_cacache/**` | `@npmcli/arborist`,按 `os.homedir()` 解析,**不随 XDG**(真机 17 GB) | 装包时 | 否 |
| 19 | `$TMPDIR/**`(`/private/var/folders/…`) | 上游 + 各子进程 | 常驻 | 否 |
| 20 | `<workspace>/.git/opencode` | 上游 project 探测 | 打开工作区 | **是** |
| 21 | `<workspace>/**` | shell / write / edit 工具(= 用户意图,REQ-138 的 `WORKDIR`) | 会话中 | **是** |
| 22 | `$HOME/.zsh_history`、`$HOME/.zsh_history.LOCK`、`$HOME/.zsh_sessions/**` | `POST /pty` 起的**登录** shell(`-l`) | 开终端 | 否 |
| 23 | `<XDG_CACHE>/bun/**`、`$HOME/Library/Caches/bun/**` | bun 运行时 —— **dev 独有**,出货 node sidecar 不需要 | 常驻 | 否 |

**B 段 —— 出货产物里可达、但本轮没跑到(上界)。** 这些写盘调用点**链接进了** sidecar 的出货
bundle(§7.3 的 70 条签名里),只是这次工作负载没走到。围栏要么放行它们,要么逐条证明
「走我们自己的代码和 runbook 到不了」——**本轮没有做这个证明**。

| 额外的写入根 | 来源模块(产物里可达) |
| --- | --- |
| `<alphaGlobalRoot>/bin/alpha-shell-denied`(+`chmod 0755`) | `ext/src/shell-sandbox.ts:215-217` —— 围栏装不上时的 fail-closed 分支;根与 A 段第 10 行相同,所以不额外扩大可写集 |
| `<userDataPath>/alpha-secrets/**`(`0700`/`0600`) | `alpha-secret-files.ts` |
| `<userDataPath>/alpha-mcp-secrets/<server>/<verId>/<VAR>` | `alpha-mcp-secrets.ts`(源码侧 19 处) |
| `<userDataPath>/catalog-channel-state.json` | `catalog-channels.ts` |
| `<userDataPath>/`(远端 catalog 缓存) | `remote-catalog.ts` |
| `<alphaGlobalRoot>/{ext-store,ext-tx}/**` | `ext-receipt-v2.ts` / `ext-transaction.ts` / `ext-bundle-lock.ts` / `ext-atomic-fs.ts` / `ext-cas.ts` / `ext-file-tx.ts` / `ext-config-tx.ts` |
| `<alphaGlobalRoot>/alpha.jsonc` + `*.alpha-bak-*` | `ext-config.ts`(真机 `~/.config/opencode/opencode.jsonc.alpha-bak-*` 是同族历史产物) |
| `<alphaGlobalRoot>/{installs.json,skills-enabled.json,ecosystem-import.json}` | `alpha-installs.ts` 等 |
| `~/.opencode/**`(桥的 unbridge 一侧) | `alpha-bridge.ts` |
| `<workspace>/.code-puppy/{.gitignore,runs/**,artifacts/**}` | `alpha-workdir.ts` —— **随工作区变化** |

**⇒ 随工作区变化的全部路径(A 段 11–13、20–21,B 段最后一行)都在 `<workspace>/` 这一条前缀
之下。** 对第二块地基(一个 sidecar 服多工作区)的直接含义:围栏每多服务一个工作区只需要多一条
`(subpath <workspace>)`,**不需要**为每个工作区复制一整套应用目录规则。难的仍然是 §6.5 那条:
围栏装上之后**不能加宽**,所以「打开新目录」要么 respawn,要么在 apply 之前就把这一代的工作区
集合定好。

### 7.7 与前两轮的冲突记录(补进 §6.9)

| 前两轮的说法 | 第三轮实测 |
| --- | --- |
| §3 表第 6 行:「**PTY 终端(缺省)** …… 今天被 C1(`cfg.shell` wrapper)罩住 = **是**」 | **在真实产品接线下不成立。** 同一个引擎、同一时刻:`GET /config` 返回 `shell = <alphaGlobalRoot>/bin/zsh`(= ext 的 wrapper),而 `POST /pty` 返回 `command:"/bin/zsh"`、`args:["-l"]`,`ps -p 44246` 也是 `/bin/zsh -l`。机理:ext 的 `config` 钩子改的是 **opencode 侧**合并出来的那个对象(`plugin/index.ts:254` 把 `cfg` 递给钩子),而 `packages/core/src/pty.ts:167` 读的是 **packages/core 的** `Config.Service.entries()` —— 它返回 layer 构造时**从磁盘读到的** `configs` 数组(`packages/core/src/config.ts:214-216`),插件的内存改写它看不见;`Shell.preferred(undefined)` 于是退到 `process.env.SHELL`。第一轮 §2.4 ARM A 是把 `cfg.shell` 直接放进 core 的那份 config 测的,所以它证到的是**结构条件成立**,不是产品接线成立 |
| 第二轮 §6.3.1 的写入集(裸引擎) | 装了 ext 之后**多一份 provider 安装**:`<userDataPath>/alpha-engine-config/node_modules`(26 包 61 MB),与 `<XDG_CONFIG>/opencode/node_modules` 并存 |
| 第二轮 §6.8「alpha 自己那部分写入集没有枚举完」 | 本节闭合,分上下界两级(§7.6) |

第一条的后果要说清楚:**今天 REQ-138 罩住的通路比 §3 表少一行**(终端面板缺省那一支实际未被罩)。
它不改变本票的走向(路一把 PTY 一并罩住,§6.2 已实测),但它是 REQ-138 覆盖面的**独立缺陷**,
应当单独开票,而不是混在本票里顺手改。

### 7.8 第三轮的未验证(如实记账)

- **没有把「装了 ext 的引擎」整个塞进外层围栏跑一遍。** 本轮跑的是两条各自成立的臂:
  ① 装了 ext、**不套**外层围栏的真引擎(§7.4);② 套了外层围栏的 REQ-138 wrapper(§7.4 ARM 2)。
  合成一次(外层围栏 + ext + 真工作负载)**没跑** —— 它需要先按 §7.6 写出候选可写集,
  而那属于方案基线之后的事。
- **shell 工具经会话那条路没跑成**(`ProviderNoProvidersError`,隔离家目录无凭据)。
  §7.4 ARM 1/2 直接执行 wrapper 覆盖了围栏语义,但「引擎 → 工具 → wrapper」整条链在本轮是断的。
- **打包 app 只做了冷启动**:没有装连接器、没开终端、没写 `alpha.jsonc`;而且它那一窗口有
  34 次 dropped ⇒ §7.5 的 19 条是**下界的下界**。
- **上界(85 个调用点)里哪些在 sidecar 里真的到得了,没有逐条证明。** 本轮只证明了它们
  **链接进了出货产物**(rollup 的 tree-shaking 已经删掉一批:例如 `alpha-bridge.ts` 的
  `symlinkSync` 分支不在产物里,`unlinkSync` 在)。逐条可达性是实现票的活。
- **多工作区没测**(§6.7 那一问仍然开着)。本节只回答了「随工作区变化的是哪些路径」。
- **`~/.npm` 与 `<XDG_CONFIG>/opencode` 能不能收窄**(改 `npm_config_cache`、把 config 文件挪出
  可写目录)本轮**没测** —— 与第二轮 §6.3.3 同一条,未闭合。
- **非 darwin 未测**(与前两轮同)。

## 8. 第四轮勘破:候选可写集 + 「装了 ext 的引擎整个塞进围栏」合成一跑(2026-09-09)

§7.8 把这一条明确记为**没跑**:「本轮跑的是两条各自成立的臂……合成一次(外层围栏 + ext +
真工作负载)**没跑** —— 它需要先按 §7.6 写出候选可写集」。本节先写出那份可写集,再把合成那一跑
跑了。

一句话结论:**路一活着。** 五步工作负载(冷启动 → 装连接器 → 开终端 → 跑 shell 工具 →
写 `alpha.jsonc`)在围栏里全部通过,四条越界探针一条都没落盘,而同一批探针在去掉围栏的那条臂上
全部落盘。**但候选可写集比 §7.6 的枚举多两条**,两条都只有实跑才冒得出来,其中一条(`§8.5` 第二条)
**加进可写集也修不好**。

### 8.0 测量口径(第四轮)

| | |
| --- | --- |
| 仓 | `alpha-code@842c374a7`(= 当时的 `origin/alpha`),worktree `.worktrees/ac-1286-synth`,由 `bash scripts/worktree-bootstrap.sh ac-1286-synth -b recon/1286-fenced-ext-synthesis --base origin/alpha` 建(`4729 packages installed [13.01s]`;随后 `bun run --cwd packages/ext typecheck` **exit 0 / 0 条 `error TS` / 0 条 `Cannot find module`**,证明这棵树的结论可信) |
| 宿主 | macOS **26.3.1**(build 25D2128),Darwin 25.3.0 arm64,xnu-12377.91.3 |
| 运行时 | bun **1.3.14**(驱动与引擎);node **v22.22.3**(MCP 探针 server 与 PTY 探针) |
| 包 | `cross-spawn` **7.0.6**;`@modelcontextprotocol/sdk` **1.29.0**;`@lydell/node-pty` **1.2.0-beta.12**;`bun-pty` **0.4.8**;`electron` **42.3.3** |
| 被测 alpha 产物 | `packages/ext/dist/plugin.js`,`bun run --cwd packages/ext build`:出货形态 **837 792 B**;勘破对照臂 **837 963 B**(只多一个 env gate,见下) |
| 出货二进制 | `/Applications/Code Puppy.app` v**0.1.11**,`Identifier=com.tide.alphacode`,`TeamIdentifier=RQX6X6A635`,`flags=0x10000(runtime)` |
| 判据 | **探针文件到底落没落盘**(`find` / `ls` 实读)。HTTP 码、exit code、stderr 只作旁证 |
| 对照臂 | 每一条「没落盘」都配一条**同一探针、同一路径、只去掉 `sandbox-exec` 那一段**的正样本臂;每一条可写集的行都配一条**只去掉这一行**的消融臂 |
| 隔离 | 隔离家目录落在 `/Users/tide/alpha1286s/run-*`(**不在** `/private/tmp` 下 —— §7.4 括注里那个「escape landed 其实是布局问题」的坑,本轮从布局上避开) |
| 日期 | 2026-09-09 |

取证脚本一次性,不入仓;下面贴的是原始输出。

**一处必须先说清的勘破改动(合入前必须删):** §6.5 已证外层整进程围栏与 REQ-138 的
`cfg.shell` wrapper **互斥**,所以「路一的形态」在今天的代码里不存在 —— 要跑它就得让
`wrapEngineShell` 不生效。本轮在 `packages/ext/src/shell-sandbox.ts` 的 `wrapEngineShell`
开头加了**四行、只读一个环境变量**的对照臂开关,构建成第二份 bundle;随后
`git checkout -- packages/ext/src/shell-sandbox.ts` 还原并重建出货形态那份(`grep -c` 实证:
对照臂 bundle 含该变量名 **1** 次,出货形态那份 **0** 次)。**它不是围栏实现,也不是提案的接线方式** ——
真正的实现要拆掉 REQ-138 那一层,不是用环境变量绕过它。

> 副作用,免得下一个人误读:该 gate 走的是 `wrapEngineShell` 的「没围成」返回路径,于是
> `plugin.ts:158` 会打印 `engine shell sandbox FAILED to install (...) — cfg.shell forced to a
> deny stub ()`。**这行日志在本轮是假的** —— deny stub 的赋值发生在 `wrapEngineShell` 的
> `catch` 里,提前 return 不经过它;实测 `GET /config` 里 `shell` 键**整个不存在**,
> 引擎因此走 `Shell.preferred(undefined)` 落到 `/bin/zsh`,shell 工具照常执行。

### 8.1 五问,各一句

1. **候选可写集长什么样、有多少条?** 19 条(§8.2)。其中 **7 条不放行就出人命**:6 条让引擎/注入
   直接死,1 条让 provider 静默装不上。
2. **装了 ext 的引擎整个塞进围栏,活不活?** **活。** 五步工作负载全过,四条越界探针 0 落盘,
   正样本臂 4/4 落盘(§8.3)。
3. **今天直接在外面套一层会怎样?** **每一次 shell 工具调用零执行** ——
   `sandbox-exec: sandbox_apply: Operation not permitted`,而且这次是**经真引擎 → 真工具 → 真 wrapper**
   量到的,不是手工拼的命令(§8.4)。这条闭合了 §7.8 记的「引擎 → 工具 → wrapper 整条链在本轮是断的」。
2'. **§7.6 的枚举够不够直接当 profile?** **不够**,差两条,见 §8.5;其中一条说明
   「按文件放行」与「按目录放行」**语义不等价**,这一条会影响可写集的整体形状。
5. **另两块地基有没有顺带读数?** 有,但都**不闭合**(§8.7)。

### 8.2 候选可写集(19 行)与逐行消融

profile 由一个生成器按根变量展开(`WORKDIR` / `<alphaGlobalRoot>` / `<userDataPath>` / `HOME`),
每行带一个 id,消融臂 = 只去掉那一行、其余逐字不变。F2 那一跑的实际 profile(隔离路径已保留原样):

```
(version 1)
(allow default)
(deny file-write*)
(allow file-write*
  (subpath "<WORKDIR>")                                  ; W1  每个工作区一条
  (subpath "<alphaGlobalRoot>")                          ; W2  = <appData>/alpha-code-state/env/<env>
  (subpath "<userDataPath>")                             ; W3  含 alpha-engine-config/**、opencode/locks/**
  (subpath "<HOME>/.local/share/opencode")               ; W4  上游引擎 log / *.db / -wal / -shm / repos
  (subpath "<HOME>/.cache/opencode")                     ; W5  bin / models.json
  (subpath "<HOME>/.config/opencode")                    ; W6  第二份 provider 安装(见 §7.4 坑一)
  (subpath "<HOME>/.npm")                                ; W7  @npmcli/arborist 的 cacache,不随 XDG
  (regex #"^<HOME>/\.zsh_history")                       ; W8  登录 shell(见 §8.5 坑一)
  (subpath "<HOME>/.zsh_sessions")                       ; W10 见 §8.6 —— 生产路径上到不了
  (regex #"^<HOME>/\.zcompdump")                         ; W19 加了也没用,见 §8.5 坑二
  (subpath "/private/tmp")                               ; W11
  (subpath "/private/var/folders")                       ; W12 $TMPDIR
  (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr")   ; W13
  (literal "/dev/tty") (regex #"^/dev/fd/")              ; W14
  (literal "/dev/ptmx") (regex #"^/dev/ttys")            ; W15 §6.4 那两条,PTY 靠它
  (subpath "<HOME>/.opencode")                           ; W16 §7.6 B 段的桥
  (subpath "<HOME>/Library/Caches/bun")                  ; W17 dev-only
  (subpath "<HOME>/.cache/bun")                          ; W18 dev-only
)
```

**逐行消融(全部 fenced、全部冷启动、全部与 F2 同一条命令,只少一行):**

| id | 内容 | 去掉之后实测 | 定级 |
| --- | --- | --- | --- |
| **W3** | `<userDataPath>` | **`/global/health` 从头到尾拿不到 200**(90 s 超时);`injectAlphaConfig` = `{ok:false, EPERM ...}` | **起不来** |
| **W4** | `<HOME>/.local/share/opencode` | **health 恒 0** | **起不来** |
| **W5** | `<HOME>/.cache/opencode` | **health 恒 0** | **起不来** |
| **W6** | `<HOME>/.config/opencode` | **health 恒 0** | **起不来** |
| **W15** | `/dev/ptmx` + `^/dev/ttys` | 引擎正常、MCP 连上,但 **`POST /pty` = HTTP 500**,PTY 探针不落盘 | **终端面板整个不可用** |
| **W2** | `<alphaGlobalRoot>` | 引擎 health 200,但 `injectAlphaConfig` = `{ok:false, EPERM}`;`<alphaGlobalRoot>/alpha.jsonc` **未落盘**,`<userDataPath>/alpha-engine-config` **不存在** | **注入整份丢失** = `alpha-config-injection.ts` 头注里 `#613` 记的「模型全灰」 |
| **W7** | `<HOME>/.npm` | 引擎 health 200、MCP 连上、PTY 200、shell 工具正常 —— 但**两处 `node_modules` 都不存在**;`opencode.log` 里两条 `level=WARN … "background dependency install failed" … NpmInstallFailedError`,各对应一个 provider 目录 | **静默:provider 一个都装不上**(health 仍 200,这是最难诊断的一档) |
| **W8** | `\.zsh_history` 家族 | 引擎与 PTY 都正常,但终端里出现 `zsh: locking failed for <HOME>/.zsh_history: operation not permitted`;`.zsh_history` 不落盘 | **用户每开一次终端看一条报错** |
| W1 | `<WORKDIR>` | health 200、MCP `connected`、`POST /pty` 200 —— 但**工作区里一个字节都写不进去**:self / mcp / pty / shelltool / `.code-puppy/alpha.jsonc` 五条界内探针**全部不落盘** | 起得来、连得上、**一件活也干不了** |
| W11 | `/private/tmp` | 五步工作负载全过,探针表与 F2 逐格相同 | 本轮**未证伪** |
| W12 | `/private/var/folders`($TMPDIR) | 同上 | 本轮**未证伪** |
| W13 | `/dev/null` `/dev/stdout` `/dev/stderr` | 同上 | 本轮**未证伪** |
| W14 | `/dev/tty` `^/dev/fd/` | 同上 | 本轮**未证伪** |
| W16 | `<HOME>/.opencode` | 同上 | 本轮**未证伪**(§7.6 B 段那条桥没走到) |
| W17+W18 | 两处 bun 缓存 | 同上 —— **连 dev 引擎跑在 bun 上都没用到** | dev-only,且本轮**未证伪** |
| W10 | `.zsh_sessions` | **本轮没有单独消融**;见 §8.6 —— 生产接线上到不了它 | 见 §8.6 |
| W19 | `\.zcompdump` | **加不加都一样**,见 §8.5 坑二 | 见 §8.5 |

**「未证伪」不等于「可以删」。** 上面六行只说明**这一条工作负载**没走到它们;`/dev/null` 是
REQ-138 spike 里已知必需的(重定向),`$TMPDIR` 在 §7.4 的报告面里有 2 条命中。它们要么保留,
要么各自补一条能走到它的用例再删 —— 本轮不做这个判定。

### 8.3 合成一跑:三条臂,同一条命令只差一段

三条臂用的是**同一个驱动、同一份工作负载、同一批探针**,差别只有两处:外层要不要
`sandbox-exec`,以及装哪一份 ext bundle。

```
# B1 正样本臂:不套围栏
cd packages/ui-mac && bun run ./alpha1286s-driver.ts
# F1:套围栏 + 出货形态的 ext(= 今天的代码直接加一层)
cd packages/ui-mac && /usr/bin/sandbox-exec -f <ISO>/fence.sb "$(which bun)" run ./alpha1286s-driver.ts
# F2:套围栏 + 拆掉 REQ-138 那层的 ext(= 路一的形态)
同上,只换 ALPHA1286_EXT 指向的 bundle
```

驱动本身就是被围栏的那个进程(与生产里「sidecar 自打沙箱之后再 import 引擎」同形),
它先跑 `injectAlphaConfig(userDataPath, extPluginPath, "dev")`,再把引擎作为**子进程**拉起来。

**探针落盘表(第二台仪器:跑完 `ls` 实读,不看进程自报):**

| 探针 | 谁写的 | B1(无围栏) | F1(围栏 + 出货 ext) | F2(围栏 + 路一形态) |
| --- | --- | --- | --- | --- |
| `<ws>/self-in.txt` | 被围栏进程自身 | **落盘** | **落盘** | **落盘** |
| `<esc>/self-esc.txt` | 同上 | **落盘** | 不落盘 | 不落盘 |
| `<ws>/mcp-in.txt` | MCP stdio 子进程(node,经 SDK 自带 cross-spawn) | **落盘** | **落盘** | **落盘** |
| `<esc>/mcp-esc.txt` | 同上 | **落盘** | 不落盘 | 不落盘 |
| `<ws>/pty-in.txt` | `POST /pty` 派生的真 PTY | **落盘** | **落盘** | **落盘** |
| `<esc>/pty-esc.txt` | 同上 | **落盘** | 不落盘 | 不落盘 |
| `<ws>/shelltool-in.txt` | `POST /session/:id/shell` → `cfg.shell` | **落盘** | **不落盘(零执行)** | **落盘** |
| `<esc>/shelltool-esc.txt` | 同上 | **落盘** | 不落盘 | 不落盘 |
| `<ws>/.code-puppy/alpha.jsonc` | ext 的 `alpha_register` | **落盘** | **落盘** | **落盘** |
| `<alphaGlobalRoot>/alpha.jsonc` | `injectAlphaConfig` | **落盘** | **落盘** | **落盘** |
| `<HOME>/.zsh_history` | `POST /pty` 起的登录 shell | **落盘** | **落盘** | **落盘** |
| **escape 目录条目数** | | **4** | **0** | **0** |

`escape/` 在 F1/F2 两臂都是空目录(`ls -A` count=0),而 B1 是 4 个文件 ——
**正样本臂非空**,这台仪器这一刻是活的。

**F2 的工作负载逐条(全部真调用,原始响应):**

| 动作 | 结果 |
| --- | --- |
| `GET /global/health` | `200 {"healthy":true,"version":"local"}` |
| `GET /project/current` | `200`,`worktree` 正确,`vcs:"git"` |
| `POST /session` | `200` |
| **装一个连接器** `POST /mcp` | `200 {"alpha1286probe":{"status":"connected"}}` —— 探针 server 真起来、真写了盘 |
| **开一个终端** `POST /pty`(缺省) | `200`,`command:"/bin/zsh"`,`args:["-l"]` |
| `POST /pty`(带 `command`/`args`) | `200`,PTY 探针界内落盘、界外不落盘 |
| **跑一次 shell 工具** `POST /session/:id/shell` | `200`;工具输出 = `(eval):1: operation not permitted: <esc>/shelltool-esc.txt` + `rc=0`;界内那条**落盘** |
| **写一次 `alpha.jsonc`** `alpha_register` | `command "alpha1286probe" registered in .code-puppy/alpha.jsonc`,文件真落盘 |
| 运行时 npm 安装 | **在围栏里完成**,两处各 **28 个顶层包 / 61 MB**,`<HOME>/.npm` 93 MB(§7.4 记的是 26 包,本轮 28 —— 依赖推进,**两份并存这一条不变**) |
| `GET /experimental/tool/ids` | 含 `alpha_reload` / `alpha_register` / `alpha_echo` / `alpha_ping` ⇒ ext 确实装进了这台被围栏的引擎 |

⇒ **AC2(MCP)、AC3(LSP 同族)、PTY、shell 工具四条通路的越界写,在整进程围栏下同时失败;
上游 0 行改动。** 与 §6.3.2 的区别是:那一轮跑的是**裸引擎**,这一轮是**装了 `@alpha-code/ext`
的引擎跑完一整套工作负载**。

**一条口径上的诚实话:`alpha_register` 是直接装载出货 bundle 执行的**(`import(dist/plugin.js)`
→ `hooks.tool.alpha_register.execute(...)`),因为它要模型回合才会经会话触发,而隔离家目录里没有凭据。
执行它的进程**就是被围栏的那个进程**,所以「这条写入通路在围栏下通不通」是实测的;
「引擎 → 模型 → 工具」那一段仍然**没跑**(与 §7.4 同一条,未闭合)。同样地,
`shell` 端点这次能跑通,是因为 payload 里显式给了 `model`,绕开了 §7.4 撞到的
`ProviderNoProvidersError`(`prompt.ts:505` 的 `input.model ?? agent.model ?? currentModel(...)`);
`shellImpl` 本身不发 LLM 请求,所以这一步量到的是真的工具派生路径。

### 8.4 F1 —— 今天照原样加一层外层围栏会发生什么

| | |
| --- | --- |
| 命令 | 与 F2 逐字相同,只把 ext bundle 换成出货形态那一份 |
| `GET /config` 的 `shell` | `<alphaGlobalRoot>/bin/zsh`(= ext 的 wrapper,REQ-138 那层还在) |
| `POST /session/:id/shell` | HTTP **200**,但工具输出 = **`sandbox-exec: sandbox_apply: Operation not permitted`** |
| 落盘 | 界内 **和** 界外**都不落盘** ⇒ **零执行** |
| 其余 | health / MCP / PTY / `alpha_register` / 两处 provider 安装**全部正常** |

⇒ §6.5 的互斥结论,现在有了**经真引擎、真会话、真工具调用**量到的版本。§7.4 ARM 2 是手工执行
wrapper 量的,§7.8 把「引擎 → 工具 → wrapper 整条链」记为断的 —— **这一格闭合**。

**它同时说明路一的落地顺序不能反:** 先装外层围栏、后拆 REQ-138 ⇒ 中间那一刻**每一次 shell 工具
调用都零执行**,而 HTTP 仍然回 200。两件事必须是同一次变更,或者先拆后装。

### 8.5 两条只有实跑才冒出来的坑

**坑一:`.zsh_history` 不止一个文件 —— §7.6 第 22 行按原文立闸会当场报错。**
§7.6 写的是 `$HOME/.zsh_history`、`$HOME/.zsh_history.LOCK`、`$HOME/.zsh_sessions/**`。
按这三条写成 `(literal ...)` 之后,登录 shell 退出时终端里出现:

```
zsh: failed to write history file <HOME>/.zsh_history.new: operation not permitted
```

zsh 存历史是**写 `.zsh_history.new` 再改名**,那个中间名不在枚举里。改成
`(regex #"^<HOME>/\.zsh_history")` 之后同一条命令**零报错**;去掉这一行则变成另一条报错
`zsh: locking failed for <HOME>/.zsh_history: operation not permitted`。三臂都用**真 PTY 起真登录 shell**
(`@lydell/node-pty` 起 `/bin/zsh -l`,交互,发 `echo`/`exit`)量的,判据是终端里那串字节 + 家目录落盘。

判据本身也验过正反:同一条 regex 下 `/bin/sh` 写 `.zsh_history` / `.zsh_history.new` /
`.zsh_history.LOCK` **三个都成功**,同一条命令里写 `other.txt` **失败**(`Operation not permitted`)。

**坑二:按文件放行 ≠ 按目录放行 —— 会让「先检查目录可写」的程序静默走进失败分支。**
用户 `.zshrc` 里一句很常见的 `autoload -Uz compinit && compinit`,在围栏下**不生成 `~/.zcompdump`,
而且一个字都不报**:

```
# 同一份 .zshrc / .zprofile(从真实家目录拷进隔离家目录),同一条 PTY 命令
无围栏 :  家目录落盘 = .zcompdump .zprofile .zsh_history .zshrc
有围栏 :  家目录落盘 = .zprofile .zsh_history .zshrc          ← 少了 .zcompdump,终端零报错
```

**把 `(regex #"^<HOME>/\.zcompdump")` 加进可写集,它依然不生成。** 机理实读
`/usr/share/zsh/5.9/functions/compdump:22`:

```zsh
[[ -w ${_d_file:h} ]] || return 1
```

它先问「**这个目录**可写吗」。围栏里 `<HOME>` 本身不在可写集(只有它下面几个具名文件在),
于是 `access(2)` 答不可写,compdump 直接 `return 1`。实测三行并排:

```
围栏内:  [ -w $HOME ] → NO
         echo probe > $HOME/.zcompdump  → OK      ← 文件写得进去
         echo probe > $HOME/other.txt   → FAILED
```

`compinit` 返回 0,`compaudit` 也返回 0,**没有任何一层报错** —— 唯一可观察的是每次开终端
重扫补全(慢),以及 dump 永远建不出来。

这一条比它自己重要:**可写集里凡是「只放行某个目录下的几个具体文件」的写法,对任何用
`access(W_OK)` 预检目录的消费方等价于「整个目录不可写」**,而那些消费方通常安静地降级。
`<HOME>` 这一层还有一个结构性问题:**登录 shell 执行的是用户自己的 rc 文件**,它们的写入面
不由我们的产物决定,**永远不可能从出货 bundle 派生出来**(§7.3 那套单一权威覆盖不到这里)。

### 8.6 §7.4 的一条更正:`.zsh_sessions` 是夹具带进来的

§7.4 把 `$HOME/.zsh_sessions/**` 与 `.zsh_history` 并列成「`POST /pty` 会写」。
本轮实测**它在生产接线上到不了**:

- `/etc/zshrc_Apple_Terminal:102` 才是写 `.zsh_sessions` 的地方,而它整段由
  `TERM_PROGRAM = Apple_Terminal` 守着;
- `Pty.create` 传下去的 env 是 `{...process.env, TERM, OPENCODE_TERMINAL}`,而 sidecar 的
  `process.env` 由 `sidecar-env.ts` 的 **allowlist** 产生:`EXACT` 表里没有 `TERM_PROGRAM`,
  `PREFIXES` 只有 `OPENCODE_` / `XDG_` / `LC_` / `ELECTRON_`;
- 真机 `~/Library/Application Support/ai.opencode.desktop/alpha-shell-env.json` 实读 **3 个键,
  不含 `TERM_PROGRAM`**;
- 实测复现:同一条 PTY 命令,`TERM_PROGRAM` 缺席时家目录只出 `.zsh_history`;把
  `TERM_PROGRAM=Apple_Terminal` 加回去才出 `.zsh_sessions/*.session`。

§7.4 那次驱动是从开发者的终端里起的,**`TERM_PROGRAM=Apple_Terminal` 顺着环境继承进了引擎** ——
这是《本机验证陷阱》里「夹具顶替了供数方」的又一例,与 §7.7 第一行同源。
可写集里这一行**留着无害**(生产走不到),但**不要拿它当已知写入面**。

### 8.7 顺带取得的另两块地基读数(都**不闭合**)

**地基二(原生模块在签名包内能否加载)—— 只把地面真相收窄了,没有实测。**

| 事实 | 实读 |
| --- | --- |
| 出货包已带的原生模块 | 三个:`@parcel/watcher-darwin-arm64/watcher.node`、`@msgpackr-extract/.../node.napi.glibc.node`、`@lydell/node-pty-darwin-arm64/prebuilds/darwin-arm64/pty.node` |
| 它们的签名 | `pty.node`:`TeamIdentifier=RQX6X6A635`,`flags=0x10000(runtime)` —— **与 app 同一个 Team**,且今天在 hardened runtime 下正常加载 |
| app 的 entitlements | 只有 `cs.allow-jit`、`cs.allow-unsigned-executable-memory`、`device.audio-input`;**没有** `cs.disable-library-validation` ⇒ 库校验开着,只能加载同 Team 签名的库或系统库 |
| `libsandbox` | `/usr/lib/libsandbox.1.dylib` **在盘上不存在**(dyld 共享缓存),但 `dlopen` 三种写法都成功,`sandbox_init` / `sandbox_init_with_parameters` / `sandbox_free_error` 三个符号都解析得到 |

⇒ 需要的那个附加模块所依赖的库是 **Apple 系统库**(不受库校验限制),而它自己会被同一条流水线
用同一个 Team 签名 —— 与三个已在出货的 `.node` 同形。**本轮这仍然是推断:本轮没有写、没有签、
没有在打包 app 里加载过任何新的 `.node`。**

> **2026-09-09 更正:这条推断已被实测证实,不再是推断。** `#1316` 写了一个最小 N-API 模块、
> 由发版那条命令自己签、放进真的打包产物,在**引擎 sidecar 进程**与主进程各 `dlopen` 成功一次,
> 三个符号全解析到;ad-hoc / 别的 Team / 去签名三条反例臂在同一进程里被库校验按 Team 拒掉。
> 同一个模块在出货 sidecar 里调 `sandbox_init_with_parameters` 实测 `rc=0` 且围栏真生效。
> 全部读数与未测项见 [`2026-09-09-req159-u1-native-addon-signed-load.md`](2026-09-09-req159-u1-native-addon-signed-load.md)。(§6.6 P1 的原文口径不变。)顺带更正一处坐标:
§6.6 写的 `/usr/lib/libsandbox.1.dylib` 不是盘上文件,是共享缓存里的名字。

**地基三(一个 sidecar 服 N 个工作区 vs 可写集不能加宽)—— 形状实测出来了,矛盾没解。**

| 臂 | profile | 实测 |
| --- | --- | --- |
| M1 | 可写集含 **两个**工作区(`(subpath ws1)` + `(subpath ws2)`) | 同一个被围栏的 sidecar,`GET /project/current?directory=ws2` **200**、`POST /session` **200**、shell 工具在 **ws2 里写文件成功**(`ws2/ws2-in.txt` 落盘),同时越界探针仍然 0 落盘 |
| M2 | 可写集**只含 ws1**(= 用户打开了新目录而 sidecar 没 respawn) | `GET /project/current?directory=ws2` 仍 **200**、session 建得出来、**读**没问题 —— 但 shell 工具输出 `(eval):1: operation not permitted: <ws2>/ws2-in.txt`,**文件不落盘** |

⇒ **「可写集取本代已知工作区之并」这条路在机制上成立**(M1 实测),§7.6 那句「多一个工作区只多
一条 `(subpath <workspace>)`」得到确认。**而 M2 就是不解决它的代价形状:项目打得开、看得见、读得了,
一写就失败**,并且失败点在工具输出里、不在任何启动日志里。**「打开新目录 ⇒ respawn sidecar」
本轮没有实现也没有实测**(§6.7 那一问仍然开着)。

> **已裁决(2026-09-09,`#1317`):取启动时并集,不把「打开新目录」接成 respawn 触发器。**
> 定价、五工作区实跑、65 535 那道硬天花板、respawn 的 10.087 s 与三条在途损失,见
> [`2026-09-09-multi-workspace-fence-decision.md`](2026-09-09-multi-workspace-fence-decision.md)。

**顺带一条会咬人的:K1(围栏内不能 exec set-ID 二进制)在路一下从「shell 工具」扩大到「整个引擎进程」。**
实测 `/bin/ps` 是 `-rwsr-xr-x root:wheel`,围栏内 `execvp() of '/bin/ps' failed: Operation not permitted`;
F1/F2 两臂里驱动想用 `ps -p <pid>` 读 PTY 的进程名,拿到的都是空串(B1 无围栏时是 `/bin/zsh -l`)。
`/usr/bin/top`、`/usr/bin/su`、`/usr/bin/login`、`/usr/bin/newgrp`、`/usr/bin/quota` 同为 set-ID。
反面对照:`/usr/bin/pgrep` **不是** set-ID,围栏内外行为一致(两臂同为 rc=1)——
所以 `mcp/index.ts:459` 那条 `pgrep` 不受影响。`#1149` 已登记的这条代价,其**爆炸半径在路一下变大**,
需要在方案基线里重新定价。

### 8.8 第四轮的未验证(如实记账)

- **出货形态(node + 打包产物 + 围栏)仍然没有合成过。** 本轮引擎跑在 **bun**(dev 树),
  PTY 探针跑在 **node**。`sidecar.js` 的入口顶层就 `getParentPort()`,脱离 `utilityProcess`
  跑不起来 ⇒ 要在出货形态上复跑这一节,得先有 §6.6 P1 那个附加模块。
- **围栏下没有发过一次真的模型请求**(与 §6.8 同一条,隔离家目录无凭据,也不愿花 owner 额度)。
  `shell` 端点这次是靠显式 `model` 绕开 provider 解析跑通的。
- **`alpha_register` 仍是直接装载 bundle 执行**,不是经模型回合触发(与 §7.4 同一条)。
- **消融表里 6 行「未证伪」不是「可删」**(§8.2 末尾),它们各自缺一条能走到自己的用例。
- **`W10`(`.zsh_sessions`)没有单独消融**;§8.6 只证明生产接线上到不了它。
- **用户 rc 文件的写入面没有边界。** 本轮只用了我自己的 `.zshrc` / `.zprofile` 一份样本
  (它触发了 `compinit`)。别人的 rc 会写什么,**结构上枚举不了** —— 这是路一必须在基线里
  正面回答的一条,不是残余风险。
- **§7.6 B 段(出货产物里可达、本轮没跑到)仍然没有逐条可达性证明**,与第三轮同。
- **`(with report)` 那台仪器本轮再次瞎给我看了。** 用 `(allow file-write* (with report))` 罩住
  compinit 想抓它写了哪些路径:`log stream --level debug` 里**与本次隔离树相关的路径 0 条**,
  **连同一窗口里的 positive-control 写入也 0 条**,且**没有 dropped 标记**。
  这正是 §7.2「换个可执行文件就整个不报告,且不会给你 dropped 标记」那一类。
  本节所有结论因此都只用**盘上快照**判定,报告面一条也没用。
- **非 darwin 未测**(与前三轮同)。

### 8.9 与前三轮的冲突记录(接 §6.9 / §7.7)

| 前三轮的说法 | 第四轮实测 |
| --- | --- |
| §7.6 第 22 行:`POST /pty` 写 `$HOME/.zsh_history`、`.zsh_history.LOCK`、`.zsh_sessions/**` | `.zsh_history` **对**,但少了改名用的 **`.zsh_history.new`** —— 按原文立闸,用户每次开终端看一条 `failed to write history file` (§8.5);`.zsh_sessions` **在生产接线上到不了**,是夹具带进来的(§8.6) |
| §7.8 第一条「合成一次(外层围栏 + ext + 真工作负载)没跑」 | 本节跑了(§8.3),**五步全过、越界 0 落盘、正样本臂 4/4 落盘** |
| §7.8 第二条「引擎 → 工具 → wrapper 整条链在本轮是断的」 | 闭合(§8.4):经真会话调 shell 工具,拿到 `sandbox_apply: Operation not permitted` 且**零执行** |
| §6.6 「bun:ffi 直连真 `/usr/lib/libsandbox.1.dylib`」 | 该路径**在盘上不存在**(dyld 共享缓存);`dlopen` 用它、用 `/usr/lib/libsandbox.dylib`、用裸名字都成功,三个符号都在(§8.7) |
| §7.4 「两处各装 26 包 / 61 MB」 | 本轮 **28 包 / 61 MB**(依赖推进);**「两处并存」这一条不变**,是可写集里 W3+W6 两行都不能少的直接理由 |
| `#1149` K1「围栏内 set-ID 不可 exec」= 一条 shell 工具的已知代价 | 路一下它是**整个引擎进程**的代价:`/bin/ps`、`/usr/bin/top` 等在围栏内 `execvp` 直接失败(§8.7) |


## 9. 用法

本文档是 REQ-159 方案基线(`docs/design/`)与其实现票**开工前**的对照物。三条纪律:

1. §2 是基准。任何与它冲突的断言,**先复跑再改文档**,不要改实现去迁就散文。
2. §1 里那条更正(MCP 不经 `ChildProcessSpawner`)推翻了票面的现状坐标 —— 基线里凡是从
   「C3 一次罩住两条」推出来的选项,前提已不成立。
3. §5 与 §6.8 的每一条,在实现票里必须变成实跑结论或显式的风险接受。
4. §6.9 与 §7.7 是本文档内部的冲突台账:凡与 §6 冲突的旧断言以 §6 为准,凡与 §7 冲突的以 §7 为准。
   §7.7 第一行是**减覆盖**方向的更正(PTY 缺省今天并未被 REQ-138 罩住),不要照 §3 表原文立闸。
5. **可写集以 §8.2 为准,不要照 §7.6 的枚举原文立闸** —— §7.6 是「写入面枚举」,§8.2 是
   「跑通过的 profile」,两者差两条(§8.5),其中一条改的是可写集的**形状**(按文件放行
   对预检目录的消费方等价于不可写)。§8.9 是第四轮的冲突台账,与它冲突的旧断言以 §8 为准。
