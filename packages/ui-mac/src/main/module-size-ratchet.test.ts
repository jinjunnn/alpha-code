// `#1289` —— 模块体积棘轮 + 阈值告警的行为闸。
//
// 这道量守的是什么(大白话):桌面端主进程那一层现在有五万多行代码,其中两个文件分别 3,525
// 行和 2,825 行。文件越大,改一次的风险越高、审阅越难、写错越不容易被发现 —— 而今天**没有
// 任何东西**会在文件继续变大时提醒我们。这种债每次只多一点点,等到必须拆的时候,拆的成本
// 已经比当初拦住它贵很多倍。
//
// 被测对象是 scripts/assert-module-size.sh(alpha-check 第 [14/14] 步跑的就是它)。
//
// 为什么判据必须长这样:
//   · **反向用例是本票的退出条件之一**:把一个登记文件加长到超基线,闸**必须响**并点名。
//     只断言「今天绿」是没有意义的 —— 一个 `exit 0` 的实现每天都绿。
//   · **每条都带控制组**:响了之后把树改回去必须不响,否则「恒响」也能满足反向用例。
//   · **目录那一行单独有用例**:只钉单文件的话,把行搬进一个**新文件**就能让 file 行全绿,
//     而这一层的总量一点没少 —— 那正是本票要治的形态,所以它必须有自己的反向用例。
//   · **登记簿坏了必须红**,不能静默绿:一个读不出登记簿于是什么都不报的实现,在退出码上与
//     真绿一模一样。
//
// 删掉本文件会失去什么:棘轮退回零判据 —— 基线读错、目录合计把测试文件也数进去、阈值那一半
// 对「本次没改过的老大文件」乱报、登记簿被清空后静默通过,都不会有任何东西变红。

import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, test } from "bun:test"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..")
const SCRIPT_REL = "scripts/assert-module-size.sh"
const GUARD_REL = "scripts/north-star-guard.sh"
const MANIFEST_REL = "scripts/module-size-ratchet.tsv"
const PRODUCTION_MANIFEST = readFileSync(resolve(REPO_ROOT, "scripts/module-size-ratchet.tsv"), "utf8")

