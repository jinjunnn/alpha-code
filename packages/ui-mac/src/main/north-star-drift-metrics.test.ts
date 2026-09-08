// `#1288` —— north-star **漂移度量**的行为闸。
//
// 这道量守的是什么(大白话):我们给自己定的规矩是「尽量不改上游的代码」,而今天用来检查这条
// 规矩的守卫只回答一个问题 ——「你这次改动有没有**新增**偏离」。它不回答「我们现在总共偏离了
// 多少」,也不回答「上一次跟上游对齐是多久以前」。于是偏离可以一点一点长大,而永远不触发任何
// 提示;账在某一次 sync 时一次性付(2026-08 那次积到四周 / 375 个提交)。
//
// 被测对象是 scripts/north-star-drift-metrics.sh(alpha-check 第 [13/14] 步跑的就是它)。
//
// 为什么判据必须长这样:
//   · **不断言脚本源码文本。** 「grep 到脚本里写着 merge-base」在本仓是点名过的假闸门形态 ——
//     整段被注释掉时它照样绿。这里起**真的 git 仓**、造**已知大小的漂移**与**钉死年龄的
//     merge-base**、跑**生产的那份脚本**,断言三个量各自**跟着树变**。
//   · **每个量都带一个杀「印一个写死的数」的控制组。** 只断言「打印了 48」是不够的:一个
//     `echo 48` 的实现也满足它。所以收编面那条把守卫复制一份、只删掉三条白名单,断言数字
//     跟着减三;年龄那条跑两棵年龄不同的树,断言差值精确。
//   · **测不到必须说测不到。** 上游镜像取不到时脚本要打「未测量」并 exit 2 —— 给一个 0 会被
//     读成「零漂移」,那正是本票要消灭的形态。
//
// 删掉本文件会失去什么:三个量退回零判据 —— 辖区换错、白名单长度写死、`--diff-filter` 写成
// 包含新增文件、carve-out 漏掉、年龄算成常数,都不会有任何东西变红,而那一屏数字看起来照常。

import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, test } from "bun:test"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..")
const METRICS_REL = "scripts/north-star-drift-metrics.sh"
const GUARD_REL = "scripts/north-star-guard.sh"
const GUARD_SOURCE = readFileSync(resolve(REPO_ROOT, "scripts/north-star-guard.sh"), "utf8")

/** 与守卫的行为闸同源的理由:开发机 ~/.gitconfig 不许影响判据,本测试也不许写到本仓的 .git。 */
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

function commit(repo: string, message: string, files: Record<string, string>, extraEnv: Record<string, string> = {}) {
  write(repo, files)
  git(repo, ["add", "-A"], extraEnv)
  git(repo, ["commit", "-q", "-m", message], extraEnv)
}

/**
 * 把一次提交钉在「距今整 N 天再多一小时」那一刻。
 *
 * 为什么不用「N 天前那个**日期**的 UTC 正午」:年龄是 `floor((now − commit) / 86400)`,而正午
 * 那种钉法下,本机时钟走到 UTC 12:00 之前算出来是 N−1、之后是 N —— 一条**按当天几点跑而翻红**
 * 的断言。多钉一小时之后,floor 恒等于 N(只要这一跑不超过一小时)。
 */
function ageEnv(days: number): Record<string, string> {
  const epoch = Math.floor(Date.now() / 1000) - days * 86_400 - 3_600
  return { GIT_AUTHOR_DATE: `@${epoch} +0000`, GIT_COMMITTER_DATE: `@${epoch} +0000` }
}

/** 上游包下的普通文件 —— 不在 ADR-033 白名单里。 */
const UPSTREAM_FILE = "packages/core/src/upstream-leaf.ts"
/** ADR-033 白名单里的**被接管**文件:守卫按设计放行它,而度量必须照样把它算进去。 */
const ADOPTED_FILE = "packages/core/src/permission.ts"
/** 上游路径下、alpha 这一侧**新增**的文件:`--diff-filter=DMR` 结构上不该点名它。 */
const ADDED_FILE = "packages/core/src/brand-new-alpha-leaf.ts"
/** carve-out ①:alpha 自有包。 */
const ALPHA_PKG_FILE = "packages/ui-mac/src/main/alpha-owned.ts"
const EXT_PKG_FILE = "packages/ext/src/alpha-ext-leaf.ts"
/** carve-out ②:ADR-034 roundtrip 包。 */
const ROUNDTRIP_FILE = "packages/app/src/frontend-leaf.ts"

