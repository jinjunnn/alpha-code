---
id: ADR-031
title: 混合用户记忆——本地优先、选择性云发布与有界上下文
status: proposed
date: 2026-07-19
kind: adr
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-19
review_after: 2027-01-19
related: [ADR-025, ADR-029, "alpha-work:REQ-121"]
---

# 混合用户记忆

## 背景

[[ADR-025]] 已把 `~/Alpha/Memory/*.md` 定义为用户可见、可编辑的本地记忆落点，并把跨会话记忆能力另留独立需求。为了让用户在多设备和云任务中选择性使用记忆，Alpha 需要增加云发布和检索接缝，同时不能把既有本地文件、会话历史或整个 `~/Alpha` 静默上传。

本 ADR 窄修订 [[ADR-025]] §6 治理边界中的**两条**结论，两条都只在 Memory 面生效：

1. **「不做 iCloud/同步/备份」** —— 原条款作用域是整个 `~/Alpha` 可见区（含 `Journal/`、`Outputs/`）；本 ADR 只取其中属于 Memory 的部分，允许用户把明确选择的 Memory 条目或 scope 发布为版本化云快照。不引入 iCloud、整个 `~/Alpha` 的通用同步/备份、`Journal/`/`Outputs/` 的同步，或实时双向文件同步。
2. **「alpha 自动写入只追加、不删改用户文件」** —— 拆为两段：**自动写入仍只追加**（自动化、云回流、agent 后台行为一律不得删改用户文件，该保证未被削弱）；**新增**用户显式请求且指明范围时可删除 Memory 文件的通道（见 §6，owner 2026-07-19 裁决）。

本 ADR 不 supersede [[ADR-025]] 的其它决定。修订记录已同步落在 [[ADR-025]] 的「修订(2026-07-19)」段。

## 状态与适用性

