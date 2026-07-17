---
title: Extension capability authorization (capability→authorize gate)
kind: contract
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-17
review_after: 2026-10-13
---

# 扩展能力授权契约(REQ-100 #348)

本文钉住扩展安装事务的 capability→authorize 闸口:planner 如何声明能力、引擎如何评估
diff 与暂停、renderer 如何确认与重驱、授权账/收据如何落盘与崩溃前滚。引擎机制归
`ext-transaction.ts` / `ext-capability-grants.ts`,意图解码归 `ext-install-planner.ts`,
确认 UI 归已批设计 `docs/design/2026-07-15-capability-authorize-dialog/`。

## 1. 覆盖范围

- **全部 catalog 生产安装路径都经 `runExtensionTransaction` 提交并过本闸**(#378 收口):
  - 单装 skill(catalog 与 packaged seed):generation 事务;
  - 单装 **agent**(seed #358 + catalog remote/builtin #361):file+config 双 item 单事务,
    同一载体 `installAgentFromCas`;
  - 单装 **MCP**(catalog #378 + seed #359):config action 单事务(capabilities/receipt 挂
    `mcp--<name>` item);带密钥 MCP 的密钥文件走**版本化只增布局**(见 §9),Excel MCP 的
    受管 workspace 注入为**非权威 provisioning**(authorize 暂停最多残留一个空受管目录,
    零 config/账本/密钥副作用);
  - 单装 **plugin**(catalog #378 + seed #359):vendored fresh = CAS file items + config item
    (`installPluginFromCas`,内容寻址 `plugins/<name>@<digest16>`);npm fresh = config action
    单事务(整数组换元;跨配置源同 base 严格检查,legacy XDG 在场拒);**同 base 严格检查对
    vendored 形态同样适用**(entry 带 package 发行元数据时 fresh 与更新都查,计划前 + 锁内;
    否则未策展同包 npm 条目与 vendored 路径双载);更新 = #352 原子替换
    (capabilities/authorization 在 plan 上,载荷分支按新 entry spec 选);
  - 单装 **cloud**(#378):receipt action 单 item(零盘副作用,capabilities/receipt 挂
    `cloud--<name>`;重装显式继承 `desiredState`,disabled 不被静默写回 enabled);
  - atomic bundle(其 skill / 无密钥 MCP-config / cloud-receipt 子项)。

  catalog remote 资产的 authorize 确认重驱复用 CAS(`tryReuseCasPayload` 逐 blob 读取重验),
  绝不二次下载。renderer 侧的拦截与重驱参数透传按类型无关写法落地(#348/PR #377)。
- **catalog 之外**:未策展手动添加通道(`ext-persist-mcp` / `ext-install-plugin`)无 catalog
  manifest,无能力集可评估,不在本闸范围(其密钥写入同样走 §9 版本化布局);skill/agent 的
  uncurated import 通道同理。这些通道的账本语义归 uncurated orchestrator(#306)。
- **一个逻辑扩展一个授权 key**(#358 裁决):多 item 事务里 capabilities 只挂逻辑主 item
  (agent seed/catalog = file item `agent--<name>`)。副 item **不声明** `capabilities`(undefined)
  —— 未声明 = 不参与授权评估、不出现在 diff、不落授权账;这与「已授权空集」判然有别,
  后续代码不得为副 item 写入空 grant。卸载联动清除该扩展全部 item key 的 `grants.json`
  (`removeInstallGrants`;agent/plugin 在 flat 通道 = 删除失败即卸载失败且账本不动,可重试;
  mcp 在 journaled artifact seam 内 = 失败保持 uninstalling 非终态前滚,恢复 seam 同语义)
  —— 残留 grant 会让重装静默继承授权。
  key 方案约束:agent 名含 `--` 与 `agent--<name>[--config]` 方案歧义,seed 与 catalog
  安装均显式拒(#361 裁决:边界禁用而非改 key 编码;存量随包/seed agent 名无 `--`)。

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
逐子项;**#378 退出条件组:mcp/plugin-vendored/plugin-npm/cloud 首装 `stage="authorize"`
生产入口各一 + 重驱落 grant、cloud 卸载双清、cloud 重装 desiredState 继承、plugin 更新
失败旧版继续健康、MCP 密钥版本化轮换/busy 不毁旧值/authorize 暂停零明文残留**)、
`alpha-mcp-secrets.test.ts`(版本化写硬化/纯替换/引用收集/锁内 GC 宽限与引用对账)、
`ext-transaction-config.test.ts`(config target 前向圈禁)、
`ext-skill-generations.test.ts`(适配层判别分支)、
`ext-authz-wiring.test.ts`(renderer 承接合同)、`ext-transaction.test.ts`
(引擎闸/整集覆盖/崩溃前滚,先于本票)。

## 9. MCP 密钥版本化布局(#378,Codex 裁决 Q1)

- 布局:`<userData>/alpha-mcp-secrets/<server>/<verId>/<VAR>`(verId = `v-<hex16>`(64 位随机,排他 mkdir 认领,GC 判别接受 8-16 位 hex),每次安装
  尝试全新目录);durable config 只携带对应 `{file:}` 引用。**只增不覆盖** —— 旧版本文件被
  旧 config 引用,直至新 config 提交前必须原样可读;固定路径覆盖写与整目录快照/恢复
  (会删掉并发写方的新版本)已废除。
- 写入硬化:tmp(0600)→ 同目录 rename 原子落位;根/server/版本三级目录 mkdir 后 lstat
  复核非 symlink 实目录(`writeMcpSecretVersioned`)。
- 生命周期:安装失败 / authorize 暂停 → 删除本次 verId 目录(删除前按**合并视图**(主 leaf +
  全部 retained legacy 源)证明未被引用,读不出即保守不删;用户确认前零明文残留);提交成功 →
  `gcMcpSecretsAgainstConfig` 在**配置写锁内**按**全源引用集**(主 leaf + 每个 legacy 源的
  `mcp.<server>` leaf,各按其文件目录解析,r9/r10)收未引用且过宽限期(10 分钟,保护「文件
  已写、config 未提交」的在途安装)的版本目录、legacy flat 文件与历史兄弟级 `.bak-<hex8>`
  快照残留(候选名在册 = 活体排除,绝不删;busy 跳过,best-effort);任一源不可读/形状非法 =
  引用集不可信,整轮安全退出;崩溃孤儿无引用,由后续 GC 收。卸载:整 `<server>` 目录删除
  (覆盖全部版本 + flat)+ 兄弟级历史备份(同活体排除)。
- 存量兼容:legacy flat 引用(`<server>/<VAR>`,含 env 迁移 `alpha-env-migrate` 写入)继续
  可读;仅在被当前 leaf 不再引用且过宽限后被 GC。未策展通道(`ext-persist-mcp`)与 catalog
  事务共用同一版本化原语,skip 语义(已有引用/空值)保持未策展既有 posture。
- 残余窗口(如实记录):密钥文件写入发生在事务外(userData 与事务根不同卷/不同圈禁域,
  file action 收不进)。崩溃于「版本目录已写、事务未提交」时留下无引用孤儿目录(0600,
  内容为用户本次亲自提交的值),等待 GC —— 不构成对既有安装的破坏面。
