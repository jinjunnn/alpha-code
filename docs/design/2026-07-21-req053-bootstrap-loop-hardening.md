# REQ-053 设计基线 — C16 悬空配置引用 → bootstrap 死循环事故整改

- **需求**:#218 REQ-053(P1 incident,scope L)
- **子票**:#468 `[CODE]` 清除/启动双入口剥离悬空引用(AC1/AC2)· #469 `[CODE]` 日志失控断路器 + 每次 spawn 轮转(AC3/AC4)· #470 `[VERIFY]` 打包事故回归三有界(AC2 打包/AC5)
- **事故档(地面真相)**:[`docs/audits/2026-07-07-req053-home-instance-loop.md`](../audits/2026-07-07-req053-home-instance-loop.md)
- **状态**:基线已批(owner 采纳);L 级方案门产物。所有断言以 2026-07-21 `alpha` 分支实读代码为据。
- **审计**:由 Fable 模型只读勘破产出;开发前每张 CODE 子票 Codex 对抗一轮(是否有更简单正确解),合并前 Fable 审计。

> 本基线纠正了一处陈旧前提:事故当天的悬空面是 `~/.opencode/opencode.jsonc`,但 REQ-059 后 alpha 真源已迁至 `<alphaGlobal>/alpha.jsonc`,今天的活体复现面已不同(见 §①)。

---

## ① 只读勘破(Ground truth)

### 1. C16 清除逻辑对 config 内容零感知 —— 但"活体复现面"与事故当天已不同

- `packages/ui-mac/src/main/data-clear.ts` 全文(1-260)只有路径清单语义:`CREDENTIAL_ITEMS`(:54-62)、`planClear`(:146-192)、`executeClear`(:200-260)。全模块**不 import jsonc-parser、不打开任何 config 文件**;`bridgeLinks` 只摘 symlink(:240-257)。勘破前提确认:C16 删资产本体,不清引用。
- **勘破修正(重要)**:REQ-059 之后 alpha 真源已从事故当天的 `~/.opencode/opencode.jsonc` 迁到 `<alphaGlobal>/alpha.jsonc`(`engine-config-truth.ts:20-22`)。而 data 级清除把 alphaGlobal 整根删掉(`data-clear.ts:171-177` 的 `alpha-global` 项,rel `"."`)——alpha.jsonc 本体随根消失,**data 级不再留下 alpha.jsonc 内的悬空引用**。今天的活体复现面是:
  - **凭证级清除**(`data-clear-boot.ts:90-127`):删 `alpha-mcp-secrets/`、`alpha-secrets`、`alpha.env`(`executeClear` 且 `includeShared:true`,:115),但 alpha.jsonc 存活,其 `mcp.<name>.environment/headers` 里的 `{file:}` 引用悬空;随后 `logout()`(:117)立刻 respawn sidecar → **与事故同构的循环当场开始,应用还在运行**。这是当前最危险的一条路径。
  - **data 级 + 未迁移/bail-out 机器**:legacy `~/.opencode/opencode.jsonc` 不在删除清单,对话框文案甚至**明文承诺不碰它**(`data-clear-boot.ts:167-168`)——正是事故里留下两条悬空引用的那份文件。
- 引擎侧失败语义确认:`{file:}` 目标 ENOENT → `InvalidError` 抛出(上游 `packages/opencode/src/config/variable.ts:67-81`;`missing` 默认 `"error"`,:34)→ `config.get()` 失败;~~file 型 plugin import 失败同理(`bootstrap.ts:37-39`)。任一者 = instance 创建中断。~~

> **订正(2026-08-14,`#218` 勘破实测)**:上面划掉的那半句今天不成立。
>
> - **旧口径为何不成立**:执行 `node_modules` 里装着的那份上游 `packages/opencode/src/plugin/loader.ts`,
>   对一个**缺失的绝对路径 plugin** 调 `PluginLoader.loadExternal` —— 它**不抛**,正常返回 `loaded = 0`,
>   只在 `reports` 里留一条 `error(stage=load): ResolveMessage: Cannot find module '<path>'`。
>   `bootstrap.ts:34-44` 里唯一**不被 catch** 的致命项是 `config.get()`(即 `{file:}` 替换失败);
>   `plugin.init()` 虽然也不被 catch,但它内部不抛。
> - **什么仍成立**:悬空 `{file:}` 仍然致命(实测上游 `ConfigVariable.substitute` 对事故档那两条引用的
>   原形抛 `ConfigInvalidError`);上游 `instance-store.ts` 仍是零退避、零失败记忆(`completeLoad` 失败即
>   `removeEntry`,:72-77),循环机制本身没变。
> - **后果(直接改变 `#470` 的夹具设计)**:**只种 `plugin[]` 造不出这个循环** —— 那样的夹具会得到一个
>   「启动正常」的假绿,而它证明不了 AC2。`#470` 的夹具**必须带 `{file:}`**。

