import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import type { CasGcRoundInput, CasGcRoundSummary } from "./ext-cas-gc"
import type { CasGcSchedulerConfig } from "./ext-cas-gc-scheduler"
import {
  cleanupDurableAtomicTemporaryFilesSync,
  DURABLE_ATOMIC_MACHINE_ID_FILE,
  writeFileDurableAtomicSync,
  type DurableAtomicFileSystem,
} from "./ext-atomic-fs"
import { createExtensionStorageAdapter, createSettingsAdapter } from "./settings-adapters"
import { ALPHA_SETTINGS_DEFAULTS, type AlphaSettings } from "../shared/settings-adapters"
import { RENDERER_SETTINGS_KEY } from "./store-keys"

const settings = (): AlphaSettings => structuredClone(ALPHA_SETTINGS_DEFAULTS)
const childModule = new URL("./settings-adapters.ts", import.meta.url).href
const childSource = `
const { createSettingsAdapter } = await import(${JSON.stringify(childModule)})
const file = process.env.REQ090_SETTINGS_FILE
const mode = process.env.REQ090_SETTINGS_MODE
if (!file || !mode) throw new Error("missing child input")
const adapter = createSettingsAdapter(file, {
  onCommitPoint(point) {
    if (point === process.env.REQ090_CRASH_POINT) process.kill(process.pid, "SIGKILL")
  },
})
if (mode === "read") console.log(JSON.stringify(adapter.read()))
if (mode === "write") {
  const value = JSON.parse(process.env.REQ090_SETTINGS_VALUE ?? "null")
  console.log(JSON.stringify(adapter.write({ value, expectedRevision: process.env.REQ090_SETTINGS_REVISION })))
}
`

function runSettingsChild(
  file: string,
  mode: "read" | "write",
  input?: { value: AlphaSettings; revision: string; crashPoint?: "file-synced" | "renamed" },
) {
  return Bun.spawnSync({
    cmd: [process.execPath, "--eval", childSource],
    env: {
      ...process.env,
      REQ090_SETTINGS_FILE: file,
      REQ090_SETTINGS_MODE: mode,
      ...(input
        ? {
            REQ090_SETTINGS_VALUE: JSON.stringify(input.value),
            REQ090_SETTINGS_REVISION: input.revision,
            ...(input.crashPoint ? { REQ090_CRASH_POINT: input.crashPoint } : {}),
          }
        : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
}

function readInChild(file: string) {
  const child = runSettingsChild(file, "read")
  expect(child.exitCode).toBe(0)
  expect(new TextDecoder().decode(child.stderr)).toBe("")
  return JSON.parse(new TextDecoder().decode(child.stdout)) as ReturnType<ReturnType<typeof createSettingsAdapter>["read"]>
}

function writeAuthority(file: string, raw: unknown, extra: Record<string, unknown> = {}) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ ...extra, [RENDERER_SETTINGS_KEY]: raw }, null, "\t"))
}

function readDocument(file: string) {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
}

const nodeFileSystem: DurableAtomicFileSystem = {
  existsSync: (file) => existsSync(file),
  mkdirSync: (dir, options) => mkdirSync(dir, options),
  writeFileSync: (file, data, options) => writeFileSync(file, data, options),
  openSync: (file, flags) => openSync(file, flags),
  fsyncSync: (fd) => fsyncSync(fd),
  closeSync: (fd) => closeSync(fd),
  renameSync: (from, to) => renameSync(from, to),
  readFileSync: (file, encoding) => readFileSync(file, encoding),
  readdirSync: (dir) => readdirSync(dir),
  unlinkSync: (file) => unlinkSync(file),
}

function durableTemporaryFiles(file: string) {
  const prefix = `.${basename(file)}.tmp-`
  return readdirSync(dirname(file)).filter(
    (entry) =>
      entry.startsWith(prefix) && /^\d+-[0-9a-f]{8}-[0-9a-f]{32}-[0-9a-f]{16}$/.test(entry.slice(prefix.length)),
  )
}

