---
title: Extension install ledger ownership and fail-closed commit
kind: contract
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-17
review_after: 2026-10-14
---

# 扩展安装账本契约(REQ-100 #354)

本文钉住 `<root>/installs.json`(v1 receipts + v2 records 同文件双视图)的**写方所有权**
与 catalog 安装提交面的 fail-closed 语义。账本机制归 `ext-receipt-v2.ts`,提交面编排归
`ext-install-planner.ts`,未策展协调归 `ext-uncurated-record.ts`(#306)。

## 1. 写方所有权(单一账本真源)

- **catalog 安装(全类型,#378 收口)** 归事务引擎 `commitReceipt`(写失败即事务失败 →
  引擎回滚,#336/#310/#311/#358/#359/#361/#378):skill = generation 事务;agent = file+config
  双 item(seed #358 + catalog #361,同一载体);**mcp = config action 单 item(#378;
  `configKey: mcp.<name>`)**;**plugin vendored fresh = CAS file items + config item(#378,
  `installPluginFromCas`;`configKey: plugin-path:<jsPath>`,`files:
  [plugins/<name>@<digest16>]`)**;**plugin npm fresh = config action 单 item(#378;
  `configKey: plugin:<pinned>`)**;plugin replace = #352 原子替换;**cloud = receipt action
  单 item(#378,零盘副作用)**;bundle 同前。planner 各分支**自提交早返回**,#354 时代的
  共享 `upsertRecordV2` 尾部与「按类型补偿闭包 + 密钥快照」已随之**下线**。
  多 item 事务的账本形态:**单条** v2 record,receipt 模板只挂逻辑主 item,副 item 不落账,
  `commitReceipt` 经 `recoveryReceiptInputs` 按 `receipt !== undefined` 过滤(恢复前滚同源)。
  installer/config 层的 eager v1 兜底早已下线(#354)——不存在「v2 失败但 v1 已写」的合法状态。
- **未策展安装**归 orchestrator(`recordUncuratedInstall`,#306):mutate → 单次账本写 →
  失败补偿并 fail-closed(未策展 MCP 的密钥写入自 #378 起走版本化只增布局,失败删本次
  verId 目录,不再整目录快照/恢复)。**例外(#390):未策展的 folder/git 技能导入与 imported
  agent(global scope)已改走事务载体**(`installUncuratedSkillImport`/`installUncuratedAgentImport`
  → generation / file+config),不再 flat copy + `recordUncuratedInstall`;自定义 MCP / npm 导入
  仍走 `recordUncuratedInstall`。account id 恒 `user:<name>`,非 catalog 不携供给链摘要(#306)。

## 2. 提交面 fail-closed(#336 残留收口;#378 起全类型归引擎)

- 账本提交 = 引擎 `commitReceipt`(锁内,switch 成功后):写失败抛错 → 引擎回滚全部盘面
  副作用(config 整文件 image 复原、file/generation 前像复原),receipt 与 live 永不背离。
- **损坏/不可读账本在计划前与锁内 precondition 双重拒绝且原文件不动**(`probeLedgerForWrite`;
  quarantine 不是提交路径)。残余界限(诚实声明):探测与 commit 之间若有绕过受控写体系的
  外部写方把账写坏,upsert 仍会 quarantine 该损坏文件再写新账 —— 旧字节保留供诊断。
- 审计事务 `commit` 通知只发生在引擎成功后;失败走 `rollback` 通知(配对 begin)。

## 3. 按类型的写前门与失败语义(#378:引擎回滚取代手工补偿)

| 类型 | 写前门(计划前 + 锁内 precondition) | 失败/崩溃语义 |
|---|---|---|
| mcp | strict 叶前像可读性(不可读/**语法损坏**/形状异常拒 —— jsonc 容错解析必须收 ParseError;重装合法,前像本体由引擎 config action 整文件 image journaled);granted 密钥未落位 fail-closed 拒明文持久化 | 引擎回滚(config 复原);本次密钥版本目录删除(版本化只增,旧版本零接触 —— 见能力授权契约 §9);成功后才 GC 旧版本 |
| plugin npm | 有账拒(三态分发;更新 = #352 替换);**跨配置源同 base 严格检查**(主配置未策展在场拒认领 + legacy XDG 在场拒,任一侧不可读拒;计划前与锁内双查)+ config 数组快照等值 | 引擎回滚(config 整文件复原);零残留 |
| plugin vendored | 有账拒(三态分发);无账既有目录拒(bare 与内容寻址目录都算在场,不覆盖/不认领);载荷经 CAS 读取重验;**entry 带 package 发行元数据时,跨配置源同 base 严格检查同样适用**(fresh 与 vendored 形态更新都查,主/legacy 未策展同包 npm 条目在场拒 —— 引擎按包名与 file URL 各自去重,漏查即双载;计划前与锁内双查,更新侧排除将被换元的旧条目) | 引擎回滚(file items + config 全撤);rolled-back 终态收空壳目录;崩溃按 journal digest 判翻转 |
| agent(seed #358 + catalog #361,同一载体) | fresh-only 双层门:catalog 锁外快速拒(有账 v2/v1、md 文件、或手工 `agent.<name>` 配置项 —— strict 读,不可读按在场)+ **引擎锁内 precondition**(`agentFreshGate`)重读封 TOCTOU;catalog 另拒 `entry.id ≠ agent:<name>` 身份漂移与含 `--` 名 | 引擎回滚(file 前像恢复缺席/旧字节 + config 叶复原) |
| cloud | 账本可写探测 | receipt action 零盘副作用;失败 = 零账本;**卸载 = grants 清除成功前置 + ledger 删除失败 `ok:false`**(receipts-only,账没去=没卸载);重装显式继承 `desiredState` |
| 未策展导入(#390:folder/git 技能 + imported agent,**仅 global**) | fresh-only:skill = `uncuratedSkillFreshGate`(catalog/损坏冲突 + 账本可写 + 有账 v2/v1 拒 + 无账 flat `skills/<name>` 目录拒),agent = `agentFreshGate(channel="import")`;`id=user:<name>`、`capabilities=[]`、**不携供给链摘要**(#306 非 catalog 不变量);内容自算地址进验证共享 CAS | 技能走 generation 载体、agent 走 file+config 载体,引擎回滚(前像恢复缺席/旧字节);project scope 不走本路径(ADR-030:维持 `<project>/.alpha/skills` flat sanctioned) |

MCP 重装是产品流(确认框重装),允许覆盖(引擎前像可复原)而非拒绝;agent 的覆盖更新在
产品上不存在(`updateEntry` 不支持 agent),故拒绝无回归。未策展导入(#390)同 agent:无就地
更新,改内容走重导入(fresh-only 拒同名)。

### 3.1 plugin 原子替换(REQ-099 #352)

- renderer 插件更新 = **单次** `ext-install-catalog`;main 从自己账本三态分发:absent → fresh、
  恰一条有效 catalog 旧账 → replace、其余(v1-only / 损坏 / 双键 / 名变更 / configKey 与
  config 不符)→ 显式拒绝(模糊态绝不当首装装)。旧「先卸后装」两步链已下线。
- replace = journaled 事务:config 精确换元(旧元素 → 新钉版/新路径,整文件 before-image
  由引擎回滚)+ receipt 同锁落账(commitReceipt 失败 = 事务失败);锁内 precondition 重读
  config 数组与账本旧事实,与 plan 快照任一分歧即拒绝重试(TOCTOU 钉死);崩溃恢复前滚
  幂等 —— `upsertRecordV2/upsertRecordsV2` 对同 `transaction.id` 且事实一致的重放原样返回
  (不递增 generation),同 id 事实冲突显式拒绝(§1 的 exact-replay 契约)。
- vendored 新内容先落 **versioned 目录** `plugins/<name>@<hex>`(staging,零权威副作用),
  事务只切 config 路径与 receipt,旧目录提交成功后 GC(失败如实入 warning;崩溃残留的
  新/旧孤儿目录无 config 引用,无害)。卸载接受 `<name>` 与 `<name>@<suffix>` 两种受控落点,
  树外路径仍 fail-closed。
- 替换过 #348 authorize 闸(能力扩张弹确认);更新**保留旧 `desiredState`**(更新 disabled
  插件不静默重新启用);同钉版同 digest 幂等早退(零副作用)。

## 4. project 账本共享与 environment 归因不变量(REQ-099 #356,Codex 裁决 A+C)

- project `.alpha` 跨 app channel(prod/beta/dev)共用,**不做**环境分根(env 隔离只作用于
  全局根);`InstallRecordV2.environment` 对 project 记录是 **adoption/安装时点的归因字段**
  ——先到先得,如实固化,后到 channel 不重写。
- **消费不变量**:environment 不是可见性、操作资格或 channel namespace —— 所有 channel 读同
  一本项目账本,任何读方(`readLedgerV2` / `findRecordV2` / `lookupForUninstall` /
  `ext-list-installs-v2`)不得按 environment 过滤或授权;新增读方必须遵守。
- adoption 触发面 = 项目 lifecycle(`ext-trust-check`),在「无 executable / 已有信任决策」
  两个早退**之前**;顺序 = realpath 身份 → `ledgerReady` → project recovery gate →
  project bundle 锁 → `migrateV1Ledger`(迁移器自身不持锁);无 `.alpha` 存量零写副作用;
  拒绝 loud log 零改动,busy/transient 下次打开自然重试(幂等)。

## 5. desiredState:初始分类、当前策略优先与投影权威(REQ-104 #395)

- **fresh-intake 分类器唯一决策点**(`shared/ext-install-policy.initialDesiredState`,#394 裁决):
  目录安装(origin=catalog)`source==="alpha"` = enabled,其余(含 official)一律 disabled;
  非目录 intake(imported/created)= enabled(用户显式自选内容)。renderer 安装文案共用同一
  函数,不得各写一份。factory 注入零安装不落账,天然绕过。
- **当前策略优先(写点决定,Codex r7 B4)**:任何更新/重装/回滚对既有记录一律保留其 desiredState。
  **决定点在写账本的原子处(`upsertRecordV2`/`upsertRecordsV2` 内锁内 prev),不是调用方计划期**——
  否则「计划期读到 enabled → 用户中途 disable → 更新事务提交旧 enabled」会复活禁用。prev 存在 = 更新,
  一律沿用 prev 当前 desiredState(启停只经 set-state 通道 `setDesiredStateV2` 改);fresh(无 prev)
  才用分类器传入值。v1→v2 迁移如实保留 enabled(存量不回溯)。
- **持久化 config 投影(#394 裁决 A′;Codex r2/r3 定稿)**:disabled 的 mcp/agent/plugin 的启用态**写进
  磁盘 alpha.jsonc**,字段用**引擎真实消费的键**:mcp `enabled:false`(引擎查 `mcp.enabled === false`)、
  agent `disable:true`(引擎查 `value.disable`)、plugin 从 `plugin[]` **缺席** —— 因引擎 import 插件早于
  config-hook,disabled plugin 必须从持久化 config 缺席才拦得住加载。plugin 增删按**解析路径身份**匹配
  (绝对/相对/`file://` 等价形态同判),受管归一化:enable 按 configKey 补回受管条目形态(受管安装从不
  写 `[spec,opts]` 元组,opts 不丢;用户对受管条目手加的 opts 不随启停往返 —— 显式契约,非静默)。config
  自持 disabled 态 → **天然免疫「删/坏账本复活」**(账本不是运行时唯一权威,config 是)。
- **skill 例外**:skill 不预加载,投影 = 引擎侧 config-hook 注入门(`skillGenerationLiveDirs`,
  只注入 **main 派生允许集** `skills-enabled.json` 里的 key;缺失/损坏/形状异常一律不注入 fail closed)。
- **cloud 例外**:无本地运行面 + UI 无启停开关,一律 enabled(直装与 bundle 子项一致)。
- **启停通道**(`ext-set-install-state`,#347-gated):锁内 record 重读 + advisory(R14)+ **持久化
  config 投影普通原子写 + 账本翻转**(非事务)。**两方向都账本先写**(Codex r4):账本是 durable
  intent —— 更新/重装读账本当前策略优先,账本先写则崩溃在账本↔config 之间时后续更新按账本重投影
  config **自愈**,禁用绝不被更新复活(config-first 会留「config 禁/账本启」被更新读启用复活)。
  config 原子写(writeFileAtomicSync 整替换或原文件不变)抛错 → 回滚账本到原态(回滚失败如实报真实
  状态);config 未变故 opts 等原样保留。残余:账本↔config 崩溃窗口的短暂运行态不符,durable intent 恒
  正确、下次更新/重开收敛。enable 缺生效面 fail-closed。disabled ≠ 卸载:内容/账本/授权账照常在位。
- **skill 严格门(Codex r5 定稿)**:ext 无法 import 主进程 decoder,逐字段镜像有永久漂移风险 ——
  改为 **main 用真 `decodeRecordV2` 派生 enabled 允许集写独立文件 `<root>/skills-enabled.json`**,
  hook 只读该文件(缺失/损坏/未知版本 = fail closed 不注入)。派生与账本**锁步**
  (`writeLedgerFile` 方向排序:有 key 被收走/现状不可信 → 派生先写,中途崩溃只会技能变暗;
  纯扩容 → 账本先写,派生失败回退删除,删不掉陈旧允许集才报错);boot reconcile 按账本重算自愈
  (升级首启 backfill / 扩容失败残留 / 账本损坏时撤陈旧允许集)。
- **startup reconcile(Codex r5 缺失件,#395 定稿)**:主进程启动时(REQ-059 truth reconcile 之后、
  首个 sidecar fork 读 config 之前)`reconcileDesiredStateAtBoot` 把账本全部 global mcp/agent/plugin
  记录的 desiredState **双向重投影**回 alpha.jsonc(disabled → 禁用键/缺席;enabled → 剥禁用键/补回),
  使 config 恒 = 账本派生 —— 消除「账本 disabled / config enabled」崩溃残留与一切旁路写入的复活面。
  边界 loud;**Codex r6 B2/B3**:凡「本应禁用的项无法保证从引擎配置移除」(config 写失败 / 非缺席
  读错误 / legacy concat 残留 / skills 陈旧允许集)= **enforcementGap** → 主进程 **fail-closed 阻断
  首个 sidecar spawn**(dialog 告知 + `app.exit`),绝不让引擎带着「账本禁用但仍会加载」的项启动;
  锁忙(在途事务自保一致)/enable 缺生效面 = 非 gap(仅 warning)。escape hatch 与 REQ-059 同口径。
- **legacy/XDG 源统一探测(Codex r6 B1 → r7 B1/M1/M3 收敛)**:引擎除主 alpha.jsonc 外还合并
  `~/.opencode` 与 XDG(config.ts directories 阶段,在主源**之后**再深合并),`plugin[]` 更是跨源
  **concat**(`mergeConfigConcatArrays`)。任何 kind 的 **disable**(set-state 与 boot reconcile,含
  alpha.jsonc **缺席**时)都先经 `legacyEnableResidueStrict` 统一探测全部 legacy 源:plugin 任一源含
  同 base(npm)/同文件身份(path,身份不可判 = fail-closed)→ concat 加载;**mcp** 任一源 `mcp[name]`
  在场且 `enabled !== false` → 深合并覆盖启用;**agent** 任一源 `agent[name]` 在场且 `disable !== true`
  → 覆盖启用。有残留 → fail-closed(set-state 拒 / boot 记 enforcementGap)。strict:任一源语法损坏/
  读不出/根非对象 → fail-closed。(r6 曾误判 mcp/agent「深合并后覆盖安全」,r7 M3 证伪:directories 阶段
  legacy 反向字段会覆盖禁用投影。)`computeEnableProjectionEdit` 因此回归纯 alpha.jsonc 投影,legacy
  探测统一在调用方一处。
- **未策展重加投影(Codex r5/r6 M1)**:`persistMcp`/`persistPlugin` 在唯一写入口消费账本 —— 记录
  disabled 的 mcp 重写叶强制并入 `enabled:false`(内容更新、状态不翻);disabled 的 plugin 重加须先
  确认该 base 从**所有运行时源缺席**才刷账本(换钉版 `@x/p@1`→`@x/p@2` 时旧 spec 若留 config 会成
  永久无账活条目):legacy/XDG 残留 → fail-closed;主 config 残留(旧钉版/崩溃残留)→ 移除该 base
  全部条目投影为缺席;都缺席 → 纯账本刷新。旁路「写正常叶复活」由此封死。
- **读错误收窄(Codex r5)**:alpha.jsonc 各读点只容缺席(ENOENT/ENOTDIR);EACCES/EIO 等
  「读不出」≠「不存在」,一律 fail-closed(启停双向拒、truth reconcile 整体 skip、legacy 不迁不清理、
  persistPlugin 拒写防空基底 clobber)。断链 symlink `pathIdentity` 判 certain:false —— **Codex r6 B5**:
  不只查最终组件,realpath **最长存在前缀**(穿透好 symlink 消除系统链别名歧义)+ 逐段上溯检测,
  祖先断链 symlink(`/alias/plugin.js` 里 `/alias` 断链)同样判不可词法证 → 匹配消费方 fail-closed。
- **账本 durability(Codex r5/r6 M2)**:`installs.json` 与 `skills-enabled.json` 写盘统一走
  `ext-atomic-fs.writeFileAtomicSync`(完整写循环杜绝短写截断 + fsync 文件 + 原子 rename + fsync
  目录)—— 手写单次 `fs.writeSync` 会忽略短写(ENOSPC/EIO)留下截断账本。账本先写契约的前提:账本
  必须先于 config 到达持久介质。skills 派生**方向排序(Codex r6 B4)**:收窄(移除项)先于账本落盘、
  扩容(新增项)后于账本;pre-shrink 失败 = 账本未写(回起点安全);final publish 失败 = 派生停在
  更严格态(skill 少注入 = 安全侧,boot 自愈补齐)。

## 6. 证据

`ext-boot-reconcile.test.ts`(#395 startup reconcile:双向重投影/幂等零写盘/锁忙与损坏
fail-closed/skills 派生允许集锁步 + boot 自愈)、`gen-skill-paths.test.ts`(允许集注入门
fail-closed)、`ext-install-planner.test.ts`(fail-closed ledger commit:逐类型写前门/根只读事务失败零
残留/损坏账本写前拒绝/v1-only 双查/authorize 暂停零权威副作用/v1 锁步派生;#378 退出条件
组:四类首装 authorize 生产入口、cloud 卸载双清与 desiredState 继承、plugin 更新失败旧版
健康、MCP 密钥版本化轮换)、`alpha-mcp-secrets.test.ts`(版本化原语)、
`ext-config.test.ts` / `ext-fs-installer.test.ts` / `alpha-environment.test.ts`
(eager v1 下线后的层级契约 + strict 读真实实现)、`ext-project-adopt.test.ts`
(adoption 矩阵:纯文本收编/幂等不重写 env/scope 不符 retained/损坏零改动/busy 可重试/
零存量零副作用/触发面源文本合同)。