### 2. 上游重试风暴(READ-ONLY,禁改)

- `packages/opencode/src/project/instance-store.ts`:`load()` 只对**成功**做 memoization——`completeLoad` 失败即 `removeEntry`(:72-77,:65-70),cache 里不留失败记忆;下一次 `load()` 全量重跑 bootstrap。全文件无任何 backoff/failure-TTL。
- 调用面:每个 HTTP 请求经 `InstanceContextMiddleware` 都触发 `store.load({directory})`(`server/routes/instance/httpapi/middleware/instance-context.ts:29`),加上引擎内部调用方(worktree/control-plane/ACP),零退避即时重试。三行循环日志源:`project.ts:214`(fromDirectory)、`bootstrap.ts:34`(bootstrapping)、`instance-store.ts:118`(creating instance)。fork 纪律:`packages/opencode/**`、`packages/desktop/**` 一律不改——AC3 必须 alpha 侧解。

### 3. 日志:轮转只在冷启动一次;引擎日志定名追加

- 引擎日志 = 固定名 `opencode.log` 追加写(`packages/core/src/observability/logging.ts:49-51`,flag `"a"`),目录 = `serverLogRoots()`(alpha 侧派生 `logging.ts:158-161`)。
- alpha 的 `rotateServerLogs()`(`logging.ts:167-180`,25MB 阈值 :14,归档保 3 份 :182-190)**只在 `initLogging()` 调一次**(:35)= 仅 app 冷启动;sidecar respawn(login/logout/self-heal)不轮转 → 单 run 无上限,21GB 一夜由此而来。alpha 自身 main/renderer 日志已有 5MB maxSize(:26),不是问题面。

### 4. 既有的护栏与呈现面(可复用,不必新建)

- `sidecar-self-heal.ts`:指数梯子 1→2→4→8→16s、5 次封顶、60s 健康即重置(:11-13,:29-34)——**只在子进程 exit 时触发**(`index.ts:174`)。事故中 sidecar HTTP 存活(/api/health 401 正常),循环烧 CPU 但进程不退,self-heal 全程未介入。且注意:**60s 健康重置语义与"活着但失控"的循环互斥**——若只靠它,循环期 uptime>60s 会不断清零 attempts。
- **RecoveryService 事故通道已存在**:give-up 路径注册 incident、`RECOVERY_ACTIONS.retryEngine` 动作、`alpha-recovery-incident` 推送 renderer(`index.ts:183-204`)。AC3 的"loud + recoverable"呈现面**不需要新建 UI 系统**。
- `bootEnforcementGap` fail-closed 闸门已存在:boot reconcile 判定不可保证 → 拒绝 spawn + 对话框 + 退出(`index.ts:729-738`);**respawn 不重跑 reconcile**(:727-728 注释)。
- `configHealth()`(`ext-config.ts:1105-1132` + renderer `use-config-health.ts`、`AlphaHome.tsx:73-86`)只探语法错/未知顶键,不感知悬空引用。
- 引用解析原语齐备:`collectMcpFileRefPaths`(`alpha-mcp-secrets.ts:432-450`)、`resolveMcpRefPath`(引擎同判语义,:425-428)、`pathIdentity` / `isAbsenceError`(缺席可证性,:368-420);配置写锁 `withConfigWriteLock`(`ext-config.ts:34-42`)、原子写 temp+rename+.bak(`writeKeyUnlocked`,:338-376)。boot reconcile 自身写盘不持锁(`engine-config-truth-boot.ts:191-203`,单线程 boot 期先例)。

### 5. 所有权三分(本设计的红线地图)

| 面 | 判据 | 本设计可否写 |
|---|---|---|
| **alpha 自有** | `<alphaGlobal>/alpha.jsonc`(恒);legacy `~/.opencode/opencode.jsonc` 仅当 `isAlphaOwnedConfig` owned(`engine-config-truth.ts:166-196`,顶键 ⊆ `ALPHA_CONFIG_TOP_KEYS` :127-135) | 可写(锁 + 原子) |
| **上游源码** | `packages/opencode/**`、`packages/desktop/**` | 禁改 |
| **用户外来** | XDG `~/.config/opencode/*`(`ext-config.ts:77-85`);legacy 文件 ownership bail-out 态;`~/.opencode` 内非链非 junk 内容 | 永不写;只 loud 记账 |

---

## ② 选定方案与被否决的替代

**总纲:AC1(引用闭包)是真正的预防,AC2(启动自愈)是同一把刀的第二个挥点,AC3 收缩为"未知原因"的窄断路器,AC4 与 AC3 共享同一次 stat。不建任何通用监控框架。**