function leaveCurrentProcessTemporaryFile(file: string) {
  const created = { file: "" }
  const fileSystem: DurableAtomicFileSystem = {
    ...nodeFileSystem,
    unlinkSync(unlinkedFile) {
      if (unlinkedFile === created.file) throw new Error("preserve temporary file for cleanup test")
      unlinkSync(unlinkedFile)
    },
  }
  expect(() =>
    writeFileDurableAtomicSync(file, "candidate", {
      fileSystem,
      onCommitPoint(point, createdFile) {
        if (point !== "file-synced") return
        created.file = createdFile
        throw new Error("stop before rename")
      },
    }),
  ).toThrow("stop before rename")
  expect(created.file).not.toBe("")
  expect(existsSync(created.file)).toBe(true)
  return created.file
}

function leaveDeadProcessTemporaryFile(file: string) {
  const read = createSettingsAdapter(file).read()
  expect(read.ok).toBe(true)
  if (!read.ok) throw new Error("expected readable Settings authority")
  const next = settings()
  next.general.showTerminal = true
  const child = runSettingsChild(file, "write", { value: next, revision: read.revision, crashPoint: "file-synced" })
  expect(child.exitCode).not.toBe(0)
  const orphan = durableTemporaryFiles(file)
  expect(orphan).toHaveLength(1)
  if (!orphan[0]) throw new Error("expected child process temporary file")
  return join(dirname(file), orphan[0])
}

