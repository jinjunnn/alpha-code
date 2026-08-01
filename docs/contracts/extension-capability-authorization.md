---
title: Extension capability authorization (capability→authorize gate)
kind: contract
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-31
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
  - atomic bundle(其 skill / 无密钥 MCP-config / cloud-receipt 子项)。**嵌套 Bundle 不受理**
    (#705):直接子项自身是 bundle、或自身还带子项者,在任何载荷下载 / 密钥写入 / 事务开启
    **之前**明确拒绝(具名理由 `nested bundle refused: …`),Desktop 不递归展平包图。此前是
    解析整张传递闭包却只装 direct child —— required 嵌套子项整单失败、**optional 嵌套子项
    静默跳过**,而两种命运对用户都显示为「装好了」。
- **一次事务一个 typed probe,组合点只有一处**(#705):`extensionHealthProbeRouter` 按 action
  与 item key 路由(generation → skill 探针、`agent--*` file → agent 探针、其余 file → plugin
  载荷探针),安装路径与启动恢复消费**同一个** router。未登记的 file item 一律 fail-closed
  判不健康 —— 新增 file 消费方必须在 router 里登记探针。组合若有第二份,漂移只会在真机
  现身:装得上,重启恢复期却被判不健康回滚。计划构造(items / receipt 模板 / precondition /
  prepared resource 描述符 / probe)归 `ext-package-tx-builders.ts`,执行仍只归
  `runExtensionTransaction`。
  - REQ-128 单组件 package：`ext-install-catalog` 先经 main-owned
    `PackageAdmissionCoordinator`，再复用同一个 `runExtensionTransaction`、授权账、
    InstallRecordV2 与受限 MCP secret store；不另建同意系统或 package 专用授权账。

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
- 引擎兜住的是**授权集合 TOCTOU**(锁内重读最新 grants 重算 diff;扩张 → 重新弹)。
  legacy catalog/seed 路径仍不把 Catalog 身份写进 transaction decision；REQ-128 package
  在进入引擎前另由同一 production IPC 的 admission attempt 精确绑定四组 digest：
  coherent signed snapshot、严格解码后的 Envelope、逐 item manifest 与 exact capability
  set。main 确认重驱时重取并重算四组；任一变化即消费并作废 attempt，transaction 调用数为零。

## 4. IPC wire 契约(`src/shared/ext-capability-authorization.ts`)

- 失败判别分支:`{ ok:false, stage:"authorize", reason, authorization: CapabilityDiffWire[] }`
  —— authorize 必带 diff,任何中间层不得把 stage 折叠进 reason 字符串丢数据。
- 重驱 = 带 `authorization: { confirmed: Record<itemKey, string[]> }` 重发**同一**
  `ext-install-catalog` 意图(catalog 与 seed 形态均接受该字段)。
- REQ-128 package 重驱还必须原样带回
  `binding:{snapshotDigest,envelopeDigest,itemDigests,capabilityDigest}` 与同一
  `attemptId`。首次返回的 `packageAuthorization.plan` 是完整、无 secret value 的单组件
  写入预览；密钥只在该预览和 capability 确认之后，以 signed prerequisite ID 为键瞬时提交。
- `decidedAt` 是授权收据的审计事实,**由 main 打戳**;renderer 无通道提供(意图解码把
  `decidedAt` 当未知键整体拒绝)。
- 意图解码边界(ADR-028 严格解码):`authorization` 只收 `confirmed`;`confirmed` ≤64 项、
  key 走事务 item key 规则(`SAFE_KEY`/128),每项 ≤32 个 capability、逐个过
  `isSafeCapability`、拒重复;重建全新对象,不保留 renderer 引用。confirmed key 是否属于
  本次 plan、整集覆盖判定归引擎。

## 5. 授权账与收据(越过可回滚点后,`authorizing` → `committed`)

- 逐 item `grants.json`(`<root>/ext-store/<key>/grants.json`)与 bundle 级授权收据
  (`<root>/ext-tx/authz/<txId>.json`,含 `decidedAt` + 完整 `items` diff + `skippedOptional`)
  在 **receipt 已 durable、事务越过可回滚点后**落盘:journal 先进非终态 `authorizing`,
  授权账/收据**全部落位后才进入终态 `committed`**(#336)。abort/rollback 永不触碰授权账 ——
  崩溃窗口的失败模式 = 下次多问一次(fail closed),绝不静默继承。
- **授权投影写失败不终态化、不谎报**(#336):失败时 journal 保留在 `authorizing`,事务结果
  仍 `ok:true`(live+receipt 已落地 —— `ok:false` = 「计划未落地」是调用方补偿路径的既有契约,
  不得伪装)但携带 `authorizationPending` 判别字段(并入 warnings);恢复 gate/启动恢复对
  `authorizing` **只前滚**重试 `writeCommitAuthorizationSync`(幂等)直至成功才 `committed`,
  绝不回滚(回滚会造成 receipt/live 分叉);持续失败 = 非终态在案,gate 拒绝后续写(loud)。
- **receipt durable = 不可回退点,对恢复一切分支成立**(#336 r3):receipt commit 成功之后的
  任何失败(snapshot/journal 进度/授权投影/终态化写)都走只前滚结果通道,绝不抛出;恢复对
  停在 `switched` 的 journal 进入**任何**回滚分支(含 probe 不健康/失据/未全翻转)前,必须经
  `RecoverOptions.receiptCommitted` **读账本**证伪本事务 receipt 是否已 durable(绝不只信
  journal state)—— 已 durable 或无法证伪(缺 seam/账本损坏)一律拒入回滚、保留非终态只前滚;
  唯有确证未落才允许回滚。生产判定与恢复 replay 同一 record→input 映射
  (`recoveryReceiptInputs` + 账本 `transaction.id`),损坏账本抛错 = fail-closed 保留。
- 读面(REQ-103 #392):governance 只读查询(`ext-inventory.ts`)按账本在册 key 附带
  `granted` 快照(capabilities/grantedAt/txId,不透传 manifestDigest),详情页「已授权能力」
  段据此渲染 —— 零写面、不枚举 `ext-store`(孤儿 grant 不进读面)、无记录/坏 JSON 如实缺省
  (绝不回填按类型派生的能力集);词汇与风险分级与确认框同源(`ext-authz.tsx`)。
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
(引擎闸/整集覆盖/崩溃前滚,先于本票;**#336 授权投影 fail-closed 组:grants/收据写失败 →
`ok:true + authorizationPending` + journal 停 `authorizing`、恢复只前滚重试直至 `committed`、
`after-authorizing` 崩溃点并入 AC1 矩阵、恢复报告携带最终 state 供 `recoveryClean` 判净**)；
`package-admission.wiring.test.ts` 从真实 `ext-install-catalog` IPC 与真实 Ed25519 coherent
snapshot 两条入口执行 package preview、四组 binding、main 重取重验、既有 transaction
终闸、prepared secret populate/probe、config switch 与 InstallRecordV2/grants 落账。

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
- 存量兼容:当前环境 root 内既有 legacy flat 引用(`<server>/<VAR>`)继续
  可读;仅在被当前 leaf 不再引用且过宽限后被 GC。未策展通道(`ext-persist-mcp`)与 catalog
  事务共用同一版本化原语,skip 语义(已有引用/空值)保持未策展既有 posture。
- catalog MCP 提交成功后不再从 `ext-install-planner`/preload 回传可执行 config 或 secret
  真值。`ext-ipc` 复用 main 已有的 authenticated v2 client(`serverReady` 的
  `url/username/password`)，先 `POST /global/dispose`，再 `GET /mcp` 触发实例按 durable
  config 重建；`ConfigVariable` 在 engine 装载期解析 `{file:}`。preload result 只携带
  MCP reference 与 `connected/disabled/failed/reload-pending` status。正常路径仍立即可用；
  `awaitServer`/dispose 受 5 秒上界、冷启 status 受 10 秒上界；route 不可用或任一上界
  到期时显式返回 `reload-pending`，不谎称已热连，也不无限占住串行写窗口。
- main/IPC 入口当前有效的 package 安装行为：package secret prerequisite 只消费 host-owned
  `AlphaPackageEnvelopeV1` 与严格 payload decoder 的产物，不 decode web Declaration；
  稳定 prerequisite ID、MCP environment/header target 与 store reference 均从 signed
  component/profile 派生；renderer 提交只能携带短生命周期的
  `{prerequisiteId,value}`。main 重验 signed snapshot/Envelope/item/capability binding 后，
  既有 transaction 授权终闸先执行；随后 prepared populate 才把值写入
  `<userData>/alpha-mcp-secrets/<server>/<verId>/<VAR>`，probe 通过后才切 config 与落账。
  持久/结果形状不记录值或值 digest；cancel、undeclared、tamper、stale、replay 均在
  transaction 或 secret 写入前 fail closed。`alpha.secret-prerequisite.v1` 因而已在
  Phase 1 main/IPC 入口兑现；renderer 的 attempt/preview/密钥采集入口由
  [`alpha-code#732`](https://github.com/jinjunnn/alpha-code/issues/732) 交付，当前不宣称已全链兑现。
- 残余窗口(如实记录):密钥文件写入发生在事务外(userData 与事务根不同卷/不同圈禁域,
  file action 收不进)。崩溃于「版本目录已写、事务未提交」时留下无引用孤儿目录(0600,
  内容为用户本次亲自提交的值),等待 GC —— 不构成对既有安装的破坏面。
