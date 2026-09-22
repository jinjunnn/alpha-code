---
title: 引擎进程围栏:sidecar 自打 seatbelt 的落地形状(REQ-159)
kind: architecture
status: active
owners:
  - alpha-code desktop maintainers
last_reviewed: 2026-09-22
review_after: 2026-12-09
supersedes:
  - 2026-08-23-shell-sandbox-seam.md
---

# 引擎进程围栏 —— 装在哪、可写集从哪来、装不上会怎样

方案基线是 [`../design/2026-09-09-req159-process-fence-baseline.md`](../design/2026-09-09-req159-process-fence-baseline.md)
(路一,五条不变量);地面真相是四轮勘破 [`2026-09-08-derived-process-spawn-paths.md`](2026-09-08-derived-process-spawn-paths.md)
与 U1 / U2 两份决定书。本文只写**落地之后的形状**:代码在哪一行做了什么、判据在哪、什么没做。
实现票 `alpha-code#1321`。

一句话:**引擎 sidecar 在 import 引擎之前把自己关进 seatbelt**,之后它派生的一切(shell 工具 / MCP stdio /
LSP / PTY / formatter …)自动继承;REQ-138 那层(`cfg.shell` → `sandbox-exec` wrapper)在**同一次变更**里拆掉。

## 1. 三个进程,各做一件事

| 进程 | 文件 | 做什么 |
| --- | --- | --- |
| **main**(不被围栏) | `packages/ui-mac/src/main/server.ts` `spawnLocalServer` → `process-fence-plan.ts` | fork 之前做**计划**:渲染可写集(`process-fence-profile.ts`)→ 用真 `/usr/bin/sandbox-exec` **试编译**(`process-fence-compile.ts`)→ 编不过就从并集尾部丢一个工作区再试 → 解析原生模块路径 → 把 `{ profile, addonPath }` 放进 `start` 命令。任何一步失败 ⇒ **拒绝 fork**(与 alpha-secrets sync 失败同一条路),日志一行原因 |
| **sidecar**(被围栏) | `packages/ui-mac/src/main/sidecar.ts` `start()` 第一句 → `process-fence-apply.ts` | 收到 `start` 后**第一件事** `process.dlopen` 原生模块、`sandbox_init(profile)`,然后**双向自证**:往 `/private/var/tmp` 写一个探针必须 EPERM(围栏不是空的)、往自己的 cwd(`engine-scratch-cwd`,W3 之下)写一个探针必须成功(围栏没紧到干不了活)。任一失败 ⇒ 抛 ⇒ 既有的 `error` IPC + `exit(1)` ⇒ main 宣告这一代失败。darwin 上 `start` 命令没带 `fence` 也拒。非 darwin 没有 seatbelt:打一行 warn,如实不装 |
| **引擎及其子进程** | 上游 0 行改动 | 继承 sidecar 的 seatbelt(勘破 §6.2:cross-spawn / `node:child_process` / 孙进程 / detached / node-pty 五条原语实测) |

原生模块:`packages/ui-mac/native/alpha-fence/alpha_fence.c`(约 100 行 C,N-API 8,头文件来自钉版的
`node-api-headers` devDependency)。它只做三件事:`dlopen` libsandbox(dyld 共享缓存里的名字)、`dlsym`
`sandbox_init` / `sandbox_free_error`、`apply(profile) → { rc, error }`。**它不决定可写集**。
`scripts/build-fence-addon.ts` 在 `prebuild` / `predev` 里把它编成一个 **fat** 文件(arm64 + x86_64 同一个
`.node`),`electron-builder.config.ts` 经 `extraResources` 放到 `<resources>/alpha-fence/alpha_fence.node`
(与 U1 `#1316` 实测加载得了的落点同形;签名由发版流水线深签,与 `pty.node` 同 Team)。

## 2. 可写集:唯一权威 + 两道闸

