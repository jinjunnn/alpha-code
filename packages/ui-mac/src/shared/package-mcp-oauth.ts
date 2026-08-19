import type {
  PackageProfilePayloadV1,
  PackageSupportedComponentV1,
} from "./host-extension-package-contract/decoder"

/**
 * MCP OAuth prerequisite v1 — the frozen shapes for the remote-MCP authorization kind whose
 * protocol authority is the *engine's* OAuth stack (`packages/opencode/src/mcp/**`), not a handler
 * compiled into this App. Its sibling is `package-alpha-connection.ts`; the two are deliberately
 * separate files because their record owners differ (§2.6 of the REQ-128 baseline): an Alpha
 * Connection's durable record is main-owned, an MCP OAuth credential's durable record is the
 * engine's `mcp-auth.json` token store (`0600 + flock`, entries bound to `serverUrl`).
 *
 * Three boundaries are load-bearing:
 *
 * 1. **Main never runs the protocol.** Discovery, dynamic client registration, PKCE, the
 *    `state` nonce, the token exchange and the token store all stay in the engine, reached only
 *    through its authenticated typed routes (`POST /mcp`, `POST /mcp/:name/auth`,
 *    `POST /mcp/:name/auth/callback`). What main owns is the *attempt*: which signed prerequisite
 *    is being satisfied, which loopback redirect belongs to it, and whether the redirect that came
 *    back carries that attempt's state.
 *
 * 2. **Every fact in an attempt is signed or main-minted.** Service identity and server URL are
 *    projected from the strictly decoded component payload; the renderer contributes only the
 *    decision to begin and the attempt id it was handed back. There is no field a renderer could
 *    use to point the flow at a different server.
 *
 * 3. **Tokens bind to the signed server URL.** The engine's `getForUrl(name, url)` refuses an
 *    entry whose `serverUrl` differs from the config's URL, and the config URL here always comes
 *    from the re-validated signed envelope — so a token minted for one server can never satisfy an
 *    envelope that now points at another. Readiness is therefore *asked of the engine* each time,
 *    never cached in a main-owned record.
 */
export const PACKAGE_MCP_OAUTH_PREREQUISITE_PROFILE_V1 = "alpha.mcp-oauth.v1" as const

/**
 * Every terminal answer this subsystem can give. Exhaustive on purpose: a caller that cannot name
 * its failure cannot fail closed, and a UI that cannot name it invents its own wording.
 */
export const PACKAGE_MCP_OAUTH_REASON_CODES_V1 = [
  "mcp-oauth-ready",
  "mcp-oauth-required",
  "mcp-oauth-profile-invalid",
  "mcp-oauth-attempt-stale",
  "mcp-oauth-attempt-conflict",
  "mcp-oauth-cancelled",
  "mcp-oauth-state-mismatch",
  "mcp-oauth-engine-error",
  "mcp-oauth-engine-unavailable",
] as const

export type PackageMcpOauthReasonCodeV1 = (typeof PACKAGE_MCP_OAUTH_REASON_CODES_V1)[number]

/**
 * Nothing here is a dead end except `mcp-oauth-profile-invalid` (needs a new package). Every other
 * failure leaves zero durable local writes behind and can be retried with a fresh attempt.
 */
export const PACKAGE_MCP_OAUTH_RETRYABLE_REASONS_V1: readonly PackageMcpOauthReasonCodeV1[] = [
  "mcp-oauth-required",
  "mcp-oauth-attempt-stale",
  "mcp-oauth-attempt-conflict",
  "mcp-oauth-cancelled",
  "mcp-oauth-state-mismatch",
  "mcp-oauth-engine-error",
  "mcp-oauth-engine-unavailable",
]

export type PackageMcpOauthPrerequisiteItemV1 = {
  prerequisiteId: string
  componentId: string
  /** The engine-facing MCP name — the component id after the profile colon, exactly as install uses it. */
  serviceId: string
  /** The signed remote server URL. The only URL any OAuth request may ever be about. */
  serverUrl: string
  label: string
  required: boolean
}

export type PackageMcpOauthPrerequisiteProfileV1 = {
  profile: typeof PACKAGE_MCP_OAUTH_PREREQUISITE_PROFILE_V1
  componentId: string
  items: PackageMcpOauthPrerequisiteItemV1[]
}

/**
 * What main tracks while an OAuth attempt is live. Derived entirely from signed facts plus
 * main-minted values; the renderer contributes nothing but the decision to begin.
 */
export type PackageMcpOauthAttemptV1 = {
  attemptId: string
  prerequisiteId: string
  componentId: string
  serviceId: string
  serverUrl: string
  catalogId: string
  envelopeDigest: string
  createdAt: string
}

/**
 * The engine's MCP status vocabulary as this host consumes it. `needs_client_registration` is a
 * distinct engine state but the answer to "is OAuth ready?" is the same as `needs_auth`.
 */
export type PackageMcpOauthEngineStatusV1 =
  | "connected"
  | "disabled"
  | "failed"
  | "needs_auth"
  | "needs_client_registration"

export type PackageMcpOauthEvaluationV1 = {
  state: "ready" | "required-action" | "blocked"
  reasonCode: PackageMcpOauthReasonCodeV1
}

/**
 * Project the signed component into the MCP OAuth prerequisite the user will be asked to satisfy.
 * Only the host-owned, strictly decoded payload is consulted — mirror of
 * `decodePackageConnectionPrerequisiteProfileV1` for the other authorization kind.
 */
export function decodePackageMcpOauthPrerequisiteProfileV1(
  component: PackageSupportedComponentV1,
  payload: PackageProfilePayloadV1,
): PackageMcpOauthPrerequisiteProfileV1 {
  if (
    payload.schema !== "alpha.host-extension-package.payload.mcp-remote.v1" ||
    payload.behavior.auth === "none" ||
    payload.behavior.auth.kind !== "mcp-oauth"
  )
    return { profile: PACKAGE_MCP_OAUTH_PREREQUISITE_PROFILE_V1, componentId: component.id, items: [] }
  const auth = payload.behavior.auth
  return {
    profile: PACKAGE_MCP_OAUTH_PREREQUISITE_PROFILE_V1,
    componentId: component.id,
    items: [
      {
        prerequisiteId: `${component.id}#${auth.prerequisiteId}`,
        componentId: component.id,
        serviceId: component.id.slice(component.id.indexOf(":") + 1),
        serverUrl: payload.behavior.url,
        label: auth.label ?? auth.prerequisiteId,
        // A component that is itself optional cannot impose a required prerequisite; a required
        // component with `auth.required === false` may still install and stay unavailable.
        required: component.required && auth.required,
      },
    ],
  }
}

/**
 * Map one engine status answer to the readiness verdict admission consumes. `connected` is the
 * only ready state: it proves tokens exist, are bound to this exact server URL (the engine's
 * `getForUrl` refuses anything else) and the server accepted them. Everything not-ready is named,
 * and required-vs-optional divergence is the caller's job, not this function's.
 */
export function evaluatePackageMcpOauthStatusV1(
  status: PackageMcpOauthEngineStatusV1,
): PackageMcpOauthEvaluationV1 {
  switch (status) {
    case "connected":
      return { state: "ready", reasonCode: "mcp-oauth-ready" }
    case "needs_auth":
    case "needs_client_registration":
      return { state: "required-action", reasonCode: "mcp-oauth-required" }
    case "disabled":
    case "failed":
      return { state: "blocked", reasonCode: "mcp-oauth-engine-error" }
  }
}
