import {
  decodePackageEnvelopeHeaderV1,
  type AlphaPackageEnvelopeV1,
  type PackageProfilePayloadDecodeV1,
  type PackageProfilePayloadV1,
} from "./decoder"
import { HOST_EXTENSION_PACKAGE_LIMITS_V1, type PackageProfileIdV1 } from "./registry"

export type SyntheticDecoderEffectsV1<Plan> = {
  fetchPayload: (envelope: AlphaPackageEnvelopeV1) => Promise<Uint8Array>
  decodePayload: (
    profileId: PackageProfileIdV1,
    bytes: Uint8Array,
    capabilities: AlphaPackageEnvelopeV1["capabilities"],
  ) => PackageProfilePayloadDecodeV1
  resolveSecrets: () => Promise<void>
  beginOAuth: () => Promise<void>
  plan: (payload: PackageProfilePayloadV1) => Promise<Plan>
}

export type SyntheticDecoderResultV1<Plan> =
  | {
      ok: true
      status: "accepted"
      envelope: AlphaPackageEnvelopeV1
      payload: PackageProfilePayloadV1
      plan: Plan
    }
  | {
      ok: false
      status: "blocked" | "skipped"
      stage: "header" | "support" | "payload"
      errors: string[]
    }

/**
 * Executable Phase 1 ordering corpus. This is deliberately not production Catalog wiring: every
 * effect is supplied by the caller, and the module itself has no Electron, network, secret, OAuth,
 * planner, or disk implementation.
 */
export async function runSyntheticPackageDecoderV1<Plan>(
  envelopeBytes: Uint8Array,
  effects: SyntheticDecoderEffectsV1<Plan>,
): Promise<SyntheticDecoderResultV1<Plan>> {
  const header = decodePackageEnvelopeHeaderV1(envelopeBytes)
  if (!header.ok) return header

  const payloadBytes = await effects.fetchPayload(header.envelope)
  const payloadRef = header.envelope.components[0].payloadRef
  if (payloadBytes.byteLength !== payloadRef.bytes)
    return {
      ok: false,
      status: "blocked",
      stage: "payload",
      errors: [
        `payload: fetched ${payloadBytes.byteLength} bytes but payloadRef declares ${payloadRef.bytes}`,
      ],
    }
  if (payloadBytes.byteLength > HOST_EXTENSION_PACKAGE_LIMITS_V1.maxPayloadBytes)
    return {
      ok: false,
      status: "blocked",
      stage: "payload",
      errors: [
        `payload: ${payloadBytes.byteLength} bytes exceeds ${HOST_EXTENSION_PACKAGE_LIMITS_V1.maxPayloadBytes}`,
      ],
    }
  if ((await sha256Hex(payloadBytes)) !== payloadRef.sha256)
    return {
      ok: false,
      status: "blocked",
      stage: "payload",
      errors: ["payload: SHA-256 does not match payloadRef.sha256"],
    }

  const payload = effects.decodePayload(
    header.envelope.components[0].profileId,
    payloadBytes,
    header.envelope.capabilities,
  )
  if (!payload.ok)
    return {
      ok: false,
      status: "blocked",
      stage: "payload",
      errors: payload.errors,
    }

  if (header.envelope.capabilities.includes("alpha.secret-prerequisite.v1"))
    await effects.resolveSecrets()
  if (header.envelope.capabilities.includes("alpha.mcp-oauth.v1")) await effects.beginOAuth()
  return {
    ok: true,
    status: "accepted",
    envelope: header.envelope,
    payload: payload.payload,
    plan: await effects.plan(payload.payload),
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength)
  input.set(bytes)
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input))
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}
