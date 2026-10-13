// Closed official recipes and read-only install prerequisites (also used by Catalog evaluation).
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { userInfo, tmpdir } from "node:os"
import { isAbsolute, join, sep } from "node:path"
import { environmentFromMutableRoot } from "./alpha-environment"
import { keychainBackend } from "./alpha-keychain-backend"

// Source: DBHub v1.5.0 CLI migration template and https://dbhub.ai/config/toml .
export const DBHUB_READONLY_TOML =
  '[[sources]]\nid = "default"\ndsn = "${DSN}"\n\n[[tools]]\nname = "execute_sql"\nsource = "default"\nreadonly = true\n'
export const OFFICIAL_CONNECTOR_NAMES = ["github-official", "dbhub-readonly"] as const
export type OfficialConnectorName = (typeof OFFICIAL_CONNECTOR_NAMES)[number]
export const officialConnectorFailure = () =>
  new Error("official-connector-needs-reentry: secure storage or runtime prerequisite unavailable")
export const isOfficialConnector = (name: string): name is OfficialConnectorName =>
  OFFICIAL_CONNECTOR_NAMES.some((entry) => entry === name)
export const insideDirectory = (root: string, target: string) => target === root || target.startsWith(root + sep)

export function officialConnectorBackend() {
  const value = keychainBackend()
  // Only macOS currently supplies the process fence that keeps ciphertext/TOML/cwd outside
  // engine-write roots. chmod alone cannot provide that boundary on the other platforms.
  if (process.platform !== "darwin" || !value?.isEncryptionAvailable()) throw officialConnectorFailure()
  return value
}

export function officialRuntimeParent(root: string) {
  const temp = realpathSync.native(tmpdir())
  if (
    insideDirectory(realpathSync.native(userInfo().homedir), temp) ||
    insideDirectory(realpathSync.native(process.cwd()), temp)
  )
    throw officialConnectorFailure()
  const base = environmentFromMutableRoot(root)
  if (!base) throw officialConnectorFailure()
  // Read the main-only workspace truth at this synchronous secret boundary. Importing the
  // tracker also imports renderer contract checks through tabs-preclean (Window.api order).
  const truthPath = join(base.casBaseRoot, "fence-workspaces", `${base.environment}.json`)
  if (existsSync(truthPath)) {
    const truth = JSON.parse(readFileSync(truthPath, "utf8"))
    if (
      truth.v !== 1 ||
      !Array.isArray(truth.workspaces) ||
      truth.workspaces.some(
        (path: unknown) =>
          typeof path !== "string" || !isAbsolute(path) || insideDirectory(realpathSync.native(path), temp),
      )
    )
      throw officialConnectorFailure()
  }
  const parent = join(
    temp,
    `alpha-connectors-${process.getuid?.()}-${createHash("sha256").update(root).digest("hex").slice(0, 16)}`,
  )
  return parent
}

export function officialNodeCommand() {
  const node = spawnSync("which", ["node"], {
    encoding: "utf8",
    timeout: 5000,
    env: { PATH: process.env.PATH },
  }).stdout?.trim()
  const npx = spawnSync("which", ["npx"], {
    encoding: "utf8",
    timeout: 5000,
    env: { PATH: process.env.PATH },
  }).stdout?.trim()
  if (!node || !npx || !isAbsolute(node) || !isAbsolute(npx)) throw officialConnectorFailure()
  const tested = spawnSync(node, ["--version"], { encoding: "utf8", timeout: 5000, env: { PATH: process.env.PATH } })
  const version = /^v(\d+)\.(\d+)\.(\d+)\s*$/.exec(tested.stdout ?? "")
  if (
    tested.status !== 0 ||
    !version ||
    Number(version[1]) < 22 ||
    (Number(version[1]) === 22 && Number(version[2]) < 5)
  )
    throw officialConnectorFailure()
  return [node, realpathSync(npx), "-y", "@bytebase/dbhub@1.5.0", "--transport", "stdio"]
}

export function officialConnectorPrerequisite(name: OfficialConnectorName, root: string) {
  officialConnectorBackend()
  officialRuntimeParent(root)
  if (name === "dbhub-readonly") officialNodeCommand()
}
