// A6: the sidecar env ALLOWLIST. Everything the sidecar's process.env contains is inherited verbatim
// by every child it spawns — third-party MCP servers, LSP servers, and agent shell commands — via
// upstream `{ ...process.env }` spreads we cannot edit (ADR-005). Default-deny is the only in-rule
// fix: main forks the sidecar with ONLY the vars below. Secrets (ALPHA_API_KEY, ALPHA_CLOUD_TOKEN,
// BYOK *_API_KEY, DEV_PLATFORM_TOKEN, EXA_API_KEY, …) are simply not in the list; model keys reach
// opencode through the {file:} channel instead (alpha-secret-files.ts).
//
// Known, accepted behavior changes (documented in docs/requirements/A6-sidecar-env-allowlist.md):
//   - EXA_API_KEY is stripped → websearch falls back to the keyless public endpoint (rate-limited;
//     keyless is already the ADR-009 default). Upstream reads it straight from env, so the file
//     channel can't serve it without re-exposing it to children.
//   - A user opencode.jsonc custom provider whose apiKey is "{env:MY_VAR}" no longer sees MY_VAR.
//     Migrate the ref to "{file:...}" — or use the escape hatch below.
//   - Agent shell commands no longer see the user's full shell exports (the shell is spawned
//     non-login with the sidecar env). That also means `echo $ALPHA_API_KEY` now prints nothing.
//
// Escape hatch: ALPHA_ENV_ALLOWLIST_EXTRA="VAR1,VAR2" passes the named vars through verbatim. This
// re-opens child inheritance for exactly those vars — an explicit, per-var user decision.
//
// DEBUG and LD_PRELOAD, which the old copy-everything implementation deleted case-by-case, now fall
// out via default-deny like everything else.

const EXACT = new Set([
  // POSIX/system basics the server, node, git and package managers need
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TERM",
  "COLORTERM",
  "LANG",
  "TZ",
  // git-over-ssh from agent shells (socket path, not a credential value)
  "SSH_AUTH_SOCK",
  // proxy stack — sidecar.ts useEnvProxy()/ensureLoopbackNoProxy() read these
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  // node runtime knobs (non-secret)
  "NODE_ENV",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  // alpha non-secret controls the SIDECAR reads (injectAlphaConfig/buildAlphaModelConfig).
  // NEVER add a token/key var here — that's what the {file:} channel is for (A6).
  "ALPHA_BASE_URL",
  "ALPHA_CLOUD_MCP_URL",
  "ALPHA_DEFAULT_MODEL",
  "ALPHA_MODELS_DISABLE",
  "ALPHA_IDENTITY_DISABLE",
  "ALPHA_BEHAVIOR_DISABLE",
  "ALPHA_WEBSEARCH_DISABLE",
  // REQ-062 路线A 逃生门(ext 插件在引擎进程内读:T1 转写 + T3/T6 内容接管一键回退)
  "ALPHA_PROMPT_REBRAND_DISABLE",
  // the escape hatch itself, so the sidecar can surface it in diagnostics
  "ALPHA_ENV_ALLOWLIST_EXTRA",
])

// Prefix families that are config/infrastructure, not credentials. The SECRETISH guard below still
// vetoes anything credential-shaped that sneaks under a prefix (e.g. a hypothetical OPENCODE_API_KEY).
const PREFIXES = ["OPENCODE_", "XDG_", "LC_", "ELECTRON_"]
const SECRETISH = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i

export function createSidecarEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const extra = new Set(
    (source.ALPHA_ENV_ALLOWLIST_EXTRA ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  )

  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (extra.has(key)) {
      env[key] = String(value)
      continue
    }
    const allowed = EXACT.has(key) || (PREFIXES.some((prefix) => key.startsWith(prefix)) && !SECRETISH.test(key))
    if (!allowed) continue
    env[key] = String(value)
  }
  return env
}