### AC1 — 清除时剥离 alpha 自有引用闭包

**选定**:新增 electron-free 纯逻辑模块 `packages/ui-mac/src/main/engine-config-dangling.ts`,单一函数族:
- `planDanglingSweep(parsed, {configDir, guardRoots})`:只识别两类事故载体——
  1. `plugin[]` 中**绝对路径**条目,resolve 进守卫根且**确证缺席** → 移除该数组元素(npm 包名条目零接触);
  2. `mcp.<name>` 叶内(environment/headers 深收集)`{file:}` 引用,按引擎语义 `resolveMcpRefPath` 解析进守卫根且确证缺席 → 删除该 env 键/header 值(**不删整个 mcp 叶**——server 条目是用户可见安装事实,密钥按凭证级对话框既有承诺"再次使用需重新填写")。
- 守卫根 = `userData`、`alphaGlobalRoot()`、`engineDataDir`、退休根 `~/.alpha`(`engine-config-truth-boot.ts:231` 同源)——指进这四处的引用**由构造即 alpha 所写**,剥离不可能触及用户内容。
- 接线:`data-clear-boot.ts` 两级清除的 `executeClear` **之后、`logout()`/`app.exit(0)` 之前**各调一次(凭证级 → alpha.jsonc + legacy owned;data 级 → 仅 legacy owned,alpha.jsonc 已随根删除)。写入走 `withConfigWriteLock` + `writeKeyUnlocked` 同款原子纪律;锁 busy → loud warn,交由 AC2 boot 扫兜底,不阻塞退出。
- 对话框文案同步:`data-clear-boot.ts:167-168` 的"不会触碰 opencode.jsonc"承诺改为如实描述"alpha 自有的悬空引用会被一并清理"(事故档教训 §2:删除边界按引用闭包算)。

**被否决**:
- *清除前预删(按"将删集合"判定)*:需要两套判据(计划集 vs 缺席),且 crash 窗口反而更复杂。事后按"确证缺席"判定 = 与 boot 扫**同一份语义**,crash 窗口天然由 AC2 覆盖。
- *写空占位密钥文件保住 `{file:}` 可解析*:placebo——引擎能启动但连接器带着幽灵引用静默坏掉,违反 anti-B11;拒。
- *清除时整删 legacy opencode.jsonc*:bail-out(用户混写)机器会毁用户内容;ownership 门内剥引用已足够。
- **更简单的正确解?** "data 级什么都不做"(alpha.jsonc 已随根死)成立一半——但凭证级与 legacy 面是活体复现路径,无法免除。已是最小刀口:两类载体、四个守卫根、两处接线。

### AC2 — 悬空夹具重启后不进循环

**选定**:同一个 `planDanglingSweep` 在 **boot 期、`reconcileEngineConfigTruth` 之后、首个 sidecar fork 之前**再跑一次(`index.ts:499` 紧邻处;boot 期单线程,循 reconcile 先例免锁)。三种结局:
- 无悬空 → no-op(幂等,常态零成本);
- 有悬空且可剥 → 剥 + loud log(事故机自愈,含"清除后 crash 未来得及剥"的窗口);
- 有悬空但**不可证/不可写**(parse error、身份 uncertain、写失败)→ 置 `bootEnforcementGap`,复用既有 fail-closed 拒 spawn 闸(`index.ts:729-738`)——宁可不启动,不进 21GB 循环。
- **隔离 onboarding(`OPENCODE_TEST_ONBOARDING=1`)仍跑这次 boot sweep**(以及 `bootEnforcementGap` 的 dangling 分支);仍跳过 REQ-059/065/104 reconcile 与全局 ecosystem gate(`#1031`)。packaged 隔离夹具不能再靠该 env 把 AC2 整段关掉。
- 附加一处零成本接线:sidecar **respawn 路径**也调 sweep(锁 busy 则跳过 loud)——补上"respawn 不重跑 reconcile"(`index.ts:727-728`)留下的运行期悬空洞,让 AC3 断路器的 kill→respawn 对已知病因一次即愈。

**被否决**:
- *只加 configHealth 式 banner 不自愈*:banner 拦不住引擎内部循环,AC2 直接 FAIL;拒。
- *把 sweep 塞进 `reconcileEngineConfigTruth` 函数体内*:该函数已承载迁移/skills/factory 四重职责;独立模块 + 相邻调用,单测边界更干净。**更简单的正确解?** 无——AC2 的机制就是 AC1 那把刀换个挥点,新增代码 ≈ 一个调用点 + gap 分支。

### AC3 — 有界退避 + loud 可恢复错误(反 scope-creep 的核心裁决)

