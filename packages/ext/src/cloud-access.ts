import { existsSync } from "node:fs"
import { FILE_REF } from "@opencode-ai/plugin/alpha-cloud-authority"
import { CLOUD_MCP_DEF_ENV } from "./cloud-websearch-kill"
import { CLOUD_ACCESS_LOGIN_HINT } from "./context-injection"

export function cloudMcpAuthorization(env: Record<string, string | undefined>): string | undefined {
  const raw = env[CLOUD_MCP_DEF_ENV]
  if (!raw) return undefined
  try {
    const definition = JSON.parse(raw) as { headers?: { Authorization?: unknown } } | null
    const header = definition?.headers?.Authorization
    return typeof header === "string" && header.trim() ? header : undefined
  } catch {
    return undefined
  }
}

export function cloudAccessState(
  env: Record<string, string | undefined> = process.env,
  exists: (path: string) => boolean = existsSync,
): { state: "logged-out" | "credential-missing" | "ready"; loginHint: string } {
  const path = env.ALPHA_BASE_URL ? FILE_REF.exec(cloudMcpAuthorization(env) ?? "")?.[1] : undefined
  return {
    state: !path ? "logged-out" : exists(path) ? "ready" : "credential-missing",
    loginHint: CLOUD_ACCESS_LOGIN_HINT,
  }
}
