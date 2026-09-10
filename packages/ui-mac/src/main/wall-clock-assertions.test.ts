// `#1300` —— 墙钟上界断言的棘轮:仓里每一条「断言一段真实耗时 < 上界」的判据都必须登记在
// scripts/wall-clock-assertions.tsv 并写明处置。新增一条不登记 ⇒ 红并点名 file:line;登记了源码里
// 已不存在的 ⇒ 红(登记簿不许长成尸体);处置不合法(rewrite / 在门内的 load-sensitive / 给 alpha
// 自有文件的 upstream / 没写理由的 keep)⇒ 红。
//
// 手段先自证(控制臂,合成源码):
//   · 2026-09-08 咬人的那一条原样(`expect(Date.now() - startedAt).toBeLessThan(100)`)必抓;
//   · 先算成变量再断言、只有耗时命名(`result.durationMs`)、performance.now + toBeLessThanOrEqual、
//     藏在 toEqual 对象里的比较、`.not.toBeGreaterThan`、方向反过来的 `expect(BUDGET).toBeGreaterThan(耗时)`、
//     上界是 `…_MS` 常量 —— 每一轴各一条必抓;
//   · 数组长度 / 字节数 / 下标 / 耗时的**下界** / 常量对常量 / 带参 `new Date(FIXED)` —— 必不抓;
//   · 反向夹具:临时目录里写一条新的墙钟上界断言,扫描器必须抓到并报出 file:line;登记簿里多一行
//     源码里没有的,必须报 stale。
//
// 保证本身(删掉本文件会失去什么):这一类会自己长回来 —— 下一条 `toBeLessThan(100)` 在满载下红一次,
// 拦下一个与它无关的 PR,而最省事的动作是 `--no-verify`。

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, describe, expect, test } from "bun:test"
import {
  DISPOSITIONS,
  diffLedger,
  dispositionError,
  gateRegisteredFiles,
  listTestFiles,
  parseLedger,
  scanRepository,
  scanSource,
  signatureOf,
  type LedgerContext,
  type LedgerRow,
} from "./wall-clock-assertions"

const repoRoot = resolve(import.meta.dir, "../../../..")
const ledgerPath = resolve(repoRoot, "scripts", "wall-clock-assertions.tsv")
const gateFilesPath = resolve(repoRoot, "scripts", "gate-files.tsv")

const repoContext: LedgerContext = {
  gateRegistered: gateRegisteredFiles(readFileSync(gateFilesPath, "utf8")),
  read: (file) => {
    try {
      return readFileSync(join(repoRoot, file), "utf8")
    } catch {
      return undefined
    }
  },
}

const row = (partial: Partial<LedgerRow>): LedgerRow => ({
  file: "packages/ui-mac/src/main/synthetic-wallclock.test.ts",
  test: "t",
  assertion: "expect(elapsed).toBeLessThan(1)",
  disposition: "keep",
  reason: "真性能契约:余量 ≥ 100×,守住的失败签名是 O(n²) 实现在 64k 输入上的分钟级耗时。",
  ...partial,
})