describe("Settings typed adapter", () => {
  let userData: string
  let file: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), "req090-settings-"))
    file = join(userData, "default.dat")
    const identitySeed = join(userData, "identity-seed")
    writeFileDurableAtomicSync(identitySeed, "identity", { fileSystem: nodeFileSystem })
    unlinkSync(identitySeed)
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  test("read returns defaults for an empty authority and normalizes the existing partial alpha seed", () => {
    const empty = createSettingsAdapter(file).read()
    expect(empty.ok).toBe(true)
    if (empty.ok) expect(empty.value).toEqual(ALPHA_SETTINGS_DEFAULTS)

    writeAuthority(file, JSON.stringify({ general: { newLayoutDesigns: true, showCustomAgents: true } }))
    const seeded = createSettingsAdapter(file).read()
    expect(seeded.ok).toBe(true)
    if (!seeded.ok) return
    expect(seeded.value.general.newLayoutDesigns).toBe(true)
    expect(seeded.value.general.showCustomAgents).toBe(true)
    expect(seeded.value.appearance.fontSize).toBe(14)
  })

  test("validate accepts the complete schema and rejects wrong types, unknown fields and unsafe keybind keys", () => {
    const adapter = createSettingsAdapter(file)
    expect(adapter.validate(settings())).toEqual({ ok: true })
    expect(adapter.validate({ ...settings(), appearance: { ...settings().appearance, fontSize: "14" } })).toEqual({
      ok: false,
      code: "invalid-input",
    })
    expect(adapter.validate({ ...settings(), secret: "must-not-become-a-setting" })).toEqual({
      ok: false,
      code: "invalid-input",
    })
    expect(adapter.validate({ ...settings(), keybinds: { constructor: "cmd+k" } })).toEqual({
      ok: false,
      code: "invalid-input",
    })
  })

  test("save is durable before success and a child process reopens the authoritative value", () => {
    writeAuthority(file, undefined, { unrelated: { preserved: true } })
    const first = createSettingsAdapter(file)
    const read = first.read()
    expect(read.ok).toBe(true)
    if (!read.ok) return
    const next = settings()
    next.notifications.errors = true
    const saved = first.write({ value: next, expectedRevision: read.revision })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.changed).toBe(true)
    expect(readDocument(file).unrelated).toEqual({ preserved: true })

    const restarted = readInChild(file)
    expect(restarted.ok).toBe(true)
    if (restarted.ok) {
      expect(restarted.value.notifications.errors).toBe(true)
      expect(restarted.revision).toBe(saved.revision)
    }
  })

  test("a successful commit fsyncs the renamed file contents and parent directory before returning success", () => {
    const descriptors = new Map<number, string>()
    const operations: Array<{
      kind: "write" | "open" | "fsync" | "close" | "rename" | "returned"
      file?: string
      fd?: number
      flags?: "r" | "wx"
      from?: string
      to?: string
    }> = []
    const fileSystem: DurableAtomicFileSystem = {
      ...nodeFileSystem,
      writeFileSync(writtenFile, data, options) {
        writeFileSync(writtenFile, data, options)
        operations.push({ kind: "write", file: writtenFile, flags: options.flag })
      },
      openSync(openedFile, flags) {
        const fd = openSync(openedFile, flags)
        descriptors.set(fd, openedFile)
        operations.push({ kind: "open", file: openedFile, fd, flags })
        return fd
      },
      fsyncSync(fd) {
        const openedFile = descriptors.get(fd)
        if (!openedFile) throw new Error("fsync descriptor was not opened by the durable writer")
        fsyncSync(fd)
        operations.push({ kind: "fsync", file: openedFile, fd })
      },
      closeSync(fd) {
        const openedFile = descriptors.get(fd)
        if (!openedFile) throw new Error("close descriptor was not opened by the durable writer")
        closeSync(fd)
        operations.push({ kind: "close", file: openedFile, fd })
        descriptors.delete(fd)
      },
      renameSync(from, to) {
        renameSync(from, to)
        operations.push({ kind: "rename", from, to })
      },
    }
    const adapter = createSettingsAdapter(file, { fileSystem })
    const read = adapter.read()
    expect(read.ok).toBe(true)
    if (!read.ok) return
    const next = settings()
    next.notifications.errors = true
    const saved = adapter.write({ value: next, expectedRevision: read.revision })
    operations.push({ kind: "returned" })

    expect(saved.ok).toBe(true)
    expect(operations.map((operation) => operation.kind)).toEqual([
      "write",
      "open",
      "fsync",
      "close",
      "rename",
      "open",
      "fsync",
      "close",
      "returned",
    ])
    const temporaryFile = operations[0]?.file ?? ""
    expect(operations[0]?.flags).toBe("wx")
    expect(temporaryFile).not.toBe(file)
    expect(dirname(temporaryFile)).toBe(dirname(file))
    expect(basename(temporaryFile)).toMatch(
      new RegExp(
        `^\\.${basename(file).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.tmp-${process.pid}-[0-9a-f]{8}-[0-9a-f]{32}-[0-9a-f]{16}$`,
      ),
    )
    expect(operations[1]?.file).toBe(temporaryFile)
    expect(operations[1]?.flags).toBe("r")
    expect(operations[1]?.file).toBe(operations[2]?.file)
    expect(operations[1]?.fd).toBe(operations[2]?.fd)
    expect(operations[1]?.file).toBe(operations[3]?.file)
    expect(operations[1]?.fd).toBe(operations[3]?.fd)
    expect(operations[4]?.from).toBe(temporaryFile)
    expect(operations[4]?.to).toBe(file)
    expect(operations[4]?.from).not.toBe(operations[4]?.to)
    expect(operations[5]?.file).toBe(dirname(file))
    expect(operations[5]?.flags).toBe("r")
    expect(operations[5]?.fd).toBe(operations[6]?.fd)
    expect(operations[5]?.file).toBe(operations[6]?.file)
    expect(operations[5]?.fd).toBe(operations[7]?.fd)
    expect(operations[5]?.file).toBe(operations[7]?.file)
  })

  test("an exact repeated submission is idempotent even with the original revision", () => {
    let commits = 0
    const adapter = createSettingsAdapter(file, {
      onCommitPoint: (point) => {
        if (point === "file-synced") commits++
      },
    })
    const read = adapter.read()
    expect(read.ok).toBe(true)
    if (!read.ok) return
    const next = settings()
    next.general.showSearch = true
    const first = adapter.write({ value: next, expectedRevision: read.revision })
    const replay = adapter.write({ value: next, expectedRevision: read.revision })
    expect(first.ok).toBe(true)
    expect(replay.ok).toBe(true)
    if (replay.ok) expect(replay.changed).toBe(false)
    expect(commits).toBe(1)
  })

  test("a stale conflicting submission is refused with the current authoritative value", () => {
    let commits = 0
    const adapter = createSettingsAdapter(file, {
      onCommitPoint: (point) => {
        if (point === "file-synced") commits++
      },
    })
    const read = adapter.read()
    expect(read.ok).toBe(true)
    if (!read.ok) return
    const first = settings()
    first.general.showStatus = true
    expect(adapter.write({ value: first, expectedRevision: read.revision }).ok).toBe(true)
    const conflicting = settings()
    conflicting.general.showFileTree = true
    const result = adapter.write({ value: conflicting, expectedRevision: read.revision })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("revision-conflict")
    expect(result.authoritative?.value.general.showStatus).toBe(true)
    expect(commits).toBe(1)
  })

  test("invalid input never writes", () => {
    const result = createSettingsAdapter(file).write({
      value: { ...settings(), notifications: { agent: true, permissions: true, errors: "yes" } },
      expectedRevision: "s1:" + "0".repeat(64),
    })
    expect(result).toEqual({ ok: false, code: "invalid-input" })
    expect(existsSync(file)).toBe(false)
  })

  test("a malformed write envelope returns only invalid-input", () => {
    expect(createSettingsAdapter(file).write(null)).toEqual({ ok: false, code: "invalid-input" })
    expect(
      createSettingsAdapter(file).write({
        value: settings(),
        expectedRevision: "s1:".padEnd(67, "0"),
        secret: "do-not-leak",
      }),
    ).toEqual({ ok: false, code: "invalid-input" })
    expect(existsSync(file)).toBe(false)
  })

  test.each(["write", "file-fsync", "hook", "rename"] as const)(
    "%s failure removes this attempt's temporary file and never falls back to a direct write",
    (failure) => {
      const descriptors = new Map<number, string>()
      const fileSystem: DurableAtomicFileSystem = {
        ...nodeFileSystem,
        writeFileSync(temporaryFile, data, options) {
          writeFileSync(temporaryFile, data, options)
          if (failure === "write") throw new Error("injected write failure")
        },
        openSync(openedFile, flags) {
          const fd = openSync(openedFile, flags)
          descriptors.set(fd, openedFile)
          return fd
        },
        fsyncSync(fd) {
          if (failure === "file-fsync" && descriptors.get(fd) !== dirname(file)) {
            throw new Error("injected file fsync failure")
          }
          fsyncSync(fd)
        },
        closeSync(fd) {
          closeSync(fd)
          descriptors.delete(fd)
        },
        renameSync(from, to) {
          if (failure === "rename") throw new Error("injected rename failure")
          renameSync(from, to)
        },
      }
      const adapter = createSettingsAdapter(file, {
        fileSystem,
        onCommitPoint: (point) => {
          if (failure === "hook" && point === "file-synced") throw new Error("injected hook failure")
        },
      })
      const read = adapter.read()
      expect(read.ok).toBe(true)
      if (!read.ok) return
      const next = settings()
      next.general.showTerminal = true
      const result = adapter.write({ value: next, expectedRevision: read.revision })

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe("write-failed")
      expect(existsSync(file)).toBe(false)
      expect(durableTemporaryFiles(file)).toEqual([])
      const restarted = readInChild(file)
      expect(restarted.ok).toBe(true)
      if (restarted.ok) expect(restarted.value).toEqual(ALPHA_SETTINGS_DEFAULTS)
    },
  )

  test("a temporary-file cleanup failure does not replace the original commit error", () => {
    const commitError = new Error("original commit failure")
    const fileSystem: DurableAtomicFileSystem = {
      ...nodeFileSystem,
      writeFileSync(temporaryFile, data, options) {
        writeFileSync(temporaryFile, data, options)
        throw commitError
      },
      unlinkSync() {
        throw new Error("secondary cleanup failure")
      },
    }

    expect(() => writeFileDurableAtomicSync(file, "candidate", { fileSystem })).toThrow(commitError)
    expect(durableTemporaryFiles(file)).toHaveLength(1)
  })

  test("an exclusive-create collision never overwrites or unlinks the existing temporary file", () => {
    const collision = { file: "" }
    const fileSystem: DurableAtomicFileSystem = {
      ...nodeFileSystem,
      writeFileSync(temporaryFile) {
        collision.file = temporaryFile
        writeFileSync(temporaryFile, "another writer", { flag: "wx" })
        const error = new Error("temporary file already exists") as NodeJS.ErrnoException
        error.code = "EEXIST"
        throw error
      },
    }

    expect(() => writeFileDurableAtomicSync(file, "candidate", { fileSystem })).toThrow("already exists")
    expect(readFileSync(collision.file, "utf8")).toBe("another writer")
  })

  test("a parent-directory fsync failure after rename never reports success", () => {
    const adapter = createSettingsAdapter(file)
    const read = adapter.read()
    expect(read.ok).toBe(true)
    if (!read.ok) return
    const old = settings()
    old.general.showStatus = true
    const initial = adapter.write({ value: old, expectedRevision: read.revision })
    expect(initial.ok).toBe(true)
    if (!initial.ok) return
    const descriptors = new Map<number, string>()
    const directoryFsyncAttempts: string[] = []
    const fileSystem: DurableAtomicFileSystem = {
      ...nodeFileSystem,
      openSync(openedFile, flags) {
        const fd = openSync(openedFile, flags)
        descriptors.set(fd, openedFile)
        return fd
      },
      fsyncSync(fd) {
        const openedFile = descriptors.get(fd)
        if (openedFile === dirname(file)) {
          directoryFsyncAttempts.push(openedFile)
          throw new Error("injected parent-directory fsync failure")
        }
        fsyncSync(fd)
      },
      closeSync(fd) {
        closeSync(fd)
        descriptors.delete(fd)
      },
    }
    const next = settings()
    next.general.showTerminal = true
    const failing = createSettingsAdapter(file, { fileSystem })
    const result = failing.write({ value: next, expectedRevision: initial.revision })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("write-failed")
      expect(result.authoritative?.value).toEqual(next)
    }
    expect(directoryFsyncAttempts).toEqual([dirname(file)])
    expect(durableTemporaryFiles(file)).toEqual([])
    const restarted = readInChild(file)
    expect(restarted.ok).toBe(true)
    if (restarted.ok) expect(restarted.value).toEqual(next)
  })

  test("startup cleanup preserves a temporary file owned by an active pid", () => {
    const active = leaveCurrentProcessTemporaryFile(file)
    expect(basename(active)).toContain(`.tmp-${process.pid}-`)

    expect(createSettingsAdapter(file).read().ok).toBe(true)
    expect(existsSync(active)).toBe(true)
  })

  test("startup cleanup recovers a same-host temporary file after its creator pid dies", () => {
    const orphan = leaveDeadProcessTemporaryFile(file)

    expect(createSettingsAdapter(file).read().ok).toBe(true)
    expect(existsSync(orphan)).toBe(false)
  })

  test("cleanup leaves foreign machine identities, other target namespaces, and similar names untouched", () => {
    const temporaryFile = leaveDeadProcessTemporaryFile(file)
    const match = /^(.*\.tmp-\d+-[0-9a-f]{8})-([0-9a-f]{32})-([0-9a-f]{16})$/.exec(basename(temporaryFile))
    expect(match).not.toBeNull()
    if (!match) return
    const foreignMachineID = match[2] === "0".repeat(32) ? "1".repeat(32) : "0".repeat(32)
    const foreignIdentity = join(userData, `${match[1]}-${foreignMachineID}-${match[3]}`)
    const similar = join(userData, `.${basename(file)}.tmp-${process.pid}-aaaaaaaa-not-an-owner`)
    const foreignNamespace = join(userData, `.other-adapter.tmp-${process.pid}-aaaaaaaa-${match[2]}-${match[3]}`)
    renameSync(temporaryFile, foreignIdentity)
    writeFileSync(similar, "similar")
    writeFileSync(foreignNamespace, "foreign")

    cleanupDurableAtomicTemporaryFilesSync(file, nodeFileSystem)
    expect(existsSync(foreignIdentity)).toBe(true)
    expect(existsSync(similar)).toBe(true)
    expect(existsSync(foreignNamespace)).toBe(true)
  })

  test("cleanup preserves a same-hostname temporary file carrying another machine's persisted identity", () => {
    const foreignUserData = mkdtempSync(join(tmpdir(), "req090-settings-foreign-machine-"))
    const foreignFile = join(foreignUserData, basename(file))
    const temporaryFile = leaveDeadProcessTemporaryFile(foreignFile)
    const localMachineID = readFileSync(join(userData, DURABLE_ATOMIC_MACHINE_ID_FILE), "utf8")
    const foreignMachineID = readFileSync(join(foreignUserData, DURABLE_ATOMIC_MACHINE_ID_FILE), "utf8")
    expect(foreignMachineID).not.toBe(localMachineID)
    const foreignTemporaryFile = join(userData, basename(temporaryFile))
    renameSync(temporaryFile, foreignTemporaryFile)

    cleanupDurableAtomicTemporaryFilesSync(file, nodeFileSystem)
    expect(existsSync(foreignTemporaryFile)).toBe(true)
    rmSync(foreignUserData, { recursive: true, force: true })
  })

  test("cleanup preserves a dead pid candidate whose process-instance-id does not match its persisted record", () => {
    const temporaryFile = leaveDeadProcessTemporaryFile(file)
    const match = /^(.*\.tmp-\d+-[0-9a-f]{8}-[0-9a-f]{32})-([0-9a-f]{16})$/.exec(basename(temporaryFile))
    expect(match).not.toBeNull()
    if (!match) return
    const mismatchedProcessInstanceID = match[2] === "0".repeat(16) ? "1".repeat(16) : "0".repeat(16)
    const mismatched = join(userData, `${match[1]}-${mismatchedProcessInstanceID}`)
    renameSync(temporaryFile, mismatched)

    cleanupDurableAtomicTemporaryFilesSync(file, nodeFileSystem)
    expect(existsSync(mismatched)).toBe(true)
  })

  test.each(["missing", "corrupt"] as const)(
    "cleanup preserves every candidate without throwing when the machine identity file is %s",
    (state) => {
      const temporaryFile = leaveDeadProcessTemporaryFile(file)
      const machineIDFile = join(userData, DURABLE_ATOMIC_MACHINE_ID_FILE)
      if (state === "missing") unlinkSync(machineIDFile)
      if (state === "corrupt") writeFileSync(machineIDFile, "not-a-machine-id")

      expect(() => cleanupDurableAtomicTemporaryFilesSync(file, nodeFileSystem)).not.toThrow()
      expect(existsSync(temporaryFile)).toBe(true)
    },
  )

  test("cleanup preserves a candidate when process state is uncertain and does not throw", () => {
    const temporaryFile = leaveDeadProcessTemporaryFile(file)
    const uncertain = join(userData, basename(temporaryFile).replace(/\.tmp-\d+-/, `.tmp-${"9".repeat(32)}-`))
    renameSync(temporaryFile, uncertain)

    expect(() => cleanupDurableAtomicTemporaryFilesSync(file, nodeFileSystem)).not.toThrow()
    expect(existsSync(uncertain)).toBe(true)
  })

  test("startup cleanup failure leaves residual temps without blocking normal reads or writes", () => {
    const residual = leaveCurrentProcessTemporaryFile(file)
    const fileSystem: DurableAtomicFileSystem = {
      ...nodeFileSystem,
      readdirSync() {
        throw new Error("injected startup cleanup failure")
      },
    }
    const adapter = createSettingsAdapter(file, { fileSystem })
    const read = adapter.read()
    expect(read.ok).toBe(true)
    if (!read.ok) return
    const next = settings()
    next.general.showSearch = true

    expect(adapter.write({ value: next, expectedRevision: read.revision }).ok).toBe(true)
    expect(existsSync(residual)).toBe(true)
  })

  test.each([
    ["file-synced", "old"],
    ["renamed", "old-or-new"],
  ] as const)("crash at %s never reports success or leaves a corrupt authority", (crashPoint, expected) => {
    const adapter = createSettingsAdapter(file)
    const read = adapter.read()
    expect(read.ok).toBe(true)
    if (!read.ok) return
    const old = settings()
    old.general.showStatus = true
    const initial = adapter.write({ value: old, expectedRevision: read.revision })
    expect(initial.ok).toBe(true)
    if (!initial.ok) return
    const next = settings()
    next.sounds.agentEnabled = false
    const child = runSettingsChild(file, "write", { value: next, revision: initial.revision, crashPoint })
    expect(child.exitCode).not.toBe(0)
    expect(new TextDecoder().decode(child.stdout)).toBe("")
    expect(durableTemporaryFiles(file).length).toBe(crashPoint === "file-synced" ? 1 : 0)

    const restarted = readInChild(file)
    expect(restarted.ok).toBe(true)
    if (!restarted.ok) return
    if (expected === "old") expect(restarted.value).toEqual(old)
    if (expected === "old-or-new") expect([old, next]).toContainEqual(restarted.value)
    expect(() => readDocument(file)).not.toThrow()
    expect(durableTemporaryFiles(file)).toEqual([])
  })

  test("an invalid authority can be repaired only with the revision returned by read", () => {
    writeAuthority(file, '{"general":{"showSearch":"/Users/alice/secret"}}')
    const adapter = createSettingsAdapter(file)
    const read = adapter.read()
    expect(read.ok).toBe(false)
    if (read.ok || read.code !== "authority-invalid") return
    expect(JSON.stringify(read)).not.toContain("/Users/")
    const repaired = adapter.write({ value: settings(), expectedRevision: read.revision })
    expect(repaired.ok).toBe(true)
    expect(readInChild(file).ok).toBe(true)
  })

  test("real file read failures return only a stable redacted code", () => {
    mkdirSync(file)
    const result = createSettingsAdapter(file).read()
    expect(result).toEqual({ ok: false, code: "read-failed" })
    expect(JSON.stringify(result)).not.toContain(userData)
  })
})

