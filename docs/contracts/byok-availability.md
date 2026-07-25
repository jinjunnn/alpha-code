---
title: BYOK selectability and executability (two predicates)
kind: contract
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-24
review_after: 2026-10-24
---

# BYOK 契约:两个独立谓词

BYOK（用户自带 KEY 的国内直连）**没有一个叫「可用性」的东西**。把可选择性与可执行性
揉成一个判据,就是 2026-07-24 事故的成因:引擎一病、平台一断、用户一登出,已配好
KEY 的直连模型全体变灰。本契约把它拆成两个**互不推导**的谓词,并封闭各自的输入集。

## 谓词 1 —— BYOK 本地可选择

```
本地可选择(provider, model) ≡ 本地目录含该 provider 的该 model  ∧  该 provider 的 KEY 已在本地配置
```

**合法输入集(封闭)**:

| 输入 | 真源 | 读取通道 |
| --- | --- | --- |
| 本地目录 | `packages/ui-mac/src/main/alpha-models.json` 的 `byokProviders[].models` | `models-catalog` IPC(main-only) |
| 本地 KEY 状态 | alpha 加密钥匙库 / `keyEnv` / `opencode.jsonc` inline | `providers-key-status` IPC(main-only) |

**禁止进入判据的输入(新增任何一项即为契约违反)**:

- 登录态(`auth.getState()`、`platformStatus`);
- 账户额度 / 会员 entitlement(`account.summary()`);
- 平台连通性(gateway `/v1/models` 是否可达、是否 401、是否契约不兼容);
- 平台 live allowlist(`<userData>/alpha-live-models.json`);
- 引擎模型清单(`model.list` 的内容、`listState`、`readyListEpoch`)。

## 谓词 2 —— 当前可执行

```
当前可执行 ≡ 引擎已恢复（sidecar 健康 + 模型链 ready）
```

这是**物理下限**,不可绕过:推理必须经活着的引擎,会话内换模型必须经 v2
`session.switchModel`。可执行性由发送门(`canSend`)与会话切换门承担,**不得**回头
否定谓词 1。

## 两个谓词的组合语义(唯一合法呈现)

| 本地可选择 | 当前可执行 | 呈现 |
| --- | --- | --- |
| 是 | 是 | 行可选;选中即生效;可发送 |
| 是 | 否 | 行可选,行内如实标「引擎重启中 · 可先选择」;**home 可先选**(内存写);发送门保持关闭 |
| 否(未配 KEY) | — | 行呈现「未配置 KEY · 点击配置」,点击进配置流 |
| 否(KEY 状态未知/读取失败) | — | 如实呈现读取中 / 读取失败,**不得**降格成「未配置」 |

`recovering` 下的会话边界:**home 模式可先选择;session 模式展示本地 BYOK 行,但在引擎
恢复、`switchModel` 确认之前不得伪装成已切换。** 不存在也不得新增 session 排队切换
状态机 —— 呈现为已切换但服务端未落档,是视觉造假。

## 目录主权

BYOK 目录**只由本地 `alpha-models.json` 决定**。平台不得远程干预:

- gateway `/v1/models` 的 `byok_providers` 字段在 alpha-code 侧**没有任何消费方**,
  不解码、不缓存、不记录、不经 IPC 传递(REQ-109 #595,owner 裁决 2026-07-24)。
  平台 wire/schema 侧的字段删除另行处理,不影响本契约。
- live allowlist 仍然收窄**平台代理模型清单**(edition-scoped),这一半不变。
- 因此 BYOK 段没有远程 kill-switch。已接受的代价:供应商破坏性改鉴权/URL/协议、模型
  下架或改名、供应商安全事故、法务/制裁要求下架、错误 baseURL 或计费语义变化,都只能
  靠发版修正。**不得**为这些风险引入新的在线政策面(签名 denylist、TTL 阻断表等一律
  不进门控)。

## 失败域隔离

平台侧的任何失败都**只损失平台段**:

- `models-catalog` IPC 的目录读取路径不引用任何平台拉取状态。平台目录契约不兼容经
  `reportContractFailure` 走独立通道上报(`alpha-contract-health` IPC +
  `alpha-contract-failure` 推送 → renderer `a-contract-failure` 面),**不得**让整个
  `models-catalog` 失败 —— 那会连本地 BYOK 一起阵亡。
- 平台不可达 / 缓存缺失 / 缓存损坏 → 平台段回退 last-known 或内置 snapshot
  (`liveSync.status` 如实标 `cache` / `static`),BYOK 段原样返回。

## 实现锚点

| 契约条款 | 代码 |
| --- | --- |
| 谓词 1 的行派生(`availability` = picker 可选择性) | `packages/ui-mac/src/renderer/alpha-ui/model-picker-core.ts` |
| row-aware 选择门 + 跳过引擎清单 membership | `packages/ui-mac/src/renderer/alpha-ui/alpha-composer-model.tsx` |
| home 恢复中的内存写豁免 / `canSend` 不豁免 | `packages/ui-mac/src/renderer/alpha-ui/alpha-composer.tsx` |
| 目录主权 + 失败域隔离 | `packages/ui-mac/src/main/alpha-platform-models.ts` |
| 注入不受 allowlist 收窄 | `packages/ui-mac/src/main/alpha-models.ts` |
| 缓存不含 BYOK 策略面 | `packages/ui-mac/src/main/alpha-live-allowlist.ts` |

## 回归闸门

| 条款 | 闸门 |
| --- | --- |
| 未登录 + KEY 已配置 → 可选,非「正在同步」 | `model-picker-core.test.ts`、`test-component/alpha-composer-model.cases.ts` |
| `listState === "recovering"` → 可选,行内「引擎重启中」 | 同上 |
| 引擎清单缺 `<id>-byok`(或标 disabled/deprecated)→ 仍可选 | 同上 |
| live allowlist 排除某供应商 / 平台不可达 → 仍在目录与注入中 | `alpha-models.test.ts`、`alpha-platform-catalog.cases.ts` |
| 平台目录 contract-incompatible → 本地 BYOK 仍返回 | `alpha-platform-catalog.cases.ts` |
| session recovering 下点击 → 零 `switchModel`,不呈现为已切换 | `test-component/alpha-composer-model.cases.ts` |
| home 选中后发送门仍关闭 | 同上 |

相关:引擎两代配置面见 [`engine-config-channels.md`](engine-config-channels.md);平台目录
拉取与 edition 语义见 [`platform-integration.md`](platform-integration.md)。
