import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { dirname, join, resolve } from "node:path"
import { Database } from "bun:sqlite"
import { createRequire } from "node:module"

// The OS keychain boundary is replaced with real AES-GCM, not a plaintext/base64 stand-in.
const key = randomBytes(32)
let available = true
mock.module("../src/main/alpha-keychain-backend", () => ({
  keychainBackend: () => ({
    isEncryptionAvailable: () => available,
    encryptString: (value: string) => {
      const iv = randomBytes(12)
      const c = createCipheriv("aes-256-gcm", key, iv)
      return Buffer.concat([iv, c.update(value), c.final(), c.getAuthTag()])
    },
    decryptString: (value: Buffer) => {
      const c = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12))
      c.setAuthTag(value.subarray(-16))
      return Buffer.concat([c.update(value.subarray(12, -16)), c.final()]).toString()
    },
  }),
}))
const { initAlphaEnvironment, getAlphaEnvironment, __resetAlphaEnvironmentForTests } = await import(
  "../src/main/alpha-environment"
)
const { officialNodeCommand, DBHUB_READONLY_TOML } = await import("../src/main/official-connector-recipes")
const {
  releaseOfficialConnectorResources,
  restoreCommittedOfficialConnectors,
  clearOfficialConnectorRuntime,
  officialConnectorConfig,
  officialConnectorPaths,
  officialRuntimeRoot,
  prepareOfficialConnector,
  removeOfficialConnector,
  restoreOfficialConnector,
} = await import("../src/main/official-connector-resources")
const { createPackageAdmissionCoordinator } = await import("../src/main/package-admission")
const { runExtensionTransaction, recoverExtensionTransactions } = await import("../src/main/ext-transaction")
const { findRecordV2, setDesiredStateV2 } = await import("../src/main/ext-receipt-v2")
const { decodePackageProfilePayloadV1, derivePayloadCapabilitiesV1 } = await import(
  "../src/shared/host-extension-package-contract/decoder"
)
const { evaluatePackageForHost } = await import("../src/main/package-installability")
const { createSidecarEnv } = await import("../src/main/sidecar-env")
import type {
  AlphaPackageEnvelopeV1,
  McpLocalPayloadV1,
  McpRemotePayloadV1,
} from "../src/shared/host-extension-package-contract/decoder"
let iso = "",
  root = "",
  home = ""
const pat = "github_pat_FAKE_aw256_CANARY_ONLY"
beforeEach(() => {
  available = true
  __resetAlphaEnvironmentForTests()
  delete process.env.ALPHA_GLOBAL_DIR
  iso = mkdtempSync(join(tmpdir(), "official-connectors-"))
  home = join(iso, "home")
  mkdirSync(home)
  root = join(home, "state", "env", "dev")
  initAlphaEnvironment({
    isPackaged: false,
    channel: "dev",
    appDataDir: home,
    baseRoot: join(home, "state"),
    homeDir: home,
  })
  root = getAlphaEnvironment().mutableRoot
})
afterEach(() => {
  clearOfficialConnectorRuntime()
  __resetAlphaEnvironmentForTests()
  rmSync(iso, { recursive: true, force: true })
})

