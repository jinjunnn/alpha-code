---
title: REQ-159 U2 裁决:一个被围栏的引擎怎么服务多个工作区
kind: architecture
status: active
owners:
  - alpha-code desktop maintainers
last_reviewed: 2026-09-09
review_after: 2026-12-09
---

# U2 裁决 —— 取启动时并集;respawn 不做「打开新目录」的触发器

对照物是勘破 [`2026-09-08-derived-process-spawn-paths.md`](2026-09-08-derived-process-spawn-paths.md)
(§6.7 提出这一问、§8.7「地基三」给出形状)与方案基线
[`../design/2026-09-09-req159-process-fence-baseline.md`](../design/2026-09-09-req159-process-fence-baseline.md) §四 U2。
本文只做**这一问**的定价与裁决,不重述勘破,也**不实现围栏、不改 respawn 机制**。

一句话:**取并集。** 它在真引擎上五个工作区一次跑通、代价接近零;而 respawn 那条路
每触发一次要花掉用户 **10 秒**、把他**踢回默认工作区**、**杀光所有终端**、并留下一条
**永远显示"运行中"的会话**和一个**没人管的孤儿进程** —— 而这条路的触发器恰恰是"用户想去新文件夹",
即"你去新文件夹"这个动作本身会把你弹回 `~/Alpha`。

## 0. 测量口径

| | |
| --- | --- |
| 宿主 | macOS **26.3.1**(build 25D2128),Darwin 25.3.0 arm64,xnu-12377.91.3 |
| 仓 | `alpha-code@8a8e1e56d`(= 当时的 `origin/alpha`),worktree `.worktrees/ac-1317`,由 `bash scripts/worktree-bootstrap.sh ac-1317 -b recon/1317-multi-workspace --base origin/alpha` 建(`4729 packages installed [9.51s]`) |
| 被测引擎(§2、§3.2) | `bun run packages/opencode/src/index.ts serve`(**dev 树、bun 运行时**,未装 `@alpha-code/ext`)—— 与 §3.1 的出货实机不是同一形态,见 §6 |
| 出货实机(§3.1) | `/Applications/Code Puppy.app`;结构性 respawn 那一份样本来自 `version: '0.1.9', packaged: true` 的真实运行日志;并存的 0.1.11 日志用于对照 |
| 判据 | **探针文件到底落没落盘**(`ls` / `wc -l` 实读)、**进程还在不在**(`pgrep` 实读)。HTTP 码、exit code、stderr 只作旁证 |
| 对照臂 | 每条"没落盘"都配一条**同一探针、同一路径、只去掉围栏**的正样本臂;每个 `pgrep` 判据先用一个**已知在跑**的同形进程自证抓得到 |
| 隔离 | 落在 `/Users/tide/alpha1317u/`(**不在** `/private/tmp` 下 —— 那是可写集里的 W11,布局会污染判据) |
| 日期 | 2026-09-09 |

取证脚本一次性,不入仓;下面贴的是原始输出。

## 1. 五问,各一句

1. **一个被围栏的引擎能不能同时服务 5 个工作区?** 能。经真 session → 真 bash 工具,5/5 写进去,
   第 6 个(不在集合里)写不进去且不落盘(§2.1)。
2. **并集会不会撑爆?** 现实区间(N≤100)代价 **34 ms**,与 N=1 无差;但有一道**硬天花板**
   `data object length … exceeds maximum (65535)`,越过即**编译失败、零执行**(§2.2)⇒ 并集必须封顶。
3. **集合从哪来?** `opencode.global.dat` 的 `tabs` / `tabs.info` —— **main 今天就在读它**
   (`catalog-liveness.ts:246-274`,零新增 IPC)。本机真实读数:99 个 tab、**5 个不同目录**(§2.3)。
4. **respawn 一次多贵?** 出货包实测 **10.087 s**,期间 renderer 整个重载、用户被丢到
   **默认工作区的新草稿**、模型表空 **7.0 s**;正在跑的活:**终端全死**、**工具子进程变孤儿继续跑**、
   会话里那条工具**永远停在 `running`**(§3)。
5. **"写不进去的文件夹"今天有多不可见?** 引擎日志里**一个字都没有** —— 被拒的 ws6 与放行的 ws5
   在日志里**逐行同形**(各 4 条 INFO),差别只在工具输出(§5.1)。

## 2. 路一(启动时取并集)的定价

