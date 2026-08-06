import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { crossRepoGitEnv } from "./git-cross-repo"

const repositoryRoot = resolve(import.meta.dir, "../../..")
const shippedHook = readFileSync(join(repositoryRoot, ".githooks/pre-push"), "utf8")
const scrubBlock = /repository_local_git_env="\$\(git rev-parse --local-env-vars\)"[\s\S]*?unset repository_local_git_env\n/

const runGit = (root: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { env: crossRepoGitEnv() })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

const makeHarness = (hook: string) => {
  const container = realpathSync(mkdtempSync(join(tmpdir(), "req815-")))
  const main = join(container, "main")
  const root = join(container, "linked")
  const remote = join(container, "remote.git")
  mkdirSync(main)
  mkdirSync(join(main, ".githooks"))
  mkdirSync(join(main, "scripts"))
  writeFileSync(join(main, ".githooks/pre-push"), hook)
  chmodSync(join(main, ".githooks/pre-push"), 0o755)
  writeFileSync(
    join(main, "scripts/alpha-check.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "\${EXPECT_CLEAN_GIT_ENV:-0}" = "1" ]; then
  while IFS= read -r name; do
    if [ -n "$name" ] && [ "\${!name+x}" = "x" ]; then
      echo "repository-local git environment escaped the hook: $name" >&2
      exit 91
    fi
  done < <(git rev-parse --local-env-vars)
fi
fixture="$(mktemp -d)"
git init -q "$fixture"
git -C "$fixture" config user.email test@opencode.test
git -C "$fixture" config user.name Test
git -C "$fixture" -c commit.gpgsign=false commit --allow-empty -qm "root commit $fixture"
`,
  )
  chmodSync(join(main, "scripts/alpha-check.sh"), 0o755)
  Bun.spawnSync(["git", "init", "-q", "-b", "main", main], { env: crossRepoGitEnv() })
  writeFileSync(join(main, "tracked.txt"), "before\n")
  runGit(main, "add", ".githooks/pre-push", "scripts/alpha-check.sh", "tracked.txt")
  runGit(main, "-c", "user.email=owner@example.invalid", "-c", "user.name=Owner", "commit", "-qm", "before")
  runGit(main, "config", "core.hooksPath", ".githooks")
  runGit(main, "worktree", "add", "-q", "-b", "push-test", root)
  Bun.spawnSync(["git", "init", "--bare", "-q", remote], { env: crossRepoGitEnv() })
  runGit(root, "remote", "add", "origin", remote)
  const commonDir = resolve(root, runGit(root, "rev-parse", "--git-common-dir"))
  return {
    container,
    root,
    head: runGit(root, "rev-parse", "HEAD"),
    configPath: join(commonDir, "config"),
    config: readFileSync(join(commonDir, "config")),
    configStat: statSync(join(commonDir, "config"), { bigint: true }),
  }
}

const runPush = (root: string, expectClean: boolean) =>
  Bun.spawnSync(["git", "-C", root, "push", "origin", "push-test"], {
    env: { ...crossRepoGitEnv(), EXPECT_CLEAN_GIT_ENV: expectClean ? "1" : "0" },
  })

describe("#815 · pre-push scrubs the repository-local Git environment before running tests", () => {
  test("control: removing the scrub makes the fixture commit and config land in the branch being pushed", () => {
    const brokenHook = shippedHook.replace(scrubBlock, "")
    expect(brokenHook).not.toBe(shippedHook)
    const harness = makeHarness(brokenHook)
    const result = runPush(harness.root, false)
    expect(result.exitCode).toBe(0)
    expect(runGit(harness.root, "rev-parse", "HEAD")).not.toBe(harness.head)
    expect(readFileSync(harness.configPath, "utf8")).toContain("test@opencode.test")
    rmSync(harness.container, { recursive: true, force: true })
  })

  test("five real linked-worktree pushes leave HEAD and the shared config identity unchanged", () => {
    const harness = makeHarness(shippedHook)
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      writeFileSync(join(harness.root, "tracked.txt"), `attempt ${attempt}\n`)
      runGit(harness.root, "add", "tracked.txt")
      runGit(
        harness.root,
        "-c",
        "user.email=owner@example.invalid",
        "-c",
        "user.name=Owner",
        "commit",
        "-qm",
        `attempt ${attempt}`,
      )
      const head = runGit(harness.root, "rev-parse", "HEAD")
      const result = runPush(harness.root, true)
      expect(result.stderr.toString()).not.toContain("repository-local git environment escaped the hook")
      expect(result.exitCode).toBe(0)
      expect(runGit(harness.root, "rev-parse", "HEAD")).toBe(head)
      expect(readFileSync(harness.configPath)).toEqual(harness.config)
      const after = statSync(harness.configPath, { bigint: true })
      expect(after.ino).toBe(harness.configStat.ino)
      expect(after.mtimeNs).toBe(harness.configStat.mtimeNs)
    }
    rmSync(harness.container, { recursive: true, force: true })
  })
})