本 ADR 处于 proposed 状态，只定义目标边界，不改变当前产品行为，也不代表云端 Memory 已实现、启用或部署。具体云端合同须先由 [alpha-platform#84](https://github.com/jinjunnn/alpha-platform/issues/84) 裁决；在相应实现与验证完成前，现有 [[ADR-025]] 本地行为仍是实际能力。

## 决策

### 1. 本地优先且保持用户所有权

- `~/Alpha/Memory/*.md` 继续是用户可读、可编辑、可离线的本地记忆面；升级不得自动上传、覆盖、重排或删除现有文件。
- 本地文件仍可在未登录、BYOK 或云端不可用时使用；云端状态不能让本地文件失效。
- 产品可以为条目维护稳定 identity、revision、digest、scope 和发布状态，但具体 sidecar/metadata 形态服从跨仓 Memory 合同，且不得把用户正文藏进不可导出的内部数据库作为唯一副本。
- 外部编辑、离线修改或 digest 变化只把已发布快照标记 stale/conflict；未经用户确认不得覆盖云端 revision。

### 2. 只做逐条或逐 scope 的选择性云发布

首版提供明确的“发布/更新云快照”和“撤销云发布”，不扫描或上传整个 `Memory/`、项目、会话或知识库。每次发布绑定用户、scope、来源、revision、digest 和当前同意版本；重复操作幂等，旧 revision 不能覆盖新 revision。

首版不做实时双向同步、后台自动合并或静默 last-write-wins。云端变化、本地变化和撤销分别显示 published、stale、conflict、revoked 等诚实状态，由用户选择更新、保留本地或撤销云快照。

### 3. Scope 默认值

| Scope | 生命周期与默认行为 |
|---|---|
| `session/task` | 带 TTL 的短期上下文，不自动晋升为长期 Memory |
| `workspace/project` | 项目约定、决定和偏好的默认长期 scope |
| `user-private` | 跨项目个人偏好与稳定事实；仅在用户明确开启和当前任务允许时使用 |
| `tenant-shared` | 首版禁用；不得借云端多租户能力变相提供团队共享记忆 |

`tenant-shared` 的禁用与 `NON_GOALS.md` 中“不做团队协作/共享 workspace/会话”的边界一致。将来如要重开，必须同时重评共享主体、成员生命周期、管理员权限、退出和删除语义，不能把 user-private scope 扩名实现。

### 4. 不可信来源只能提出候选

用户显式“记住”可以创建或更新已确认条目。会话 compaction、网页、连接器、工具结果和 REQ-113 知识库只能形成带 provenance 的待确认候选；模型不能自行把它们提升为 active memory。

候选必须展示来源、摘要、建议 scope、敏感性和可能冲突。用户拒绝或忽略候选不会形成隐藏记录；候选过期后按合同清理。Secret、OAuth token、API key 和私钥不进入候选或 Memory，它们只属于 Vault。

### 5. 有界注入；**接入方式待逐案裁决,本 ADR 不断言**

**目标语义**（本 ADR 决定的部分）：Memory 注入应沿用现有 System Context 的 baseline、update、removal 与持久审计语义，**不新建第二套 prompt 注入或会话历史引擎**。

**接入方式（本 ADR 不裁决，留给 [alpha-code#427](https://github.com/jinjunnn/alpha-code/issues/427)）**：初稿曾断言「作为新的 System Context source 接入现有 Registry/Context Epoch」。2026-07-19 勘破证明**该路径在本仓现行宪法下不可行**——System Context Registry 是上游内部服务，全部注册者静态编入 `packages/core/src/location-services.ts` 的 Layer 图，新增一个 source 必须修改该上游文件（north-star guard `M` 判红）；`packages/{plugin,sdk,protocol}` 对 systemContext 零命中；[[ARCHITECTURE]] 硬约束③的零-fork 接缝清单不含此类。而唯一现存的合法注入口 `experimental.chat.{system,messages}.transform` 已被 [[ADR-002]] 标注风险、并被 `NON_GOALS.md` #4 与 ARCHITECTURE 禁区禁止长期承载核心后端行为。

⇒ 既走不了 L0，又不能长期走 experimental v1 hook。按 [[ADR-029]] 上游主权阶梯 §3，接入方式必须由一条**逐案主权 ADR** 裁决（载明勘探证据、级别选择、守卫/tripwire、回退方案，L3 另加放弃白嫖范围声明），或改由上游接缝解决。该裁决登记为 [alpha-code#427](https://github.com/jinjunnn/alpha-code/issues/427)。

**在 #427 结论落地前，本 ADR 不声称 Memory 注入已有可用接缝。** owner 2026-07-19 定调：Memory 是核心能力、后续需要收回主权，但不着急现在做。

### 5b. 注入的有界约束（不依赖接入方式，恒定成立）

每次任务只请求用户显式允许且当前授权的 scope，并按数量、token、敏感级别、时效、相关性和费用预算选择少量条目。会话界面应能展示实际注入的来源、revision 和 `why_used`；撤销、停用或删除后通过 removal/失权语义停止后续使用。

Memory 是上下文而不是指令或授权。当前用户请求、系统/开发者规则和实时权限判定优先于旧 Memory；Memory 不能批准工具调用、支付、连接器、文件写入、网络动作或其它副作用。

**云端不可达必须降级，不得阻断会话。** 这是 §1「云端状态不能让本地文件失效」的执行细则：Memory 注入在云端不可达、超时或失权时，必须以「本地条目 + 空云端结果」继续，并在界面诚实标注云端部分不可用；**不得**使整个上下文初始化进入阻断态。现有 System Context 的 `unavailable` 语义是 fail-closed 阻断（任一 source 报 unavailable ⇒ `InitializationBlocked`，新会话开不起来），Memory source **不得**进入该集合——否则云端一次抖动就会让用户连本地会话都开不了，与本地优先承诺正面相撞。接入方式裁决（[#427](https://github.com/jinjunnn/alpha-code/issues/427)）必须满足本约束。

### 6. 用户控制

用户必须能够显式：

- 记住、查看、编辑、纠正和改变 scope；
- 发布或更新云快照、撤销云发布，并查看 stale/conflict/revoked 状态；
- 导出本地条目和当前有权访问的云端记录；
- 忘记单条、一个 scope 或全部记忆，并分别确认本地删除与云端删除范围；
- 查看 tombstone 已阻断召回以及派生 purge pending/failed/completed 的真实状态。

任何删除本地用户文件的动作都要求明确的用户请求和目标范围。云端异步 purge 失败不能被 UI 显示为“已彻底删除”，但 tombstone 生效后也不能继续召回内容。

## 边界

- Session history、Context Epoch 和 compaction 是会话工作记忆/审计，不等于长期 Memory，也不自动发布。
- REQ-113 知识库可共享未来的索引组件，但 Memory 使用独立的数据模型、namespace、权限和删除语义，不是“特殊知识库”。
- 第三方插件和 Connector 不获得隐式 user-private 或跨项目读取权；其访问必须走显式 scope 授权。
- 本 ADR 不建立全局知识图谱、自动用户画像、全量会话学习、团队 Memory 或通用文件同步产品。
- 具体云存储、区域、加密、冲突合同和 purge 参数由 [alpha-platform#84](https://github.com/jinjunnn/alpha-platform/issues/84) 裁决；目标架构不等于实现或部署。

## 关系与交付入口

- 父需求：[alpha-work#24](https://github.com/jinjunnn/alpha-work/issues/24)
- 云端权威与同步合同：[alpha-platform#84](https://github.com/jinjunnn/alpha-platform/issues/84)、[alpha-platform#85](https://github.com/jinjunnn/alpha-platform/issues/85)
- 云端有界检索：[alpha-platform#86](https://github.com/jinjunnn/alpha-platform/issues/86)
- 能力级验证：[alpha-platform#87](https://github.com/jinjunnn/alpha-platform/issues/87)
- 本地兼容与选择性发布：[alpha-code#424](https://github.com/jinjunnn/alpha-code/issues/424)
- Memory Center 与 System Context：[alpha-code#425](https://github.com/jinjunnn/alpha-code/issues/425)
- 同意、设备、导出与清除控制：[alpha-web#73](https://github.com/jinjunnn/alpha-web/issues/73)
- 云端 Memory 数据面决策：[alpha-platform ADR-029](https://github.com/jinjunnn/alpha-platform/blob/main/.claude/rules/adrs/ADR-029-cloud-memory-plane.md)

## 后果

- 用户保留本地、透明、离线可用的 Memory，同时可以明确选择哪些条目进入云端能力面。
- 云端快照与本地文件的分歧成为可见 conflict，而不是静默覆盖或隐藏同步。
- 长期记忆复用现有 System Context/Context Epoch，不重写 agent core、session 或 context 引擎。
- 首版的自动化被约束为“提出候选、等待确认”；更主动的学习或共享能力必须另立决策。