// Source envelope: pinned alpha-web producer expected.mcp-remote.compiled.json.
// Only identities/payload/digests are changed to exercise this host's newly specified recipes.
// Recipe fields: github/github-mcp-server v2.0.2 docs/remote-server.md and
// docs/host-integration.md (Bearer PAT, readonly repos); DBHub v1.5.0 CLI + config/toml.
async function fixture(name: "github-official" | "dbhub-readonly" = "github-official") {
  const compiled = await Bun.file(
    resolve(
      import.meta.dir,
      "../../alpha-contracts-consumer/vendor/alpha-web-extension-package/expected.mcp-remote.compiled.json",
    ),
  ).json()
  const envelope = structuredClone(compiled.envelope) as AlphaPackageEnvelopeV1
  const payload: McpRemotePayloadV1 | McpLocalPayloadV1 =
    name === "github-official"
      ? {
          schema: "codepuppy.host-extension-package.payload.mcp-remote.v1",
          behavior: {
            officialRecipe: "github-remote-v1",
            url: "https://api.githubcopilot.com/mcp/",
            auth: "none",
            requiredSecrets: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
            headersTemplate: {
              Authorization: "Bearer {GITHUB_PERSONAL_ACCESS_TOKEN}",
              "X-MCP-Toolsets": "repos",
              "X-MCP-Readonly": "true",
            },
          },
        }
      : {
          schema: "codepuppy.host-extension-package.payload.mcp-local.v1",
          behavior: {
            officialRecipe: "dbhub-readonly-v1",
            command: ["npx", "-y", "@bytebase/dbhub@1.5.0", "--transport", "stdio"],
            environment: {},
            requiredSecrets: ["DSN"],
          },
        }
  const bytes = new TextEncoder().encode(JSON.stringify(payload))
  envelope.prelude.packageId = `package:${name}`
  envelope.root = `mcp:${name}`
  envelope.components = [
    {
      ...envelope.components[0]!,
      id: envelope.root,
      profileId: name === "github-official" ? "mcp-remote" : "mcp-local",
      capabilities: derivePayloadCapabilitiesV1(payload),
      payloadRef: {
        ...envelope.components[0]!.payloadRef,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
        mediaType: `application/vnd.codepuppy.host-extension-package.${name === "github-official" ? "mcp-remote" : "mcp-local"}.v1+json`,
      },
    },
  ]
  envelope.capabilities = envelope.components[0]!.capabilities
  return { envelope, bytes, payload }
}
async function install(version: string, value: string, refuseCommit = false) {
  const f = await fixture()
  const admit = createPackageAdmissionCoordinator({
    loadVerifiedCatalog: async () => ({
      source: "remote",
      catalog: { version: "1", entries: [{}], packages: [f.envelope] },
      snapshotDigest: "7".repeat(64),
    }),
    root: () => root,
    userDataPath: join(home, "userData"),
    casBaseRoot: () => join(home, "state"),
    environment: () => "dev",
    installability: { fetchPayload: async () => f.bytes },
    secretVersionId: () => version,
    transaction: (root, plan, hooks) =>
      runExtensionTransaction(
        root,
        plan,
        refuseCommit
          ? {
              ...hooks,
              commitReceipt: () => {
                throw Error("injected disk failure")
              },
            }
          : hooks,
      ),
  })
  const intent = { catalogId: f.envelope.prelude.packageId, scope: { scope: "global" }, attemptId: version }
  const preview = await admit(intent)
  if (preview.ok || !("authorization" in preview) || !("packageAuthorization" in preview))
    throw Error(JSON.stringify(preview))
  return admit({
    ...intent,
    grants: { secrets: { "mcp:github-official#GITHUB_PERSONAL_ACCESS_TOKEN": value } },
    authorization: {
      confirmed: Object.fromEntries(preview.authorization.map((item) => [item.key, item.requested])),
      binding: preview.packageAuthorization.binding,
    },
  })
}
function contents(dir: string): Buffer[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? contents(join(dir, entry.name)) : [readFileSync(join(dir, entry.name))],
  )
}

test("closed recipe and capability reject altered endpoint, argv, secret, auth and unknown recipe before installation", async () => {
  for (const name of ["github-official", "dbhub-readonly"] as const) {
    const f = await fixture(name)
    expect(
      decodePackageProfilePayloadV1(f.envelope.components[0]!.profileId, f.bytes, f.envelope.capabilities).ok,
    ).toBe(true)
    expect(
      decodePackageProfilePayloadV1(f.envelope.components[0]!.profileId, f.bytes, ["codepuppy.secret-prerequisite.v1"]).ok,
    ).toBe(false)
    for (const change of [
      { officialRecipe: "unknown" },
      { requiredSecrets: [] },
      ...(name === "github-official"
        ? [
            { url: "https://evil.invalid/" },
            { auth: { kind: "mcp-oauth", prerequisiteId: "auth", required: true } },
            { headersTemplate: { Authorization: "Bearer {GITHUB_PERSONAL_ACCESS_TOKEN}" } },
          ]
        : [
            { command: ["npx", "-y", "@bytebase/dbhub@0.12.0", "--readonly"] },
            { environment: { DSN: "sqlite:///secret.db" } },
          ]),
    ]) {
      const bytes = new TextEncoder().encode(
        JSON.stringify({ ...f.payload, behavior: { ...f.payload.behavior, ...change } }),
      )
      expect(
        decodePackageProfilePayloadV1(f.envelope.components[0]!.profileId, bytes, f.envelope.capabilities).ok,
      ).toBe(false)
    }
    const unknown = structuredClone(f.envelope)
    unknown.capabilities = ["codepuppy.unknown-official.v1"]
    unknown.components[0]!.capabilities = unknown.capabilities
    expect(
      (
        await evaluatePackageForHost(unknown, {
          fetchPayload: async () => {
            throw Error("must not fetch")
          },
        })
      ).verdict,
    ).toBe("update-required")
  }
})

