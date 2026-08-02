---
title: REQ-128 Phase 3 T2 —— 每道闸的绕过实施记录
kind: verification
owners:
  - alpha-code extension maintainers
last_reviewed: 2026-08-02
review_after: 2026-11-02
---

本地 Claude 插件包安装(`packages/ui-mac/src/main/claude-plugin-install.ts`,`#781`)立的每一道闸,
都在本机**实际实施了一次绕过**并记录了它变红的原文。方案基线
[REQ-128 Phase 3](../design/2026-08-02-req128-phase3-local-claude-plugin-import.md) §6 首句:
**写不出绕过配方的闸判为假闸,不许留在表里充数。**

实施纪律:每次实验前 `git status` 干净(实现已 commit),实验后只 `git checkout -- <被改的那一个文件>`。
基线树 = `feat/781-plugin-install` 的实现提交;每次只改一处生产代码,跑
`bun test src/main/claude-plugin-install.test.ts`。**绿基线 = 26 pass / 0 fail。**

| 闸 | 改坏了什么(生产代码) | 结果 |
| --- | --- | --- |
| **G15** 四集双射 | 图的 children 由 `accepted.slice(1)` 改成 `accepted.slice(2)`(少一个节点,item 照留) | **5 fail**;闸在调事务**之前**拒绝,原文见下 |
| **G3** 载荷完整 | `specsByKey` 只留 `SKILL.md`(= `buildSkillTxItems` 的形状,files 与 populate 同时收窄) | **1 fail**:安装**成功**,而 generation 目录比源目录少 3 个文件 |
| **G1** 原子性 | `installLocalClaudePluginV1` 改回「一个技能一个事务」的 `for` 循环 | **8 fail**,含「生产入口:N 条 record 携带的是**同一个** transactionId」 |
| **G2** 分组不可绕 | 把 `packageMutation` 从 root item 上摘掉 | **6 fail**;`uninstallByKey` 对包内技能返回 `ok: true`(被静默卸掉) |
| **G4** 复用既有 fresh 闸 | 换成自制的「只查账本 record」替身 | **5 fail**:flat 目录 / 残留 generation store / catalog 同名 / 并发 / 整次零写 |
| **G4b** 锁内重验 | 删掉 `hooks.precondition`,只留锁外预检 | **1 fail**:并发夹具(preview 之后、拿到锁之前被占名)变红 |
| **G7** 引擎授权闸 | 计划里预塞一份「全部确认」的 `authorization` | **1 fail**:capabilities 非空时安装**照样成功**,不再停在 authorize |
| **G10** 默认关 | 从 `shared/ext-install-policy.ts` 删掉 `localPackage` 判别维 | **3 fail**:落账变回 `enabled` |
| **G13** 零组件终态 | 去掉两处「预览不可装即拒」,让 0 组件也去建 mutation | **1 fail**:不再是具名终态 |
| **G14** root 是真技能 | root 换成合成的 `kind:"plugin"` 节点 | **5 fail**;被 G15 在写盘前拦下(合成 root 不在预览可装集里) |

## G15 —— 被拒绝时用户看到的原文

```
{
 "ok": false,
 "code": "bijection-mismatch",
 "reason": "拒绝安装:包图节点集与预览可装集不一致(skill:postmarket,skill:riskscan ≠ skill:postmarket,skill:premarket,skill:riskscan)——这会让账本里出现一条不属于任何扩展包的记录,整包移除之后它还留在盘上"
}
```

## G2 —— 这条记录是「我们没长出第二套包语义」的硬证据

摘掉 `packageMutation` 之后,claim 集合为空 ⇒ `ensureStandaloneClaims` 早返回 ⇒
`directUninstallVerdict(null)` 返回 `delete` ⇒ 包内单个技能被**既有的** `ext-uninstall-v2`
静默卸掉。实测原文:

```
402 |     const refused = await uninstallByKey({ type: "skill", name: "postmarket", scope: "global" }, plannerDeps(calls))
403 |     expect(refused.ok).toBe(false)
error: expect(received).toBe(expected)
Expected: false
Received: true
(fail) G2 分组不可绕:包内单个技能走既有卸载路径必须被拒
```

也就是说:**分组语义完全由 V3 账本的那一份 claim 提供**,本票没有另写一套「这个组件属于哪个包」
的判据。挡住直接卸载的是既有的 `planDirectUninstall` / `directUninstallVerdict`,不是新写的检查。

## G3 —— 「装得上、能启用、引用的文件全没了」长什么样

按 `buildSkillTxItems` 的形状收窄之后,安装、账本、探针全绿,只有对**源目录独立扫描**的比对变红:

```
- Expected  - 15
+ Received  + 0
(fail) G3 载荷完整:比较基准是对源目录的独立扫描 > 多文件技能装完之后,generation 目录与源目录逐条相等
```

15 行 = 3 个文件对象(`references/deep/notes.md`、`references/glossary.md`、`scripts/fetch.py`)。
把比较基准换回 `collectImportSkillPayload().files[]` 会让这条**恒绿** —— 那是拿实现自己拼的
等价链当断言,凡采集器静默丢掉的结构上永远不会红。

## 三条本轮没有以绕过实验覆盖的事

- **G13 的「事务函数零调用」**用的是「零 journal 目录」这个可观察产物,不是 spy 计数。
  两者的区别:引擎在拿到锁之后才写 journal,所以「零 journal」证明的是「没有走到写盘」,
  不是「函数一次都没被调用」。这是有意的取舍(不为测试给生产入口加注入面),**写在这里而不是
  写成「等价」**。
- **G6 / G8② / G19 / G20** 属于 `#782`(通道)与 `#784`(renderer)的边界,本票不立。
- **打包真机**(装 → 显示未启用 → 用户启用 → 下一条消息里技能真被引擎注入)归 `#783` 的 L2。
