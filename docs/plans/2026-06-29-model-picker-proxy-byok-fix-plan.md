# 修复计划:代理 / BYOK "都不通" + 重启友好性 + 重复 effort(2026-06-29)

> 由 4 路独立 codex:rescue 只读诊断 + 本会话上下文综合。**新 session 按此执行**。
> 纪律:**一次只修一项,在真机(打包版 /Applications/alpha-code.app)验证后再下一项,不要批量**。本会话之前正是批量改导致连环回归。

---

## 核心洞察:"代理和 BYOK 都不通" 是**同一个** bug(P0 崩溃),不是两件事

opencode 在 `prompt_async` 里就崩了(发任何模型前),所以**每条 prompt 都无输出** —— 代理、BYOK 一起死。先修 P0,两者大概率一起复活。

---

## P0 —— 致命:每条 prompt 崩溃(ADR-006 运行时世界)【最高优先】

**证据**(codex 实测,日志在 `~/.local/share/opencode/log/opencode.log`,**不在**桌面 `server.log` —— 这就是之前 grep server.log 空的原因):
```
prompt_async failed … Cannot find module
'/Users/tide/app/alpha-code/packages/plugin/src/tool.js'
imported from /Users/tide/app/alpha-code/packages/plugin/src/index.ts
```

**根因链**:opencode `ToolRegistry`(`packages/opencode/src/tool/registry.ts:172`)运行时动态 import 项目目录的 `.opencode/tool/*.ts` → 它们 import `@opencode-ai/plugin` → 该包 `package.json` exports 指向**生 TS**(`src/index.ts`)→ `src/index.ts:15` `import './tool.js'` 但磁盘只有 `tool.ts` → Electron-Node 不做 `.js`→`.ts` 重写 → 崩 → `SessionPrompt.run` 抛错 → 无输出。这正是 **ADR-006** 警告的"两个运行时世界"。

**关键判断(新 session 先确认)**:崩溃路径是**源码仓库路径**,说明 opencode 在加载**某个打开项目目录**里的生 TS 工具。CLAUDE.md/ADR-006 明确写过「**别把 fork/opencode 仓库本身当工作项目打开**(带生 TS 工具会 crash)」。**极可能是:用户把 `/Users/tide/app/alpha-code` 仓库当项目打开了** → 触发崩溃 → 全不通。也可能这条日志是早先被杀的 `bun run dev` 实例残留 —— **务必先复现确认**。

**第 1 步(验证 + 可能即解)**:
1. 看当前打开的是哪个项目;若是 alpha-code 仓库(或任何含生 TS `.opencode/tool/*.ts` 的项目)→ **换一个干净的普通项目**(无 `.opencode/tool/*.ts`)→ 重发消息 → 崩溃应消失,BYOK 应通(代理见 P1)。
2. 确认 `~/.local/share/opencode/log/opencode.log` 末尾的崩溃是**当前打包版**产生的(对时间戳),而非 dev 残留。

**真修(若需在任意项目都稳,或要保留自有 `.opencode/tool`)**:按 ADR-006,自有/上游生 TS 工具必须**预编译成自包含 JS**:
- 给 `packages/plugin` 加 build(`src/index.ts`+`src/tool.ts` → JS)并改 exports 指向产物;或
- 自有 `.opencode/tool/*` 一律走预 bundle 的 `@alpha-code/ext`,不在运行时解析生 TS。

**验收**:干净项目里,BYOK 模型 + 代理模型各发一条 → 都有返回。

---

## P1 —— 代理二级问题:网关对该 model id 返回 `Not Found`(P0 之后)

**证据**:更早的日志显示模型**确实到达** opencode(`providerID=alpha modelID=deepseek-v4-flash`),但网关回 `AI_APICallError: Not Found`(是 **404 不是 401**,说明 **JWT 鉴权过了**,是路由/模型映射问题)。

**根因**:**已部署**的网关 worker(`alpha-gateway.jinjunnm.workers.dev`)没有路由这个 model id。**属 alpha-platform 侧**:对比 `/Users/tide/app/alpha-platform/packages/gateway/src/worker.ts` 的模型路由表 vs alpha-code `alpha-models.json` 的 `platformModels` ids。多半是**部署的 worker 落后于源码 `registry.ts`** → 需 `wrangler deploy`,或 id 映射缺失。

**验收**:`curl -H "authorization: Bearer <有效JWT>" https://alpha-gateway.jinjunnm.workers.dev/v1/chat/completions -d '{"model":"<每个代理id>",...}'` → 期望 200(非 404)。

