---
title: Extension install ledger ownership and fail-closed commit
kind: contract
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-08-03
review_after: 2026-10-14
---

# 扩展安装账本契约(REQ-100 #354)

本文钉住 `<root>/installs.json`(v1 receipts + v2 records 同文件双视图)的**写方所有权**
与 catalog 安装提交面的 fail-closed 语义。账本机制归 `ext-receipt-v2.ts`,提交面编排归
`ext-install-planner.ts`,未策展协调归 `ext-uncurated-record.ts`(#306)。

> ## ⚠️ ADR-040(2026-08-03,`#825` 已落地):plugin 的**安装与启用**整段作废
>
> **Alpha 的扩展安装唯一形态是 Bundle;任何扩展安装都不得写入引擎的 `plugin[]`。**
> 本文中一切描述「plugin 怎么装进去」的段落 —— npm fresh、vendored fresh、`installPluginFromCas`、
> §3.1 的原子替换、以及启停投影的 **enable 臂**(「按 configKey 补回受管条目形态」)——
> **都已随生产代码退场**,保留在此仅作历史脉络。
>
> **今天仍然成立的**只有 plugin 的**减法**半场:启停投影的 disable 臂(从 `plugin[]` 移除)、
> 卸载(`removePlugin` / `removePluginPath`)、dangling 清扫、以及 boot reconcile 里
> 「disabled plugin 移不掉 = `enforcementGap` 阻断 sidecar」那条(§ 启动 reconcile 原样有效)。
> **plugin 的 enable 现在是具名拒绝**:「启用」按定义就是把 spec 写回 `plugin[]`,与安装是同一件事。
>
> 咽喉在 `packages/ui-mac/src/main/engine-plugin-seal.ts`:**三族**物理写原语
> (`ext-config.ts` 的原子提交、`ext-config-tx.ts` 的 image 对、boot reconcile 的整文件写)在写盘前
> 判「`plugin[]` 有没有多出写之前没有的元素」,有则拒 —— **新增写入点不需要登记就已经被挡住**。
>
> `#832`(2026-08-03)关掉了 `#825` 留下的最后一个结构性绕开口:boot 期 reconcile 曾经自己
> `writeFileSync+rename` 整个 `alpha.jsonc`,三道白名单一道都不过,而它每次启动都跑。处置是两件事:
> ① `planConfigMerge` 里「legacy `plugin[]` 并集」删掉(本 portfolio 无真实用户 ⇒ 无 legacy 迁移
> 义务;而「来源是用户旧配置」不改变「以引擎同等权限执行的第三方 JS」这个事实);② 那次整文件写盘
> 改调 `ext-config` 的同一个原子提交点。
>
> **边界要说清(实读枚举过,不是推断):咽喉不是唯一的守门人。** 不过这道咽喉的写还有四条,
> 各自靠**另一道**闸 —— 谁在挡比路径本身重要:
>
> | 不过咽喉的写 | 真正挡住 `plugin` 的是什么 |
> | --- | --- |
> | `ext-config.ts` `applyBuiltinPolicyEditsUnlocked`(自己的 tmp+rename 写 `alpha.jsonc`) | `builtinPolicyPathAllowed` 具名路径白名单(只放 `agent` / `permission.skill` / `command` 叶子,`plugin` 不是合法首段,落盘前逐条判) |
> | `alpha-config-injection` | 只在真源**缺席**时 seed 字面量 `{$schema}`,内容里没有 `plugin` 键 |
> | `alpha-migrate` legacy 臂 | 目标是 legacy `opencode.jsonc`,只做减法,且要 `ALPHA_MIGRATE_ENABLE=1` |
> | **`ecosystem-import.ts` `registerProjectSkillsPath`**(整文件写**项目级** `<proj>/.alpha/alpha.jsonc`) | **它自己没有任何白名单**;挡住 `plugin` 的闸在另一个包:`packages/ext/src/project-config.ts` 的 `mergeProjectConfig` 只合 `mcp`(信任门)/`agent`/`command`/`skills.paths`。同族的 `packages/ext/src/register.ts`(引擎进程侧整文件序列化同一文件)靠 `RegisterType` 类型白名单 |
>
> 最后一行是 `#832` 审计补上的,也是唯一一条「今天只写 `skills.paths`」属于**恰好**而非被挡:实测在
> `registerProjectSkillsPath` 里加一行 `cfg.plugin=[…]`,盘上当场多出该条目而咽喉用例全绿;同一份文本
> 喂 `mergeProjectConfig` 则 `added` 只有 `["skills.paths"]`、`cfg.plugin === undefined`。
> **今天没有洞,但功劳不是咽喉的,两道闸之间也没有任何东西把它们和 ADR-040 连起来。**
> 随之而来的一格新 fail-closed:盘上的 `alpha.jsonc` 语法坏掉、而容错解析仍读得出 `plugin` 条目时,
> reconcile **整次不写盘**(loud,`bailedOut` 带咽喉理由,`~/.opencode` 也不清理)—— 因为「写完之后
> 没多出元素」在那种输入上证不出来。坏文件原样留给用户,不被改写。
>
> 权威见 `.claude/rules/adrs/ADR-040-extension-package-taxonomy.md` §决策三。

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
  **enable 方向的 catalog 解析两路分明(`#817`)**:legacy catalog record(V3 图/claim 两个 package
  信号都不在场)照旧解析 legacy `entries[]` 的 exact 条目(id/kind/name/version 精确对应 + #397
  curation 消费);**signed package child** 以一次有效 V3 state 分类 —— 任一 packageGraph 节点命中
  `(kind,name)`,或该 `(kind,name)` 的 claim 含 `bundle:` owner,任一成立即 package-managed ——
  先要求 exact graph/record 身份(节点 `componentId===record.id ∧ manifestDigest===record.manifestDigest`),
  再按 **(packageId, 已装 record.version) 双键**解析已验 catalog `packages[]`(同 packageId 多版本可
  合法并存,禁单键 `.find`),逐项核对 envelope/component/payload/manifest digest;missing/delisted/
  security/catalog 不可得/任一 digest mismatch 一律 fail-closed,**package-managed 永不回退
  `entries[]`**;全匹配 = 诚实 uncurated,落既有保守启用面(不发明 package curation)。
  **disable 方向不咨询 catalog**(两路皆然)。
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
  边界 loud;**enforcementGap(r11 pivot 后收窄到 plugin)**:唯 **plugin disable 无法从 alpha.jsonc
  `plugin[]` 落盘**(config 写失败/非缺席读错误/非法 jsonc)= gap → 主进程 **fail-closed 阻断首个
  sidecar spawn**(dialog + `app.exit`)。mcp/agent 由下述主权注入兜底,写失败非 gap;锁忙/enable 缺
  生效面 = 非 gap(仅 warning)。escape hatch 与 REQ-059 同口径。
- **主权注入(Codex r11 定案 —— 取代 r6→r10 的 legacy 探测器)**:引擎除 alpha.jsonc 外还合并许多源
  (XDG 全局三 json + legacy TOML `config` / `~/.opencode` / 各目录 `{agent,agents}/**/*.md` + `{plugin,
  plugins}/*.{ts,js}` 自动发现 / `OPENCODE_CONFIG_CONTENT` / 项目 / managed / MDM / active-org)。**逐源探测
  = 重实现引擎整个 config 解析器,是发散的无底洞**(r7→r11 每轮暴露新源:TOML、逐目录交错序、gray-matter
  YAML、JSONC、npm 身份归一……)。改为**让 alpha 权威**:
    · **mcp/agent**:`injectDisabledOverrides`(`ext-disabled-injection.ts`)把每个 **global disabled** 记录的
      `mcp[name].enabled=false` / `agent[name].disable=true` 注入 **`OPENCODE_CONFIG_CONTENT`** —— 它在引擎
      加载序 **step 6**(所有 in-scope 源之后:XDG/~/.opencode/agent-md·plugin-script 自动发现/项目)。
      `mergeDeep` later-wins 使 alpha 的禁用**压过一切 in-scope 源**,disabled 扩展**永不被引擎加载,无需
      探测**。引擎 schema 显式允许 lone `{enabled:false}` mcp 叶(`core/v1/config/config.ts:114` 的 Union)
      与 disable-only agent 叶(全 optional)。每次 sidecar fork 从账本重算,best-effort(账本不可读 → 跳过,
      alpha.jsonc 投影仍在)。
    · **plugin**:union(`mergePluginOrigins`)**无 disable 键、无覆盖面** → 只能从 **alpha.jsonc `plugin[]`
      移除**(`computeEnableProjectionEdit`:disable 按 base 移除同 base 全部钉版;enable 按精确 spec 重建)。
      **已知边界(Codex r12 Major2,信任模型显式声明)**:plugin 的 disable **只治理 alpha 自有副本**
      (alpha 只写 alpha.jsonc);若同一 plugin 也出现在其他引擎读取源(XDG / 项目 / `~/.opencode` / 自动
      发现目录),引擎 union 仍会 import —— **本设计不防御该情形**。当前部署无用户 = 无其他 plugin 源,故
      移除即权威;若未来引入用户手写配置,须显式向用户暴露"plugin 开关仅治理 alpha 安装的副本"这一限制,
      或补 plugin 侧的运行时 enforcement。移除失败 = plugin gap(阻断 sidecar)。
    · **企业/远程源(managed dir / MDM / active-org,step 7-9,在注入之后加载)**:alpha 无法覆盖,属管理员/
      远程受控,不在 alpha 的威胁模型内(且无用户下不存在)。**文档化边界**,非 alpha 残留。
    · **账本损坏/不可读**(Codex r12 B2):sidecar 注入会拿到空 records、disabled mcp/agent 无从注入 →
      boot reconcile `probeLedgerForWrite` 检出损坏(非缺席)即 **enforcementGap 阻断 sidecar**(不放行可能
      加载已禁扩展的引擎)。缺席账本(ENOENT)= 无记录 = 安全,不阻断。
    · **command/bundle 无生效面**(Codex r12 Major3):引擎 config.command/bundle 无 disable 键、alpha 无
      投影/注入面 —— set-state 对 command/bundle/cloud 一律拒(翻 desiredState 会谎报已禁而仍可执行),
      行内/详情页开关也只给有生效面的 mcp/agent/plugin/skill。
    · **live 运行面**:引擎 `mcp.connect`/`mcp.add` 强制 `enabled:true`,当前 session 的连接是暂态;权威层 =
      注入(任何 reload 引擎必读 disabled)。安装/开关的 live 连接前经 inventoryView 复查 activation,读失败
      **fail-closed 不激活**(Codex r12 Major1:回 reload-pending,不靠"下次自愈"当安全控制);disabled 则不
      连。alpha.jsonc 的 mcp/agent 投影(set-state/boot)保留作 consistency,非 load-bearing。
- **未策展重加投影(Codex r5/r6 M1 → r11)**:`persistMcp` 对账本 disabled 的 mcp 重写叶并入 `enabled:false`
  (内容更新、状态不翻);`persistPlugin` 对 disabled 的 plugin 从 alpha.jsonc `plugin[]` 移除该 base 全部
  条目(换钉版旧 spec 不留)——无用户 = 无他源,移除即权威(不再逐源探测)。
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
  更严格态(skill 少注入 = 安全侧,boot 自愈补齐)—— **#336 如实上报**:该降级不再静默,writer
  ok 臂携带 `projectionLag` 判别字段(账本已 durable、允许集发布失败),**用户可见写入口必须呈现**
  (skill 安装/bundle/set-state 的 warning 通道),**后台入口(recovery 重放 / migration / boot)
  必须 loud log**(写点统一 `console.error`);整体仍 `ok:true`(账本才是真源 —— 改 `ok:false`
  会经 commitReceipt throw 让引擎回滚 live 与已 durable 账本分叉)。

### 5.1 warning 谁来呈现(`#765`)

上一条说「用户可见写入口必须呈现」。**那句话曾经是靠人记得**:呈现是每个调用点各写一行,
而 REQ-128 Phase 2 期间连着三次发现调用点没写 —— 六个里只有一个照做,最后一处还是闸门逼出来的
(详情页装扩展包走确认屏,压根不经过此前那个「单点出口」)。

现在呈现收在 renderer 的 **IPC 包装层**:`renderer/extensions/ext-ipc.ts` 的 `extIpc` 是生产代码
够到 `window.api.ext` 的唯一入口,凡是返回值里带一条非空 `warning` 字符串的调用,由它统一推 toast。
判据看**返回值**不看方法名 —— 明天新加的 IPC 通道默认被覆盖,不需要来这里登记。

对 main 侧写入口的要求因此没有变化(照旧把 loud 信号放进 `warning`),对 renderer 调用点的要求
则**反过来了**:不要再自己呈现一次,那会让用户读到两条一模一样的提示。复数 `warnings`
(`InstallLedgerView` / `projectResidualsCheck`)不走这条通道 —— 它们是成批清单,各有各的呈现位置。

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
零存量零副作用/触发面源文本合同)、`ext-receipt-v2.test.ts`(**#336 projectionLag 判别式:
final-publish 窄 seam 注入 —— 账本 durable 后发布失败 → ok:true + projectionLag、收窄方向不受
seam 影响、无变化不误报、boot 自愈闭环**)、`ext-uncurated-bodies.test.ts`(**#336 未策展提交面
账本写失败注入:custom MCP 前像精确复原/密钥版本清理、npm plugin removePluginEntryExact、
projectedDisabled 绕幂等短路真进落账、恰同钉版幂等零落账**)、`ext-project-residuals.test.ts`
(**#336 批处理判别位:failed 非空 → 整单 ok:false + 进度字段保留、幂等重试只补失败项**)。