test("encrypted HOME, 0600 ephemeral refs, no sidecar env values, restart and full cleanup preserve SQLite", () => {
  const dbfile = join(home, "user database.db")
  const db = new Database(dbfile)
  db.run("CREATE TABLE existing(id INTEGER)")
  db.close()
  const dsn = `sqlite://${dbfile}`
  for (const [name, value] of [
    ["github-official", pat],
    ["dbhub-readonly", dsn],
  ] as const) {
    prepareOfficialConnector(root, name, "v-one", value)
    const paths = officialConnectorPaths(root, name, "v-one")
    const config = officialConnectorConfig(root, name, "v-one")
    expect(readFileSync(join(paths.secret, "secret.enc")).includes(value)).toBe(false)
    expect(readFileSync(config.file, "utf8")).toBe(value)
    expect(statSync(config.file).mode & 0o777).toBe(0o600)
    expect(config.file.startsWith(home)).toBe(false)
    expect(contents(home).some((bytes) => bytes.includes(value))).toBe(false)
    expect(JSON.stringify(createSidecarEnv({ GITHUB_PERSONAL_ACCESS_TOKEN: pat, DSN: dsn }))).not.toContain(value)
    const oldRun = officialRuntimeRoot(root)
    clearOfficialConnectorRuntime()
    expect(existsSync(config.file)).toBe(false)
    expect(restoreOfficialConnector(root, name, "v-one").type).toBe(name === "github-official" ? "remote" : "local")
    clearOfficialConnectorRuntime([oldRun]) // late exit from the previous sidecar cannot erase the new generation
    expect(readFileSync(officialConnectorConfig(root, name, "v-one").file, "utf8")).toBe(value)
    removeOfficialConnector(root, name)
    expect(existsSync(paths.secret)).toBe(false)
    expect(existsSync(paths.config)).toBe(false)
  }
  expect(existsSync(dbfile)).toBe(true)
})

test("missing/ref-injected secrets, non-SQLite DSN, unavailable encryption and symlinked resources fail closed", async () => {
  for (const value of ["", " ", "{file:/etc/passwd}", "{env:TOKEN}", "bad\nheader"])
    expect(() => prepareOfficialConnector(root, "github-official", "v-bad", value)).toThrow("needs-reentry")
  for (const value of ["postgres://fake:fake@127.0.0.1/db", "sqlite://./db", "sqlite:///:memory:"])
    expect(() => prepareOfficialConnector(root, "dbhub-readonly", "v-bad", value)).toThrow("needs-reentry")
  available = false
  expect(() => prepareOfficialConnector(root, "github-official", "v-bad", pat)).toThrow("needs-reentry")
  const f = await fixture()
  expect((await evaluatePackageForHost(f.envelope, { fetchPayload: async () => f.bytes })).verdict).toBe("blocked")
  available = true
  const outside = join(iso, "outside")
  mkdirSync(outside, { mode: 0o700 })
  symlinkSync(outside, join(home, "state", "connector-secrets"))
  expect(() => prepareOfficialConnector(root, "github-official", "v-bad", pat)).toThrow("needs-reentry")
  expect(readdirSync(outside)).toEqual([])
})

test("deleted registered workspace does not block either recipe at installation", async () => {
  const { fenceWorkspaceTruthPath, writeWorkspaceTruth } = await import("../src/main/process-fence-workspaces")
  const workspace = join(home, "deleted-workspace")
  mkdirSync(workspace)
  writeWorkspaceTruth(fenceWorkspaceTruthPath(getAlphaEnvironment().casBaseRoot, "dev"), [workspace], {
    mkdirSync, writeFileSync, renameSync: require("node:fs").renameSync,
  })
  rmSync(workspace, { recursive: true })
  for (const name of ["github-official", "dbhub-readonly"] as const) {
    const f = await fixture(name)
    expect((await evaluatePackageForHost(f.envelope, { fetchPayload: async () => f.bytes })).verdict).toBe("compatible")
  }
})

