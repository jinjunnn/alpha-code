// `#889` —— north-star 守卫的**行为闸**。
//
// 这道门守的是什么(大白话):本仓是 opencode 的 fork,上游包只读 —— 改了它们,下一次
// fork-sync 就冲突。守卫是这条铁律唯一的机械判据,同时也是 alpha 分支保护上的一个必需
// context(`north-star guard (zero upstream edits)`)。
//
// 为什么判据必须长这样:
//   · **不断言脚本源码文本。** 「grep 到脚本里写着 origin/alpha」在本仓是点名过的**假闸门**
//     形态 —— 守卫被整段注释掉时它照样绿。这里起**真的 git 仓**、造**真的上游改动**、跑
//     **生产的那份脚本**(scripts/north-star-guard.sh,CI 与本地 alpha-check.sh 调用的
//     就是它),断言它**真的点名了那个文件**、真的以非零退出。
//   · **不只断言「改上游就红」。** 一个「永远红」的错误实现能满足那一条,所以另有两条反向:
//     只改 alpha 自有文件必须绿、exclude 表里的收编文件必须不被点名。
//   · **基准那一条自带控制组。** 只断言「守卫没点名 upstream-drift.ts」是不够的 —— 一个
//     夹具如果根本没造出 dev/alpha 的分叉,那条断言会空对空地绿。所以同一条用例里把生产
//     脚本复制一份、只把基准换成 origin/dev 跑一遍,先证明**这个夹具测得出已知的坏**,
//     再用它判未知的好(CLAUDE.md「观测手段自己有盲区」)。
//
// `#889` 修的缺陷:守卫的比较基准两处写死 `origin/dev`(上游纯镜像分支),而这道门要回答的
// 是「**这个 PR 自己**改了上游文件吗」,基准只能是它的目标分支 alpha。实测(2026-08-10):
// 两条 ref 的 merge-base 停在 `347510a73`(2026-07-23),alpha 领先 289 个提交、dev 领先 261
// 个且仍在动 ⇒ `origin/dev...HEAD` 的窗口是 550 commits / 2467 文件。今天两种基准结论相同
// (都是 0),**只是因为**那 44 条 ADR-033 收编白名单恰好吸收了窗口里点名的 47 个上游文件 ——
// 任何一次不在白名单里的合法上游改动,都会让这道门在每个 PR 上恒红(`#754` 那一类:
// 门还在跑、还给结论,而人人 --no-verify)。
//
// 删掉本文件会失去什么:守卫退回「没有任何行为判据」的状态 —— 基准改错、excludes 数组传错、
// diff-filter 写错、脚本被换成 `exit 0`,都不会有任何东西变红。它因此登记在
// scripts/gate-files.tsv 里,拿精确条数。
//
// `#913` 在文件末尾补了第二个 describe:守卫**降级**那一档(fetch 失败 ⇒ 用本地上一次拿到的
// `origin/alpha`)必须自报基准的身份与年龄,否则「今天绿」的含义取决于一个没人看得见的量。
// 那三条的理由写在那个 describe 头上。

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, test } from "bun:test"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..")
const GUARD = resolve(REPO_ROOT, "scripts/north-star-guard.sh")

/**
 * 完全隔离的 git 环境(与 ci-diff-scope.test.ts 同源的理由):
 *  ① 开发机的 ~/.gitconfig(core.hooksPath、templateDir、别名…)不许影响判据;
 *  ② 反过来 —— 本测试**结构上不可能**写到本仓的 .git/config 或当前分支(`ac#815` 那一类:
 *     跑门的过程往共享树里写东西,只有 reflog 分辨得出)。身份走 env,不走 `git config`。
 */
const GIT_ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "alpha ci fixture",
  GIT_AUTHOR_EMAIL: "fixture@alpha.invalid",
  GIT_COMMITTER_NAME: "alpha ci fixture",
  GIT_COMMITTER_EMAIL: "fixture@alpha.invalid",
} as const

