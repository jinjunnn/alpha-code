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
当前可执行(provider, model) ≡ 引擎已恢复（sidecar 健康 + 模型链 ready）
                            ∧  引擎本次注册的清单里确有该 (provider, model)
```

这是**物理下限**,不可绕过:推理必须经活着的引擎,会话内换模型必须经 v2
`session.switchModel`。可执行性由发送门(`canSend` 与 `preflightBlockReason`)与会话
切换门承担,**不得**回头否定谓词 1。

**两个谓词必须各自都被执行(硬约束)**。撤销豁免(下条)让选择在引擎缺该节点时活了下来,
发送门就**必须自己**拿引擎清单挡住 —— 否则会把一个引擎里根本不存在的 Model Ref 提交上去。
「引擎不能否决可选择性」与「发送门不检查可执行性」是同一个缺陷的两面:前者太严,后者太松。
清单为空 = 引擎未就绪,该判据整体让路(不误杀冷启动)。

**执行失败不得反向改写谓词 1(硬约束)**:引擎恢复后回报的清单里没有某个本地 BYOK 节点,
只允许让「当前可执行」为假(发送门关闭、切换门拒绝、如实报错),**不得撤销、挂起或清空**
一个由本地目录 + 本地 KEY 支撑的选择。括号里那三件事是**配套义务而非可选项** ——
豁免撤销的同时必须补上发送门约束,否则就是把「视觉造假」换成了「提交造假」。放行这条撤销,`model.list` 就又变成了谓词 1 的
最终裁判 —— 只是把裁判点从渲染层挪到了父层 reconciliation。
撤销豁免只覆盖本地目录 BYOK:自定义节点消失、平台代理的登录/额度否定,一律照旧生效。

**恢复 owner 不得被选择行为 supersede**:home 的本地 BYOK 选择只是一次内存写,在**任何**
链状态下都不得让在跑的模型链或账户链判 stale —— 那会把「可用性押在一个不会再到来的事件上」
这类悬崖重新造出来。建立了新 replacement owner 的 supersede(工作区切换、登录态变化、
会话切换、显式重试)不在此列。

## 两个谓词的组合语义(唯一合法呈现)

| 本地可选择 | 当前可执行 | 界面 | 呈现 |
| --- | --- | --- | --- |
| 是 | 是 | home / session | 行可点;选中即生效;可发送 |
| 是 | 否 | **home** | 行可点,行内标「引擎重启中 · 可先选择」;选中只是内存写;发送门保持关闭 |
| 是 | 否 | **session** | 行照常展示,但**不可点**且随之置灰,行内标「引擎重启中 · 恢复后可切换」—— 会话换模型必须落到服务端,不得让用户看到一条正常亮行却点不动 |
| 是 | 否(引擎已 ready 但清单无此节点) | home / session | **选择保留不撤销**;发送门关闭;界面常驻一行如实说明(说清是本次引擎启动没加载这个直连供应商)并给重试入口 —— 不静默、不撤销、不假装能发 |
| 否(未配 KEY) | — | home / session | 行呈现「未配置 KEY · 点击配置」,点击进配置流 |
| 否(KEY 状态未知/读取失败) | — | home / session | 如实呈现读取中 / 读取失败,**不得**降格成「未配置」 |

呈现纪律(与上表同级):**视觉必须跟随可点性**。行只要被选择门阻断就置灰,不允许出现
「`availability` 说可选、按钮却 disabled、样式仍是正常亮行」这种三方互相打架的状态。

`recovering` 下的会话边界:**home 模式可先选择;session 模式展示本地 BYOK 行,但在引擎
恢复、`switchModel` 确认之前不得伪装成已切换。** 不存在也不得新增 session 排队切换
状态机 —— 呈现为已切换但服务端未落档,是视觉造假。

## 目录主权

BYOK 目录**只由本地 `alpha-models.json` 决定**。平台不得远程干预:

- gateway `/v1/models` 的 `byok_providers` 字段在 alpha-code 侧**没有任何策略消费方**:
  **不作策略消费、不缓存、不记录、不经 IPC 传播**(REQ-109 #595,owner 裁决 2026-07-24)。
  **它仍被解码与校验** —— `ModelCatalogV1` 把 `byok_providers` 列为 required,缺字段会判
  `contract-incompatible`;`decodeJsonContract` 照旧解出完整信封,只是本仓不再读取该字段。
  wire/schema 侧的字段删除另票处理,不影响本契约。
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
| 谓词 2 的发送门约束(`byok-not-registered`) | `model-default-core.ts`(`preflightBlockReason`)+ `alpha-composer.tsx`(`canSend` / `submit` / 行内说明) |
| 禁止引擎清单反向撤销已选本地 BYOK | `packages/ui-mac/src/renderer/alpha-ui/model-default-core.ts`(`checkSelectedModel`) |
| 目录主权 + 失败域隔离 | `packages/ui-mac/src/main/alpha-platform-models.ts` |
| 注入不受 allowlist 收窄 | `packages/ui-mac/src/main/alpha-models.ts` |
| 缓存不含 BYOK 策略面 | `packages/ui-mac/src/main/alpha-live-allowlist.ts` |

## 回归闸门

闸门层次要读准:**行派生**(纯核)只证明渲染判据,**点击层**只证明 picker 的门,
**父层 reconciliation** 才证明选择不会在引擎回报后被撤销。三层缺一,主权就有漏口。

| 条款 | 层次 | 闸门 |
| --- | --- | --- |
| 未登录 + KEY 已配置 → 可选,非「正在同步」 | 行派生 + 点击层 | `model-picker-core.test.ts`、`test-component/alpha-composer-model.cases.ts` |
| `listState === "recovering"` → 可选,行内「引擎重启中」 | 行派生 + 点击层 | 同上 |
| 引擎清单缺 `<id>-byok`(或标 disabled/deprecated)→ 行仍可选 | 行派生 + 点击层 | 同上 |
| 引擎恢复后清单仍缺该节点 → 已选的本地 BYOK **不被撤销/挂起** | **父层 reconciliation** | `model-default-core.test.ts`(纯核豁免)、`test-component/alpha-composer-model.cases.ts`(真链两轮 reconciliation) |
| 引擎 ready 但清单缺该节点 → 发送门关闭 + 如实告知(且不撤销选择) | **父层发送门** | `model-default-core.test.ts`(纯核 `byok-not-registered` 四例)、`test-component/alpha-composer-model.cases.ts`(真链:选择保留 + `send.disabled` + 常驻说明) |
| 清单**含**该节点 → 发送门照常打开(不得过度收紧) | **父层发送门** | `test-component/alpha-composer-model.cases.ts` |
| home 选择不得 supersede 在跑的模型链 / 账户链 | **父层生命周期** | `test-component/alpha-composer-model.cases.ts`(链恢复自愈 + 账户链存活 → `platformPermission` 回 ready) |
| live allowlist 排除某供应商 / 平台不可达 → 仍在目录与注入中 | main | `alpha-models.test.ts`、`alpha-platform-catalog.cases.ts` |
| 平台目录 contract-incompatible → 本地 BYOK 仍返回 | main | `alpha-platform-catalog.cases.ts` |
| session recovering 下点击 → 零 `switchModel`,不呈现为已切换,行置灰且文案不说「可先选择」 | 点击层 + 呈现 | `test-component/alpha-composer-model.cases.ts` |
| home 选中后发送门仍关闭 | 点击层 + 发送门 | 同上 |

相关:引擎两代配置面见 [`engine-config-channels.md`](engine-config-channels.md);平台目录
拉取与 edition 语义见 [`platform-integration.md`](platform-integration.md)。
