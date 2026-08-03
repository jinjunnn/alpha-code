// alpha 治理的云 MCP server(`cloud`)在引擎配置里的定义。
//
// `#733`(REQ-130):从「塞一个静态 bearer」改成「走标准 MCP OAuth」。
// 这不是翻一个开关 —— 三件事必须同时成立,少一件这条路就是断的:
//
//  1. **`oauth` 必须是对象,不能是 `false`。** 引擎 `packages/opencode/src/mcp/index.ts:241`
//     写着 `const oauthDisabled = mcp.oauth === false`,再由 `:246` 的 `if (!oauthDisabled)`
//     决定要不要构造 `McpOAuthProvider`。没有 provider,`@modelcontextprotocol/sdk@1.29.0` 的
//     `dist/esm/client/streamableHttp.js:96`(`response.status === 401 && this._authProvider`)
//     就不会把 401 当成认证错误 —— 于是 `connectRemote` 的 `isAuthError` 恒假,该 server
//     **结构上永远进不了 `needs_auth`**,只会以 `failed` 收场,用户没有任何补救入口。
//     `oauth` 字段本身也不接受 `true`(`packages/core/src/v1/config/mcp.ts` 的
//     `Schema.Union([OAuth, Schema.Literal(false)])`):只能是 OAuth **对象**或字面 `false`。
//
//  2. **不再有 `headers.Authorization`。** 从前这里写死
//     `Bearer {file:<userData>/alpha-secrets/ALPHA_CLOUD_TOKEN}`。凭证改由引擎自己的
//     OAuth 凭证库按 server URL 绑定持久化并自动刷新(`packages/opencode/src/mcp/auth.ts`),
//     所以这份定义里**一个凭证通道都不该有**。
//     注意:`ALPHA_CLOUD_TOKEN` 这个密钥文件本身**没有被删** —— 它还是「已登录且平台代付」
//     的判据(`alpha-config-injection.ts` 的 `platformPays`,ADR-009 B1),只是不再当 MCP 的
//     Authorization 来源。把它一起删掉会顺手关掉 web search 主权闸。
//
//  3. **`redirectUri` 必须显式写死。** 引擎默认值是
//     `http://127.0.0.1:19876/mcp/oauth/callback`(`packages/core/src/v1/config/mcp.ts` 的
//     `redirectUri` 注解 + `packages/opencode/src/mcp/oauth-provider.ts:11-12` 的两个常量),
//     而 alpha-web 的回环白名单只放行 `.../callback`。默认值走这条路是断的,见下方常量。

/**
 * 云 MCP 的 OAuth 客户端标识 —— 一个 **CIMD**(Client ID Metadata Document)URL。
 *
 * 不用动态客户端注册(RFC 7591),也不复用预注册的 `alpha-code` 客户端:owner 裁决。
 * 有 `clientId` 时引擎的 `McpOAuthProvider.clientInformation()` 直接返回它、跳过 DCR
 * (`packages/opencode/src/mcp/oauth-provider.ts:55-61`),授权服务器再按这个 URL 取回
 * 客户端元数据(含 `redirect_uris`)。
 *
 * **这个字面量在 alpha-code 与 alpha-web 两侧必须逐字一致**(alpha-web 侧的托管文档归
 * `alpha-web#127`)。两边各写一份、写岔一个字符,表现是授权页直接拒绝而不是任何本地错误 ——
 * 所以它在这里是**具名常量**并被测试钉死,不是散落在对象字面量里的一个字符串。
 */
export const CLOUD_MCP_OAUTH_CLIENT_ID = "https://auth.tidelabs.click/oauth/clients/alpha-code-mcp.json"

/**
 * 本机回环回调地址。**无尾斜杠**,且路径就是 `/callback`。
 *
 * 引擎不写这个字段时用的是 `http://127.0.0.1:19876/mcp/oauth/callback`
 * (`packages/opencode/src/mcp/oauth-provider.ts` 的 `OAUTH_CALLBACK_PORT` /
 * `OAUTH_CALLBACK_PATH`),而 alpha-web 的回环白名单只放行 `.../callback` ——
 * 两边今天对不上,那条路是断的。owner 裁决走 3-b:**alpha-code 侧显式配成白名单已放行的
 * 形态,不改 alpha-web 的白名单**。
 *
 * 这个值同时决定两件事,所以不能只当成"发给授权服务器的一个参数":
 *   - 授权请求里的 `redirect_uri`(`McpOAuthProvider.redirectUrl`);
 *   - 本机回调服务器 listen 的**端口与路径**(`oauth-callback.ts` 经 `parseRedirectUri()`
 *     解析本值;路径对不上时它对回调返回 404)。
 */
export const CLOUD_MCP_OAUTH_REDIRECT_URI = "http://127.0.0.1:19876/callback"

// ── 为什么这里**没有** `scope` ────────────────────────────────────────────────────────────
//
// 因为配置里的 `oauth.scope` 在真实取值顺序里排最后,这条链上恒被压过 —— 写了它不报错、
// 也不生效,是一个纯粹的 no-op。实测取值顺序(`@modelcontextprotocol/sdk@1.29.0`,
// `dist/esm/client/auth.js:167-176` 的 `determineScope`):
//
//     requestedScope || resourceMetadata?.scopes_supported?.join(' ') || clientMetadata.scope
//
//   - `requestedScope` 来自 transport 的 `this._scope`(`client/streamableHttp.js:28` 初始
//     `undefined`;`:355-396` 在收到 401/403 后从 `WWW-Authenticate` 的 `scope=` 里取);
//   - `resourceMetadata.scopes_supported` 来自 RS 的 PRM(`.well-known`);
//   - `clientMetadata.scope` 才是我们这里的 `oauth.scope`
//     (`packages/opencode/src/mcp/oauth-provider.ts:51`)。
//
// 也就是说:**首次连接**落到 RS 的 PRM,**吃了 401 之后**落到 challenge 的 `scope=`,
// 两条都排在 config 之前。scope 的权威在服务端(alpha-web / alpha-platform),不在这里。
//
// 之所以把这段写下来:它的失效形态特别贵 —— 改了没反应 → 怀疑缓存 → 怀疑部署 → 怀疑 flaky,
// 而真因只是取值顺序。宁可留一段注释,也不要留一个看着像开关的死字段。

/**
 * 云 MCP server 定义。**注意签名只剩一个参数** —— 第二个参数从前是密钥文件引用
 * (`{file:…ALPHA_CLOUD_TOKEN}`),随静态 bearer 一起删掉了。
 */
export function materializeCloudMcpConfig(url: string) {
  return {
    type: "remote" as const,
    url,
    enabled: true,
    oauth: {
      clientId: CLOUD_MCP_OAUTH_CLIENT_ID,
      redirectUri: CLOUD_MCP_OAUTH_REDIRECT_URI,
    },
  }
}
