// A6: the sidecar env ALLOWLIST. Everything the sidecar's process.env contains is inherited verbatim
// by every child it spawns — third-party MCP servers, LSP servers, and agent shell commands — via
// upstream `{ ...process.env }` spreads we cannot edit (ADR-005). Default-deny is the only in-rule
// fix: main forks the sidecar with ONLY the vars below. Secrets (ALPHA_API_KEY, ALPHA_CLOUD_TOKEN,
// BYOK *_API_KEY, DEV_PLATFORM_TOKEN, EXA_API_KEY, …) are simply not in the list; model keys reach
// opencode through the {file:} channel instead (alpha-secret-files.ts).
//
// Known, accepted behavior changes:
//   - EXA_API_KEY is stripped → websearch falls back to the keyless public endpoint (rate-limited;
//     keyless is already the ADR-009 default). Upstream reads it straight from env, so the file
//     channel can't serve it without re-exposing it to children.
//   - A user opencode.jsonc custom provider whose apiKey is "{env:MY_VAR}" no longer sees MY_VAR.
//     Migrate the ref to "{file:...}"; a credential-shaped MY_VAR cannot be restored by the hatch.
//   - Agent shell commands no longer see the user's full shell exports (the shell is spawned
//     non-login with the sidecar env). That also means `echo $ALPHA_API_KEY` now prints nothing.
//   - An OPENCODE_CONFIG_CONTENT exported by the launching shell is dropped (#603, see
//     NEVER_INHERIT). Configure the engine through a config FILE instead (OPENCODE_CONFIG /
//     OPENCODE_CONFIG_DIR / ~/.opencode/opencode.jsonc), all of which still pass.
//
// Escape hatch: ALPHA_ENV_ALLOWLIST_EXTRA="VAR1,VAR2" passes the named vars through verbatim. This
// re-opens child inheritance for exactly those vars — an explicit, per-var user decision. It is NOT
// a secret hatch: names matching SECRETISH are vetoed even when listed (#603). The "no token in the
// sidecar env" invariant is absolute and not user-waivable, because the blast radius is not the
// user's alone to accept — every third-party MCP/LSP child would inherit the value. A user who
// needs a credential in a child process must route it through the {file:} channel instead.
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
  // REQ-065 修订:出厂技能目录(main 启动时算好,ext config hook 内存注入 —— 不落用户配置文件)
  "ALPHA_FACTORY_SKILL_DIRS",
  // REQ-067:出厂默认禁项(− 用户解禁),同为内存注入、零明文
  "ALPHA_FACTORY_DENY_SKILLS",
  // REQ-098:环境 mutable root(main 启动时由唯一环境映射落定,路径非密钥)。sidecar 的
  // injectAlphaConfig(alpha.jsonc 真源)与 @alpha-code/ext(全局根边界判定)必须与 main 同根,
  // 否则引擎会读到另一环境的可变状态(AC#1 破)。
  "ALPHA_GLOBAL_DIR",
  // REQ-059 / ADR-019 逃生阀。main 与 sidecar 必须同口径:main 侧读它们跳过 truth 迁移与
  // desired-state 投影(index.ts / engine-config-truth-boot.ts)并把 mcp/plugin/provider 写回
  // legacy 目标(ext-config.ts),sidecar 侧读它们跳过 OPENCODE_CONFIG 注入(sidecar.ts)。缺了这两项
  // 时 sidecar 收不到它们,于是 main 走 legacy 而 sidecar 照旧注入 —— 正是 req053 设计稿 §风险8
  // 「逃生舱错位」那一格,也让两个逃生阀在真出事故时按了没反应(#606)。布尔开关,非密钥。
  "ALPHA_JSONC_TRUTH_DISABLE",
  "ALPHA_LEGACY_INSTALL_ROOT",
  // the escape hatch itself, so the sidecar can surface it in diagnostics
  "ALPHA_ENV_ALLOWLIST_EXTRA",
])

// Prefix families that are config/infrastructure, not credentials. The SECRETISH veto below runs
// before every allow rule, so anything credential-shaped is dropped no matter which rule would have
// admitted it — a hypothetical OPENCODE_API_KEY under a prefix, a name listed in the escape hatch, or
// a token var mistakenly added to EXACT.
const PREFIXES = ["OPENCODE_", "XDG_", "LC_", "ELECTRON_"]

