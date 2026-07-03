# Sprint 2026-07-03 s9-proxy-e2e

**目标**:打通平台代理 A→B→A 全链路(登录 → 真实模型流式回包 → 计量出数),在同一登录态环境落地 A6 sidecar env 白名单(唯一 launch-blocker),再接网关 provider/model 白名单接口。
**抽取**:REQ-002、A6、REQ-001(BACKLOG 已翻 in-sprint)。**范围 = 核心链**(用户 2026-07-03 批准);同域顺带(REQ-003/B2/B21/B1)与简单批(REQ-009/C3/D1/D10/D4/C20)未抽取,留 ready 由用户人工分派给并发 session。

| Task | 内容 | 对应 ID | 模型 | 状态 |
|---|---|---|---|---|
| T1 | 真机登录态代理联调:A→B→A 闭环 + 流式回包 + 计量出数(`/v1/account/summary` usageSeries 当日累加);断点逐一入 BACKLOG;结论落 audits/ 或本目录 | REQ-002 | fable | ✅ 核心链 verified(BP-1/2 修复、BP-3→REQ-014);④token 过期/logout 复验未做。audit + [platform `6fe49f3`] |
| T2 | `createSidecarEnv` 改白名单透传;实测第三方 MCP 子进程 env dump 无 `ALPHA_API_KEY`/BYOK/`ALPHA_CLOUD_TOKEN`/`EXA_API_KEY`;T1 环境复验平台代理/BYOK/websearch/cloud MCP 四链路不破;落地后 BACKLOG 记录 R3 门控解除(解锁 A2b、E2/E6) | A6 | fable | ✅ shipped(**PR #40**:白名单 `sidecar-env.ts` + `{file:}` 密钥通道 `alpha-secret-files.ts` 联动,115 tests 绿;**真机 env dump + 四链路复验待做**,verified 后解 R3) |
| T3 | 网关 edition 白名单接口(B 侧)+ picker 按白名单装配显隐(A 侧,收编 D2、消灭 `alpha-default` 占位)⚠️ 验收⑤「BYOK 是否受 edition 收窄」未拍板 —— 撞到即停,不代替决策 | REQ-001 | fable | ☐ |

**依赖**:T2/T3 依赖 T1 环境;T2 完成前 R3 门控不解除。
**并发纪律(本 sprint)**:不设锁,任务由用户人工分派;B1 与 T2 同文件(`ui-mac/src/main/server.ts`),未分派前其它 session 勿动。
**验收真源**:[A6](../../requirements/A6-sidecar-env-allowlist.md) · [REQ-002](../../requirements/REQ-002-proxy-e2e-integration.md) · [REQ-001](../../requirements/REQ-001-gateway-provider-allowlist.md)。

**Gates**:typecheck ☐ · bun test ☐ · 北极星守卫 ☐ · /app:review ☐ · /app:qa(需要时)☐
**回写**:BACKLOG ☐ · CHANGELOG ☐ · verify 记录 ☐ · retro 链接:—