**先回答题眼:AC1/AC2 已消灭已知病因,AC3 是窄收容背板,不是子系统。**

**选定**:`engine-runaway-guard.ts`——**单信号、单执行器**的断路器:
- **信号**:sidecar ready 后每 60s 对 `serverLogRoots()` 活跃 `opencode.log` 做一次 `statSync`(每 tick 一次系统调用,零解析零采样)。判失控:**连续 2 个窗口增量 > 64MB**(事故速率 ~30MB/min 的 2 倍裕度,合法日志差 2-3 个数量级)**或绝对尺寸 > 512MB**(运行期硬帽;因 AC4 使每次 spawn 起点 <25MB,绝对帽不会被陈年存量误触)。
- **执行器**:strike 1-2 → 直接 kill sidecar 子进程(**不置空 `server`**,让 exit 走既有 `handleSidecarExit` → `planSelfHeal` 梯子 respawn,`index.ts:174-211`;respawn 顺路轮转 + sweep);strike 3 → 按蓄意 kill 纪律置空 `server` 后 kill,**不再自动 respawn**,注册 RecoveryService incident(镜像 give-up 块 :183-204,`retryEngine` 动作复位 strikes)——引擎停机 = CPU 归零、实例数归零、日志冻结,UI 收到可区分的"引擎反复失控,已暂停"可恢复事故卡。strikes 30 分钟无判定自然衰减。**guard 自带 strike 计数,不复用 self-heal 的 60s-健康重置**(勘破 §4:该重置语义与"活着但失控"互斥)。
- **为什么不是通用看门狗(显式拒绝审计 §2 的引申)**:CPU 采样跨平台脏且对合法高载(编译/索引/首扫)假阳性高;日志内容解析的 I/O 与洪水同阶;进程表监控/B11 监控框架是为"未来所有病"预付的无底洞。本断路器只证明一件事:**引擎日志以病理速率增长**——这恰是本事故类(以及任何 flood 类)的充分信号,且 AC4 反正需要这次 stat。
- **被否决的其它替代**:*改上游加 backoff*(fork 纪律禁);*renderer 限流*(勘破 §2:风暴在引擎内部调用面 + 无失败 memoization,alpha renderer 本就只有手动重试 Banner,`AlphaHome.tsx:73-79`,无可限之流);*什么都不做,只靠 AC1/AC2*(AC3 要求的是**类**边界——未知病因的 flood 同样要有界,instance-vs-class 纪律);*只留绝对帽不做速率规则*(慢烧循环在帽下可长时间烧 CPU,~~速率规则 2 分钟内断路~~,两规则共享同一次 stat,边际成本为零)。

