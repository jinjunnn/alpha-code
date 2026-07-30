---
title: "#681 ModelCatalogV2 硬切:生产入口恢复 V1 的 inversion 记录"
kind: verification
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-29
review_after: 2026-10-29
---

# #681 生产入口 inversion(2026-07-29)

[ADR-039](../../../.claude/rules/adrs/ADR-039-model-catalog-v2-hard-cut.md) §4 要求:
「记录一次把生产入口恢复到 V1 后该 gate 变红的 inversion」。本文件是那次记录。

**但持久的闸不是这份记录。** 手工复原只证明「当时红过一次」;真正每次 PR 都在跑的是
`packages/ui-mac/src/main/models-catalog-v2.wiring.cases.ts` 里那条自动化 negative gate ——
同一个生产 IPC 入口喂 V1 响应,必须 `pricingBasisModelId === null`、每行 `pricing === undefined`、
`getContractFailure().surface === "model-catalog"`。它登记在 `scripts/gate-files.tsv`,
删掉即红。这份文件补的是它覆盖不到的那一半:**把 decoder 本身换回 V1** 之后会怎样。

## 复原了什么

三处,精确对应硬切的三处:

| 文件 | 复原动作 |
| --- | --- |
| `packages/alpha-contracts-consumer/src/decode.ts` | 把 `ModelCatalogV1: ajv.compile({ $ref: "alpha-wire-contracts.schema.json#/$defs/ModelCatalogV1" })` 加回 validator 表 |
| `packages/alpha-contracts-consumer/src/types.ts` | 把 `ModelCatalogV1` 加回 `ContractValues` |
| `packages/ui-mac/src/main/alpha-platform-models.ts` | 生产 fetch 改回 `decodeJsonContract("ModelCatalogV1", …)` |

## 结果:闸变红

```
$ bun test ./src/main/models-catalog-v2.wiring.cases.ts     # (packages/ui-mac)
 4 pass
 4 fail
exit=1
```

四条红,以及它们各自证明的东西:

- `production IPC refreshes through the V2 fetch decoder and returns the persisted projection`
  —— `expect(live.error).toBeUndefined()` 收到 `"contract-incompatible"`:V1 decoder 拒了真实的 V2 响应,
  于是**生产入口再也拿不到平台的价格**。
- `提交给平台 cutover gate 的 consumer pin,经生产入口跑通全链` —— 同因:本仓声称已切到 V2 的那份 pin,
  在 V1 生产入口下跑不通。
- `已有合法 LKG 时,一次 V1 响应也不得把它降级` —— `ENOENT … alpha-live-models.json`:根本没有 LKG
  被写出来。
- `有效 LKG:两侧 id 列表逐项相等` —— 引擎配置退回本地静态 9 行,而不是平台的 12 行。

复原后重跑,`8 pass / 0 fail`;三份文件按备份逐字节还原,`git diff` 无残留。

## 这次 inversion 没有覆盖的

只留 `decodeJsonContract` 一处改回 V1(不动 decoder 表)时,那条自动化 negative gate **仍然绿** ——
因为 schema 之外的语义校验(basis 非空 / 每行 pair 可信)会接手,把 V1 载荷同样判成
`contract-incompatible`。这是有意的纵深,不是漏洞:两层里任何一层单独存在都足以挡住 V1 载荷。
如实记在这里,免得下次有人误以为「改一行就会红」。
