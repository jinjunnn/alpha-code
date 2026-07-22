import type { CloudUploadIntent, CloudUploadResult } from "./types"

type Forbidden =
  | "proof"
  | "token"
  | "accessToken"
  | "manifest"
  | "manifestJson"
  | "manifestSha256"
  | "consentToken"
  | "uploadConsent"
  | "consent_token"
  | "upload_consent"
type HasNoForbiddenKey<Value> = Value extends readonly (infer Item)[]
  ? HasNoForbiddenKey<Item>
  : Value extends object
    ? Extract<keyof Value, Forbidden> extends never
      ? false extends { [Key in keyof Value]: HasNoForbiddenKey<Value[Key]> }[keyof Value]
        ? false
        : true
      : false
    : true

const uploadSurfaceHasNoCredentialOrManifestFields: HasNoForbiddenKey<CloudUploadIntent | CloudUploadResult> = true
void uploadSurfaceHasNoCredentialOrManifestFields

// @ts-expect-error the recursive guard must reject forbidden fields even when nested.
const forbiddenFieldProbe: HasNoForbiddenKey<{ nested: { token: string } }> = true
void forbiddenFieldProbe
