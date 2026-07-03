# S9+S10 真机验证批 — 2026-07-03(prod 签名+公证包)

> 方法:`OPENCODE_CHANNEL=prod bun run ship:mac`(Developer ID 签名 + Apple 公证成功)→ 装 /Applications
> → `ALPHA_CDP=1` 启动 → CDP(9222)截图 + main.log 取证。冻结前端首个真机包(ADR-020 后)。
> appId 澄清:CFBundleIdentifier=`com.tide.alphacode`(Gatekeeper/scheme);运行时 userData appId=
> `ai.opencode.desktop`(APP_IDS[prod])——故复用今早 v0.1.0 登录态,同 Developer ID keychain 解密成功。

## ✅ 已验证(真机证据)

| 项 | 证据 | 判定 |
|---|---|---|
| **冻结前端 REQ-010/013** | 首页/onboarding/会话/审查面板/模型选择器全换肤;**用户消息气泡**(546 回归元素)已换肤;截图 prod-home/session/picker | ✅ verified — 冻结整体恢复 6/30 态,无回归 |
| **B6(=G1)** | main.log `alpha-ext: loading plugin bundle { path: .../Resources/alpha-ext/plugin.js }`(初启+respawn 各一次);且 deepseek-v4-pro 真实回包 = ext 加载未崩服务器(ADR-006 zod 跨实例未破) | ✅ verified — 主接缝装载 |
| **A6 {file:} 通道** | main.log 登录后 `alpha-secrets sync: wrote [ALPHA_API_KEY, ALPHA_CLOUD_TOKEN, DEEPSEEK_API_KEY]`;**BYOK 模型调用成功**(key 从 {file:} 解析→真实回包)= 四链路之 BYOK 链复验通过 | ⚠️ 文件通道+BYOK 链已验;**MCP 子进程 env dump(验收②)未做** → A6 保持 shipped,R3 未解 |
| **REQ-001** | main.log `allowlist synced { edition: intl, models: 11, byok: unrestricted }`(3×);picker 显真实 registry id(deepseek-chat/reasoner/v4-flash/v4-pro、gpt-5.4-mini…)**非 alpha-default 占位**;tier/倍率渲染 | ✅ verified — 装配+视觉+消灭占位 |
| **REQ-002 登录** | main.log 冷启 `opening authorize url` → `login complete { mode: platform }`(2s,浏览器已有 session)——新签名包 OAuth 端到端 | ✅ 登录链;④ 见下 |
| **B5 respawn 互斥** | 日志多次 respawn(allowlist 3×/ext 2×)无端口冲突/崩溃 = 单飞合并实际生效 | ✅ 间接验证 |

## ⏳ 剩余(需决策/介入/外部配置)

| 项 | 为何未做 | 需要 |
|---|---|---|
| A6 验收② MCP 子进程 env dump | 需装一个 MCP 并 dump 其 env(macOS ps 不显他进程 env);文件通道+白名单(单测)+ OPENCODE_CONFIG_CONTENT 不再含明文已确立 | 装 MCP 后 dump,或接受白名单单测+间接证据解 R3(用户判断) |
| B2 短 TTL(过期→续期/撤销→降级) | 需临时改 alpha-web `DESKTOP_ACCESS_TTL_SECONDS` 为短值 + 等待过期 | 改 prod alpha-web env(侵入)或本地起 web |
| REQ-002④ logout 停代理不串台 | **会登出用户当前 app 会话**——不擅自做 | 用户授权后执行 |
| B3 in-app MCP 闭环 | 需配 cloud MCP(ALPHA_CLOUD_MCP_URL)+ 会话内 dispatch;B 链已 dev 全绿(另档) | 配 cloud MCP 后会话内验 |

## 旁记(非本批回归)
- 启动瞬态 toast:`无法重新加载 opencode server GET /agent?directory=%2F → 499`——renderer 在 server 就绪前探测 root 目录 agent 端点。疑启动竞态(B11/B20 呈现面域),非今日改动引入;登记观察。
