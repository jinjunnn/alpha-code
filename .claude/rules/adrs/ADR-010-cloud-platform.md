---
id: ADR-010
title: 云执行平台与派发接缝 — 自建 worker,确定性优先,agency 留在本地
status: proposed
date: 2026-06-18
related: [ADR-002, ADR-006, ADR-011]
---

## 背景
要给 alpha-code 加"云上运行、返回结果"的能力(主场景:非编码任务——调研/抓取/长分析,返回数据)。用户定向:云端**不用 opencode 框架**(独立运行时,可自有 agent core),自建 worker、最大控制。本地仍是 opencode,当编排器。

**(2026-06-18 修订)产品转向面向多用户:云平台为多租户共享、运行不可信用户的任务 → 威胁模型从"单人可信"变"多租户不可信",见原则 6/7 与 [[ADR-011]] 安全段。**

## 决策
1. **统一抽象**:云作业 = `task` 信封;`skill` / `workflow` / `agent` 不是并列选项,而是同一 job 的**三档自治度**(低=固定函数 / 中=固定多步管线 / 高=开放式 loop)。
2. **确定性优先,agency 有界**:litmus =「能否现在写下步骤」。能且复发 → 固定 **workflow + 调度**;能但一次性 → 固定 **skill**;不能 → **有界 agent**(包在薄 durable workflow 里)。**一切都包进 workflow 信封**(哪怕单步),白拿 durability/重试/调度/可观测(实现 = Upstash Workflow/QStash,见 [[ADR-011]])。
3. **派发接缝**:本地 `.opencode/skill`(准入 rubric + 完整性 checklist)让 opencode agent 产出 **schema 约束的 task contract**(inputs / successCriteria / budget / `capabilities[]`)→ MCP `cloud.dispatch(contract)` **服务端硬校验**(skill 软引导、schema 是硬闸门)→ 立即返回 `job_id`,异步;`cloud.await/status` 取结果(先 Poll,通知注入二期)。
4. **原则**:agency 放本地(你盯得住)、确定性放云端(你盯不住);云端只在"步骤真没法预先写下"才放 agent。
5. **有界 agent 硬约束**(无人监督,必须焊死):max iterations / token 预算 / wall-clock / 工具白名单 / tripwire kill / 结构化输出。
6. **准入审计 ⟂ 出口控制是正交两层(纵深防御)**:审计看**静态任务契约**、挡坏**输入**;出口控制限**运行时坏行为**的爆炸半径,且是"运行时审计"成立的前提(不锁出口,箱子绕过网关的动作根本审计不到)。**开放 agent / code-exec 档两者都要;固定 skill/workflow 档审计权重高、出口控制可轻。**
7. **多租户新增需求(待细化)**:租户隔离、认证授权、按租户配额/计费、LLM key 归属(平台付 vs BYOK)、滥用防护。

## 后果
- ✅ 云能力以"少量可靠有界的电动工具"形态存在,组合灵活性交给本地 agent;单人维护可控、成本/失败可预期。
- ✅ 接缝是 MCP + sidecar(承袭 [[ADR-002]]),本地侧零改 upstream。
- ⚠️ 云端是独立运行时,自负其安全/成本/运维(不在 opencode 升级隔离保护内)。
- ⚠️ 多用户上云 = 重大 scope 扩张(NON_GOALS「不服务的用户群」已据此修订);北极星(升级隔离健康度)只约束本地 fork,**不覆盖云端多租户的安全/隔离/计费/运维**——自负。
- 🔭 执行分层、运行时选型、工具注入见 [[ADR-011]]。
