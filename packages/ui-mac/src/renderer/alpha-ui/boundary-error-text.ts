// [REQ-085][CODE] Shared, render-safe error text for crash/recovery fallback UI. Security-relevant:
// a caught `Error` can carry file paths, tokens, or other sensitive substrings from wherever it was
// thrown — rendering `error.message` verbatim (as the fatal SurfaceBoundary flow already avoided,
// see RuntimeRecoveryHost/#434) is not safe for regional recovery UI either. Every consumer must
// redact before rendering. Same discipline as tool-redactor (AC5): a redaction failure hides the
// whole field — it never falls back to the raw string.
import { redactText } from "./session-timeline/cards/tool-redactor"

const BOUNDARY_ERROR_MAX_CHARS = 4_000

function rawErrorText(error: unknown): string {
  try {
    if (error instanceof Error) return error.message
    if (typeof error === "string") return error
    return String(error)
  } catch {
    return ""
  }
}

/** Redacted, render-safe text for a caught error, or `undefined` when there is nothing to show
 *  or redaction failed — callers must render a fixed "detail hidden" placeholder in that case,
 *  never the raw error. */
export function boundaryErrorText(error: unknown): string | undefined {
  const raw = rawErrorText(error)
  if (raw.length === 0) return undefined
  const result = redactText(raw, BOUNDARY_ERROR_MAX_CHARS)
  return result.ok ? result.value : undefined
}
