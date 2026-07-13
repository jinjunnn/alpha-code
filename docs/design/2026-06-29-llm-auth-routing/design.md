# LLM 调用 / Auth / 路由架构设计(2026-06-29)

> 状态:**待你审查**。审查通过前**不写任何代码**。
> 决策来源:本会话上下文 + Explore 对 opencode provider/auth 接缝的实测(见下「接缝事实」)。
> 配图(每方案一张,`docs/design/2026-06-29-llm-auth-routing/`):
> - `option-C-recommended.svg` —— **推荐 · 已选**
> - `option-A-rejected.svg` —— 未选(对照)
> - `option-B-variant.svg` —— C 的"始终全开"变体

---

## 0. 你的决策(已锁定)

1. **代理 = 默认一个 provider**(`provider.alpha`),其下挂多个 model id。
2. **BYOK = 直连节点**(不走网关,直连厂商)。
3. **支持哪些 BYOK provider + 哪些 model id → 全部在 alpha-code 的目录(`alpha-models.json`)里定义。**
4. **auth 全部由 alpha own**:代理用 alpha 自己的 JWT;BYOK 用 alpha 自管的用户 key。**opencode 自身的 auth(Zen 登录 + `auth.json`)一律不用。**

5. **BYOK 节点 opt-in**:仅当用户为该 provider 填了 key 才注入对应节点(默认只代理)。
6. **BYOK key 存储**:safeStorage 钥匙串加密(仿 `alpha-auth.ts`)。
7. **目录外自定义节点:保留** —— 现有「添加节点」(填 baseURL + key + model id)继续可用,作高级逃生口;`alpha-models.json` 的精选厂商为默认。
8. **BYOK 注入方式:自定义 provider(写法 a)** —— alpha-code 完整写出 baseURL/apiKey/models,opencode 照单全收、不查 models.dev。
9. **可用性模型**:未登录 → 仅 BYOK 可用(代理不注入);登录且**有额度** → `provider.alpha` 可用(BYOK 若配了 key 同时在);**额度用尽** → 选择器禁用/隐藏代理模型、保留 BYOK 并提示充值或用自有 key。登录这步用**原地重启 sidecar**(kill + 重 fork,非整 app 重启)无感激活代理。

→ 对应 **方案 C**。

---

## 1. 接缝事实(Explore 实测,决定可行性)

opencode 的"接缝" = `OPENCODE_CONFIG_CONTENT.provider[]` + `enabled_providers` + opencode auth store。alpha 全程只用前两者,零改 upstream。

- **取 key**:自定义 openai-compatible provider 的 key,**config `options.apiKey` 优先**,且**覆盖** `auth.json` 里的 key(`provider.ts:1669`)。→ alpha 用 config 注入 key,**完全绕过 opencode auth.json**。✅ 你的"不用 opencode auth"成立。
- **`enabled_providers` = 硬白名单**(`provider.ts:1342`):设了就只剩这些 provider。
- **自定义 model id 直接被接受**(无 models.dev 校验,`provider.ts:1389`)→ 网关的 `claude-opus-4.8` 等自定义 id 可用。
- **自定义 header 支持**(`provider.ts:1670`,`options.headers` → SDK → 上游)。
- **运行时换 key 不可靠**(model/SDK 缓存不失效)、**运行时加 provider 不可能**(config 仅启动时读)→ 「免重启」的干净做法是**原地重启 sidecar**(kill+重 fork),不是 opencode auth。
- ⚠️ Explore 说「`{env:VAR}` 只对 baseURL 生效、对 key 不生效」——与现有代理能 authed(JWT 过了到 404)矛盾,几乎肯定是漏看了 config 层的 `{env}` 替换。**无论如何设计不依赖它**:alpha 在 Node 侧已有真值,直接 inline 已解析的 key 最稳。

---

## 2. 三方案对照

| 维度 | A 全统一网关 | B 双轨全开 | **C 推荐** |
|---|---|---|---|
| opencode 里的 provider 数 | 1(`alpha`) | 1 代理 + N 个 BYOK(全启用) | 1 代理(默认) + BYOK 按需注入 |
| BYOK 走哪 | **经网关**(vault 存 / 每请求透传) | **直连厂商** | **直连厂商** |
| BYOK 逃生出口 | **几乎没有**(网关挂=全挂) | 直连节点(始终在) | 直连节点(按需,目录定义) |
| 客户端复杂度 | 最低 | 偏高(双套 key/双类 provider 常驻) | 中(默认简单,用了 BYOK 才复杂) |
| 平台/网关复杂度 | **最高**(要收/转/存用户 key) | 低(只跑平台流量) | 低(只跑平台流量) |
| 成本(谁付推理) | alpha 全包(含 BYOK 也过网关) | 平台付平台、BYOK 用户自付 | 平台付平台、BYOK 用户自付 |
| 隐私(BYOK key/prompt) | **都过 alpha 网关** | BYOK 全程不碰 alpha | BYOK 全程不碰 alpha |
| auth | alpha own(+网关存/转 key) | alpha own | alpha own |
| opencode auth.json | 不用 | 不用 | 不用 |

