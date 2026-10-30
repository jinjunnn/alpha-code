---
title: BYOK selectability and executability (two predicates)
kind: contract
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-10-30
review_after: 2027-01-30
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
| 本机已应用 BYOK 目录 | `<userData>/alpha-applied-catalog.json` 的 `byok`(fork 前钉住:已下载的远程 BYOK 目录与安装包首启引导取版本高者;见下文「目录主权」) | `models-catalog` IPC(main-only) |
| 本地 KEY 状态 | alpha 加密钥匙库 / `keyEnv`(Key 名只认 App 内置适配器表 `byok-adapters.ts`)/ `opencode.jsonc` inline | `providers-key-status` IPC(main-only) |

「本机已应用 BYOK 目录」在读取时是本机文件,不是一次在线判断:拉取失败、平台不可达、未登录都只意味着继续用已采纳的
版本(`#1556`)。远程退役一个模型的效果与 App 升级删掉它相同(谓词 1 变假,现有 `checkSelectedModel` 挂起选择),
不是新的在线闸门。

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

**空清单同样算不满足成员关系。** `model.list` 可以**成功**返回 `[]`,而模型链照样进 `ready` ——
「空清单 ⇒ 引擎未就绪」是一个**状态机从未承诺的不变量**,判据不得依赖它(依赖它就等于留了一条
逃逸口:成功空清单 + 链 ready ⇒ 仍可提交)。

