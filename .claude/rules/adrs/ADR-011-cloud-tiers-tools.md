---
id: ADR-011
title: 云执行分层、运行时与工具注入 — 能力路由 + 中央 MCP 网关 + 秘钥 broker
status: proposed
date: 2026-06-18
related: [ADR-010]
---

> 📌 决策(2026-06-18):编排层锁定 **Upstash 全包**(Workflow/QStash + Box);**函数宿主 = AWS ECS**;Box 秘钥注入/出口已核。⚠️ **转多租户后 Tier-3 沙箱选型重开(Box egress 短板)——未写死**,见安全段。

## 背景
承 [[ADR-010]] 的云平台,定执行落点与工具如何注入。自治度(skill/workflow/agent)与执行环境重量是**正交**两轴。

## 决策

### 执行三档 tier(按能力需求路由,非类型枚举)
- **Tier-1 进程内**:ECS 服务直调 Anthropic API,纯 LLM + web,无状态。
- **Tier-2 进程内 + 一次性沙箱**:ECS 调 ephemeral Box 当工具,起→跑→销毁,短/无状态 code-exec。
- **Tier-3 常驻容器**:Box 内原生 Claude Code + 持久 fs + 长记忆。
- agent/skill 只声明 `capabilities[]`,**router 映射到能满足的最便宜 tier**(关注点分离,agent 不知道"Tier-3=容器")。v1 先 Tier-1 + Tier-2,Tier-3 按需。

### 运行时 / 基建(锁定:Upstash 全包,2026-06-18)
- **编排 / durability / 调度 / 状态**:**Upstash Workflow + QStash**(durable steps、默认重试 3、`context.sleep/sleepUntil` 长等待不占用)+ Redis 存 job 状态。
- **Tier-3 / Tier-2 执行**:**Upstash Box**(TS SDK)。`keepAlive` 持久 box = Tier-3(冻结、数周后 resume,原生 `Agent.ClaudeCode` 建箱时配 harness+model+key);非 keepAlive ephemeral box = Tier-2(`box.exec.command` 跑完即弃)。
- **Tier-1**:就是 workflow endpoint 函数内直调 Anthropic API。
- **函数宿主 = AWS ECS**(Fargate)承控制面 / MCP 网关 / workflow endpoint;Upstash(Workflow/QStash/Redis/Box)经 HTTPS 调用。① 非 scale-to-zero(常驻成本)② 需 ALB 公网入口供 QStash HTTP 回调。
- **Box 配置已核**(`Box.create`):`env:{…}` 注环境变量、`agent.apiKey`(支持 `BoxApiKey.StoredKey` 引用 Upstash 存储密钥)、`git.token`、**`mcpServers:[{url, headers}]`**(自定义 URL + auth header)、`skills`。
- ⚠️ **Box 无出口/网络管控**(多源核实,无 egress/firewall/allowlist)→ 见安全段降级。

### 工具注入(三类,别按 skill 捆绑)
- **① 本地状态工具**(bash/file/code,操作箱内 fs)→ **sandbox 内**(多为 runtime 内置)。
- **② 能力/秘钥工具**(search/外部 API/notify)→ **中央 MCP 工具网关**,所有 tier 共用(`tools/list` 发现 + `tools/call` 调用)。
- **③ 确定性胶水**(解析/去重/转换)→ 就是 workflow 步骤代码,**不做成 LLM tool**。
- skill 只声明工具 **allowlist + 每工具预算**,不携带实现;网关按 job 强制最小权限。

### 秘钥与安全(capability-token broker)
- **工具秘钥**(Exa/DB/notify):只在 MCP 网关;box 经 `Box.create.mcpServers:[{url:网关, headers:{authorization:"Bearer <jobToken>"}}]` 接入,**scoped token 走 header、不落 env**。
- **Anthropic key**:首选 `agent.apiKey = BoxApiKey.StoredKey`(Upstash 存储、不内联明文,已核);进阶用 `env.ANTHROPIC_BASE_URL` 指网关代理让真 key 也不进箱(待确认 Box 原生 Claude Code 是否透传该 env)。
- **出口管控(多租户后升为必需)**:云跑不可信用户任务 → 对**开放 agent / code-exec 档**,出口锁死(只通网关)从"可选"变**必需**(它也是"运行时审计"成立的前提:不锁出口,箱子绕过网关的动作审计不到)。**Box 不支持 egress 锁定(已核)= 真短板。**
  - **Tier-3 沙箱选型 = 未定(不写死)**,候选并列,按"任务信任度 × 是否 code-exec"分流:① Box + 降级三件套(可信/低风险) ② 自管 Fargate 沙箱(无 IGW + 出口防火墙,egress 可锁) ③ microVM(E2B/Firecracker,强隔离 + 出口管控)。
  - **降级三件套**(任何用 Box 处必挂):① token 短 TTL + 最小 scope ② 网关侧预算/限流/审计 ③ 箱内不放长效高价值秘钥 → 即便注入亦无可窃。

## 后果
- ✅ 一份能力工具实现服务所有 tier;改工具 = 改网关,不重建 sandbox 镜像。
- ✅ 秘钥不进一次性 sandbox,符合最小权限;"最大控制"落到出口管控。
- ⚠️ 网关是中央 chokepoint(需限流/缓存/可用性);耦合点 = Anthropic Messages API、MCP 契约、所选 sandbox / durable 引擎 SDK。
- ⚠️ 镜像策略:runtime+libs 预烤进镜像(承 [[ADR-006]] "预 bundle"心智),skill/agent 定义启动时从存储拉取,per-job 只注 token + 契约。
- ⚠️ 多租户未决:Tier-3 沙箱选型、租户隔离 / 配额 / 计费随之待定;Box "全包"优势在不可信多租场景被 egress 短板部分抵消,故 Tier-3 不锁死。
