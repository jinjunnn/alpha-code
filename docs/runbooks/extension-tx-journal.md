---
title: Extension transaction journal diagnosis
kind: runbook
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-15
review_after: 2026-10-15
---

# 扩展事务 journal 诊断

扩展安装/卸载/回滚是 journaled 事务(REQ-100):journal 位于
`<环境根>/ext-tx/journal/<txId>.json`,终态 = `committed` / `rolled-back` /
`aborted` / `uninstalled`。启动期与**每次写操作前**(#347 恢复 gate)`recoverExtensionTransactions` 把非终态
journal 收敛到终态;收敛不了的**如实保留**,绝不静默终态化(#346 修掉了
两处「缺恢复接缝仍标终态」的谎报点)。

## 非终态 journal 的含义与自动处置

| 现象 | 含义 | 自动处置 |
| --- | --- | --- |
| `uninstalling`(action=generation/config) | 卸载中途崩溃/某步失败 | 启动或下一次相关写操作前幂等前滚(删净 artifact → 删账 → 终态) |
| `switching`/`switched` | 安装/回滚在 health/receipt 确认前中断 | probe 重验:健康前滚落账,不健康回滚+隔离 |
| `staging`/`staged`/`materialized` | switch 未发生 | 清 staging 残留,journal → `aborted`(可重试) |

## 需要人工诊断的保留态(自动恢复**不会**碰)

以下情形 journal 保持非终态并在每次恢复日志(`[req100-tx-recovery]`)重复报告:

- **不可解析 journal**:被移动为 `<txId>.json.corrupt-<ts>` 留证;
- **畸形 journal**:空/多 item、非法 key、非法 genId、意外 state;
- **未知 uninstall key**(如 kind 不在 skill/agent/mcp/plugin/cloud):
  账本删除接缝抛错保留;
- **owned path 删不掉**(EACCES/EBUSY):修复文件权限后,下次启动或下一次相关写操作自动收敛。
- **不可解析 journal 被隔离的那一轮**:该轮写操作被拒(证据移 `.corrupt-*`);下一轮重试即放行。

处置步骤:

1. 读 journal 与恢复日志,确认 txId、key、state、reason;
2. 环境性问题(权限/占用)→ 修复后重试写操作(或重启),前滚自动完成;
3. 真正畸形/未知的 journal → 人工核对 live 状态(config/store/账本三面)
   一致后,把 journal 文件移出 `journal/` 目录留档(不要删除;显式
   quarantine/retire 通道在案 → #375);
4. 任何时候都**不要**手工改账本(`installs.json`)—— 用卸载/安装通道重放。

## 边界

- v2 账本 IPC 写方以恢复结果为准入门(#347);非终态 journal 在场时相关
  操作会被如实拒绝,不是故障,是 fail-closed。
- 本 runbook 只覆盖诊断;journal 结构演进与恢复语义归引擎
  (`packages/ui-mac/src/main/ext-transaction.ts` 头注)。

## plugin 原子替换的恢复形态(REQ-099 #352)

替换 = 单 item config 事务(`plugin--<name>`,action=config)。崩溃窗口与处置:

- **journal 未达 committed**:启动恢复按整文件 before-image 回滚 config —— 旧插件条目原样,
  账本未动;vendored 情况下已 staging 的 `plugins/<name>@<hex>` 新目录成为无引用孤儿(无害,
  可手工清理;它不在 GC mark 根上)。
- **journal 已 committed、receipt 前滚**:恢复重放 `commitReceipt` —— `upsertRecordsV2` 对同
  `transaction.id` 且事实一致的重放**幂等**(不递增 generation);同 id 但事实不一致 = 账本被
  外力改写,前滚显式失败并保持 journal 非终态,按本 runbook 顶部的损坏处置流程人工核对。
- **提交成功、旧 vendored 目录 GC 前崩溃**:旧目录成为无引用孤儿(config 已指向新 versioned
  目录),安装功能不受影响;出现于 `plugins/` 下 `<name>`(旧式)或 `<name>@<hex>`(versioned)
  且不被当前 config/账本引用的目录即孤儿,可安全删除。
