---
id: ADR-028
title: Extension Package & Registry v2:ManifestV2/InstallRecordV2 严格 schema + main-only 安装计划 + 项目作用域闭环(Phase 0 最小信任修复 / Phase 1 ManifestV2 分期)
status: accepted
date: 2026-07-12
related: [ADR-014, ADR-019, ADR-023, ADR-024, ADR-029, REQ-098, REQ-099, REQ-100, REQ-101, REQ-102]
---

> **状态:accepted。** 预决策已由需求档 [[REQ-099]](https://github.com/jinjunnn/alpha-code/issues,GitHub SoT `alpha-code#210`/`#191`)与 2026-07-12 产品所有权专项评审支撑:该评审拍板了分期(Phase 0 最小信任修复 / Phase 1 ManifestV2,用户采纳,已记入需求档 §分期)并把本 ADR 立为 REQ-099 的实施门([GitHub Issues](https://github.com/jinjunnn/alpha-code/issues) 与 [Alpha Delivery](https://github.com/users/jinjunnn/projects/2) §5 编号预留)。本文件是该预决策的正式落笔,不引入超出需求档的新方向。

## 背景

1. **信任差异(REQ-099 立项动因)**:远程 Skill/Agent 安装已走「renderer 只传 catalogId,main 从已验签 catalog 重新派生 name/清单/版本」的安全模式(REQ-032/REQ-046,codex H1),但其余安装路径仍由 renderer 提供**安装事实**:
   - `ext-persist-mcp`:renderer 传完整 server config(command/url/env)+ 可自称 `catalogId`(伪造 catalog 出身);
   - `ext-install-plugin`:renderer 传 npm 包名;
   - `ext-install-builtin-skill` / `ext-install-builtin-agent` / `ext-install-vendored-plugin`:renderer 传资产键**和落盘名**(同资产可装成任意名,shadow 既有扩展);
   - `ext-uninstall`:renderer 传**整张 receipt**(含绝对路径 files[]、configKey)——被攻破的 renderer 可以喂伪造 receipt 驱动 main 删文件/删配置。
2. **receipts v1 表达力不足**:无环境、无项目 identity、无 manifest/payload/grant digest、无 generation/previous 链;Hub 主要读 global 视图,项目资产管理不闭环(项目移动/receipt 损坏时无 fail-closed 依据)。
3. **catalog 主体只做浅层结构检查**:条目形状(`catalog-types.ts`)无版本化严格 schema,未知字段/未知版本静默通过——schema 演进(A/C 唯一需协调的耦合点,ADR-023 修订)缺少机械闸。
4. **REQ-098 已就位**:环境(prod/beta/dev)由 main 单向派生 mutable root(`alpha-environment.ts`,renderer 零输入),v2 receipt 的 `environment` 字段与 root 分域有了真源。
5. **分期拍板(2026-07-12 评审,用户采纳)**:P0 信任暴露面(renderer 可喂安装事实)不等 v2 schema 设计——Phase 0 先推广「main 按 catalog ID 重新派生」到 MCP/npm plugin/builtin/vendored 路径,不动 schema;Phase 1 交付 ManifestV2 / InstallRecordV2 / 未策展来源入口 / 项目 scope 闭环。

## 主权阶梯落位(ADR-029 §3)

本 ADR 的全部机器为 alpha 自有文件(`packages/ui-mac/src/main` 新模块 + IPC + `.alpha` 账本文件),**零上游文件触碰 = L0 接缝叠加(默认级)**。无需 L1 变换、L2 补丁或 L3 冻结接管——引擎对扩展的发现/加载面(skills.paths、agent.<n>、mcp、plugin[])全部经既有 alpha.jsonc 注入缝(ADR-019/REQ-059)与 `@alpha-code/ext` 插件缝(ADR-002)承接。按 ADR-029 §3,勘探证据 = 本仓已有同型先例(remote skill/agent 的 main 派生模式即 L0 实现且已真机验证),不存在「低级别不可行」的升级诉求;北极星 file-diff 守卫既有覆盖,零新增守卫动作(§4)。

## 决策

### 1. main-only 安装计划(renderer 零安装权)

- **catalog 安装唯一通道 = `ext-install-catalog`**:renderer 意图收窄为 `{ catalogId, scope, grants }`;main 从**已验 catalog**(ed25519 验签的远端/缓存 → 随包字节快照兜底,ADR-023 修订的两级真源)解析条目,**重新派生全部安装事实**(name、server config、包名、资产键、owned paths),renderer 传入的任何 package/command/config/路径字段在严格解码时 loud 拒绝(未知键即错,不是忽略)。
- **grants = 用户输入,不是安装事实**:secrets 值(变量名必须 ⊆ catalog 声明的 `requiredEnvVars`)、workspace 目录、镜像偏好。main 校验 grant 键集,越权键拒绝。
- **卸载同构**:`ext-uninstall` 只收 `{ type, name, scope(, projectDir) }` 键;receipt 由 main 从**自己的账本**读取,owned paths 从受控根 + 账本事实重新派生,renderer 提供的绝对路径无通道可达删除逻辑。
- 原 renderer 安装事实通道(`ext-install-builtin-skill/agent`、`ext-install-vendored-plugin`、`ext-install-remote-skill/agent`、`ext-enable-cloud`)**下线**(breaking-change,REQ-099 标注)。
- 既有 installer 校验(命令头/URL/env 白名单、realpath 反逃逸、frontmatter 名一致)**全部保留**为纵深防御——planner 派生 ≠ 放宽执行层校验。

### 2. 未策展来源入口与 Catalog 可信语义分离(ADR-023 一脉)

自定义 MCP(`ext-persist-mcp`)与 npm 导入(`ext-install-plugin`)保留为**未策展入口**:IPC 层不再接受 renderer 的 `meta`(catalogId/version)——未策展安装**不可能自称 catalog 出身**,receipt 恒 `origin: created/imported`、id 恒 `user:<name>`。白名单校验(ADR-014 §8/C2)不因入口自定义而放宽。风险文案随 Hub 详情/表单呈现(诚实:可执行内容,来源自负)。

### 3. ExtensionManifestV2 严格 schema 原则

- **版本化 + 严格解码**:`schemaVersion: 2` 精确匹配,未知版本、未知顶层键、未知子键一律 loud 拒绝并给出可定位错误(键名/路径),绝不静默忽略——schema 演进从「向后兼容纪律」升级为机械闸。
- 字段:`id/name/kind/version`、`artifact { digest(sha256 十六进制,格式机械校验), size, mediaType }`、`compatibility { platforms[] }`、`capabilities[]`(**枚举白名单**,越权 capability 拒绝)、`dependencies[]`(计划期循环检测)、**五维 ownership**(`authored/curated/distributed/runtimeSurfaces[]/supportTier`——Alpha curated 不得误标 authored)、`components[]` 逐组件 `runsIn[]` 数组(运行位置不用单值)。
- **`manifestDigest` 不进 manifest 本体**(自哈希悖论):digest 对 canonical JSON 计算,落在 descriptor/receipt/签名 target(REQ-101 的 channel metadata 签名对象即此 digest)。
- 校验时点 = **写盘前**:任何非法 manifest(缺字段/未知键/非法 digest/越权 capability/循环依赖/平台不兼容)在产生任何磁盘副作用之前拒绝。
- Phase 1 当前范围:manifest 由 main 从已验 catalog 条目**合成**(catalog 是现阶段唯一分发真源);独立 manifest 文件分发与验签归 REQ-101(signed channel metadata)/REQ-102(CAS)。

### 4. InstallRecordV2(receipt v2)

- 字段:`environment`(REQ-098 环境,main 真源)、`scope identity`(global / project:安装时 realpath + sha256 路径哈希)、`version`、`manifestDigest`、`payloadDigest`(有字节可及时)、`grantDigest`(secret **变量名**与 grant 键的 digest,不含值)、`desiredState(enabled/disabled)`、`generation`(单调递增)、`previousDigest`(上代 manifestDigest,形成链)、`transaction { id, state }`(REQ-100 接缝)、`channelSequence`(REQ-101 预留,可缺省)、时间戳。
- **账本双格式**:`installs.json` 升 `v:2`,同时写 `records[]`(v2)与派生的 `receipts[]`(v1 兼容视图)——**回滚不丢安装**(旧版本 app 读 receipts[] 照常工作);v1-only 存量在首次 v2 写入时显式迁移(`generation:1`、`migratedFrom:"v1"`,缺 digest 字段如实缺省不伪造)。损坏账本沿用隔离纪律(quarantine + loud,绝不静默清零)。

### 5. 项目作用域闭环(fail-closed)

- 项目 receipt 落**项目自己的** `.alpha/installs.json`(随项目移动);操作项目 scope 时 main 重新 realpath 当前项目目录并与 record 的 scope identity 比对——**不一致(项目被移动/符号链接偷换)即 fail closed**,给出显式错误,**绝不退化为 global 卸载**;record 损坏同样拒绝操作(不猜路径)。
- owned paths 永远从「受控根(env-scoped `~/.alpha` 或 `<project>/.alpha`)+ kind + name」重新派生(realpath 反逃逸守卫),record 中的绝对路径仅作对账参考,不作删除依据。
- global 与不同项目安装同名扩展互不影响(账本物理分域 + scope identity)。

### 6. 分期交付与 REQ-100 接缝

- **Phase 0(最小信任修复,不动 schema)**:§1/§2 全量——planner 通道 + 意图收窄 + 卸载键化 + 未策展入口分离。
- **Phase 1(ManifestV2)**:§3/§4/§5——严格 schema、v2 账本、scope 闭环;Hub 的项目上下文 UI(逐项目展示/禁用/更新)与五维 ownership 呈现按需求档节奏跟进(main 侧数据与守卫先行)。
- **REQ-100 边界**:本 ADR 拥有 schema/planner/receipts;staging/materialization/健康探测/rollback/隔离区归 REQ-100。接缝 = planner 暴露的窄事务钩子(`begin/commit/rollback`,record.transaction 记录其结果),REQ-100 在钩子内落自己的机器,不改本 ADR 的 schema 与派生逻辑。
- signed channel metadata(REQ-101)、CAS 共享层(REQ-102)、Claude plugin 转换(REQ-034)明确不在本 ADR。

### 7. 守卫 / tripwire / 回退

- **守卫**:schema 严格性(未知键/未知版本/非法 digest 拒绝)、planner 权威(伪造 renderer 事实旁路)、scope 闭环(fail-closed)、v1 迁移不丢安装——全部以 bun:test 锁死;北极星 zero-upstream-edits 守卫覆盖不变(全 L0)。
- **tripwire**:catalog schema 演进时,严格解码会把 C 侧新字段挡成 loud 错误——这正是 ADR-023「A/C schema 协调闸」的机械化;C 上架新形态前必须先发 A 兼容(存量 app 不再静默吞未知形态)。
- **回退**:账本 v2 双格式保证降级安装可读(receipts[] 视图);IPC breaking-change 的回退 = 回退整只 app 版本(renderer/preload/main 同包发布,无跨版本 IPC 兼容矩阵需要维护);未策展入口行为回退面 = 既有逃生阀(`ALPHA_LEGACY_INSTALL_ROOT` 语义不变)。

## 后果

- ✅ AC「伪造 renderer package/command/config/receipt/绝对路径 → main 忽略并按已验 target 重建」获得单一通道级保证:不是逐处打补丁,而是**通道上不存在**可传伪造事实的参数。
- ✅ receipts 从「装了什么」升级为「在哪个环境/哪个 scope/哪代/凭什么 digest 装的」,为 REQ-100 事务化、REQ-101 验签、REQ-102 CAS 提供了不需要再改形状的地基。
- ✅ 与 ADR-024 信任模型对齐:凡进入引擎进程/上下文的外来物过同意门,凡落盘的安装事实过 main 派生门。
- ⚠️ breaking-change:旧 IPC 通道下线,renderer 与 main 必须同版本(同包发布,实际无兼容窗口);catalog 严格解码把 schema 演进的协调成本显式化(这是目的,不是副作用)。
- ⚠️ manifest 由 catalog 合成 = 现阶段 manifest 可信度上限是 catalog 通道可信度(ed25519 整体验签);逐包签名/独立 manifest 分发在 REQ-101 前不假装存在。
- 🔭 residual(如实):Hub 项目上下文 UI(逐项目禁用/更新)、五维 ownership 的 UI 呈现、未策展入口的风险文案 UI、v1 账本的自动批量迁移触发时机——main 侧机器(`ext-install-catalog` / `ext-uninstall-v2` / `ext-set-install-state` / `ext-list-installs-v2` 四通道 + schema/planner/账本模块)已就位,UI/编排随后续 slice。既有 renderer 事实通道(`ext-persist-mcp` 收 meta、`ext-install-builtin-*`、`ext-uninstall` 收整张 receipt 等)的**实际下线**与未策展入口的 meta 剥离,随 renderer 切换到新通道同 PR 收口——新旧并存只是仓内开发窗口,不跨发布(同包发布,无兼容矩阵)。
