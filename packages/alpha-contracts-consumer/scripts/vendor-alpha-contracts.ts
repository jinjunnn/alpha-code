#!/usr/bin/env bun

import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const COMMIT = "bcc60bbf4870dd23ea5a63c9dca3107aa7a4b990"
const REPO = "jinjunnn/alpha-platform"
const FILES = [
  "contracts/v1/alpha-wire-contracts.schema.json",
  "contracts/v1/artifact-descriptor.schema.json",
  "contracts/v1/limits.json",
  "contracts/v1/fixtures/producer/artifact-list.json",
  "contracts/v1/fixtures/producer/cloud-job-accepted.json",
  "contracts/v1/fixtures/producer/cloud-job-request.json",
  "contracts/v1/fixtures/producer/cloud-job-status.json",
  "contracts/v1/fixtures/producer/ledger-page.json",
  "contracts/v1/fixtures/producer/model-catalog.json",
  "contracts/v1/fixtures/consumers/alpha-code-224/cloud-and-artifact.json",
  "contracts/v1/fixtures/consumers/alpha-web-22/platform-access-claims.json",
  "contracts/v1/fixtures/invalid/artifact-inline-content.json",
  "contracts/v1/fixtures/invalid/cloud-missing-version.json",
  "contracts/v1/fixtures/invalid/cloud-unknown-field.json",
  "contracts/v1/fixtures/limits/envelope-max-exact.json",
  "contracts/v1/fixtures/limits/envelope-max-plus-one.json",
  "contracts/v1/fixtures/limits/payload-max-exact.json",
  "contracts/v1/fixtures/limits/payload-max-plus-one.json",
] as const

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repositoryRoot = resolve(packageRoot, "../..")
const sourceRoot = resolve(repositoryRoot, process.env.ALPHA_PLATFORM_CONTRACT_SOURCE ?? ".upstream-contracts")
const vendorRoot = resolve(packageRoot, "vendor/alpha-platform")
const lockPath = resolve(packageRoot, "alpha-platform-contract.lock.json")
const check = process.argv.includes("--check")
const hasStagedSource = existsSync(sourceRoot)

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex")

if (check) {
  const lock = (await Bun.file(lockPath).json()) as {
    repo?: unknown
    commit?: unknown
    files?: Array<{ path?: unknown; sha256?: unknown }>
  }
  if (lock.repo !== REPO || lock.commit !== COMMIT) throw new Error("contract lock does not resolve to the approved immutable commit")
  if (!Array.isArray(lock.files) || lock.files.length !== FILES.length) throw new Error("contract lock file set differs from the approved vendor set")
  for (const path of FILES) {
    const entry = lock.files.find((candidate) => candidate.path === path)
    if (!entry || typeof entry.sha256 !== "string") throw new Error(`contract lock is missing ${path}`)
    const vendored = new Uint8Array(await Bun.file(resolve(vendorRoot, path)).arrayBuffer())
    if (sha256(vendored) !== entry.sha256) throw new Error(`vendored contract hash mismatch: ${path}`)
    if (!hasStagedSource) continue
    const sourceFile = Bun.file(resolve(sourceRoot, path))
    if (!(await sourceFile.exists())) throw new Error(`staged contract artifact is missing: ${path}`)
    const source = new Uint8Array(await sourceFile.arrayBuffer())
    if (sha256(source) !== entry.sha256) throw new Error(`staged contract hash mismatch: ${path}`)
  }
  console.log(`verified ${FILES.length} Alpha contract artifacts at ${COMMIT}`)
  process.exit(0)
}

if (!hasStagedSource) throw new Error(`staged Alpha contracts not found: ${sourceRoot}`)

const files = [] as Array<{ path: string; sha256: string }>
for (const path of FILES) {
  const source = Bun.file(resolve(sourceRoot, path))
  if (!(await source.exists())) throw new Error(`approved Alpha contract artifact is missing: ${path}`)
  const data = new Uint8Array(await source.arrayBuffer())
  JSON.parse(new TextDecoder().decode(data))
  await Bun.write(resolve(vendorRoot, path), data, { createPath: true })
  files.push({ path, sha256: sha256(data) })
}

await Bun.write(lockPath, `${JSON.stringify({ repo: REPO, commit: COMMIT, files }, null, 2)}\n`)
console.log(`vendored ${files.length} Alpha contract artifacts from ${REPO}@${COMMIT}`)