const gcConfig: CasGcSchedulerConfig = {
  casBaseRoot: "/alpha",
  envRoots: ["/alpha/env/dev", "/alpha/env/prod", "/alpha/env/beta"],
  seedLockPaths: ["/app/seed.lock.json"],
  graceMs: 21_600_000,
  dryRun: false,
  initialDelayMs: 300_000,
  intervalMs: 86_400_000,
}

const summary = (overrides: Partial<CasGcRoundSummary> = {}): CasGcRoundSummary => ({
  ok: true,
  dryRun: true,
  marked: 7,
  blobsTotal: 11,
  sweepableCount: 4,
  sweptCount: 0,
  keptByGrace: 2,
  warningCount: 1,
  ...overrides,
})

describe("extension storage typed adapter", () => {
  test("inspect uses dry-run and returns the exact aggregate whitelist", async () => {
    const inputs: CasGcRoundInput[] = []
    const adapter = createExtensionStorageAdapter(gcConfig, (input) => {
      inputs.push(input)
      return Promise.resolve({
        ...summary(),
        digest: "a".repeat(64),
        swept: ["/alpha/cas/v1/sha256/aa/secret"],
        warnings: ["secret warning detail"],
      } as CasGcRoundSummary & { digest: string; swept: string[]; warnings: string[] })
    })
    expect(adapter.snapshot()).toEqual({ state: "not-run", result: null })
    const result = await adapter.inspect()
    expect(inputs).toEqual([
      {
        casBaseRoot: gcConfig.casBaseRoot,
        envRoots: gcConfig.envRoots,
        seedLockPaths: gcConfig.seedLockPaths,
        graceMs: gcConfig.graceMs,
        dryRun: true,
      },
    ])
    expect(Object.keys(result).sort()).toEqual(
      ["code", "blobsTotal", "sweepableCount", "sweptCount", "keptByGrace", "warningCount"].sort(),
    )
    expect(result).toEqual({
      code: "ok",
      blobsTotal: 11,
      sweepableCount: 4,
      sweptCount: 0,
      keptByGrace: 2,
      warningCount: 1,
    })
    expect(JSON.stringify(result)).not.toContain("digest")
    expect(JSON.stringify(result)).not.toContain("/alpha/")
    expect(JSON.stringify(result)).not.toContain("warnings")
    expect(JSON.stringify(result)).not.toContain("marked")
    expect(JSON.stringify(result)).not.toContain("dryRun")
    expect(adapter.snapshot()).toEqual({ state: "ready", result })
  })

  test("collect uses the same worker with dryRun=false and reports only aggregate deletion count", async () => {
    const inputs: CasGcRoundInput[] = []
    const adapter = createExtensionStorageAdapter(gcConfig, (input) => {
      inputs.push(input)
      return Promise.resolve(summary({ dryRun: false, sweptCount: 4 }))
    })
    const result = await adapter.collect()
    expect(inputs[0]?.dryRun).toBe(false)
    expect(result).toEqual({
      code: "ok",
      blobsTotal: 11,
      sweepableCount: 4,
      sweptCount: 4,
      keptByGrace: 2,
      warningCount: 1,
    })
  })

  test("GC reasons map to stable codes without leaking reason, path or secret", async () => {
    const failed = createExtensionStorageAdapter(gcConfig, () =>
      Promise.resolve(summary({ ok: false, reason: "seed lock invalid /Users/alice/token-secret" })),
    )
    const failedResult = await failed.inspect()
    expect(failedResult.code).toBe("fail-closed")
    expect(JSON.stringify(failedResult)).not.toContain("/Users/")
    expect(JSON.stringify(failedResult)).not.toContain("token-secret")

    const busy = createExtensionStorageAdapter(gcConfig, () =>
      Promise.resolve(summary({ ok: false, reason: "CAS lock busy: held by /home/alice" })),
    )
    expect((await busy.collect()).code).toBe("busy")

    const transactionBusy = createExtensionStorageAdapter(gcConfig, () =>
      Promise.resolve(summary({ ok: false, reason: "transaction in flight at /x — GC skipped (mutual exclusion)" })),
    )
    expect((await transactionBusy.collect()).code).toBe("busy")

    const misleadingPath = createExtensionStorageAdapter(gcConfig, () =>
      Promise.resolve(summary({ ok: false, reason: "seed identity invalid at /Users/lock busy/root" })),
    )
    expect((await misleadingPath.inspect()).code).toBe("fail-closed")
  })

  test("worker failure returns a stable zeroed result", async () => {
    const adapter = createExtensionStorageAdapter(gcConfig, () =>
      Promise.reject(new Error("worker crashed at /Users/alice token=secret")),
    )
    const result = await adapter.inspect()
    expect(result).toEqual({
      code: "worker-failed",
      blobsTotal: 0,
      sweepableCount: 0,
      sweptCount: 0,
      keptByGrace: 0,
      warningCount: 0,
    })
    expect(JSON.stringify(result)).not.toContain("/Users/")
    expect(JSON.stringify(result)).not.toContain("secret")
  })

  test("snapshot exposes running state and a concurrent trigger gets busy without spawning another round", async () => {
    let finish: ((value: CasGcRoundSummary) => void) | undefined
    let rounds = 0
    const adapter = createExtensionStorageAdapter(gcConfig, () => {
      rounds++
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    const inspecting = adapter.inspect()
    expect(adapter.snapshot()).toEqual({ state: "checking", result: null })
    expect((await adapter.collect()).code).toBe("busy")
    expect(rounds).toBe(1)
    finish?.(summary())
    expect((await inspecting).code).toBe("ok")
    expect(adapter.snapshot().state).toBe("ready")
  })
})
