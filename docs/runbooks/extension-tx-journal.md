---
title: Extension transaction journal diagnosis
kind: runbook
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-16
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
| `switching`/`switched` | 安装/回滚在 health/receipt 确认前中断 | probe 重验:健康前滚落账,不健康回滚+隔离(generation 隔离;config/file 按 image 回旧) |
| `staging`/`staged`/`materialized` | switch 未发生 | 清 staging 残留,journal → `aborted`(可重试) |

## 需要人工诊断的保留态(自动恢复**不会**碰)

以下情形 journal 保持非终态并在每次恢复日志(`[req100-tx-recovery]`)重复报告:

- **不可解析 journal**:被移动为 `<txId>.json.corrupt-<ts>` 留证;
- **畸形 journal**:空/多 item、非法 key、非法 genId、意外 state;
- **未知 uninstall key**(如 kind 不在 skill/agent/mcp/plugin/cloud):
  账本删除接缝抛错保留;
- **owned path 删不掉**(EACCES/EBUSY):修复文件权限后,下次启动或下一次相关写操作自动收敛。
- **不可解析 journal 被隔离的那一轮**:该轮写操作被拒(证据移 `.corrupt-*`);下一轮重试即放行。

## 处置流程(#375:显式诊断 + retire 通道)

1. **诊断(只读)**:`ext-journal-retained-list` IPC(main-owned;global dev/prod/beta 三根
   恒聚合,projectDir 可选)列出保留态 journal —— 每项带 entryId(定位符)、txId(体内不一致
   时 bodyTxId 并列)、op/state/keys、reason(结构畸形 = `structure`,运行期依赖 = `state`)、
   **fingerprint(journalSha256 + bytes)**、firstSeenAt(标 birthtime/mtime 来源)、
   `markDigestCount`(该 journal 提供的 CAS mark 数)、`stagingPresent`;另列既有
   `.corrupt-*` 留证件与 retire 崩溃残留(`retire-incomplete`)。
2. 环境性问题(权限/占用)→ 修复后重试写操作(或重启),前滚自动完成 —— **能自愈的绝不 retire**;
3. 真正畸形/不可诊断的 journal → 人工核对 live 状态(config/store/账本三面)一致后,走
   **`ext-journal-retire`**(显式确认通道):
   - 请求以 **entryId + journalSha256** 定位(诊断到确认之间文件被替换 = 指纹失配拒,重新诊断);
   - 必须显式 `liveStateChecked: true` 与 `casMarkRemovalAcknowledged: true`(retire 移除该
     journal 的 CAS mark;老于宽限窗的孤立 blob 可在**下一轮 GC 被删** —— 宽限窗按 blob mtime,
     不从 retire 时刻重起算)+ 非空 note(进审计 receipt);
   - 通道持 root Bundle 锁(与事务/恢复/GC 互斥),锁内先做最后一轮收敛,收敛掉的如实拒绝;
   - journal 被 **rename 到 `ext-tx/journal-retired/`**(原字节保留,绝不删除),两阶段审计
     receipt(prepared → retired)同目录留档;中途崩溃可判定:下次 retire 操作自动调和
     (dest 在场补记 retired;源仍在场记 abandoned),诊断面把残留列为 `retire-incomplete`;
   - **staging 残留不处置**:journal 移走后 `ext-tx/staging/<txId>`(若在)成为无限期人工证据,
     recovery 不再收敛它;其中 config/file 前像可含 0600 敏感内容,检视后自行决定留存;
4. 任何时候都**不要**手工改账本(`installs.json`)—— 用卸载/安装通道重放;retire 只处置
   journal 文件本身,live 状态修复仍走既有安装/卸载通道。

## 边界

