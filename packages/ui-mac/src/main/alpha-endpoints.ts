// Single endpoint RESOLVER (main process). Replaces "hardcoded constant baked into every bundle" with
// a layered resolution so a moved gateway/account URL needs NO code change or repackage:
//
//   env override  >  userData pin file  >  login discovery (①)  >  hardcoded default (bootstrap)
//   ALPHA_*_URL      <userData>/           token response          shared/alpha-config.ts
//                    alpha-endpoints.json   { endpoints: {...} }
//
// Why this exists (the bug it prevents): `platform` was once hardcoded to a wrong host and shipped
// baked-in (pre-REQ-070 history: api.tidelabs.click 404 → workers.dev → now the real custom domain
// alpha-gateway.tidelabs.click). The volatile URLs
// (gateway/account) now come from discovery/pin so the platform can move clients without a release.
// The renderer no longer imports the constant directly — it reads the resolved set over IPC
// (endpoints-ipc.ts → window.api.endpoints). Pure node (fs only); no electron import.

import * as fs from "node:fs"
import * as path from "node:path"
import { ContractIncompatibleError } from "@alpha-code/contracts-consumer"
import { ALPHA_ENDPOINTS, type AlphaEndpoints } from "../shared/alpha-config"

const ENV_KEYS: Record<keyof AlphaEndpoints, string> = {
  web: "ALPHA_WEB_URL",
  platform: "ALPHA_PLATFORM_URL",
  account: "ALPHA_ACCOUNT_URL",
  cloud: "ALPHA_CLOUD_URL",
  mcp: "ALPHA_MCP_URL",
}
const KEYS = ["web", "platform", "account", "cloud", "mcp"] as const

let userDataPath = ""
let override: Partial<AlphaEndpoints> = {} // <userData>/alpha-endpoints.json — manual pin, read at init
let discovered: Partial<AlphaEndpoints> = {} // from the login token response (①), persisted across restarts

const strip = (u?: string | null): string | undefined => {
  const v = u?.replace(/\/+$/, "")
  if (!v) return undefined
  // A pin/discovery/env value resolves into ALPHA_BASE_URL — the bearer-carrying proxy target — so a
  // tampered plain-http or attacker host would exfil the JWT. Accept https only (loopback http for dev);
  // anything else falls through to the next precedence tier / hardcoded default (C26).
  try {
    const p = new URL(v)
    const loopback = p.hostname === "localhost" || p.hostname === "127.0.0.1" || p.hostname === "[::1]"
    if (p.protocol === "https:" || (p.protocol === "http:" && loopback)) return v
  } catch {
    /* not a valid URL — reject */
  }
  return undefined
}
const overrideFile = () => path.join(userDataPath, "alpha-endpoints.json")
const discoveredFile = () => path.join(userDataPath, "alpha-discovered-endpoints.json")
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

function readPartial(file: string): Partial<AlphaEndpoints> {
  try {
    const d: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
    if (!isRecord(d)) return {}
    const out: Partial<AlphaEndpoints> = {}
    for (const k of KEYS) {
      const s = strip(typeof d[k] === "string" ? d[k] : undefined)
      if (s) out[k] = s
    }
    return out
  } catch {
    return {}
  }
}

function readDiscovery(file: string): Partial<AlphaEndpoints> {
  if (!fs.existsSync(file)) return {}
  try {
    return decodeEndpointDiscovery(JSON.parse(fs.readFileSync(file, "utf8")))
  } catch (error) {
    if (error instanceof ContractIncompatibleError) throw error
    throw new ContractIncompatibleError({
      surface: "endpoint-discovery",
      received_version: "unknown",
      reason: "schema-validation",
    })
  }
}

/** Called once at startup (index.ts), AFTER preferAppEnv and BEFORE initAuthEnv — so applyAuthEnv
 *  resolves the proxy URL with the pin + persisted discovery already loaded. */
export function initEndpoints(dataPath: string) {
  userDataPath = dataPath
  override = readPartial(overrideFile())
  discovered = readDiscovery(discoveredFile())
}

/** ① The alpha-web /auth/token response carries
 *  `{ endpoints: { platform, account, cloud, mcp, web } }`. Persist accepted values so the next
 *  sidecar fork resolves the right services without a desktop release. A present payload is
 *  accepted atomically; an invalid version or endpoint throws without changing discovery state. */
export function setDiscoveredEndpoints(payload: unknown) {
  discovered = decodeEndpointDiscovery(payload)
  try {
    fs.mkdirSync(userDataPath, { recursive: true })
    fs.writeFileSync(discoveredFile(), JSON.stringify({ schema_version: 1, ...discovered }), { encoding: "utf8", mode: 0o600 })
  } catch {
    /* persistence is best-effort; the validated in-memory discovery remains authoritative */
  }
}

export function decodeEndpointDiscovery(payload: unknown): AlphaEndpoints {
  const value = isRecord(payload) ? payload : null
  const keys = value ? Object.keys(value) : []
  const allowed = new Set(["schema_version", ...KEYS])
  const web = strip(typeof value?.web === "string" ? value.web : undefined)
  const platform = strip(typeof value?.platform === "string" ? value.platform : undefined)
  const account = strip(typeof value?.account === "string" ? value.account : undefined)
  const cloud = strip(typeof value?.cloud === "string" ? value.cloud : undefined)
  const mcp = strip(typeof value?.mcp === "string" ? value.mcp : undefined)
  if (
    !value ||
    value.schema_version !== 1 ||
    keys.some((key) => !allowed.has(key)) ||
    !web ||
    !platform ||
    !account ||
    !cloud ||
    (value.mcp !== undefined && !mcp)
  ) {
    throw new ContractIncompatibleError({
      surface: "endpoint-discovery",
      received_version:
        value && "schema_version" in value
          ? typeof value.schema_version === "number"
            ? value.schema_version
            : "unknown"
          : "missing",
      reason: "schema-validation",
    })
  }
  return { web, platform, account, cloud, ...(mcp ? { mcp } : {}) }
}

/** Resolve all endpoints. Precedence (highest first): env override (dev/staging) > userData pin >
 *  login discovery > hardcoded default. `mcp` is omitted unless someone provides it; callers derive
 *  `${cloud}/mcp`. */
export function resolveEndpoints(): AlphaEndpoints {
  const pick = (k: keyof AlphaEndpoints): string | undefined =>
    strip(process.env[ENV_KEYS[k]]) ?? override[k] ?? discovered[k]
  const mcp = pick("mcp")
  return {
    web: pick("web") ?? ALPHA_ENDPOINTS.web,
    platform: pick("platform") ?? ALPHA_ENDPOINTS.platform,
    account: pick("account") ?? ALPHA_ENDPOINTS.account,
    cloud: pick("cloud") ?? ALPHA_ENDPOINTS.cloud,
    ...(mcp ? { mcp } : {}),
  }
}
