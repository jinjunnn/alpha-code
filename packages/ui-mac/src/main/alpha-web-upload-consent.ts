import { CONTROL_ENVELOPE_MAX_BYTES } from "@alpha-code/contracts-consumer"
import { ALPHA_PATHS } from "../shared/alpha-config"
import { resolveEndpoints } from "./alpha-endpoints"
import { UploadAdmissionError } from "./alpha-upload-manifest"

export async function requestUploadConsent(input: {
  accessToken: string
  manifestJson: string
  manifestSha256: string
}, deps: { fetcher?: typeof fetch; web?: string } = {}) {
  const response = await (deps.fetcher ?? fetch)(`${deps.web ?? resolveEndpoints().web}${ALPHA_PATHS.uploadConsent}`, {
    method: "POST",
    headers: { authorization: `Bearer ${input.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: 1,
      manifest: input.manifestJson,
      manifest_sha256: input.manifestSha256,
    }),
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new UploadAdmissionError("upload-consent-issuance-failed")
  const text = await response.text()
  if (Buffer.byteLength(text, "utf8") > CONTROL_ENVELOPE_MAX_BYTES) {
    throw new UploadAdmissionError("upload-consent-invalid")
  }
  try {
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new UploadAdmissionError("upload-consent-invalid")
    }
    if (
      Object.keys(value).length !== 1 ||
      !("upload_consent" in value) ||
      typeof value.upload_consent !== "string" ||
      !value.upload_consent
    ) {
      throw new UploadAdmissionError("upload-consent-invalid")
    }
    return value.upload_consent
  } catch (error) {
    if (error instanceof UploadAdmissionError) throw error
    throw new UploadAdmissionError("upload-consent-invalid")
  }
}
