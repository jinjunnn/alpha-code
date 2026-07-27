// #647 —— 闸门文件登记簿的**完备性**闸。
//
// 背景(这一轮的教训,写下来免得再犯):#647 修完 `readBoundedBody` 之后,我们发现
// 「整套 suite 的地板抓不到删掉一个 N 条用例的文件」,于是给 ui-mac 的类级闸加了点名下界。
// 然后**只加了那一个** —— ext 的 REQ-062 drift lock(`prompt-rebrand.test.ts`,26 条)照旧
// 只被整包地板 100 罩着,而 ext 排除它还剩 106 条,删掉它 CI 静默全绿。
// 同一条规律,只应用了一次。这就是本文件存在的理由:**让「又冒出一个闸门文件却没登记」变成红灯**,
// 而不是靠下一个人记得。
//
// 机制:仓库对闸门文件有稳定的命名习惯(ratchet / lock / anchors / contract / copies /
// snapshot / drift / hygiene / rebrand / seam / coexistence / census)。凡文件名命中这些词的
// 测试文件,必须**要么登记在 `scripts/gate-files.tsv`,要么在下面 NOT_GATES 里写明为什么不是**。
// 两边都没有 = 红。
//
// ⚠️ 诚实边界(这是启发式,不是完备枚举):
//   · 命名不含上述词的闸门文件**检测不到**。登记簿因此仍是**显式**清单,不是自动推导的结果 ——
//     新写闸门时该登记还是要登记。本闸挡的是「按仓库惯例命名了、却忘了登记」这一类,
//     那正是 ext 那次的实际形态。
//   · 它也不判断登记的下界取得对不对,只判断「有没有被分类」。
//
// 保证本身(删掉本文件会失去什么):新增的闸门文件不再被强制分类,登记簿会随时间腐烂 ——
// 而登记簿腐烂时,没有任何别的东西会红。本文件自身也登记在 `gate-files.tsv` 里。

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

/** 解析登记簿:返回登记的路径集合(workdir/path)。 */
function registeredPaths(): string[] {
  const body = readFileSync(join(REPO_ROOT, "scripts/gate-files.tsv"), "utf8")
  const rows: string[] = []
  for (const line of body.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue
    const [, workdir, path] = line.split("\t")
    if (workdir && path) rows.push(`${workdir}/${path}`)
  }
  return rows
}

const ALL_TESTS = gitListedTests()
const REGISTERED = registeredPaths()
const IN_SCOPE_TESTS = ALL_TESTS.filter((path) => IN_SCOPE.some((prefix) => path.startsWith(prefix)))

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
})