### 2.1 一个围栏、五个工作区、真引擎、真工具 —— 三条臂

同一个驱动、同一份工作负载(每个工作区各一次 `GET /project/current` + `POST /session` +
`POST /session/:id/shell` 写一个探针文件),三条臂只差**围栏里放行了哪几条**:

```
# nofence 正样本臂:不套围栏
bash m5-union-engine.sh nofence 4721
# union 臂:围栏放行 ws1..ws5(工作区之并),ws6 不在集合里
bash m5-union-engine.sh union   4722
# single 臂:围栏只放行 ws1(= 用户打开了新目录而引擎没换代)
bash m5-union-engine.sh single  4723
```

`nofence`(正样本臂,证明探针测得出"好"):

```
  boot -> 200 (2s)
  ws1  /project/current=200  session=200   probe_landed=YES
  ws2  /project/current=200  session=200   probe_landed=YES
  ws3  /project/current=200  session=200   probe_landed=YES
  ws4  /project/current=200  session=200   probe_landed=YES
  ws5  /project/current=200  session=200   probe_landed=YES
  ws6  /project/current=200  session=200   probe_landed=YES
```

`union`(15 条规则 / 898 B):

```
  boot -> 200 (2s)
  ws1  /project/current=200  session=200   probe_landed=YES
  ws2  /project/current=200  session=200   probe_landed=YES
  ws3  /project/current=200  session=200   probe_landed=YES
  ws4  /project/current=200  session=200   probe_landed=YES
  ws5  /project/current=200  session=200   probe_landed=YES
  ws6  /project/current=200  session=200   probe_landed=no
       tool_out=(eval):1: operation not permitted: …/ws6/probe-ws6.txt
```

`single`(11 条规则 / 677 B):

```
  ws1  probe_landed=YES
  ws2..ws6  probe_landed=no
       tool_out=(eval):1: operation not permitted: …/wsN/probe-wsN.txt
```

⇒ **并集在真引擎上成立到 5 个工作区**,越界仍 0 落盘;`single` 臂把 §8.7 的 M2 形状从 2 个放大到 6 个,
形状不变:**项目打得开(`/project/current` 200)、会话建得出(200)、一写就 `operation not permitted`**。

### 2.2 规模:现实区间免费,但有一道会让引擎起不来的硬天花板

只放大 `(subpath …)` 条数(每条一个工作区),判据仍是探针落不落盘:

| N | 探针落盘 | profile 字节 | 一次 `sandbox-exec` 墙钟 |
| --- | --- | --- | --- |
| 1 | YES | 200 | 0.025 s |
| 20 | YES | — | 0.034 s |
| 100 | YES | — | 0.034 s |
| 200 | YES(200/200)| 12 631 | 0.053 s |
| 1 000 | YES(1000/1000)| 63 032 | 0.349 s |
| 3 000 | YES | — | 2.285 s |
| 6 000 | YES | — | 8.802 s |
| **7 000** | **no** | — | 11.963 s ← `sandbox-exec: data object length 70173 exceeds maximum (65535)` |
| 8 000 | no | — | `data object length 80191 exceeds maximum (65535)` |
| 9 000+ | no | — | `sandbox-exec: profile compilation failed` |

天花板的单位**不是条数,是编译后数据对象的字节**:把每条路径拉长到 220 字符,同一道墙在
**340 → 400 条**之间就撞上(`data object length 76413 exceeds maximum (65535)`)。

两条随之而来的纪律:

- **并集必须封顶**,且封的是**估算字节**而不是条数。撞墙的后果不是"少放行一个目录",是
  `sandbox_init` 失败 ⇒ 按 fail-closed 就是**引擎起不来** —— 与基线 I1 同族的"前提为假的闸门比没有闸门更贵"。
- 现实区间(本机 N=5,即使 N=100)编译代价 **34 ms**,与 N=1 量不出差别 ⇒
  §7.6 那句"多一个工作区只多一条规则,不会组合爆炸"得到确认,**在有封顶的前提下**。

### 2.3 集合从哪来:main 今天就读得到的那一份

**不需要新 IPC,也不必去读引擎的 SQLite。** `catalog-liveness.ts` 的 `resolveCatalogProbeDirectory`
(`packages/ui-mac/src/main/catalog-liveness.ts:246-274`)已经在做同一件事的单数版:main 从**自己的**
electron store `opencode.global.dat` 里读 renderer 持久化的 tab 状态 —— `tabs`(draft tab 带裸
`directory`)、`tabs.info[key].directory`(session tab),并只认 `server === "sidecar"` 的本地引擎 tab。
它的抬头写明"main 侧今天就拿得到、零新增 IPC",并已对两份真实生产 store 实读验证过全部三种形状。