// The credential-NAME veto (#605). It used to be a bare substring match, which also vetoed innocent
// names that merely contain one of the words (MONKEY_MODE, KEYBOARD_LAYOUT, TURKEY_REGION,
// TOKENIZER_PATH) — harmless while the veto only guarded PREFIXES, but #603 hoisted it above every
// allow rule, so the false-positive surface grew to all three paths. Two alternatives now, both /i:
//
//   1. `(^|_)WORD S? (_|$)` — the word is a whole `_`-delimited segment.
//      ALPHA_API_KEY, AWS_SECRET_ACCESS_KEY, DB_PASSWORD, my_api_key, bare KEY, TOKEN_.
//   2. `WORD S? $`          — the name ENDS with the word, no separator required.
//      APIKEY, MYKEY, GITHUBTOKEN, camelCase myApiKey. Rule 1 alone lets every one of those
//      through, and the trailing segment is exactly where a real key name puts the word ("this var
//      IS a key"). Dropping rule 2 is the single mutation that reopens the leak.
//
// `S?` is not cosmetic: without it API_KEYS / ACCESS_TOKENS / SOME_CREDENTIALS are `_`-bounded on
// the left but not the right and do not end in the singular either, so BOTH rules miss them. A
// plural is the likeliest real key name a naive boundary rewrite would have re-opened.
//
// This is a DENY predicate being NARROWED — the fail-open direction (startup baseline ③″4-2/4-4).
// Invariants it now depends on, and what enforces each (③″1):
//
//   I1. Every real credential var name carries the word either as a full `_`-segment or in trailing
//       position (± plural). Enforced by the must-deny matrix in sidecar-env.test.ts: the 11 names
//       #603 measured, plus the no-separator and plural forms. Reddening mutation: delete the
//       `WORD S? $` alternative.
//   I2. No EXACT member is credential-shaped, so a veto that runs before the EXACT check cannot
//       strand a var the sidecar genuinely needs. Enforced by the "no EXACT allowlist entry is
//       credential-shaped" guard, which calls isSecretish() — re-typing the regex in the test would
//       have kept asserting the OLD predicate after this change (③″3-1 禁止镜像). Reddening
//       mutation: add a "*_TOKEN" name to EXACT.
//   I3. Narrowing a DENY rule must not widen ALLOW. Structurally enforced: the veto only decides
//       what to DROP; a name it stops vetoing still has to clear EXACT / PREFIXES / the hatch, and
//       is otherwise dropped by default-deny. Reddening mutation: any allow-rule edit fails the
//       must-allow matrix's "nothing else got in" assertions.
//
// Accepted residual, stated rather than hidden: a credential word buried mid-name with no separator
// and not in trailing position (XKEYX, OPENCODE_KEYFILE) is no longer vetoed. It must still clear an
// allow rule to reach the sidecar, and no real key var is spelled that way. Symmetrically, a BARE
// MONKEY / TURKEY / DONKEY is still vetoed by rule 2 — over-denial is the safe direction, and every
// reported false positive was `MONKEY_MODE`-shaped (word not trailing).
const SECRETISH = /(^|_)(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?(_|$)|(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?$/i

/** The credential-name veto. Exported so its gates execute the production predicate, not a copy. */
export function isSecretish(name: string): boolean {
  return SECRETISH.test(name)
}

// Container-valued vars: SECRETISH matches NAMES, so it is blind to a secret carried in the VALUE.
// OPENCODE_CONFIG_CONTENT is a whole-config JSON blob that can embed an inline provider apiKey, and
// its name matches no SECRETISH word while the OPENCODE_ prefix would forward it verbatim (#603).
// main must never forward one it inherited from the launching shell. This costs alpha nothing: main
// never produces this var (the only writer in ui-mac/src is sidecar.ts:419, which runs AFTER fork,
// inside the sidecar), and injectAlphaConfig already starts from a fresh skeleton when it is unset
// (sidecar.ts:173-174) — that is the branch every normal boot already takes. The engine keeps its
// file/dir config channels (OPENCODE_CONFIG, OPENCODE_CONFIG_DIR); only the inline-JSON-in-env
// channel is closed, and a config blob holding a real secret belongs in the {file:} channel anyway.
//
// Entries are lowercase and compared lowercased. Windows env keys are case-insensitive and
// Object.entries() yields whatever casing the OS stored, so a case-sensitive Set lookup let a
// lowercase twin through while the sidecar's `process.env.OPENCODE_CONFIG_CONTENT` read still
// resolved it (#603 R2; ui-mac ships Windows). Applied on every platform, not behind a
// process.platform branch: a DENY rule that is uniformly case-insensitive cannot be wrong, and on
// POSIX a lowercase twin is inert to the engine anyway (it reads the exact uppercase name), so
// dropping it costs nothing. The ALLOW rules below stay case-sensitive on purpose — see the loop.
const NEVER_INHERIT = new Set(["opencode_config_content"])

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
    // Both DENY rules come FIRST and are case-insensitive (SECRETISH via /i, NEVER_INHERIT via the
    // lowercased compare), so they hold on every path — including the escape hatch — under any
    // casing the OS hands us. The ALLOW rules stay case-sensitive: that can only ever admit FEWER
    // vars, and a var it declines to admit is simply dropped. Nothing reaches the sidecar without
    // clearing both DENY rules first, so no casing variant can bypass them (#603 R2).
    if (isSecretish(key)) continue
    if (NEVER_INHERIT.has(key.toLowerCase())) continue
    const allowed = extra.has(key) || EXACT.has(key) || PREFIXES.some((prefix) => key.startsWith(prefix))
    if (!allowed) continue
    env[key] = String(value)
  }
  return env
}
