// Unit tests for the A6 sidecar env allowlist (sidecar-env.ts). The contract under test IS the A6
// acceptance criterion: no secret (ALPHA_API_KEY / BYOK keys / ALPHA_CLOUD_TOKEN / EXA_API_KEY /
// DEV_PLATFORM_TOKEN) may survive into the env that MCP/LSP/shell children inherit, while everything
// the sidecar genuinely needs must still pass.

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { createSidecarEnv, isSecretish } from "./sidecar-env"

describe("createSidecarEnv — default-deny", () => {
  test("strips every secret named by the A6 acceptance criteria", () => {
    const env = createSidecarEnv({
      ALPHA_API_KEY: "jwt",
      ALPHA_CLOUD_TOKEN: "bearer",
      DEEPSEEK_API_KEY: "sk-1",
      MOONSHOT_API_KEY: "sk-2",
      EXA_API_KEY: "exa",
      DEV_PLATFORM_TOKEN: "dev",
      PATH: "/usr/bin",
    })
    expect(env.ALPHA_API_KEY).toBeUndefined()
    expect(env.ALPHA_CLOUD_TOKEN).toBeUndefined()
    expect(env.DEEPSEEK_API_KEY).toBeUndefined()
    expect(env.MOONSHOT_API_KEY).toBeUndefined()
    expect(env.EXA_API_KEY).toBeUndefined()
    expect(env.DEV_PLATFORM_TOKEN).toBeUndefined()
    expect(env.PATH).toBe("/usr/bin")
  })

  test("drops arbitrary unknown vars (default-deny, not a blocklist)", () => {
    const env = createSidecarEnv({ RANDOM_SHELL_EXPORT: "x", AWS_SECRET_ACCESS_KEY: "y", DEBUG: "1", LD_PRELOAD: "z" })
    expect(Object.keys(env)).toEqual([])
  })

  test("passes the system/proxy/node basics children legitimately need", () => {
    const env = createSidecarEnv({
      PATH: "/usr/bin",
      HOME: "/Users/u",
      SHELL: "/bin/zsh",
      TMPDIR: "/tmp",
      LANG: "en_US.UTF-8",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      HTTPS_PROXY: "http://127.0.0.1:7890",
      no_proxy: "localhost",
      NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
    })
    for (const key of [
      "PATH",
      "HOME",
      "SHELL",
      "TMPDIR",
      "LANG",
      "SSH_AUTH_SOCK",
      "HTTPS_PROXY",
      "no_proxy",
      "NODE_EXTRA_CA_CERTS",
    ]) {
      expect(env[key]).toBeDefined()
    }
  })

  test("passes the non-secret alpha controls the sidecar reads", () => {
    const env = createSidecarEnv({
      ALPHA_BASE_URL: "https://gw.example/v1",
      ALPHA_CLOUD_MCP_URL: "https://mcp.example",
      ALPHA_DEFAULT_MODEL: "alpha/x",
      ALPHA_MODELS_DISABLE: "1",
      ALPHA_IDENTITY_DISABLE: "1",
      ALPHA_BEHAVIOR_DISABLE: "1",
      ALPHA_WEBSEARCH_DISABLE: "1",
      // main-only alpha vars must NOT pass
      ALPHA_WEB_URL: "https://web.example",
      ALPHA_SHOT: "1",
    })
    expect(env.ALPHA_BASE_URL).toBe("https://gw.example/v1")
    expect(env.ALPHA_CLOUD_MCP_URL).toBe("https://mcp.example")
    expect(env.ALPHA_DEFAULT_MODEL).toBe("alpha/x")
    expect(env.ALPHA_MODELS_DISABLE).toBe("1")
    expect(env.ALPHA_IDENTITY_DISABLE).toBe("1")
    expect(env.ALPHA_BEHAVIOR_DISABLE).toBe("1")
    expect(env.ALPHA_WEBSEARCH_DISABLE).toBe("1")
    expect(env.ALPHA_WEB_URL).toBeUndefined()
    expect(env.ALPHA_SHOT).toBeUndefined()
  })

  test("passes OPENCODE_/XDG_/LC_/ELECTRON_ prefixes (channel DB, state home, locale, dev exec path)", () => {
    const env = createSidecarEnv({
      OPENCODE_ENABLE_EXA: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_CHANNEL: "prod",
      XDG_STATE_HOME: "/Users/u/Library/Application Support/alpha-code",
      LC_ALL: "en_US.UTF-8",
      ELECTRON_EXEC_PATH: "/opt/electron",
    })
    expect(env.OPENCODE_ENABLE_EXA).toBe("1")
    expect(env.OPENCODE_DISABLE_MODELS_FETCH).toBe("1")
    expect(env.OPENCODE_CHANNEL).toBe("prod")
    expect(env.XDG_STATE_HOME).toBeDefined()
    expect(env.LC_ALL).toBeDefined()
    expect(env.ELECTRON_EXEC_PATH).toBeDefined()
  })

  test("vetoes credential-shaped names even under an allowed prefix", () => {
    const env = createSidecarEnv({ OPENCODE_API_KEY: "zen", ELECTRON_GITHUB_TOKEN: "gh", OPENCODE_CLIENT: "desktop" })
    expect(env.OPENCODE_API_KEY).toBeUndefined()
    expect(env.ELECTRON_GITHUB_TOKEN).toBeUndefined()
    expect(env.OPENCODE_CLIENT).toBe("desktop")
  })
})

