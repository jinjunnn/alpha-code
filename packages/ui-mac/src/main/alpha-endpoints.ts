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

function readPartial(file: string): Partial<AlphaEndpoints> {
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
    const out: Partial<AlphaEndpoints> = {}
    for (const k of KEYS) {
      const s = strip(typeof d[k] === "string" ? (d[k] as string) : undefined)
      if (s) out[k] = s
    }
    return out
  } catch {
    return {}
  }
}

/** Called once at startup (index.ts), AFTER preferAppEnv and BEFORE initAuthEnv — so applyAuthEnv
 *  resolves the proxy URL with the pin + persisted discovery already loaded. */
export function initEndpoints(dataPath: string) {
  userDataPath = dataPath
  override = readPartial(overrideFile())
  discovered = readPartial(discoveredFile())
}

/** ① The alpha-web /auth/token response carries
 *  `{ endpoints: { platform, account, cloud, mcp, web } }`. Persist accepted values so the next
 *  sidecar fork resolves the right services without a desktop release. Defaults still apply to
 *  omitted or rejected values. */
export function setDiscoveredEndpoints(partial: Partial<Record<keyof AlphaEndpoints, unknown>> | undefined) {
  if (!partial || typeof partial !== "object") return
  const next: Partial<AlphaEndpoints> = {}
  for (const k of KEYS) {
    const s = strip(typeof partial[k] === "string" ? (partial[k] as string) : undefined)
    if (s) next[k] = s
  }
  if (Object.keys(next).length === 0) return
  discovered = { ...discovered, ...next }
  try {
    fs.mkdirSync(userDataPath, { recursive: true })
    fs.writeFileSync(discoveredFile(), JSON.stringify(discovered), { encoding: "utf8", mode: 0o600 })
  } catch {
    /* discovery is best-effort; defaults still resolve */
  }
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
