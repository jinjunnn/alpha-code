---
id: REQ-022
title: 云端定时执行(B 侧):CF cron trigger + schedule registry + 到期 dispatch + A 侧拉回契约
type: feature
priority: P2
status: in-sprint
repo: B
created: 2026-07-04
sprint: —
source: designs/2026-07-04-extension-hub-v3-universal.md(§7 云档位)· alpha-platform designs/2026-07-04-cloud-scheduled-automations.md
---

## 背景/拍板
REQ-021 A3(自动化云档位)需要「app 不在线也按时执行」。勘探实锤:B 侧现无任何调度设施(各 wrangler.*.jsonc 无 `triggers.crons`、无 QStash;CF Workflows 仅按 job durable 执行)。**拍板(2026-07-04)**:立项 B 仓;先计划后实现。**B 侧实现细节真源 = alpha-platform `docs/designs/2026-07-04-cloud-scheduled-automations.md`(PA-28 proposed)**;本档只钉 A↔B 契约与 A 视角验收(ADR-018 §8:B 内部细节留 B 仓)。

## A↔B 契约(A 视角需要什么)
1. **Schedule CRUD**:`POST/GET/PATCH/DELETE /v1/cloud/schedules`(租户 JWT 鉴权;字段:name、cron、tz、envelope(复用 `CloudJobEnvelopeSchema` 全量校验)、enabled、budget 覆盖);每租户上限与最小间隔由 B 端硬校验并在错误中明示。
2. **MCP facade**:`cloud_schedule_create/list/delete`(薄壳,同一 HTTP 真相源,PA-25 口径)。
3. **拉回端点**:`GET /v1/cloud/jobs?since=<ts>&origin=schedule`——A 开机枚举错过的 schedule 触发 job,复用既有 `cloud_status/artifacts` 取结果落 `.alpha/runs/`。
4. **执行语义**:到期 → B 复用既有 dispatch 路径(job token / preauth / ledger 恒 `billable:true`);overlap(上次未终态)skip;连败 3 次自动 disable 且状态在 schedule 对象可见(A UI 呈现原因)。
5. **预算默认**:schedule 触发的 job 默认预算比交互 dispatch 更紧(建议 15 iter/150k tok/300s,B 仓计划文档定稿),envelope 可显式覆盖但不越 B 端上限。

## 验收标准(A 视角,端到端)
1. A 创建 cloud 档任务 → 退出 app → 到点 B 执行(ledger 有账、run 可查)→ 重开 app 拉回 run 落 `.alpha/runs/`;
2. 欠费/超配额时到期不执行且 schedule 状态可见原因;A UI 呈现;
3. 连败熔断后 A 侧列表显示「已自动停用(连败)」;
4. 删除 schedule 后不再触发(负向验证);
5. 全链路数据边界符合 ADR-021(§2 校验在 A 发出前已生效——依赖 REQ-020 T1)。

## 非目标
离线推送(微信/邮件通知)、web 端 schedule 管理 UI(C 仓另议)、事件触发(非 cron)、A 侧 UI(归 REQ-021 A3)。

## 依赖/前置
B 仓 PA-27 P0 整改(计费正确性)先行;REQ-020 T1(ADR-021 §2)是 A 侧发起面的硬前置;B16(PIPL consent)公开开放前重启评估。

**S18 开批拍板(2026-07-05,用户批)**:连带清 B 侧前置——sprint 内顺序 = PA-27 三 P0(AR-1/2/3)→ REQ-030/031(settle/ledger 变更一次做,S18 冲突矩阵 X4)→ PA-28 → 本档契约端点 → REQ-025 A 侧。B16 仅门控公开放量,dev 自用先行。