/** 夹具里那次**已知大小**的上游漂移:两个文件、+2 增、−1 删。 */
const EXPECTED_DRIFT_FILES = 2
const EXPECTED_ADDED = 2
const EXPECTED_DELETED = 1

/**
 * 夹具形状:
 *
 *   seed(钉死年龄 = forkAgeDays)──► dev   (上游镜像继续前进)
 *      └────────────────────────► alpha  (alpha 侧的偏离都发生在这里)
 *
 * ⇒ merge-base(origin/dev, HEAD) 恒等于 seed,年龄由构造决定,不是从脚本输出反推的。
 */
function driftFixture(forkAgeDays: number) {
  const origin = mkdtempSync(join(tmpdir(), "alpha-drift-origin-"))
  git(origin, ["init", "-q", "-b", "alpha"])
  commit(
    origin,
    "seed",
    {
      [UPSTREAM_FILE]: "a\nb\nc\n",
      [ADOPTED_FILE]: "p1\np2\n",
      [ALPHA_PKG_FILE]: "alpha1\n",
      [EXT_PKG_FILE]: "ext1\n",
      [ROUNDTRIP_FILE]: "front1\n",
    },
    ageEnv(forkAgeDays),
  )
  git(origin, ["checkout", "-q", "-b", "dev"])
  commit(origin, "upstream mirror moves on", { "packages/core/src/dev-only.ts": "devOnly\n" }, ageEnv(forkAgeDays - 1))
  git(origin, ["checkout", "-q", "alpha"])
  commit(
    origin,
    "alpha drifts from upstream",
    {
      // ① 普通上游文件:3 行 → 5 行 ⇒ +2 / −0
      [UPSTREAM_FILE]: "a\nb\nc\nd\ne\n",
      // ② 白名单里的收编文件:2 行 → 1 行 ⇒ +0 / −1(守卫放行它,度量必须计入)
      [ADOPTED_FILE]: "p1\n",
      // ③ 新增文件:DMR 不该点名(否则 alpha 自己写的判据文件会被算成上游漂移)
      [ADDED_FILE]: "brand\nnew\nfile\n",
      // ④⑤⑥ 三张 carve-out:各改一行,都不该计入
      [ALPHA_PKG_FILE]: "alpha1\nalpha2\nalpha3\n",
      [EXT_PKG_FILE]: "ext1\next2\next3\n",
      [ROUNDTRIP_FILE]: "front1\nfront2\nfront3\n",
    },
    ageEnv(0),
  )

  const work = mkdtempSync(join(tmpdir(), "alpha-drift-work-"))
  const cloned = Bun.spawnSync(["git", "clone", "-q", origin, work], { env: { ...GIT_ENV } })
  if (cloned.exitCode !== 0) throw new Error(`git clone 失败:${cloned.stderr.toString()}`)
  git(work, ["checkout", "-q", "-b", "feature", "origin/alpha"])
  Bun.spawnSync(["mkdir", "-p", join(work, "scripts")], { env: { ...GIT_ENV } })
  copyFileSync(resolve(REPO_ROOT, METRICS_REL), join(work, METRICS_REL))
  copyFileSync(resolve(REPO_ROOT, GUARD_REL), join(work, GUARD_REL))
  return { origin, work }
}

type Run = { exitCode: number; output: string }

function runMetrics(repo: string): Run {
  const result = Bun.spawnSync(["bash", join(repo, METRICS_REL)], { cwd: repo, env: { ...GIT_ENV } })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  // 一个字都不打印的运行不是「通过」——「空输出 / 零命中」在本仓是点名过的假绿形态。
  if (output.trim().length === 0) throw new Error("度量脚本一个字都没输出 —— 本次测量作废(不是通过)")
  return { exitCode: result.exitCode, output }
}

/** 从输出里**读出**三个量。读不出就抛「本次测量作废」,而不是返回 0(沉默的 0 会被读成零漂移)。 */
function readNumber(output: string, pattern: RegExp, what: string): number {
  const found = pattern.exec(output)
  if (!found) throw new Error(`度量输出里读不出${what} —— 本次测量作废:\n${output}`)
  return Number(found[1])
}