function git(cwd: string, args: string[], extraEnv: Record<string, string> = {}): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: { ...GIT_ENV, ...extraEnv } })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} 失败:${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

function write(repo: string, files: Record<string, string>) {
  for (const [path, body] of Object.entries(files)) {
    Bun.spawnSync(["mkdir", "-p", join(repo, path, "..")], { env: { ...GIT_ENV } })
    writeFileSync(join(repo, path), body)
  }
}

function commit(repo: string, message: string, files: Record<string, string>, extraEnv: Record<string, string> = {}): string {
  write(repo, files)
  git(repo, ["add", "-A"], extraEnv)
  git(repo, ["commit", "-q", "-m", message], extraEnv)
  return git(repo, ["rev-parse", "HEAD"])
}

/** 把一次提交钉在某一天(UTC 正午,避开时区把日期翻到隔壁天)。 */
function onDay(day: string): Record<string, string> {
  return { GIT_AUTHOR_DATE: `${day}T12:00:00+00:00`, GIT_COMMITTER_DATE: `${day}T12:00:00+00:00` }
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
}

/** 上游包(真实 UPSTREAM_PATHS 之一)下的一个普通文件 —— 不在 ADR-033 白名单里。 */
const UPSTREAM_FILE = "packages/core/src/upstream-leaf.ts"
/** ADR-033 §1 白名单里的被接管文件 —— 改它是**有意的收编**,守卫必须放行。 */
const TAKEN_OVER_FILE = "packages/core/src/permission.ts"
/** alpha 自有包 —— 守卫的范围之外。 */
const ALPHA_FILE = "packages/ui-mac/src/main/alpha-owned.ts"
/**
 * **只落在 dev 窗口、不落在 alpha 窗口**的那个上游文件:它在 alpha 自己的历史里被改过
 * (真实世界里 = 三周 289 个提交里的任何一次收编/同步),而当前分支一个字没碰它。
 */
const ALPHA_SIDE_DRIFT = "packages/core/src/upstream-drift.ts"

/**
 * 夹具形状 —— 真实世界的缩比:
 *
 *   seed ──► dev    (上游镜像继续前进)
 *      └──► alpha   (alpha 自己改过 ALPHA_SIDE_DRIFT)
 *              └──► feature   (本次 PR 的分支,从 alpha 切出)
 *
 * `origin/alpha...HEAD` 只看得见 feature 自己的改动;`origin/dev...HEAD` 的分叉点退到 seed,
 * 于是把 alpha 侧的 ALPHA_SIDE_DRIFT 一起算进来。
 */
function forkFixture() {
  const origin = mkdtempSync(join(tmpdir(), "alpha-north-star-origin-"))
  git(origin, ["init", "-q", "-b", "alpha"])
  commit(origin, "seed", {
    [UPSTREAM_FILE]: "export const leaf = 1\n",
    [TAKEN_OVER_FILE]: "export const permission = 1\n",
    [ALPHA_SIDE_DRIFT]: "export const drift = 1\n",
    [ALPHA_FILE]: "export const alphaOwned = 1\n",
  })
  git(origin, ["checkout", "-q", "-b", "dev"])
  commit(origin, "upstream mirror moves on", { "packages/core/src/dev-only.ts": "export const devOnly = 1\n" })
  git(origin, ["checkout", "-q", "alpha"])
  commit(origin, "alpha takes over an upstream leaf (ADR-style)", {
    [ALPHA_SIDE_DRIFT]: "export const drift = 2\n",
  })

  const work = mkdtempSync(join(tmpdir(), "alpha-north-star-work-"))
  const result = Bun.spawnSync(["git", "clone", "-q", origin, work], { env: { ...GIT_ENV } })
  if (result.exitCode !== 0) throw new Error(`git clone 失败:${result.stderr.toString()}`)
  git(work, ["checkout", "-q", "-b", "feature", "origin/alpha"])
  return { origin, work }
}

/** `#913`:降级夹具里那个「上一次成功 fetch」的基准提交有多旧。 */
const STALE_DAYS = 45

/**
 * `#913` 降级夹具:**fetch 一定失败**(remote 指到一个不存在的路径),而本地 last-known
 * `origin/alpha` 停在 HEAD 之前 `staleDepth` 个提交 —— 这就是「上一次 fetch 成功之后 alpha
 * 又走了几步」在本地留下的样子(remote-tracking ref 本来就只是一个 ref,陈旧态与它逐字节
 * 相同,所以这里用 `update-ref` 把它回拨,而不是伪造别的东西)。
 *
 *   origin/alpha:  seed(STALE_DAYS 天前) ── m1 ── m2 ── m3(m* 只碰 alpha 自有文件)
 *   work:          HEAD = m3;refs/remotes/origin/alpha 回拨到 m3 往前第 staleDepth 个提交
 *
 * ⇒ 基准的身份与比较窗口宽度都由**夹具的构造**决定(baselineSha / window = staleDepth),
 * 不是从守卫自己的输出反推出来的 —— 后者是自指等价链,一起改错就一起自洽。
 * 每个提交的日期都显式钉死(UTC 正午):`--date=short` 按提交自带的时区渲染,不钉的话
 * 「今天」在 +08:00 的机器上会和 UTC 的今天差一天,断言随机翻红。
 */
function degradedFixture(staleDepth: number) {
  const staleDay = daysAgo(STALE_DAYS)
  const recentDay = daysAgo(1)
  const origin = mkdtempSync(join(tmpdir(), "alpha-north-star-stale-origin-"))
  git(origin, ["init", "-q", "-b", "alpha"])
  const seed = commit(
    origin,
    "seed",
    {
      [UPSTREAM_FILE]: "export const leaf = 1\n",
      [TAKEN_OVER_FILE]: "export const permission = 1\n",
      [ALPHA_FILE]: "export const alphaOwned = 1\n",
    },
    onDay(staleDay),
  )
  const moves = [1, 2, 3].map((n) =>
    commit(
      origin,
      `alpha moves on (${n})`,
      { [`packages/ui-mac/src/main/alpha-move-${n}.ts`]: `export const move = ${n}\n` },
      onDay(recentDay),
    ),
  )
  const history = [seed, ...moves]
  const days = [staleDay, recentDay, recentDay, recentDay]
  const at = history.length - 1 - staleDepth

  const work = mkdtempSync(join(tmpdir(), "alpha-north-star-stale-work-"))
  const cloned = Bun.spawnSync(["git", "clone", "-q", origin, work], { env: { ...GIT_ENV } })
  if (cloned.exitCode !== 0) throw new Error(`git clone 失败:${cloned.stderr.toString()}`)
  git(work, ["checkout", "-q", "-b", "feature", "origin/alpha"])
  // last-known 陈旧:remote-tracking ref 回拨。
  git(work, ["update-ref", "refs/remotes/origin/alpha", history[at]!])
  // fetch 一定失败:origin 指到一个不存在的路径(本地路径 ⇒ 立即 fatal,不碰网络、不会挂住)。
  git(work, ["remote", "set-url", "origin", `${origin}-vanished`])

  return { work, baselineSha: history[at]!, baselineDay: days[at]!, headSha: history[history.length - 1]!, staleDay }
}

/**
 * 从守卫输出里**读出**降级基准的比较窗口宽度。读不出就抛「本次测量作废」,而不是给一个
 * 数字 —— 观测手段自己有盲区时,沉默地返回 0 会把「一个字都没报」读成「窗口是 0」。
 */
function reportedWindow(output: string): number {
  const found = /window origin\/alpha\.\.HEAD = (\d+) commits/.exec(output)
  if (!found) throw new Error(`守卫的降级输出里读不出比较窗口宽度 —— 本次测量作废:\n${output}`)
  return Number(found[1])
}

type GuardRun = { exitCode: number; output: string }

/** 跑**生产脚本本体**。`script` 只在基准控制组里换成一份改过基准的复制品。 */
function runGuard(repo: string, script: string = GUARD): GuardRun {
  const result = Bun.spawnSync(["bash", script], { cwd: repo, env: { ...GIT_ENV } })
  const exitCode = result.exitCode
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  // 测不到就抛。守卫无论红绿都必须说话 —— 一个什么都不打印的运行不是「通过」。
  if (output.trim().length === 0) throw new Error("守卫一个字都没输出 —— 本次测量作废(不是通过)")
  return { exitCode, output }
}

describe("#889 north-star 守卫的行为", () => {
  test("改一个不在收编白名单里的上游文件 ⇒ 红,且点名那个文件", () => {
    const { work } = forkFixture()
    commit(work, "touch an upstream file", { [UPSTREAM_FILE]: "export const leaf = 999\n" })
    const run = runGuard(work)
    expect(run.exitCode, `守卫放行了一次真实的上游改动:\n${run.output}`).not.toBe(0)
    // 只断退出码不够:一个「永远红」的实现也满足它。必须**点名**,否则人拿不到可操作的信息。
    expect(run.output, `守卫红了但没点名被改的文件:\n${run.output}`).toContain(UPSTREAM_FILE)
  })

  test("上游改动只在工作树里(未提交)也必须红 —— 本地档比 CI 多验的那一半", () => {
    const { work } = forkFixture()
    write(work, { [UPSTREAM_FILE]: "export const leaf = 777\n" })
    const run = runGuard(work)
    // CI_STEPS 把这一步登记成 `SUPERSET:committed delta ∪ 未提交工作树改动`。那句登记是散文,
    // 这条用例是它的判据 —— 只留 committed 那一半时当场红。
    expect(run.exitCode, `未提交的上游改动被放行了(SUPERSET 那半边没了):\n${run.output}`).not.toBe(0)
    expect(run.output).toContain(UPSTREAM_FILE)
  })

  test("只改 alpha 自有文件 ⇒ 绿(否则「守卫恒红」这个错误实现也能满足上面两条)", () => {
    const { work } = forkFixture()
    commit(work, "alpha-owned change", { [ALPHA_FILE]: "export const alphaOwned = 2\n" })
    write(work, { [ALPHA_FILE]: "export const alphaOwned = 3\n" })
    const run = runGuard(work)
    expect(run.exitCode, `一次纯 alpha 改动被判成破北极星 —— 恒红的门等于没有门:\n${run.output}`).toBe(0)
  })

  test("ADR-033 白名单里的被接管文件被改 ⇒ 绿且不点名(excludes 真的传进去了)", () => {
    const { work } = forkFixture()
    commit(work, "edit a sanctioned takeover surface", { [TAKEN_OVER_FILE]: "export const permission = 2\n" })
    const run = runGuard(work)
    // 数组展开写错(比如漏了引号、或 pathspec 被当成一个整串)时,这一条是唯一会红的 ——
    // 那种错误会让 44 条收编集体失效,干净分支上恒假红。
    expect(run.exitCode, `收编白名单没生效,有意的接管被判成破北极星:\n${run.output}`).toBe(0)
    expect(run.output).not.toContain(TAKEN_OVER_FILE)
  })

  test("基准是 origin/alpha:只落在 dev 窗口里的上游改动不许被点名(还原成 origin/dev 即红)", () => {
    const { work } = forkFixture()
    commit(work, "an ordinary alpha-side change", { [ALPHA_FILE]: "export const alphaOwned = 2\n" })

    // ── 控制组:先证明这个夹具**测得出已知的坏** ────────────────────────────────
    // 只跑生产脚本、只断言「没点名」是不够的:夹具若根本没造出 dev/alpha 分叉,那条断言会
    // 空对空地绿。所以把生产脚本原样复制一份、只把基准换成 origin/dev 跑一遍。
    const mutated = join(mkdtempSync(join(tmpdir(), "alpha-north-star-ctl-")), "guard-on-dev.sh")
    writeFileSync(mutated, readFileSync(GUARD, "utf8").replaceAll("origin/alpha", "origin/dev"))
    const onDev = runGuard(work, mutated)
    expect(onDev.exitCode, `控制组没红 —— 夹具没造出 dev/alpha 的分叉,本条判据测不到目标:\n${onDev.output}`).not.toBe(0)
    expect(onDev.output, `控制组红了但没点名 alpha 侧的上游改动 —— 本次测量作废:\n${onDev.output}`).toContain(
      ALPHA_SIDE_DRIFT,
    )

    // ── 生产:同一棵树、同一个分支,基准换成目标分支后必须干净 ──────────────────
    const run = runGuard(work)
    expect(run.exitCode, `守卫把 alpha 自己历史里的上游改动算成了本分支的:\n${run.output}`).toBe(0)
    expect(run.output, `守卫点名了一个本分支没碰过的文件(基准退回 origin/dev 了):\n${run.output}`).not.toContain(
      ALPHA_SIDE_DRIFT,
    )
  })

  test("基准 ref 取不到时 fail-closed:非零 + 说「作废」,不是静默放行", () => {
    const solo = mkdtempSync(join(tmpdir(), "alpha-north-star-solo-"))
    git(solo, ["init", "-q", "-b", "feature"])
    commit(solo, "no remote at all", { [UPSTREAM_FILE]: "export const leaf = 1\n" })
    const run = runGuard(solo)
    // 改之前这里是 `git diff … 2>/dev/null || true`:ref 不存在 ⇒ git 报错被吞 ⇒ 空串 ⇒
    // 「已提交改动」那半边守卫**静默消失**而这一步报 ✓。测不到必须说测不到。
    expect(run.exitCode, `基准取不到时守卫竟然放行了 —— 那是假绿:\n${run.output}`).not.toBe(0)
    expect(run.output).toContain("origin/alpha")
  })

  test("上游路径下**新增**文件不被点名 —— `--diff-filter=DMR` 的明写边界,不是漏网", () => {
    const { work } = forkFixture()
    commit(work, "add a new file under an upstream package", {
      "packages/core/src/brand-new-alpha-leaf.ts": "export const added = 1\n",
    })
    const run = runGuard(work)
    // 这是**刻意**的:fork-sync 冲突来自 M/D/R,新增文件不冲突;ADR-035 与 ADR-038 都明写
    // 依赖它(「新增闸门文件落 alpha 自有的 alpha-*.test.ts,新增文件不触发 --diff-filter=DMR,
    // 无需 exclude」)。本条把那句散文变成判据:有人顺手加上 `A`,那两条 ADR 的前提当场失效,
    // 这里会红并逼他去读它们。`#889` 不改这个行为。
    expect(run.exitCode, `新增文件被守卫点名了 —— ADR-035/038 的「无需 exclude」前提已失效:\n${run.output}`).toBe(0)
  })
})

// ── `#913`:降级时「我量的是什么」必须出现在输出里 ──────────────────────────────────
//
// 守卫开跑前的 `git fetch` **间歇失败**(实测:`#889` 实现方约 3 次 1 次,主 session 复验 3 次
// 撞到 1 次)。失败时它降级到本地上一次拿到的 `origin/alpha` 继续跑 —— **方向是安全的**:
// 陈旧基准只把比较窗口撑得更宽 ⇒ 过报,不漏报,这不是假绿。
// 坏的是可见性:那行 warn 混在一整屏门输出里极易被略过,而「落后 1 个提交」与「落后 3 周」
// 原来长得**一模一样** ⇒「守卫今天绿」这句话的含义,取决于一个没人看得见的量。
//
// 判据为什么长这样:
//   · **不断言脚本源码文本**(grep 到脚本里写着 `commits behind`)—— 本仓点名过的假闸门形态。
//   · 断言落在**值**上:基准 sha 与陈旧程度必须是这棵树的真实值,而不是一句写死的话 ——
//     所以同一条用例跑两棵陈旧程度不同的树,报出来的数必须跟着变。
//   · 另有反向一条:fetch 正常时这一段**不许出现**。缺了它,「无条件永远打印一句年龄」这个
//     错误实现能满足上面全部断言。
//   · 还有一条守住既有行为:降级**不是**放弃 —— 它仍要跑完并给出正确结论。
describe("#913 fetch 失败降级时,基准的身份与年龄必须可读", () => {
  test("fetch 拿不到 + last-known 陈旧 ⇒ 基准 sha 与陈旧程度都读得出,且跟着真实状态变", () => {
    const stale = degradedFixture(3)
    const run = runGuard(stale.work)

    // 降级不改变结论:这个窗口里只有 alpha 自有改动 ⇒ 仍然绿。
    expect(run.exitCode, `降级路径把一次干净的运行判红了:\n${run.output}`).toBe(0)

    // ① 身份 —— 报的必须是**基准**那个提交,不是 HEAD(报 HEAD 等于什么都没说)。
    expect(run.output, `降级输出里没有基准的身份:\n${run.output}`).toContain(stale.baselineSha.slice(0, 7))
    expect(run.output, `降级输出报的是 HEAD 而不是基准:\n${run.output}`).not.toContain(stale.headSha.slice(0, 7))

    // ② 陈旧程度 —— 基准提交自己的日期,以及比较窗口因此有多宽(过报的量)。
    expect(run.output, `基准有多旧没出现在输出里:\n${run.output}`).toContain(stale.baselineDay)
    expect(reportedWindow(run.output), `报出来的窗口宽度不是这棵树的真实值:\n${run.output}`).toBe(3)

    // ── 控制组:同一形状、只把陈旧程度换掉,报出来的数必须跟着变 ────────────────────
    // 上面三条,一个「印一句写死的年龄」的实现也能满足(只要那句话碰巧写着这棵树的数)。
    const barely = degradedFixture(1)
    const run2 = runGuard(barely.work)
    expect(run2.output, `控制组里报的仍是另一棵树的基准 sha —— 这个值是写死的:\n${run2.output}`).toContain(
      barely.baselineSha.slice(0, 7),
    )
    expect(reportedWindow(run2.output), `窗口宽度不随树变 —— 它是个常量:\n${run2.output}`).toBe(1)
    expect(run2.output, `基准日期不随树变 —— 它是个常量:\n${run2.output}`).not.toContain(barely.staleDay)
    expect(run2.output, `控制组里读不到它自己那个基准的日期:\n${run2.output}`).toContain(barely.baselineDay)
  })

  test("fetch 正常 ⇒ 不出现降级上报(否则「无条件永远打印一句年龄」也能满足上一条)", () => {
    const { work } = forkFixture() // origin 是一个真路径 ⇒ 守卫的 fetch 会成功
    const run = runGuard(work)
    expect(run.exitCode, `干净分支被判红了:\n${run.output}`).toBe(0)
    const baseline = git(work, ["rev-parse", "origin/alpha"])
    expect(run.output, `fetch 明明成功,守卫却报告自己在用 last-known 基准:\n${run.output}`).not.toContain(
      baseline.slice(0, 7),
    )
    expect(() => reportedWindow(run.output), `fetch 成功的一跑里出现了降级基准上报:\n${run.output}`).toThrow()
  })

  test("降级仍然是一道**在跑**的门:陈旧基准下改上游文件依然红且点名", () => {
    const stale = degradedFixture(3)
    commit(stale.work, "touch an upstream file", { [UPSTREAM_FILE]: "export const leaf = 999\n" })
    const run = runGuard(stale.work)
    // 既有行为,`#913` 不许改:fetch 失败是降级、不是弃权。把降级改成直接 exit 1,这一条不会
    // 红(它本来就期望非零),红的是上面那条「干净运行仍然绿」—— 两条一起才钉住这个档位。
    expect(run.exitCode, `降级之后守卫放行了一次真实的上游改动:\n${run.output}`).not.toBe(0)
    expect(run.output, `降级之后守卫红了,却没点名被改的文件:\n${run.output}`).toContain(UPSTREAM_FILE)
    // 且必须**确实**走了降级路径,否则这一条测的是另一条路。
    expect(run.output, `这一跑没走降级路径,本条用例测的不是它要测的东西:\n${run.output}`).toContain(
      stale.baselineSha.slice(0, 7),
    )
  })
})
