---
id: REQ-069
title: 未登录模型默认/展示流程重设计 — 不默认代理模型、海外 model id 不外显、默认链(KEY→上次使用→空态引导)
type: ux
priority: P1
repo: A
created: 2026-07-08
sprint: S32(2026-07-08)
status: shipped
source: 用户真机报障(2026-07-08,4 张截图在报障会话)
---

## 背景/证据(用户真机报障,2026-07-08)

未登录状态下启动 app,模型选择流程存在多处错误,连成一条「默认即撞墙」的坏路径:

1. **未登录却默认选中平台代理模型**(member-only,仅登录 + 有订阅/余额可用)——用户什么都没做,composer 默认就落在必拒的模型上;
2. **发消息即被网关拒绝**:「预授权拒绝: member-only model 需 active 会员」原文抛给用户(B 侧防线是对的,但正常流不该让用户默认就触达它);
3. **未登录时 picker 逐条外显 GPT/Claude 等海外平台 model id**——用户期望:未登录只显示 CN 的节点,不显示海外模型 id;
4. **picker/composer 存在一处 UI 展示问题**(用户截图 Image #4;细节待真机复现定位,随本项一并修)。

## 机制排查(登记时已核,锚点)

- **renderer 默认门是好的,但没拦住**:`alpha-composer.tsx:466-511`(REQ-056,PR #141)的自动默认已门在「登录 + proxyLive」;故报障中的默认另有来路,候选:
  - **持久化残留**:`composer-state.ts:42` 冷启动直读 localStorage `MODEL_KEY`,**不做任何当前可用性校验**——此前登录期(显式或误)选过代理模型,登出后仍原样沿用;
  - **引擎级默认**:未显式选择时 composer 不传参数、引擎用自己的默认(`composer-state.ts:7`);若代理 provider 因 stored mode/env 残留仍注册,引擎默认可能落在它身上(参 [[REQ-002]] BP-2 冷启动登录态、alpha-auth.ts:163 `loggedInPlatform` 判定);
  - 具体是哪条(或两条都有)→ 实现时真机复现钉死。
- **picker 无条件列出全部平台模型**:`alpha-composer-model.tsx:104-118` `proxyRows` 直接返回 `cat.platformModels`(A 侧 snapshot 全量,含 intl 的 GPT/Claude),未登录只是标 `locked`,不是不显示——与 REQ-030 的 edition 收口(prod 默认 edition=cn,仅 v4 两档)在**登录前的展示层**没有对齐。

## 期望行为(用户拍板方向,2026-07-08)

启动后的**默认模型解析链**(按序降级,每级不满足才进下一级):

1. **上次使用的模型**(localStorage 持久化)→ 先过可用性校验:provider 仍在引擎注册 && (若为平台代理 → 已登录);可用则用;**不可用不静默沿用、也不静默换**,降级到下一级(picker 内如实显示原选择被禁用的原因);
2. **已登录 + 代理活** → 现有 REQ-056 默认(catalog 默认档),不回归;
3. **未登录但配置过 API KEY(BYOK)** → 默认该 provider 上次使用/推荐的模型,直接可发;
4. **全新用户(未登录、无 KEY、无历史)** → **优雅空态**:composer 模型位显示引导态(非死点,点开即 picker);picker 顶部引导卡给两个出口——「登录使用代理模型(零配置)」/「配置自己的 API KEY」;发送前 preflight:选中(或残留)平台代理模型而未登录 → 行内引导阻断,**不把网关预授权拒绝原文当第一道 UX**(网关拒绝保留为兜底防线)。

**未登录 picker 展示规则**:平台代理区不逐条外显海外 model id——按默认 edition(cn)清单收敛,整区以「登录解锁」引导态呈现(具体形态设计定稿);登录后恢复现有全量行为。

## 验收标准

1. 全新环境(未登录、无 KEY、无历史)冷启动:composer 不默认任何平台代理模型;直接发消息不产生「预授权拒绝: member-only model」;空态引导可见、可操作(登录/配 KEY 两出口皆可达);
2. 未登录时 picker 不逐条显示 intl-only 平台模型 id(GPT/Claude);平台区为引导态;
3. 已配 BYOK KEY、未登录:默认解析到该 BYOK 模型,发送成功;
4. 「登录期选过代理模型 → 登出 → 重启」:不静默沿用残留选择,默认链正确降级,picker 如实显示原选择不可用的原因;
5. 已登录 + 代理活:REQ-056 既有默认行为不回归(含单测锁的 engine defaultModel 语义不动);
6. Image #4 所示 UI 展示问题真机复现定位并随本项修复;
7. 零改上游源码;真机截图核验([[visual-verify-required]])。

## 非目标

- 不改 B 侧网关预授权语义(拒绝是正确防线,本项只消灭「默认就撞上它」的流程);
- 不做登录前的租户 edition 探测(未登录一律按默认 edition 视图);
- 不动引擎 defaultModel 语义(REQ-056 单测已拦过一次误改)。