**为什么排除 A**:你明确要「BYOK 直连」。A 把 BYOK 也塞进网关 → 网关变唯一命门、要承担用户 key 的存储/转发(安全与运维负担全压平台),且**没有直连逃生出口**。与你的决策冲突。

**B vs C**:同样「BYOK 直连、目录在 alpha-code」,差别只在**默认是否把全部 BYOK provider 常驻启用**。B 常驻(干净度差、暴露未配 key 的节点);C 默认只代理、**BYOK 加了 key 才注入对应节点**(默认极简,BYOK 是显式逃生口)。→ 取 C。

---

## 3. 方案 C 详细(待你确认)

### 3.1 目录:`alpha-models.json` = 唯一真源(已是此形,做一处精化)

它同时定义**代理**与 **BYOK 直连**支持的 provider 与 model id:

```jsonc
{
  "platformProvider": { "id": "alpha", "npm": "@ai-sdk/openai-compatible" },
  "platformModels": [ { "id": "claude-opus-4.8", ... }, ... ],   // 代理:1 provider,多 model id

  "byokProviders": [                                              // BYOK:直连节点,全在这里定义
    { "id": "deepseek", "compat": "openai",    "baseURL": "https://api.deepseek.com/v1",
      "keyEnv": "DEEPSEEK_API_KEY", "models": ["deepseek-v4-flash", "deepseek-v4-pro"] },
    { "id": "zhipuai",  "compat": "anthropic", "baseURL": "https://open.bigmodel.cn/api/anthropic",
      "keyEnv": "ZHIPU_API_KEY",    "models": ["glm-5.2", "glm-4.5-air"] }
    // …新增 BYOK provider / model id = 只改这份 JSON,零代码
  ]
}
```

**精化点(关键)**:BYOK 直连节点改为**按目录注入「自定义 provider」**(用 `compat`→`@ai-sdk/openai-compatible`|`@ai-sdk/anthropic` + 目录里的 `baseURL`/`models`),**不再依赖 opencode 的 models.dev**。这样「支持哪些 provider/model id」**完全由 alpha-code 定义**(也能支持 models.dev 里没有的厂商),正是你要的。注入形如:

```jsonc
"provider": {
  "deepseek": {
    "npm": "@ai-sdk/openai-compatible",
    "options": { "baseURL": "https://api.deepseek.com/v1", "apiKey": "<alpha 注入的用户 key>" },
    "models": { "deepseek-v4-flash": {"name":"…"}, "deepseek-v4-pro": {"name":"…"} }
  }
}
```

### 3.2 auth(全 alpha,opencode auth.json 出局)

- **代理**:登录拿 JWT → 作为 `provider.alpha.options.apiKey` 注入(网关校验 JWT)。
- **BYOK**:用户在 alpha UI 填 key → 存进 **alpha 自管的密钥库**(建议复用 `alpha-auth.ts` 的 safeStorage 钥匙串加密,而非明文 alpha.env)→ 作为对应自定义 provider 的 `options.apiKey` 注入。
- opencode 的 `auth.json` / Zen 登录:**完全不出现在 UI、不参与取 key**。

### 3.3 免重启:原地重启 sidecar

登录 / 加 BYOK key / 启停节点 → **kill 当前 utilityProcess + 用新 env 重 fork**(不整 app 重启,规避 ADR-017 的 ad-hoc 签名退出),renderer 的 SDK client + SSE 重连同端口/密码。比现状的「整 app relaunch」体验好,也比 opencode auth 运行时换 key 可靠(后者有缓存坑)。

### 3.4 BYOK 逃生出口在哪(明确回答你)

= **alpha-code 目录里定义的 BYOK 直连节点本身**。它们直连厂商、**绕过网关**,所以:网关 404 / 挂了 / 没登录,BYOK 照常可用;key 与 prompt 全程不经过 alpha。这就是逃生口的物理位置。

---

## 4. 子决策(已锁定 · 2026-06-29)

1. BYOK 默认形态 → **加 key 才注入节点**(opt-in,默认只代理)
2. BYOK key 存储 → **safeStorage 钥匙串加密**(仿 `alpha-auth.ts`)
3. 免重启 → **原地重启 sidecar**(kill + 重 fork + renderer 重连);可用性模型见 §0.9
4. 目录外自定义节点 → **保留**(现有「添加节点」baseURL + key + model id 流程)
5. BYOK 注入方式 → **自定义 provider(写法 a)**(脱离 models.dev)

---

## 5. 与现状的差距(实现时的工作量预估,仅供参考)

- 已有:`alpha-models.json` 目录、`buildAlphaModelConfig` 注入、代理 provider、BYOK env-key、key 状态探测。
- 要改:① BYOK 注入从 `{whitelist}` → 自定义 provider;② BYOK key 库(钥匙串) + UI 填 key;③ 原地重启 sidecar + renderer 重连;④ 默认只代理、BYOK opt-in 的启停。
- 全部落 `packages/ui-mac/*`,**零改 opencode 源码**。