describe("登记簿 == 扫描(全仓测试文件)", () => {
  const hits = scanRepository(repoRoot)
  const ledger = parseLedger(readFileSync(ledgerPath, "utf8"))
  const diff = diffLedger(hits, ledger, repoContext)

  test("扫描集合与登记簿都非空,且扫描真的走到了上游包(扫到 0 个 = 扫描器瞎了,不是仓里没有)", () => {
    expect(hits.length).toBeGreaterThan(0)
    expect(ledger.length).toBeGreaterThan(0)
    expect(hits.some((h) => h.file.startsWith("packages/opencode/test/"))).toBe(true)
    expect(ledger.some((r) => r.disposition === "upstream")).toBe(true)
  })

  test("未登记的墙钟上界断言 = 0(默认动作是改写成不依赖机器闲忙的判据,不是登记)", () => {
    expect(
      diff.unregistered.map((h) => `${h.file}:${h.line}  [${h.axes.join("+")}]  ${h.assertion}`),
      [
        "有墙钟上界断言没登记。它断的不是被测对象对不对,是机器当时有多闲 —— 满载时会假红并拦下无关的 PR。",
        "默认动作:改写成与机器闲忙无关的判据(调用计数 / 事件序 / 冻住时钟 / TestClock;先例见登记簿抬头)。",
        "实在要留:`bun packages/ui-mac/scripts/wall-clock-assertions.ts --write` 生成签名,把 TODO 改成",
        "keep(真性能契约,写清余量与失败签名)/ load-sensitive(只许门外文件)/ upstream(只许非 alpha 文件)/ not-elapsed(过报)。",
        "不许登记进 scripts/known-fails.tsv;不许把上界放宽成更大的数(#1300 票面)。",
      ].join("\n"),
    ).toEqual([])
  })

  test("登记簿里没有源码里已不存在的行,没有重复行", () => {
    expect(diff.stale.map(signatureOf), "登记了源码里没有的断言 —— 删掉那一行(改写完成的留痕写在抬头注释里)").toEqual([])
    expect(diff.duplicates).toEqual([])
  })

  test("每一行的处置都合法:不是 TODO / rewrite,门内文件不许 load-sensitive,alpha 自有文件不许 upstream,理由不许空", () => {
    expect(diff.invalid.map(({ row, error }) => `${signatureOf(row)}\n    → ${error}`)).toEqual([])
  })

  test("扫描集合自证:含 src 下的 .test.ts、宿主跑的 .cases.ts、门外的 test-live;不含 node_modules", () => {
    const files = listTestFiles(repoRoot)
    expect(files).toContain("packages/ui-mac/src/main/gate-file-registry.test.ts")
    expect(files.some((f) => f.endsWith(".cases.ts"))).toBe(true)
    expect(files.some((f) => f.startsWith("packages/ui-mac/test-live/"))).toBe(true)
    expect(files.some((f) => f.startsWith("packages/opencode/test/"))).toBe(true)
    expect(files.filter((f) => f.includes("node_modules"))).toEqual([])
  })
})