`packages/ui-mac/src/main/process-fence-profile.ts` 的 `renderProcessFenceProfile` 是可写集的**唯一**渲染点。
行 = 勘破 §8.2 的 19 行**逐字**(不照 §7.6;差在 `.zsh_history.new` 与「按文件放行 ≠ 按目录放行」两处),
参数已代入:

- `W1` 每个工作区一条 `(subpath …)`(并集规则见 §3);
- `W2` `<alphaGlobalRoot>` · `W3` `<userDataPath>`(state 根跟着 sidecar.ts 对 `XDG_STATE_HOME` 的决定:用户
  显式导出别处时多一行) · `W4/W5/W6` `<XDG_{DATA,CACHE,CONFIG}_HOME>/opencode`(与 `packages/core/src/global.ts`
  经 `xdg-basedir` 的取法逐字同形,由测试对着 node_modules 里那份包交叉验证) · `W7` `~/.npm`;
- `W8` `~/.zsh_history*`(regex) · `W10` `~/.zsh_sessions` · `W19` `~/.zcompdump*`(regex);
- `W11` `/private/tmp` · `W12` `/private/var/folders` · `W13`–`W15` `/dev` 节点(`/dev/ptmx` `^/dev/ttys` 是 PTY 的命);
- `W16` `~/.opencode` · `W17/W18` bun 缓存(dev-only,未证伪 ≠ 可删,保留)。

**没有加任何 §8.2 之外的行**。已知的缺口(留给披露面 / owner):bash 用户的 `~/.bash_history` 不在集合里
(§8.2 只量了 zsh);任何用户 rc 文件的写入面结构上枚举不了(基线 I3)。

两道闸:

1. **形状闸** `process-fence-profile.test.ts`:渲染结果与 §8.2 逐行全等,少一行 / 放宽一行即红。
2. **写入点登记簿**(AC3)`scripts/process-fence-write-sites.tsv` + `process-fence-write-sites.test.ts`:
   alpha 在 sidecar 进程里的每一处写盘调用点(`packages/ext/src/**` 全部 + `sidecar.ts` 的相对 import 闭包,
   用 TypeScript AST 解析 `node:fs` 绑定 —— 改名 import / namespace / `promises` / 多行 import 都抓)都要登记
   它落在哪一行(`W-id`,可 `+` 连多个;`arg` = 路径来自调用方;`main-only` = 只有 main 执行到,今天只
   `alpha-environment.ts` 一处)。**新增一处写盘不登记 ⇒ 红**;点不出根 = 新的写入根 = 要么给可写集加行
   (带实测)要么改代码。当前 76 条签名 / 92 个调用点。

**状态根下 main 独占的真源**(可写集的反面:这些位置**故意**不在任何一行之下)。`<appData>/alpha-code-state`(冻结环境快照的
`casBaseRoot`)本身不在可写集里 —— W2 只放行它之下的 `env/<env>`;于是它的其它子目录就是「main 写得了、引擎写不到」的家,
由文件系统边界给出,一条 `grep` 就能复核,不依赖任何加密假设:

| 子目录 | 存什么 | 谁写 | 落地 |
| --- | --- | --- | --- |
| `cas/` | 扩展 CAS 存储 | main / GC worker | 先例 |
| `fence-workspaces/<env>.json` | 围栏的工作区清单(§3 5c) | main,经 renderer IPC | `#1394` |
| `custom-providers/<env>.json` | 用户「添加自定义节点」的记录 `{ v: 1, providers: [{ id, name, compat, baseURL, models }] }`,**密钥不进这里**(仍在 `#1343` 的钥匙串库) | main(`custom-provider-truth-write.ts`);读端 `custom-provider-truth.ts` 零写盘、不 import `node:fs` | `#1391` 只落存储层,**零消费者**(§7) |

