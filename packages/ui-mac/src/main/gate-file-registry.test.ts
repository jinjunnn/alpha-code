// #647 —— 闸门文件登记簿的**完备性**闸。
//
// 背景(这一轮的教训,写下来免得再犯):#647 修完 `readBoundedBody` 之后,我们发现
// 「整套 suite 的地板抓不到删掉一个 N 条用例的文件」,于是给 ui-mac 的类级闸加了点名下界。
// 然后**只加了那一个** —— ext 的 REQ-062 drift lock(`prompt-rebrand.test.ts`,26 条)照旧
// 只被整包地板 100 罩着,而 ext 排除它还剩 106 条,删掉它 CI 静默全绿。
// 同一条规律,只应用了一次。这就是本文件存在的理由:**让「又冒出一个闸门文件却没登记」变成红灯**,
// 而不是靠下一个人记得。
//
// 本文件有**三层**检查,一层比一层不依赖措辞:
//
// ① 命名习惯(启发式)。仓库对闸门文件有稳定的命名词(ratchet / lock / anchors / contract /
//    copies / snapshot / drift / hygiene / rebrand / seam / coexistence / census)。命中即必须
//    要么登记在 `scripts/gate-files.tsv`,要么在 NOT_GATES 里写明为什么不是。
//
// ② 委派声明(权威,默认拒)。源码棘轮常把主判据交给别的测试文件 —— `route-authority-ratchet`
//    的抬头就白纸黑字写着「THE PRIMARY JUDGEMENT IS NOT IN THIS FILE」。删掉受托方,保证就没了,
//    而棘轮只守住「源码里有那段文字」——按本仓定义那是**假闸门**。因此登记簿有 `delegates_to`
//    一列:**每行都必须显式填**(没有委派写 `-`,留空即红),且**每个受托方必须也在登记簿里**。
//
// ③ 引用绊线(发现用,不是权威)。闸门文件正文里出现的**任何**其它测试文件,都必须已被分类
//    (已登记 / NOT_GATES / REFERENCED_BUT_UNREGISTERED 三选一)。这一层不去理解语义 ——
//    自然语言的委派说法太多(「真实判据见」「行为层闸门在」「移至」「由 X 断言」…),
//    按措辞枚举与按文件名枚举是**同一种缺陷**:说法不合的就隐形。所以它只做机械的事:
//    提到了就必须表态。这一层实际找出了 7 处一层和二层都没发现的委派关系。
//
// ⚠️ 诚实边界:
//   · ①命名不含那些词、且②③都没提到的闸门文件,本文件**检测不到**。登记簿因此仍是**显式**
//     清单,不是自动推导的结果 —— 新写闸门时该登记还是要登记。
//   · 它不判断登记的下界取得对不对,只判断「有没有被分类」。
//
// 保证本身(删掉本文件会失去什么):新增的闸门文件不再被强制分类,委派关系不再被强制闭合,
// 登记簿会随时间腐烂 —— 而登记簿腐烂时,没有任何别的东西会红。本文件自身也登记在
// `gate-files.tsv` 里,所以它不能被静默删掉。

import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, test } from "bun:test"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..")

/** 仓库给闸门文件用的命名词。命中即必须分类。 */
const GATE_NAME_TOKENS =
  /(ratchet|lock|anchors?|contract|copies|snapshot|drift|hygiene|rebrand|seam|coexistence|census)/i

/** 本 CI 五步真正会跑到的测试范围 —— 范围外的文件(如上游 opencode 测试)不归本闸管。 */
const IN_SCOPE = [
  "packages/alpha-contracts-consumer/src/",
  "packages/ext/src/",
  "packages/ui-mac/src/",
  "packages/opencode/test/tool/alpha-",
]

/**
 * 命中命名词、但**不是**闸门文件 —— 每条必须写明理由。
 * 判据:删掉它损失的是覆盖率(某个函数/组件少测了),而不是某条仓库级保证。
 */
const NOT_GATES: Record<string, string> = {
  "packages/ui-mac/src/main/ext-bundle-lock.test.ts":
    "REQ-100 bundle 锁的**功能**单测(互斥/争用/死 pid/心跳超时)。删掉是 bundle-lock 这个功能少测了,不是某条仓库级保证消失。",
  "packages/ui-mac/src/main/alpha-auth-clock.test.ts":
    "只是文件名里的 'clock' 撞上了 'lock'。内容是刷新时机的纯逻辑单测,与闸门无关。",
  "packages/ui-mac/src/renderer/alpha-ui/model-contract.test.ts":
    "`createModelContract` 这个函数的单测(输入→输出),不是钉住外部产物的契约锁。",
}

