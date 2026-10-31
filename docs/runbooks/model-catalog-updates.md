---
title: Model catalog updates (platform proxy & BYOK)
kind: runbook
status: active
owners:
  - Code Puppy maintainers
last_reviewed: 2026-10-30
review_after: 2027-01-30
---

# 模型清单更新 runbook(代理节点 / BYOK)

两份清单都由 alpha-platform 网关发布,桌面端后台拉取、校验、采纳;**加模型、改名称 / 能力 / 档位都不需要发 app 版本**
(仍要发版的情形见下文「仍需要发 App」)。方案:alpha-code `docs/design/req236-catalog-and-model.md` §2.1–2.4、§2.9。

- **代理节点(经 ALPHA 代理)**:真源 = alpha-platform 网关 registry
  (`packages/gateway/src/models.config.json`)+ edition 白名单。桌面端经 `GET /v1/models`(ModelCatalogV3)拿到
  edition 内的模型清单、计价倍数,以及每个模型的名称 / 品牌 / 能力 / 档位(`display`)。桌面端**不再**按 id 维护第二份
  展示数据;没有拿到过有效清单时,选择器的平台段为空并写「平台模型清单尚未获取」。
- **BYOK(自带 KEY 直连)**:模型清单与元数据的真源 = alpha-platform 网关的 BYOK 预置目录
  (`packages/gateway/src/byok-catalog.json`,经 `GET /v1/byok-catalog` 发布,ByokCatalogV1)。**从不按账户 / edition 收窄**,
  拉取不带凭据。决定 Key 发去哪的三样东西 —— 端点 `baseURL`、Key 名 `keyEnv`、协议适配器 `compat` —— **只在安装包里**
  (`packages/ui-mac/src/main/byok-adapters.ts`),远程目录带这些字段会被整份拒绝;远程目录里 App 不认识的 provider 会被跳过。
  安装包里的 `packages/ui-mac/src/main/alpha-models.json` 只留一份同形的**首启引导**(`byokCatalog`)。

**刷新与生效**(`catalog-refresher.ts`):刷新点 = 启动、登录身份变化(只拉平台那份)、每 30 分钟、手动重试;
失败保留上次拿到的版本,两份清单的失败分别提示。**已下载 ≠ 已应用**:新清单下载好以后,要等引擎下一次启动
(任何原因的换代,含重启 App)才会被选择器和引擎同时用上;这段时间选择器底部会写「模型清单已更新,将在引擎下次启动后生效」。

## A. 代理节点加/换模型

前置判断(缺一不可,否则上架即死路由):

