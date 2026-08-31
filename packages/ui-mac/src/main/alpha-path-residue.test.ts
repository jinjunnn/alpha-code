// `#1206` —— `.alpha` 路径残留的**双向**闸:扫描面与登记表必须互为子集。
//
// 为什么存在:`#1202` 用**手工枚举**列了 13 处注释,而实测是 91 处(46 代码行 + 45 注释行)。
// 漏掉的 78 处不会被任何东西发现 —— 散文清单不会自己长出来。本文件把判据换成一个会自己
// 长出来的形态:任何人新写一处 `.alpha`,门当场红并指着他;任何一处残留被清掉而登记表没跟着
// 删,门同样红。
//
// **必须是双向的。** 只判「扫描命中都在表里」会让表变成僵尸:某处 `.alpha` 被删了而表项还在,
// 门照样绿,而那一行从此是关于一个不存在的地方的说明。两个方向各有一次变异自证(见 `#1206`
// 的 PR 正文)。
//
// ── 这道闸**确切**守住什么 ────────────────────────────────────────────────────────────
//
// 守住:`git ls-files`(已跟踪 + 未被 .gitignore 忽略的新文件)列出的、路径匹配
//       `packages/**/src/**` 的**每一个文件**(不限扩展名 —— 33 处 `vnd.alpha.*` 就住在
//       `.json` 里),排除 `*.test.ts` / `*.cases.ts` / `*.spec.ts`。
//
// 守不住(明说,别当成它守住了):
//   · **写法层面**:把 `.alpha` 拆成字符串拼接、写进 base64、写进二进制资产 —— 都绕得过。
//     它挡的是现实中唯一见过的形态:有人照着旧世界的名字写下 `.alpha`。这是减速带,不是安全边界。
//   · **范围层面**:`docs/` 与 ADR、`packages/ui-mac/resources/`、`scripts/`、测试文件本身。
//     那些是各自独立的事(`#1206` out-of-scope 明列)。
//   · **语义层面**:它只判「这一处在不在表里」,不判「表里那句理由对不对」。理由是给人读的。
//
// 行号会随该文件上方增删行而失效 —— 那正是本表想让你重新过一遍分类的时刻。**不要只把数字
// 改对**:先确认那一处 `.alpha` 今天仍然该留着,再改行号。
//
// 登记表:scripts/alpha-path-residue.tsv(`文件 ⇥ 行号 ⇥ 类别 ⇥ 理由`)。

import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, test } from "bun:test"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..")
const REGISTRY = "scripts/alpha-path-residue.tsv"

/**
 * `.alpha` 后面不接 `-` / 字母 / 数字 / `_`,借此排除 `.alpha-code`、`.alphanumeric` 这类
 * 更长的标识符。与 `#1206` 票面枚举用的那条正则逐字同形(那份枚举是本表的地面真相)。
 */
const RESIDUE = /\.alpha([^-a-zA-Z0-9_]|$)/

/** 类别固定枚举。新增类别要连同本文件与 TSV 抬头一起改 —— 加类别是决定,不是记账。 */
const CATEGORIES = new Set(["media-type", "retired-guard", "historical", "signed-snapshot", "provider-id"])

/** 扫描面:`packages/**\/src/**`,排除测试文件。不限扩展名 —— 媒体类型住在 .json 里。 */
const IN_SCOPE = /^packages\/.*\/src\//
const IS_TEST = /\.(test|cases|spec)\.(ts|tsx)$/

/** 枚举交给 git,不手写 walker(手写 walker 漏掉嵌套 workspace 是本仓踩过的,见 stream-read-hygiene)。 */
function gitListed(): string[] {
  const result = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard"], { cwd: REPO_ROOT })
  if (result.exitCode !== 0)
    throw new Error(
      `git ls-files 失败(exit ${result.exitCode}):${result.stderr.toString()} —— 闸门不得在枚举失败时静默放行`,
    )
  return [...new Set(result.stdout.toString().split("\n").filter(Boolean))]
}

const ALL_LISTED = gitListed()
const SCANNED = ALL_LISTED.filter((path) => IN_SCOPE.test(path) && !IS_TEST.test(path))

type Hit = { path: string; line: number; text: string }

function scan(): Hit[] {
  const hits: Hit[] = []
  for (const path of SCANNED) {
    let body: string
    try {
      body = readFileSync(join(REPO_ROOT, path), "utf8")
    } catch {
      continue // 目录项 / 竞态删除:枚举本身的可信度由上面的 exitCode 与下面的规模断言罩着
    }
    const lines = body.split("\n")
    for (let i = 0; i < lines.length; i++) if (RESIDUE.test(lines[i]!)) hits.push({ path, line: i + 1, text: lines[i]! })
  }
  return hits
}

const HITS = scan()
const HIT_KEYS = new Set(HITS.map((h) => `${h.path}:${h.line}`))

type Row = { path: string; line: number; category: string; reason: string; raw: string; n: number }

function registry(): Row[] {
  const text = readFileSync(join(REPO_ROOT, REGISTRY), "utf8")
  const rows: Row[] = []
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    if (!raw || raw.startsWith("#")) continue
    const parts = raw.split("\t")
    if (parts.length !== 4) throw new Error(`${REGISTRY}:${i + 1} 不是四列(文件⇥行号⇥类别⇥理由):${raw}`)
    const [path, line, category, reason] = parts as [string, string, string, string]
    if (!/^[0-9]+$/.test(line)) throw new Error(`${REGISTRY}:${i + 1} 行号不是数字:${raw}`)
    rows.push({ path, line: Number(line), category, reason, raw, n: i + 1 })
  }
  return rows
}