const ADOPTION = /① 收编面(?:[^\n]*?):(\d+) 条/
// 刻意不把全角括号写进 pattern:输出里是 `(2 增 / 1 删)`,ASCII `(` 在这里对不上,而对不上
// 时上面的 readNumber 会抛「测量作废」——那正是它存在的理由,但没必要天天演一遍。
const DRIFT_FILES = /② 上游漂移:(\d+) 个文件 \/ (\d+) 行\D*?(\d+) 增 \/ (\d+) 删/
const AGE = /③ merge-base 年龄:(\d+) 天/

/** 生产守卫里的收编白名单条目数 —— 与脚本自己数出来的 `${#UPSTREAM_EXCLUDES[@]}` 是两条独立轴。 */
function whitelistEntriesFromGuardSource(source: string): number {
  const block = /^UPSTREAM_EXCLUDES=\(\n([\s\S]*?)^\)$/m.exec(source)
  if (!block) throw new Error("守卫脚本里找不到 UPSTREAM_EXCLUDES=( … ) —— 本次测量作废")
  return [...block[1].matchAll(/'([^']+)'/g)].length
}

describe("#1288 north-star 漂移度量:① 收编面", () => {
  test("打印的收编面条数 == 守卫白名单里真实的条目数(两条独立的解析轴)", () => {
    const { work } = driftFixture(40)
    const run = runMetrics(work)
    expect(run.exitCode, `度量脚本非零退出:\n${run.output}`).toBe(0)
    const expected = whitelistEntriesFromGuardSource(GUARD_SOURCE)
    // 解析自检:一份解析退化成 0 的正则会让下面那条断言空对空地绿。
    expect(expected, "守卫白名单解析退化成空 —— 本次测量作废").toBeGreaterThanOrEqual(20)
    expect(readNumber(run.output, ADOPTION, "收编面条数")).toBe(expected)
  })

  test("控制组:守卫少三条白名单 ⇒ 打印的条数跟着少三(杀掉「印一个写死的数」)", () => {
    const { work } = driftFixture(40)
    const full = readNumber(runMetrics(work).output, ADOPTION, "收编面条数")

    // 只动**复制品**:删掉白名单数组里的前三条 `':(exclude)…'` 行。
    const guardPath = join(work, GUARD_REL)
    const lines = readFileSync(guardPath, "utf8").split("\n")
    let removed = 0
    const trimmed = lines.filter((line) => {
      if (removed < 3 && /^\s+':\(exclude\)/.test(line)) {
        removed += 1
        return false
      }
      return true
    })
    expect(removed, "夹具没能从守卫复制品里删掉三条白名单 —— 本次测量作废").toBe(3)
    writeFileSync(guardPath, trimmed.join("\n"))

    expect(readNumber(runMetrics(work).output, ADOPTION, "收编面条数")).toBe(full - 3)
  })
})

