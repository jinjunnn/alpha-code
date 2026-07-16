---
title: Extension capability authorization (capability→authorize gate)
kind: contract
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-16
review_after: 2026-10-13
---

# 扩展能力授权契约(REQ-100 #348)

本文钉住扩展安装事务的 capability→authorize 闸口:planner 如何声明能力、引擎如何评估
diff 与暂停、renderer 如何确认与重驱、授权账/收据如何落盘与崩溃前滚。引擎机制归
`ext-transaction.ts` / `ext-capability-grants.ts`,意图解码归 `ext-install-planner.ts`,
确认 UI 归已批设计 `docs/design/2026-07-15-capability-authorize-dialog/`。

## 1. 覆盖范围(诚实边界)

- **进闸路径** = 进入 `runExtensionTransaction` 的生产安装:单装 skill(catalog 与
  packaged seed)、**agent seed(REQ-102 #358:file+config 双 item 单事务)**、
  **mcp/plugin seed(REQ-102 #359:config action 单事务)**、plugin 原子替换(#352)
  与 atomic bundle(其 skill / 无密钥 MCP-config / cloud-receipt 子项)。
- **未进闸**:单装 MCP / plugin / agent(catalog 通道)/ cloud 走非事务 legacy 写入路径,
  当前没有 authorize 阶段可言 —— 这不是本契约的豁免而是缺口,由后续 CODE 票(#378,挂父
  #211)把这些类型拉进事务后自动获得同一闸口。renderer 侧的拦截**与重驱参数透传**已对全部
  安装动作(mcp/skill/agent/plugin/bundle/cloud)落地,类型入事务即生效,无需再动 UI。
- **一个逻辑扩展一个授权 key**(#358 裁决):多 item 事务里 capabilities 只挂逻辑主 item
  (agent seed = file item `agent--<name>`)。副 item **不声明** `capabilities`(undefined)
  —— 未声明 = 不参与授权评估、不出现在 diff、不落授权账;这与「已授权空集」判然有别,
  后续代码不得为副 item 写入空 grant。卸载联动清除该扩展全部 item key 的 `grants.json`
  (`removeInstallGrants`;agent/plugin 在 flat 通道 = 删除失败即卸载失败且账本不动,可重试;
  mcp 在 journaled artifact seam 内 = 失败保持 uninstalling 非终态前滚,恢复 seam 同语义)
  —— 残留 grant 会让重装静默继承授权。
  key 方案约束:agent 名含 `--` 与 `agent--<name>[--config]` 方案歧义,seed 安装显式拒。

## 2. 能力声明(planner → plan)

- 能力集来源 = **严格解码后的 `manifest.capabilities`**(`ext-manifest-v2` 白名单枚举,
  由 catalog entry 类型派生,作者无自报通道)。不得二次调用派生函数制造第二套事实。
- `SkillGenerationInstall.capabilities` 与 `AgentSeedInstall.capabilities`(#358)均为
  **必填**:调用方必须显式选择能力集,真正无能力传 `[]`(空集 = 闸静默通过)。可选字段
  被安静遗漏正是 #348 修复的缺陷形态。
- bundle 逐子项声明各自 manifest 的能力集;**禁止**把 bundle 并集复制给子项 ——
  grants key 与能力归属必须一一对应。

## 3. 闸口语义(引擎,锁内)

- 弹确认条件:首装(盘上无 `grants.json`,fail-closed 含不可读)且请求非空,或扩权
  (`added` 非空)。纯收缩/不变静默通过。
- 暂停返回 = `{ ok:false, stage:"authorize", authorization: CapabilityDiff[] }`,
  **零权威副作用**:无 generation/current 切换、无 config/receipt/grants/授权收据写入。
  已验证载荷可能留在可回收共享 CAS(见 §6)。
- 确认语义 = **整集覆盖**(`requested ⊆ confirmed[key]`,展示什么确认什么,防 TOCTOU);
  无逐能力开关、bundle 无按项拒绝 —— 部分拒绝 = 取消整个安装。
- 引擎兜住的是**授权集合 TOCTOU**(锁内重读最新 grants 重算 diff;扩张 → 重新弹),
  不是 catalog 快照身份 TOCTOU(若未来要求「确认的正是同一版本/清单」需把 digest 绑进
  decision,不属本契约)。

## 4. IPC wire 契约(`src/shared/ext-capability-authorization.ts`)

- 失败判别分支:`{ ok:false, stage:"authorize", reason, authorization: CapabilityDiffWire[] }`
  —— authorize 必带 diff,任何中间层不得把 stage 折叠进 reason 字符串丢数据。
- 重驱 = 带 `authorization: { confirmed: Record<itemKey, string[]> }` 重发**同一**
  `ext-install-catalog` 意图(catalog 与 seed 形态均接受该字段)。
- `decidedAt` 是授权收据的审计事实,**由 main 打戳**;renderer 无通道提供(意图解码把
  `decidedAt` 当未知键整体拒绝)。
- 意图解码边界(ADR-028 严格解码):`authorization` 只收 `confirmed`;`confirmed` ≤64 项、
  key 走事务 item key 规则(`SAFE_KEY`/128),每项 ≤32 个 capability、逐个过
  `isSafeCapability`、拒重复;重建全新对象,不保留 renderer 引用。confirmed key 是否属于
  本次 plan、整集覆盖判定归引擎。

## 5. 授权账与收据(仅 committed 后)

- 逐 item `grants.json`(`<root>/ext-store/<key>/grants.json`)与 bundle 级授权收据
  (`<root>/ext-tx/authz/<txId>.json`,含 `decidedAt` + 完整 `items` diff + `skippedOptional`)
  **只在事务 journal 达 committed 后**落盘;abort/rollback 不碰授权账 —— 崩溃窗口的失败
  模式 = 下次多问一次(fail closed),绝不静默继承。
- 崩溃恢复前滚沿 `journal.authorization` 与逐 item `capabilities` 自足落账
  (`writeCommitAuthorizationSync` 与主路径同源),无 UI 参与。

## 6. 重驱缓存(不二次下载)

remote 载荷首驱已提升进共享 CAS;authorize 确认重驱**不得再次访问网络**:逐 blob 读取
重验(防盘上篡改)+ bytes 精确 + 路径守卫,全部命中才复用并 touch mtime(GC #318 grace
续命);任一缺失/损坏 → cache miss 回下载路径。manifest/digest 变化自然 miss。
由此「取消零副作用」的准确表述是**零权威安装副作用**:取消不会安装扩展、不切换
current、不写 config/receipt/grants/授权收据;已验证载荷可能留在可回收 CAS。

## 7. 确认 UI 承诺(已批设计)

- 宿主复用 `alpha-ui/Dialog`:有安装前确认框的类型(MCP/plugin/bundle)authorize 作为
  **同框第二阶段**原地切换;skill 直装/更新扩权独立弹出。
- 差异三分层(新增/已授权/将收回);仅 `engine:plugin`、`process:spawn` 标高风险;
  未知 capability 原样展示(前向兼容)。主按钮场景化(授权并安装/授权并更新)。
- driving/redriving 期间 Dialog 不可关(`dismissible=false`)—— IPC 无取消能力;
  重驱再遇 authorize 用最新 diff 原地替换;`update all` 遇 authorize 停止批量循环;
  取消零权威副作用、静默(toast 只报成功)。

## 8. 证据

`ext-install-planner.test.ts`(capability authorize gate via installCatalog:首装暂停/
零权威副作用/重驱落账/decidedAt 伪造拒绝/基线覆盖静默/扩权重弹/remote 单次下载/bundle
逐子项)、`ext-skill-generations.test.ts`(适配层判别分支)、
`ext-authz-wiring.test.ts`(renderer 承接合同)、`ext-transaction.test.ts`
(引擎闸/整集覆盖/崩溃前滚,先于本票)。