test("real admission commits remote truth plus encrypted resource; failed replacement restores both and successful reentry retires old version", async () => {
  expect(await install("v-one", pat)).toMatchObject({ ok: true })
  const truth = join(home, "state", "mcp-servers", "dev.json")
  const before = readFileSync(truth, "utf8")
  expect(before).toContain("api.githubcopilot.com")
  expect(before).toContain("{file:")
  expect(before).not.toContain(pat)
  expect(contents(home).some((bytes) => bytes.includes(pat))).toBe(false)
  expect(await install("v-fail", pat + "REPLACEMENT", true)).toMatchObject({ ok: false })
  expect(readFileSync(truth, "utf8")).toBe(before)
  expect(existsSync(officialConnectorPaths(root, "github-official", "v-fail").secret)).toBe(false)
  expect(existsSync(officialConnectorPaths(root, "github-official", "v-one").secret)).toBe(true)
  expect(await install("v-two", pat + "NEW")).toMatchObject({ ok: true })
  expect(existsSync(officialConnectorPaths(root, "github-official", "v-one").secret)).toBe(false)
  expect(readFileSync(truth, "utf8")).toContain("v-two")
  expect(setDesiredStateV2(root, "mcp", "github-official", "enabled").ok).toBe(true)
  const old = officialConnectorConfig(root, "github-official", "v-two").file
  clearOfficialConnectorRuntime()
  restoreCommittedOfficialConnectors()
  expect(existsSync(old)).toBe(false)
  expect(readFileSync(truth, "utf8")).not.toContain(old)
})

test("prepared journal crash recovery removes only uncommitted official versions", async () => {
  prepareOfficialConnector(root, "github-official", "v-crash", pat)
  await expect(
    runExtensionTransaction(
      root,
      {
        items: [
          {
            key: "mcp--github-official",
            action: "config",
            config: {
              target: join(root, "alpha.jsonc"),
              edits: [{ keyPath: ["mcp", "github-official"], value: { enabled: false } }],
            },
          },
        ],
        prepared: [
          { kind: "mcp-secret-version", store: "official-connectors", server: "github-official", version: "v-crash" },
        ],
      },
      { populate: () => {}, probe: () => ({ healthy: true }), populatePrepared: () => {}, crashAt: "after-populate" },
    ),
  ).rejects.toThrow("simulated crash")
  expect(existsSync(officialConnectorPaths(root, "github-official", "v-crash").secret)).toBe(true)
  const recovered = await recoverExtensionTransactions(root, {
    pidAlive: () => false,
    probe: () => ({ healthy: true }),
    commitReceipt: () => {},
    releasePrepared: (resources) => releaseOfficialConnectorResources(join(home, "userData"), resources),
  })
  expect(recovered.ok).toBe(true)
  expect(recovered.reports.at(-1)?.action).toBe("aborted")
  expect(existsSync(officialConnectorPaths(root, "github-official", "v-crash").secret)).toBe(false)
})