describe("#1288 north-star 漂移度量:② 上游漂移", () => {
  test("已知大小的上游漂移被逐字量出来(文件数 / 增 / 删)", () => {
    const { work } = driftFixture(40)
    const run = runMetrics(work)
    const found = DRIFT_FILES.exec(run.output)
    if (!found) throw new Error(`读不出上游漂移 —— 本次测量作废:\n${run.output}`)
    expect(
      { files: Number(found[1]), lines: Number(found[2]), added: Number(found[3]), deleted: Number(found[4]) },
      `夹具造的是 ${EXPECTED_DRIFT_FILES} 个文件 / +${EXPECTED_ADDED} / -${EXPECTED_DELETED}:\n${run.output}`,
    ).toEqual({
      files: EXPECTED_DRIFT_FILES,
      lines: EXPECTED_ADDED + EXPECTED_DELETED,
      added: EXPECTED_ADDED,
      deleted: EXPECTED_DELETED,
    })
  })

  test("白名单里的收编文件**照样计入**(守卫放行它,是判决,不是「不存在」)", () => {
    // 夹具改的那个文件必须真的在生产白名单里,否则上面那条只是碰巧数对了。
    const block = /^UPSTREAM_EXCLUDES=\(\n([\s\S]*?)^\)$/m.exec(GUARD_SOURCE)
    const entries = [...(block?.[1] ?? "").matchAll(/':\(exclude\)([^']+)'/g)].map((m) => m[1])
    expect(entries, "白名单解析退化 —— 本次测量作废").toContain(ADOPTED_FILE)

    const { work } = driftFixture(40)
    const run = runMetrics(work)
    // 两个文件里有一个正是那条收编文件 ⇒ 排除白名单的实现只会数到 1。
    expect(readNumber(run.output, /② 上游漂移:(\d+) 个文件/, "漂移文件数")).toBe(EXPECTED_DRIFT_FILES)
  })

  test("控制组:抹掉守卫的 carve-out ⇒ 数字变大(证明夹具里真有 carve-out 改动,不是空对空地绿)", () => {
    const { work } = driftFixture(40)
    const before = readNumber(runMetrics(work).output, /② 上游漂移:(\d+) 个文件/, "漂移文件数")

    const guardPath = join(work, GUARD_REL)
    const patched = readFileSync(guardPath, "utf8")
      .replace(/^ALPHA_OWNED_PACKAGES="[^"]+"/m, 'ALPHA_OWNED_PACKAGES="carveout-gone"')
      .replace(/^ROUNDTRIP_PACKAGES="[^"]+"/m, 'ROUNDTRIP_PACKAGES="roundtrip-gone"')
    writeFileSync(guardPath, patched)

    const after = readNumber(runMetrics(work).output, /② 上游漂移:(\d+) 个文件/, "漂移文件数")
    // 三张 carve-out 各一个被改的文件 ⇒ 抹掉之后正好多三个。
    expect(after, "抹掉 carve-out 之后数字没变 —— 要么夹具没造 carve-out 改动,要么度量根本没用辖区").toBe(before + 3)
  })

  test("上游路径下**新增**的文件不算漂移(`--diff-filter=DMR` 的明写边界)", () => {
    const { work } = driftFixture(40)
    const run = runMetrics(work)
    // 夹具里那个新增文件有 3 行:算进去的话行数会从 3 变成 6。
    expect(readNumber(run.output, /② 上游漂移:\d+ 个文件 \/ (\d+) 行/, "漂移行数")).toBe(EXPECTED_ADDED + EXPECTED_DELETED)
  })
})

describe("#1288 north-star 漂移度量:③ merge-base 年龄", () => {
  test("年龄 == 夹具钉死的天数,且换一棵树数字跟着变(杀掉「印一个常数」)", () => {
    const old = runMetrics(driftFixture(40).work)
    const fresh = runMetrics(driftFixture(10).work)
    expect(readNumber(old.output, AGE, "merge-base 年龄")).toBe(40)
    expect(readNumber(fresh.output, AGE, "merge-base 年龄")).toBe(10)
  })
})

describe("#1288 north-star 漂移度量:测不到就说测不到", () => {
  test("上游镜像取不到 ⇒ exit 2 且明说「未测量」,**不打印 0**", () => {
    const { work } = driftFixture(40)
    git(work, ["update-ref", "-d", "refs/remotes/origin/dev"])
    const run = runMetrics(work)
    expect(run.exitCode, `镜像缺失时应判「未测量」(exit 2),实得 ${run.exitCode}:\n${run.output}`).toBe(2)
    expect(run.output).toContain("未测量")
    // 关键的一半:不许给数字。给 0 会被读成「零漂移」,而那正是本票要消灭的形态。
    expect(run.output, "镜像缺失时仍打印了漂移数字 —— 那是编出来的").not.toContain("② 上游漂移:")
    expect(run.output, "镜像缺失时仍打印了年龄 —— 那是编出来的").not.toContain("③ merge-base 年龄:")
    // ① 与镜像无关,它必须照常打(否则「未测量」会把能量的也一起吞掉)。
    expect(run.output).toContain("① 收编面")
  })

  test("守卫脚本不见了 ⇒ 判「度量作废」并非零退出,不静默报零漂移", () => {
    const { work } = driftFixture(40)
    writeFileSync(join(work, GUARD_REL), "#!/usr/bin/env bash\nexit 9\n")
    const run = runMetrics(work)
    expect(run.exitCode, `守卫坏掉时度量必须作废:\n${run.output}`).toBe(1)
    expect(run.output).toContain("作废")
  })
})