`custom-providers` 的读与写刻意拆成两个文件:读端将来要被 `alpha-models.ts` / `ext-config.ts`(都在 sidecar 的 import 闭包里)
消费,写入点若跟着进闭包,上面那本登记簿只能给它填 `main-only` 这个文字标签 —— 那不是判据。写模块不在闭包里由
`custom-provider-truth-write.test.ts` 对着生产的 `sidecarSourceFiles` 实测。读端**严格**:缺失 = 没有记录;解析失败 / 版本不认识 /
字段不合法 / 同 id 重复 / 多余的键 ⇒ 「没问出来」(不是空清单)并出一行日志。真源路径不在可写集任何固定行之下的判据在
`custom-provider-truth.test.ts`(对着渲染出的 profile 逐条规则枚举 W-id;W1 由 §3 5b 兜)与 `custom-provider-truth-fence.test.ts`
(真 sandbox-exec)。方案基线:[`../design/2026-09-21-1383-custom-provider-address-truth-baseline.md`](../design/2026-09-21-1383-custom-provider-address-truth-baseline.md)。

## 3. 多工作区:启动时并集怎么裁

U2(`#1317`)裁了「取并集、封顶、按最近使用序」,K 与排序留给了本票。定成(`selectWorkspaceUnion`,
理由写在源码抬头):

1. `~/code-puppy` **恒在首位**(ADR-025 默认对话目录;renderer 重载后的启动草稿恒落在它上面)。
2. 其后:`tabs.recent.key` 指向的目录 → `tabs` 数组顺序(draft tab 的裸 `directory`)→ `tabs.info` 插入顺序
   (session tab)。`tabs.recent` 是 store 里唯一的「最近」信号,数组顺序是 tab 栏顺序;没有更细的 LRU,本票不造。
3. 只认 `server === "sidecar"` 的 tab(与 `catalog-liveness.ts` 同一判据)。
4. 只收**绝对路径且盘上存在的目录**;不代建(ADR-025)。
5. 排除 `/`、HOME、HOME 的任何祖先 —— 放行 HOME = 没有围栏。
5b. 排除与**应用状态根**(`<appData>/alpha-code-state`,三个 env 根与 CAS 的父目录;冻结环境快照的 `casBaseRoot`)
   **相关**的候选 —— 同一路径、在它之内、或包含它(`#1390`)。理由(当时):候选来自 `opencode.global.dat`,而它住在 W3 之下,
   **被围栏的引擎树自己写得了**;一条伪造的 draft 记录(`{type:"draft", server:"sidecar", directory:"~/Library/Application Support"}`)
   就能在下次启动把状态根的祖先放进可写集(票面实测:`selected` 含该目录、`excluded` 为空)。比较在 **`fs.realpathSync.native`
   之后**做:APFS 大小写不敏感,`~/LIBRARY/application support` 词法比不出来;软链同理。**必须是 `.native`** —— Electron 内嵌
   node(实测 v24.15.0 / electron 42.3.3)与 node 22 的 JS 版 `realpathSync` 只解软链、不归一大小写,bun 的两种都归一,
   所以这条差别在 bun 里测不出来。realpath 拿不到(ENOENT 等)退回词法比较,不因此放行;排除进 `excluded` 带理由,
   并出现在 `process fence planned:` 那行日志。这是第一步;第二步(5c)把清单本身搬出了围栏可写处之后,本条**留作第二道闸**:
   候选不管从哪来,状态根都进不来(`process-fence-plan.test.ts` 那条 `#1390` 用例改成「真源里的记录指向状态根祖先仍排除」)。
