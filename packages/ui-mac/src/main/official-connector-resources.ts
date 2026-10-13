import { applyEdits, modify } from "jsonc-parser"
import {
  collectMergedMcpRefPathsStrict,
  mcpPluginTargetPath,
  readMcpLeafStrict,
  releasePreparedTxResources,
  withConfigWriteLock,
  writeConfigTextAtomic,
} from "./ext-config"
import { collectMcpFileRefPaths } from "./alpha-mcp-secrets"
import { alphaGlobalRoot } from "./engine-config-truth"
import { findRecordV2 } from "./ext-receipt-v2"
import { probeTransactionJournals, type TxPreparedResourceV1 } from "./ext-transaction"
import { upsertMcpServerRecord } from "./mcp-server-lifecycle"
// alpha-web#256: two closed recipes; only ciphertext survives a stopped application.
import { createHash, randomUUID } from "node:crypto"
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path"

import { environmentFromMutableRoot } from "./alpha-environment"
import {
  DBHUB_READONLY_TOML,
  OFFICIAL_CONNECTOR_NAMES,
  isOfficialConnector,
  officialConnectorBackend,
  officialConnectorFailure,
  officialNodeCommand,
  officialRuntimeParent,
  insideDirectory,
  type OfficialConnectorName,
} from "./official-connector-recipes"

const runs = new Map<string, string>()
// Check every managed ancestor, never follow a planted link or adopt somebody else's directory.
function directory(path: string) {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 })
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw officialConnectorFailure()
}
function managedDirectory(base: string, path: string) {
  const parent = realpathSync(base)
  const parts = relative(base, path).split(sep)
  if (parts.some((part) => !part || part === "..")) throw officialConnectorFailure()
  parts.reduce((current, part) => {
    const next = join(current, part)
    directory(next)
    return next
  }, parent)
}
function readProtected(file: string) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.nlink !== 1)
      throw officialConnectorFailure()
    return readFileSync(fd)
  } finally {
    closeSync(fd)
  }
}
function writeProtected(file: string, bytes: string | Buffer, mode = 0o600) {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
  try {
    writeFileSync(fd, bytes)
  } finally {
    closeSync(fd)
  }
}

export function officialConnectorPaths(root: string, name: string, version: string) {
  const base = environmentFromMutableRoot(root)
  if (!base || !isOfficialConnector(name) || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,95}$/.test(version))
    throw officialConnectorFailure()
  return {
    base: base.casBaseRoot,
    secret: join(base.casBaseRoot, "connector-secrets", base.environment, name, version),
    config: join(base.casBaseRoot, "connector-config", base.environment, name, version),
  }
}

export function officialRuntimeRoot(root: string) {
  const existing = runs.get(root)
  if (existing) {
    directory(existing)
    return existing
  }
  const parent = officialRuntimeParent(root)
  managedDirectory(dirname(parent), parent)
  // Only roots bearing our own identity and a dead owner PID are eligible for crash cleanup.
  for (const entry of readdirSync(parent)) {
    if (!/^\d+-[a-f0-9-]{36}$/.test(entry)) throw officialConnectorFailure()
    directory(join(parent, entry))
    try {
      process.kill(Number(entry.split("-")[0]), 0)
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw officialConnectorFailure()
      rmSync(join(parent, entry), { recursive: true })
    }
  }
  const run = join(parent, `${process.pid}-${randomUUID()}`)
  directory(run)
  runs.set(root, run)
  return run
}

export function clearOfficialConnectorRuntime(generation = [...runs.values()]) {
  for (const [root, run] of runs) {
    if (!generation.includes(run)) continue
    directory(run)
    rmSync(run, { recursive: true })
    runs.delete(root)
  }
}

