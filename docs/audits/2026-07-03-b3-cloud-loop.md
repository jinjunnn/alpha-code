# B3(=G4)云协同闭环 E2E 验证记录 — 2026-07-03

> 方法:对**已部署** prod worker(alpha-cloud / alpha-bounded-agent / alpha-pipelines)做 dev-token
> 窗口验证——`wrangler secret put DEV_PLATFORM_TOKEN` + `deploy --var PLATFORM_ENV:dev`,跑完
> **立即回滚**(redeploy 纯 prod + `secret delete`,复验 dev token → 401)。零代码改动,纯链路实证。

## 结论
**B 侧 dev 闭环全通**:dispatch → 执行(双 autonomy)→ SSE 进度 → 结构化结果回流,MCP facade 四工具可用。
G4 成功条件的 B 侧全部命中:真实任务端到端出结构化结果 ✓ · schema 硬校验拒残缺契约(400)✓ ·
有界 agent 预算计量(JobCounter DO,counters 出数)✓。

## 证据(三套 e2e,全绿)

### 1. `e2e-cloud.sh` — cloud jobs API:13/13
- 健康/鉴权负例(无 token 401)/残缺信封 400;
- **pipeline research**:202 queued → completed → 结构化 result(subQuestions/searchBackend…);
- **bounded-agent Tier-1**(非编码):completed,counters `{model_calls:1, tokens_in:61, tokens_out:5, cost_usd:0.000258}`——**计量出数**;
- **bounded-agent Tier-2 code_exec**(沙箱):completed,真实写出 `/workspace/sum.py`,`cost_usd:0.198`;
- 公共视图不含 tier/harness key(越权信息不外泄)。

### 2. `mcp-smoke.mjs` — MCP facade(官方 SDK client,Streamable HTTP):PASS
- initialize 握手 ✓;`cloud_dispatch / cloud_status / cloud_await / cloud_artifacts` 四工具在列 ✓;
- dispatch 返回 job_id + urls ✓;await → completed ✓;坏信封 → isError ✓;无 tier 泄漏 ✓。

### 3. `e2e-sse.sh` — SSE 进度(JobEvents DO):7/7
- pipeline docs:`job.snapshot → job.started → job.running → workflow.step.completed → job.completed` 有序 ✓;
- bounded-agent T1 同构 ✓;**Last-Event-ID 重放不重发 ≤lastId** ✓;/events 鉴权负例 ✓。

## 途中发现与处置
- 唯一障碍 = prod fail-closed(dev token 关闭,审计 #1 纪律**正确**);bounded-agent 与 cloud 各自独立
  鉴权,dev 窗口需两个 worker 同开——已记入运维手法;
- cancel 契约两侧核对:cloud.ts `/v1/cloud/jobs/:id/cancel`(AR-17 soft-cancel)与 A 侧
  `cancelCloudJob` 对齐,无缺口(health 路由自述清单漏列,无碍);
- 端点发现闭环已在 C 侧就位:`alpha-web lib/endpoints.ts` 随 token/refresh 下发
  `endpoints{cloud,mcp,…}`,A 的 MCP URL 不再从模型 gateway 误派生(旧 404 根因);B2 的 refresh
  也会随续期刷新端点。

## 剩余(→ 真机验证批)
in-app 闭环:登录态下 opencode agent 经注入的 `mcp.cloud`(Streamable HTTP + Bearer,A6 后 token 走
`{file:}` 通道)调 `cloud_dispatch` → 会话内拿回结果。artifact 落盘 `.alpha/`(ADR-019)随 REQ-004 spike。
