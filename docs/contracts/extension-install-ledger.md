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
- **generation/bundle** 归事务引擎 `commitReceipt`(写失败即事务失败,#336/#310/#311)。

## 2. 提交面 fail-closed(#336 残留收口)

非 generation 单装(mcp / plugin / agent / cloud)的 `upsertRecordV2` 失败 = **安装失败**:

- planner 审计事务 `commit` 只发生在账本提交成功后;失败走 `rollback`。
- 失败时先按**账本整文件前像**复原(`upsertRecordV2` 对损坏账本会 quarantine 再重写,
  只复原目标 record 保护不了其它条目;前像取不到(非 ENOENT)= 写前拒绝,零副作用),
  再按类型补偿副作用;补偿结果并入失败原因(补偿不完整仍 `ok:false`,留可诊断事实)。

## 3. 按类型的补偿边界(补偿必须可证明)

| 类型 | 写前门 | 提交面失败补偿 |
|---|---|---|
| mcp | strict 叶前像(不可读/形状异常拒)+ strict 密钥快照(取不到拒) | `restoreMcpLeaf(前像)` + 密钥快照 restore;discard 只在提交成功后 |
| plugin npm | 有账拒(更新 = #352 原子替换);`changed:false` 无账 = 拒绝认领未策展 | `removePluginEntryExact(本次钉版)` |
| plugin vendored | 有账拒;无账既有目录拒(不覆盖/不认领) | 撤路径条目 + 删本次目录(fresh 已证明) |
| agent | 有账或文件在场一律拒(无更新链) | `removeFsInstall`(fresh 已证明,整撤安全) |
| cloud | — | 无副作用,仅账本前像复原 |

MCP 重装是产品流(确认框重装),走前像复原而非拒绝;plugin 更新链的原子替换归 #352;
agent 的覆盖更新在产品上不存在(`updateEntry` 不支持 agent),故拒绝无回归。

## 4. 证据

`ext-install-planner.test.ts`(fail-closed non-generation ledger commit:逐类型写前门/
补偿/成功路径 discard 时序/账本前像拒绝/cloud 零补偿/v1 锁步派生)、
`ext-config.test.ts` / `ext-fs-installer.test.ts` / `alpha-environment.test.ts`
(eager v1 下线后的层级契约)。
