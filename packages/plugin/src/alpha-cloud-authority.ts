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