5c. **清单从哪来**(`#1394`,`#1390` 第二步,2026-09-22):不再是 store。真源是 `<appData>/alpha-code-state/fence-workspaces/<env>.json`
   (`process-fence-workspaces.ts`)—— 与三个 env 根、`cas/` 同级,W2 只放行 `env/<env>`、W3 是另一棵树,其余 17 行都不覆盖它
   (`#1383` 基线 §1.1/§1.2 逐行核过;`cas/` 已是「main 写、引擎只读」的先例)。形状 `{ "v": 1, "workspaces": ["<绝对路径>", …] }`,
   顺序与此前从 store 派生时相同(recent → tab 栏 → info);原子写;**严格读**(版本 / 数组 / 每项绝对路径,不对就整份拒)。
   谁写:①首次启动(文件不存在)从 store 播种一次,日志 `process fence: workspace truth seeded from the renderer tab store … N workspace(s)`
   —— 那一刻的可写集与 `#1390` 之后逐字等价;②之后只经 renderer → `store-set` / `store-delete` / `store-clear` IPC → main(`ipc.ts` 写完
   store 后通知 tracker),围栏内的进程到不了 IPC。**检疫**:renderer 启动时从 store 恢复 tab,伪造的那条也会被恢复成一个 tab,
   用户随后开/关任何 tab 都会把整个 `tabs` 数组写回 —— 所以 boot 时把「store 里有、真源里没有」的目录记成本会话的检疫名单,
   它们永远不进真源(日志点名)。真源缺失 / 坏 ⇒ planner 退到只有 `~/code-puppy`,日志
   `process fence: workspace truth unavailable — … : <文件>: <原因>`;坏文件不改写、不重播,renderer 下一次 tab 变更按当时状态重写它。
   store 那份(`opencode.global.dat`)保留给界面状态与 catalog 看门狗的探针目录,**不再喂给围栏**。
6. 去重后取前 **K = 32**(本机真实读数 99 个 tab 收敛成 5 个目录,6 倍余量)。K 不是字节上限,只让试编译循环有界。
7. **字节上限用真编译器判**(`trimUntilCompiles`):`sandbox-exec -f <profile> /usr/bin/true` 失败 ⇒ 从尾部
   (最不常用)丢一个再试;丢到只剩 `~/code-puppy` 仍失败 ⇒ **抛**(这时原因不是并集大小,放行是「前提为假的闸门」)。
   已知的坏先自证:400 条互不相同的 220 字符路径 119 ms 撞墙 `data object length … exceeds maximum (65535)`;
   而 1200 条**只差尾号**的 200 字符路径**编得过**(编码里有共享前缀 —— 单位没有精确刻画,所以不许靠算)。

## 4. 装不上会怎样(AC4)

| 失败 | 在哪一层被拒 | 用户看到 |
| --- | --- | --- |
| 试编译最小集仍失败 / 原生模块文件不在 / 默认工作区不在盘上 | main,fork 之前 | 引擎这一代启动失败,main 日志 `process fence plan FAILED — refusing to fork the sidecar … <原因>` |
| `start` 命令没带 `fence`(darwin) | sidecar `installProcessFence` | 同上,原因 `process fence missing from the start command on darwin` |
| `dlopen` 失败(签名 / 架构片 / 文件) | sidecar `loadFenceAddon` | 同上,原因带 dyld 原文 |
| `sandbox_init` rc ≠ 0 | sidecar `applyProcessFence` | 同上,原因带 libsandbox 原文(如 `syntax error: expecting ')'`) |
| rc = 0 但集合外仍写得进 | sidecar 探针 | 同上,`the fence is void, refusing to start the engine` |
| rc = 0 但 cwd 写不进 | sidecar 探针 | 同上,`engine cwd is not writable` |

**没有任何一条路会「引擎起来了但没有围栏」**。判据:`process-fence-apply.test.ts` C1–C5(真 .node / 真 seatbelt /
Electron 内嵌 node)、`process-fence-plan.test.ts` 三种 fail-closed、`process-fence-wiring.test.ts`(计划器抛出 ⇒
fork 一次都不发生)。

## 5. x64 那一格怎么不靠人记得