describe("createSidecarEnv — escape hatch", () => {
  test("ALPHA_ENV_ALLOWLIST_EXTRA passes the named non-secret vars through", () => {
    const env = createSidecarEnv({
      ALPHA_ENV_ALLOWLIST_EXTRA: "MY_CUSTOM_VAR, MY_PROVIDER_BASE_URL",
      MY_CUSTOM_VAR: "v",
      MY_PROVIDER_BASE_URL: "https://p.example/v1",
      UNNAMED_VAR: "not-in-the-hatch",
      DEEPSEEK_API_KEY: "still-stripped",
    })
    expect(env.MY_CUSTOM_VAR).toBe("v")
    expect(env.MY_PROVIDER_BASE_URL).toBe("https://p.example/v1")
    expect(env.UNNAMED_VAR).toBeUndefined()
    expect(env.DEEPSEEK_API_KEY).toBeUndefined()
    // the hatch itself stays visible for diagnostics
    expect(env.ALPHA_ENV_ALLOWLIST_EXTRA).toBeDefined()
  })

  // #603: the hatch used to pass its named vars BEFORE the SECRETISH guard, so
  // ALPHA_ENV_ALLOWLIST_EXTRA=ALPHA_API_KEY leaked the raw platform bearer into the sidecar and
  // every MCP/LSP/agent-shell child it spawns. The A6 / startup-baseline ③ invariant "a token never
  // enters the sidecar env" is absolute: no user opt-in may waive it.
  test("vetoes the absolute platform tokens even when named in the hatch", () => {
    const env = createSidecarEnv({
      ALPHA_ENV_ALLOWLIST_EXTRA: "ALPHA_API_KEY,ALPHA_CLOUD_TOKEN,DEV_PLATFORM_TOKEN",
      ALPHA_API_KEY: "jwt",
      ALPHA_CLOUD_TOKEN: "bearer",
      DEV_PLATFORM_TOKEN: "dev",
    })
    expect(env.ALPHA_API_KEY).toBeUndefined()
    expect(env.ALPHA_CLOUD_TOKEN).toBeUndefined()
    expect(env.DEV_PLATFORM_TOKEN).toBeUndefined()
  })

  test("vetoes any credential-shaped name named in the hatch (SECRETISH, not a fixed blocklist)", () => {
    const names = ["EXA_API_KEY", "GH_TOKEN", "DB_PASSWORD", "SOME_CREDENTIAL", "AWS_SECRET_ACCESS_KEY", "my_api_key"]
    const env = createSidecarEnv({
      ALPHA_ENV_ALLOWLIST_EXTRA: names.join(","),
      ...Object.fromEntries(names.map((name) => [name, "leak"])),
      MY_CUSTOM_VAR: "kept",
    })
    for (const name of names) expect(env[name]).toBeUndefined()
    expect(Object.values(env)).not.toContain("leak")
  })

  test("the veto is absolute: no path (hatch, exact, prefix) passes a credential-shaped name", () => {
    const env = createSidecarEnv({
      ALPHA_ENV_ALLOWLIST_EXTRA: "ALPHA_API_KEY,OPENCODE_API_KEY,MY_CUSTOM_VAR",
      ALPHA_API_KEY: "jwt",
      OPENCODE_API_KEY: "zen",
      OPENCODE_CLIENT: "desktop",
      PATH: "/usr/bin",
      MY_CUSTOM_VAR: "v",
    })
    // isSecretish, not a re-typed regex: a copy would keep asserting whatever the predicate USED to
    // be after someone edits it (#605 / startup baseline ③″3-1 禁止镜像).
    expect(Object.keys(env).filter(isSecretish)).toEqual([])
    // …while the hatch and the ordinary allowlist keep working
    expect(env.MY_CUSTOM_VAR).toBe("v")
    expect(env.OPENCODE_CLIENT).toBe("desktop")
    expect(env.PATH).toBe("/usr/bin")
  })

  // R1 Minor: the case above admits both secrets through the hatch, so it cannot tell "the hatch is
  // vetoed" apart from "the prefix rule is vetoed". These two isolate one path each.
  test("prefix path alone (no hatch at all) vetoes a credential-shaped name", () => {
    const env = createSidecarEnv({ OPENCODE_API_KEY: "zen", OPENCODE_CLIENT: "desktop" })
    expect(env.OPENCODE_API_KEY).toBeUndefined()
    expect(env.OPENCODE_CLIENT).toBe("desktop")
  })

  test("hatch path alone (name matches no prefix and no exact entry) vetoes a credential-shaped name", () => {
    const env = createSidecarEnv({ ALPHA_ENV_ALLOWLIST_EXTRA: "WIDGET_TOKEN", WIDGET_TOKEN: "leak" })
    expect(env.WIDGET_TOKEN).toBeUndefined()
    expect(Object.values(env)).not.toContain("leak")
  })

  // R1 Minor, third path: EXACT is module-private, so a credential-shaped member cannot be injected
  // from a test. What makes the EXACT path safe is the pair (a) the veto runs before the EXACT check
  // and (b) no EXACT member is credential-shaped. (a) is structural; this guard holds (b) — so the
  // regression "someone adds FOO_TOKEN to EXACT" fails here loudly instead of leaking silently.
  //
  // #605 invariant I2. The filter calls isSecretish (the production predicate) rather than a re-typed
  // regex: the copy this line used to hold would have gone on asserting the pre-#605 substring rule
  // while production ran the narrowed one, i.e. the guard would have silently stopped guarding.
  test("guard: no EXACT allowlist entry is credential-shaped", () => {
    const src = fs.readFileSync(path.join(import.meta.dir, "sidecar-env.ts"), "utf8")
    const block = src.match(/const EXACT = new Set\(\[([\s\S]*?)\]\)/)
    expect(block).not.toBeNull()
    const names = [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
    expect(names.length).toBeGreaterThan(20)
    expect(names.filter(isSecretish)).toEqual([])
  })

  // #606 turned the guard above into a live concern: it proves no EXACT member is credential-SHAPED,
  // but not that every member actually survives the function. Same invariant (I2) from the behavior
  // side, and it stays valid no matter how the veto is spelled — an EXACT entry that any DENY rule
  // eats is an allowlist entry that silently does nothing, which is how #606's two switches were
  // dead in the first place (they were simply absent; this catches the near-miss where someone adds
  // a name that a DENY rule then swallows).
  test("guard: every EXACT allowlist entry really survives createSidecarEnv", () => {
    const src = fs.readFileSync(path.join(import.meta.dir, "sidecar-env.ts"), "utf8")
    const names = [...src.match(/const EXACT = new Set\(\[([\s\S]*?)\]\)/)![1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
    expect(names.length).toBeGreaterThan(20)
    const env = createSidecarEnv(Object.fromEntries(names.map((name) => [name, `v-${name}`])))
    expect(names.filter((name) => env[name] !== `v-${name}`)).toEqual([])
  })

  // NEVER_INHERIT is compared lowercased, so an entry written in uppercase would silently never
  // match. Same guard shape as above: make that mistake fail here instead of leaking.
  test("guard: every NEVER_INHERIT entry is lowercase (it is compared lowercased)", () => {
    const src = fs.readFileSync(path.join(import.meta.dir, "sidecar-env.ts"), "utf8")
    const block = src.match(/const NEVER_INHERIT = new Set\(\[([\s\S]*?)\]\)/)
    expect(block).not.toBeNull()
    const names = [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
    expect(names.length).toBeGreaterThan(0)
    expect(names.filter((name) => name !== name.toLowerCase())).toEqual([])
  })
})

// #605: SECRETISH went from a bare substring match to word-boundary + trailing-word. That is a DENY
// predicate being NARROWED — structurally the fail-open direction (startup baseline ③″4-2: ALLOW 放宽
// = 扩大攻击面; ③″4-4: 修 fail-closed 极易修成 fail-open). So the must-DENY matrix below is the
// REVERSE GATE the baseline demands: it is not here to show the new rule is precise, it is here to
// go red the moment the narrowing lets a real credential name through.
describe("createSidecarEnv — SECRETISH word boundary (#605)", () => {
  // The exact 11 names #603 measured as vetoed. Not one may become admissible.
  const MUST_DENY = [
    "ALPHA_API_KEY",
    "ALPHA_CLOUD_TOKEN",
    "DEV_PLATFORM_TOKEN",
    "EXA_API_KEY",
    "DEEPSEEK_API_KEY",
    "OPENCODE_API_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "GH_TOKEN",
    "DB_PASSWORD",
    "SOME_CREDENTIAL",
    "my_api_key",
    // #605 R1 (adversarial): the first boundary rewrite SHIPPED a leak here. These are real,
    // currently-supported credential vars — the HashiCorp Google provider stuffs the raw
    // service-account JSON into them — and `KEY` buried in `_KEYFILE_` satisfied neither rule.
    "GOOGLE_CLOUD_KEYFILE_JSON",
    "GCLOUD_KEYFILE_JSON",
    // Re-judged in the same round: KEYSTORE/KEYCHAIN really do hold keys, so the earlier verdict
    // that filed them as "innocent old-deny→new-allow" was wrong. Over-denial is the safe side.
    "KEYSTORE_DIR",
    "KEYCHAIN_PATH",
    "OPENCODE_KEYFILE",
    // Corpus widened after the leak: the family that slipped through was absent from the first
    // corpus, so cloud / IaC / CI / db credential names are now first-class must-deny entries.
    "GOOGLE_APPLICATION_CREDENTIALS",
    "AZURE_CLIENT_SECRET",
    "VAULT_TOKEN",
    "NPM_TOKEN",
    "CI_JOB_TOKEN",
    "PGPASSWORD",
    "SSH_KEYFILE",
    "JAVA_KEYSTORE",
    "GPG_KEYRING",
    // 对抗审 R2 新报三族:KEYTAB(HashiCorp Vault provider 的 Kerberos keytab)、
    // KEYSET(Tink 密钥集)、以及「名词不在段首 + 包装段被 _ 分隔」的 *_FILE 形态。
    "KRB_KEYTAB",
    "TINK_KEYSET_JSON",
    "APIKEY_FILE",
    "APIPASSWORD_FILE",
    "PRIVATEKEY_PATH",
  ]

  // #605 must-allow: the false positives the substring match caused, plus every name #603 measured
  // as passing (the narrowing must not disturb them either).
  const MUST_ALLOW = [
    "MONKEY_MODE",
    "KEYBOARD_LAYOUT",
    "TURKEY_REGION",
    "TOKENIZER_PATH",
    "MY_CUSTOM_VAR",
    "MY_PROVIDER_BASE_URL",
    "JAVA_HOME",
    "GOPATH",
    "OPENCODE_CLIENT",
    "PATH",
    "ALPHA_BASE_URL",
  ]

  test("reverse gate: every must-deny name stays vetoed, on the path that would admit them", () => {
    // The hatch names every one of them, so each has an allow rule behind it; only the veto stops
    // them. A distinct probe value per name proves the VALUE is gone, not merely the key.
    const env = createSidecarEnv({
      ALPHA_ENV_ALLOWLIST_EXTRA: [...MUST_DENY, "MY_CUSTOM_VAR"].join(","),
      ...Object.fromEntries(MUST_DENY.map((name) => [name, `leak-${name}`])),
      MY_CUSTOM_VAR: "kept",
    })
    for (const name of MUST_DENY) {
      expect(env[name]).toBeUndefined()
      expect(JSON.stringify(env)).not.toContain(`leak-${name}`)
    }
    // …and the run was not vacuous: the hatch really was live on this call.
    expect(env.MY_CUSTOM_VAR).toBe("kept")
    expect(MUST_DENY.length).toBe(30)
  })

  test("reverse gate: the predicate itself vetoes every must-deny name (hatch/EXACT/prefix)", () => {
    expect(MUST_DENY.filter((name) => !isSecretish(name))).toEqual([])
  })

  test("reverse gate: the no-separator and plural classes are dropped on the prefix path", () => {
    // OPENCODE_APIKEY is the shape rule 1 alone would have re-opened; OPENCODE_API_KEYS is the shape
    // BOTH rules miss without `S?`. Both ride an allowed prefix, so only the veto can stop them.
    const env = createSidecarEnv({
      OPENCODE_APIKEY: "leak-apikey",
      OPENCODE_API_KEYS: "leak-plural",
      OPENCODE_ACCESS_TOKENS: "leak-tokens",
      OPENCODE_CLIENT: "desktop",
    })
    expect(env.OPENCODE_APIKEY).toBeUndefined()
    expect(env.OPENCODE_API_KEYS).toBeUndefined()
    expect(env.OPENCODE_ACCESS_TOKENS).toBeUndefined()
    expect(JSON.stringify(env)).not.toContain("leak-")
    expect(env.OPENCODE_CLIENT).toBe("desktop")
  })

  test("no longer vetoes the MONKEY_MODE class, and the passing names #603 measured still pass", () => {
    expect(MUST_ALLOW.filter(isSecretish)).toEqual([])
    // Clearing the veto is only half of it — they must actually arrive in the sidecar env.
    const viaHatch = MUST_ALLOW.filter((name) => !["OPENCODE_CLIENT", "PATH", "ALPHA_BASE_URL"].includes(name))
    const env = createSidecarEnv({
      ALPHA_ENV_ALLOWLIST_EXTRA: viaHatch.join(","),
      ...Object.fromEntries(MUST_ALLOW.map((name) => [name, `value-${name}`])),
    })
    expect(MUST_ALLOW.filter((name) => env[name] === undefined)).toEqual([])
  })

  // Every edge case #605 required to be adjudicated explicitly, verdict inline. `true` = vetoed.
  test("edge cases: explicit verdicts, including the accepted residuals", () => {
    const verdicts: Array<[string, boolean]> = [
      // — named in the issue —
      ["KEY", true], // bare word: rule 1 as ^KEY$
      ["TOKEN_", true], // trailing separator: rule 1 as ^TOKEN_
      ["_SECRET", true], // leading separator: rule 1 as _SECRET$
      ["APIKEY", true], // NO separator. THE risk of the rewrite; rule 2 keeps it denied
      ["MYKEY", true], // ditto — the second name the issue calls out
      ["KRB_KEYTAB", true],
      ["TINK_KEYSET", true],
      ["APIKEY_FILE", true],
      // — 剥包装段不得反向误杀:短化后仍不匹配的名字照旧放行 —
      ["KEYBOARD_FILE", false],
      // — 刻意不收 VAULT:AZURE_KEYVAULT_URL 是服务地址,认证那半仍由 SECRET/TOKEN 拼写 —
      ["AZURE_KEYVAULT_URL", false],
      // — 剥离引入的**过拦**面(R3):尾锚 $ 会把中段偶合的名词暴露成尾词。
      //   ("只缩短所以反向安全"那句论证是错的,已在实现里更正。)
      //   下面三条**只把已知的过拦类别文档化** —— 它们不扫描未来的 env 名,新变量落进这一类
      //   **不会**自动让任何用例转红。一次**有限词法抽样**只表明:这 70 个片段中的新增拒绝为空集
      //   (packages/ui-mac/src 下静态大写点访问)。该抽样不覆盖
      //   动态读取 / 解构 / 作为参数传递的 env 对象 / 上游内嵌 server。 —
      ["MONKEY_FILE", true],
      ["TURKEY_PATH", true],
      ["CATALOG_PUBKEY_B64", true],
      ["XKEYX", false], // ACCEPTED RESIDUAL: buried, non-trailing, no separator
      // — the no-separator class rule 2 exists for —
      ["GITHUBTOKEN", true],
      ["AWSSECRET", true],
      ["myApiKey", true], // camelCase suffix, caught by /i + rule 2
      // — the plural class `S?` exists for —
      ["API_KEYS", true],
      ["ACCESS_TOKENS", true],
      ["SOME_CREDENTIALS", true],
      ["DB_PASSWORDS", true],
      // — the false positives this ticket removes —
      ["MONKEY_MODE", false],
      ["KEYBOARD_LAYOUT", false],
      ["TURKEY_REGION", false],
      ["DONKEY_CART", false],
      ["TOKENIZER_PATH", false],
      // — accepted OVER-denial (safe direction): the word IS the trailing segment —
      ["MONKEY", true],
      ["TURKEY", true],
      ["DONKEYS", true],
      // — CONTAINER compounds: noun + FILE/STORE/CHAIN/RING/PAIR/DATA still denotes the secret.
      //   KEYFILE and KEYBOARD are structurally identical (noun + suffix); shape alone cannot
      //   separate them, which is why the container words are a closed enumeration (#605 R1). —
      ["OPENCODE_KEYFILE", true],
      ["GOOGLE_CLOUD_KEYFILE_JSON", true],
      ["KEYSTORE_DIR", true],
      ["KEYCHAIN_PATH", true],
      ["GPG_KEYRING", true],
      ["SIGNING_KEYPAIR", true],
      ["TOKENSTORE", true],
      // — accepted RESIDUAL under-denial: noun buried, not trailing, no separator.
      //   NOTE: an earlier version of this note said "one name, not a family" — that was WRONG and
      //   the adversarial round disproved it with KRB_KEYTAB / TINK_KEYSET / APIKEY_FILE. The honest
      //   bound is "whatever the CONTAINER and WRAPPER lists currently enumerate"; a credential
      //   spelling that fits neither list still passes. The corpus differential below is the gate
      //   that makes each widening visible — it cannot prove the enumeration complete. —
      ["XKEYX", false],
    ]
    expect(verdicts.map(([name]) => [name, isSecretish(name)])).toEqual(verdicts.map(([n, v]) => [n, v]))
  })

  // The differential the I3 note in sidecar-env.ts points at. I3 is a STRUCTURAL argument plus THIS
  // evidence — it is not an independent gate (see that note). What this does gate: narrowing the
  // DENY predicate must not stop vetoing any real credential name, in either direction.
  test("corpus differential: no real credential name moved from denied to allowed", () => {
    const OLD_SUBSTRING = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i
    // Real credential var names, widened after #605 R1 (the *_KEYFILE_JSON family was absent from
    // the first corpus, which is exactly why the leak shipped).
    const REAL_CREDENTIALS = [
      ...MUST_DENY,
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AZURE_CLIENT_SECRET",
      "GOOGLE_CLOUD_KEYFILE_JSON",
      "GCLOUD_KEYFILE_JSON",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "TF_VAR_credentials",
      "PULUMI_ACCESS_TOKEN",
      "GITHUB_TOKEN",
      "GITLAB_TOKEN",
      "CIRCLE_TOKEN",
      "NPM_TOKEN",
      "CARGO_REGISTRY_TOKEN",
      "PGPASSWORD",
      "MYSQL_PWD_SECRET",
      "REDIS_PASSWORD",
      "RABBITMQ_DEFAULT_PASS_SECRET",
      "KAFKA_SASL_PASSWORD",
      "DOCKER_REGISTRY_PASSWORD",
      "VAULT_TOKEN",
      "SSH_KEYFILE",
      "JAVA_KEYSTORE",
      "ANDROID_KEYSTORE",
      "GPG_KEYRING",
      "SIGNING_KEYPAIR",
      "SERVICE_ACCOUNT_KEYDATA",
      "APIKEY",
      "MYKEY",
      "GITHUBTOKEN",
      "API_KEYS",
      "ACCESS_TOKENS",
    ]
    const INNOCENT = [
      ...MUST_ALLOW,
      "DONKEY_CART",
      "TOKENIZERS_PARALLELISM",
      "PASSWORDLESS_MODE",
      "SECRETARY_NAME",
      "MONKEY_BUSINESS",
      "KEYBOARD_SHORTCUTS",
    ]
    const corpus = [...new Set([...REAL_CREDENTIALS, ...INNOCENT])]

    // Direction that would leak: old vetoed it, new does not.
    const nowAllowed = corpus.filter((name) => OLD_SUBSTRING.test(name) && !isSecretish(name))
    expect(nowAllowed.filter((name) => REAL_CREDENTIALS.includes(name))).toEqual([])

    // Direction that would silently narrow ALLOW: old admitted it, new vetoes it.
    expect(corpus.filter((name) => !OLD_SUBSTRING.test(name) && isSecretish(name))).toEqual([])

    // Not vacuous: the differential really does have transitions, and they are all innocent.
    expect(nowAllowed.length).toBeGreaterThan(0)
    expect(nowAllowed.every((name) => INNOCENT.includes(name))).toBe(true)
  })
})

// #606: sidecar.ts reads ALPHA_JSONC_TRUTH_DISABLE / ALPHA_LEGACY_INSTALL_ROOT inside the SIDECAR
// process to decide whether to inject OPENCODE_CONFIG, but neither name was in EXACT — and the
// sidecar's env is this function's explicit return object (Electron ForkOptions.env inherits
// process.env only when OMITTED, server.ts:191). So the reads could never see them: both escape
// hatches were dead. They are not obsolete — main still honours them in index.ts (desired-state
// reconcile), engine-config-truth-boot.ts (truth migration), ext-config.ts (mcp/plugin/provider
// write target), ext-fs-installer.ts, factory-skills.ts and ext-install-planner.ts, and ADR-019 §5 /
// ADR-028 name ALPHA_LEGACY_INSTALL_ROOT as the documented rollback surface. Forwarding them (route
// 1) is therefore the fix; deleting the sidecar read (route 2) would leave main in legacy mode while
// the sidecar kept injecting — req053 设计稿 §风险8「逃生舱错位」exactly.
describe("createSidecarEnv — escape switches the sidecar itself reads (#606)", () => {
  for (const name of ["ALPHA_JSONC_TRUTH_DISABLE", "ALPHA_LEGACY_INSTALL_ROOT"]) {
    test(`${name}=1 reaches the sidecar env`, () => {
      const env = createSidecarEnv({ [name]: "1", PATH: "/usr/bin" })
      expect(env[name]).toBe("1")
    })
  }

  test("both switches are forwarded together, and neither is credential-shaped", () => {
    const env = createSidecarEnv({
      ALPHA_JSONC_TRUTH_DISABLE: "1",
      ALPHA_LEGACY_INSTALL_ROOT: "1",
      ALPHA_GLOBAL_DIR: "/Users/u/.alpha",
      ALPHA_API_KEY: "jwt",
    })
    expect(env.ALPHA_JSONC_TRUTH_DISABLE).toBe("1")
    expect(env.ALPHA_LEGACY_INSTALL_ROOT).toBe("1")
    expect(isSecretish("ALPHA_JSONC_TRUTH_DISABLE")).toBe(false)
    expect(isSecretish("ALPHA_LEGACY_INSTALL_ROOT")).toBe(false)
    // adding them must not have disturbed anything else on the path
    expect(env.ALPHA_GLOBAL_DIR).toBe("/Users/u/.alpha")
    expect(env.ALPHA_API_KEY).toBeUndefined()
  })
})

// #603 R1 Blocker: a name-based veto is blind to secrets carried in a VALUE. OPENCODE_CONFIG_CONTENT
// is a whole-config JSON blob; its name matches no SECRETISH word but it can embed an inline
// provider apiKey, and the OPENCODE_ prefix rule used to forward it verbatim. Blast radius is the
// same as a raw key var: sidecar.ts:419 writes it back into the sidecar's process.env, and upstream
// MCP/LSP/PTY spread the whole process.env into third-party children.
//
// Scope note (why there is no "generated content passes" case here): createSidecarEnv runs ONLY in
// main, to build the fork env. The sidecar's own content is produced post-fork by injectAlphaConfig
// (sidecar.ts:157, not exported, single call site :135) and written straight to its own process.env
// at :419 — it never traverses this function. So the drop is unconditional and does not need to
// inspect the value; alpha's injection is unaffected. The tests that protect alpha's injection are
// the "inputs still pass" case below.
describe("createSidecarEnv — container-valued vars", () => {
  test("drops externally inherited OPENCODE_CONFIG_CONTENT carrying an inline apiKey", () => {
    const env = createSidecarEnv({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        provider: { deepseek: { options: { apiKey: "sk-inline-probe-value" } } },
      }),
      PATH: "/usr/bin",
    })
    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined()
    // the probe VALUE must be absent from the env, not merely the variable name
    expect(JSON.stringify(env)).not.toContain("sk-inline-probe-value")
    expect(env.PATH).toBe("/usr/bin")
  })

  // R2 Blocker: Windows env keys are case-insensitive, and Object.entries() yields whatever casing
  // the OS stored. A Set lookup is case-SENSITIVE, so a lowercase twin slipped past the drop while
  // the sidecar's `process.env.OPENCODE_CONFIG_CONTENT` read (sidecar.ts:173) still resolved it on
  // Windows. ui-mac really ships there (package.json `ship:windows`).
  test("drops OPENCODE_CONFIG_CONTENT under Windows casing, even when named in the hatch", () => {
    const env = createSidecarEnv({
      ALPHA_ENV_ALLOWLIST_EXTRA: "opencode_config_content",
      opencode_config_content: JSON.stringify({ provider: { p: { options: { apiKey: "sk-win-probe" } } } }),
      PATH: "/usr/bin",
    })
    expect(env.opencode_config_content).toBeUndefined()
    expect(JSON.stringify(env)).not.toContain("sk-win-probe")
    expect(env.PATH).toBe("/usr/bin")
  })

  test("drops OPENCODE_CONFIG_CONTENT under any mixed casing", () => {
    for (const key of ["Opencode_Config_Content", "OPENCODE_config_CONTENT", "openCODE_CONFIG_content"]) {
      const env = createSidecarEnv({ [key]: JSON.stringify({ apiKey: "sk-mixed-probe" }) })
      expect(env[key]).toBeUndefined()
      expect(JSON.stringify(env)).not.toContain("sk-mixed-probe")
    }
  })

  test("drops externally inherited OPENCODE_CONFIG_CONTENT regardless of what the value holds", () => {
    // Uniform rule: no value parsing. A {file:}-only blob is dropped too — main has no business
    // forwarding a config blob at all, and the sidecar builds its own after fork.
    const env = createSidecarEnv({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { p: { options: { apiKey: "{file:/tmp/k}" } } } }),
    })
    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined()
  })

  // NAMING IS DELIBERATE (R2 Minor): this asserts only that createSidecarEnv still forwards the
  // INPUTS alpha's injection reads. It is NOT a gate on the injection succeeding — injectAlphaConfig
  // could throw internally, be swallowed by its function-level catch (sidecar.ts:421), produce no
  // content at all, and this test would stay green. That end-to-end gate cannot live in this repo's
  // test process today: sidecar.ts is unimportable under bun because its first import,
  // `registerHooks` from node:module (the ADR-006 TS-resolve bridge, sidecar.ts:2/:25), is
  // undefined in bun 1.3.14 — and behind it sidecar.ts:84 calls getParentPort() at top level, which
  // throws outside a utility process. No test in this repo imports sidecar.ts for that reason.
  test("forwards the env INPUTS alpha's injection reads (not a gate on the injection succeeding)", () => {
    // injectAlphaConfig sets OPENCODE_CONFIG itself (sidecar.ts:170) and materializeV2EngineConfig
    // sets OPENCODE_CONFIG_DIR; both are PATHS, not secret containers. Closing exactly one channel
    // must not close the family.
    const env = createSidecarEnv({
      OPENCODE_CONFIG: "/Users/u/.alpha/alpha.jsonc",
      OPENCODE_CONFIG_DIR: "/Users/u/Library/Application Support/alpha-code/engine-config",
      ALPHA_IDENTITY_DISABLE: "1",
      ALPHA_BEHAVIOR_DISABLE: "1",
      ALPHA_CLOUD_MCP_URL: "https://mcp.example",
      ALPHA_GLOBAL_DIR: "/Users/u/.alpha",
    })
    expect(env.OPENCODE_CONFIG).toBe("/Users/u/.alpha/alpha.jsonc")
    expect(env.OPENCODE_CONFIG_DIR).toBeDefined()
    expect(env.ALPHA_IDENTITY_DISABLE).toBe("1")
    expect(env.ALPHA_BEHAVIOR_DISABLE).toBe("1")
    expect(env.ALPHA_CLOUD_MCP_URL).toBe("https://mcp.example")
    expect(env.ALPHA_GLOBAL_DIR).toBe("/Users/u/.alpha")
  })
})