1. **至少一条可路由的 route**:平台持有该家原生 key,或 OpenRouter 已上架该
   模型(千问系截至 2026-07-23 无原生 key、纯 OpenRouter 兜底 ——
   qwen3.8-max 因 OpenRouter 未上架同名条目而无法上代理节点,就是这个卡点)。
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
5. 同一个条目里写 `display`(必填):`name`、`brand`(`anthropic | openai | deepseek | zhipu | qwen | moonshot | minimax`,
   是**品牌**不是路由腿 —— qwen 经 OpenRouter 路由,brand 仍是 `qwen`)、可选 `reasoning` / `web` / `variants`
   (推理档位,REQ-029/055;选项键只允许 `reasoningEffort | reasoning | thinking`,loader 校验)。它随
   `GET /v1/models` 下发,桌面端**不需要**任何改动或发版。
   ⚠️ 桌面端**不配任何价格**。计价倍数随 `GET /v1/models` 的 `pricing_multiplier`
   下发(REQ-127 #679 / ADR-039),Code Puppy 侧一个价格字段都不许有 —— 曾经有
   过一张本地档位表,它对本地没收录的线上模型一律显示成最便宜的一档
   (claude-fable-5 真实 输入 71.4× / 输出 178.6×,当时显示「标准 ×1」)。
   `src/shared/platform-pricing-authority-ratchet.test.ts` 会拦住它回来。
6. (可选)要换 picker 的**平台默认模型**,改 `alpha-models.json` 顶层
   `defaultPlatformModel`(裸 model id)。它是唯一的旋钮:声明缺席或该 id 不在
   生效目录中,app 就不自动默认任何平台模型 —— 不会替你挑一个便宜的。
7. 验证:部署后等一个刷新点(或重启 app)→ 引擎下次启动后,picker 代理节点组出现新模型、名称与档位是 `display`
   里写的 → 行尾显示的是**两个真倍数**(平台段写「平台模型清单尚未获取」说明这台机器还没拿到有效的 V3 目录)→ 真发
   一条消息(走通 invoke→ledger 全链),盘一眼 ledger 计价 route 是否命中预期。

## B. BYOK 加模型 / 改元数据

在**已有 provider**(App 适配器表里有的那几家)上增删模型、改名称 / 徽标 / 档位 / 能不能看图,全在 alpha-platform:

1. `packages/gateway/src/byok-catalog.json`(ByokCatalogV1):
   - 已有 provider 加模型:`providers[].models` 加 `{ id, name, reasoning?, variants?, image_input }`,id 用上游真实
     model id(如 alibaba 加 `qwen3.8-max`)。**每个模型自带完整元数据** —— 桌面端不再从平台同名条目借名称 / 徽标 / 档位
     (同一模型经直连与经 OpenRouter 形状不同,不得跨腿套用)。
   - provider 级可改 `name`、`brand`、`preset`(是否出现在「添加节点」快捷卡)与顺序。
   - **把 `catalog_version` 加一**(单调递增整数)。桌面端只采纳比本机已有版本(上次采纳的、或安装包首启引导的,取高者)
     更高的文档;要撤一次坏发布,就再发一个更高的版本,不要回退版本号。
   - **不要**写 `baseURL` / `keyEnv` / `compat` / `npm`:schema 不允许,网关装载失败;即使发出去,桌面端也会整份拒绝。
   - 档位表的 wire 形状按 `@ai-sdk/openai-compatible` 写,直连节点能原样复用的前提是每个
     BYOK 适配器都是 `compat: "openai"`(alpha-models 套件钉着)。**显式关闭档**写
       `{ "thinking": { "type": "disabled" } }`,值必须逐字 `disabled`:智谱 2026-09-06 实打,
       `type` 写错(如 `bogus`)会被上游**静默忽略并继续思考,HTTP 仍 200** —— 所以「上游返回 200」
       不是受理证据,`reasoning_content` 有没有才是(勘破记录见
       [`model-variant-reachability`](../architecture/2026-09-06-model-variant-reachability.md) §5)。
       上游 `transform.options()` 对 `zhipuai*` 直连**无条件**写 `thinking: enabled`,所以智谱
       直连的每个模型要么标徽标并给「关」档,要么接受它总在思考。
   - **能不能看图**(REQ-228 #1420):每个模型的 `image_input` 必填 `true` / `false`(schema 判,缺一个整份拒绝),
     值抄自 models.dev 同名模型的 `modalities.input` 是否含 `image`;查的是与该 provider 适配器 `baseURL` 同一端点的
     models.dev provider(`api.moonshot.cn` ⇒ `moonshotai-cn`、`dashscope.aliyuncs.com` ⇒ `alibaba-cn`、
     `api.minimaxi.com` ⇒ `minimax-cn`、`api.deepseek.com` ⇒ `deepseek`、`open.bigmodel.cn` ⇒ `zhipuai`)。查法:
     `curl -s https://models.dev/api.json | jq '."<provider>".models."<id>".modalities.input'`。
     models.dev 里查不到 ⇒ 写 `false`(看不了图,图片交给云端识图),不要按名字猜。引擎侧的最终值由
     `image-input-capability.test.ts` 起真引擎判。
     平台代理模型不读这个字段,一律看不了图(网关聊天入口拒收图片)。
     自定义节点没有上游出处,只认用户在真源记录里显式声明的 `imageInput`(见 `custom-provider-truth.ts`)。
     **实测覆盖记录**:`deepseek-flash`(直连)2026-10-31 实测:`POST https://api.deepseek.com/v1/chat/completions`,
     `model: deepseek-flash`,带 32×32 PNG data URI 的图片请求 ⇒ 200,回答 "Red",223 入 / 23 出 ⇒ 目录改为能看图
     (alpha-platform#565,`catalog_version` 2)。OpenRouter 上的 `deepseek/deepseek-v4-flash` 仍只收文字(2026-09-24 实测),两者不是同一个入口。
2. 新模型 id 上游认不认:有该家 key 时跑 `bun packages/ui-mac/scripts/verify-byok-catalog.ts`(#1281;它查的是
   安装包里的首启引导与适配器表的端点 —— 要验刚加的 id,临时把它加进本机 `alpha-models.json` 的 `byokCatalog` 再跑,
   别提交);没 key 时它会把 id 列进「本次未验证」,不会假装绿。
3. alpha-platform 网关 `bun test`(`byok-catalog.test.ts` 校验 schema、无凭据可读、不读 edition)→ 部署 gateway。
4. 验证:`curl -sS https://<gateway>/v1/byok-catalog` 不带凭据返回新版本 → 等一个刷新点(或重启 app)→ 引擎下次启动后
   BYOK 组出现新模型(该 provider 已配 key 即亮)→ 选中发一条消息。BYOK 不经网关、不产生平台计费;模型能不能用取决于
   用户自己的 key 权限(preview 类模型可能需要上游侧开通,如阿里 Token Plan)。
5. 下次发 App 时可以把安装包首启引导(`alpha-models.json` 的 `byokCatalog`)更新成当时线上那份(同内容、同版本):
   新装用户第一次启动、还没拉到远程目录前看到的就是它。版本**高于**本机已采纳的远程版本时首启引导胜出。

## 仍需要发 App(`ship:mac`)的情形

只有这些(方案 §2.9),其余都走上面两节:

1. 新 BYOK 供应商:新端点 / Key 名 / 协议适配器 —— 加进 `packages/ui-mac/src/main/byok-adapters.ts`
   (`{ id, compat, baseURL, keyEnv, pico }`),同时在 alpha-platform 的 BYOK 目录里发布它的模型。只发目录不发 App,
   旧 App 会跳过这个 provider。
2. 新的推理选项键或新的请求协议(超出 `reasoningEffort | reasoning | thinking`、`openai | anthropic` 适配器)。
3. 新品牌要显示专属图标(数据可先发,图标回落为通用图形)。
4. 目录 schema 主版本变化(V3→V4、byok v1→v2)。
5. 平台模型需要客户端新能力(例如看图要开平台聊天入口的图片通道)。

发版本身:`bun test src` → `ship:mac` 重建安装(install-local 会用稳定 Developer ID 签名,不再触发钥匙串重弹)。

## 常见坑

- **模型 id 用 registry 当代真实 id**;换代走 `aliases`,不要留旧 id 在清单里。
- **edition 白名单是双落点**(registry.ts 兜底 + wrangler.jsonc 运行时),改一半
  = 本地测试与线上行为分叉。
- **pricing 不准 = ledger 记错账**,上架前对一次上游价目页。
- 引擎侧 v1/v2 双配置通道由 sidecar 自动双投影
  (见 [engine-config-channels](../contracts/engine-config-channels.md)),
  本 runbook 的改动**不需要**碰引擎配置。
- preview/实验模型在展示名里带 "Preview" 字样,避免用户当正式版依赖。
- **同步失败有出口**(#1084,`#1556` 起按清单分开):`GET /v1/models` 或 `GET /v1/byok-catalog` 拉不下来、
  或文档校验不过时,窗口顶部会出现一条 warning 横幅,说明是哪一份清单,带分类码(`rate_limited` / `unauthorized` /
  `http-503` / `contract-incompatible` …)。排障时先看它。一份清单成功只收掉它自己那一条,另一份的失败仍然显示。
- **改了没生效?先分清已下载还是已应用。** 选择器底部写着「模型清单已更新,将在引擎下次启动后生效」= 新清单已下载、
  这一代引擎还在用旧的;重启 App(或等下一次引擎换代)即生效。平台段写「平台模型清单尚未获取」= 这台机器还没拿到过
  有效的平台清单(网络 / 登录 / 网关未部署 V3)。
