// Alpha narrow surface (ADR-027 revision 2026-07-24, REQ-125 #554): terminal engine seam.
// Re-exports exactly the engine pieces the alpha session workspace may consume — the
// workspace-scoped PTY tab state (useTerminal), the Ghostty terminal embed (Terminal),
// and the pty record type (LocalPTY). Nothing else: no `./surface/*` wildcard, no
// pages/context subpaths. The single sanctioned consumer is the ui-mac terminal engine
// adapter; both sides are pinned by surface-seam-contract.test.ts.
export { useTerminal } from "@/context/terminal"
export type { LocalPTY } from "@/context/terminal"
export { Terminal } from "@/components/terminal"
