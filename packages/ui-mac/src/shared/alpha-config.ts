// Single source of truth for alpha's backend endpoint defaults. Change a domain HERE — not in
// individual pages/modules. Main-process callers layer env overrides on top (ALPHA_WEB_URL /
// ALPHA_PLATFORM_URL) for dev/staging; the renderer imports these defaults directly (it has no
// process.env). Pure constants only — NO electron/node imports — so both the main and renderer
// bundles can import this module.

export const ALPHA_ENDPOINTS = {
  /** alpha-web (C): identity / login / token / billing portal. */
  web: "https://auth.tidelabs.click",
  /** alpha-platform (B): model proxy (/v1) + MCP gateway (/mcp). */
  platform: "https://api.tidelabs.click",
} as const