const GIT_ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "alpha ci fixture",
  GIT_AUTHOR_EMAIL: "fixture@alpha.invalid",
  GIT_COMMITTER_NAME: "alpha ci fixture",
  GIT_COMMITTER_EMAIL: "fixture@alpha.invalid",
} as const

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: { ...GIT_ENV } })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} 失败:${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

function write(repo: string, files: Record<string, string>) {
  for (const [path, body] of Object.entries(files)) {
    Bun.spawnSync(["mkdir", "-p", join(repo, path, "..")], { env: { ...GIT_ENV } })
    writeFileSync(join(repo, path), body)
  }
}

/** N 行内容(每行一个可读的标记,便于失败时看清是谁)。 */
function lines(n: number, tag: string): string {
  return `${Array.from({ length: n }, (_, i) => `// ${tag} ${i + 1}`).join("\n")}\n`
}

const PINNED_A = "packages/ui-mac/src/main/pinned-a.ts"
const PINNED_B = "packages/ui-mac/src/main/pinned-b.ts"
const MAIN_TREE = "packages/ui-mac/src/main"
const PINNED_A_LINES = 5
const PINNED_B_LINES = 7
const TREE_LINES = PINNED_A_LINES + PINNED_B_LINES

/** 登记簿里那条**不该**被数进目录合计的测试文件(排除口径:*.test.* / *.cases.ts / *.spec.*)。 */
const TREE_TEST_FILE = "packages/ui-mac/src/main/huge-fixture.test.ts"
/** 已存在很久、本分支**没碰**的大文件:阈值那一半不该点它的名。 */
const UNTOUCHED_BIG = "packages/ui-mac/src/renderer/legacy-big.ts"
/** 本分支新增的大文件:阈值那一半必须点它的名。 */
const NEW_BIG = "packages/ui-mac/src/renderer/brand-new-big.ts"

function manifest(rows: Array<[string, string, string, string]>): string {
  return `# 夹具登记簿\n${rows.map((r) => r.join("\t")).join("\n")}\n`
}

const DEFAULT_ROWS: Array<[string, string, string, string]> = [
  [String(PINNED_A_LINES), "file", PINNED_A, "夹具:被点名的单文件之一"],
  [String(PINNED_B_LINES), "file", PINNED_B, "夹具:被点名的单文件之二"],
  [String(TREE_LINES), "tree", MAIN_TREE, "夹具:目录合计 —— 挡住「把行搬进新文件」那条路"],
]

/**
 * 夹具形状:origin 上一个 `alpha` 分支作为比较基准,work 里从它切出 `feature`。
 * 阈值那一半要的正是「本分支相对 origin/alpha 改了哪些文件」,所以基准必须真的存在。
 */
function fixture(rows: Array<[string, string, string, string]> = DEFAULT_ROWS) {
  const origin = mkdtempSync(join(tmpdir(), "alpha-modsize-origin-"))
  git(origin, ["init", "-q", "-b", "alpha"])
  write(origin, {
    [PINNED_A]: lines(PINNED_A_LINES, "a"),
    [PINNED_B]: lines(PINNED_B_LINES, "b"),
    [TREE_TEST_FILE]: lines(1200, "t"),
    [UNTOUCHED_BIG]: lines(900, "legacy"),
  })
  git(origin, ["add", "-A"])
  git(origin, ["commit", "-q", "-m", "seed"])

  const work = mkdtempSync(join(tmpdir(), "alpha-modsize-work-"))
  const cloned = Bun.spawnSync(["git", "clone", "-q", origin, work], { env: { ...GIT_ENV } })
  if (cloned.exitCode !== 0) throw new Error(`git clone 失败:${cloned.stderr.toString()}`)
  git(work, ["checkout", "-q", "-b", "feature", "origin/alpha"])
  Bun.spawnSync(["mkdir", "-p", join(work, "scripts")], { env: { ...GIT_ENV } })
  copyFileSync(resolve(REPO_ROOT, SCRIPT_REL), join(work, SCRIPT_REL))
  copyFileSync(resolve(REPO_ROOT, GUARD_REL), join(work, GUARD_REL))
  writeFileSync(join(work, MANIFEST_REL), manifest(rows))
  return { origin, work }
}

type Run = { exitCode: number; output: string }

function run(repo: string): Run {
  const result = Bun.spawnSync(["bash", join(repo, SCRIPT_REL)], { cwd: repo, env: { ...GIT_ENV } })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (output.trim().length === 0) throw new Error("体积闸一个字都没输出 —— 本次测量作废(不是通过)")
  return { exitCode: result.exitCode, output }
}

describe("#1289 模块体积棘轮:基线内 / 超基线", () => {
  test("三行登记全部等于实测 ⇒ exit 0,并逐条打出实测与基线", () => {
    const { work } = fixture()
    const r = run(work)
    expect(r.exitCode, `全部在基线内却非零退出:\n${r.output}`).toBe(0)
    expect(r.output).toContain(`${PINNED_A} ${PINNED_A_LINES} 行`)
    expect(r.output).toContain(`${PINNED_B} ${PINNED_B_LINES} 行`)
    expect(r.output).toContain(`${MAIN_TREE} ${TREE_LINES} 行`)
  })

  test("反向用例:把一个登记文件加长到超基线 ⇒ 闸响、点名、报出实测/基线/差值", () => {
    const { work } = fixture()
    write(work, { [PINNED_A]: lines(PINNED_A_LINES + 3, "a") })
    const r = run(work)
    expect(r.exitCode, `加长到超基线之后闸没响:\n${r.output}`).toBe(2)
    // 只断退出码不够:一个「永远响」的实现也满足它,而且人拿不到可操作的信息。
    expect(r.output).toContain(`超基线:${PINNED_A} 实测 ${PINNED_A_LINES + 3} 行 > 基线 ${PINNED_A_LINES}(+3)`)
    // 响了要说清怎么办 —— 否则下一个人的默认动作是无视它。
    expect(r.output).toContain("scripts/module-size-ratchet.tsv")
    expect(r.output).toContain("票面")
  })

  test("控制组:同一棵树把它改回基线内 ⇒ 不响(否则「恒响」也能满足上一条)", () => {
    const { work } = fixture()
    write(work, { [PINNED_A]: lines(PINNED_A_LINES + 3, "a") })
    expect(run(work).exitCode).toBe(2)
    write(work, { [PINNED_A]: lines(PINNED_A_LINES, "a") })
    const r = run(work)
    expect(r.exitCode, `改回基线之后仍在响 —— 那是恒响门:\n${r.output}`).toBe(0)
  })

  test("低于基线 ⇒ 不响,但提示「可收紧至 N」(棘轮只许降,收紧靠人手改那一行)", () => {
    const { work } = fixture()
    write(work, { [PINNED_B]: lines(PINNED_B_LINES - 2, "b") })
    const r = run(work)
    expect(r.exitCode, `变小了却响了:\n${r.output}`).toBe(0)
    expect(r.output).toContain(`可收紧:${PINNED_B} 实测 ${PINNED_B_LINES - 2} 行 < 基线 ${PINNED_B_LINES}`)
  })
})

describe("#1289 模块体积棘轮:目录合计那一行", () => {
  test("把行搬进一个**新文件** ⇒ 两条 file 行全绿,而目录合计必须响", () => {
    const { work } = fixture()
    write(work, { "packages/ui-mac/src/main/brand-new-leaf.ts": lines(4, "n") })
    const r = run(work)
    expect(r.exitCode, `新增文件把这一层撑大了,目录行却没响:\n${r.output}`).toBe(2)
    expect(r.output).toContain(`超基线:${MAIN_TREE} 实测 ${TREE_LINES + 4} 行 > 基线 ${TREE_LINES}`)
    // 两条 file 行必须仍然是等号 —— 否则这条用例证明不了「只钉单文件会漏」。
    expect(r.output).toContain(`${PINNED_A} ${PINNED_A_LINES} 行`)
    expect(r.output).toContain(`${PINNED_B} ${PINNED_B_LINES} 行`)
  })

  test("目录合计不数测试文件(夹具里那个 1200 行的测试文件若被数进来,基线当场崩)", () => {
    const { work } = fixture()
    const r = run(work)
    expect(r.exitCode, `目录合计把测试文件也数进来了:\n${r.output}`).toBe(0)
    expect(r.output).toContain(`${MAIN_TREE} ${TREE_LINES} 行`)
  })
})

describe("#1289 阈值告警:只管本次改动", () => {
  test("本分支新增的大文件 ⇒ 点名并要求票面写理由", () => {
    const { work } = fixture()
    write(work, { [NEW_BIG]: lines(900, "big") })
    const r = run(work)
    expect(r.exitCode, `本次新增了 900 行的文件却没告警:\n${r.output}`).toBe(2)
    expect(r.output).toContain(`超阈值:${NEW_BIG} 900 行 > 800`)
    expect(r.output).toContain("票面")
  })

  test("控制组:本分支**没碰**的老大文件不告警(否则每个 PR 都在为别人的债刷屏)", () => {
    const { work } = fixture()
    const r = run(work)
    expect(r.exitCode, `没改过任何东西却告警了:\n${r.output}`).toBe(0)
    expect(r.output, "点了一个本分支没碰过的文件的名 —— 阈值那一半的窗口写错了").not.toContain(UNTOUCHED_BIG)
  })

  test("改动的**测试文件**再长也不告警(与票面「非测试 TS」的口径同一条)", () => {
    const { work } = fixture()
    write(work, { [TREE_TEST_FILE]: lines(1300, "t") })
    const r = run(work)
    expect(r.exitCode, `改了个测试文件就告警:\n${r.output}`).toBe(0)
    expect(r.output).not.toContain(TREE_TEST_FILE)
  })
})

describe("#1289 登记簿坏了必须红,不许静默绿", () => {
  test("登记的文件不存在 ⇒ exit 1(登记簿在骗人)", () => {
    const { work } = fixture()
    rmSync(join(work, PINNED_A))
    const r = run(work)
    expect(r.exitCode, `登记了一个不存在的文件却过了:\n${r.output}`).toBe(1)
    expect(r.output).toContain(PINNED_A)
  })

  test("基线非数字 / 路径重复 / 登记簿被清空 ⇒ 都是 exit 1", () => {
    const bad = run(fixture([["很多", "file", PINNED_A, "夹具"], ...DEFAULT_ROWS.slice(1)]).work)
    expect(bad.exitCode, `基线非数字却过了:\n${bad.output}`).toBe(1)

    const dup = run(fixture([...DEFAULT_ROWS, [String(PINNED_A_LINES), "file", PINNED_A, "夹具:重复行"]]).work)
    expect(dup.exitCode, `重复路径却过了:\n${dup.output}`).toBe(1)

    const empty = run(fixture([]).work)
    expect(empty.exitCode, `空登记簿却过了 —— 那正是「闸门被清空后静默通过」:\n${empty.output}`).toBe(1)
    expect(empty.output).toContain("登记簿被清空或解析失败")
  })

  test("kind 只认 file / tree,写歪不静默退化成普通行", () => {
    const r = run(fixture([["5", "directory", MAIN_TREE, "夹具"], ...DEFAULT_ROWS.slice(1)]).work)
    expect(r.exitCode, `未知 kind 被静默放行:\n${r.output}`).toBe(1)
    expect(r.output).toContain("kind 只能是 file 或 tree")
  })
})

describe("#1289 生产登记簿本身", () => {
  test("票面点名的两个文件与那一层目录都在册,且每行四列合法", () => {
    const rows = PRODUCTION_MANIFEST.split("\n")
      .filter((line) => line.trim() && !line.trimStart().startsWith("#"))
      .map((line) => line.split("\t"))
    // 解析自检:解析退化成空会让下面每条断言空对空地绿。
    expect(rows.length, "生产登记簿一行都没解析到 —— 本次测量作废").toBeGreaterThanOrEqual(3)
    for (const row of rows) {
      expect(row.length, `这一行不是四列:${row.join(" / ")}`).toBe(4)
      expect(/^\d+$/.test(row[0]!), `基线不是数字:${row[0]}`).toBe(true)
      expect(["file", "tree"], `kind 非法:${row[1]}`).toContain(row[1]!)
      expect(row[3]!.trim().length, `${row[2]} 没写为什么点名它`).toBeGreaterThan(20)
    }
    const targets = rows.map((row) => row[2])
    expect(targets).toContain("packages/ui-mac/src/main/ext-install-planner.ts")
    expect(targets).toContain("packages/ui-mac/src/main/ext-transaction.ts")
    expect(targets).toContain("packages/ui-mac/src/main")
  })
})
