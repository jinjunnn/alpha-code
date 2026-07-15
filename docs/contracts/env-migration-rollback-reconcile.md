---
title: Environment migration receipt, rollback-era reconcile and legacy-root symlink rejection (REQ-098)
kind: contract
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-15
review_after: 2026-10-13
---

# 环境迁移 receipt、rollback 期对账与 legacy-root symlink 拒绝(REQ-098 #304)

本文钉住旧 `~/.alpha` 单根布局 → 每环境 mutable root 迁移(`alpha-env-migrate.ts`,REQ-098 T3)
的持久化 receipt schema 与 rollback 恢复语义。上游脉络:父需求 alpha-code#209(AC#3 幂等迁移、
AC#4 回滚不丢状态)、#304(rollback 期对账 + symlink 拒绝)、2026-07-14 逐需求审计
(alpha-work `governance/audits/2026-07-14-s40-s49-per-requirement-audit/REQ-098.md`)。

## 1. 不变量(红线)

| 不变量 | 语义 |
| --- | --- |
| source 只读 | 旧根绝不被修改/删除;唯一 additive 写 = `.alpha-env-rollback.json` 标记(仅初次迁移写;对账轮绝不碰旧根) |
| 不覆盖 | 环境根同名对象(**lstat 判存在**,broken symlink 也算)绝不被迁移/对账 rename 覆盖 |
| receipt 唯一权威 | `env-migration-receipt.json`(原子写 + fsync)= 迁移完成与对账基线的唯一凭证;rollback 标记只是给降级版本的告知,不是第二套账本 |
| 不引用旧根 | 环境根内不得存在指向旧根/另一环境的引用 —— 字符串通道(alpha.jsonc / installs.json 路径改写)与文件系统通道(symlink 拒绝)同一契约 |
| 防复活 | 曾被观察定序的名字,环境侧删除后不会被对账重新导入 |

## 2. receipt schema(`v: 1`,#304 additive 扩展)

原字段不变(environment/appVersion/migratedAt/sourceRoot/targetRoot/source/results/secretRefs/
pathsRewritten/warnings)。#304 变更:

- `source[].kind` / `results[].outcome` 扩展:顶层条目本身是 symlink / 非常规类型 →
  `kind: "symlink" | "special"`、`outcome: "rejected-symlink" | "rejected-special"`(记账后继续
  其余条目,不再放倒整次迁移)。
- 新增 `reconcile` 状态块(非历史数组,只承载当前基线 + 当前未解决状态):

| 字段 | 语义 |
| --- | --- |
| `baseline` / `baselineAt` / `bootstrap` | 首个可信观察,**不可变**。观察 = 每条目 `ItemObservation`:配置文件记内容 sha256(可表示 `absent`);目录记子条目「名字 + 类型 + 树指纹」(指纹 = 排序遍历 rel/kind/叶哈希,symlink 记原始 target,确定性) |
| `lastObserved` | 最近一次旧根观察 = 增量判定锚。曾出现于此的名字永久定序;导入失败的子条目**不定序**(剔除,下轮重试) |
| `lastReconcile` | 最近一次有导入的轮次(at/appVersion/imported) |
| `legacyOnly` | 当前报告:旧根有、环境根无(bootstrap 前差异 / 环境侧删除 / 别名碰撞)—— 只报告不导入 |
| `conflicts` | 当前报告:两侧同名且指纹不同(env wins,不覆盖不告警轰炸) |
| `rejected` | 被拒引用(symlink/special/导入失败),带指纹 —— 源形态变化后重新评估 |
| `unresolvedDrift` | 配置文件相对 **baseline** 的漂移(检测 ≠ 解决;基线不被漂移覆盖) |

- 读取校验:结构(v/environment/roots/results)+ **身份匹配**(environment、sourceRoot、
  targetRoot 与当前输入一致)。不匹配/损坏 → 按缺失处理,重跑迁移(逐条 already-present 自愈)。

## 3. rollback 期对账(每次启动,receipt 在场时)

1. 观察旧根五件套(指纹级)。
2. **目录子条目增量导入**:相对 `lastObserved` 新出现、且环境根无同名/无别名
   (NFC + 大小写归一,防大小写不敏感文件系统碰撞)的 file/dir 子条目 → 随机私有 staging
   (`<targetRoot>/.alpha-env-migrating/`,轮始轮末清理)守卫拷贝 → lstat 复核 → 原子 rename。
   **每成功一个子条目即原子提交一次 receipt**(resurrection 窗口收束到单个子条目:rename 与
   receipt 提交之间崩溃 + 用户恰好删除 = 已知残余窗口,记录于此)。
3. **配置文件不自动合并**:相对 baseline 漂移只记 `unresolvedDrift` + loud 日志;环境文件不动;
   旧根保持可读,用户可手工取回。
4. 状态未变 → `clean`,receipt 字节不重写(同一事实不重复告警)。
5. 对账失败只降级本轮(`reconcile-failed`,下次启动重试),**不得误报为迁移失败**。
6. **bootstrap**(存量 receipt 无 `reconcile` 块):只建基线 + 报告 `legacyOnly`,不自动导入 ——
   无基线时「rollback 新增」与「环境侧删除」不可区分,宁可少动作也不复活已删对象;基线就位后
   的新增才自动回流。
7. 首次迁移遇预存目标目录:child 级不覆盖合并(旧根独有子条目不再静默漏掉),同名一律 env wins。

## 4. symlink / 非常规类型拒绝(迁移与对账共用守卫)

- 仅保留「**相对形式** + 词法解析与 canonical(realpath)解析都留在**本次复制子树**内」的
  symlink(拷贝后在环境根内自洽解析)。
- 一律拒绝(跳过不拷 + receipt/warnings 记账;source 只读故无破坏):绝对链(含指向旧根)、
  逃逸相对链、broken 链、FIFO/socket/device 等非常规类型。
- 与既有 fail-closed 先例同纪律:`ext-cas`(blob 拒 symlink)、`ext-fs-installer` git 导入
  (skip symlink)、`ext-atomic-fs.confinedExistingPath`(realpath 圈禁)。
- 已导入子树内嵌套链的后续形态变化不触发重导(子条目整体已定序;记录在案)。

## 5. 边界(non-goals)

- 不做 alpha.jsonc / installs.json 语义合并;不做环境根 → 旧根反向同步;不做删除传播。
- 不清理环境根内历史遗留 symlink(本契约管进口关;存量清理另立票)。
- 不涉 REQ-100 事务 generation 的 offline rollback(另一套 rollback,契约见
  `extension-cas-seed.md` §3 与 ext-transaction)。

验证:`packages/ui-mac/src/main/alpha-env-migrate.test.ts`(幂等/crash 重试/防复活/漂移三态/
bootstrap/身份校验/多环境/symlink 矩阵/别名碰撞/预存目录合并)。
