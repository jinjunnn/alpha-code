import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Database } from "bun:sqlite"
import { createElectronStub } from "./req053-electron-stub"
let home = "",
  root = "",
  scratch = ""
const warnings: string[] = []
const key = randomBytes(32)
mock.module("electron", () => createElectronStub({ userDataPath: () => join(home, "userData") }))
mock.module("../src/main/store", () => ({ getStore: () => ({ get: () => null, set: () => {}, delete: () => {} }) }))
mock.module("../src/main/logging", () => ({
  getLogger: () => ({ log: () => {}, warn: (line: string) => warnings.push(line), error: () => {} }),
  write: () => {},
  rotateServerLogs: () => {},
}))
// Only the OS keychain boundary is replaced; corrupted ciphertext fails actual authenticated decryption.
mock.module("../src/main/alpha-keychain-backend", () => ({
  keychainBackend: () => ({
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => {
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, iv)
      return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()])
    },
    decryptString: (value: Buffer) => {
      const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12))
      cipher.setAuthTag(value.subarray(-16))
      return Buffer.concat([cipher.update(value.subarray(12, -16)), cipher.final()]).toString()
    },
  }),
}))
const { initAlphaEnvironment, getAlphaEnvironment, __resetAlphaEnvironmentForTests } = await import(
  "../src/main/alpha-environment"
)
const {
  officialRuntimeRoot,
  officialConnectorConfig,
  officialConnectorPaths,
  prepareOfficialConnector,
  clearOfficialConnectorRuntime,
  clearOfficialConnectorRuntimeOnExit,
} = await import("../src/main/official-connector-resources")
const { upsertRecordV2 } = await import("../src/main/ext-receipt-v2")
const { writeWorkspaceTruth, fenceWorkspaceTruthPath } = await import("../src/main/process-fence-workspaces")
const { spawnLocalServer } = await import("../src/main/server")
const { creditDanglingSweepForSpawn } = await import("../src/main/dangling-sweep-latch")
const { collectMcpFileRefPaths } = await import("../src/main/alpha-mcp-secrets")
const { findMcpServerRecord } = await import("../src/main/mcp-server-lifecycle")
const saved: Record<string, string | undefined> = {}
const envKeys = ["SHELL", "ALPHA_SECRETS_DISABLE", "ALPHA_GLOBAL_DIR", "XDG_DATA_HOME", "XDG_STATE_HOME"]
beforeEach(() => {
  for (const name of envKeys) saved[name] = process.env[name]
  __resetAlphaEnvironmentForTests()
  delete process.env.ALPHA_GLOBAL_DIR
  scratch = mkdtempSync(join(tmpdir(), "official-recovery-"))
  home = join(scratch, "home")
  mkdirSync(home)
  initAlphaEnvironment({
    isPackaged: false,
    channel: "dev",
    appDataDir: home,
    baseRoot: join(home, "state"),
    homeDir: home,
  })
  root = getAlphaEnvironment().mutableRoot
  process.env.SHELL = "nu"
  process.env.ALPHA_SECRETS_DISABLE = "1"
  process.env.XDG_DATA_HOME = join(home, "xdg-data")
  process.env.XDG_STATE_HOME = join(home, "xdg-state")
  warnings.length = 0
})
afterEach(() => {
  clearOfficialConnectorRuntime()
  __resetAlphaEnvironmentForTests()
  for (const name of envKeys) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
  rmSync(scratch, { recursive: true, force: true })
})
class Child extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  postMessage(message: { type: string }) {
    if (message.type === "start") queueMicrotask(() => this.emit("message", { type: "ready" }))
    if (message.type === "stop") queueMicrotask(() => this.emit("exit", 0))
  }
  kill() {
    queueMicrotask(() => this.emit("exit", 0))
  }
}
async function spawn(child: Child, observe: () => void, onExit?: (code: number) => void) {
  creditDanglingSweepForSpawn()
  const result = await spawnLocalServer("127.0.0.1", 39117, "fake", {
    userDataPath: join(home, "userData"),
    fork: (() => {
      observe()
      return child
    }) as Parameters<typeof spawnLocalServer>[3]["fork"],
    planFence: () => ({ profile: "(version 1)\n(allow default)", addonPath: "/nonexistent/fixture.node" }),
    egressProxy: async () => ({ port: 39118 }),
    healthCheck: async () => true,
    onExit,
  })
  await result.health.wait
  return result
}
function seed(name: "github-official" | "dbhub-readonly", value: string) {
  prepareOfficialConnector(root, name, "v-recovery", value)
  expect(
    upsertRecordV2(root, {
      id: `mcp:${name}`,
      name,
      kind: "mcp",
      environment: "dev",
      scope: { kind: "global" },
      desiredState: "enabled",
      origin: "catalog",
      installedAt: "2026-10-13T00:00:00.000Z",
    }).ok,
  ).toBe(true)
  const file = join(root, "alpha.jsonc")
  const previous = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}
  writeFileSync(
    file,
    JSON.stringify({
      ...previous,
      mcp: { ...previous.mcp, [name]: officialConnectorConfig(root, name, "v-recovery").config },
    }),
  )
}
test.each(["deleted workspace", "moved SQLite", "decryption failure"])(
  "real spawn isolates %s and still forks with needs-reentry",
  async (failure) => {
    const workspace = join(home, "workspace")
    mkdirSync(workspace)
    const database = join(workspace, "fixture.db")
    new Database(database).close()
    seed("github-official", "github_pat_FAKE_RECOVERY")
    seed("dbhub-readonly", `sqlite://${database}`)
    const failed = failure === "decryption failure" ? "github-official" : "dbhub-readonly"
    const healthy = failed === "github-official" ? "dbhub-readonly" : "github-official"
    if (failure === "deleted workspace") {
      writeWorkspaceTruth(fenceWorkspaceTruthPath(getAlphaEnvironment().casBaseRoot, "dev"), [workspace], {
        mkdirSync,
        writeFileSync,
        renameSync,
      })
      rmSync(workspace, { recursive: true })
    }
    if (failure === "moved SQLite") renameSync(database, database + ".moved")
    if (failure === "decryption failure")
      writeFileSync(join(officialConnectorPaths(root, failed, "v-recovery").secret, "secret.enc"), "invalid ciphertext")
    const diagnostics = spyOn(console, "warn").mockImplementation((line) => warnings.push(String(line)))
    let forks = 0
    try {
      const result = await spawn(new Child(), () => {
        forks++
        const config = JSON.parse(readFileSync(join(root, "alpha.jsonc"), "utf8")).mcp
        expect(config[failed].enabled).toBe(false)
        expect(config[healthy].enabled).toBe(true)
        const refs = collectMcpFileRefPaths(config[failed])
        expect(refs).toHaveLength(1)
        expect(readFileSync(refs[0]!, "utf8")).toBe("")
        expect(readFileSync(collectMcpFileRefPaths(config[healthy])[0]!, "utf8").length).toBeGreaterThan(0)
        if (failed === "github-official") expect(findMcpServerRecord(failed)).toEqual({ ok: true, record: undefined })
      })
      expect(forks).toBe(1)
      expect(warnings).toContain(`official-connector-needs-reentry: ${failed}`)
      expect(warnings.join("\n")).not.toContain("github_pat_FAKE_RECOVERY")
      await result.listener.stop()
    } finally {
      diagnostics.mockRestore()
    }
  },
)
test("startup sweeps stale runtime roots even with no installed connector", async () => {
  const parent = dirname(officialRuntimeRoot(root))
  clearOfficialConnectorRuntime()
  const stale = [process.pid, process.ppid, 2147483647].map((pid) =>
    join(parent, `${pid}-00000000-0000-0000-0000-000000000000`),
  )
  for (const dir of stale) {
    mkdirSync(dir, { mode: 0o700 })
    writeFileSync(join(dir, "fake-secret"), "FAKE_ORPHAN_PAT", { mode: 0o600 })
  }
  const result = await spawn(new Child(), () => stale.forEach((dir) => expect(existsSync(dir)).toBe(false)))
  await result.listener.stop()
})
test("runtime cleanup failure cannot interrupt sidecar exit, pending probes or onExit", async () => {
  seed("github-official", "github_pat_FAKE_EXIT")
  const child = new Child(),
    exits: number[] = []
  const result = await spawn(
    child,
    () => {},
    (code) => exits.push(code),
  )
  const run = officialRuntimeRoot(root)
  const pending = result.listener.probeWrite(home)
  chmodSync(run, 0o755)
  const diagnostics = spyOn(console, "warn").mockImplementation((line) => warnings.push(String(line)))
  try {
    expect(() => child.emit("exit", 0)).not.toThrow()
    expect(exits).toEqual([0])
    expect((await pending).outcome).toBe("unknown")
    expect(warnings).toContain("official connector runtime cleanup failed on exit")
    await result.listener.stop()
  } finally {
    chmodSync(run, 0o700)
    diagnostics.mockRestore()
  }
})

// index.ts will-quit and the real child-exit path above share this exact cleanup boundary.
test("application exit cleanup logs failure and returns so remaining quit handlers can run", () => {
  const run = officialRuntimeRoot(root)
  chmodSync(run, 0o755)
  const diagnostics = spyOn(console, "warn").mockImplementation((line) => warnings.push(String(line)))
  try {
    expect(() => clearOfficialConnectorRuntimeOnExit()).not.toThrow()
    expect(warnings).toEqual(["official connector runtime cleanup failed on exit"])
    expect(existsSync(run)).toBe(true)
  } finally {
    chmodSync(run, 0o700)
    diagnostics.mockRestore()
  }
})