describe("控制臂:扫描器测得出已知的坏", () => {
  const sigs = (file: string, src: string) => scanSource(file, src).map((h) => `${h.line}|${h.axes.join("+")}|${h.assertion}`)

  test("2026-09-08 咬人的那一条原样必抓(clock 轴),并带 test 标题与 file:line", () => {
    const src = [
      `import { expect, test } from "bun:test"`,
      `test("timed-out reservation deletion is abandoned", async () => {`,
      `  const startedAt = Date.now()`,
      `  const result = await write("bounded-delete.bin", "x")`,
      `  expect(result.ok).toBe(false)`,
      `  expect(Date.now() - startedAt).toBeLessThan(100)`,
      `})`,
    ].join("\n")
    const hits = scanSource("synthetic/wallclock-a.test.ts", src)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      file: "synthetic/wallclock-a.test.ts",
      test: "timed-out reservation deletion is abandoned",
      assertion: "expect(Date.now() - startedAt).toBeLessThan(100)",
      axes: ["clock"],
      line: 6,
    })
    expect(diffLedger(hits, [], repoContext).unregistered).toHaveLength(1)
  })

  test("先算成变量再断言:数据流经 const 传递(clock+name)", () => {
    const src = `const t0 = performance.now()\nawait run()\nconst elapsed = performance.now() - t0\nexpect(elapsed).toBeLessThan(3_000)\n`
    expect(sigs("synthetic/wallclock-b.test.ts", src)).toEqual(["4|clock+name|expect(elapsed).toBeLessThan(3_000)"])
  })

  test("只有耗时命名、看不见时钟调用(生产量出来的 durationMs):name 轴必抓;toBeLessThanOrEqual 同", () => {
    const src = `const result = await runProcess()\nexpect(result.durationMs).toBeLessThan(15_000)\nexpect(timedOut.took).toBeLessThanOrEqual(1_000)\n`
    expect(sigs("synthetic/wallclock-c.test.ts", src)).toEqual([
      "2|name|expect(result.durationMs).toBeLessThan(15_000)",
      "3|name|expect(timedOut.took).toBeLessThanOrEqual(1_000)",
    ])
  })

  test("藏在 toEqual 对象里的比较、.not.toBeGreaterThan、方向反过来的 toBeGreaterThan —— 都抓", () => {
    const src = [
      `const started = performance.now()`,
      `const elapsed = performance.now() - started`,
      `expect({ linearBudgetMs: 2000, withinBudget: elapsed < 2000 }).toEqual({ linearBudgetMs: 2000, withinBudget: true })`,
      `expect(Date.now() - started).not.toBeGreaterThan(500)`,
      `expect(BUDGET_MS).toBeGreaterThan(Date.now() - started)`,
    ].join("\n")
    expect(sigs("synthetic/wallclock-d.test.ts", src).map((s) => s.split("|").slice(0, 2).join("|"))).toEqual([
      "3|clock+name",
      "4|clock",
      "5|clock+bound-name",
    ])
  })

  test("上界是 UPPER_SNAKE 时间常量而被约束侧不是常量:bound-name 轴必抓(gapBetween 那一形)", () => {
    const src = `const ATTRIBUTED_FLOOR_MS = 150\nexpect(gapBetween("renderer.shell.ready", "renderer.sidebar.setup")).toBeLessThan(ATTRIBUTED_FLOOR_MS)\n`
    expect(sigs("synthetic/wallclock-e.test.ts", src)).toEqual([
      `2|bound-name|expect(gapBetween("renderer.shell.ready", "renderer.sidebar.setup")).toBeLessThan(ATTRIBUTED_FLOOR_MS)`,
    ])
  })

  test("纯正的非耗时 toBeLessThan 一条都不抓:长度 / 字节 / 下标 / 耗时下界 / 常量对常量 / 固定时刻", () => {
    const src = [
      `const PROBE_TIMEOUT_MS = 5`,
      `const FETCH_TIMEOUT_MS = 10`,
      `const FIXED = Date.parse("2026-07-20T12:00:00.000Z")`,
      `const calls = ["open:pty_1", "open:pty_2"]`,
      `const requestAt = calls.indexOf("open:pty_1")`,
      `const t0 = Date.now()`,
      `expect(items.length).toBeLessThan(100)`,
      `expect(9 * 1024 * 1024).toBeLessThan(10 * 1024 * 1024)`,
      `expect(requestAt).toBeLessThan(calls.indexOf("open:pty_2"))`,
      `expect(Date.now() - t0).toBeGreaterThanOrEqual(20)`,
      `expect(PROBE_TIMEOUT_MS).toBeLessThan(FETCH_TIMEOUT_MS)`,
      `expect(cfg.graceMs).toBeGreaterThan(0)`,
      `expect(new Date(FIXED).getTime()).toBeLessThan(FIXED + 1)`,
      `expect(FETCH_TIMEOUT_MS).toBeGreaterThanOrEqual(3_000)`,
    ].join("\n")
    expect(sigs("synthetic/wallclock-f.test.ts", src)).toEqual([])
  })

  test("不在任何 test() 里的断言(助手函数)test 列记为 '-'", () => {
    const src = `function waitDone(t0: number) {\n  expect(Date.now() - t0).toBeLessThan(1_000)\n}\n`
    expect(scanSource("synthetic/wallclock-g.test.ts", src).map((h) => h.test)).toEqual(["-"])
  })
})

