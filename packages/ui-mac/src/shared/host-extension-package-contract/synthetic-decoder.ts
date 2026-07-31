import {
  decodePackageEnvelopeHeaderV1,
  type AlphaPackageEnvelopeV1,
  type PackageComponentSkipReasonV1,
  type PackageProfilePayloadDecodeV1,
  type PackageProfilePayloadV1,
  type PackageSupportedComponentV1,
} from "./decoder"
import {
  HOST_EXTENSION_PACKAGE_LIMITS_V1,
  type PackageCapabilityV1,
  type PackageProfileIdV1,
} from "./registry"

export type SyntheticDecoderEffectsV1<Plan> = {
  fetchPayload: (
    envelope: AlphaPackageEnvelopeV1,
    component: PackageSupportedComponentV1,
  ) => Promise<Uint8Array>
  decodePayload: (
    profileId: PackageProfileIdV1,
    bytes: Uint8Array,
    capabilities: PackageCapabilityV1[],
  ) => PackageProfilePayloadDecodeV1
  resolveSecrets: () => Promise<void>
  plan: (payload: PackageProfilePayloadV1, component: PackageSupportedComponentV1) => Promise<Plan>
}

export type SyntheticComponentResultV1<Plan> = {
  componentId: string
  role: "root" | "leaf"
  payload: PackageProfilePayloadV1
  plan: Plan
}

export type SyntheticSkippedComponentV1 = {
  componentId: string
  reasonCode: PackageComponentSkipReasonV1
}

export type SyntheticDecoderResultV1<Plan> =
  | {
      ok: true
      status: "accepted"
      envelope: AlphaPackageEnvelopeV1
      /** Root first, then every supported leaf in envelope order. */
      components: SyntheticComponentResultV1<Plan>[]
      /** Curated components this host cannot serve. They reach no effect at all. */
      skipped: SyntheticSkippedComponentV1[]
    }
  | {
      ok: false
      status: "blocked"
      stage: "header" | "support" | "payload"
      errors: string[]
      /**
       * Present only for `stage: "support"`, where the header decoder has already accepted and
       * bounded the presentation before rejecting the package. Declared here because this module
       * returns the header decode result verbatim; omitting it made the published type narrower
       * than the runtime shape.
       */
      presentation?: AlphaPackageEnvelopeV1["presentation"]
    }

/**
 * Executable ordering corpus. This is deliberately not production Catalog wiring: every effect is
 * supplied by the caller, and the module itself has no Electron, network, secret, planner, or disk
 * implementation.
 *
 * A skipped component reaches **none** of the effects — not fetch, not decode, not the secret
 * stage, not the planner. That is the executable form of the promise the safe view makes to the
 * user, and it is why the caller's call counters are the gate rather than a prose assertion.
 */
export async function runSyntheticPackageDecoderV1<Plan>(
  envelopeBytes: Uint8Array,
  effects: SyntheticDecoderEffectsV1<Plan>,
): Promise<SyntheticDecoderResultV1<Plan>> {
  const header = decodePackageEnvelopeHeaderV1(envelopeBytes)
  if (!header.ok) return header

  const supported = header.components.filter((entry) => entry.status === "supported")
  const ordered = [
    ...supported.filter((entry) => entry.role === "root"),
    ...supported.filter((entry) => entry.role === "leaf"),
  ]
  const results: SyntheticComponentResultV1<Plan>[] = []
  for (const entry of ordered) {
    const component = entry.component
    const payloadBytes = await effects.fetchPayload(header.envelope, component)
    const payloadRef = component.payloadRef
    if (payloadBytes.byteLength !== payloadRef.bytes)
      return blocked(
        `payload[${component.id}]: fetched ${payloadBytes.byteLength} bytes but payloadRef declares ${payloadRef.bytes}`,
      )
    if (payloadBytes.byteLength > HOST_EXTENSION_PACKAGE_LIMITS_V1.maxPayloadBytes)
      return blocked(
        `payload[${component.id}]: ${payloadBytes.byteLength} bytes exceeds ${HOST_EXTENSION_PACKAGE_LIMITS_V1.maxPayloadBytes}`,
      )
    if ((await sha256Hex(payloadBytes)) !== payloadRef.sha256)
      return blocked(`payload[${component.id}]: SHA-256 does not match payloadRef.sha256`)

    const payload = effects.decodePayload(component.profileId, payloadBytes, component.capabilities)
    if (!payload.ok)
      return { ok: false, status: "blocked", stage: "payload", errors: payload.errors }

    if (component.capabilities.includes("alpha.secret-prerequisite.v1")) await effects.resolveSecrets()
    results.push({
      componentId: component.id,
      role: entry.role,
      payload: payload.payload,
      plan: await effects.plan(payload.payload, component),
    })
  }

  return {
    ok: true,
    status: "accepted",
    envelope: header.envelope,
    components: results,
    skipped: header.components.flatMap((entry) =>
      entry.status === "skipped"
        ? [{ componentId: entry.component.id, reasonCode: entry.reasonCode }]
        : [],
    ),
  }
}

function blocked<Plan>(error: string): SyntheticDecoderResultV1<Plan> {
  return { ok: false, status: "blocked", stage: "payload", errors: [error] }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength)
  input.set(bytes)
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input))
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}
