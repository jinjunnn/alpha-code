import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { crossRepoGitEnv, gitInRepository, repoLocalGitEnvNames } from "./git-cross-repo"

/**
 * #754 regression: `git push` exports GIT_DIR into the hook process, GIT_DIR beats `git -C <dir>`,
 * and so every cross-repository lookup in `check:vendor` resolved against alpha-code instead of the
 * producer checkout. The pre-push gate was therefore red for **every** push regardless of content,
 * and the whole team routed around it with `--no-verify`.
 *
 * Two things these tests deliberately do NOT do, each of which would make them a fake gate:
 *
 *  1. **They never poison by mutating `process.env`.** Measured: `Bun.spawnSync` does not see
 *     runtime mutations of `process.env` — a child spawned without an explicit `env` gets the
 *     environment this process *started* with. So a test that set `process.env.GIT_DIR` and then
 *     called the un-fixed code would watch it succeed and report green. Poison is therefore only
 *     ever applied at spawn time: as an explicit `env` for a raw `git`, or as the real startup
 *     environment of a freshly spawned `check:vendor`.
 *  2. **They never lean on the sibling `../alpha-web` checkout for the core assertions.** That
 *     checkout does not exist on CI, and a gate that quietly evaporates in some environments is the
 *     failure mode this file exists to prevent. The one test that does need it is declared
 *     conditional, so a green run never silently claims the end-to-end path was proven.
 */

const scriptDir = import.meta.dir
const packageRoot = resolve(scriptDir, "..")
const checkVendorScript = resolve(scriptDir, "vendor-alpha-contracts.ts")

/**
 * `git init` + one commit, with identity/signing forced so a developer's global config cannot break it.
 *
 * The fixture itself must scrub, and this is not belt-and-braces: these tests run **inside the
 * pre-push hook**, where GIT_DIR is already injected. Building the fixture with a bare
 * `git -C <tmp>` meant `git init` landed on alpha-code's git dir and the temp repositories were
 * never created at all — caught only by actually running an unbypassed `git push` (#754's own exit
 * gate), never by running `bun test` from a normal shell.
 */
