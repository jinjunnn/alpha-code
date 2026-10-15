import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { crossRepoGitEnv } from "./git-cross-repo"

const repositoryRoot = resolve(import.meta.dir, "../../..")
const shippedHook = readFileSync(join(repositoryRoot, ".githooks/pre-push"), "utf8")
const alphaCheck = readFileSync(join(repositoryRoot, "scripts/alpha-check.sh"), "utf8")
const scrubBlock = /repository_local_git_env="\$\(git rev-parse --local-env-vars\)"[\s\S]*?unset repository_local_git_env\n/
const selfHealBlock = alphaCheck.match(
  /if \[ "\$\{ALPHA_HOOKS_DISABLE:-\}" != "1" \]; then\n[\s\S]*?unset current_alpha_hooks_path\nfi\n/,
)?.[0]
if (!selfHealBlock) throw new Error("alpha-check hook self-heal block not found")

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
  mkdirSync(join(main, "bin"))
  writeFileSync(join(main, "bin/check"), readFileSync(join(repositoryRoot, "bin/check")))
  chmodSync(join(main, "bin/check"), 0o755)
  writeFileSync(join(main, ".githooks/pre-push"), hook)
  chmodSync(join(main, ".githooks/pre-push"), 0o755)
  writeFileSync(
    join(main, "scripts/alpha-check.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
${selfHealBlock}
if [ "\${EXPECT_CLEAN_GIT_ENV:-0}" = "1" ]; then
  while IFS= read -r name; do
    if [ -n "$name" ] && [ "\${!name+x}" = "x" ]; then
      echo "repository-local git environment escaped the hook: $name" >&2
      exit 91
    fi
  done < <(git rev-parse --local-env-vars)
fi
if [ -n "\${CHECK_LOG:-}" ]; then
  echo check >> "$CHECK_LOG"
  exit "\${CHECK_EXIT:-0}"
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
  runGit(main, "add", ".githooks/pre-push", "scripts/alpha-check.sh", "bin/check", "tracked.txt")
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

const runPush = (root: string, expectClean: boolean, env: Record<string, string> = {}) =>
  Bun.spawnSync(["git", "-C", root, "push", "origin", "push-test"], {
    env: { ...crossRepoGitEnv(), PATH: "/usr/bin:/bin", EXPECT_CLEAN_GIT_ENV: expectClean ? "1" : "0", ...env },
  })

const runCheck = (root: string, disabled = false) =>
  Bun.spawnSync(["bash", join(root, "scripts/alpha-check.sh")], {
    cwd: root,
    env: { ...crossRepoGitEnv(), ALPHA_HOOKS_DISABLE: disabled ? "1" : "0" },
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

  test("alpha-check repairs an actual hooksPath drift but does not override the disable escape hatch", () => {
    const harness = makeHarness(shippedHook)
    runGit(harness.root, "config", "core.hooksPath", ".husky/_")
    expect(runCheck(harness.root).exitCode).toBe(0)
    expect(runGit(harness.root, "config", "--get", "core.hooksPath")).toBe(".githooks")
    runGit(harness.root, "config", "core.hooksPath", ".husky/_")
    expect(runCheck(harness.root, true).exitCode).toBe(0)
    expect(runGit(harness.root, "config", "--get", "core.hooksPath")).toBe(".husky/_")
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

describe("#1537 · pre-push gate delegation and fallback", () => {
  test("gate receives remote arguments and real Git stdin unchanged; its success/failure is final, without a second alpha-check", () => {
    const harness = makeHarness(shippedHook)
    mkdirSync(join(harness.container, "tools"))
    // 只替代命令边界,不重写 gate 的缓存/签名协议。缓存与落盘另用本机真实 gate 取证。
    writeFileSync(join(harness.container, "tools/gate"), `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$@" > "$GATE_ARGS"
cat > "$GATE_INPUT"
pwd > "$GATE_CWD"
while IFS= read -r name; do
  if [ -n "$name" ] && [ "\${!name+x}" = x ]; then exit 91; fi
done < <(git rev-parse --local-env-vars)
exit "$GATE_EXIT"
`)
    chmodSync(join(harness.container, "tools/gate"), 0o755)
    const env = {
      PATH: `${harness.container}/tools:/usr/bin:/bin`,
      GATE_ARGS: join(harness.container, "args"),
      GATE_INPUT: join(harness.container, "input"),
      GATE_CWD: join(harness.container, "cwd"),
      CHECK_LOG: join(harness.container, "checks"),
    }
    for (const code of [42, 0]) {
      expect(runPush(harness.root, true, { ...env, GATE_EXIT: String(code) }).exitCode === 0).toBe(code === 0)
      expect(readFileSync(env.GATE_ARGS, "utf8").trim().split("\n")).toEqual(["pre-push", "origin", join(harness.container, "remote.git")])
      expect(readFileSync(env.GATE_INPUT, "utf8").split(" ").slice(0, 2)).toEqual(["refs/heads/push-test", harness.head])
      expect(readFileSync(env.GATE_CWD, "utf8").trim()).toBe(harness.root)
      expect(Bun.file(env.CHECK_LOG).size).toBe(0)
    }
    rmSync(harness.container, { recursive: true, force: true })
  })

  test("no gate: alpha-check runs exactly once, rejects failure and accepts success; bin/check forwards the same exit code", () => {
    const harness = makeHarness(shippedHook)
    const log = join(harness.container, "checks")
    for (const code of [42, 0]) {
      const env = { CHECK_LOG: log, CHECK_EXIT: String(code) }
      expect(runPush(harness.root, true, env).exitCode === 0).toBe(code === 0)
      expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(code === 42 ? 1 : 3)
      expect(Bun.spawnSync(["./bin/check"], { cwd: harness.root, env: { ...crossRepoGitEnv(), ...env } }).exitCode).toBe(code)
    }
    rmSync(harness.container, { recursive: true, force: true })
  })
})