U1 只出了 arm64,并明写将来出 Intel / universal 时若漏第二份,x64 包里围栏**静默不装**。本票的做法:
`build-fence-addon.ts` 一次编出 **fat** 文件(`clang -arch arm64 -arch x86_64`),编完**逐片判**:
`lipo -archs` 缺任一片、或某一片 `nm` 里没有 `_napi_register_module_v1` ⇒ 删产物、非零退出 ⇒ prebuild 红。
`process-fence-apply.test.ts` A1/A2 用一个只编 arm64 的 thin 文件与一个 fat 空壳证明这条判据会红。
出 x64 / universal 包时**不需要多做任何事**。未验证:x86_64 那一片没有被执行过(本机 node / Electron 都是 arm64;
判据止于「片在且导出 N-API 入口」)。

## 6. 判据地图

| 文件 | 跑在哪 | 守什么 |
| --- | --- | --- |
| `process-fence-profile.test.ts` | 全平台 | §8.2 形状逐行全等;XDG 对着真 xdg-basedir;并集规则(吃 candidates 列表,`#1394`);试编译丢尾 |
| `process-fence-compile.test.ts` | darwin | 真 sandbox-exec:已知的坏(65535 墙 / 语法错)必红,§8.2 + 32 工作区必绿 |
| `process-fence-plan.test.ts` | darwin | 父目录预建、真源拿不到出声并退到默认工作区(`#1394`)、三种 fail-closed、两种 addonPath、真源里指向状态根祖先仍排除 |
| `process-fence-workspaces.test.ts` | 全平台 | `#1394` 真源:位置不在 W2 之下;原子写 / 严格读(七种坏形状);播种(AC4④)、装载 + 检疫、检疫挡得住 renderer 写回、只认三个 tab 键、坏文件不动、写失败不抛 |
| `process-fence-apply.test.ts` | darwin | x64 两片判据;四类原语正反臂(Electron 的 node);AC4 五种失败 |
| `process-fence-wiring.test.ts` | 全平台 | 计划 → start 命令 → 拒 fork;sidecar.ts 接线锚;`#1394` 端到端(darwin):伪造记录真写进 `opencode.global.dat` ⇒ **生产计划器**的 profile 不含它(AC4①③),写进真源 ⇒ 含它(AC4②),真源坏 ⇒ 只剩默认工作区;planner / ipc.ts / index.ts 接线锚 |
| `process-fence-write-sites.test.ts` | 全平台 | AC3 登记簿 == 扫描;四条控制臂 |
| `custom-provider-truth.test.ts` | 全平台 | `#1391` 自定义节点真源(读端):I2 —— 真源路径不在可写集任何固定行之下(对着渲染出的 profile 逐条规则枚举 W-id,17 个固定 id 手写登记;默认 / 覆盖 base × 两种 XDG_STATE_HOME;控制臂塞一行罩住状态根即点名);严格读十六种坏形状各拒且日志一行,缺失 = 没有记录 |
| `custom-provider-truth-write.test.ts` | 全平台 | `#1391` 写端:字节固定、原子(rename / write 中途抛 ⇒ 旧内容不动)、坏记录不落盘;写模块不在 sidecar import 闭包里(生产 `sidecarSourceFiles` 实测 + 合成三文件控制臂) |
| `custom-provider-truth-fence.test.ts` | darwin | `#1391` I2 的真裁判:生产 profile 交给真 sandbox-exec,围栏内写 / 建目录 / mv 进真源全拦、零落盘;W2 / W3 落盘;bare 臂写得进 |
| `process-fence-engine.test.ts` | darwin | **真引擎 + 真 ext** 在生产 .node 围栏下:shell 工具 / PTY / MCP 三条真消费方界外 0 落盘、界内落盘;AC2 shell 工具照常执行、`cfg.shell` 不指向 wrapper |
| `packages/ext/src/alpha-ext-no-shell-layer.test.ts` | 全平台 | REQ-138 层已拆:生产 config 钩子不碰 `cfg.shell` |

