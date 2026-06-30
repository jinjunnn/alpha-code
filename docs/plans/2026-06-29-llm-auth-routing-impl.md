# 完整实施方案 — 方案 C(LLM 路由 / auth)2026-06-29

> 设计来源:`docs/designs/2026-06-29-llm-auth-routing/design.md`(决策已锁,§0)。
> 现状已**逐条核实**(读源码 + git diff,非臆测)。
> 纪律:**零改 opencode 源码;一次只落一个 Phase,真机(打包版)验证通过再下一个。**
> P0「打开本仓库崩溃(生-TS 工具)」是**独立项**,不在本方案内 —— 但工作区现有一处 codex 未验证改动要先处置(见 §0)。
>
> **进度(2026-06-29)**:Phase 0 ✅(revert codex 的 `sidecar.ts`;`deepseek-v4-flash/pro` 经 DeepSeek API 实证为**真实 id**,保留)· Phase 1 ✅(BYOK 钥匙串 `alpha-byok-keys.ts` + opt-in 自定义 provider 注入 + auth.json 出 call-path + setKey/removeKey IPC/UI;typecheck+build 通过;**已 ship 到 /Applications,待真机验证**)· 下一步:Phase 4(原地重生 sidecar,去掉重启摩擦)/ Phase 5(自定义节点 key 入钥匙串)。

---

## 0. 先决:清理工作区到「已知良好」基线(动方案 C 之前)

工作区现在混着**两批**未提交改动,必须先各自定性,否则又会"批量改→连环回归"。

### 0a. codex 的 `sidecar.ts` 改动(P0,未验证)— **建议 revert**
- 内容:`+24` 行,top-level 调 `registerProjectTypeScriptResolver()`(`node:module` `registerHooks` 的 `.js`→`.ts` resolve hook)。
- 风险:**在 sidecar 启动期注册**,若 `registerHooks` 在本 Electron(Node 22.x)`utilityProcess` 里不可用/行为异常 → **每次启动崩 sidecar**(疑似"启动不了了"诱因)。codex 被中止,**从未实测**。
- 它属 **P0**,与方案 C 无关;且你已明确「codex 只分析、不改代码」。
- **建议:`git checkout -- packages/ui-mac/src/main/sidecar.ts` 还原**。P0 等方案 C 落定后,由我**亲手 + 真机实测**单独做(逻辑可借鉴它,但要验证 `registerHooks` 可用性)。

### 0b. 第二轮模型/端点改动(部分对齐方案 C)— **分类保留/删/验**
| 改动 | 处置 |
|---|---|
| `alpha-endpoints.ts` / `endpoints-ipc.ts` / `use-alpha-endpoints.ts`(端点发现:env>pin>discovery>default) | **保留**(基建,正交、有用) |
| `alpha-account.ts` 端点化、picker 额度门控(out/empty/balance/member) | **保留**(方案 C 的"可用性模型"已基本在此) |
| `ext-config.ts` `readAuthStoreKeys()` + `model-picker` 的 "auth" 来源显示 | **删** —— 违背决策#4「opencode auth 出局」 |
| `alpha-models.json` 改的 model id(`deepseek-v4-flash/pro`、`glm-5.2`) | **验证** —— 必须是厂商真实 API id,否则 BYOK 直连 400/404(疑似旧"P2") |

> 产物:一个 typecheck+build 通过、真机冒烟过的基线(代理能连/未登录能用 BYOK),再开 Phase 1。

---

## 1. 现状核实(已读源码)

**已有、可复用:**
- `buildAlphaModelConfig()`(`alpha-models.ts:65`):代理=自定义 provider(`ALPHA_BASE_URL` 在时注入);BYOK=builtin `{whitelist}`;user custom 合并进 allowlist。
- picker 三组(代理/BYOK/自定义)+ **额度门控**(`model-picker-inject.tsx:64` `state()`=out/empty/balance/member、`accountLocked`、`proxyConnected`)。
- account/quota 拉取(`alpha-account.ts` → `/v1/account/summary`,JWT,境内)。
- 自定义节点(`persistProvider`→`opencode.jsonc`,`ext-config.ts:169`)、连接测试(`provider-test.ts`)、keyStatus(env/config/auth)。
- IPC:`window.api.{models.catalog, providers.{add,test,keyStatus,remove}, account.{summary,transactions}, auth.*, endpoints}`。

**与方案 C 有差距,要改:**
- BYOK 注入 = `{whitelist}`(无条件、依赖 models.dev)→ 需 **opt-in 的自定义 provider(写法 a)**。
- key 来源含 opencode `auth.json` → 需 **alpha 钥匙串**,删 auth.json。
- 无 in-place respawn(`index.ts:96 killSidecar` + `:178 relaunch` 走**整 app 重启**)→ 需 **原地重生 sidecar + renderer 重连**。

**关键架构约束(决定实现形态):** `safeStorage` 仅主进程可用;config 由 **sidecar(utilityProcess)** 组装。
→ BYOK key 钥匙串存**主进程**,(重)fork 前**解密注入 env**(沿用现有 `keyEnv` 通道),sidecar 端 `buildAlphaModelConfig` 仍只读 env。改 key ⇒ 需重 fork(正是 Phase 4 的价值)。key 一律 **inline 已解析值**(不用 `{env:VAR}` 模板,避开 Explore 存疑点)。

