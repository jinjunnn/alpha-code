/**
 * Running `git` against a **different** repository than the one we are standing in.
 *
 * #754:the pre-push hook was red for every push, and the content being pushed had nothing to do
 * with it. `git push` exports GIT_DIR into the hook process, and GIT_DIR **beats `git -C <dir>`**
 * — so `git -C ../alpha-web rev-parse <sha>` inside the hook resolved against alpha-code's own
 * object store, the producer commit "did not resolve", and `check:vendor` threw. Everyone learned
 * to push with `--no-verify`, which is worse than having no hook at all: the gate reads as armed
 * while being structurally off.
 *
 * Measured (git 2.50.1, Apple Git-155), not inferred — a bare `pre-push` hook that dumps `env`:
 *
 *   push from a **linked worktree** → GIT_DIR=<repo>/.git/worktrees/<name>, GIT_EDITOR, GIT_EXEC_PATH, GIT_PREFIX
 *   push from the **main worktree** → GIT_EDITOR, GIT_EXEC_PATH, GIT_PREFIX   (no GIT_DIR)
 *
 * That is the whole story of "always red": this repository's standard is that all work happens in
 * `.worktrees/` (alpha-work CLAUDE.md), so in practice every push is a linked-worktree push.
 *
 * The fix is **not** to hand-maintain a list of "git variables that break `-C`". Writing our own
 * stand-in for another tool's grammar is this repository's most expensive recurring defect
 * (alpha-work CLAUDE.md「勘破先于闸门设计」:consume the other side's decision, do not re-derive
 * it). Git already publishes the answer: `git rev-parse --local-env-vars` lists exactly the GIT_*
 * variables that are **local to a repository** — the same set git itself clears before running a
 * subprocess inside a different repository. We consume that list verbatim.
 *
 * Measured against `git -C <other repo> rev-parse <sha>^{commit}` with each variable poisoned, the
 * ones that actually redirect the lookup today are GIT_DIR, GIT_COMMON_DIR, GIT_OBJECT_DIRECTORY
 * and GIT_CONFIG_COUNT. We deliberately scrub the *whole* published set anyway rather than just
 * those four: the others (GIT_INDEX_FILE, GIT_WORK_TREE, GIT_PREFIX, …) are inert for the two
 * command shapes used today and would bite the first call site that runs anything else.
 * `git-cross-repo.test.ts` pins the four measured ones, so a git release that stopped listing them
 * turns the gate red instead of silently un-scrubbing it.
 */

/** Cached because it is a constant of the installed git, and we call it once per spawn otherwise. */
let cached: readonly string[] | undefined

/**
 * The GIT_* variable names the installed git considers repository-local.
 *
 * Verified to be answerable under a hostile environment — it stays correct with GIT_DIR pointing at
 * a path that does not exist, and outside any repository at all — which matters because the first
 * thing this runs in is a hook whose environment is exactly that.
 */
export const repoLocalGitEnvNames = (): readonly string[] => {
  if (cached) return cached
  const listed = Bun.spawnSync(["git", "rev-parse", "--local-env-vars"])
  if (listed.exitCode !== 0)
    throw new Error(
      `cannot ask git which environment variables are repository-local ` +
        `(git rev-parse --local-env-vars exited ${listed.exitCode}: ${listed.stderr.toString().trim()})`,
    )
  const names = listed.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  // Fail closed. An empty list would silently mean "scrub nothing", i.e. exactly the #754 behaviour
  // we are removing — and it would look green until the next push from a worktree.
  if (names.length === 0) throw new Error("git reported an empty repository-local environment variable set")
  cached = names
  return cached
}

/** `source` minus every variable that binds git to *this* repository. */
export const crossRepoGitEnv = (source: Record<string, string | undefined> = process.env) => {
  const env: Record<string, string | undefined> = { ...source }
  for (const name of repoLocalGitEnvNames()) delete env[name]
  return env
}

/**
 * The single chokepoint for talking to another repository's git.
 *
 * Every cross-repository git call goes through here rather than each site remembering to pass an
 * env — a call site that forgets is invisible until someone pushes from a worktree, which is how
 * #754 survived. Same signature and return value as `Bun.spawnSync`, so call sites read unchanged.
 */
export const gitInRepository = (repositoryRoot: string, args: readonly string[]) =>
  Bun.spawnSync(["git", "-C", repositoryRoot, ...args], { env: crossRepoGitEnv() })
