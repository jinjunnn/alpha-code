#!/usr/bin/env bun

import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// One entry per upstream contract publisher. Each pins an immutable commit and owns its own lock
// file, vendor subtree, and staged-source directory. `vendor` re-copies bytes from a staged checkout
// of the pinned commit and rewrites that lock; `--check` (the merge gate) re-hashes the vendored
// bytes against the lock and, when a staged checkout is present, against the upstream bytes too.
const UPSTREAMS = [
  {
    // #640 / platform#101: bumped off bcc60bbf for the Ledger V1 hard cut. `LedgerEntryV1` is now the
    // append-only ledger fact (seq/op_id/kind/domain/signed amount/created_at ms); the old mutable
    // {id,type,title,amount_fen,status} row is gone at an unchanged schema_version — a breaking
    // in-place cut with no compatibility shim, so this pin and the desktop decoder move together.
    repo: "jinjunnn/alpha-platform",
    commit: "2fe1d0103b7c3f68acb98c44d13ed0fcfe8bf196",
    lock: "alpha-platform-contract.lock.json",
    vendor: "vendor/alpha-platform",
    sourceEnv: "ALPHA_PLATFORM_CONTRACT_SOURCE",
    sourceDefault: ".upstream-contracts",
    files: [
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
    ],
  },
  {
    // alpha-web publishes the consumer fixtures for alpha-code's two web-owned surfaces
    // (alpha-web#23 / alpha-work#9 AC3). They are exercised through the shipped decoders in
    // packages/ui-mac/src/main/alpha-web-contract-fixtures.test.ts — an upstream change those
    // decoders reject turns this repository's merge gate red as soon as the pin is bumped.
    repo: "jinjunnn/alpha-web",
    commit: "b597f0d548db9ffafc6d6301e548dbd323c810ad",
    lock: "alpha-web-contract.lock.json",
    vendor: "vendor/alpha-web",
    sourceEnv: "ALPHA_WEB_CONTRACT_SOURCE",
    sourceDefault: ".upstream-web-contracts",
    files: [
      "contracts/web-identity/fixtures/consumers/alpha-code/endpoint-discovery.json",
      "contracts/web-account/fixtures/consumers/alpha-code/account-summary.json",
      // The schema itself, so the account decoder's accepted key sets can be bound to the
      // upstream property sets by test rather than restated as a hand-maintained constant.
      "contracts/web-account/account-summary.v1.schema.json",
    ],
  },
] as const

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repositoryRoot = resolve(packageRoot, "../..")
const check = process.argv.includes("--check")

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex")
const sourceRootOf = (upstream: (typeof UPSTREAMS)[number]) =>
  resolve(repositoryRoot, process.env[upstream.sourceEnv] ?? upstream.sourceDefault)

if (check) {
  for (const upstream of UPSTREAMS) {
    const vendorRoot = resolve(packageRoot, upstream.vendor)
    const sourceRoot = sourceRootOf(upstream)
    const hasStagedSource = existsSync(sourceRoot)
    const lock = (await Bun.file(resolve(packageRoot, upstream.lock)).json()) as {
      repo?: unknown
      commit?: unknown
      files?: Array<{ path?: unknown; sha256?: unknown }>
    }
    if (lock.repo !== upstream.repo || lock.commit !== upstream.commit)
      throw new Error(`contract lock does not resolve to the approved immutable commit: ${upstream.lock}`)
    if (!Array.isArray(lock.files) || lock.files.length !== upstream.files.length)
      throw new Error(`contract lock file set differs from the approved vendor set: ${upstream.lock}`)
    for (const path of upstream.files) {
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
    console.log(`verified ${upstream.files.length} contract artifacts from ${upstream.repo}@${upstream.commit}`)
  }
  process.exit(0)
}

let vendored = 0
for (const upstream of UPSTREAMS) {
  const sourceRoot = sourceRootOf(upstream)
  // Bumping one pin does not require staging every upstream; an unstaged publisher keeps its
  // existing vendored bytes and lock untouched.
  if (!existsSync(sourceRoot)) {
    console.log(`skipped ${upstream.repo}: no staged contracts at ${sourceRoot}`)
    continue
  }
  const vendorRoot = resolve(packageRoot, upstream.vendor)
  const files = [] as Array<{ path: string; sha256: string }>
  for (const path of upstream.files) {
    const source = Bun.file(resolve(sourceRoot, path))
    if (!(await source.exists())) throw new Error(`approved contract artifact is missing: ${path}`)
    const data = new Uint8Array(await source.arrayBuffer())
    JSON.parse(new TextDecoder().decode(data))
    await Bun.write(resolve(vendorRoot, path), data, { createPath: true })
    files.push({ path, sha256: sha256(data) })
  }
  await Bun.write(
    resolve(packageRoot, upstream.lock),
    `${JSON.stringify({ repo: upstream.repo, commit: upstream.commit, files }, null, 2)}\n`,
  )
  console.log(`vendored ${files.length} contract artifacts from ${upstream.repo}@${upstream.commit}`)
  vendored++
}
if (vendored === 0) throw new Error("no staged upstream contracts found")
