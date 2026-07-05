---
id: REQ-001
title: 网关 allowed-providers/models 白名单接口 + 客户端按版本显隐
type: feature
priority: P1
status: archived
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

## 采纳方案(2026-07-03,B=alpha-platform e6e90c1 · A=PR 见 BACKLOG)
- **B 侧**:registry.ts 加 EditionConfig 层(运行时中立);`GET /v1/models` 返回 edition-scoped `data`
  + `edition` + `byok_providers`(null=不限);`POST /v1/chat/completions` 调用时执行(403
  `edition_forbidden`)。配置 = env `EDITION_CONFIG`(JSON),**改 var 即生效不发代码**;解析
  fail-open 回代码内默认(intl 不限 / cn=deepseek 系 4 模型 + 国内 BYOK 五家)。edition 解析:
  JWT `edition` claim(前瞻)> config.tenants > default。契约全文见
  [platform-endpoint-discovery-contract.md](../platform-endpoint-discovery-contract.md) §②。
- **A 侧**:`alpha-live-allowlist.ts` 文件桥缓存(main 写 / sidecar 读,复用 A6 模式);装配与 picker
  目录都按缓存收窄;平台模型以 live 清单为准(真实 registry id,snapshot 名称富化)——**「占位模型 id」
  漂移问题就此消灭**(platform-integration.md 待办③,其 `alpha-default` 表述系文档滞后,代码此前已
  是 snapshot);D2 的 platformLive IPC 收编接进 picker(打开即同步)。降级:失败保留 last-known →
  无缓存回内置 snapshot,picker 永不空白 + 「内置目录」徽标(B20)。

## 决策记录(验收⑤,用户 2026-07-03 拍板)
**BYOK 目录跟随 edition 收窄,用户自定义添加的节点不受限制**——内置 BYOK 目录(deepseek/zhipuai/
minimax/alibaba/moonshot)按 `byok_providers` 显隐;「添加自定义节点」(自填 baseURL/key)不拦,
保留 power user 出口。⚖️ 队列该行已划掉。

## 验证记录
- **2026-07-03(单测/联调级)**:B:typecheck(node+worker)+ 215 tests(+17 edition);prod curl
  `/v1/models` → `edition:intl, byok_providers:null, 11 models`(向后兼容);dev server 以
  `EDITION_CONFIG(default=cn)` 实测 → 目录立即收窄为 2 模型 + byok=[deepseek](验收③「改配置不发版」)。
  A:typecheck + 126 tests(+11:byok 收窄/名称富化/空白名单 fail-open/自定义不拦/损坏缓存降级)。
- **待(verified 门槛)**:真机 picker 截图核验(验收②,[[visual-verify-required]])——随 S9 收尾
  真机批(与 A6 env dump、REQ-002④ 同场)。
