import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

/**
 * #769 · the CI step `verify immutable Alpha contract vendor lock` was **red on every run**, and red
 * for a reason unrelated to the drift it exists to catch: `check:vendor` hard-failed with
 * "required producer checkout is unavailable" whenever the sibling `../alpha-web` checkout was
 * absent, and CI runs a bare `actions/checkout` that never clones a sibling. A permanently red gate
 * is not a gate — it is a step everyone learns to ignore, so a real drift would sail through too.
 *
 * The fix degrades instead of failing. The whole risk of degrading is trading a constant red for a
 * **fake green**, so this file's job is to prove the degraded mode is still a real gate:
 *
 *  · it still goes red when vendored bytes disagree with the lock (the ticket's named criterion);
 *  · it still goes red when a *self-consistent* rewrite changes vendored bytes **and** the lock
 *    together — which is exactly what running `vendor` against a stale or wrong directory does, and
 *    is the one attack a "lock ↔ vendored bytes" check cannot see by itself;
 *  · it says out loud, in its own output, that provenance was not verified this run;
 *  · `vendor` (which *writes* the lock) still hard-fails without a checkout, because a lock minted
 *    with no provenance is a self-consistent forgery.
 *
 * Every assertion runs against an **isolated copy** of the package in a temp directory, never the
 * repository's own vendor tree. Tampering with the real vendored bytes and restoring them afterwards
 * is how a crashed test run leaves a corrupted checkout behind — and how a `git checkout --` cleanup
 * wipes unrelated uncommitted work (this portfolio has lost real work to exactly that twice).
 */

const packageRoot = resolve(import.meta.dir, "..")
const MANIFEST = "extension-package-producer-artifact.v1.json"
const VENDOR = "vendor/alpha-web-extension-package"
const LOCK = "alpha-web-extension-package.lock.json"

/**
 * Force the degraded path deterministically for **every** upstream.
 *
 * Not left to the ambient filesystem: on a developer machine `../alpha-web` really does exist, so a
 * test that merely hoped the temp directory had no sibling would silently exercise the full path
 * here and the degraded path on CI — i.e. it would assert something different depending on where it
 * ran, which is the failure mode this whole file is about.
 */
const NO_SOURCES = {
  ALPHA_PLATFORM_CONTRACT_SOURCE: "/nonexistent-769/platform",
  ALPHA_PLATFORM_MODEL_CATALOG_SOURCE: "/nonexistent-769/model-catalog",
  ALPHA_WEB_CONTRACT_SOURCE: "/nonexistent-769/web",
  ALPHA_WEB_EXTENSION_PACKAGE_SOURCE: "/nonexistent-769/web-extension-package",
}

let tmpRoot: string
let pkg: string

beforeEach(() => {
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "req769-")))
  pkg = join(tmpRoot, "alpha-contracts-consumer")
  cpSync(join(packageRoot, "scripts"), join(pkg, "scripts"), { recursive: true })
  cpSync(join(packageRoot, "vendor"), join(pkg, "vendor"), { recursive: true })
  for (const lock of [
    "alpha-platform-contract.lock.json",
    "alpha-platform-model-catalog.lock.json",
    "alpha-web-contract.lock.json",
    LOCK,
  ])
    cpSync(join(packageRoot, lock), join(pkg, lock))
})
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }))

const run = (args: string[], extra: Record<string, string> = {}) => {
  const env: Record<string, string | undefined> = { ...process.env, ...NO_SOURCES, ...extra }
  // GITHUB_ACTIONS is real in CI. Unless a test is specifically about the annotation, remove it, so
  // "no annotation" never passes merely because of where the suite happened to run.
  if (!("GITHUB_ACTIONS" in extra)) delete env.GITHUB_ACTIONS
  const proc = Bun.spawnSync(["bun", join(pkg, "scripts/vendor-alpha-contracts.ts"), ...args], { cwd: pkg, env })
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() }
}

const readLock = () => JSON.parse(readFileSync(join(pkg, LOCK), "utf8")) as { files: Array<{ path: string; sha256: string }> }
const writeLock = (lock: unknown) => writeFileSync(join(pkg, LOCK), `${JSON.stringify(lock, null, 2)}\n`)

