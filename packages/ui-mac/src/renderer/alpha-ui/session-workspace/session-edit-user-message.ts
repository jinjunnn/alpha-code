import type { TimelineEditUserMessageIntent } from "../session-timeline/cards/timeline-intents"
import {
  identityKey,
  type AlphaSessionIdentity,
  type AlphaSessionLiveSnapshot,
  type AlphaSessionRecord,
} from "./session-workspace-core"
import type { SessionComposerEditRequest } from "./session-composer-mount"

interface EditSessionClient {
  abort(input: { sessionID: string }): Promise<unknown>
  revert(input: { sessionID: string; messageID: string }): Promise<unknown>
}

export interface SessionEditUserMessageDeps {
  current(): AlphaSessionLiveSnapshot | undefined
  accepts(identity: AlphaSessionIdentity): boolean
  canEdit(identity: AlphaSessionIdentity): boolean
  session(): EditSessionClient
  apply(request: SessionComposerEditRequest): void
  reject(error: unknown): void
}

/** Unknown session metadata is not evidence that a session is top-level. */
export function canEditUserMessageForSession(
  identity: AlphaSessionIdentity | undefined,
  info: AlphaSessionRecord | undefined,
): boolean {
  return !!identity && !!info && !info.parentID
}

/** A prefill request is valid only while its originating I8 identity remains current. */
export function discardStaleEditRequest(
  request: SessionComposerEditRequest | undefined,
  identity: AlphaSessionIdentity | undefined,
  discard: () => void,
): void {
  if (request && request.identityKey !== identityKey(identity)) discard()
}

/**
 * Existing session abort/revert orchestration behind the timeline edit intent.
 * Kept as a production function so the destructive edge can be exercised without
 * source-text assertions.
 */
export function createSessionEditUserMessageHandler(deps: SessionEditUserMessageDeps) {
  let inFlight = false
  let revision = 0

  return async (intent: TimelineEditUserMessageIntent): Promise<void> => {
    if (inFlight) return
    const snapshot = deps.current()
    const bound = snapshot?.identity
    const key = identityKey(bound)
    if (!bound || !key || !deps.canEdit(bound)) return
    if (intent.sessionID !== bound.sessionID || !intent.messageID || !intent.text) return

    inFlight = true
    try {
      const session = deps.session()
      if (snapshot.activity === "running") await session.abort({ sessionID: bound.sessionID }).catch(() => {})
      const result = await session.revert({ sessionID: bound.sessionID, messageID: intent.messageID })
      const engineError = (result as { error?: unknown } | undefined)?.error
      if (engineError !== undefined) {
        const failure = new Error("edit resend revert was rejected by the engine")
        ;(failure as Error & { cause?: unknown }).cause = engineError
        throw failure
      }
      if (!deps.accepts(bound)) return
      deps.apply({ identityKey: key, revision: ++revision, text: intent.text })
    } catch (error) {
      if (deps.accepts(bound)) deps.reject(error)
    } finally {
      inFlight = false
    }
  }
}