test("DBHub 1.5.0 real stdio SELECT 1 succeeds, writes fail, only execute_sql exists, and uninstall preserves the database", async () => {
  // Only this newly-created test directory is touched under actual HOME: the production
  // profile grants all system temp writes, so a temp-only test cannot prove TOML protection.
  const ownedHome = mkdtempSync(join(userInfo().homedir, ".connector-256-fixture-"))
  try {
    __resetAlphaEnvironmentForTests()
    delete process.env.ALPHA_GLOBAL_DIR
    home = ownedHome
    initAlphaEnvironment({
      isPackaged: false,
      channel: "dev",
      appDataDir: home,
      baseRoot: join(home, "state"),
      homeDir: home,
    })
    root = getAlphaEnvironment().mutableRoot
    mkdirSync(join(home, "project"))
    const database = join(home, "project", "sqlite sample.db")
    const db = new Database(database)
    db.run("CREATE TABLE original(id INTEGER)")
    db.close()
    const dsn = `sqlite://${database}`
    prepareOfficialConnector(root, "dbhub-readonly", "v-sqlite", dsn)
    const recipe = officialConnectorConfig(root, "dbhub-readonly", "v-sqlite")
    if (recipe.config.type !== "local") throw Error("wrong recipe")
    expect(recipe.config.command.join(" ")).not.toContain(dsn)
    expect(
      readFileSync(join(officialConnectorPaths(root, "dbhub-readonly", "v-sqlite").config, "dbhub.toml"), "utf8"),
    ).toBe(DBHUB_READONLY_TOML)
    // Consume the engine's actual {file:} implementation; no test-owned interpolation algorithm.
    const { ConfigVariable } = await import(resolve(import.meta.dir, "../../opencode/src/config/variable.ts"))
    const config = JSON.parse(
      await ConfigVariable.substitute({
        type: "virtual",
        source: "official-test",
        dir: root,
        text: JSON.stringify(recipe.config),
      }),
    )
    const require = createRequire(resolve(import.meta.dir, "../../opencode/package.json"))
    const { Client } = await import(require.resolve("@modelcontextprotocol/sdk/client/index.js"))
    const { StdioClientTransport } = await import(require.resolve("@modelcontextprotocol/sdk/client/stdio.js"))
    const client = new Client({ name: "alpha-256-test", version: "1.0.0" })
    // Acquire the pinned npm fixture outside the fence, using only this test's empty npm
    // configs. Then run the real recipe offline inside the fence (no DB network permission).
    const npmEnv = {
      PATH: config.environment.PATH,
      HOME: home,
      npm_config_cache: join(tmpdir(), "alpha-256-npm-cache"),
      npm_config_userconfig: join(iso, "user.npmrc"),
      npm_config_globalconfig: join(iso, "global.npmrc"),
    }
    writeFileSync(npmEnv.npm_config_userconfig, "", { mode: 0o600 })
    writeFileSync(npmEnv.npm_config_globalconfig, "", { mode: 0o600 })
    const acquire = (offline: boolean) =>
      Bun.spawn({
        cmd: [
          config.command[0],
          config.command[1],
          ...(offline ? ["--offline"] : []),
          "--yes",
          "--package=@bytebase/dbhub@1.5.0",
          "--",
          config.command[0],
          "--version",
        ],
        env: npmEnv,
        stdout: "ignore",
        stderr: "ignore",
      }).exited
    if ((await acquire(true)) !== 0) expect(await acquire(false)).toBe(0)
    const fence = join(iso, "readonly.sb")
    if (process.platform === "darwin") {
      const { renderProcessFenceProfile, resolveEngineRoots } = await import("../src/main/process-fence-profile")
      writeFileSync(
        fence,
        renderProcessFenceProfile({
          workspaces: [join(home, "project")],
          alphaGlobalRoot: root,
          userDataPath: join(home, "userData"),
          stateHome: join(home, "userData"),
          roots: resolveEngineRoots({}, home),
          egressProxyPort: 9,
        }),
      )
      const paths = officialConnectorPaths(root, "dbhub-readonly", "v-sqlite")
      const protectedFiles = [
        join(paths.config, "dbhub.toml"),
        join(paths.config, "work", ".env"),
        join(paths.secret, "secret.enc"),
      ]
      const probe = Bun.spawnSync({
        cmd: [
          "/usr/bin/sandbox-exec",
          "-f",
          fence,
          config.command[0],
          "-e",
          'const fs=require("node:fs"); console.log(JSON.stringify(process.argv.slice(1).map(p=>{try{fs.appendFileSync(p,"unsafe");return "written"}catch(e){return e.code}})))',
          ...protectedFiles,
        ],
        env: { PATH: process.env.PATH },
      })
      expect(probe.exitCode).toBe(0)
      expect(JSON.parse(probe.stdout.toString())).toEqual(["EPERM", "EPERM", "EPERM"])
    }
    const transport = new StdioClientTransport({
      command: process.platform === "darwin" ? "/usr/bin/sandbox-exec" : config.command[0],
      args: process.platform === "darwin" ? ["-f", fence, ...config.command] : config.command.slice(1),
      cwd: config.cwd,
      stderr: "pipe",
      env: {
        ...config.environment,
        ...npmEnv,
        npm_config_offline: "true",
      },
    })
    let diagnostic = ""
    transport.stderr?.on("data", (chunk: Buffer) => {
      diagnostic += chunk.toString()
    })
    try {
      await client.connect(transport)
      expect(client.getServerVersion()).toMatchObject({ version: "1.5.0" })
      const listed = await client.listTools()
      expect(listed.tools.map((tool: { name: string }) => tool.name)).toEqual(["execute_sql"])
      const selected = await client.callTool({ name: "execute_sql", arguments: { sql: "SELECT 1 AS aw256_ok" } })
      expect(selected.isError).not.toBe(true)
      expect(JSON.parse(selected.content[0].text).data.statements[0].rows).toEqual([{ aw256_ok: 1 }])
      const write = await client.callTool({
        name: "execute_sql",
        arguments: { sql: "CREATE TABLE aw256_should_not_exist(id INTEGER)" },
      })
      expect(write.isError).toBe(true)
      expect(JSON.parse(write.content[0].text).code).toBe("READONLY_VIOLATION")
      const independent = new Database(database, { readonly: true })
      expect(independent.query("SELECT name FROM sqlite_master WHERE name='aw256_should_not_exist'").all()).toEqual([])
      independent.close()
      expect(contents(home).some((bytes) => bytes.includes(dsn))).toBe(false)
    } catch (error) {
      throw Error(String(error) + " " + diagnostic.replaceAll(dsn, "[DSN]"))
    } finally {
      await client.close()
      await transport.close()
    }
    removeOfficialConnector(root, "dbhub-readonly")
    expect(existsSync(database)).toBe(true)
  } finally {
    clearOfficialConnectorRuntime()
    rmSync(ownedHome, { recursive: true, force: true })
  }
}, 120_000)