export function assertOfficialConnectorSecret(name: OfficialConnectorName, value: string) {
  if (!value?.trim() || value !== value.trim() || /\{(?:file|env):|[\u0000\r\n]/.test(value))
    throw officialConnectorFailure()
  if (name === "github-official") return
  // v1.5.0 SQLiteDSNParser consumes a literal pathname. Require an existing local absolute
  // file; no remote dialect, relative cwd, memory DB, URL query or ambiguous encoded path.
  if (!value.startsWith("sqlite:///")) throw officialConnectorFailure()
  const file = value.slice("sqlite://".length)
  if (!isAbsolute(file) || /[?#%]/.test(file) || file.startsWith("//") || !lstatSync(file).isFile())
    throw officialConnectorFailure()
}

export function officialConnectorConfig(root: string, name: OfficialConnectorName, version: string) {
  const paths = officialConnectorPaths(root, name, version)
  const variable = name === "github-official" ? "GITHUB_PERSONAL_ACCESS_TOKEN" : "DSN"
  const file = join(officialRuntimeRoot(root), name, version, variable)
  const ref = `{file:${file}}`
  if (name === "github-official")
    return {
      file,
      config: {
        type: "remote" as const,
        url: "https://api.githubcopilot.com/mcp/",
        oauth: false as const,
        headers: { Authorization: `Bearer ${ref}`, "X-MCP-Toolsets": "repos", "X-MCP-Readonly": "true" },
      },
    }
  const command = officialNodeCommand()
  return {
    file,
    config: {
      type: "local" as const,
      timeout: 60_000,
      command: [...command, "--config", join(paths.config, "dbhub.toml")],
      cwd: join(paths.config, "work"),
      environment: { DSN: ref, PATH: `${dirname(command[0]!)}:${process.env.PATH ?? "/usr/bin:/bin"}` },
    },
  }
}

export function prepareOfficialConnector(root: string, name: OfficialConnectorName, version: string, value: string) {
  try {
    assertOfficialConnectorSecret(name, value)
    const encrypted = officialConnectorBackend().encryptString(value)
    const paths = officialConnectorPaths(root, name, version)
    managedDirectory(paths.base, paths.secret)
    writeProtected(join(paths.secret, "secret.enc"), encrypted)
    if (name === "dbhub-readonly") {
      managedDirectory(paths.base, join(paths.config, "work"))
      writeProtected(join(paths.config, "dbhub.toml"), DBHUB_READONLY_TOML, 0o400)
      writeProtected(
        join(paths.secret, "recipe.json"),
        JSON.stringify({
          path: join(paths.config, "dbhub.toml"),
          sha256: createHash("sha256").update(DBHUB_READONLY_TOML).digest("hex"),
        }),
      )
    }
    restoreOfficialConnector(root, name, version)
  } catch {
    throw officialConnectorFailure()
  }
}

export function restoreOfficialConnector(
  root: string,
  name: OfficialConnectorName,
  version: string,
  state: "enabled" | "disabled" = "enabled",
) {
  try {
    const paths = officialConnectorPaths(root, name, version)
    managedDirectory(paths.base, paths.secret)
    const bytes = readProtected(join(paths.secret, "secret.enc"))
    const value = state === "enabled" ? officialConnectorBackend().decryptString(bytes) : ""
    if (state === "enabled") assertOfficialConnectorSecret(name, value)
    const next = officialConnectorConfig(root, name, version)
    managedDirectory(officialRuntimeRoot(root), dirname(next.file))
    if (existsSync(next.file)) {
      if (readProtected(next.file).toString() !== value) {
        rmSync(next.file)
        writeProtected(next.file, value)
      }
    } else writeProtected(next.file, value)
    if (name === "dbhub-readonly") {
      managedDirectory(paths.base, paths.config)
      directory(join(paths.config, "work"))
      if (
        readdirSync(join(paths.config, "work")).length ||
        readProtected(join(paths.config, "dbhub.toml")).toString() !== DBHUB_READONLY_TOML
      )
        throw officialConnectorFailure()
    }
    return { ...next.config, enabled: state === "enabled" }
  } catch {
    throw officialConnectorFailure()
  }
}

export function removeOfficialConnectorVersion(root: string, name: OfficialConnectorName, version: string) {
  const paths = officialConnectorPaths(root, name, version)
  const run = runs.get(root)
  for (const dir of [paths.secret, paths.config, ...(run ? [join(run, name, version)] : [])]) {
    if (!existsSync(dir)) continue
    managedDirectory(insideDirectory(paths.base, dir) ? paths.base : run!, dir)
    rmSync(dir, { recursive: true })
  }
}

export function removeOfficialConnector(root: string, name: OfficialConnectorName) {
  const paths = officialConnectorPaths(root, name, "unused")
  const parents = [dirname(paths.secret), dirname(paths.config)]
  const versions = new Set(
    parents.flatMap((parent) => (existsSync(parent) ? (directory(parent), readdirSync(parent)) : [])),
  )
  for (const version of versions) removeOfficialConnectorVersion(root, name, version)
}

export function collectOldOfficialConnectorVersions(root: string, name: OfficialConnectorName, keep: string) {
  const parent = dirname(officialConnectorPaths(root, name, keep).secret)
  directory(parent)
  for (const version of readdirSync(parent)) if (version !== keep) removeOfficialConnectorVersion(root, name, version)
}

/** Main admission/recovery share the same release decision; never touch a still-live version. */
export function releaseOfficialConnectorResources(userDataPath: string, resources: readonly TxPreparedResourceV1[]) {
  for (const resource of resources) {
    if (resource.store === "official-connectors" && isOfficialConnector(resource.server)) {
      const live = collectMergedMcpRefPathsStrict(resource.server)
      if (!live.ok || live.refs.some((file) => file.includes(`/${resource.server}/${resource.version}/`)))
        throw new Error("official connector version still referenced or config unreadable")
      removeOfficialConnectorVersion(alphaGlobalRoot(), resource.server, resource.version)
      continue
    }
    releasePreparedTxResources(userDataPath, [resource])
  }
}

/** Rebind only committed identities after transaction recovery, before a sidecar can read refs. */
export function restoreCommittedOfficialConnectors() {
  try {
    for (const name of OFFICIAL_CONNECTOR_NAMES) {
      const record = findRecordV2(alphaGlobalRoot(), "mcp", name)
      if (!record) continue
      const recovery = probeTransactionJournals(alphaGlobalRoot())
      if (recovery.unreadableDir || recovery.entries.some((entry) => !entry.terminal))
        throw new Error("official-connector-needs-reentry: transaction recovery incomplete")
      const live = readMcpLeafStrict(name)
      if (!live.ok || !live.value) throw new Error("official-connector-needs-reentry: committed config unavailable")
      const refs = collectMcpFileRefPaths(live.value)
      const file = refs[0]
      const version = file ? basename(dirname(file)) : ""
      if (refs.length !== 1 || !file || basename(dirname(dirname(file))) !== name)
        throw new Error("official-connector-needs-reentry: committed identity unavailable")
      officialConnectorPaths(alphaGlobalRoot(), name, version)
      const config = restoreOfficialConnector(
        alphaGlobalRoot(),
        name,
        version,
        record.desiredState === "enabled" ? "enabled" : "disabled",
      )
      const written = withConfigWriteLock(() => {
        const target = mcpPluginTargetPath()
        const before = readFileSync(target, "utf8")
        return writeConfigTextAtomic(target, before, applyEdits(before, modify(before, ["mcp", name], config, {})))
      })
      if (!written.ok) throw new Error("official connector config rebind failed")
      if (config.type === "remote") {
        const remote = upsertMcpServerRecord({ name, url: config.url, headers: config.headers })
        if (!remote.ok) throw new Error("official connector remote rebind failed")
      }
    }
  } catch (error) {
    clearOfficialConnectorRuntime()
    throw error
  }
  return [...runs.values()]
}
