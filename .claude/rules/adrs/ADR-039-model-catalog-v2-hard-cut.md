---
id: ADR-039
title: Desktop 模型目录硬切 ModelCatalogV2，不保留 V1 或本地计价回退
status: accepted
date: 2026-07-29
kind: adr
owners:
  - alpha-code
last_reviewed: 2026-07-29
review_after: 2027-07-29
related: [ADR-037, "alpha-work:REQ-127", "alpha-code:#679", "alpha-code:#681", "alpha-platform:#138"]
---

# Desktop 模型目录硬切 ModelCatalogV2

## 背景

Desktop 当前从 `/v1/models` 解码 `ModelCatalogV1`，但该契约只携带 model id、provider 和
最低套餐。随后客户端用打包在 `alpha-models.json` 的 `std/pro/flag` 与 `×1/×3/×8`
补价格；未被本地快照收录的线上模型又会被合成为 `tier: "std"`。结果是平台代理目录虽然来自
线上，计价主张仍来自客户端，而且最贵的新模型可能被显示成 `1×`。

REQ-127 需要在生产入口加入必填的双倍数和 basis。这是
`ModelCatalogV1` 不允许的 breaking change。按 [ADR-037](ADR-037-engine-generation-switch-is-its-own-change.md)，
生产路径的协议代际替换必须拥有独立 Issue、PR、能力清单和可反向验证的行为闸，不能夹进
renderer 功能修复。

## 决策

### 1. 整条生产链一次性切到 V2

`alpha-code#681` 独立负责让 Desktop 在同一个稳定的 `GET /v1/models` 路径上，从
`ModelCatalogV1` 硬切到 `ModelCatalogV2`。URL 中的 `v1` 是既有 HTTP API namespace；
本次只升级这一份 Alpha-owned response schema，不为 endpoint、cache 或 IPC 再建立版本轴。
一次用户可见 flow 只存在一个 catalog generation：

- 不增加 `/v2/models`，也不在 V2 失败后重试 V1 payload；
- 不让同一 IPC 同时接受 V1/V2；
- 不把 V2 必填字段偷偷加入名为 V1 的 schema；
- 不迁移旧 V1 cache，也不把旧 cache 当 last-known-good。

平台为 V2 model catalog 单独发布 capability-scoped schema 与 producer fixture。
Desktop 为该 artifact 建立独立 immutable pin/decoder；现有 V1 bundle 继续服务其它 V1
契约，且不因 model catalog V2 要求 alpha-web 更新它的 V1 pin。

### 2. 一个严格 V2 snapshot 贯穿 fetch、cache、IPC 与执行配置

成功响应必须先由 V2 schema 完整验证，再原子替换 LKG；cache 不建立自己的版本字段，旧形状
因缺 basis/pair 自然无效。basis 和每个 model 的 input/output pair 属于同一个不可拆 snapshot。known model
只允许从本地补 name、reasoning、web 和 variants 等展示元数据，不能覆盖平台字段。

读取时，renderer picker 与 sidecar/engine config 消费同一份 validated projection。
网络失败可以继续使用有效 V2 LKG 并明确标记 cache；契约不兼容、旧 V1 cache、空或坏 snapshot
都不能产生半真目录。没有有效 V2/LKG 时，平台代理计价状态为 unavailable；BYOK 目录继续由
本地权威独立工作。

### 3. 平台拥有计算，客户端只拥有展示

V2 只新增固定 `pricing_basis_model_id`，以及每个 model 的 input/output 两个 numeric
multiplier。未缓存 token 单价、平台 half-up 到一位小数是契约固定语义，不在每次响应重复编码。
价格完整性继续只由平台 #102 的 fingerprint/countersign gate 承担，不新增 price-book revision。
客户端：

- 不读取原始 USD 价格；
- 不做价格除法、rounding、加权或 route 选择；
- 不建立 tier、range 或未知模型 `1×`；
- 只验证、持久化、投影和本地化展示平台给出的值。

`alpha-code#679` 是独立产品 PR：删除本地档位与虚假兜底，并为可信 pair / unavailable
两态提供 UI。它若先合并，所有平台代理行诚实显示计价不可用；这是一项可单独发布的修复，
不是 V1 compatibility path。

### 4. 合并门是生产 wiring 行为，不是 schema 存在

`alpha-code#681` 的 gate 必须从真实 `models-catalog` IPC 用户入口出发，观察
V2 fetch → decoder → LKG → effective projection 的结果，并记录一次把生产入口恢复到 V1 后
该检查变红的 inversion。类型检查、fixture 单测、HTTP 200、源码字符串或全套测试绿色不能替代
这个证据。

## Capability inventory disposition

代际切换 Issue 必须逐项记录凭证、tool runtime、plugin hook、event/projection、persistence
与 approval surface 的 `file:line`/复现命令。当前裁决如下：

- 凭证沿用目录的 optional `model.invoke` access token；
- tool runtime、plugin hook 和 approval 均不在只读 catalog IPC 路径上，不新增接缝；
- event/projection 收敛为 main-process V2 refresh → validated LKG → 单一 IPC projection；
- persistence 仍是本地 catalog cache，但 schema 硬切 V2 且写入原子化。

任何能力清单缺项都阻止 `alpha-code#681` 进入 Ready 或合并。

## 被否决的方案

- **在 `ModelCatalogV1` 原地增加必填字段**：让同一版本号代表两种不兼容语义，破坏 strict
  contract 与 immutable pin 的意义。
- **新增 `/v2/models` 或 V1/V2 双读**：为同一能力制造 URL 与 payload 两个版本轴，
  让同一用户流出现半迁移，且恢复了本地价格主权。
- **继续 pin 整个 V1 bundle 并塞入 V2**：无关 Token/Cloud/Artifact 消费者被 model catalog
  变化耦合；capability-scoped artifact 更小且边界更清楚。
- **客户端读取原始价格后计算倍数**：basis 与 rounding 会在消费端漂移。
- **把 generation switch 与 #679 合并**：违反 ADR-037，也让协议切换无法独立 inversion。

## 后果

- `/v1/models` response 与 Desktop decoder 的 hard cut 需要协调发布；任一时刻不保留双代兼容窗口。
- 无 V2/LKG 时平台代理价格声明会暂时不可用，但不会再谎报便宜档位。
- 未来若 V2 发生必填性、单位或语义 breaking change，必须产生新 generation，不能原地改写。
- REQ-127 的跨仓方案与验收由
  [alpha-work#45](https://github.com/jinjunnn/alpha-work/issues/45) 统一追踪。
