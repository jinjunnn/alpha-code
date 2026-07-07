---
id: B3
title: 云协同最后一公里:dispatch → 进度 → artifact 回流(=G4/E12)
type: feature
priority: P1
status: archived
repo: X
created: 2026-07-03
sprint: 2026-07-03-s11-cloud-loop
source: 册 §一 P1 / T4.1-4.3 / R1
---

## 背景/证据
从未有一次 A→B→A 云闭环被证明:cloud MCP 每启动 failed、`window.api.cloud.*` preload 桥零调用、dispatch skill(task contract)未建。**R1 修正:勿切端点**(workers.dev 是唯一路由 /v1 的 host),真因更可能 token 注入时序;cloud MCP URL 待 discovery 契约的 `endpoints.mcp`(见 `platform-endpoint-discovery-contract.md`)。

## 验收标准(= GOALS G4)
1. 登录 → cloud MCP status=connected;
2. 会话内经 `cloud.*` 工具发一次真实 research dispatch → SSE 进度 → **结构化结果/artifact 回流**;
3. dispatch skill 产出 task contract,schema 硬校验能拒残缺契约;
4. 云任务呈现为会话内工具调用 + 流式进度消息(轻量状态,不建任务管理中心);
5. artifact 落点按 ADR-019 进 `.alpha/`;
6. 失败可在会话内重试;dispatch 前配额/预估可见(account IPC 已有,差 UI)。

## 验证记录
- **2026-07-03(B 链全绿,零代码改动)**:dev-token 窗口法(临时 dev 化 → 测 → 立即回滚复验 401)
  对 prod worker 实证三套 e2e:cloud jobs API **13/13**(research pipeline 结构化结果、T1 计量出数
  `cost_usd:0.000258`、T2 沙箱真实写文件)· MCP facade smoke **PASS**(四工具 + await→completed)·
  SSE **7/7**(有序事件 + Last-Event-ID 重放)。验收③ schema 硬校验(400)✓。证据:
  [audits/2026-07-03-b3-cloud-loop](../audits/2026-07-03-b3-cloud-loop.md)。
- **背景纠偏**:「cloud MCP 每启动 failed」的 MCP URL 根因(gateway/mcp 404)已由端点发现契约闭环解决
  ——alpha-web `lib/endpoints.ts` 随 token/refresh 下发 `endpoints{cloud,mcp}`,applyAuthEnv 改从
  ep.cloud 派生;token 注入时序由 A6 `{file:}` 通道 + B2 续期共同稳定。
- **待(verified 门槛,→ 真机批)**:验收①②④ in-app 闭环(登录态 agent 经 mcp.cloud 调
  cloud_dispatch → 会话内回结果);验收⑤ artifact 落 `.alpha/` 依赖 REQ-004 spike(单列);验收⑥
  配额 UI 差一块(→ B11 呈现面)。

## 关联
G4、ADR-019(落点)、C9(数据边界,同场做)、B16(parked,上线前重启)、C23/REQ-003(SSE 健壮)、E12。
