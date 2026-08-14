import { randomUUID } from "node:crypto"
import { decodeUploadConsentClaims } from "@alpha-code/contracts-consumer"
import type { CloudDispatchResult, CloudUploadIntent, CloudUploadResult } from "../preload/types"
import {
  UploadAdmissionError,
  createExplicitUploadRequest,
  createExplicitUploadSnapshot,
  type ExplicitUploadSnapshot,
  type UploadClassifier,
  type UploadErrorCode,
  type UploadSelection,
} from "./alpha-upload-manifest"

type AccessIdentity = { accessToken: string; tenantId: string }
type ExplicitUploadBody = ReturnType<typeof createExplicitUploadRequest>
type PendingUpload = {
  senderId: number
  tenantId: string
  snapshot: ExplicitUploadSnapshot
  body: ExplicitUploadBody
}

export function createMainUploadService(deps: {
  identity: () => AccessIdentity | undefined | Promise<AccessIdentity | undefined>
  issue: (input: { accessToken: string; manifestJson: string; manifestSha256: string }) => Promise<string>
  dispatch: (input: {
    accessToken: string
    body: ExplicitUploadBody
    uploadConsent?: string
  }) => Promise<CloudDispatchResult | { error: string }>
  log: (message: string) => void
  now?: () => Date
  id?: () => string
  classify?: UploadClassifier
}) {
  const pending = new Map<string, PendingUpload>()

  return {
    prepare: async (senderId: number, intent: CloudUploadIntent, selection: UploadSelection): Promise<CloudUploadResult> => {
      if (!intent || intent.kind !== "code-review") return fail(deps.log, "upload-selection-invalid")
      try {
        const identity = await deps.identity()
        if (!identity) return fail(deps.log, "not-authenticated")
        const snapshot = await createExplicitUploadSnapshot(selection, identity.tenantId, {
          now: deps.now,
          id: deps.id,
          classify: deps.classify,
        })
        const body = createExplicitUploadRequest(snapshot, { autonomy: "pipeline", kind: "code-review", input: {} })
        if (!snapshot.manifest.consent_required) {
          const job = await deps.dispatch({ accessToken: identity.accessToken, body })
          // [#940] 派发腿的分类错误**原样上抛**(unauthorized / network / 平台分类码如
          // upload_reserved_input / http-<status> 回退)。旧的 "upload-dispatch-failed" 把
          // 分类整个坍缩成一句「派发失败」—— 平台那句「这个输入是保留的」根本到不了用户。
          if ("error" in job) return fail(deps.log, job.error)
          return { status: "sent", privacy: "clear", job, directory: snapshot.projectDirectory }
        }

        for (const [requestId, value] of pending) {
          if (value.senderId === senderId) pending.delete(requestId)
        }
        const requestId = randomUUID()
        pending.set(requestId, { senderId, tenantId: identity.tenantId, snapshot, body })
        return { status: "consent-required", requestId, preview: snapshot.preview }
      } catch (error) {
        return fail(deps.log, error instanceof UploadAdmissionError ? error.code : "upload-selection-invalid")
      }
    },
    confirm: async (senderId: number, requestId: string): Promise<CloudUploadResult> => {
      const upload = typeof requestId === "string" ? pending.get(requestId) : undefined
      if (!upload || upload.senderId !== senderId) return fail(deps.log, "upload-selection-invalid")
      pending.delete(requestId)
      try {
        const identity = await deps.identity()
        if (!identity || identity.tenantId !== upload.tenantId) return fail(deps.log, "not-authenticated")
        const uploadConsent = await deps.issue({
          accessToken: identity.accessToken,
          manifestJson: upload.snapshot.manifestJson,
          manifestSha256: upload.snapshot.manifestSha256,
        })
        const claims = decodeUploadConsentClaims(uploadConsent)
        const now = Math.floor((deps.now ?? (() => new Date()))().getTime() / 1000)
        if (
          claims.sub !== upload.tenantId ||
          claims.manifest_id !== upload.snapshot.manifest.manifest_id ||
          claims.manifest_sha256 !== upload.snapshot.manifestSha256 ||
          claims.exp <= claims.iat ||
          claims.exp <= now ||
          JSON.stringify(claims.egress) !== JSON.stringify(upload.snapshot.manifest.egress)
        ) {
          return fail(deps.log, "upload-consent-invalid")
        }
        const job = await deps.dispatch({ accessToken: identity.accessToken, body: upload.body, uploadConsent })
        // [#940] 同上:同意面的分类拒绝(upload_consent_legacy / upload_consent_replayed …)原样上抛。
        if ("error" in job) return fail(deps.log, job.error)
        return { status: "sent", privacy: "confirmed", job, directory: upload.snapshot.projectDirectory }
      } catch (error) {
        return fail(
          deps.log,
          error instanceof UploadAdmissionError ? error.code : "upload-consent-issuance-failed",
        )
      }
    },
    cancel: (senderId: number, requestId: string): CloudUploadResult => {
      const upload = typeof requestId === "string" ? pending.get(requestId) : undefined
      if (!upload || upload.senderId !== senderId) return { status: "cancelled" }
      pending.delete(requestId)
      return { status: "cancelled" }
    },
    clear: (senderId: number) => {
      for (const [requestId, upload] of pending) {
        if (upload.senderId === senderId) pending.delete(requestId)
      }
    },
  }
}

export function assertSafeUploadResult<T>(result: T): T {
  const inspect = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(inspect)
    if (!value || typeof value !== "object") return
    for (const [key, nested] of Object.entries(value)) {
      if (
        [
          "proof",
          "token",
          "accessToken",
          "manifest",
          "manifestJson",
          "manifestSha256",
          "consentToken",
          "uploadConsent",
          "consent_token",
          "upload_consent",
        ].includes(key)
      ) {
        throw new UploadAdmissionError("upload-consent-invalid")
      }
      inspect(nested)
    }
  }
  inspect(result)
  return result
}

// [#940] code 除本地准入码外还可能是派发腿透传的平台分类码 / http-<status> 回退。
// 两者都是稳定分类面(唯一咽喉 platform-error-code.ts 已按文法过滤,散文不进来),
// 日志与 renderer 都可安全承载。
function fail(log: (message: string) => void, code: UploadErrorCode | (string & {})): CloudUploadResult {
  log(`[alpha-upload] failed code=${code}`)
  return { status: "failed", error: code }
}