把它从"取首屏那一个"改成"取全部",就是这一代要服务的工作区集合。**本机真实读数**(出货 0.1.11
正在运行的那份 store,`opencode.global.dat`,34 282 B):

```
tabs count: 99      tabs.info count: 12
--- 并集候选(tabs + tabs.info 的 directory)---
   /Users/tide/Alpha
   /Users/tide/Documents/workspace
   /Users/tide/app/alpha-code
   /Users/tide/code-puppy
   /private/var/folders/9m/…/T/req105-ac4-ws-z8Agfn
N = 5
```

99 个 tab 收敛成 **5 个目录** —— 这就是并集的现实量级。旁证:引擎自己的库
(`~/.local/share/opencode/opencode-alpha.db`)里 `project` 3 行、`project_directory` 5 行,同一量级。

三条要在实现票里守住的:

- **`~/Alpha` 恒在集合里**。它是 ADR-025 的默认对话目录,而 renderer 重载后的启动草稿
  **恒落在它上面**(`alpha-sidebar.tsx:686-692` `resolveDraftTarget`,实测见 §3.1)—— 它不在集合里
  就等于"每次重启后落地即不可写"。
- **集合是单调收集、按上限裁剪**,不是"上次会话的那一个"。上面第 5 条是一个 `$TMPDIR` 下的旧测试目录:
  集合会**带着历史垃圾单调增长**,所以裁剪规则(按 `tabs` 的最近使用序取前 K)必须和封顶一起定。
  好消息是**不存在的路径不会让 profile 编译失败**(§2.2 的 pad 臂全是不存在的路径,照样编译通过)。
- **引擎库里的 `project_directory` 有 `git_worktree` 类型的行**(本机 3 行,都在
  `/Users/tide/app/alpha-code` 之下)。它们今天被父目录那条 `(subpath)` 顺带罩住,但 git worktree
  **可以落在任何地方** —— 若日后把引擎的项目库也当集合来源,这是要单独定价的一格。

### 2.4 用户打开一个不在集合里的新文件夹时会怎样

就是 §2.1 `single` 臂那六行:**打得开、看得见、读得了,一写就 `operation not permitted`,文件不落盘。**
这一格不靠"放宽"解决(基线 I1:装上就不能加宽),只靠 §5 的可观察面 + "下次启动它就在集合里了"。

## 3. 路二(打开新目录就 respawn)的定价

### 3.1 出货包上真实发生过的一次结构性 respawn:10.087 秒,并且把用户丢回默认工作区

日志:`~/Library/Application Support/ai.opencode.desktop/logs/20260903T034019/startup-timeline.log`
(`app starting { version: '0.1.9', packaged: true }`;起因是 token 续期拿到 `invalid-grant` → 登出 →
`alpha-auth.ts:513` 的 `respawnSidecar("structural")`)。逐格:

| 时刻 | 标记 | 距起点 |
| --- | --- | --- |
| 03:02:35.671 | `sidecar.generation.emit phase=recovering reason=structural` | 0 |
| 03:02:36.726 | `sidecar.respawn.fork.start` | +1.055 s(杀旧 sidecar + 悬空 sweep + allowlist 同步) |
| 03:02:37.524 | `sidecar.respawn.fork.end durationMs=802.3 outcome=ok` | +1.853 s |
| 03:02:37.563 | **`main.renderer.reload count=1 trigger=sidecar-respawn`** | +1.892 s |
| 03:02:38.210 | `renderer.root.mount occurrence=2` | +2.539 s |
| 03:02:38.446 | `launch_draft.step resolve_target outcome=**default-workspace**` | +2.775 s |
| 03:02:38.497 | `launch_draft.end outcome=navigated` | +2.826 s |
| 03:02:45.701 | `home.catalog_ready barrierMs=**7019.3** probeTimeouts=3` | +10.030 s |
| 03:02:45.758 | `home.model_list.end count=32 durationMs=7076.5` | **+10.087 s** |

三件用户直接看得见的事:

