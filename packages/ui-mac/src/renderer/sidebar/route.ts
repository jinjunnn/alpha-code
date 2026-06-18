// URL helpers for the alpha Codex-style sidebar.
//
// opencode's router (packages/app/src/app.tsx) keys directories in the path as URL-safe
// base64 of the absolute worktree path. We replicate the exact scheme from
// packages/core/src/util/encode.ts here (a 3-line pure transform) rather than importing it —
// @opencode-ai/core is not a runtime dependency for us (ADR-002/NON_GOALS#5: the frontend
// talks to the backend only through @opencode-ai/sdk). Keeping our own copy is intentional:
// it must stay byte-compatible with opencode's `base64Encode`, so if you ever see routing
// 404s after an upstream bump, re-check this against core/src/util/encode.ts.

export function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

export function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/** Route to an existing session inside a project directory. */
export function sessionHref(directory: string, sessionID: string): string {
  return `/${base64UrlEncode(directory)}/session/${sessionID}`
}

/**
 * Route to a project with no session id. Under the new layout opencode's SessionRoute
 * (app.tsx) auto-creates a draft for this directory, i.e. this starts a brand-new chat.
 */
export function newSessionHref(directory: string): string {
  return `/${base64UrlEncode(directory)}/session`
}

export function homeHref(): string {
  return "/"
}

/** The basename a project shows in the sidebar (matches opencode's worktree → label). */
export function projectLabel(worktree: string): string {
  const trimmed = worktree.replace(/[\/\\]+$/, "")
  const base = trimmed.split(/[\/\\]/).pop()
  return base && base.length > 0 ? base : trimmed
}

