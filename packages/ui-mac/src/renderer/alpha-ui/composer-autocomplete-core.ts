// composer-autocomplete-core — PURE logic for the home composer's slash/@ menus (REQ-038), kept
// solid-free so bun test can exercise it directly (composer-autocomplete.tsx wires it to signals).
// Behaviour parity notes live in composer-autocomplete.tsx; this file is the mechanics.

export type TriggerView = { mode: "slash" | "at"; query: string; tokenStart: number; caret: number }

export type MentionPart =
  | { type: "agent"; name: string; content: string }
  | { type: "file"; path: string; content: string }

const AT_TOKEN = /(^|\s)@(\S*)$/

/** Derive the active menu trigger from the text + caret.
 *  slash: the whole input is a single "/token" still being typed (a following space closes the menu —
 *  upstream slash popover parity). @: a token ending AT the caret that starts with "@" on a word
 *  boundary. Returns null when neither applies. */
export function detectTrigger(text: string, caret: number): TriggerView | null {
  const slash = /^\/(\S*)$/.exec(text)
  if (slash && caret >= 1) return { mode: "slash", query: slash[1].toLowerCase(), tokenStart: 0, caret }
  const upToCaret = text.slice(0, caret)
  const at = AT_TOKEN.exec(upToCaret)
  if (at) {
    const tokenStart = upToCaret.length - at[2].length - 1 // index of "@"
    return { mode: "at", query: at[2].toLowerCase(), tokenStart, caret }
  }
  return null
}

/** A stable signature for the current trigger token — Esc stores it so the menu stays dismissed for
 *  THIS token only and re-opens on any change (upstream parity). */
export function triggerSignature(v: TriggerView, text: string): string {
  return v.mode === "slash" ? `slash:${text}` : `at:${v.tokenStart}:${text.slice(v.tokenStart + 1, v.caret)}`
}

/** Replace the trigger token with the selected mention, returning the next text + caret. */
export function applyMention(text: string, v: TriggerView, content: string): { text: string; caret: number } {
  const next = text.slice(0, v.tokenStart) + content + " " + text.slice(v.caret)
  return { text: next, caret: v.tokenStart + content.length + 1 }
}

/** Build the REAL prompt parts for the mentions still present in the submitted text (upstream
 *  build-request-parts.ts shapes — agent parts carry source offsets, file parts a file:// url).
 *  Mentions whose token was edited away are dropped. */
export function buildMentionParts(body: string, worktree: string, mentions: ReadonlyArray<MentionPart>): unknown[] {
  const parts: unknown[] = []
  for (const m of mentions) {
    const start = body.indexOf(m.content)
    if (start < 0) continue
    if (m.type === "agent") {
      parts.push({
        type: "agent",
        name: m.name,
        source: { value: m.content, start, end: start + m.content.length },
      })
    } else {
      const abs = m.path.startsWith("/") ? m.path : `${worktree.replace(/\/$/, "")}/${m.path}`
      // per-segment encoding (upstream encodeFilePath parity): encodeURI would leave `#`/`?` raw
      // and truncate such paths into fragment/query (codex audit)
      const encoded = abs.split("/").map(encodeURIComponent).join("/")
      parts.push({
        type: "file",
        mime: "text/plain",
        url: `file://${encoded}`,
        filename: m.path.split("/").pop(),
      })
    }
  }
  return parts
}
