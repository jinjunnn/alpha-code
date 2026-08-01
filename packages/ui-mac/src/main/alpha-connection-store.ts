import * as fs from "node:fs"
import * as path from "node:path"
import { writeFileAtomicSync } from "./ext-atomic-fs"
import {
  ALPHA_CONNECTION_ID_RE,
  decodeConnectionRecordV1,
  withPackageBindingV1,
  type ConnectionRecordV1,
} from "../shared/package-alpha-connection"

/**
 * The main-owned `ConnectionRecordV1` repository.
 *
 * **Where this lives is the whole design.** Every other durable record in this app is owned by an
 * install: `installs.json` entries die with their `(kind, name)`, and `<root>/ext-store/<key>/`
 * is deleted wholesale by `uninstallExtension`. A connection is the first object here whose
 * lifetime is none of those — it is shared between packages and it survives all of them, because
 * the thing it represents is consent recorded at a *provider*, which uninstalling a local file
 * cannot and must not revoke.
 *
 * So the store sits under `userData`, beside the MCP secret store and outside the extension root
 * entirely, and `assertStoreIndependence` refuses to touch it if that ever stops being true. That
 * guard is not decoration: the natural, tempting place to put this file is next to the ledger, and
 * a store under the extension root is silently destroyed the first time a user uninstalls anything.
 */
const CONNECTION_DIR = "alpha-connections"
const CONNECTION_FILE = "records.json"
const ENVELOPE_KEYS = new Set(["v", "records"])
const MAX_RECORDS = 64

export type AlphaConnectionStoreScope = {
  userDataPath: string
  /** The extension transaction root — passed so the independence guard can be enforced, not assumed. */
  extensionRoot: string
}

export type AlphaConnectionStoreRead =
  | { ok: true; records: ConnectionRecordV1[] }
  | { ok: false; reason: string }

export type AlphaConnectionStoreWrite = { ok: true } | { ok: false; reason: string }

export function alphaConnectionStoreDir(userDataPath: string): string {
  return path.join(userDataPath, CONNECTION_DIR)
}

export function alphaConnectionStorePath(userDataPath: string): string {
  return path.join(alphaConnectionStoreDir(userDataPath), CONNECTION_FILE)
}

/**
 * Fail closed when the connection store would live inside the extension root. Everything under
 * that root belongs to install/uninstall transactions; a connection record placed there is not
 * "stored badly", it is *scheduled for deletion* by the next uninstall.
 */
export function assertAlphaConnectionStoreIndependenceV1(
  scope: AlphaConnectionStoreScope,
): { ok: true } | { ok: false; reason: string } {
  const store = path.resolve(alphaConnectionStoreDir(scope.userDataPath))
  const root = path.resolve(scope.extensionRoot)
  if (store === root || store.startsWith(root + path.sep))
    return {
      ok: false,
      reason: `connection store ${store} is inside the extension root ${root} — refusing (uninstall would destroy it)`,
    }
  return { ok: true }
}

/**
 * Read every record. A corrupt or unknown-shaped store is an error, never an empty list: silently
 * reading zero connections would present a fully connected package as "not connected yet" and walk
 * the user into re-authorising at the provider.
 */
export function readAlphaConnectionRecordsV1(scope: AlphaConnectionStoreScope): AlphaConnectionStoreRead {
  const guard = assertAlphaConnectionStoreIndependenceV1(scope)
  if (!guard.ok) return guard
  let raw: string
  try {
    raw = fs.readFileSync(alphaConnectionStorePath(scope.userDataPath), "utf8")
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined
    if (code === "ENOENT") return { ok: true, records: [] }
    return { ok: false, reason: error instanceof Error ? error.message : "connection store unreadable" }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: "connection store is not valid JSON — refusing (fail closed)" }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return { ok: false, reason: "connection store envelope must be an object" }
  const envelope = parsed as Record<string, unknown>
  for (const key of Object.keys(envelope))
    if (!ENVELOPE_KEYS.has(key)) return { ok: false, reason: `connection store: unknown key "${key}"` }
  if (envelope.v !== 1) return { ok: false, reason: "connection store: unsupported envelope version" }
  if (!Array.isArray(envelope.records)) return { ok: false, reason: "connection store: records must be an array" }
  if (envelope.records.length > MAX_RECORDS)
    return { ok: false, reason: `connection store: exceeds ${MAX_RECORDS} records` }

  const records: ConnectionRecordV1[] = []
  const seen = new Set<string>()
  for (const entry of envelope.records) {
    const decoded = decodeConnectionRecordV1(entry)
    if (!decoded.ok) return { ok: false, reason: `connection store: ${decoded.errors.join("; ")}` }
    if (seen.has(decoded.record.connectionId))
      return { ok: false, reason: `connection store: duplicate connectionId ${decoded.record.connectionId}` }
    seen.add(decoded.record.connectionId)
    records.push(decoded.record)
  }
  return { ok: true, records }
}

