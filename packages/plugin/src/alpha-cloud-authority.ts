/**
 * Alpha Cloud MCP authority is proven only by the definition that the desktop
 * injection handshake placed in this process. Keep this verifier pure so the
 * extension sovereignty gate and the engine display snapshot use one fact.
 */

export const CLOUD_MCP_SERVER_ENV = "ALPHA_CLOUD_MCP_SERVER"
export const CLOUD_MCP_DEF_ENV = "ALPHA_CLOUD_MCP_DEF"

export type McpOwnership = {
  governed: string[]
  foreign: string[]
}

export const UNVERIFIED_MCP_OWNERSHIP: McpOwnership = { governed: [], foreign: [] }

type McpHost = { mcp?: Record<string, unknown> }

export function governedCloudEndpoint(
  env: Record<string, string | undefined>,
): { name: string; url: string } | undefined {
  const name = env[CLOUD_MCP_SERVER_ENV]
  const raw = env[CLOUD_MCP_DEF_ENV]
  if (!name || !raw) return undefined
  let definition: unknown
  try {
    definition = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) return undefined
  const { type, url } = definition as { type?: unknown; url?: unknown }
  if (type !== "remote" || typeof url !== "string" || !url) return undefined
  return { name, url }
}

export function isGovernedMcpEntry(
  name: string,
  entry: unknown,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const endpoint = governedCloudEndpoint(env)
  if (!endpoint || name !== endpoint.name) return false
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false
  const { type, url } = entry as { type?: unknown; url?: unknown }
  return type === "remote" && url === endpoint.url
}

/**
 * REQ-236 §2.1-5(`#1562`):治理云 MCP 条目每次请求的凭据,从 `ALPHA_CLOUD_MCP_DEF` 定义里
 * `headers.Authorization` 的 `{file:}` 引用**现读**(权限方案冻结接口),不读已装载条目里的字面量 ——
 * 那个字面量是引擎配置加载器(生产分支)或 ext `installCloudMcp`(kill-switch 分支)在装载时替换进去的,
 * 续期之后它就是旧令牌。返回给 MCP SDK transport 的 `fetch` 选项:StreamableHTTP 与 SSE 的 POST、GET/SSE
 * 与重连、404 会话恢复全都经过它。读不到(DEF 缺席 / 无引用 / 文件缺席或为空)⇒ 本地答一个 401,请求不出网,
 * SDK 照它自己的路径报认证错误(无 authProvider 时为 `StreamableHTTPError(401)` / `SseError(401)`,
 * 引擎归为 `failed` + code `auth`,不重连)。IO 由调用方注入,本模块不碰文件系统。
 */
export function governedCredentialFetch(
  env: Record<string, string | undefined>,
  readFile: (path: string) => Promise<string>,
  fetchImpl: (url: string | URL, init?: RequestInit) => Promise<Response>,
): (url: string | URL, init?: RequestInit) => Promise<Response> {
  const template = governedAuthorizationTemplate(env)
  return async (url, init) => {
    const authorization = template ? await resolveAuthorization(template, readFile) : undefined
    if (!authorization)
      return new Response("Alpha cloud connector credential could not be read; the request was not sent.", {
        status: 401,
        statusText: "Unauthorized",
      })
    const headers = new Headers(init?.headers)
    headers.set("authorization", authorization)
    return fetchImpl(url, { ...init, headers })
  }
}

function governedAuthorizationTemplate(env: Record<string, string | undefined>): string | undefined {
  const raw = env[CLOUD_MCP_DEF_ENV]
  if (!raw) return undefined
  try {
    const definition: unknown = JSON.parse(raw)
    const headers = (definition as { headers?: unknown } | null)?.headers
    const value = headers && typeof headers === "object" ? (headers as { Authorization?: unknown }).Authorization : undefined
    return typeof value === "string" && FILE_REF.test(value) ? value : undefined
  } catch {
    return undefined
  }
}

const FILE_REF = /\{file:([^}]+)\}/

async function resolveAuthorization(template: string, readFile: (path: string) => Promise<string>) {
  const match = FILE_REF.exec(template)
  if (!match) return undefined
  const value = await readFile(match[1]!).then(
    (content) => content.trim(),
    () => "",
  )
  if (!value) return undefined
  return template.replace(match[0], () => value)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error("MCP evidence contains a non-JSON value")
  return encoded
}

const FILE_REF = /\{file:[^}]+\}/

/**
 * #1576:the engine resolves `{file:}` references while it parses config text (production branch) and
 * `installCloudMcp` resolves them itself (kill-switch branch), so the loaded entry carries the token
 * literal where the definition carries the reference. For a header whose definition value is a file
 * reference, only require that the entry has the same header as a string; the value is a credential,
 * not provenance. Every other field (and every header key set) still has to match exactly.
 */
function withDefinitionFileRefs(entry: unknown, definition: unknown): unknown {
  const defHeaders = (definition as { headers?: unknown } | null)?.headers
  const entryHeaders = (entry as { headers?: unknown } | null)?.headers
  if (!defHeaders || typeof defHeaders !== "object" || !entryHeaders || typeof entryHeaders !== "object") return entry
  const headers: Record<string, unknown> = { ...(entryHeaders as Record<string, unknown>) }
  for (const [key, value] of Object.entries(defHeaders as Record<string, unknown>))
    if (typeof value === "string" && FILE_REF.test(value) && typeof headers[key] === "string") headers[key] = value
  return { ...(entry as Record<string, unknown>), headers }
}

/**
 * Display authority is stricter than the legacy web-search sovereignty owner
 * check: the complete invocation config must equal the verified definition,
 * not merely share its endpoint. The evidence is the definition itself (file
 * references, never token values), so token rotation keeps the digest stable.
 */
export function governedMcpEvidence(
  name: string,
  entry: unknown,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (!isGovernedMcpEntry(name, entry, env)) return undefined
  const raw = env[CLOUD_MCP_DEF_ENV]
  if (!raw) return undefined
  try {
    const definition: unknown = JSON.parse(raw)
    if (canonicalJson(withDefinitionFileRefs(entry, definition)) !== canonicalJson(definition)) return undefined
    return canonicalJson({ kind: "alpha-cloud-mcp", name, definition })
  } catch {
    return undefined
  }
}

export function computeMcpOwnership(cfg: unknown, env: Record<string, string | undefined> = process.env): McpOwnership {
  const host = cfg as McpHost | null | undefined
  if (!host || typeof host !== "object") return UNVERIFIED_MCP_OWNERSHIP
  const servers = host.mcp && typeof host.mcp === "object" ? host.mcp : {}
  const governed: string[] = []
  const foreign: string[] = []
  for (const [name, entry] of Object.entries(servers)) {
    if (isGovernedMcpEntry(name, entry, env)) governed.push(name)
    else foreign.push(name)
  }
  return { governed, foreign }
}
