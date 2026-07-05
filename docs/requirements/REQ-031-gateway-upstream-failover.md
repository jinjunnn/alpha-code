---
id: REQ-031
title: LLM gateway 多上游路由 + 欠费 failover(canonical id → 候选链,原生优先 / OpenRouter 兜底,per-route 计价)
type: feature
priority: P1
status: shipped
repo: B
created: 2026-07-05
---

## 背景(为什么)

2026-07-05 现状核查(alpha-platform `packages/gateway`):

1. **gateway 无任何上游 failover/重试**:`worker.ts:342-351` 单次 fetch,上游非 2xx 原样透传给客户端,fetch 异常返 502。运营者的 provider 账户欠费(如 DeepSeek 余额 0 → 402)= 该系全部模型对所有租户直接不可用,直到人工充值——**单点欠费即服务中断**。
2. **每个 model id 只有一条上游**:`REGISTRY` 每条 entry 单值 `upstreamModel + baseURL`(`registry.ts:6-20`)。DeepSeek 走原生直连(`api.deepseek.com`),Claude 走 OpenRouter(`openrouter.ai`,3 条)+ 一条独立 direct id 直连 Anthropic——同族两条路是**两个不同 model id**,不是同 id 候选链。
3. **id 映射机制已有单值雏形**:`upstreamModel` 字段已做「对外 id → 上游 id」映射(如 `claude-opus-4.8` → `anthropic/claude-opus-4.8`),扩成候选链有现成落点。OpenRouter 命名(`deepseek/deepseek-v4-pro`)与原生命名(`deepseek-v4-pro`)不一致的问题由 per-route `upstreamModel` 解决。
4. 价格表内嵌于 registry(`pricing`),计量 `meterUsage` → 境内 account `/v1/settle` 按 model 查价——**OpenRouter 价 ≠ 原生价**,failover 后按哪个价结算是必须解决的计费正确性问题。

用户诉求(2026-07-05):配置了原生 provider key(如 DeepSeek)则优先走原生端点;该端点余额为 0 时自动 fallback 到 OpenRouter 的同一模型;未配原生 key 的直接走 OpenRouter——避免运营者模型账户欠费导致服务不可用。**只涉及 LLM gateway(B 侧运营者 key),不涉及 A 侧用户 BYOK。**

## 目标(做什么)

1. **配置化候选链**:registry 配置(与 [[REQ-030]] 同一文件)每个 canonical model id 携带 `routes[]`,每条 route = `{provider, baseURL, upstreamModel, wire, pricing}`;数组顺序即优先级(原生在前、OpenRouter 兜底)。单 route 条目行为与现状完全等价(向后兼容)。
2. **运行时选路**:逐候选尝试——该 provider 无 server-side key → 跳过;上游返回**欠费/配额类错误**(402 / provider 特有 insufficient-balance 错误码,按 provider 枚举成集合)→ 试下一候选;全链耗尽 → 按现状透传最后一个错误(loud,不伪装成功)。
3. **上游健康短记忆**:欠费命中后在 KV 写短 TTL 降级标记(如 10-30min),后续请求直接从下一候选起步,避免每请求先撞一次欠费端点;TTL 过期自动恢复探测。不做主动余额轮询(YAGNI)。
4. **计费正确性**:metering/settle 记录**实际命中的 route**(upstream 字段进 ledger),按该 route 的 pricing 结算;preauth 估算按首选 route。
5. **诚实边界**:failover 仅发生在**首响应之前**;SSE 流已开始后上游中断不做中途换路重放(错误透传,复用 REQ-003 的流健壮性语义)。

## 验收标准(可验证,逐条)

1. 原生 key 已配且余额正常 → 请求走原生端点(日志/metering 的 upstream 标注可查);
2. 模拟原生欠费(dev 环境撤 key 换错 key / mock 402)→ 同一 model id 请求自动落 OpenRouter 成功,客户端无感,ledger 记 openrouter route 与其价目;
3. 未配原生 key 的模型首发即走 OpenRouter(不产生对原生端点的无效请求);
4. KV 降级标记生效期内请求不再尝试欠费上游;TTL 过期后恢复尝试(可用短 TTL 实测);
5. 全链失败(两侧都不可用)→ 客户端收到 loud 上游错误,不静默、不假 200;
6. 单 route 存量条目行为回归零变化(既有 e2e/单测全绿)。

## 非目标

- 不做负载均衡 / 按价格或延迟动态选路(顺序优先级足够);
- 不做 A 侧(用户 BYOK 直连)failover——用户自己 key 欠费属用户侧问题,picker/错误呈现另议(B11/B20 域);
- 不做跨 wire 混链:`wire:"anthropic"` 的 direct 条目(claude-opus-4.8-direct)不与 openai-wire 候选混编,本期候选链限同 wire(记录边界,跨 wire 转译另立项);
- 不做流中重试/断点续传(REQ-003 已定语义);
- 不做主动余额查询/告警(欠费被动检测 + 短记忆已满足;告警面将来挂运营监控)。

## 方案 / 关联

- 配置 schema 与 [[REQ-030]] 一次定型(同一 models.config.json),建议同 sprint 相邻排期;
- 错误码枚举参考:DeepSeek 402(Insufficient Balance)、OpenAI 429(insufficient_quota)、OpenRouter 402;实现期逐 provider 核实写死成集合,未知错误码**不**触发 failover(保守:只对确定的欠费/配额类换路,5xx 透传);
- B 侧实现细节落 alpha-platform 仓(ADR-018 §8);与 account 服务 settle 契约变更(ledger 增 upstream 字段)同 PR 联动;
- 关联:[[REQ-003]](SSE 健壮性,流边界语义)、REQ-002(联调环境复用)。