describe("控制臂:处置合法性(默认拒)", () => {
  test("合法组合:keep(理由 ≥ 40)/ 门外 load-sensitive / 非 alpha 文件 upstream / not-elapsed(理由 ≥ 20)", () => {
    expect(dispositionError(row({}), repoContext)).toBeUndefined()
    expect(
      dispositionError(row({ file: "packages/ui-mac/test-live/synthetic/live.test.ts", disposition: "load-sensitive", reason: "test-live,单独命令跑" }), repoContext),
    ).toBeUndefined()
    expect(dispositionError(row({ file: "packages/opencode/test/util/synthetic.test.ts", disposition: "upstream", reason: "上游文件" }), repoContext)).toBeUndefined()
    expect(dispositionError(row({ disposition: "not-elapsed", reason: "被约束的是由 attempt 算出的退避间隔,不是耗时" }), repoContext)).toBeUndefined()
  })

  test("rewrite / TODO / 未知处置一律非法(改写 = 断言不再存在 = 不该有这一行)", () => {
    for (const disposition of ["rewrite", "TODO", "", "ignore"]) expect(dispositionError(row({ disposition }), repoContext), disposition).toBeDefined()
    expect(DISPOSITIONS).not.toContain("rewrite")
  })

  test("load-sensitive 不许给每 PR 套件里的文件:ui-mac/src、ext、contracts-consumer、test-component、gate-files 点名的", () => {
    for (const file of [
      "packages/ui-mac/src/main/synthetic.test.ts",
      "packages/ext/src/synthetic.test.ts",
      "packages/alpha-contracts-consumer/src/synthetic.test.ts",
      "packages/ui-mac/test-component/synthetic.cases.ts",
      "packages/llm/test/auth-fail-closed.test.ts",
    ])
      expect(dispositionError(row({ file, disposition: "load-sensitive", reason: "负载敏感" }), repoContext), file).toContain("load-sensitive")
  })

  test("upstream 不许给 alpha 自有文件:alpha 三包 / alpha- 前缀 / 正文带 north-star:alpha-owned", () => {
    const ctx: LedgerContext = { ...repoContext, read: (file) => (file.endsWith("marked.test.ts") ? "// north-star:alpha-owned\n" : "") }
    for (const file of [
      "packages/ui-mac/src/main/synthetic.test.ts",
      "packages/ext/src/synthetic.test.ts",
      "packages/opencode/test/tool/alpha-synthetic.test.ts",
      "packages/core/test/marked.test.ts",
    ])
      expect(dispositionError(row({ file, disposition: "upstream", reason: "上游" }), ctx), file).toContain("upstream")
    expect(dispositionError(row({ file: "packages/core/test/plain.test.ts", disposition: "upstream", reason: "上游" }), ctx)).toBeUndefined()
  })

  test("keep 的理由必须 ≥ 40 字符,not-elapsed ≥ 20,任何处置理由不许空", () => {
    expect(dispositionError(row({ reason: "性能契约" }), repoContext)).toContain("40")
    expect(dispositionError(row({ disposition: "not-elapsed", reason: "过报" }), repoContext)).toContain("20")
    expect(dispositionError(row({ file: "packages/opencode/test/x.test.ts", disposition: "upstream", reason: "  " }), repoContext)).toContain("理由")
  })
})

describe("反向夹具:临时仓里新增一条墙钟上界断言,棘轮必须响并点名 file:line;登记了不存在的必须报 stale", () => {
  const fixture = mkdtempSync(join(tmpdir(), "alpha-wallclock-fixture-"))
  afterAll(() => rmSync(fixture, { recursive: true, force: true }))

  test("新增未登记 ⇒ unregistered 恰好那一条;登记簿多一行 ⇒ stale 恰好那一行", () => {
    mkdirSync(join(fixture, "packages", "x", "test"), { recursive: true })
    mkdirSync(join(fixture, "node_modules", "y"), { recursive: true })
    writeFileSync(
      join(fixture, "packages", "x", "test", "fresh.test.ts"),
      [
        `import { expect, test } from "bun:test"`,
        `test("returns quickly", async () => {`,
        `  const t0 = Date.now()`,
        `  await thing()`,
        `  expect(items.length).toBeLessThan(3)`,
        `  expect(Date.now() - t0).toBeLessThan(50)`,
        `})`,
      ].join("\n"),
    )
    // node_modules 里的同形文件不算(扫描集合排除它)。
    writeFileSync(join(fixture, "node_modules", "y", "dep.test.ts"), `expect(Date.now() - t0).toBeLessThan(50)\n`)
    const hits = scanRepository(fixture)
    expect(hits.map((h) => `${h.file}:${h.line}`)).toEqual(["packages/x/test/fresh.test.ts:6"])

    const ctx: LedgerContext = { gateRegistered: new Set(), read: () => "" }
    const unregistered = diffLedger(hits, [], ctx)
    expect(unregistered.unregistered.map((h) => `${h.file}:${h.line} ${h.assertion}`)).toEqual([
      "packages/x/test/fresh.test.ts:6 expect(Date.now() - t0).toBeLessThan(50)",
    ])

    const ghost = row({ file: "packages/x/test/gone.test.ts", test: "old", assertion: "expect(Date.now() - t0).toBeLessThan(9)", disposition: "upstream", reason: "已删" })
    const registered = row({ file: "packages/x/test/fresh.test.ts", test: "returns quickly", assertion: "expect(Date.now() - t0).toBeLessThan(50)", disposition: "upstream", reason: "夹具" })
    const withGhost = diffLedger(hits, [registered, ghost], ctx)
    expect(withGhost.unregistered).toEqual([])
    expect(withGhost.stale.map(signatureOf)).toEqual([signatureOf(ghost)])
  })
})