describe("#769 · check:vendor degrades without a producer checkout instead of being red forever", () => {
  test("control: an untampered run with no checkout anywhere exits 0", () => {
    // Without this control every "it went red" below could be the fixture being red on its own, and
    // the bypass experiment would prove nothing.
    const clean = run(["--check"])
    expect(clean.stderr).toBe("")
    expect(clean.exitCode).toBe(0)
  })

  test("the degraded run states, in its own output, that provenance was NOT verified", () => {
    const clean = run(["--check"])
    // Naming the pin is the point: "provenance unverified" without saying *which* commit went
    // unproven is not a usable statement.
    expect(clean.stdout).toContain("PROVENANCE NOT VERIFIED this run")
    expect(clean.stdout).toContain("no staged checkout of jinjunnn/alpha-web@9f1e74a146f2046126982b371ba66180d26bbcde")
    expect(clean.stdout).not.toContain("verified 40 contract artifacts from")
  })

  test("on GitHub Actions the degradation is also raised as a workflow annotation, not just a log line", () => {
    // A line buried in a green step's log is how a gate rots the second time. The annotation surfaces
    // on the run summary and the PR page.
    const annotated = run(["--check"], { GITHUB_ACTIONS: "true" })
    expect(annotated.exitCode).toBe(0)
    expect(annotated.stdout).toContain("::warning title=PROVENANCE NOT VERIFIED (jinjunnn/alpha-web)::")
    expect(run(["--check"]).stdout).not.toContain("::warning")
  })

  test("AC: vendored bytes that disagree with the lock still turn the degraded run RED", () => {
    const target = join(pkg, VENDOR, "input.bundle.valid.json")
    writeFileSync(target, `${readFileSync(target, "utf8")}\n`)
    const tampered = run(["--check"])
    expect(tampered.exitCode).not.toBe(0)
    expect(tampered.stderr).toContain("vendored contract hash mismatch: input.bundle.valid.json")
  })

  test("a self-consistent rewrite of BOTH vendored bytes and the lock is still RED", () => {
    // The attack a bare "lock ↔ vendored bytes" check structurally cannot see: `vendor` run against a
    // stale or wrong directory rewrites the bytes and the lock in one pass, so the two agree with each
    // other and disagree with reality. The producer manifest is what closes it — its file hashes are
    // covered by an aggregate that must equal `artifactSha256`, a constant living in reviewed source
    // that `vendor` never rewrites.
    const path = "input.bundle.valid.json"
    const target = join(pkg, VENDOR, path)
    const bytes = `${readFileSync(target, "utf8")}\n`
    writeFileSync(target, bytes)
    const lock = readLock()
    const entry = lock.files.find((candidate) => candidate.path === path)!
    entry.sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
    writeLock(lock)

    const forged = run(["--check"])
    expect(forged.exitCode).not.toBe(0)
    expect(forged.stderr).toContain(`producer manifest disagrees with the lock about ${path}`)
  })

  test("the producer manifest cannot self-certify: rewriting it AND its own lock entry is still RED", () => {
    // Deliberately not the naive version. Editing the manifest alone goes red on the plain byte
    // check, which proves nothing new — the attacker who rewrote the lock in the previous test would
    // obviously rewrite this entry too. So do exactly that, and let the only remaining anchor answer:
    // the aggregate over the manifest must equal `artifactSha256`, pinned in reviewed source.
    const manifestPath = join(pkg, VENDOR, MANIFEST)
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      files: Array<{ path: string; sha256: string }>
    }
    manifest.files[0]!.sha256 = "0".repeat(64)
    const rewritten = `${JSON.stringify(manifest, null, 2)}\n`
    writeFileSync(manifestPath, rewritten)
    const lock = readLock()
    lock.files.find((candidate) => candidate.path === MANIFEST)!.sha256 = new Bun.CryptoHasher("sha256")
      .update(rewritten)
      .digest("hex")
    writeLock(lock)

    const forged = run(["--check"])
    expect(forged.exitCode).not.toBe(0)
    expect(forged.stderr).toContain("producer artifact manifest aggregate/provenance binding mismatch")
  })

  test("`vendor` — the side that WRITES the lock — still hard-fails with no producer checkout", () => {
    // Degrading is only honest for the read side. Minting a lock with no provenance produces a
    // self-consistent forgery that every later `--check` would then happily confirm.
    const written = run([])
    expect(written.exitCode).not.toBe(0)
    expect(written.stderr).toContain("required producer checkout is unavailable")
  })
})