function gitListedTests(): string[] {
  const result = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard", "--", "*.ts", "*.tsx"], {
    cwd: REPO_ROOT,
  })
  if (result.exitCode !== 0) throw new Error(`git ls-files 失败:${result.stderr.toString()}`)
  return result.stdout
    .toString()
    .split("\n")
    .filter((path) => /\.(test|spec)\.tsx?$/.test(path))
}

type Row = { path: string; delegates: string[]; rawDelegates: string; fields: number }

/** 解析登记簿。五列:floor / workdir / path / delegates_to / guarantee。 */
function manifestRows(): Row[] {
  const body = readFileSync(join(REPO_ROOT, "scripts/gate-files.tsv"), "utf8")
  const rows: Row[] = []
  for (const line of body.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue
    const parts = line.split("\t")
    const [, workdir, path, delegates] = parts
    if (!workdir || !path) continue
    rows.push({
      path: `${workdir}/${path}`,
      rawDelegates: delegates ?? "",
      delegates: (delegates ?? "").trim() === "-" ? [] : (delegates ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      fields: parts.length,
    })
  }
  return rows
}

/**
 * 在闸门文件正文里出现、但**刻意不登记**的测试文件。每条必须写明理由。
 * 这是「发现绊线」的出口 —— 不是豁免后门:写在这里等于公开声明「这条保证今天没有 CI 在跑」。
 */
const REFERENCED_BUT_UNREGISTERED: Record<string, string> = {
  "packages/opencode/test/tool/alpha-mcp-websearch-gate.test.ts":
    "真委派(通用 Remote MCP 钳制点的证据),但 owner 明确指示不在本 PR 纳入 CI;纳入与否在 #649 评估(23s 耗时 + Bun.serve 超时告警需先定性)。",
  "packages/opencode/test/mcp/alpha-cloud-mcp-multisource.test.ts":
    "真委派(云 MCP 多源继承的真实 lifecycle 断言),纳入与否同样在 #649 评估。",
  "packages/opencode/test/mcp/alpha-cloud-mcp-revival.test.ts":
    "真委派(云 MCP 复活路径的真实 lifecycle 断言),纳入与否同样在 #649 评估。",
  "packages/core/test/tool-websearch.test.ts":
    "上游测试文件。alpha-websearch-sovereignty 的抬头只是说明自己的 harness 与它**同源**,不是把判据委派给它;packages/core 是上游包,该文件由 north-star 守卫保护。",
  "packages/opencode/test/tool/websearch.test.ts":
    "上游测试文件,不是 alpha 的闸门 —— alpha 刻意不接管它(见 alpha-ci.yml 的 ADR-035 注释),它由 north-star 守卫保护不被 alpha 改动。",
}

const ALL_TESTS = gitListedTests()
const ROWS = manifestRows()
const REGISTERED = ROWS.map((row) => row.path)
const IN_SCOPE_TESTS = ALL_TESTS.filter((path) => IN_SCOPE.some((prefix) => path.startsWith(prefix)))

/** 正文里出现的其它测试文件(发现用绊线)。解析成仓库相对路径。 */
const TEST_REF = /[\w./-]*[\w-]+\.test\.tsx?/g

function referencesOf(row: Row): string[] {
  const body = readFileSync(join(REPO_ROOT, row.path), "utf8")
  const own = row.path.split("/").pop()
  const found = new Set<string>()
  for (const raw of body.match(TEST_REF) ?? []) {
    const base = raw.split("/").pop()
    if (!base || base === own) continue
    // 先当仓库相对路径;不成立就按 basename 在全量测试清单里唯一解析。
    if (ALL_TESTS.includes(raw)) {
      found.add(raw)
      continue
    }
    const matches = ALL_TESTS.filter((path) => path.endsWith(`/${base}`))
    if (matches.length === 1) found.add(matches[0]!)
  }
  return [...found]
}

describe("闸门文件登记簿完备性 (#647)", () => {
  // ── 前提自检:枚举/解析坏掉时必须红,不能静默通过 ────────────────────────
  test("测试文件枚举与登记簿解析都不是空的", () => {
    expect(ALL_TESTS.length).toBeGreaterThan(150)
    expect(IN_SCOPE_TESTS.length).toBeGreaterThan(150)
    expect(REGISTERED.length).toBeGreaterThanOrEqual(15)
  })

  test("登记簿里的每个文件都真的存在(登记了一个已删的文件 = 登记簿在骗人)", () => {
    const missing = REGISTERED.filter((path) => !ALL_TESTS.includes(path))
    expect(missing, `登记簿指向不存在的测试文件:${missing.join(", ")}`).toEqual([])
  })

  test("NOT_GATES 里的每个文件都真的存在且真的命中命名词", () => {
    for (const path of Object.keys(NOT_GATES)) {
      expect(ALL_TESTS, `NOT_GATES 登记了不存在的文件:${path}`).toContain(path)
      expect(GATE_NAME_TOKENS.test(path), `${path} 并不命中命名词,不需要放进 NOT_GATES`).toBe(true)
    }
  })

  // ── 本体:命名像闸门的文件,必须被分类 ────────────────────────────────────
  test("命名命中闸门词的测试文件,要么已登记、要么已写明不是闸门", () => {
    const unclassified = IN_SCOPE_TESTS.filter(
      (path) => GATE_NAME_TOKENS.test(path) && !REGISTERED.includes(path) && !(path in NOT_GATES),
    )
    expect(
      unclassified,
      [
        "下列测试文件按仓库惯例命名得像闸门文件,却既没登记进 scripts/gate-files.tsv,",
        "也没在 gate-file-registry.test.ts 的 NOT_GATES 里写明为什么不是。",
        "",
        "闸门文件 = 删掉它就移除某条**具体保证**(而不只是减少覆盖率)。",
        "  · 是闸门 → 登记到 scripts/gate-files.tsv,给一个点名下界(整包地板抓不到单文件消失)。",
        "  · 不是闸门 → 加进 NOT_GATES,并写清删掉它损失的只是覆盖率。",
        "不要为了让 CI 变绿而随手塞进 NOT_GATES —— 本仓已经因为漏掉一个 drift lock 吃过亏。",
      ].join("\n"),
    ).toEqual([])
  })

  test("本文件自身也在登记簿里(否则它可以被静默删掉)", () => {
    expect(REGISTERED).toContain("packages/ui-mac/src/main/gate-file-registry.test.ts")
  })

  // ── 委派规则:主判据被委派出去时,受托方也必须在册 ──────────────────────────
  // 源码棘轮常把主判据交给别的测试(「THE PRIMARY JUDGEMENT IS NOT IN THIS FILE」)。
  // 删掉受托方,保证就没了,而棘轮只守住「源码里有那段文字」—— 按本仓定义那是**假闸门**。

  test("每行都显式填了 delegates_to（默认拒:没有委派也要写 '-'）", () => {
    const empty = ROWS.filter((row) => row.fields < 5 || row.rawDelegates.trim() === "")
    expect(
      empty.map((row) => row.path),
      "这些行没有填 delegates_to。没有委派请显式写 '-' —— 留空默认拒,不默认放行。",
    ).toEqual([])
  })

  test("被委派的受托方必须也在登记簿里", () => {
    const dangling = ROWS.flatMap((row) =>
      row.delegates.filter((target) => !REGISTERED.includes(target)).map((target) => `${row.path} → ${target}`),
    )
    expect(
      dangling,
      [
        "下列闸门文件把主判据委派给了一个**没有登记**的测试文件。",
        "受托方没有点名下界 = 它可以被静默删掉,而委派方只守住源码文本 —— 那是假闸门。",
        "把受托方也登记进 scripts/gate-files.tsv。",
      ].join("\n"),
    ).toEqual([])
  })

  // 发现用绊线(**不是**权威判据 —— 权威是上面那两条显式声明)。
  // 自然语言的委派说法太多,按措辞枚举与按文件名枚举是同一种缺陷。所以这里不去理解语义,
  // 只做一件机械的事:闸门文件正文里出现的**任何**其它测试文件,都必须已被分类。
  test("闸门文件正文提到的其它测试文件,都必须已被分类(已登记 / NOT_GATES / 写明未登记理由)", () => {
    const unclassified = ROWS.flatMap((row) =>
      referencesOf(row)
        .filter(
          (target) =>
            !REGISTERED.includes(target) && !(target in NOT_GATES) && !(target in REFERENCED_BUT_UNREGISTERED),
        )
        .map((target) => `${row.path} → ${target}`),
    )
    expect(
      unclassified,
      [
        "下列测试文件在某个闸门文件的正文里被提到,却没有被分类。",
        "这条绊线的存在理由:route-authority-ratchet 的抬头白纸黑字写着主判据在",
        "route-deep-link-consumer.test.ts,而按文件名发现闸门时它完全隐形 —— 与当初只扫一级目录的",
        "walker 是同一种缺陷。",
        "",
        "三选一,不许沉默:",
        "  · 它是受托方/闸门 → 登记进 scripts/gate-files.tsv(并在委派方的 delegates_to 里列出)",
        "  · 它不是闸门     → 加进 NOT_GATES 并写清删掉它损失的只是覆盖率",
        "  · 真委派但今天不纳入 CI → 加进 REFERENCED_BUT_UNREGISTERED 并写明理由与跟踪票号",
      ].join("\n"),
    ).toEqual([])
  })

  test("REFERENCED_BUT_UNREGISTERED 里的文件都真的存在(免得理由挂在一个已删的路径上)", () => {
    for (const path of Object.keys(REFERENCED_BUT_UNREGISTERED)) expect(ALL_TESTS).toContain(path)
  })
})