全部登记在 `scripts/gate-files.tsv`(darwin-only 的按 `[平台:darwin]` 登记)。

## 7. 没做的(如实)

- **出货形态(node sidecar + 打包产物 + 围栏)已于 2026-09-10 合成一次跑通**(U3,`#1323`):本机发版命令打出的签名包上,
  六格正反两臂各 32/32,sidecar 自报 `process fence applied: addon=fence-… profile=2068B`,集合外 0 落盘。本票自己在 Electron 内嵌 node 里
  验的 dlopen + apply + 四类原语、在 bun 上验的真引擎 + 真 ext,都不是出货的那份字节;出货那份的读数在
  [`../verification/2026-09-10-req159-1323-packaged-fence/README.md`](../verification/2026-09-10-req159-1323-packaged-fence/README.md)。
  那里还记着一条给下一个打包验证的人的坑:**给 app 设 `HOME` 隔离不了它** —— Electron 的 appData 不看 `$HOME`,而 `preferAppEnv`
  会用登录 shell env 缓存把 `HOME` 改回去。
- **围栏下没有发过一次真的模型请求**(与四轮勘破同一条)。
- **网络轴已落地(REQ-137,`#1336` / `#1337`)**:本围栏的网络面不再是 `(allow default)` —— profile 尾部多了
  `#1334` Q1.2 那四行(`(deny network*)` + loopback bind / inbound + 只放行 main 进程内策略代理的端口),
  sidecar 的代理 env 由 main 整份改写指向它。形状、判据与覆盖面声明在
  [`2026-09-10-network-egress-on-process-fence.md`](2026-09-10-network-egress-on-process-fence.md) §落地。
  那轮勘破的关键一条仍值得记着:2026-08-25 勘破 §5 写下的形状照抄过来会让**引擎起不来**
  (sidecar 是 HTTP 服务器,`(deny network*)` 连 `listen()` 一起拦),而围栏自己会照常报
  `process fence applied` —— 所以 N3(inbound)那一行由 `process-fence-profile.test.ts` 逐字守着。
- **x86_64 片没有被执行过**(§5)。
- **公证 / staple 没做**(U1 §4 同一条;发版 runbook §1 ③ 已要求核对)。
- **`~/.bash_history`** 不在可写集(§2);终端配置降级的披露面已落地(§8,`#1322`),但它只是**告知**,
  不是修复:登录 shell 的写入面仍然结构上枚举不了(基线 I3)。
- 用户打开集合外的新文件夹:打得开、读得了、一写就 `operation not permitted`,**下次启动即在集合里**(U2 §2.4;`#1394` 起
  「在集合里」= 在 main 独占的真源里,由界面开/关项目经 IPC 写入);工作区层面的只读告知已落地(§8,`#1322`)。
- **`#1394` 之后仍然开着的(如实)**:①首次播种信任当时 store 里已有的内容 —— 升级前已被塞进去的伪造条会一起搬过去
  (与 `#1390` 之后的可写集等价,没有更坏);②围栏内的代码仍能往 `opencode.global.dat` 塞条目,renderer 会把它恢复成一个用户没开过的
  tab —— 它写不进去、也进不了真源(检疫),但这条通路本身没堵,界面上也没有标它可疑;③被检疫的目录若恰是用户后来真想打开的,
  要先关掉那个 tab、重启、再打开;④catalog 看门狗的探针目录(`catalog-liveness.ts`)仍从 store 解析 —— 它只决定探哪个目录的
  catalog,不决定可写集;⑤真源文件坏掉(不是攻击可达的状态)时这一代只剩 `~/code-puppy`,直到 renderer 下一次 tab 变更把它重写好。
  端到端判据(`process-fence-wiring.test.ts`)在 bun 里对着生产计划器跑,fork 是假子进程;**没有**在真 Electron 主进程里冷启动一次
  取证 —— 「index.ts 在预清之后、注册 IPC 之前播种」与「ipc.ts 三个通道写完都通知 tracker」两跳是源码锚,不是行为判据。
