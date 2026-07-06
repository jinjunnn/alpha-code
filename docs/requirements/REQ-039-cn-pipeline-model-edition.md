---
id: REQ-039
title: cn 租户云管线默认模型适配 —— edition 白名单拦掉 pipelines 默认 claude-sonnet(edition_forbidden)
type: feature
priority: P1
status: shipped
repo: B
created: 2026-07-05
sprint: 2026-07-06-s28-prelaunch-fastlane
source: 2026-07-05 schedule e2e 实锤(REQ-022 部署演练)
---

## 背景/证据(S28 勘探,2026-07-06,全部 file:line 在 alpha-platform)

云管线(research/code-review/docs + 沙箱步)执行走 `/v1/chat/completions`,SMART 槽默认模型硬编码 `claude-sonnet-4.6`(`pipelines.ts:28`);该 endpoint 的 edition 白名单闸(`worker.ts:313-315`,dev 镜像 `server.ts:73-74`)**对所有凭证一视同仁**——不区分服务端 job token 与用户 picker。cn 白名单只放 deepseek v4 两档(`registry.ts:173`)→ cn 租户的云任务/云定时任务必 403 `edition_forbidden`。

**关键不对称(勘探核心发现)**:同为服务端调用的编码 harness 走 `/v1/messages`,那条闸**已对内部凭证豁免**(`worker.ts:537-546`:仅 `auth.via==="jwt"||"apikey"` 才执行白名单,job/dev 豁免,注释明言「云 tier 准入在 dispatch 层已判定」)。chat/completions 闸漏了同款豁免。

- edition 解析链:JWT claim > `EDITION_CONFIG.tenants[tenant]` > `default`(`registry.ts:197-200`);job token 不带 edition claim(`worker.ts:114`)→ prod default=cn。
- 模型归属:A 侧 envelope **无 model 字段**(`cloud-contract.ts:38-42`),模型由 B 侧 harness/pipeline 定 —— 修法全在 B 侧,A 零动作。
- 白名单语义:注释自证为**产品显隐/picker 边界,非计费/安全边界**(`registry.ts:150-151`);计费/tier 由 `accountPreauth`(`worker.ts:333`)独立硬刹。
- 临时处置:`wrangler.jsonc:11-13` 把 dev/运营者租户映射 intl —— 放量后无法枚举真实 cn 用户,不解决。

## 候选修法(S28 简报)

| 案 | 内容 | 成本 | 风险/取舍 |
|---|---|---|---|
| **a. 管线模型按 edition 选择** | dispatch 处解析 tenant→edition 穿进 pipeline;SMART/CHEAP 改 per-edition 表(cn→deepseek-v4);research native-search 槽对 deepseek 切 client 搜索路径(`pipelines.ts:68-72` 已实现) | 高(多调用点 + edition 管道 + 配置面) | cn 云任务用国产模型:代付成本降 ~6x(sonnet 3/15 vs v4-pro 0.55/2.19 USD/Mtok)、数据流向与 cn 合规姿态对齐;管线产出质量换代验证 |
| **b. cn 白名单纳入 claude-sonnet** | `EDITION_CONFIG` cn.models 加 claude-sonnet-4.6 | 最低(1 行 var) | **不可接受 as-is**:闸与 `/v1/models` 同源(`registry.ts:210`)→ cn 用户 picker 直接看到并可直调 claude(定价/策展/合规三漏) |
| **c. chat/completions 闸对内部凭证豁免** | `worker.ts:310-316` + `server.ts:70-75` 包 `if (via==="jwt"||"apikey")`,与 `/v1/messages` 闸(`worker.ts:537-546`)对称 | 低(约 2 行 + 单测补缺口) | picker 不泄漏(/v1/models 不动);计费仍由 preauth 硬刹;**但 cn 用户云任务内容继续送 claude(经 OR)**——数据流向/代付成本维持现状 |

**推荐**:短期 **c**(放量阻断解除,语义 = 修复既有闸的不对称,零新面);**a 作为成本/合规优化后续立项**(c 落地后 a 变纯优化,不再是放量前置)。b 单独否决。

## 验收标准

1. cn edition 租户(不在 tenants 映射里)dispatch research 管线 → job completed,不再 `edition_forbidden`;
2. 云定时任务(schedule → runDueSchedules → dispatchJob)同上;
3. cn 用户 `/v1/models` 仍只列 deepseek v4 两档(picker 零泄漏);cn 用户直调 chat/completions 请求 claude 仍被 403(闸对 jwt/apikey 语义不变);
4. 新增闸的 via-豁免单测(edition.test.ts 只测纯函数、闸分支零覆盖 = 本 bug 漏网原因,须补);
5. dev e2e + prod 部署后 smoke。

## 非目标

- 不动 A 侧(envelope 无 model 字段,维持);
- 不在本 REQ 做 per-edition 管线模型优化(候选 a,拍板后另立);
- 不改 `/v1/messages` 闸与 `accountPreauth` 计费逻辑。

## 拍板记录

- **2026-07-06 用户拍板:「c 案 + a 留册」**——c 案当日落地;a 案立项 [[REQ-049]](P2,放量后按云任务用量/代付成本触发)。b 案否决。

## 处置(S28 shipped,alpha-platform PR #19,prod 已部署)

- `registry.ts` 新增 `editionGateApplies(via)`(jwt/apikey 受闸;job/dev 豁免)——单源;
- `worker.ts` chat/completions 闸接豁免 + `/v1/messages` 闸判定收敛同一 helper(防两闸漂移);`server.ts` dev 镜像同步;白名单(picker)/`accountPreauth` 计费语义零变。
- 单测:edition.test.ts 补闸 via 分支 3 例(验收④,此前零覆盖);270/270 绿;双 typecheck 过。
- dev e2e 绿证(验收①③机制面):`EDITION_CONFIG` default=cn 且 dev 租户不映射 intl → dev 凭证请求 claude-sonnet-4.6 **完整跑通上游补全**;同配置 `/v1/models` 仍只列 deepseek v4 两档。红证 = 2026-07-05 schedule e2e `edition_forbidden` 在册。
- prod:`wrangler deploy` alpha-gateway(Version 463b3fa1)+ smoke(无凭证 chat/completions 401;默认 cn picker 仅 v4 两档,零泄漏)。
- **verified 待**:真实 cn 租户(非运营者账号,不在 tenants 映射)prod 云任务/云定时任务复验(验收①②全链)——放量前执行;临时处置(运营者映射 intl)保留,与本修独立(属账号 edition 归属)。