> **订正(2026-08-14,`#218` 实测驱动出货的 `decideEngineRunawayGuard`)**:上面划掉的
> 「速率规则 2 分钟内断路」对**本事故类**不成立,而且 W5 的「有界」在一个具体区间里也不成立。
> 两条都只**登记**,本轮**不动任何阈值**(阈值是产品裁决,已交回 owner)。
>
> **① 本事故类只有绝对帽有效,速率规则一次都不触发。**
> 判据来源说明(执行 #470 的人必读):**生产在断路那一刻只写 `{ strikes }`**
> (`index.ts:386` / `:396` 两条 `writeLog("utility", …, { strikes }, "error")`),`decideEngineRunawayGuard`
> 的返回值里也只有 `action` —— **没有任何日志/返回值直接说出「是哪条规则」**。规则归属只能由夹具
> **自己独立记录的逐分钟尺寸序列**反推:全程窗口增量 Δ < 64MB ⇒ `fastWindows` 恒 0 ⇒ 速率规则结构上
> 不可能触发 ⇒ 首次 verdict 必由 `size > 512MB` 给出。
>
> | 事故速率 | 第一击 | 第三击(停机) | 累计写盘 | 触发规则 |
> |---|---|---|---|---|
> | 30 MB/min(1.8GB / 1h) | 第 **18** 个 60s 窗,`t=+18min`,**540MB** | `t=+54min` | ≈ 3 × 540MB ≈ **1.6GB** | `absolute-cap`(`fastWindows` 全程 0) |
> | 35 MB/min(21GB / 夜) | 第 **15** 窗,`t=+15min`,**525MB** | `t=+45min` | ≈ **1.5GB** | 同上 |
>
> 建模约定(**别把 17 和 18 当成矛盾**):512MB 这条帽在 `t = 512/30 ≈ 17.1min` 就被越过,但判定
> **只在 60s 采样点做出** ⇒ 第一次**看见**它的是第 18 窗。窗序随「起表时刻与写入起点的相位差」±1。
> 每次 `kill-and-respawn` 后 `spawnLocalServer` 会轮转掉那 540MB(AC4)⇒ 尺寸归零、重新起表,
> 所以三击的间隔是等长的。
>
> **② 慢烧区间(< 512MB ÷ 29min ≈ 17.7 MB/min)里断路器永远停在第一击。**
> `ENGINE_RUNAWAY_STRIKE_DECAY_MS`(30min)与 512MB 帽的比值给出一个临界速率:比它慢的循环,
> 两次判定的间隔 ≥ 30min ⇒ `decideEngineRunawayGuard` 开头那个衰减分支先把 `strikes` 清零,
> **strikes 永远回不到 2**。10 小时窗口实测:17.6 MB/min ⇒ **20 次** kill/respawn、15 MB/min ⇒ **17 次**、
> 10 MB/min ⇒ **11 次**,`stop-and-report` **一次都没到达**(17.7 MB/min 则正常三击停机)。
> 后果:日志确实有界(≤ 525MB + 3 份归档),但**引擎被无限重启、循环无限重来、CPU 不有界,
> 而且用户永远看不到那张可恢复事故卡** —— AC3 的「loud、可恢复」与 AC5 的「CPU 有界」在这个区间不成立。
> ⚠️ 本条是**决策核建模实测**(按 `index.ts:360-362`/`:380-391` 的真实路径复现 respawn 后的
> 轮转 + 重新 arm),**不是打包实测**;打包侧验证挂 `#470` / 新票。跟踪:`alpha-code#967`(产品裁决)。
- **更简单的正确解?** 有人会提"只在 give-up 弹 recovery"——但 self-heal 永不触发(进程不退)。断路器已是能满足"CPU/日志双有界 + loud recoverable"的最小机器:一个 stat、两条阈值规则、一个 strike 计数、复用两套既有机器(self-heal 梯子 + RecoveryService)。
- **AC3 是否需要 DECIDE 票:不需要**。机制在此设计锁定;按 L 级契约,开发前 Codex 一轮对抗"是否有更简单正确解"即为裁决点,结论回写本基线。无未决技术路径。

### AC4 — 运行期日志尺寸帽/轮转

**选定**:两行结构的改动——
1. `rotateServerLogs` 从 `logging.ts` 导出,在 `spawnLocalServer`(`server.ts:122`)fork **之前**调用 → 冷启动、login/logout respawn、self-heal respawn、断路器 respawn **每次 spawn 都轮转**(kill 先行,无 fd 竞争);
2. 运行期间的帽 = AC3 的 512MB 绝对规则(触帽即 kill→轮转→respawn)。

**诚实边界**:单 run 活跃文件上界 ≈ 512MB + 一个窗口增量;目录总量 ≈ 活跃 + 3 份归档(`pruneServerArchives`)。相对 21GB 是 40 倍级收敛;AC5 断言"有界",不承诺"很小"。

> **补记(2026-08-14,`#218` 实测)**:这条「诚实边界」本身仍然成立,但它只覆盖**单 run 的日志**。
> 实测把两件事补全:①**累计**写盘量 = 每一击 ~520–540MB × 3 击 ≈ **1.5–1.6GB**(每次 kill→respawn
> 都轮转,所以盘上同时存在的量有界,写下去的总量没有);②在 **< 17.7 MB/min** 的慢烧区间里,
> kill/respawn 无限循环,累计写盘随时间线性增长而**永不停机**(10 小时实测 11–20 次),
> 此时「CPU 有界」不成立。详见 §AC3 的订正块与 `alpha-code#967`。

**被否决**:*copytruncate 在线截断*(引擎虽 O_APPEND 但截断有丢行窗口,且为省一次 respawn 引入第二套机制);*让引擎自转*(上游禁改);*缩短 60s 窗口/调低帽*(把正常长会话推进"为轮转杀会话"的体验坑)。**更简单的正确解?** 若只做"每次 spawn 轮转"而无运行帽,单 run 仍无界,AC4 字面 FAIL;当前组合已最小。

### AC5 — 打包事故回归

**选定**:VERIFY 票,复用 packaged smoke 范式(`docs/verification/2026-07-17-packaged-macos-rc-smoke.md` 先例):夹具 A(启动前种悬空 plugin[]+{file:} 于 alpha.jsonc/legacy)证 boot 自愈 + "creating instance 恰 1 次";夹具 B(运行中制造悬空触发活循环)证断路器 ~~≤3 窗口断路~~、recovery 卡可见、终态 CPU <10%、opencode.log ≤ 帽 + 裕度、无第二实例风暴。不新建 harness 框架。

> **订正(2026-08-14,`#218`)**:`≤3 窗口断路` 这条退出条件今天为假 —— 照它写断言**必红**,
> 而红了以后最省事的「修法」正好是把阈值调小,那等于把一道真闸门当噪声处置。见 §AC3 订正块:
> 事故自身速率下第一击落在**第 18 个**窗(30MB/min)/ 第 **15** 窗(35MB/min),由 `absolute-cap` 给出。
>
> **AC5 的退出条件改写为**:夹具 B 逐分钟记录 `serverLogRoots()[0]/opencode.log` 的尺寸序列,
> 断言 **哪条规则 / 第几窗 / 多少字节 / 多少分钟** 触发,而不是断言一个窗口数。
> 「哪条规则」**没有直接来源**(生产只 log `{strikes}`,见 §AC3 订正块),必须由夹具自己的
> 尺寸序列反推:全程 Δ<64MB ⇒ `fastWindows` 恒 0 ⇒ 首次 verdict 必由 `size>512MB` 给出。
>
> **`#470` 的夹具清单(四条,缺一条就有一整类不被证)**:
> - **A 冷启动自愈** —— `<alphaGlobal>/alpha.jsonc` 与 legacy `~/.opencode/opencode.jsonc` **各**种一条事故原形
>   (一条 = `plugin[]` 绝对路径 + `{file:}` 各一条 ⇒ **每份 2 条**)。**必须带 `{file:}`**(见 §①.1 订正块:
>   只用 `plugin[]` 造不出循环)。断言:①引擎日志 `creating instance` **恰 1 次**(事故档 10:31 恢复确认用的
>   就是这个数)②main.log 的判据行是 `[req053-dangling-sweep] confirmed-absent Alpha config references stripped`
>   (`index.ts:296`),数量不在这一行的文本里,而在**随行对象**里、写作 `stripped: 4`(冒号+空格)。
>   ③**每份**配置里那 2 条键真消失,而同夹具里的**活引用 + npm 包名条目 + 一条落在守卫根外的 user-foreign
>   绝对路径**逐字节保留 ④预置的 XDG `~/.config/opencode/opencode.jsonc` 的 inode+mtime 不变。
>
>   > **订正(2026-08-14,`#218` R2)**:本条断言 ② 原文写「main.log 出现 `… stripped=2`」,两处都错,
>   > 而这个订正块的全部作用就是当 `#470` 的执行地图 —— 照原文 grep 恒零命中。
>   > **(a) 形态**:`stripped=<n>` 这个 `key=value` 形态**只属于清除路径**(`data-clear-boot.ts:90`,
>   > `[req053-dangling-sweep] level=${level} stripped=${n} files=...`),而夹具 A 走的是**冷启动**路径,
>   > 它在 `index.ts:296` 是 `logger.warn("[req053-dangling-sweep] confirmed-absent Alpha config references stripped",
>   > { context, stripped, files })` —— 数量是**对象字段**。`logging.ts` 只覆写了 `transports.file.maxSize`
>   > 与 `resolvePathFn`(`:26-27`),**没有**覆写 `transports.file.format` ⇒ 走 electron-log 默认
>   > `[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}]{scope} {text}`,对象经 `util.formatWithOptions` 渲染。
>   > 实跑装着的那份(`electron-log@5.4.4`,同一 warn 调用形态)落盘是:
>   > `[2026-08-14 11:34:06.981] [warn]  [req053-dangling-sweep] confirmed-absent Alpha config references stripped {`
>   > 换行 `  context: 'boot',` / `  stripped: 4,` / `  files: [ … ]` / `}` —— 带真实绝对路径时单行超
>   > `breakLength` **必然换行展开**(短对象则不换行,两种形态都出现过)。⇒ **判据不得写成一条同时要求
>   > 标记与数字的单行 grep**;用 `grep -a -A4 "confirmed-absent Alpha config references stripped" main.log`
>   > 读整块,或把标记与 `stripped: <n>` 拆成两条断言。
>   > **(b) 数**:boot 一次 sweep 覆盖 `[alpha.jsonc, legacy]` **两份**,`outcome.stripped` 是**跨文件汇总**
>   > (`engine-config-dangling.ts:258` 把每份的 `plan.edits` 推进同一个数组)且 `recordDanglingSweep`
>   > **只发一行** ⇒ 本夹具是 **`stripped: 4`**(2 份 × 2 条)。③ 里的「2 条」是**单文件**维度 ——
>   > 同一条清单里的这两个数指的不是同一件事,按夹具实际种子数重算,别照抄 4。
> - **A2 fail-closed 单独一格** —— legacy 文件多一个用户手写顶层键(如 `theme`)+ 同样两条悬空 ⇒ 断言 app
>   **不 spawn sidecar**、退出码 1、日志有 boot enforcement gap。没有这一格,把 `index.ts:821-826` 删掉夹具 A 照样全绿。
> - **B 运行期断路** —— 逐分钟尺寸序列 + 上面那条改写后的判据;strike3 后 RecoveryService 事故卡可见 +
>   引擎停机 + 全进程 CPU<10% + 目录总量 ≤ 活跃(≤576MB)+ 3 份归档。单次跑到 strike-3 约 **45–54 分钟**真实时间。
> - **C 速率规则单独证活** —— **不要指望 B 覆盖它**(实测 B 全程 `fastWindows=0`)。用
>   `engine-runaway-guard.test.ts` 已有的 rate 夹具保住,并在证据里留一条绕过实验记录:
>   「把 `decideEngineRunawayGuard` 的 `fastWindows >= 2` 删掉,夹具 B 仍全绿」。
>
> 证据落 `docs/verification/<日期>-req053-packaged-incident-regression/`;本轮(`#966`)只写清落点与清单,不创建。

---

## ③ 安全面(必填)

### AC1/AC2 config 剥离可能毁伤用户配置的整类通路 + 必守不变量

**攻击/事故类枚举**(fail-open 即事故):

1. **写错文件**:sweep 触到 XDG 用户 config 或 bail-out 态 legacy 文件 → 毁用户手写内容。
2. **剥错条目**:用户在混写文件里的自有 plugin 路径(如 `~/dev/myplugin/index.js`)恰好暂缺 → 被当悬空删除。
3. **缺席误判**:EACCES/EIO/ELOOP 被折叠成"不存在";或 symlink 别名(`/var→/private/var`、断链前缀)使词法比较漏判"同一文件仍在" → 删活引用。
4. **并发写毁伤**:无锁 read-modify-write 使在途 ext 事务的 before-image 失效(`ext-config.ts:29-33` 已记载的事故类),或与 catalog 写互相覆盖。
5. **写坏整份 config**:半截写/非法 JSONC 落盘 → 引擎对语法错整份清零(`ext-config.ts:1087-1090` 上游行为)= 比悬空引用更大的爆炸半径。
6. **parse 失败 fail-open**:损坏文件被容错解析成部分对象后照写 → 以残基底重建,抹掉未解析出的内容(#395 步骤4 同类,`engine-config-truth-boot.ts:126-129` 先例)。
7. **过度删除形状**:删整个 `mcp.<name>` 叶(而非悬空 env 键)→ 毁用户可见安装事实;或误把 npm 包名 plugin 条目当路径删。
8. **逃生舱错位**:`ALPHA_JSONC_TRUTH_DISABLE` / `ALPHA_LEGACY_INSTALL_ROOT` 模式下 sweep 写了非引擎读取目标(或反之漏写真目标)。

**实现必守不变量**(逐条对应上表):

- **I1(目标集封闭)**:sweep 可写目标 = `{alpha.jsonc}` ∪ `{legacy ~/.opencode/opencode.jsonc 当且仅当 isAlphaOwnedConfig owned}`;XDG 路径出现在写路径即 bug。发现 XDG 内悬空 alpha 形态引用 → 只 loud log,零写入。
- **I2(双重判据)**:剥离条件 = (顶键 ∈ `ALPHA_CONFIG_TOP_KEYS` 的 `plugin`/`mcp` 域)∧(目标经 `resolveMcpRefPath` 引擎语义解析后落入四守卫根)∧(缺席**确证**)。三者缺一不剥。
- **I3(缺席可证性)**:复用 `pathIdentity`/`isAbsenceError`(`alpha-mcp-secrets.ts:368-420`):仅 ENOENT/ENOTDIR 且 `certain:true` 算缺席;uncertain → 保留引用,boot 场景升 `bootEnforcementGap`(fail-closed 拒 spawn),清除场景 loud 保留。
- **I4(锁纪律)**:清除时与 respawn 时的 sweep 必持 `withConfigWriteLock`(bundle 锁,`ext-config.ts:34-42`);busy → 跳过 loud,绝不裸写。boot 期免锁循 `reconcileEngineConfigTruth` 先例(sidecar 未 spawn、单线程)。
- **I5(原子 + 后验)**:jsonc-parser `modify/applyEdits` 保注释,写前收集 `ParseError[]` 后验,temp+rename+`.bak` 回滚——完全复用 `writeKeyUnlocked` 纪律(:338-376),不另造写路径。
- **I6(parse fail-closed)**:任一目标文件读不出(非缺席错误)或解析报错 → 该文件本轮零写入 + loud;boot 场景若该文件同时检出悬空形态 → `bootEnforcementGap`。
- **I7(最小编辑形状)**:plugin[] 只删命中元素;mcp 只删悬空 env 键/header 值,叶与空 `environment: {}` 保留(engine schema 合法);**sweep 永不删除任何磁盘文件**——它只编辑 config 文本,文件删除权仍独属 data-clear。
- **I8(路由一致)**:sweep 的目标解析走 `mcpPluginTargetPath()` 同一路由(`ext-config.ts:117-121`);逃生舱模式下与引擎读取目标一致,否则跳过 loud。

### 断路器的假阳性类 + 防误杀不变量

**类**:合法慢启动/高载被误杀——首次运行的技能扫描、大仓索引、verbose 会话、陈年大日志存量、日志目录暂不可读。

**不变量**:
- **W1(信号下界)**:速率规则要求**连续 2 个 60s 窗口各 >64MB 增量**(≥ ~1MB/s 持续 2 分钟)——健康引擎冷启动全量 32 行(事故档修复后实测),合法负载与阈值差 2-3 个数量级;单窗口尖峰不触发。
- **W2(存量免罪)**:速率按 delta 计,绝对帽依赖"每次 spawn 已轮转至 <25MB"(AC4)——陈年大文件在 fork 前已归档,绝对帽只可能由本 run 增长触达。
- **W3(armed-after-ready)**:guard 在 sidecar ready 之后才起表,首窗口以当前尺寸为基线;spawn/启动阶段永不判定。
- **W4(执行器封闭)**:唯一动作 = kill 本代 sidecar 子进程 + 既有梯子/recovery 通道;不碰其它进程、不删日志内容、strike 3 后停机而非无限杀-拉锯;`stat` 失败(ENOENT 等)恒为"无判定",永不作阳性。
- **W5(可恢复性)**:终态必是 RecoveryService incident(`retryEngine` 复位 strikes + selfHeal),不存在静默永久停机;strikes 30 分钟无判定自动衰减,周级偶发不累加成停机。

---

## ④ 子票切分

按 requirement-management 契约,L 级、基线批准后切;**无 DECIDE 票**(AC3 机制已在 ② 设计锁定,开发前 Codex 一轮为对抗性复核点;唯一 owner 可见的契约变化——data-clear 对话框不再承诺不碰 legacy config——随 #468 PR 正文显式呈报,属文案裁决非技术路径未决)。

### #468 `[REQ-053][CODE]` 清除与启动双入口剥离 alpha 悬空配置引用(plugin[] + {file:})
- **AC**:AC1、AC2(单测/集成层证据;打包证据归 VERIFY 票)。
- **边界**:新建 `packages/ui-mac/src/main/engine-config-dangling.ts`(纯逻辑 + 单测);接线 `data-clear-boot.ts`(两级清除后、对话框文案 :167-168)、`index.ts`(boot reconcile 后 sweep + `bootEnforcementGap` 分支、respawn 前 sweep);写盘复用 `ext-config.ts` 的锁与原子写原语。
- **Out of scope**:XDG 用户 config 的任何写入;mcp 叶整体删除;上游任何文件;新 UI;configHealth 扩展。
- **退出条件**:③ 中 I1-I8 各有对应单测;`bin/check` 绿;凭证级清除后 alpha.jsonc 无守卫根内悬空引用的集成断言。

### #469 `[REQ-053][CODE]` 引擎日志失控断路器 + 每次 spawn 轮转引擎日志
- **AC**:AC3、AC4。
- **边界**:`logging.ts` 导出 `rotateServerLogs` 并在 `server.ts` `spawnLocalServer` fork 前调用;新建 `engine-runaway-guard.ts`(纯决策核 + 单测);`index.ts` 接线(60s 定时、kill 路由、strike-3 的 RecoveryService incident 注册,镜像 :183-204 give-up 块)。
- **Out of scope**:CPU/进程监控、日志内容解析、上游改动、renderer 新 UI、阈值可配置化(常量即可)。
- **退出条件**:决策核单测覆盖 W1-W5;respawn 路径轮转的集成断言;`bin/check` 绿。

### #470 `[REQ-053][VERIFY]` 打包事故回归:悬空引用重启不循环,CPU/实例数/日志增长三有界
- **AC**:AC2(打包面证据)、AC5。
- **边界**:packaged macOS 构建 + 两个夹具(A:启动前种悬空引用;B:运行中制造悬空触发活循环);证据落 `docs/verification/`。
- **Out of scope**:Windows 半场(随 #332 节奏);常规 RC checklist(L3 归 RC 票)。
- **退出条件**:矩阵执行完、证据文档落库;FAIL 转 bug 票挂父需求 #218。

**依赖序**:#468 与 #469 无代码重叠,可并行两条 review 线;#470 在两票合并后执行。父票 #218 由 owner 按 AC1-AC5 对证据逐条勾后手工关闭。