test("actual Node >=22.5, HOME/workspace exclusion, protected cwd and template tampering are enforced", () => {
  const previous = process.env.PATH
  const bin = join(iso, "node with spaces")
  mkdirSync(bin)
  writeFileSync(join(bin, "node"), '#!/bin/sh\nprintf "v22.4.0\\n"\n', { mode: 0o700 })
  writeFileSync(join(bin, "npx"), "#!/bin/sh\nexit 0\n", { mode: 0o700 })
  try {
    process.env.PATH = bin + ":/usr/bin:/bin"
    expect(() => officialNodeCommand()).toThrow("needs-reentry")
    writeFileSync(join(bin, "node"), '#!/bin/sh\nprintf "v22.5.0\\n"\n', { mode: 0o700 })
    expect(officialNodeCommand()[0]).toBe(join(bin, "node"))
  } finally {
    process.env.PATH = previous
  }
  const previousTmp = process.env.TMPDIR
  try {
    process.env.TMPDIR = process.env.HOME
    expect(() => officialRuntimeRoot(root)).toThrow("needs-reentry")
  } finally {
    process.env.TMPDIR = previousTmp
  }
  // Use the producer's real main-only workspace truth writer, also pinning the reader's path.
  const { fenceWorkspaceTruthPath, writeWorkspaceTruth } = require("../src/main/process-fence-workspaces")
  const truth = fenceWorkspaceTruthPath(getAlphaEnvironment().casBaseRoot, "dev")
  writeWorkspaceTruth(truth, [tmpdir()], { mkdirSync, writeFileSync, renameSync: require("node:fs").renameSync })
  expect(() => officialRuntimeRoot(root)).toThrow("needs-reentry")
  rmSync(truth)
  const file = join(home, 'quote " and \\ database.db')
  new Database(file).close()
  prepareOfficialConnector(root, "dbhub-readonly", "v-boundary", `sqlite://${file}`)
  const paths = officialConnectorPaths(root, "dbhub-readonly", "v-boundary")
  writeFileSync(join(paths.config, "work", ".env"), "DSN=must-not-load")
  expect(() => restoreOfficialConnector(root, "dbhub-readonly", "v-boundary")).toThrow("needs-reentry")
  rmSync(join(paths.config, "work", ".env"))
  chmodSync(join(paths.config, "dbhub.toml"), 0o600)
  writeFileSync(join(paths.config, "dbhub.toml"), DBHUB_READONLY_TOML.replace("readonly = true", "readonly = false"))
  expect(() => restoreOfficialConnector(root, "dbhub-readonly", "v-boundary")).toThrow("needs-reentry")
  const orphan = join(dirname(officialRuntimeRoot(root)), "2147483647-00000000-0000-0000-0000-000000000000")
  clearOfficialConnectorRuntime()
  mkdirSync(orphan, { mode: 0o700 })
  writeFileSync(join(orphan, "fake-secret"), pat, { mode: 0o600 })
  officialRuntimeRoot(root)
  expect(existsSync(orphan)).toBe(false)
})