- v2 账本 IPC 写方以恢复结果为准入门(#347);非终态 journal 在场时相关
  操作会被如实拒绝,不是故障,是 fail-closed。
- 本 runbook 只覆盖诊断;journal 结构演进与恢复语义归引擎
  (`packages/ui-mac/src/main/ext-transaction.ts` 头注)。

## agent(file+config)事务的恢复形态(REQ-102 #358;#361 起 catalog agent 同载体同形态)

agent 安装(seed 与 catalog remote/builtin 同走 `installAgentFromCas`)= 双 item 单事务:
file item(`agent--<name>`,action=file,写
`<root>/agents/<name>.md`)+ config item(`agent--<name>--config`,action=config,写
`agent.<name>` 叶)。journal 的 file 段记
`relTarget/slot/pre-next digest/preAbsent/requireAbsent/applied`(内容在受保护 staging
0600;`applied` 在 apply 前紧邻持久化 = 逐 item 进度)。崩溃窗口与处置:

- **switching/switched 中断**:恢复按逐 item 翻转判定(file = **本事务已 applied ∧** live
  digest == nextDigest —— 只看 digest 会把旁路植入的同 digest 文件误认本事务输出;#358 时代
  的 legacy journal 无 requireAbsent/applied 字段,按其发布时语义退回纯 digest 判定;
  config = live digest == nextDigest)—— 全翻转 ∧ probe 健康(live md digest +
  `agentMdToEntry` 可解析 + config 叶与 md 严格一致)∧ receipt 可重放 → 前滚 committed;
  部分翻转或健康未知 → 双向回滚(file 恢复**缺席态或旧字节** —— `preAbsent` 区分缺席与
  零字节,config 整文件 before-image 回旧;`requireAbsent` 且未 applied 的目标若 live 在场
  = 窗口植入证据,不 unlink,保留非终态)。
- **旁路改写**(live md 既非 pre 也非 next;在线回滚与崩溃恢复同语义):恢复 fail-closed
  保留现状,**journal 保持非终态**(写方 gate 继续阻断相关写操作,**包括卸载**),绝不
  盲目覆盖也绝不宣称 rolled-back;config 项已幂等回旧(下轮 noop)。处置顺序:先人工核对
  live md / config 叶 / 账本三面一致,**再走 `ext-journal-retire` 通道**把该 journal 退役
  (解除 gate 阻断)——**绝不手工把 journal 移出 `journal/`**(会绕过 Bundle 锁/fingerprint/
  CAS mark 确认/prepared receipt,可能与恢复并发);retire 完成后才经安装/卸载通道重放收敛。
- **staging 丢失 / journal file 段非法 / 圈禁不过**(恢复期无法重建 file image)= 失据:
  **零改动、journal 保持非终态**供重试或人工处置 —— 失据时不做任何回滚(盲回滚可能毁掉
  唯一的完好侧),也不终态化(终态化会同时留下半装态并解除写方 gate 的阻断)。

## plugin 原子替换的恢复形态(REQ-099 #352)

替换 = 单 item config 事务(`plugin--<name>`,action=config)。崩溃窗口与处置:

- **journal 未达 committed**:启动恢复按整文件 before-image 回滚 config —— 旧插件条目原样,
  账本未动;vendored 情况下已 staging 的 `plugins/<name>@<hex>` 新目录成为无引用孤儿(无害,
  可手工清理;它不在 GC mark 根上)。
- **journal 已 committed、receipt 前滚**:恢复重放 `commitReceipt` —— `upsertRecordsV2` 对同
  `transaction.id` 且**身份事实**一致的重放**幂等**(纯重放批零写盘、不递增 generation;
  `desiredState/updatedAt` 是合法可变归属字段,不算冲突,重放保留后到变更)。同 id 但身份
  事实(版本/digest/configKey 等)不一致 = 账本被外力改写:前滚 `commitReceipt` 显式失败,
  **引擎按回滚路径终态化该 journal(rolled-back,config 回旧)**,而被改写的 receipt 会
  保留在账 —— 此时 config 与账本分叉,不会再自动收敛,按本 runbook 顶部的损坏处置流程
  人工核对(这是「txId 被冲突重用」的防伪保守面,预期极罕见)。
- **提交成功、旧 vendored 目录 GC 前崩溃**:旧目录成为无引用孤儿(config 已指向新 versioned
  目录),安装功能不受影响;出现于 `plugins/` 下 `<name>`(旧式)或 `<name>@<hex>`(versioned)
  且不被当前 config/账本引用的目录即孤儿,可安全删除。

## plugin seed 的残留形态(REQ-102 #359)

seed plugin 的载荷是同一事务里的 file items,落点 = 内容寻址目录
`plugins/<name>@<digest16>`(#352 的随机后缀 stager 不用于 seed;无锁外 staging → 无 tmp
目录残留)。残留识别与处置:

- **孤儿判定**:目录不被当前 `alpha.jsonc` `plugin[]` 与账本 `configKey` 引用即孤儿(来源
  只有两类:replace 提交成功后旧目录 GC 失败 warning 留下的旧目录;回滚后未收干净的空壳
  子目录),可安全删除;它不在 #318 CAS GC 的删除面上,不会被自动回收。
- **含文件的目录 + 非终态 journal 在场**:那是失据/旁路改写保留的现场证据 —— 按顶部保留态
  流程处理,**不要**先删目录。
- **fresh 安装被「exists without a ledger record」拒**:目标内容寻址目录被外部放置/历史残留
  占用 —— 核对无账后手工删除该目录再重试(未策展不认领,绝不静默覆盖)。

## MCP 密钥版本目录的残留形态(REQ-100 #378)

单装/未策展 MCP 的密钥自 #378 起写入版本化布局
`<userData>/alpha-mcp-secrets/<server>/<verId>/<VAR>`(verId = `v-<hex16>`(接受 8-16 位 hex 存量),只增不覆盖;
完整合同见 `docs/contracts/extension-capability-authorization.md` §9)。残留识别与处置:

- **孤儿判定**:版本目录内没有任何文件被当前 `alpha.jsonc` `mcp.<server>` leaf 的 `{file:}`
  引用即孤儿(来源:安装失败/authorize 暂停清理失败、崩溃于提交前、提交后旧版本 GC 失败
  warning)。安装成功路径会在配置写锁内自动 GC(未引用 + mtime 超 10 分钟宽限),一般无需
  人工;要手工收时先核对当前 leaf 引用,再删未引用版本目录。**宽限期内的新目录不要删**——
  可能是「文件已写、config 尚未提交」的在途安装。
- **legacy flat 文件**(`<server>/<VAR>` 直挂):存量安装与 env 迁移的合法布局,被当前 leaf
  引用时绝不可删;不再被引用后由同一 GC 收。
- **卸载**:journaled 卸载会删除整个 `<server>` 目录(全部版本 + flat),无需按版本处置。