**「未就绪」是判据自己的返回值,不是对调用方的口头约定(#686)。** 早期形态把这道闸留给调用方:
判据只吃引擎清单,由一句注释请求每个消费点先自行确认 `modelChainState() === "ready"`。那种形状下
**每新增一个消费点就多一次漏掉的机会**,而注释拦不住任何人 —— 冷启动窗口里(链复位后、
`model.list` 回来之前)漏掉的消费点会拿一个被清空的清单,断言「本次引擎启动没有加载这个模型」,
而那是链 ready 之后才成立的结论。现行契约:

- 就绪与否经**必填**入参 `engineFactsReady` 喂进 `preflightBlockReason` —— 漏掉它是一个 typecheck
  错误,不是一条运行时的假结论;
- 未就绪时判据一律回 `not-ready`,**一条事实性拒绝都不产出**(`platform-needs-login` /
  `nothing-usable` / `byok-not-registered` 全部让位)——`loggedIn`、`hasConfiguredByok`、
  `engineModels` 三者在 `runModelChain` 起手时被整批复位,此刻拿其中任何一个下结论都是在猜;
- `not-ready` 的用户可见文案只能说「正在读取模型状态」,不得断言引擎有没有加载某个模型。

支撑这条的实现侧不变量(由本仓自己维持,不是假设):`engineModelRefs` 的写入**早于**
`setModelChainState("ready")`(`alpha-composer.tsx` 全文件唯一一处 `ready` 转换;链重跑先切
`loading` 再清空清单)⇒ 只要链是 `ready`,清单就是本次真实加载的结果。

**执行失败不得反向改写谓词 1(硬约束)**:引擎恢复后回报的清单里没有某个本地 BYOK 节点,
只允许让「当前可执行」为假(发送门关闭、切换门拒绝、如实报错),**不得撤销、挂起或清空**
一个由本地目录 + 本地 KEY 支撑的选择。括号里那三件事是**配套义务而非可选项** ——
豁免撤销的同时必须补上发送门约束,否则就是把「视觉造假」换成了「提交造假」。放行这条撤销,`model.list` 就又变成了谓词 1 的
最终裁判 —— 只是把裁判点从渲染层挪到了父层 reconciliation。
撤销豁免只覆盖本地目录 BYOK(`localKeyedByokProviders`:本地目录 ∩ 本地 KEY):平台代理的
登录/额度否定、以及绝大多数自定义节点消失,一律照旧生效。
**两处判据的集合刻意不严格相同**,如实登记:撤销豁免用上面那个精确集合,发送门约束用
`isByokEngineId` 后缀集合(前者是后者的子集)。后果是一个恰好以 `-byok` 结尾的**用户自定义**
节点会**受发送门约束**但**不受撤销豁免** —— 方向是 fail-closed(它确实不在引擎里就是发不出去),
故不收紧;但不要把它表述成「自定义节点语义完全未变」。

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
| 是 | 否(引擎已 ready,但清单里没有该 `(provider, model)`,**含成功返回空清单**) | home / session | **选择保留不撤销**;发送门关闭(按钮与 Enter 两条入口共用同一判据);界面常驻一行如实说明「本次引擎启动没有加载这个模型」并给重试入口 —— 不静默、不撤销、不假装能发 |
| 否(未配 KEY) | — | home / session | 行呈现「未配置 KEY · 点击配置」,点击进配置流 |
| 否(KEY 状态未知/读取失败) | — | home / session | 如实呈现读取中 / 读取失败,**不得**降格成「未配置」 |

呈现纪律(与上表同级):**视觉必须跟随可点性**。行只要被选择门阻断就置灰,不允许出现
「`availability` 说可选、按钮却 disabled、样式仍是正常亮行」这种三方互相打架的状态。

告知纪律(同级):**说明必须与判据同粒度**。发送门查的是精确 `(providerID, model id)`,
说明就不能只声称「这个供应商没加载」—— 供应商在册而所选模型缺失时那句话是假的。

`recovering` 下的会话边界:**home 模式可先选择;session 模式展示本地 BYOK 行,但在引擎
恢复、`switchModel` 确认之前不得伪装成已切换。** 不存在也不得新增 session 排队切换
状态机 —— 呈现为已切换但服务端未落档,是视觉造假。

## 目录主权

BYOK 目录 = **远程发布 → 本机校验采纳 → 钉住应用**;安装包里的那份只作**首启引导**;**从不按账户 / edition 收窄**;
**拉取失败从不移除条目**(REQ-237 `#1556`,方案 `docs/design/req236-catalog-and-model.md` §2.3;REQ-237 Scope 第 4 条的落实):

- **远程发布**:alpha-platform 网关 `GET /v1/byok-catalog`(ByokCatalogV1,schema 在本仓
  `packages/alpha-contracts-consumer/vendor/alpha-platform-model-catalog/contracts/v1/byok-catalog.schema.json`)。
  拉取**从不带凭据**,结构上无法按账户收窄;网关端点也不读凭据、账户或 edition。
- **本机校验采纳**(`catalog-refresher.ts` `adoptByokCatalog`):信封不合 schema 即整份拒绝;`catalog_version` 不高于
  本机已有版本(LKG 与首启引导取高者)不采纳;App 适配器表里没有的 provider 跳过;档位选项键越界的文档不采纳。
  通过才原子写 `<userData>/alpha-byok-catalog.json`(已下载);拉取失败、校验失败、未登录都不写,已有条目不减。
- **钉住应用**:每次 fork 前与平台快照一起钉进 `alpha-applied-catalog.json`;picker 与引擎配置只读钉住的那份。
  已下载 ≠ 已应用:新目录在下一次引擎换代时生效。
- **可执行字段不在远程数据里**:端点 `baseURL`、Key 名 `keyEnv`、协议适配器 `compat` 只来自 App 内置适配器表
  (`packages/ui-mac/src/main/byok-adapters.ts`);远程文档出现这些字段即整份拒绝,远程目录也就**不能**重定向用户的 Key,
  不能给引擎新增出网放行主机(放行集合从注入的 baseURL 派生)。新供应商仍需发版。
- 平台模型目录 V3 已删 `byok_providers`(REQ-109 #595 后它本就没有策略消费方)。live allowlist 仍然收窄**平台代理模型清单**
  (edition-scoped),这一半不变。
- **不得引入在线政策面**:远程目录只能增删模型、改展示与三种推理选项键,不是 kill-switch。供应商破坏性改鉴权/URL/协议、
  供应商安全事故、错误 baseURL 等仍只能靠发版修正;**不得**为这些风险引入新的在线政策面(签名 denylist、TTL 阻断表等
  一律不进门控),也不得给谓词 1 加登录 / 会员 / 余额 / 网关在线前提。

## 失败域隔离

平台侧的任何失败都**只损失平台段**:

- `models-catalog` IPC 的目录读取路径不引用任何平台拉取状态。平台目录契约不兼容经
  `reportContractFailure` 走独立通道上报(`alpha-contract-health` IPC +
  `alpha-contract-failure` 推送 → renderer `a-contract-failure` 面),**不得**让整个
  `models-catalog` 失败 —— 那会连本地 BYOK 一起阵亡。
- 平台不可达 / 缓存缺失 / 缓存损坏 / **旧代缓存** → 平台段回退 last-known;没有 last-known 时平台段为空
  (`liveSync.status` 如实标 `cache` / `static`,picker 写「平台模型清单尚未获取」,`#1556` 起不再回退任何随包平台清单),
  且不声称任何价格(`pricingBasisModelId` 为 `null`);BYOK 段原样返回 —— 它本来就不经平台目录。BYOK 目录自己的
  拉取失败同样只损失 BYOK 目录的新鲜度,已应用条目不减。
- **失败域隔离 ≠ 失败静默**(#1084,#987 CHOICE=A / DECIDE #1078)。刷新失败只损失那一份目录的新鲜度,
  但它必须**说出来**:`syncLiveAllowlist`(平台)与 BYOK 刷新轮的每一条出路都经 `reportCatalogRefresh(doc, code)` 落到
  `alpha-catalog-health` IPC + `alpha-catalog-failure` 推送,两份目录**各一格**(`{ platform, byok }`,`#1556`):
  一份成功只清它自己那一格,另一份的失败仍可见。renderer 的 `CatalogFailureBanner` 以 warning 横幅
  (`.a-catalog-failure`)呈现失败的那一份及其稳定分类码。
  此前分类码只到 `fetchPlatformModels()` 的返回值为止 —— 三个刷新入口(启动、登录后 respawn 前、
  `models-platform-live` IPC)一个都不消费它,于是「失败处理」写得再好,用户永远看不到。
  横幅是 warning 而不是 error:BYOK 与上次成功的缓存目录照常可用,这是降级不是阻断。
  #1500:实际 `TimeoutError` 的分类码为 `timeout`,经同一横幅说明超时。首试仍最多等待 8 秒,
  超时后约 1 秒后台补试一次(仍最多 8 秒),首轮调用不等待补试;成功经现有快照路径清空失败状态,
  再次失败保留 LKG/BYOK。HTTP 拒绝与契约不兼容不补试。新刷新或账号身份变化使旧轮失效,
  旧轮不得写快照或覆盖 health。GET 完成日志仅记 origin/path、method、attempt、durationMs
  与 HTTP status/异常类别,不记录查询、凭据、头或正文。
  contract-incompatible 两个通道都记(main 侧「最后一次刷新结局」是单一真源),renderer 侧由
  `CatalogFailureBanner` 在契约横幅在场时自抑制 —— 两条横幅是同一个 fixed 位。

## 实现锚点

| 契约条款 | 代码 |
| --- | --- |
| 谓词 1 的行派生(`availability` = picker 可选择性) | `packages/ui-mac/src/renderer/alpha-ui/model-picker-core.ts` |
| row-aware 选择门 + 跳过引擎清单 membership | `packages/ui-mac/src/renderer/alpha-ui/alpha-composer-model.tsx` |
| home 恢复中的内存写豁免 / `canSend` 不豁免 | `packages/ui-mac/src/renderer/alpha-ui/alpha-composer.tsx` |
| 谓词 2 的发送门约束(`byok-not-registered`) | `model-default-core.ts`(`preflightBlockReason`)+ `alpha-composer.tsx`(`canSend` / `submit` / 行内说明) |
| 禁止引擎清单反向撤销已选本地 BYOK | `packages/ui-mac/src/renderer/alpha-ui/model-default-core.ts`(`checkSelectedModel`) |
| 目录主权:BYOK 目录拉取(不带凭据)与采纳规则 | `packages/ui-mac/src/main/catalog-refresher.ts`(`adoptByokCatalog`) |
| BYOK 已下载 / 已应用文件、首启引导取高者 | `packages/ui-mac/src/main/alpha-live-allowlist.ts` |
| 端点 / Key 名 / 协议适配器 / 保留 id 的唯一来源 | `packages/ui-mac/src/main/byok-adapters.ts` |
| 失败域隔离(平台段) | `packages/ui-mac/src/main/alpha-platform-models.ts` |
| 刷新失败的用户可观察出口 | `packages/ui-mac/src/main/alpha-catalog-health.ts` + `renderer/alpha-ui/Banner.tsx`(`CatalogFailureBanner`) |
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
| 引擎 ready 但清单缺该节点 → 发送门关闭 + 如实告知(且不撤销选择) | **父层发送门** | `model-default-core.test.ts`(纯核 `byok-not-registered`)、`test-component/alpha-composer-model.cases.ts`(真链:选择保留 + `send.disabled` + 常驻说明) |
| 引擎**成功返回空清单**且链仍进 ready → 同样关闭发送门 | **父层发送门** | 同上两处(纯核 + 真链各一例) |
| **Enter 键**(唯一能绕过 disabled 按钮的入口)→ 零 `startChat`,并如实告知 | **父层发送门** | `test-component/alpha-composer-model.cases.ts` |
| **冷启动窗口**(链未 ready + 清单为空)按 Enter → 零 `startChat`,且**不谎称**引擎没加载该模型 | **判据自身**(`engineFactsReady` 必填 ⇒ `not-ready`) | `model-default-core.test.ts`(纯核三例)、`test-component/alpha-composer-model.cases.ts`(真链:`list` 永不 settle + Enter) |
| 清单**含**该节点 → 发送门照常打开(不得过度收紧) | **父层发送门** | `test-component/alpha-composer-model.cases.ts` |
| home 选择不得 supersede 在跑的模型链 / 账户链 | **父层生命周期** | `test-component/alpha-composer-model.cases.ts`(链恢复自愈 + 账户链存活 → `platformPermission` 回 ready) |
| live allowlist 排除某供应商 / 平台不可达 → 仍在目录与注入中 | main | `alpha-models.test.ts`、`alpha-platform-catalog.cases.ts` |
| 平台目录 contract-incompatible → 本地 BYOK 仍返回 | main | `alpha-platform-catalog.cases.ts` |
| 平台目录刷新失败 → 分类码到达 renderer(不被吞掉),成功刷新清空 | main + renderer | `models-catalog-v2.wiring.cases.ts`、`test-component/catalog-failure-banner.cases.ts` |
| 两份目录的刷新结局分别保存:一份成功不抹掉另一份的失败 | main + renderer | `catalog-refresher.cases.ts`(`#1556` AC6)、`test-component/catalog-failure-banner.cases.ts` |
| BYOK 目录采纳规则 1–5;带 baseURL / keyEnv / compat 的文档被拒 | main | `byok-catalog-adopt.cases.ts` |
| BYOK 拉取不带凭据;失败 / 校验失败 / 未登录不减少已应用条目 | main | `catalog-refresher.cases.ts`(`#1556` AC4) |
| BYOK 端点 / Key 名 / npm 只来自适配器表;远程目录不能新增放行主机 | main | `alpha-models.test.ts`、`network-egress-derived.test.ts` |
| 迁移前已存的 Key 仍物化、注入并真发出请求,密钥文件不被清理分支删 | main + 真引擎 | `byok-key-migration.test.ts` |
| session recovering 下点击 → 零 `switchModel`,不呈现为已切换,行置灰且文案不说「可先选择」 | 点击层 + 呈现 | `test-component/alpha-composer-model.cases.ts` |
| home 选中后发送门仍关闭 | 点击层 + 发送门 | 同上 |

相关:引擎两代配置面见 [`engine-config-channels.md`](engine-config-channels.md);平台目录
拉取与 edition 语义见 [`platform-integration.md`](platform-integration.md)。