/** Insert or replace one record by `connectionId`. 0600, atomic, whole-file. */
export function upsertAlphaConnectionRecordV1(
  scope: AlphaConnectionStoreScope,
  record: ConnectionRecordV1,
): AlphaConnectionStoreWrite {
  const current = readAlphaConnectionRecordsV1(scope)
  if (!current.ok) return current
  const next = [
    ...current.records.filter((candidate) => candidate.connectionId !== record.connectionId),
    record,
  ]
  return writeRecords(scope, next)
}

/**
 * Release one component's binding from every record that holds it.
 *
 * The record stays. Reaching zero bindings means "no installed package needs this right now", not
 * "throw away the user's authorisation" — and this is the function an uninstall calls, so treating
 * empty as a delete would make uninstalling one package revoke a connection another package (or a
 * future reinstall) still depends on.
 */
export function releaseAlphaConnectionBindingsV1(
  scope: AlphaConnectionStoreScope,
  componentId: string,
  now: string,
): AlphaConnectionStoreWrite {
  const current = readAlphaConnectionRecordsV1(scope)
  if (!current.ok) return current
  const next = current.records.map((record) => withPackageBindingV1(record, componentId, "release", now))
  if (next.every((record, index) => record === current.records[index])) return { ok: true }
  return writeRecords(scope, next)
}

/** Bind one component to one connection. Idempotent. */
export function bindAlphaConnectionPackageV1(
  scope: AlphaConnectionStoreScope,
  connectionId: string,
  componentId: string,
  now: string,
): AlphaConnectionStoreWrite {
  if (!ALPHA_CONNECTION_ID_RE.test(connectionId)) return { ok: false, reason: "invalid connectionId" }
  const current = readAlphaConnectionRecordsV1(scope)
  if (!current.ok) return current
  const target = current.records.find((record) => record.connectionId === connectionId)
  if (!target) return { ok: false, reason: `connection ${connectionId} is not in the store` }
  const bound = withPackageBindingV1(target, componentId, "bind", now)
  if (bound === target) return { ok: true }
  return writeRecords(
    scope,
    current.records.map((record) => (record.connectionId === connectionId ? bound : record)),
  )
}

/**
 * Remove one record. The *only* deletion path, and it exists for the explicit disconnect action —
 * no uninstall, claim release, or GC sweep may reach it.
 */
export function removeAlphaConnectionRecordV1(
  scope: AlphaConnectionStoreScope,
  connectionId: string,
): AlphaConnectionStoreWrite {
  const current = readAlphaConnectionRecordsV1(scope)
  if (!current.ok) return current
  const next = current.records.filter((record) => record.connectionId !== connectionId)
  if (next.length === current.records.length) return { ok: true }
  return writeRecords(scope, next)
}

function writeRecords(
  scope: AlphaConnectionStoreScope,
  records: ConnectionRecordV1[],
): AlphaConnectionStoreWrite {
  const guard = assertAlphaConnectionStoreIndependenceV1(scope)
  if (!guard.ok) return guard
  if (records.length > MAX_RECORDS) return { ok: false, reason: `connection store: exceeds ${MAX_RECORDS} records` }
  const sorted = [...records].sort((left, right) =>
    left.connectionId < right.connectionId ? -1 : left.connectionId > right.connectionId ? 1 : 0,
  )
  const dir = alphaConnectionStoreDir(scope.userDataPath)
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.chmodSync(dir, 0o700)
    const stat = fs.lstatSync(dir)
    if (stat.isSymbolicLink() || !stat.isDirectory())
      return { ok: false, reason: "connection store dir is not a real directory — refusing (symlink hazard)" }
    writeFileAtomicSync(alphaConnectionStorePath(scope.userDataPath), `${JSON.stringify({ v: 1, records: sorted }, null, 2)}\n`, {
      mode: 0o600,
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "failed to write connection store" }
  }
}