1. **整个界面重载。** `shouldReloadRenderer(reason)` 对 `structural` 恒为真
   (`sidecar-lifecycle.ts:5-7`),`index.ts:1479` 执行 `mainWindow.webContents.reload()`。
2. **落地点不是你刚才那一页,是默认工作区的一条新草稿。** 重载后启动路径重跑
   `startDraft("launch")`,而 `resolveDraftTarget` 在本地 sidecar 上**一律先取默认对话目录**
   (`alpha-sidebar.tsx:686-692`,ADR-025 2026-07-28 修订:"未显式选择目录时一律落默认对话目录,
   不再『上次使用优先』")。实测那一格正是 `outcome=default-workspace`。
   **⇒ 如果 respawn 的触发器是"用户打开了新文件夹",那么这个动作会把用户从新文件夹弹回 `~/Alpha`。**
   这不是可以调参的性能问题,是触发器与落地逻辑**方向相反**。
3. **模型表空 7.0 秒。** 这不是孤例:同一台机上 `home.catalog_ready` 的首次样本共 5 条
   —— 409.9 / 1 806.6 / 3 008.8 / 7 019.3 / 8 798.4 ms。重载后的等待与冷启动同分布。

fork 那一半有 **46 条样本**(45 条 token-only + 上面这 1 条 structural):min 734 / p50 806 / max 1 008 ms。
**带 renderer 重载的那一半只有 n=1**,见 §6。

### 3.2 正在跑的活会怎样:终端全死,工具子进程变孤儿,会话永远"运行中"

同一条引擎上同时起两样东西,然后杀掉引擎(生产等价物:`sidecar.ts:149-153` 先
`stopSidecarListener` 再 `process.exit(0)`,对子进程同样不做任何回收;主进程侧的兜底是
`SIDECAR_STOP_TIMEOUT=6_000` 之后的 SIGTERM):

```
探针自证:pgrep -f ALPHA1317BEAT-selftest -> [13519]      ← 先证明 pgrep 抓得到已知在跑的同形进程
正样本臂:pty_beat=48 tool_beat=47 pty_pid=[21445] tool_pid=[21449]
== SIGTERM 引擎 ==
  +5s:  pty_beat=48  tool_beat=69   pty_pid=[]  tool_pid=[21449]
  +15s: pty_beat=48  tool_beat=92   pty_pid=[]  tool_pid=[21449]
  +30s: pty_beat=48  tool_beat=114  pty_pid=[]  tool_pid=[21449]
== 代 2(引擎回来)==
  read#1: tool=bash status=running
  read#2: tool=bash status=running      ← 10s 后再读,还是 running
  最终 tool_beat=211 tool_pid=[21449]   ← 孤儿仍在写盘
```

三条结论,各自都是用户可观察的损失:

- **PTY 子进程随引擎一起死**(心跳冻结在 48,pid 消失)⇒ 一次换代**杀掉全部工作区的全部终端**,
  包括用户根本没碰的那个工作区。
- **工具(`bash`)子进程不死,变孤儿继续跑**(引擎死后 30 s 仍在写盘,新一代起来后还在)⇒
  一次换代留下一个**没人管、还在改用户文件**的进程。
- **会话里那条工具永远停在 `running`。** 库里没有任何开机对账把它改掉;唯一会把它翻译成
  `[Tool execution was interrupted]` 的地方是**下一次送模型时**的提示词转换
  (`packages/opencode/src/session/message-v2.ts:351`)。在那之前,界面上就是一条永远转圈的任务。

### 3.3 触发条件怎么定才不抖 —— 这一格没有便宜的答案

今天 `SidecarRespawnReason` 只有两种(`sidecar-lifecycle.ts:3`),现有触发点是登录/登出、
BYOK 改键、provider 变更、崩溃自愈、catalog 看门狗。把"打开新目录"加进去意味着:

- 用户在两个项目之间来回切 ⇒ 两次换代 ⇒ 两次 10 秒 + 两次终端全灭;
- 要不抖就得加"合并窗口 / 只增不减 / 已在集合里就不换代"这类规则 —— 而"已在集合里就不换代"
  恰恰就是**路一**;换句话说,任何不抖的 respawn 方案都要先实现一个并集,respawn 只是它的
  兜底分支。

## 4. 裁决

**取启动时并集。** 具体形状(实现票据此切):

1. 集合 = `opencode.global.dat` 的 `tabs` + `tabs.info` 里 `server === "sidecar"` 的全部绝对
   `directory`,**并入 `~/Alpha`**(默认对话目录),按 `tabs` 最近使用序去重取前 K,**并对
   估算字节封顶**(§2.2)。来源与解析复用 `catalog-liveness.ts:246-274` 那份,不另写一份。
2. **不把"打开新目录"接成 respawn 触发器。** 理由是 §3.1 第 2 条:那个动作会把用户弹回 `~/Alpha`,
   与它自己的目的相反;§3.2 的三条损失是附加代价,不是主要理由。
3. 用户打开集合外的新文件夹 ⇒ **不换代、不阻止、如实告知**(§5),并把该目录写进集合,
   **下次启动即生效**。是否给一个"立即重启以启用写入"的显式按钮,留给披露面那张票
   (基线 §五 子票 4)一起裁 —— 那时 respawn 是**用户主动按下**的,§3.1 的落地点问题变成
   可接受的已知代价,而不是系统替他做的决定。

被否决:

| 替代 | 否决依据 |
| --- | --- |
| 打开新目录即 respawn | §3.1:触发器与落地逻辑方向相反(用户被弹回 `~/Alpha`);§3.2:终端全灭 + 孤儿进程 + 永久 `running` |
| 不做并集,只放行当前工作区 | §2.1 `single` 臂:第 2..6 个工作区全部"打得开、一写就失败" |
| 把 `$HOME` 或用户全部代码根目录整个放行 | 与基线 I1/围栏目的直接冲突,不定价 |
| 并集不封顶 | §2.2:撞到 65 535 那道墙 ⇒ profile 编译失败 ⇒ fail-closed 下引擎起不来 |

## 5. 「用户打开了一个写不进去的文件夹」怎么变得可见

### 5.1 今天它有多不可见(带正样本臂)

`union` 臂那一跑里,被拒的 ws6 与被放行的 ws5 在**引擎自己的日志**
(`$XDG_DATA_HOME/opencode/log/opencode.log`,共 56 行)里**逐行同形**:

```
$ grep -in "ws6|not permitted|EPERM|denied" opencode.log
50: message="creating instance" directory=…/ws6
51: message=fromDirectory directory=…/ws6
52: message=bootstrapping directory=…/ws6
56: message=created id=ses_… directory=…/ws6 …
$ grep -c "ws5" opencode.log        # 反向对照:放行的那个
4
```

**`not permitted` / `EPERM` / `denied` 命中 0 条。** 被拒和被放行在日志里长得一模一样 ——
这正是基线 I3 与 §8.2 里 `<HOME>/.npm` 那条"health 仍 200 而 provider 一个都装不上"的同族:
**最难诊断的一档**。

### 5.2 不要手写 seatbelt 的替身:`(subpath …)` 的真实文法(实测)

最省事的写法是"main 知道自己放行了哪些前缀,拿字符串比一下"。**实测三处它会说谎**
(profile 放行 `$R/ws1`、`$R/ws2`、`$R/ws3/`;判据仍是探针落不落盘):

| 形状 | 实测 | 字符串判据会说什么 |
| --- | --- | --- |
| `$R/ws1` 本身 / `$R/ws1/sub` | **允许** | 一致 |
| `$R/outside` | **拒绝** | 一致 |
| `$R/ws1extra`(前缀相同但不是路径分段) | **拒绝** | `startsWith` 说"在里面" ⇒ **该报的警不报** |
| `$R/link-to-ws1` → `$R/ws1`(软链进集合) | **允许** | 说"不在里面" ⇒ **假警报** |
| `$R/ws1/link-out` → `$R/outside`(软链出集合) | **拒绝** | 说"在里面" ⇒ **该报的警不报** |
| `$R/WS2`,规则写的是 `ws2`(APFS 默认大小写不敏感) | **允许** | 大小写敏感的比较说"不在里面" ⇒ 假警报 |
| `$R/ws3`,规则写的是 `ws3/`(尾斜杠) | **允许** | 视写法而定 |

⇒ `(subpath X)` 是**按路径分段匹配、解析软链、随卷的大小写策略**的。手写一个 TypeScript 谓词去
复述它,就是 `#123` / `#36` 那个形态(**手写别人文法的替身**)再来一次。
**要么消费围栏自己的判决,要么别问。**

### 5.3 因此:靠一次真写,而不是靠一个判断

**判据 = 在目标工作区里真写一次再删掉,由被围栏的引擎执行。** 触发点是"这个目录成为当前工作区"
这一刻,而不是第一次工具写盘的时刻。出口只有三个,都已定位:

- `packages/ui-mac/src/renderer/alpha-ui/workspace-chip.tsx:103-110` —— 原生目录选择器选中后
  `props.onSelect(picked)`(首页 `AlphaHome.tsx:186`、新对话页 `alpha-new-session.tsx:153` 共用);
- `packages/app/src/pages/layout/deep-links.ts:79/83` —— `openProject(directory, …)`;
- 启动时的 `resolveDraftTarget`(`alpha-sidebar.tsx:681-693`)落定的那个目录。

呈现的最低要求(具体文案与视觉归披露面那张票,基线 §五 子票 4 / I4):

1. **在工作区层面而不是工具输出里**说出来 —— 用户看到的是"这个项目现在只读",不是某一次
   `operation not permitted`;
2. **说清为什么和怎么办**("这一代引擎启动时这个文件夹还不在名单里;重启应用后即可写入");
3. **有判据守着它**(I4:披露文案的存在与位置要有测试,否则下一次改 UI 会把它删掉而无人知道);
4. 同时写一条 main 侧日志(带目录与本代可写集摘要),让事后诊断不必依赖用户复述。

**注意一处不能省的正样本臂:** 这个探针必须先证明它在**可写**的工作区上返回"可写"
(§2.1 的 `union` 臂 ws1..ws5 就是这条臂),否则一个恒答"不可写"的探针会把每个项目都标成只读。

## 6. 本轮的未验证(如实记账)

- **§2 与 §3.2 跑的是 dev 树 + bun 运行时的引擎,没装 `@alpha-code/ext`。** 与 §8.3 的 F2 合成臂
  形态不同;基线 U3(node + 打包产物 + 围栏)仍未合成,本票不闭合它。
- **带 renderer 重载的 respawn 只有 n=1 个样本**(2026-09-03,packaged 0.1.9)。fork 那一半有 46 条,
  重载那一半没有。按"时序结论需 ≥3 轮采样"的纪律,§3.1 的 10.087 s 应读作**一个真实观测**,
  不是 P50。它不影响裁决(裁决的依据是 §3.1 第 2 条那个**方向性**问题,不是耗时)。
- **没有在出货包上主动触发过一次结构性 respawn。** §3.1 是对已发生事件的日志读数;主动触发需要
  登出或改 BYOK 键,会动 owner 正在用的那台机(实测期间 `Code Puppy` pid 19723 在运行),本轮不做。
- **§3.2 用 SIGTERM 代表换代。** 生产路径是 `stopSidecarListener` 后 `process.exit(0)`
  (`sidecar.ts:149-153`),对子进程同样零回收;两者**在子进程回收这一点上等价**是推断,不是实测。
- **围栏下没有发过一次真的模型请求**(与 §6.8 / §8.8 同一条:隔离家目录无凭据)。
  §2.1 的 shell 端点靠引擎默认 `modelID=big-pickle / providerID=opencode` 跑通,没有模型往返。
- **65 535 那道墙的单位没有精确刻画。** 已证它**不是**路径字节的简单求和(220 字符 × 340 条 =
  74 513 B 仍通过,而工具报的 `data object length` 是 76 413),编码里有去重/共享前缀。
  实现票要么保守封顶,要么**在装围栏前先试编译一次**并对失败 fail-closed 到"少放几个工作区"。
- **非 darwin 未测**(与前四轮同)。
- **并集裁剪规则(取前 K 的 K 是多少、按什么排序)本轮没有定**,只给出了它必须存在的理由(§2.2)
  与量级参考(本机 N=5)。

## 7. 与勘破 / 基线的关系

- 勘破 §6.7 提出的那一问("取并集还是打开新目录就 respawn")**由本文闭合**;§8.7「地基三」
  末句"『打开新目录 ⇒ respawn』本轮没有实现也没有实测"—— 本文没有实现它,但把它的**用户可见代价**
  测了(§3),据此否决。
- 基线 §四 U2 由本文闭合;基线 §五 的子票 3(围栏落地)的前置条件里,U2 这一格可以拆掉。
- 本文**新增一条基线该收的不变量**:*并集必须封顶,且封顶失败要 fail-closed 到"少放几个工作区",
  不是"起不来"*(§2.2)。它与 I1 同族,建议在基线里作为 I1 的补注落库。