const makeRepo = (root: string, content: string) => {
  const run = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", root, ...args], { env: crossRepoGitEnv() })
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`)
    return r.stdout.toString().trim()
  }
  Bun.spawnSync(["git", "init", "-q", "-b", "main", root], { env: crossRepoGitEnv() })
  // Prove we are about to write into the throwaway repository and not somewhere real, BEFORE any
  // commit happens. If the scrub ever regresses, `git` with an inherited GIT_DIR and no
  // GIT_WORK_TREE treats the current directory as the work tree and happily commits into
  // alpha-code's own history — which is exactly what happened once here. That must be a loud
  // failure, not a silent side effect on the repository under test.
  const gitDir = run("rev-parse", "--absolute-git-dir")
  if (!gitDir.startsWith(root))
    throw new Error(`fixture repository escaped its temp directory: expected a git dir under ${root}, got ${gitDir}`)
  Bun.write(join(root, "file.txt"), content)
  run("add", "file.txt")
  run("-c", "user.email=t@example.invalid", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", content)
  return { root, head: run("rev-parse", "HEAD"), gitDir }
}

let tmpRoot: string
let producer: ReturnType<typeof makeRepo>
let pusher: ReturnType<typeof makeRepo>

beforeAll(() => {
  // realpath, because on macOS `tmpdir()` is `/var/...` while git answers `/private/var/...`. Without
  // it the escape guard below fires on every run — i.e. it would be "red no matter what", which reads
  // as a working guard while proving nothing about the thing it is supposed to catch.
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "req754-")))
  // Distinct content ⇒ distinct commit SHAs, so "resolved the producer's commit" can never be
  // satisfied by accidentally reading the pushing repository.
  producer = makeRepo(join(tmpRoot, "producer"), "producer-bytes")
  pusher = makeRepo(join(tmpRoot, "pusher"), "pushing-repository-bytes")
})
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))

/** Poison values for the variables git publishes as repository-local, all aimed at the *wrong* repo. */
const poison = (name: string) => {
  if (name === "GIT_DIR" || name === "GIT_COMMON_DIR") return pusher.gitDir
  if (name === "GIT_WORK_TREE" || name === "GIT_IMPLICIT_WORK_TREE") return pusher.root
  if (name === "GIT_OBJECT_DIRECTORY" || name === "GIT_ALTERNATE_OBJECT_DIRECTORIES")
    return join(pusher.gitDir, "objects")
  if (name === "GIT_INDEX_FILE") return join(pusher.gitDir, "index")
  if (name === "GIT_CONFIG" || name === "GIT_GRAFT_FILE" || name === "GIT_SHALLOW_FILE")
    return join(pusher.gitDir, "config")
  if (name === "GIT_CONFIG_COUNT") return "1"
  if (name === "GIT_CONFIG_PARAMETERS") return "'core.bare=true'"
  if (name === "GIT_PREFIX") return "packages/alpha-contracts-consumer/"
  if (name === "GIT_REPLACE_REF_BASE") return "refs/replace/"
  return "1"
}

const poisonAll = () => Object.fromEntries(repoLocalGitEnvNames().map((name) => [name, poison(name)]))

describe("#754 · a git call aimed at another repository ignores this repository's git environment", () => {
  const resolveProducerCommit = () => ["rev-parse", `${producer.head}^{commit}`]

  test("control: the hazard is real — GIT_DIR really does beat `git -C`", () => {
    // Without this control, the next test would keep passing on a hypothetical git where `-C` won,
    // i.e. it would be asserting something true no matter what we did to our own code.
    const raw = Bun.spawnSync(["git", "-C", producer.root, ...resolveProducerCommit()], {
      env: { ...process.env, GIT_DIR: pusher.gitDir },
    })
    expect(raw.exitCode).not.toBe(0)
    expect(raw.stdout.toString().trim()).not.toBe(producer.head)
  })

  test("scrubbing the environment restores the producer lookup", () => {
    const fixed = Bun.spawnSync(["git", "-C", producer.root, ...resolveProducerCommit()], {
      env: crossRepoGitEnv({ ...process.env, GIT_DIR: pusher.gitDir }),
    })
    expect(fixed.stderr.toString()).toBe("")
    expect(fixed.exitCode).toBe(0)
    expect(fixed.stdout.toString().trim()).toBe(producer.head)
  })

  test("control: the ENTIRE published repository-local set, poisoned at once, breaks a raw call", () => {
    const raw = Bun.spawnSync(["git", "-C", producer.root, ...resolveProducerCommit()], {
      env: { ...process.env, ...poisonAll() },
    })
    expect(raw.exitCode).not.toBe(0)
  })

  test("scrubbing survives the ENTIRE published repository-local set poisoned at once", () => {
    const fixed = Bun.spawnSync(["git", "-C", producer.root, ...resolveProducerCommit()], {
      env: crossRepoGitEnv({ ...process.env, ...poisonAll() }),
    })
    expect(fixed.exitCode).toBe(0)
    expect(fixed.stdout.toString().trim()).toBe(producer.head)
  })

  test("the scrub set still covers every variable measured to hijack `git -C`", () => {
    // Authority is `git rev-parse --local-env-vars`, not a list we maintain. These four are the ones
    // measured (git 2.50.1) to actually redirect `git -C <other repo> rev-parse <sha>^{commit}`; if a
    // future git stops publishing one, this goes red instead of silently un-scrubbing the gate.
    const published = repoLocalGitEnvNames()
    for (const name of ["GIT_COMMON_DIR", "GIT_CONFIG_COUNT", "GIT_OBJECT_DIRECTORY", "GIT_DIR"])
      expect(published).toContain(name)
    // Only repository-local names are dropped: GIT_EXEC_PATH is how git finds its own subcommands
    // and `git push` injects it, so removing it would break the hook in a different way.
    expect(crossRepoGitEnv({ GIT_DIR: "/x", GIT_COMMON_DIR: "/x", GIT_EXEC_PATH: "/keep", PATH: "/keep" })).toEqual({
      GIT_EXEC_PATH: "/keep",
      PATH: "/keep",
    })
  })
})

describe("#754 · the shipped check:vendor entry point, not just the helper", () => {
  /**
   * Spawns the real script the pre-push hook runs, with `extra` present in its **startup**
   * environment — which is the only way a child sees it, and the only faithful reproduction of what
   * `git push` does to the hook.
   */
  const runCheckVendor = (extra: Record<string, string>) => {
    const proc = Bun.spawnSync(["bun", checkVendorScript, "--check"], {
      cwd: packageRoot,
      // The base environment is scrubbed so that "clean" really is clean even when this file is
      // itself running inside the pre-push hook, where GIT_DIR is already present. Without that,
      // the reference run and the poisoned run would be the same environment and every comparison
      // below would pass by being a tautology.
      env: { ...crossRepoGitEnv(process.env), ...extra },
    })
    return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() }
  }

  const ownGitDir = Bun.spawnSync(["git", "-C", scriptDir, "rev-parse", "--absolute-git-dir"]).stdout
    .toString()
    .trim()

  // Measured from a probe `pre-push` hook rather than recalled (git 2.50.1): a push from a LINKED
  // WORKTREE exports GIT_DIR / GIT_EDITOR / GIT_EXEC_PATH / GIT_PREFIX. A push from the main
  // worktree exports the same minus GIT_DIR — which is exactly why this bug only ever bit people
  // following this repository's own `.worktrees/` standard.
  const pushEnv = { GIT_DIR: ownGitDir, GIT_PREFIX: "packages/alpha-contracts-consumer/", GIT_EDITOR: "true" }

  const clean = () => runCheckVendor({})

  test("a push-shaped environment does not change what check:vendor concludes", () => {
    const reference = clean()
    const underPush = runCheckVendor(pushEnv)
    // The #754 fingerprint, asserted by name: this error is only reachable when a git call aimed at
    // the producer repository got redirected back into alpha-code.
    expect(underPush.stderr).not.toContain("does not resolve exactly")
    expect(underPush.exitCode).toBe(reference.exitCode)
    expect(underPush.stdout).toBe(reference.stdout)
  })

  test("neither does the entire published repository-local set, poisoned at once", () => {
    const reference = clean()
    const underPoison = runCheckVendor(poisonAll())
    expect(underPoison.stderr).not.toContain("does not resolve exactly")
    expect(underPoison.exitCode).toBe(reference.exitCode)
    expect(underPoison.stdout).toBe(reference.stdout)
  })

  // The positive half needs the sibling `../alpha-web` checkout, which only a developer machine has
  // — and that is precisely the machine where the pre-push hook runs, so it is worth asserting.
  // It is NOT written as a skip: a skipped test silently drops out of the case count, and "fewer
  // cases" is exactly what the gate-file floor is supposed to catch. Instead the degraded branch
  // asserts a *positive* description of the degradation, so this can never pass for a reason
  // nobody named.
  //
  // #769: the branch condition used to be `exitCode !== 0`, because a missing checkout was a hard
  // failure. It is now a **degradation**, so the run exits 0 either way and the branch is chosen by
  // what the run says it proved — which is the honest discriminator anyway.
  test("with the producer checkout present, a pushed run still verifies it end to end", () => {
    const reference = clean()
    expect(reference.exitCode).toBe(0)
    if (!reference.stdout.includes("verified 36 contract artifacts from jinjunnn/alpha-web@")) {
      expect(reference.stdout).toContain("PROVENANCE NOT VERIFIED this run")
      return
    }
    for (const env of [pushEnv, poisonAll()]) {
      const run = runCheckVendor(env)
      expect(run.exitCode).toBe(0)
      expect(run.stdout).toContain("verified 36 contract artifacts from jinjunnn/alpha-web@")
    }
  })
})
