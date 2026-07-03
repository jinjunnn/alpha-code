---
id: B3
title: 云协同最后一公里:dispatch → 进度 → artifact 回流(=G4/E12)
type: feature
priority: P1
status: ready
repo: X
created: 2026-07-03
sprint: —
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

## 关联
G4、ADR-019(落点)、C9(数据边界,同场做)、B16(parked,上线前重启)、C23/REQ-003(SSE 健壮)、E12。