- **`#1391` 自定义节点的真源只有存储层**(§2 那张表的第三行):`custom-providers/<env>.json` 可读可写、判据齐,但**零消费者** ——
  注入面(`buildAlphaModelConfig`)、`enabled_providers`(`readUserProviderIds`)与出网派生今天仍看 `alpha.jsonc` 等三份配置文件
  (`#1392`);添加时的地址准入与出网同源、旧 `alpha.jsonc` 记录的处置(`#1393`)。用户可观察行为在 `#1391` 合入后零变化:
  「自己填服务地址加节点」那半入口仍是 `#1397` 关掉的状态。
- 非 darwin:不装围栏,sidecar 打一行 warn(基线「如实声明」);§8 的两处告知随之**不出现**(没有围栏就不说有)。

## 8. 披露面:两句实话怎么到用户眼前(`#1322`)

owner 2026-09-09 裁决(`#1286`):终端配置降级与集合外工作区都**不放宽、不改行为,改为如实告知**。
设计稿 `docs/design/2026-09-10-req159-sandbox-disclosure/design.md`(§3 是 AC 字面量锚点;随 PR #1329 并入活稿,
本文刻意不用相对链接 —— 两条线并行合入时链接目标可能还不在树上);本节只写落地形状。

### 8.1 「沙箱开启」—— 信号从哪来

| 环节 | 文件 | 事实 |
| --- | --- | --- |
| main | `server.ts` `spawnLocalServer` 返回值 | `fence: "applied"` **只在两个事实同时成立时**出现:本进程把计划放进了 start 命令(darwin 上没有计划走不到这里),且 sidecar 发了 `ready` —— 而 sidecar.ts 的 `start()` 第一句就是 `installProcessFence`,apply 失败 ⇒ error IPC + exit(1),永远发不出 ready(接线锚 `process-fence-wiring.test.ts`) |
| main | `sidecar-generation.ts` / `sidecar-lifecycle.ts` | 终态生产者把它挂到**引擎在线**的终态上(`ready` / `injection-failed`);`failed` 不带 —— 没有引擎就没有围栏可言。经既有的 `sidecar-generation` IPC 到 renderer |
| renderer | `alpha-ui/sandbox-state.ts` | 订阅既有的 runtime-recovery 通道,投影成 `sandboxApplied()`:在线 **且** `fence === "applied"`。缺席 / 不在线 / 字段不在 ⇒ false |
| renderer | `session-workspace-shell.tsx` → `terminal-rail-panel.tsx` | 经 props 递进终端面板(面板的 I1 棘轮禁 window.api);脚条第三项(env 之后、size 之前,窄于 360px 只留「沙箱开启」)+ 空态一行 + 悬停层。钩子 `data-alpha-terminal-foot-sandbox` / `data-alpha-terminal-empty-sandbox` |

非 darwin:计划为 `undefined` ⇒ 返回值不带 `fence` ⇒ 一路缺席 ⇒ 不出现。

### 8.2 「只读」—— 探针在哪跑

字符串比较四种形状必错(U2:`ws1extra` / 软链出集合 / 软链进集合 / APFS 大小写),所以判据只能是**由被围栏的进程真写一次再删**:

