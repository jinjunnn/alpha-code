---
id: REQ-025
title: 自动化 A3 云档位:execution:cloud 注册到 B + 开机拉回 + 数据边界提示(前置 REQ-022/B16)
type: feature
priority: P2
status: in-sprint
repo: X
created: 2026-07-05
sprint: —
source: requirements/REQ-021-automations.md(A3 节)· ADR-022 §6 · requirements/REQ-022-cloud-schedules-platform.md
---

## 背景(为什么)
[[REQ-021]] A3(云档位:app 不在线也按时执行)按分期未做,拆为本独立需求(2026-07-05 建档,同 [[REQ-024]] 的 ID 纪律理由)。**当前被 B 侧硬阻塞**(见下),登记不排期。

## 范围(承 REQ-021 A3 原文)
1. **`execution:cloud`**:保存时经 REQ-022 契约注册 schedule 到 B(envelope 复用 `CloudJobEnvelopeSchema`);离线也执行。
2. **开 app 拉回**:按 REQ-022 `GET /v1/cloud/jobs?since=<ts>&origin=schedule` 拉取错过的 run → `cloud_status/artifacts` → `.alpha/runs/`(复用 cloud-save-run 链路)。
3. **数据边界提示**:云任务的 ADR-021 边界提示在预览卡与详情页强制展示(consent 挂钩点届时随 B16 拍板)。

## 验收标准(承 REQ-021 A3)
1. 创建 cloud 档任务 → 退出 app → 到点 B 侧执行 → 重开 app 自动拉回 run 落盘;
2. 欠费/超配额被拒且 UI 可见原因;
3. 连败熔断后 A 侧列表显示「已自动停用(连败)」(B 侧状态回读);
4. 删除 schedule 后不再触发(负向)。

## 前置(硬,2026-07-05 核查状态)
| 前置 | 状态 | 说明 |
|---|---|---|
| [[REQ-020]] §2(ADR-021 三校验) | ✅ shipped(PR #80;verified 随 REQ-016 D2) | A 侧发起面已就绪 |
| [[REQ-022]](B 侧 schedules,PA-28) | ❌ **proposed 未实现** | B 仓设计在(`alpha-platform designs/2026-07-04-cloud-scheduled-automations.md`),未开工 |
| B 仓 PA-27 P0 整改(计费正确性) | ❌ **in-progress,3 条 prod-switch P0 未清**(AR-1/2/3) | PA-28 prod 放开的硬前置 |
| [[B16]](PIPL consent) | ⏸️ parked | 云档位公开放量前重启评估;A3 dev 自用可先行但发布受此门 |

→ **激活条件**:REQ-022 shipped(PA-28 落地 + PA-27 三 P0 清零)后本档转 ready;届时 ADR-022 §6 按修订记录云档位落地(dispatch 复用 ADR-021 §2 校验)。

## 非目标
离线推送通知(微信/邮件,C/B 仓另议)、web 端 schedule 管理 UI(C 仓)、事件触发。

## 关联
[[REQ-021]](母档)· [[REQ-024]](A2)· [[REQ-022]](B 侧契约)· [[REQ-020]] · [[B16]] · ADR-021/ADR-022。
