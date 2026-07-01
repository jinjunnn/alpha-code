# 平台共享密钥单源同步计划 — JWT_SECRET 防漂移(2026-06-29)

> 触发:代理 401 = **部署的 alpha-web 签名密钥 ≠ 部署的网关验签密钥**(本会话实测铁证:app 发的 JWT iss/aud/exp 全对,直接 curl 部署网关仍 401,任何本地 secret 都验不出该签名)。
> 目标:**一处管理 + 双端必然一致 + 结构性防漂移**(确保不再发生)。
> 范围:**alpha-web(签)↔ alpha-platform 网关(验)**。本计划落在那两个仓;alpha-code 只做可选的"诚实报错"(§4)。

## 0. 拓扑澄清(纠正"同步给 alpha-code")
| 组件 | 角色 | 持 JWT_SECRET? |
|---|---|---|
| alpha-web | 登录,用密钥**签** access_token(HS256) | ✅ 签名方 |
| alpha-platform 网关 | `jwtVerify(token, JWT_SECRET, {iss:alpha-web, aud:alpha-platform})` | ✅ 验签方 |
| **alpha-code(本 app)** | 登录拿 JWT → 作为 Bearer **转发**给网关 | ❌ 从不持有 |

→ 需"双端一致"的只有 **web↔网关**。alpha-code 要的是**端点正确**(网关 URL),已由登录 discovery 解决(`alpha-endpoints.ts`),与密钥无关。

## 1. 即时解封(今天,先通)
挑一个强密钥,两端设成同一个,然后重登验证:
```
# 网关(Cloudflare Worker)
cd /Users/tide/app/alpha-platform/packages/gateway
npx wrangler secret put JWT_SECRET     # 粘贴该密钥
npx wrangler deploy
# alpha-web 部署环境(Vercel/CF)的 JWT_SECRET 设成同一个 → 重新部署
```

## 2. 治本(择一,§3 验证两者都加)

### 方案 A(推荐 · 结构性免漂移):JWKS / 非对称签名
- **alpha-web**:改用**私钥**签(RS256/ES256),暴露 `https://alphacodeone.com/.well-known/jwks.json`(公钥集)。
- **网关**:用 `jose` 的 `createRemoteJWKSet(new URL(JWKS_URL))` 验签(自动拉取 + 缓存公钥)。
- **效果**:**两端不再共享任何密钥** → 漂移在结构上不可能;密钥轮换只在 alpha-web 一处做,网关下次拉 JWKS 自动跟随。这是 OIDC/OAuth 的标准做法,也正是你要的"一处管理"。
- **成本**:web 改签名 + 加 JWKS 端点;网关把 `jwtVerify(...TextEncoder(JWT_SECRET))` 换成 `jwtVerify(...remoteJWKS)`。一次性、各一处。

### 方案 B(最小改动):单源真值 + 同步脚本(保持 HS256)
- 建**唯一真源** SSoT,如 `alpha-platform/secrets.env`(gitignore),含 `JWT_SECRET`(+ `DEV_PLATFORM_TOKEN`/`RECONCILE_SECRET`/provider keys)。
- `scripts/sync-secrets.mjs`:读 SSoT → `wrangler secret put` 推到网关各 Worker + 写 alpha-web 部署环境(`vercel env`/CF)同值。
- 挂进 **predeploy / CI**:改密钥 = 只改 SSoT 跑同步;部署前自动同步。
- **代价**:靠流程保证一致(人/CI 不跑同步仍会漂);比 A 弱,但改动小、保留对称密钥。

## 3. 防回归验证(两方案都加)
`verify-jwt-chain` 脚本:alpha-web 签一个测试 JWT → 调网关 `/v1/chat/completions`(或一个 `/v1/whoami`)→ **断言非-401**。挂进"部署后冒烟" + 可手动跑。本质 = 今天那条 curl 的脚本化,作为 CI gate。
> 还可加一条更早的 tripwire:部署时比对 web 与网关的密钥/公钥指纹(A:JWKS kid;B:secret 的 sha256 前 8 位),不一致就 fail 部署。

## 4. alpha-code 侧(本仓,可选小改)
- 不持密钥、无需同步逻辑。
- **可选**:把代理 401 在 model picker/会话里**诚实提示**「平台鉴权未通(JWT 验签失败)」而非静默失败 —— 下次此类问题能一眼定位是平台密钥,而不是耗一天排查。属 alpha-code 自有 UI 改动,零改 upstream。

## 推荐路径
§1 即时解封(今天)→ §2 **方案 A(JWKS)根除** → §3 验证 gate。
若暂时不想动 alpha-web 的签名算法 → 先 §2 方案 B(SSoT+同步脚本)兜底,日后再升 A。

---

## 实现状态(2026-06-29 · 方案 A 已落代码,待部署)

**已改 + 验证(typecheck 双绿 + ES256 sign↔verify round-trip 实测通过):**
- **alpha-web(签名方,ES256)**
  - `lib/jwt.ts`:HS256+共享密钥 → ES256 私钥签(`JWT_PRIVATE_KEY` PKCS8)+ `verifySession` 用公钥验 + 导出 `publicJwk()`。
  - `app/api/jwks/route.ts`(新):公开 `{ keys:[publicJwk] }`(无私钥)。
  - `scripts/gen-jwt-key.mjs`(新):一键生成 ES256 keypair → 打印 `JWT_KID` / `JWT_PUBLIC_JWK` / `JWT_PRIVATE_KEY`。
- **alpha-platform 网关(验签方,JWKS)**
  - `src/worker.ts` + `src/account.ts`:`jwtVerify(tok, JWT_SECRET)` → `jwtVerify(tok, createRemoteJWKSet(JWKS_URL))`;`Env.JWT_SECRET`→`JWKS_URL`;dev token bypass 保留;`src/` 已无 `JWT_SECRET` 引用。
  - `wrangler.jsonc` / `.dev.vars` / `.env`:加 `JWKS_URL=https://alphacodeone.com/api/jwks`。
  - 遗留:`scripts/sign-test-jwt.mjs` 仍 HS256(手动测试用,已被真登录流 + JWKS 取代,可改 ES256 或删);单测走 dev token,不受影响。

## 部署 runbook(你执行 —— 需 Vercel + CF 账号;部署完代理 401 即消)
1. **生成密钥**(私钥只留你机器,别贴聊天):`cd alpha-web && node scripts/gen-jwt-key.mjs`
2. **Vercel 设 alpha-web env(Production)**:`JWT_KID` / `JWT_PUBLIC_JWK` / `JWT_PRIVATE_KEY`(三个都设)。
3. **部署 alpha-web** → 验证 JWKS:`curl https://alphacodeone.com/api/jwks` 应返回 `{"keys":[{"kty":"EC","crv":"P-256",...,"kid":"alpha-web-..."}]}`。
4. **部署网关**:`cd alpha-platform/packages/gateway && npx wrangler deploy`(`JWKS_URL` 已在 `wrangler.jsonc`)。可选彻底无共享密钥:`npx wrangler secret delete JWT_SECRET`。
5. **重登 app** → 选代理模型 → 应通(网关经 JWKS 验签;不再有可漂移的共享密钥)。
> 顺序:alpha-web 先(JWKS 上线 + 开始签 ES256)→ 网关后。当前代理本就 401(无可破坏的好状态),两边部署完重登即好。
> 轮换:以后换密钥只在 alpha-web 重跑 §1 + 重部署;网关经 JWKS 自动跟随,**永不需要再同步**。