---

## 2. 分阶段实施(每阶段:文件 → 改动 → 真机验收)

### Phase 1 — BYOK 钥匙串库(主进程)+ 删 auth.json 依赖
- 新增 `main/alpha-byok-keys.ts`:`safeStorage` 加密存 `{ [providerId]: key }`(仿 `alpha-auth.ts` 的落盘/0600/钥匙串);`get/set/remove/listConfigured`。
- `main/index.ts`:(重)fork 前,把 keychain 里每个 key 解密 → 写入对应 `keyEnv`(catalog 的 `byokProviders[].keyEnv`)到 sidecar env(类似 `applyAuthEnv`)。
- `ext-config.ts`:**删** `readAuthStoreKeys`/`removeAuthStoreKey`;`getProviderKeyStatus`(`alpha-models.ts:40`)来源改为 **keychain(+env 兜底)**,去掉 "auth"。
- `alpha-model-types.ts`:`source` 去掉 `"auth"`。
- IPC:`providers.setKey(id,key)` / `providers.removeKey(id)`(写 keychain)。
- **验收**:填 key→重启→`keyStatus` 显示 configured(来源 keychain);无 opencode auth 参与。

### Phase 2 — BYOK 注入改写:opt-in 自定义 provider(写法 a)
- `alpha-models.ts` `buildAlphaModelConfig`:BYOK 段从 `{whitelist}` 改为:**仅当该 provider 在 env 有 key** 时,注入完整自定义 provider:
  `provider[id] = { npm: compat→@ai-sdk/openai-compatible|@ai-sdk/anthropic, name, options:{ baseURL, apiKey:<解析值> }, models:{...ids} }` + 入 allowlist。
- `alpha-models.json`:`byokProviders[]` 即唯一目录(已有 baseURL/compat/models);新增厂商/模型只改这份 JSON。
- **验收**:配了 key 的 BYOK 节点出现且可发消息(直连厂商);没配 key 的不出现(opt-in);未登录也能用 BYOK。

### Phase 3 — 可用性模型收口(对齐 design §0.9)
- 复核 `model-picker-inject.tsx` 的 `state()`:未登录→仅 BYOK;`empty`(额度 0)→锁代理、留 BYOK;`balance/member`→代理可用。基本已就位,按 §0.9 校准文案/按钮。
- 代理 provider 仍仅登录(`ALPHA_BASE_URL`)时注入;额度 0 时 UI 锁(已有)。
- **验收**:四态(未登录 / 有额度 / 额度尽 / 已订阅)行为符合 §0.9。

### Phase 4 — 原地重生 sidecar + renderer 重连(替换整 app relaunch)
- `server.ts`/`index.ts`:加 `restartSidecar()` = `killSidecar()` → 重 `spawnLocalServer`(同 port/password),**不** `app.relaunch()`。
- renderer:sidecar ready 后,重建 opencode SDK client + 重连 `/global/event` SSE(复用 `awaitInitialization()` 的 url/password)。
- `alpha-auth.ts`:`enableProxy`/`setAuthMode` 由 `relaunchApp()` 改调 `restartSidecar()`;login/加 key 同走。
- **验收**:登录后**不整 app 重启**即出现代理模型;加 BYOK key 后**不整 app 重启**即出现该节点。
> 风险最高一阶,单独做、单独验;若 renderer 重连不稳,**回退到现状的整 app relaunch**(功能不丢,仅体验差)。

### Phase 5 — 自定义节点(目录外)对齐
- `persistProvider`/AddProvider:key 写 **keychain**(不再 inline 进 `opencode.jsonc` 的 `options.apiKey`);provider 元数据(baseURL/compat/models)仍可落 `opencode.jsonc` 或 alpha 自有存储,注入时按写法 a + keychain key。
- **验收**:加一个目录外自定义厂商(baseURL+key+model id)→ 可用、key 在钥匙串、重启后仍在。

---

## 3. 文件清单(全部 `packages/ui-mac/*`,零改 opencode)
- 新增:`main/alpha-byok-keys.ts`。
- 改:`main/alpha-models.ts`、`main/ext-config.ts`、`main/index.ts`、`main/server.ts`、`main/provider-ipc.ts`、`preload/{index,types}.ts`、`shared/alpha-model-types.ts`、`renderer/alpha-ui/model-picker-{inject,add}.tsx`、`alpha-auth.ts`(respawn 接线)。
- 数据:`main/alpha-models.json`(BYOK 目录 = 真源)。

## 4. 风险与回退
- Phase 4 respawn 最险 → 失败回退整 app relaunch。
- v4 model id 未证 → Phase 0b 先验。
- keychain 在 utilityProcess 不可用 → 已用「主进程解密→env」规避。
- 每 Phase 独立 commit + 真机验,任一回归立即单点回退。

## 5. 验收总则(对齐 design §0)
代理=单 provider 多 model id;BYOK=opt-in 直连节点(目录在 alpha-code);key 走钥匙串;opencode auth 全程不参与;未登录用 BYOK、登录+额度用代理、额度尽锁代理留 BYOK;**零改 opencode 源码**。