**JWT(低优先,待证)**:网关 `worker.ts:39` 期望 `issuer:"alpha-web"`、`audience:"alpha-platform"`、有 `sub`、用 `JWT_SECRET` 签。token 在 `alpha-auth.json` 加密读不到 → 若 P1 修完仍 401 再核对 claims。

---

## P2 —— BYOK DeepSeek(P0 之后)

主因 = P0 崩溃。P0 修好后**重测** BYOK。若仍不行:
- whitelist 从 `deepseek-chat/reasoner` 改成了 `deepseek-v4-flash/pro`(`alpha-models.json`)。若用户**当前选中的模型**是已被移除的 `deepseek-chat` → opencode 丢弃它 → 选中模型失效 → 需**重选** `deepseek-v4-flash`。
- 考虑过渡期 whitelist **同时保留新旧 id**,避免老选择失效;或在 UI 上对"选中模型已下线"做兜底。
- 确认 `deepseek-v4-flash/pro` 对用户的 DeepSeek key 可用(直连 api.deepseek.com)。
> (P3 的 codex 仍在跑;若产出新细节,在此补。)

---

## P3 —— 登录后还要点"启用代理·重启"(体验)

**根因**:代理 provider 配置(`provider.alpha` + key)在 **sidecar fork 时**读;登录发生在 fork 之后 → 运行中的 sidecar 没有它 → 需重启。`enableProxy()` 走整 app relaunch(ad-hoc 签名本地包会**直接退出**,见 ADR-017)。

**方案(择优,新 session 实现)**:
- **A. 原地重生 sidecar**:kill+重 fork utilityProcess 让它重读 env。难点:renderer 的 opencode SDK client + SSE 要干净重连(同端口/密码)。
- **B(推荐,若验证通过). 启动即恒定注册 `provider.alpha`**(baseURL 静态、由 endpoint 解析器给)+ **登录时把 JWT 作为该 provider 的 key 经 opencode 原生 auth 运行时写入**(`PUT /auth/alpha`)→ **无需 fork/重启**。
  - **必须先验证**:opencode 是否对**自定义 `@ai-sdk/openai-compatible`(自带 baseURL)provider** 使用 auth.set 的 api key?`provider.ts` 里多处用 `auth?.type==="api"?auth.key`(如 gitlab/cloudflare 行 601/734/781),但**通用 openai-compatible 路径**需逐行确认。确认 yes → 走 B。
> (P1 的 restart codex 仍在跑;A/B 结论以其为准补全。)

---

## P4 —— 重复 effort 控件(composer)【codex 已给确定结论,低风险】

**根因**:alpha 的「⚡高」`EffortChip`(`composer-inject.tsx` 注入)加进来时,**从没给原生 effort 控件加隐藏 CSS**。原生控件 = `data-component="prompt-variant-control"` / `data-action="prompt-model-variant"`(就是「默认 / 切换思考强度 ⇧⌘D」那个,源在 `packages/app/src/components/prompt-input.tsx`)。**不是回归**,是一直漏了。

**修复**:在 `packages/ui-mac/src/renderer/alpha-ui/composer-reskin.css` 加(仿现有 attach 按钮隐藏规则):
```css
[data-component="session-composer"] [data-component="prompt-variant-control"],
[data-component="session-new-composer"] [data-component="prompt-variant-control"] {
  display: none !important;
}
```

---

## 工作区状态(新 session 必读)

- **已提交**:`3139c42`(第一轮:代理模式激活修复 + BYOK P1-P3)。
- **未提交(本会话第二轮,在 `alpha` 工作区)**:BYOK 读 auth.json 检测 + 隐藏未配置 + 删"管理"按钮、v4 模型 id、网关 URL 修正(`api.tidelabs.click`→`alpha-gateway.jinjunnm.workers.dev`)、**端点架构重构**(`alpha-endpoints.ts` 解析器 + IPC + 登录发现 + renderer 去 baked)。typecheck+build 过,但**真机未验证通**。
  - ⚠️ v4 id 变更可能正是 P2(老选择失效)诱因 —— 决定保留/改/回退时一并考虑。
  - 还有一份给 alpha-platform 的 ① 发现契约 `docs/platform-endpoint-discovery-contract.md`。

## 执行顺序(建议)
1. **P0**(崩溃)—— 先确认是不是"打开了仓库当项目";干净项目验证 BYOK+代理是否复活。
2. **P4**(一条 CSS,最稳)。
3. **P1**(网关 Not Found,alpha-platform 侧 redeploy/路由)。
4. **P3**(重启友好性,走 B 若验证通过)。
5. **P2** 兜底(whitelist 新旧并存 / 选中失效兜底)。
- 每步真机验证后再下一步。
