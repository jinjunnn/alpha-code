// alpha 治理的云 MCP server(`cloud`)在引擎配置里的定义。
//
// `#1195`(REQ-144 T2):凭证从「引擎交互式 OAuth」改走**登录铸的 `mcp_access` token**,
// 经既有 A6 `{file:}` 秘密文件通道进引擎 —— `headers.Authorization = "Bearer {file:…ALPHA_MCP_TOKEN}"`
// + `oauth:false`。这不是回滚 `#733`:`#733` 删掉的静态 bearer 装的是**错受众**的
// `platform_access`;现在恢复的是**通道**,装的是 `aud = …/mcp` 的登录铸 token
// (方案基线 `docs/design/req-144-login-minted-mcp-access.md` §2.1/§3)。三件事这里必须同时成立:
//
//  1. **`oauth` 必须是字面 `false`。** 引擎 `packages/opencode/src/mcp/index.ts` 对
//     `oauth === false` 完全不构造 `McpOAuthProvider`、不碰 `mcp-auth.json`、不开 loopback ——
//     交互式二次授权那条被 ~10 分钟换血必然打断的路(`ac#721`/`ac#1044`)从「必经之路」
//     变成「不存在的路」。凭证缺席时请求 401 ⇒ `failed`,**不回退**到任何 OAuth 流(I6)。
//     第三方 MCP server 的 `oauth` 对象路径不经过本文件,原样保留(AC3)。
//
//  2. **header 值只能是 `{file:}` 引用,不能是 token 字面量。** 引擎在 config 装载时替换
//     (`packages/opencode/src/config/variable.ts`),值不进 env、不进
//     `OPENCODE_CONFIG_CONTENT` 字面量(A6 / I3)。注意:引擎对缺席文件的 `{file:}` 引用
//     **fail-loud 到整个 config 装载失败**(`missing:"error"`)—— 所以文件缺席时的定义
//     由本函数给出**无引用**的 `enabled:false` 形状,绝不带一个指向不存在文件的引用。
//
//  3. **文件缺席 ⇒ `enabled:false`,无任何回退。** 不回退到 `ALPHA_CLOUD_TOKEN` header
//     (错受众)、不回退到交互式 OAuth(I6)。`enabled:false` 的条目仍要**在**:深合并里
//     它压掉任何继承来源的同名 `cloud` 定义(#223 R6 的教训 —— 缺键不会删除先前来源的定义)。

/**
 * 云 MCP server 定义。
 *
 * @param mcpTokenFileRef 登录铸 `mcp_access` token 的 `{file:}` 引用
 *   (`secretFileRef(userDataPath, "ALPHA_MCP_TOKEN")`)。**`undefined` = 凭证缺席**:
 *   返回 `enabled:false` 且不带任何凭证通道的形状 —— 见文件头第 2/3 条,这里是
 *   「缺席 fail-closed、且不发指向缺席文件的引用」两条不变量的唯一出口。
 */
export function materializeCloudMcpConfig(url: string, mcpTokenFileRef: string | undefined) {
  if (!mcpTokenFileRef) {
    return {
      type: "remote" as const,
      url,
      enabled: false as const,
      oauth: false as const,
    }
  }
  return {
    type: "remote" as const,
    url,
    enabled: true as const,
    headers: { Authorization: `Bearer ${mcpTokenFileRef}` },
    oauth: false as const,
  }
}
