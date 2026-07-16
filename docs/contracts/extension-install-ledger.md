---
title: Extension install ledger ownership and fail-closed commit
kind: contract
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-16
review_after: 2026-10-14
---

# 扩展安装账本契约(REQ-100 #354)

本文钉住 `<root>/installs.json`(v1 receipts + v2 records 同文件双视图)的**写方所有权**
与 catalog 安装提交面的 fail-closed 语义。账本机制归 `ext-receipt-v2.ts`,提交面编排归
`ext-install-planner.ts`,未策展协调归 `ext-uncurated-record.ts`(#306)。

## 1. 写方所有权(单一账本真源)

- **catalog 安装**的账本写方 = planner 提交面的 `upsertRecordV2`(单次写盘,v2 record 与
  派生 v1 receipt 锁步)。installer/config 层的 eager v1 兜底(persistMcp /
  persistPluginUnlocked / persistPluginPathUnlocked / recordReceipt catalog 分支)已随
  fail-open 一并**下线**——不存在「v2 失败但 v1 已写」的合法状态。
- **未策展安装**归 orchestrator(`recordUncuratedInstall`,#306):mutate → 单次账本写 →
  失败补偿并 fail-closed。
- **generation/bundle/agent-seed** 归事务引擎 `commitReceipt`(写失败即事务失败 → 引擎
  回滚,#336/#310/#311/#358)。agent seed(#358)的账本形态:**单条** v2 record(kind
  `agent`,`configKey: agent.<name>`,`files: [<root>/agents/<name>.md]`),receipt 模板
  只挂事务的 file 主 item —— config 副 item 不落账,`commitReceipt` 按 `receipt !== undefined`
  过滤。

## 2. 提交面 fail-closed(#336 残留收口)

非 generation 单装(mcp / plugin / agent / cloud)的 `upsertRecordV2` 失败 = **安装失败**:

- planner 审计事务 `commit` 只发生在账本提交成功后;失败走 `rollback`。
- **损坏/不可读账本在任何副作用之前被拒绝且原文件不动**(`probeLedgerForWrite`;quarantine
  不是提交路径)。由此健康账本 + 原子写失败 = 磁盘零变化 —— 提交面**不做**整文件恢复:
  恢复步骤本身才是跨进程覆盖竞态与「恢复后补偿再改账」的来源。残余界限(诚实声明):
  写前探测与 upsert 之间若有绕过受控写体系的外部写方把账写坏,upsert 仍会 quarantine
  该损坏文件再写新账 —— 旧字节保留在 quarantine 供诊断,不静默丢失。
- 失败时按类型补偿副作用;补偿结果并入失败原因(补偿不完整仍 `ok:false`,留可诊断事实
  —— 密钥恢复失败留 `.bak` 取证,vendored 目录删除失败如实上报)。

## 3. 按类型的补偿边界(补偿必须可证明)

| 类型 | 写前门 | 提交面失败补偿 |
|---|---|---|
| mcp | strict 叶前像(不可读/**语法损坏**/形状异常拒 —— jsonc 容错解析必须收 ParseError)+ strict 密钥快照(取不到拒) | `restoreMcpLeaf(前像)` + 密钥快照 restore(失败留 `.bak` 并上报);discard 只在提交成功后 |
| plugin npm | 有账拒 —— 覆盖 v2 record **与 v1-only receipt**,且按 `entry.name` 与历史规范化名 `pluginRecordName(package)` 双查(更新 = #352 原子替换);`changed:false` 无账 = 拒绝认领未策展 | `removePluginEntryExact(本次钉版)` |
| plugin vendored | 有账拒(同双查);无账既有目录拒(不覆盖/不认领) | 撤路径条目 + 删本次目录(fresh 已证明;删除失败如实上报) |
| agent(catalog 单装) | 有账(v2/v1)、有 md 文件、或有手工 `agent.<name>` 配置项(strict 读,不可读按在场)一律拒(无更新链) | `removeFsInstall`(fresh 已证明,整撤安全) |
| agent(seed,#358) | 同上 fresh-only,但在**引擎锁内 precondition** 重读(封锁外 TOCTOU;md 检查含 legacy `agent/` 单数目录,config 不可读 fail-closed) | 引擎回滚(file 前像恢复缺席/旧字节 + config 叶复原),无 planner 手工补偿 |
| cloud | — | 无副作用 |

MCP 重装是产品流(确认框重装),走前像复原而非拒绝;agent 的覆盖更新在产品上不存在
(`updateEntry` 不支持 agent),故拒绝无回归。

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

## 5. 证据

`ext-install-planner.test.ts`(fail-closed non-generation ledger commit:逐类型写前门/
补偿/成功路径 discard 时序/损坏账本写前拒绝/v1-only 双查/补偿失败可观察/cloud 零补偿/
v1 锁步派生)、`ext-config.test.ts` / `ext-fs-installer.test.ts` / `alpha-environment.test.ts`
(eager v1 下线后的层级契约 + strict 读真实实现)、`ext-project-adopt.test.ts`
(adoption 矩阵:纯文本收编/幂等不重写 env/scope 不符 retained/损坏零改动/busy 可重试/
零存量零副作用/触发面源文本合同)。
