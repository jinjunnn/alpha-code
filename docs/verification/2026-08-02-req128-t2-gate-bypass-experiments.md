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
`bun test src/main/claude-plugin-install.test.ts`。**绿基线:R1 前 26 pass / 0 fail,R1 三条修完后 29 pass / 0 fail。**

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

## Codex R1 之后补的三条(2026-08-02)

对抗审计 R1 开出 2 Major + 1 Minor,全部采纳。三条各自补了闸,并各自实施了一次绕过。

| 闸 | 改坏了什么 | 结果 |
| --- | --- | --- |
| **G3 的 mode 语义** | 把 T1 自包含判定里**可执行位那一臂删掉**(模拟「拒绝有洞」),并给夹具的 `scripts/fetch.py` `chmod 0755` | **1 fail**:源侧 `exec: true`,装完 `exec: false` |
| **G4 的 v1 那一臂** | `uncuratedSkillFreshGate` 里 `lookup.status === "v1"` 去掉,只留 `"valid"` | **1 fail**;**修复前同一变异 = 26 pass / 0 fail**(那半边确实从没被执行过) |
| **CAS warning 透传** | 成功结果只并 `result.warnings`,丢掉 `casWarnings` | **1 fail**:`warning` 为空串 |

### G3 mode —— 它兜的到底是什么

载荷经 CAS 物化用的是**不带 mode** 的 `fs.writeFileSync`(`ext-cas.ts:267-279`),`TxFileSpec`
里也**没有 mode 这一栏** ⇒ 执行位在这条路上**结构性地传不过去**。今天这件事到不了:owner 裁决 A
让 T1 在**预览期**就把带可执行位的技能具名拒绝了。**正因为如此这道比较才要立** —— 它是那道拒绝
万一有洞时的兜底,不是主防线。变异后的原文:

```
-     "exec": true,
+     "exec": false,
(fail) G3 载荷完整 > 多文件技能装完之后,generation 目录与源目录逐条相等
```

比的是「任一 x 位」而不是原始 mode 数字:umask 与源文件 0600/0644 的差异不是语义,
「这个文件能不能执行」才是。另有一条**单独钉住**「装完的文件一个都没有执行位」的用例 ——
只写「与源相等」的话,源侧哪天也被放行成可执行,两边会一起变绿。
(这条在上面那次变异里**照样是绿的**,而且这是对的:已批准策略就是「装完不带执行位」。
两条各管一个方向,不是重复。)

### G4 v1 —— 「闸门被替换掉一半也不会红」的实测

生产闸同时查 v1 与 v2(`ext-install-planner.ts:2640`),而原来的四个负向夹具**全是 v2**。
把 v1 那一支删掉之后,**修复前的测试文件 26 pass / 0 fail** —— 也就是说那半边从来没有被执行过。
补上真 v1-only 账本夹具(`addReceipt`,origin 刻意**不是** catalog:catalog 的 v1 receipt 会先被
`checkUncuratedConflict` 的另一条分支拦下,那样又绕开了 v1 这一臂)之后:

```
Expected: false
Received: true
(fail) G4 > 负向夹具②b:**v1-only 存量** receipt(非 catalog 来源)⇒ 整次拒绝,账本原文与磁盘不变
```

`Received: true` = 本地包**静默认领**了用户既有的那份技能。

### CAS warning —— 没有另发明通道

`#765` 之后,呈现的咽喉在 renderer 的 `extIpc` 包装层:凡返回值带具名 `warning` 就统一推 toast。
所以 main 侧的责任只有一条 —— **把它挂在既有的 `warning` 字段上**,与单技能生产路径
(`ext-install-planner.ts:2668`)逐字同形(立刻 loud log + 并入成功结果)。夹具用「在店 blob 损坏」
(真实可达:盘损坏 / 半写),promote 自愈并 loud 报一条:

```
Expected to contain: "was CORRUPT on disk"
Received: ""
(fail) CAS 提升的 warning 走到成功结果的 `warning` 上,不被静默丢弃
```

## 三条本轮没有以绕过实验覆盖的事

- **G13 的「事务函数零调用」**用的是「零 journal 目录」这个可观察产物,不是 spy 计数。
  两者的区别:引擎在拿到锁之后才写 journal,所以「零 journal」证明的是「没有走到写盘」,
  不是「函数一次都没被调用」。这是有意的取舍(不为测试给生产入口加注入面),**写在这里而不是
  写成「等价」**。
- **G6 / G8② / G19 / G20** 属于 `#782`(通道)与 `#784`(renderer)的边界,本票不立。
- **打包真机**(装 → 显示未启用 → 用户启用 → 下一条消息里技能真被引擎注入)归 `#783` 的 L2。