// Protocol fixture copied from the official MCP 2025-06-18 lifecycle/tools examples;
// it is deliberately ExampleServer/get_weather, NOT fabricated GitHub repository output.
// https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle
// https://modelcontextprotocol.io/specification/2025-06-18/server/tools
// GitHub's exact endpoint/header recipe source: github/github-mcp-server v2.0.2
// docs/remote-server.md and docs/host-integration.md. Real PAT authorization is release evidence.
test("GitHub recipe decrypts through actual engine file substitution into HTTP headers and CONNECT permits only the official authority", async () => {
  await install("v-http", pat)
  expect(setDesiredStateV2(root, "mcp", "github-official", "enabled").ok).toBe(true)
  restoreCommittedOfficialConnectors()
  const recipe = officialConnectorConfig(root, "github-official", "v-http")
  const { ConfigVariable } = await import(resolve(import.meta.dir, "../../opencode/src/config/variable.ts"))
  const config = JSON.parse(
    await ConfigVariable.substitute({
      type: "virtual",
      source: "official-test",
      dir: root,
      text: JSON.stringify(recipe.config),
    }),
  )
  expect(config.url).toBe("https://api.githubcopilot.com/mcp/")
  expect(config.oauth).toBe(false)
  const seen: Headers[] = []
  const result = {
    content: [{ type: "text", text: "Current weather in New York:\nTemperature: 72°F\nConditions: Partly cloudy" }],
    isError: false,
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (req.method !== "POST") return new Response(null, { status: 405 })
      seen.push(req.headers)
      const body = (await req.json()) as { id?: number; method: string }
      if (body.id === undefined) return new Response(null, { status: 202 })
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result:
          body.method === "initialize"
            ? {
                protocolVersion: "2025-06-18",
                capabilities: {
                  logging: {},
                  prompts: { listChanged: true },
                  resources: { subscribe: true, listChanged: true },
                  tools: { listChanged: true },
                },
                serverInfo: { name: "ExampleServer", title: "Example Server Display Name", version: "1.0.0" },
                instructions: "Optional instructions for the client",
              }
            : result,
      })
    },
  })
  const require = createRequire(resolve(import.meta.dir, "../../opencode/package.json"))
  const { Client } = await import(require.resolve("@modelcontextprotocol/sdk/client/index.js"))
  const { StreamableHTTPClientTransport } = await import(
    require.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js")
  )
  const client = new Client({ name: "official-doc-fixture", version: "1.0.0" })
  try {
    await client.connect(new StreamableHTTPClientTransport(server.url, { requestInit: { headers: config.headers } }))
    expect(await client.callTool({ name: "get_weather", arguments: { location: "New York" } })).toEqual(result)
    expect(seen.length).toBeGreaterThan(1)
    for (const headers of seen) {
      expect(headers.get("Authorization")).toBe(`Bearer ${pat}`)
      expect(headers.get("X-MCP-Toolsets")).toBe("repos")
      expect(headers.get("X-MCP-Readonly")).toBe("true")
    }
  } finally {
    await client.close()
    server.stop(true)
  }
  const { startEgressPolicyProxy } = await import("../src/main/network-egress-proxy")
  const { connect } = await import("node:net")
  const records: unknown[] = []
  const dialed: string[] = []
  const target = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket) {
        socket.end("fixture")
      },
    },
  })
  const proxy = await startEgressPolicyProxy({
    log: (record) => {
      records.push(record)
    },
    dial: (host, port) => {
      dialed.push(`${host}:${port}`)
      return connect(target.port, "127.0.0.1")
    },
  })
  const tunnel = (authority: string) =>
    new Promise<string>((done, reject) => {
      const socket = connect(proxy.port, "127.0.0.1", () =>
        socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`),
      )
      socket.once("data", (data) => {
        socket.destroy()
        done(data.toString())
      })
      socket.once("error", reject)
    })
  try {
    expect(await tunnel("api.githubcopilot.com:443")).toContain("200")
    expect(await tunnel("api.githubcopilot.com:444")).toContain("403")
    expect(dialed).toEqual(["api.githubcopilot.com:443"])
    expect(JSON.stringify(records)).not.toContain(pat)
  } finally {
    await proxy.close()
    target.stop(true)
  }
  expect(contents(home).some((bytes) => bytes.includes(pat))).toBe(false)
})

test("real IPC previews/cancels without secrets, installs both recipes, stops before cleanup and retries failed uninstall", async () => {
  type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>
  const handlers = new Map<string, Handler>(),
    events: string[] = [],
    logs: unknown[] = []
  let current = await fixture()
  mock.module("electron", () => ({
    BrowserWindow: class {
      static fromWebContents() {
        return undefined
      }
    },
    dialog: {
      showMessageBox: async () => ({ response: 1, checkboxChecked: false }),
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    },
    ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
  }))
  mock.module("../src/main/ipc", () => ({
    pickedFiles: {
      read: async () => {
        throw Error("unexpected picked file")
      },
    },
  }))
  mock.module("../src/main/logging", () => ({
    getLogger: () => ({
      log: (...args: unknown[]) => logs.push(args),
      warn: (...args: unknown[]) => logs.push(args),
      error: (...args: unknown[]) => logs.push(args),
    }),
  }))
  mock.module("../src/main/ext-advisory-gate", () => ({
    listAdvisoryBlockedFacts: () => ({ ids: [], fresh: true }),
    makeAdvisoryGate: () => () => ({ allowed: true }),
  }))
  mock.module("../src/main/remote-catalog", () => ({
    downloadRemoteAsset: async () => ({ ok: false, reason: "unexpected asset" }),
    readCachedCatalog: () => null,
    registerPackageCatalogReadIpcHandlers: () => {},
    refreshRemoteCatalog: async () => ({
      source: "remote",
      catalog: { version: "1", entries: [{}], packages: [current.envelope] },
      snapshotDigest: "7".repeat(64),
    }),
  }))
  mock.module("../src/main/ext-mcp-activation", () => ({
    verifyInstalledMcp: async (name: string) => ({ reference: name, status: "connected" }),
    probeProjectMcpActivation: async () => "unverifiable",
  }))
  const { registerExtIpcHandlers } = await import("../src/main/ext-ipc")
  const ready = registerExtIpcHandlers(
    join(home, "userData"),
    "dev",
    async () => ({ url: "http://127.0.0.1:39117", username: "opencode", password: "fake" }),
    home,
    {
      stop: async () => {
        events.push("stop")
        clearOfficialConnectorRuntime()
      },
      refresh: async () => {
        events.push("refresh")
        clearOfficialConnectorRuntime()
        try {
          restoreCommittedOfficialConnectors()
          return true
        } catch {
          return false
        }
      },
    },
  )
  await ready.ledgerReady
  const original = globalThis.fetch
  // Catalog fetch is the external seam: production admission and both registered IPC bodies run.
  globalThis.fetch = (async () => new Response(current.bytes, { status: 200 })) as typeof fetch
  const dbfile = join(home, "ipc sqlite.db")
  new Database(dbfile).close()
  try {
    for (const name of ["github-official", "dbhub-readonly"] as const) {
      current = await fixture(name)
      const invoke = handlers.get("ext-install-catalog")!
      const intent = {
        catalogId: current.envelope.prelude.packageId,
        scope: { scope: "global" },
        attemptId: `ipc-${name}`,
      }
      const preview = (await invoke({}, intent)) as {
        authorization: { key: string; requested: string[] }[]
        packageAuthorization: { binding: unknown }
      }
      expect(preview.authorization.length).toBeGreaterThan(0)
      expect(events).toEqual([]) // cancelling here has no persistent secret and no process restart
      expect(existsSync(officialConnectorPaths(root, name, "unused").secret)).toBe(false)
      const variable = name === "github-official" ? "GITHUB_PERSONAL_ACCESS_TOKEN" : "DSN"
      const value = name === "github-official" ? pat : `sqlite://${dbfile}`
      const result = await invoke(
        {},
        {
          ...intent,
          grants: { secrets: { [`mcp:${name}#${variable}`]: value } },
          authorization: {
            confirmed: Object.fromEntries(preview.authorization.map((item) => [item.key, item.requested])),
            binding: preview.packageAuthorization.binding,
          },
        },
      )
      expect(result).toMatchObject({ ok: true, name, installedDisabled: true })
      expect(events).toEqual(["stop", "refresh"])
      events.length = 0
      const parent = join(getAlphaEnvironment().casBaseRoot, "connector-secrets", "dev", name)
      const versions = readdirSync(parent)
      expect(versions).toHaveLength(1)
      const paths = officialConnectorPaths(root, name, versions[0]!)
      const runtime = officialConnectorConfig(root, name, versions[0]!).file
      expect(readFileSync(runtime, "utf8")).toBe("") // disabled configs remain parseable without decrypting a secret
      expect(contents(home).some((bytes) => bytes.includes(value))).toBe(false)
      expect(
        await handlers.get("ext-set-install-state")!({}, { type: "mcp", name, scope: "global", state: "enabled" }),
      ).toMatchObject({ ok: true })
      expect(readFileSync(officialConnectorConfig(root, name, versions[0]!).file, "utf8")).toBe(value)
      expect(
        await handlers.get("ext-set-install-state")!({}, { type: "mcp", name, scope: "global", state: "disabled" }),
      ).toMatchObject({ ok: true })
      expect(readFileSync(officialConnectorConfig(root, name, versions[0]!).file, "utf8")).toBe("")
      expect(events).toEqual(["stop", "refresh", "stop", "refresh"])
      events.length = 0
      // Make cleanup fail after configuration removal. The receipt must survive for retry.
      chmodSync(paths.secret, 0o755)
      expect(await handlers.get("ext-uninstall-package")!({}, `package:${name}`)).toMatchObject({ ok: false })
      expect(findRecordV2(root, "mcp", name)).not.toBeNull()
      chmodSync(paths.secret, 0o700)
      expect(await handlers.get("ext-uninstall-package")!({}, `package:${name}`)).toMatchObject({ ok: true })
      expect(events).toEqual(["stop", "refresh", "stop", "refresh"])
      events.length = 0
      expect(existsSync(paths.secret)).toBe(false)
      expect(existsSync(parent)).toBe(false)
      expect(existsSync(paths.config)).toBe(false)
      expect(existsSync(dbfile)).toBe(true)
      expect(JSON.stringify(logs)).not.toContain(value)
      if (name === "github-official")
        expect(readFileSync(join(home, "state", "mcp-servers", "dev.json"), "utf8")).not.toContain("github-official")
    }
  } finally {
    globalThis.fetch = original
  }
}, 30_000)
