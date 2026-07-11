# alpha-code ↔ 云平台(alpha-platform)集成接缝与时序

> 本地侧(alpha-code)如何接入云平台 B 的**模型代理 + host tool + tier agent**。
> 全部走**零-upstream 接缝**(provider 配置注入 / MCP / sidecar,见 ADR-002);不改 opencode 源码。
> 云平台内部设计见 `alpha-platform/docs/design.md`;模型 key 归属见 `alpha-platform` ADR-013 —— **本文件是其"本地侧"**(ADR-013 本体已迁 alpha-platform)。

## 接缝清单(同一鉴权:dev 期 `DEV_PLATFORM_TOKEN` → prod 期租户 JWT)
| 接缝 | 落点 | 作用 |
|---|---|---|
| **模型代理 provider 注入** | `ui-mac/src/main/server.ts` `preferAppEnv()` 或 `OPENCODE_CONFIG_CONTENT`(同 ADR-007/009 注入处) | platform-pays 时把某 provider `baseURL` 指网关 + 带 token;**BYOK 不注入 → 直连** |
| **云 MCP 注册** | `.opencode` config `mcp.servers`(或 sidecar) | 注册 `cloud.dispatch/status/await`(带 token)→ **host tool + tier agent 的统一入口** |
| **身份 / JWT** | app 发起 → 浏览器 OAuth/PKCE 授权(`alpha-code://auth/callback` deep-link 回调,落 `ui-mac/src/main/alpha-auth.ts`)→ web 建 session、签 access+refresh,safeStorage 加密存;dev 期用固定 `DEV_PLATFORM_TOKEN` | 鉴权(代理 + 云 MCP 共用);**web 为 session 唯一权威** |
| **余额 / plan 显示 + 充值** | 读 B(SDK)+ deep-link alpha-web | 钱包 / 月卡 |
| **模式开关** | BYOK(默认)/ platform-pays | 决定是否注入代理、是否需登录 |

## 时序

### A. 开发顺序(**不等 web**;用 `DEV_PLATFORM_TOKEN`)
1. B 起执行核心(代理 + MCP 网关 + Tier-1 + Upstash workflow + ledger),发一个固定 dev token。
2. alpha-code 只做两条:**注入 provider baseURL=网关**、**注册云 MCP**,鉴权用 dev token。
3. 跑通 代理 + host tool + tier agent 全链路 —— **无登录、无 web、无充值**。

### B. 上线运行流程(prod)
1. 下载安装(alpha-web);默认 **BYOK 直连,无需登录/平台**。
2. 要平台代付/云任务 → app 内点「登录」→ **浏览器打开 web 授权页**(app 发起,带 PKCE)→ 用户在 web 登录,web 建 session 并签 token → **`alpha-code://auth/callback` 跳回 app** → app 换 token、safeStorage 存。**web 为 session 唯一权威**(续期/撤销/设备管理都在 web,app 只持 token)。
3. **充值/买月卡**(deep-link alpha-web 微信支付)→ 余额/订阅进 B。
4. 选 platform-pays → app **自动注入** baseURL+JWT(不手动配)→ 模型走代理。
5. host tool + tier agent 经**同一云 MCP + 同一 JWT** 自动可用(**非额外集成步**)。

### C. 授权时序(browser-delegated;web = session 权威;落点全在 `ui-mac` 自有包)
```
renderer「登录」按钮
  → main(alpha-auth.ts): 生成 PKCE(verifier+state) + shell.openExternal
       <ALPHA_WEB_URL>/auth/authorize?client=alpha-code&code_challenge=…&state=…
           &redirect_uri=alpha-code://auth/callback
  → 浏览器: 用户登录,web 建 session、签 (access JWT 短效 + refresh 长效)
  → web 重定向 alpha-code://auth/callback?code=…&state=…
  → main: 现成 open-url/second-instance 管道(index.ts)接住 → 校验 state
       → 拿 code+verifier 换 token → safeStorage 加密存 {access,refresh,sessionId,exp,plan}
       → IPC 推 auth-state 给 renderer(已登录 / 余额 / plan)
  → platform-pays: sidecar.ts 往 OPENCODE_CONFIG_CONTENT 注入
       provider[cloud].options{baseURL=网关, apiKey=JWT} + mcp.servers.cloud(同 Bearer)
```
- **scheme**:注册自有 `alpha-code://`(与 `opencode://` **并存不替换**),避免和官方 opencode desktop 抢注册。
- **注入时机**:`OPENCODE_CONFIG_CONTENT`/`preferAppEnv` 在 sidecar fork 前算一次 → MVP 登录后 **respawn sidecar**(复用 `killSidecar`/`relaunch`);prod 改 sidecar 内 runtime 转发代理(登录/续期不碰 sidecar 生命周期)。
- **session 统一管理**:web 持 session/设备列表、能撤销;app 只持 token,续期失败即掉回 BYOK/登出。"登出所有设备" = deep-link web portal,不在 app 内重做。

## 约束
- 零改 opencode 源码(ADR-002);**BYOK 路径绝不经平台**(直连,无登录)。
- `DEV_PLATFORM_TOKEN` 仅 dev、env-gated、不进客户端二进制、**≠ 模型真 key**(见 `alpha-platform/docs/design.md` §12.3)。
- 代理必须**透明流式**(见 design.md §8.1);云任务进度走 job 事件流、最终结果异步 artifact(§6)。

## 历史已知问题(2026-06-24,账户用量集成 PR #11 后)

> **冻结的历史记录(2026-07-11 cutover)。** 占位模型 id / 接真实
> `/v1/models` 曾登记为 REQ-001，联调计量出数曾登记为 REQ-002；两项均已
> 交付并作为历史证据保留。本节不再承载待办或状态，活跃工作以
> [GitHub Issues](https://github.com/jinjunnn/alpha-code/issues) 与
> [Alpha Delivery](https://github.com/users/jinjunnn/projects/2) 为准。
- **用量曲线/今日今周为 0 = 没有模型流量经 B 被计量(非接口缺陷)**。已两头核实:
  - **B 侧计量链是通的**:`alpha-platform/packages/gateway/src/account.ts` `charge()` → `recordDailyTokens()` → `summary().usageSeries`;prod 经 `worker.ts` 带 `x-reconcile-secret` POST 落 `account-server` 的账本。`/v1/account/summary` 返回结构正常,只是 `usage/usageSeries` 全 0。
  - **根因在 alpha-code 出口**:走 B gateway 的 `alpha` provider 仅当 `ALPHA_BASE_URL` 存在(= 平台模式登录,`applyAuthEnv` 设)才注册(`alpha-models.ts:52`);BYOK provider(deepseek/zhipuai/…)**直连、绝不过 B**(见上「约束」),所以默认无可计量流量。
  - **真 gap(待办)**:`alpha-models.ts:60` 的 alpha provider 模型仍是占位 `models: { "alpha-default": … }`(代码内 `// TODO: replace with the real model id(s)`)→ 即便进平台模式,模型选择也没接到 B `/v1/models` 的真实模型 id,平台用量跑不起来。
  - **让用量出数的条件**:① 平台模式登录 → `ALPHA_BASE_URL` 设 → alpha provider 注册;② 把占位模型接成 B registry 真实模型 id;③ 实际选用 alpha 模型发起调用 → 经 gateway 计量 → summary 出数。
  - **已验证**:本地起 `alpha-platform/packages/gateway`(dev 租户),`/v1/account/summary` 字段/形状 100% 对上 `AccountSummary` 类型;一旦流量过 gateway,`usageSeries` 当天格即累加。
