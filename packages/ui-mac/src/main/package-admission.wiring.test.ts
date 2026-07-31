// REQ-128 package admission production gate. The shipped Catalog has no packages[] instance, so
// the child process feeds the pinned producer corpus through the real registered
// ext-install-catalog IPC. It uses the real coordinator, secret store, recovery write channel,
// transaction engine, config switch, capability ledger, and InstallRecordV2 commit.
import { resolve } from "node:path"
import { expect, test } from "bun:test"

test("production ext-install-catalog runs digest-bound package admission through the real transaction", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", resolve(import.meta.dir, "../../test-component/package-admission.wiring.cases.ts")],
    cwd: resolve(import.meta.dir, "../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  expect(output).toMatch(/\b1 pass\b/)
  expect(output).toMatch(/\b0 fail\b/)
}, 120_000)

test("signed Catalog snapshot carries the Envelope prerequisite into the real secret store", () => {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "test",
      resolve(import.meta.dir, "../../test-component/package-admission.signed-catalog.cases.ts"),
    ],
    cwd: resolve(import.meta.dir, "../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  expect(output).toMatch(/\b1 pass\b/)
  expect(output).toMatch(/\b0 fail\b/)
}, 120_000)

test("admission decoder, secret failure, MCP adoption, tamper, cancel, stale, and replay gates remain active", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", resolve(import.meta.dir, "package-admission.test.ts")],
    cwd: resolve(import.meta.dir, "../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  expect(output).toMatch(/\b10 pass\b/)
  expect(output).toMatch(/\b0 fail\b/)
}, 120_000)
