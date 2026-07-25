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
//   1. `(^|_)WORD (_|$)` — the word is a whole `_`-delimited segment.
//      ALPHA_API_KEY, AWS_SECRET_ACCESS_KEY, DB_PASSWORD, my_api_key, bare KEY, TOKEN_.
//   2. `WORD $`          — the name ENDS with the word, no separator required.
//      APIKEY, MYKEY, GITHUBTOKEN, camelCase myApiKey. Rule 1 alone lets every one of those
//      through, and the trailing segment is exactly where a real key name puts the word ("this var
//      IS a key"). Dropping rule 2 is the single mutation that reopens the leak.
//
// WORD is not the bare noun. It is `NOUN CONTAINER? S?`:
//
//   NOUN      = KEY | TOKEN | SECRET | PASSWORD | CREDENTIAL
//   CONTAINER = FILE | STORE | CHAIN | RING | PAIR | DATA
//
// `S?` is not cosmetic: without it API_KEYS / ACCESS_TOKENS / SOME_CREDENTIALS are `_`-bounded on
// the left but not the right and do not end in the singular either, so BOTH rules miss them. A
// plural is the likeliest real key name a naive boundary rewrite would have re-opened.
//
// CONTAINER is the fix for a leak this rewrite ORIGINALLY SHIPPED (found by the adversarial round,
// #605 R1): GOOGLE_CLOUD_KEYFILE_JSON and GCLOUD_KEYFILE_JSON are real, currently-supported
// credential vars — the HashiCorp Google provider stuffs the raw service-account JSON into them —
// and `KEY` buried in `_KEYFILE_` satisfies neither rule 1 nor rule 2. The old substring predicate
// vetoed them; the first boundary rewrite did not.
//
// Why a suffix list and not a smarter shape rule: KEYFILE and KEYBOARD are STRUCTURALLY IDENTICAL
// (credential noun + suffix). Shape alone cannot separate them — the difference is semantic, not
// lexical. What separates them is that FILE/STORE/CHAIN/RING/PAIR/DATA name a CONTAINER OF the
// credential, so the compound still denotes the secret, whereas BOARD/-IZER/-EY make the noun a
// coincidental prefix of an unrelated word. That is the invariant this list encodes; it is a
// closed, reviewable enumeration rather than a general rule, and adding to it is the correct move
// when a new container word shows up.
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
//   I3. Narrowing a DENY rule must not widen ALLOW. **Structural argument plus differential
//       evidence — NOT an independent gate** (③″1 / ③″3-12: the honest label belongs in the source,
//       not only in a delivery report). The structure: the veto only decides what to DROP; a name it
//       stops vetoing still has to clear EXACT / PREFIXES / the hatch, and is otherwise dropped by
//       default-deny. The evidence: the corpus differential in the test file reports every
//       old-deny→new-allow transition and asserts none of them is a real credential name, plus
//       old-allow→new-deny = 0. What is NOT enforced: adding an untested benign name to EXACT does
//       widen ALLOW and no gate reddens (the must-allow matrix only asserts known names survive;
//       there is no "nothing else got in" assertion). Stated so the next reader does not mistake
//       this row for a gated invariant.
//
// Accepted residual, stated rather than hidden: a credential noun buried mid-name with no separator
// and not in trailing position (XKEYX) is not vetoed. It must still clear an allow rule to reach the
// sidecar. Two earlier versions of this note were WRONG and the corrections are kept visible on
// purpose: v1 filed the whole *_KEYFILE family here ("a keyfile name is a path, not the secret" —
// disproved by GOOGLE_CLOUD_KEYFILE_JSON), and v2 then claimed the residual was "one name, not a
// family" — also disproved, by KRB_KEYTAB / TINK_KEYSET / APIKEY_FILE. The honest statement is that
// this residual is bounded by what the CONTAINER and WRAPPER lists currently enumerate, and a new
// credential spelling that fits neither list will pass. That is why the corpus differential gate
// below exists, and why widening the corpus is the review action when a new family shows up. Symmetrically, a BARE MONKEY /
// TURKEY / DONKEY is still vetoed by rule 2 — over-denial is the safe direction, and every reported
// false positive was `MONKEY_MODE`-shaped (noun not trailing).
const CREDENTIAL_NOUN = "KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL"
// Round 2 of the adversarial review added TAB (KRB_KEYTAB — the HashiCorp Vault provider points it
// at a Kerberos keytab holding login entries) and SET (TINK_KEYSET — a Tink keyset IS the key
// collection), plus MATERIAL/BLOB/BUNDLE by the same "compound still denotes the secret" standard.
// Deliberately NOT here: VAULT. AZURE_KEYVAULT_URL is a service address, and the authenticating
// half is still spelled with SECRET/TOKEN — vetoing on KEYVAULT would re-create an obvious
// false positive.
const CREDENTIAL_CONTAINER = "FILE|STORE|CHAIN|RING|PAIR|DATA|TAB|SET|MATERIAL|BLOB|BUNDLE"
const CREDENTIAL_WORD = `(?:${CREDENTIAL_NOUN})(?:${CREDENTIAL_CONTAINER})?S?`
const SECRETISH = new RegExp(`(^|_)${CREDENTIAL_WORD}(_|$)|${CREDENTIAL_WORD}$`, "i")

// Widening the CONTAINER list alone was still not enough (adversarial round 2): in APIKEY_FILE the
// noun is not at a segment start (the segment is APIKEY, and APIKEY !== KEY) while FILE has been
// split off into its own `_` segment, so NEITHER rule can see it. APIPASSWORD_FILE, PRIVATEKEY_PATH
// and TINK_KEYSET_JSON are the same shape, and all of them are env vars real projects use to point
// at a secrets file. So a trailing WRAPPER segment is stripped and the name retested: the wrapper
// says "this var carries the thing", it never makes the thing stop being a credential. Stripping is
// safe in the other direction because it only ever shortens the name — KEYBOARD_FILE reduces to
// KEYBOARD, which still matches nothing.
const WRAPPER_SEGMENT = /_(FILE|PATH|JSON|B64|BASE64|CONTENTS?)$/i

/** The credential-name veto. Exported so its gates execute the production predicate, not a copy. */
export function isSecretish(name: string): boolean {
  let candidate = name
  // Bounded: every iteration strips one trailing segment, so it terminates on the name's length.
  for (let i = 0; i < 4; i++) {
    if (SECRETISH.test(candidate)) return true
    const stripped = candidate.replace(WRAPPER_SEGMENT, "")
    if (stripped === candidate) break
    candidate = stripped
  }
  return SECRETISH.test(candidate)
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