| 环节 | 文件 | 事实 |
| --- | --- | --- |
| 合同 | `workspace-write-probe.ts` | main → sidecar `{type:"write-probe", id, directory}`,sidecar → main `{type:"write-probe-result", id, outcome, detail?}`;形状不对就当没有。`outcome` 三种:`writable`(写-删成功)/ `denied`(**EPERM** —— seatbelt 的拒绝就是这个码,`process-fence-apply.test.ts` B2 实测)/ `unknown`(其它一切:ENOENT、ENOTDIR、EACCES 是文件系统自己的权限位而不是围栏、超时、引擎不在) |
| sidecar | `sidecar.ts` 消息循环 | 收到命令即同步在目标目录写一个 `.alpha-write-probe-<戳>`(`wx`,永不覆盖用户文件)再删,回一条应答。写入点登记在 `scripts/process-fence-write-sites.tsv`(根 W1 = 它**该**落的根;落不进正是它要报告的) |
| main | `server.ts` `listener.probeWrite` → `ipc.ts` `workspace-write-probe` → preload `workspaceWriteProbe` | 请求簿按 id 对号;超时 5 s / 子进程退出 / 没有活着的 sidecar ⇒ `unknown` |
| renderer | `alpha-ui/workspace-writable.ts`(核 `workspace-writable-core.ts`) | 「这个目录成为当前工作区」的单一咽喉:两个宿主各挂一次 `useWorkspaceWritable(dir)` —— 会话页是 `live.current().identity.directory`(deep link / draft 晋升都落这里),新对话页与首页是 chip 的 `activeWs`(chip 选目录 / 侧栏 draft 目标解析都落这里)。只在 `sandboxApplied()` 时才探;答案按「引擎代 + 目录」缓存(respawn 换代重问);四态里只有 `denied` 标记 |
| renderer | `session-workspace-shell.tsx`(顶栏胶囊 + 弹层,动作 = 既有 `window.api.relaunch`)/ `workspace-chip.tsx`(尾标) | 钩子 `data-alpha-workspace-readonly` / `data-alpha-workspace-chip-readonly` |

**为什么不在 main 里探**:main 没有被围栏,`fs.writeFile` 在那里恒答可写。`workspace-write-probe-fence.test.ts` 的 bare 臂
就是这个形态的实测(集合外也答 writable),AC3 的判据(`workspace-write-probe-judge.ts`)把它当假探针拒掉;
同一个判据也拒掉恒答「不可写」的替身(它会把每个项目都标成只读)。

### 8.3 判据地图(补 §6)

| 文件 | 跑在哪 | 守什么 |
| --- | --- | --- |
| `workspace-write-probe.test.ts` | 全平台 | 合同形状 fail-closed;errno 分类;真文件系统写-删不留残;请求簿三种 unknown;AC3 判据自证(两个替身各被拒在一边) |
| `workspace-write-probe-fence.test.ts` | darwin | 真 .node / 真 seatbelt / 真子进程:围栏臂集合内 writable、集合外 denied(EPERM);bare 臂(= main)集合外 writable ⇒ 拒 |
| `process-fence-wiring.test.ts` | 全平台 | `spawnLocalServer` 返回 `fence:"applied"`;`listener.probeWrite` 走线上命令、按 id 对号、停后答 unknown |
| `sidecar-generation.test.ts` / `sidecar-lifecycle.test.ts` | 全平台 | 围栏字段只随在线终态上车,failed 不带 |
| `test-component/terminal-rail.cases.ts`(宿主 `terminal-rail.test.ts`) | 全平台 | AC1:脚条第三项位置、空态一行、悬停层;反向臂 = 信号关 / prop 缺席 ⇒ 两个钩子都不在 |
| `test-component/session-workspace.cases.ts`(宿主 `alpha-session-workspace.test.ts`) | 全平台 | AC2 顶栏两臂:集合内无胶囊;集合外胶囊紧跟状态胶囊、role=status、悬停/点击开弹层、重启动作、Esc 关 |
| `test-component/new-session-workspace.cases.ts`(宿主 `new-session-workspace.component.test.ts`) | 全平台 | AC2 chip 两臂 + 四态:denied 才有尾标;unknown / 出错 / 桥缺席 无标记;沙箱没装一次都不探 |
| `workspace-writable-core.test.ts` / `sandbox-state.test.ts` | 全平台 | 状态机四态、分代缓存、同代只探一次;沙箱投影只认在线 + fence 字段 |
