---
id: REQ-001
title: 网关 allowed-providers/models 白名单接口 + 客户端按版本显隐
type: feature
priority: P1
status: ready
repo: X
created: 2026-07-03
sprint: 2026-07-03-s9-proxy-e2e
---

## 背景(为什么)
前端应用后期有**两个版本**:国内版(只提供 DeepSeek 等国内模型)、国际版(世界模型)。当前 alpha-code 的 provider/model 展示不受网关控制:BYOK 内置目录全量注入(见 memory [[alpha-byok-key-model]]:connected = configured ≠ keyed),平台 `alpha` provider 的模型仍是占位 `alpha-default`(`alpha-models.ts:60` TODO,见 `docs/platform-integration.md` 待办③)。需要网关(B)成为「允许哪些 provider / model」的权威源,alpha-code 据此装配与显示。

## 目标(做什么)
1. **B 侧**:网关提供 edition/租户级白名单接口——建议扩展既有 `GET /v1/models`(或 `/v1/account/summary` 带 `edition` + `allowed`),返回该租户所属版本允许的 provider 列表与 model id 列表;edition 在网关侧可配,改配置不发版。
2. **A 侧**:平台模式下 model picker / 模型装配按白名单过滤;`alpha` provider 占位模型接成 B registry 真实 model id(消灭 `alpha-default`);BYOK 目录是否同样受 edition 收窄 → 产品决策点(国内版可能连 BYOK 目录也要收窄)。

## 验收标准(可验证,逐条)
1. 网关接口返回 edition-scoped providers + models,契约文档化(续 `docs/platform-endpoint-discovery-contract.md` 风格,或并入其中);
2. alpha-code 平台模式 picker 仅显示白名单内 provider / model id;真机截图核验([[visual-verify-required]]);
3. 网关侧切换 edition 配置后,客户端**不发版**即生效(重新登录或刷新即可);
4. 接口失败 / 断网降级:回退内置 snapshot,picker 不空白、有明确提示(B20 纪律);
5. BYOK 是否受白名单约束有明确决策记录(行为 + 文档一致)。

## 非目标
- 不做多租户计费 / 配额变更(既有 PA 系列覆盖);
- 不改 opencode provider 机制本身(注入仍走 `OPENCODE_CONFIG_CONTENT` / env 接缝,ADR-002/007)。

## 方案 / 关联
- 收编 **D2**(`/v1/models` live 同步 IPC 死代码 → 接进 picker,而非删除);
- 解决 `docs/platform-integration.md`「已知问题/待办」③(占位模型 id);
- 关联 REQ-002(联调环境)、C4(models.dev 关闸后目录来源)、memory [[alpha-proxy-activation-chain]]。

## 验证记录
_verify 时补。_
