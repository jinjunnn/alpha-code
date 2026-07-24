---
title: Model catalog updates (platform proxy & BYOK)
kind: runbook
status: active
owners:
  - alpha-code maintainers
last_reviewed: 2026-07-23
review_after: 2026-10-23
---

# 模型清单更新 runbook(代理节点 / BYOK)

两条链路真源不同,别改错地方:

- **代理节点(经 ALPHA 代理)**:真源 = alpha-platform 网关 registry
  (`packages/gateway/src/models.config.json`)+ edition 白名单。app 启动/开
  picker 时经 `GET /v1/models` 同步,**加模型不需要发 app 版本**。
- **BYOK(自带 KEY 直连)**:真源 = alpha-code 本地 catalog
  (`packages/ui-mac/src/main/alpha-models.json`),打进安装包,**改完必须
  `ship:mac` 重建安装**。内置 BYOK provider 的**显隐**额外受网关 edition
  白名单控制(模型 id 不受)。

## A. 代理节点加/换模型

前置判断(缺一不可,否则上架即死路由):

1. **至少一条可路由的 route**:平台持有该家原生 key,或 OpenRouter 已上架该
   模型(千问系截至 2026-07-23 无原生 key、纯 OpenRouter 兜底 ——
   qwen3.8-max-preview 因 OpenRouter 未上架而无法上代理节点,就是这个卡点)。
2. **真实定价**:`routes[].pricing`(USD/Mtok)直接驱动 ledger 计价,必须与
   上游实价一致,不许估。

步骤(全在 alpha-platform):

1. `packages/gateway/src/models.config.json` → `models` 加条目:
   `minPlan`(free/member)、`enabled`、`routes[]`(顺序即优先级:原生在前、
   OpenRouter 兜底;每条含 provider/upstreamModel/baseURL/wire/pricing)。
   换代时旧 id 进 `aliases`(存量默认模型/结算不炸;`/v1/models` 只列当代)。
   策展政策:每家只保留最新一代(2026-07-05 拍板)。
2. edition 白名单**双落点同步**(cn 版要可见就都要加):
   - `packages/gateway/src/registry.ts` `DEFAULT_EDITION_CONFIG.editions.cn.models`(代码兜底);
   - `packages/gateway/wrangler.jsonc` `vars.EDITION_CONFIG`(运行时权威)。
3. 测试:gateway 包 `bun test`(models-config/edition 套件校验配置形状)。
4. 部署:gateway worker `wrangler deploy`。
5. (可选,建议)alpha-code `alpha-models.json` → `platformModels` 加展示富化
   条目(name/tier/reasoning/variants)——不加也能用,但 picker 显示裸 id、无
   档位标签;variants 即推理档位(REQ-029/055)。此项要 `ship:mac` 才生效。
6. 验证:重启 app → picker 代理节点组出现新模型 → 真发一条消息(走通
   invoke→ledger 全链),盘一眼 ledger 计价 route 是否命中预期。

## B. BYOK 加模型 / 加 provider

1. `packages/ui-mac/src/main/alpha-models.json`:
   - 已有 provider 加模型:`byokProviders[].models` 数组加 registry 真实
     model id(如 alibaba 加 `qwen3.8-max-preview`)。
   - 新 provider:整段新增 `{ id, name, compat(openai|anthropic), baseURL,
     keyEnv, pico, models }`;要出现在「添加节点」快捷卡加 `preset: true` +
     `presetIds`。**同时**去 alpha-platform 把 id 加进 edition 白名单
     `byokProviders`(双落点同上),否则 cn 版被网关隐藏。
2. `bun test src`(alpha-models 套件校验 catalog 形状)。
3. `ship:mac` 重建安装(catalog 打包进 app;install-local 会用稳定 Developer
   ID 签名,不再触发钥匙串重弹)。
4. 验证:重启 app → BYOK 组新模型出现(该 provider 已配 key 即亮)→ 选中发
   一条消息。BYOK 不经网关、不产生平台计费;模型能不能用取决于用户自己的
   key 权限(preview 类模型可能需要上游侧开通,如阿里 Token Plan)。

## 常见坑

- **模型 id 用 registry 当代真实 id**;换代走 `aliases`,不要留旧 id 在清单里。
- **edition 白名单是双落点**(registry.ts 兜底 + wrangler.jsonc 运行时),改一半
  = 本地测试与线上行为分叉。
- **pricing 不准 = ledger 记错账**,上架前对一次上游价目页。
- 引擎侧 v1/v2 双配置通道由 sidecar 自动双投影
  (见 [engine-config-channels](../contracts/engine-config-channels.md)),
  本 runbook 的改动**不需要**碰引擎配置。
- preview/实验模型在展示名里带 "Preview" 字样,避免用户当正式版依赖。