const ROWS = registry()
const ROW_KEYS = new Set(ROWS.map((r) => `${r.path}:${r.line}`))

describe("`.alpha` 残留登记表双向门 (#1206)", () => {
  // ── 覆盖面:先证明这个闸不是空的 ──────────────────────────────────────────
  // 「扫了 0 个文件 ⇒ 命中 0 处 ⇒ 两个方向都成立」是本类闸门最典型的假绿。

  test("枚举来自 git 且规模合理(枚举失败/近乎空集不得静默放行)", () => {
    expect(ALL_LISTED.length).toBeGreaterThan(2_000)
    expect(SCANNED.length).toBeGreaterThan(4_000)
    expect(SCANNED.some((path) => IS_TEST.test(path))).toBe(false)
    // 三个真的有残留的包都要进扫描面 —— 少一个,那个包上的禁令就恒真。
    for (const prefix of ["packages/ext/src/", "packages/ui-mac/src/main/", "packages/ui-mac/src/shared/"])
      expect(SCANNED.filter((path) => path.startsWith(prefix)).length, `${prefix} 一个文件都没扫到`).toBeGreaterThan(0)
    // 非 .ts 文件必须在扫描面里:33 处媒体类型全住在 .json 中。
    expect(SCANNED.some((path) => path.endsWith(".json"))).toBe(true)
  })

  test("扫描真的读到了内容(锚点文件在集合里且确实命中)", () => {
    // 两个独立包各取一个锚:一个是 retired-guard 代码行,一个是 media-type JSON 行。
    expect(HIT_KEYS.has("packages/ext/src/project-config.ts:30")).toBe(true)
    expect(
      HITS.some((h) => h.path.endsWith("host-extension-package.registry.v1.json") && h.text.includes("vnd.alpha.")),
    ).toBe(true)
  })

  test("检测器认得出违规写法、且不误伤新名字(自我变异)", () => {
    for (const positive of [
      '  // 写 <proj>/.alpha/runs/<runId>/',
      '  const retired = join(home, ".alpha")',
      '  mediaType: "application/vnd.alpha.remote-asset",',
      "// 尾部就是 .alpha",
    ])
      expect(RESIDUE.test(positive), `应命中却没命中:${positive}`).toBe(true)
    for (const negative of [
      "  // 写 <proj>/.code-puppy/runs/<runId>/",
      "  import { x } from '@alpha-code/ext'",
      "  // .alpha-code 是包名前缀,不是路径",
      "  // .alphanumeric",
      "  const alphaRoot = 1",
    ])
      expect(RESIDUE.test(negative), `不该命中却命中了:${negative}`).toBe(false)
  })

  // ── 登记表本身合形 ────────────────────────────────────────────────────────

  test("登记表非空、类别取自固定枚举、理由不得为空、无重复行", () => {
    expect(ROWS.length).toBeGreaterThan(0)
    for (const row of ROWS) {
      expect(CATEGORIES.has(row.category), `${REGISTRY}:${row.n} 类别 "${row.category}" 不在固定枚举里`).toBe(true)
      expect(row.reason.trim().length, `${REGISTRY}:${row.n} 理由为空或过短 —— 登记一处豁免要写清为什么`).toBeGreaterThan(7)
    }
    expect(ROW_KEYS.size, "登记表里有重复的 文件:行号").toBe(ROWS.length)
  })

  // ── 方向 A:扫描命中 ⊆ 登记表 ─────────────────────────────────────────────

  test("方向 A —— 每一处扫描命中都登记在册(新长出来的残留会被拦住)", () => {
    const unregistered = HITS.filter((h) => !ROW_KEYS.has(`${h.path}:${h.line}`)).map(
      (h) => `${h.path}:${h.line}: ${h.text.trim()}`,
    )
    expect(
      unregistered,
      [
        "这些位置写着 `.alpha`,但不在 " + REGISTRY + " 里。",
        "先问:它指的是**今天的项目根**吗?是 ⇒ 改成 `.code-puppy`(项目根已改名,`~/.alpha` 是退役根)。",
        "不是 ⇒ 登记进表,类别取自 media-type / retired-guard / historical / signed-snapshot / provider-id,",
        "并写清为什么它必须保持 `.alpha`。**不要为了让这道门变绿而登记** —— 表里每一行都要经得起读。",
      ].join("\n"),
    ).toEqual([])
  })

  // ── 方向 B:登记表 ⊆ 扫描命中 ─────────────────────────────────────────────

  test("方向 B —— 每一条登记都对应一处真实命中(表项失效后不会变成僵尸)", () => {
    const stale = ROWS.filter((r) => !HIT_KEYS.has(`${r.path}:${r.line}`)).map(
      (r) => `${REGISTRY}:${r.n} → ${r.path}:${r.line} [${r.category}]`,
    )
    expect(
      stale,
      [
        "这些登记项在源码里扫不到对应的 `.alpha`。",
        "常见成因:那一处已被清掉(⇒ 删掉这一行),或该文件上方增删了行导致行号漂移",
        "(⇒ 先确认那一处今天仍然该留着,再改行号 —— 不要只把数字改对)。",
        "单向的门会让这张表变成僵尸:残留没了而表项还在,门照样绿。这一条就是防它。",
      ].join("\n"),
    ).toEqual([])
  })
})
