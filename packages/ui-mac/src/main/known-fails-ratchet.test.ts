// `#1086` —— base fail-set 棘轮的行为闸。
//
// 被测对象是 scripts/bun-test-floor.sh + scripts/known-fails-compare.py 这对组合在
// ALPHA_KNOWN_FAILS_FILE 置位时的判决:清单内的红放行、**清单外的红拦住并点名**、
// 清单里已不失败的行提示可缩短、任何无法逐测试归因的失败一律拦住(fail-closed)。
// 全部判据都驱动**脚本本体**跑合成夹具(真 bun 子进程、真 junit 落盘),不断言脚本源码文本 ——
// 按本仓定义,断言 shell 源码文本是假闸门(守卫被整段注释掉时那种断言照样绿)。
//
// 为什么这道闸必须双向(#1086 AC3):只验「清单内的红放行」的话,一个把比对整个跳过的
// 实现(恒容忍)与正确实现不可区分 —— 本仓出过 fresh gate 半边分支从未被执行、26 pass /
// 0 fail 的实例。所以「清单外必须拦」在这里是**第一条**用例,不是补充。
//
// 保证本身(删掉本文件会失去什么):[5/10] 与 CI `bun test (ui-mac)` 的容忍语义可以退化成
// 「一律容忍」或「测不出名字就放行」而没有任何东西变红 —— 那正是 #754 的 `--no-verify`
// 形态换了一件自动化的外衣。

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path, { join, resolve } from "node:path"
import { expect, test } from "bun:test"

const UI_MAC = resolve(import.meta.dir, "../..")
const REPO_ROOT = resolve(UI_MAC, "../..")
const FLOOR = "scripts/bun-test-floor.sh"
const REAL_LIST = join(REPO_ROOT, "scripts/known-fails.tsv")

// 形状 B 同款(#777):把正在跑本测试的 bun 所在目录前置进 PATH,父子同一个二进制。
const BUN_DIR = path.dirname(process.execPath)

function runFloor(args: string[], knownFails?: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${BUN_DIR}${path.delimiter}${process.env.PATH ?? ""}`,
    // 夹具都是毫秒级用例;缩短子进程超时,让「夹具卡死」在 15s 内变红而不是拖满 120s。
    ALPHA_TEST_TIMEOUT_MS: "15000",
  }
  // 防继承污染:本测试自己可能正跑在一次置位了测量/容忍变量的闸门运行里。
  delete env.ALPHA_KNOWN_FAILS_FILE
  delete env.ALPHA_TEST_COUNT_FILE
  if (knownFails) env.ALPHA_KNOWN_FAILS_FILE = knownFails
  const r = Bun.spawnSync({ cmd: ["bash", FLOOR, ...args], cwd: REPO_ROOT, env })
  return { output: `${r.stdout.toString()}${r.stderr.toString()}`, code: r.exitCode }
}

/** 夹具:嵌套 describe 里一条红 + 一条顶层绿。嵌套是故意的 —— 锁住显示名重建的外→内顺序。 */
const FIXTURE_RED = `import { describe, test, expect } from "bun:test"
describe("outer ring", () => {
  describe("inner ring", () => {
    test("known red probe", () => { expect(1).toBe(2) })
  })
})
test("green neighbour", () => { expect(1).toBe(1) })
`

/** 同名但全绿的版本 —— AC3② 的「清单内的红修绿」。 */
const FIXTURE_GREEN = FIXTURE_RED.replace("expect(1).toBe(2)", "expect(1).toBe(1)")

/** 显示名:console (fail) 行的那串。junit classname 是内→外倒序,重建必须把它转回来。 */
const RED_DISPLAY = "outer ring > inner ring > known red probe"
const LIST_HEADER = "# 合成清单(本测试夹具)\n"
const LIST_ENTRY = `kfprobe.test.ts\t${RED_DISPLAY}\t理由:#1086 行为闸的合成已知红\n`

function fixture(testSource: string, listBody: string) {
  const dir = mkdtempSync(join(tmpdir(), "kf-ratchet-"))
  writeFileSync(join(dir, "kfprobe.test.ts"), testSource)
  const list = join(dir, "list.tsv")
  writeFileSync(list, listBody)
  return { dir, list }
}

test("清单外的红必须拦住,并按 describe 外→内的真实顺序点名(AC3① 正向)", { timeout: 120_000 }, () => {
  const { dir, list } = fixture(FIXTURE_RED, LIST_HEADER) // 空清单:零容忍
  try {
    const r = runFloor(["1", dir, "kfprobe.test.ts"], list)
    expect(r.code).not.toBe(0)
    expect(r.output).toContain("清单外新红")
    // 点名必须是完整显示名 —— bun 1.3.14 的 junit classname 是「inner ring > outer ring」
    // 倒序;重建若不反转,这里就会点出一个用户在 console 里找不到的名字。
    expect(r.output).toContain(`kfprobe.test.ts :: ${RED_DISPLAY}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("清单内的红放行,逐条打出容忍与清单里的理由,条数下界照常执行(AC2)", { timeout: 120_000 }, () => {
  const { dir, list } = fixture(FIXTURE_RED, LIST_HEADER + LIST_ENTRY)
  try {
    const r = runFloor(["1", dir, "kfprobe.test.ts"], list)
    expect(r.code).toBe(0)
    expect(r.output).toContain("清单内已知红")
    expect(r.output).toContain(RED_DISPLAY)
    expect(r.output).toContain("合成已知红") // 理由列要到达输出,容忍不许是无声的
    expect(r.output).toContain("1 条断言真的执行了")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("容忍不放松条数下界 —— 清单齐全但 pass 低于地板仍然红", { timeout: 120_000 }, () => {
  const { dir, list } = fixture(FIXTURE_RED, LIST_HEADER + LIST_ENTRY)
  try {
    const r = runFloor(["99", dir, "kfprobe.test.ts"], list)
    expect(r.code).not.toBe(0)
    expect(r.output).toContain("低于下界 99")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("清单内的红修绿 ⇒ 不拦,但必须提示清单可缩短并点名那一行(AC3② 反向)", { timeout: 120_000 }, () => {
  const { dir, list } = fixture(FIXTURE_GREEN, LIST_HEADER + LIST_ENTRY)
  try {
    const r = runFloor(["1", dir, "kfprobe.test.ts"], list)
    expect(r.code).toBe(0)
    expect(r.output).toContain("清单可缩短")
    expect(r.output).toContain(RED_DISPLAY)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("清单行缺 reason 列 ⇒ 全绿的一次运行也要拦(AC5 默认拒,不许只有测试名)", { timeout: 120_000 }, () => {
  const { dir, list } = fixture(FIXTURE_GREEN, `${LIST_HEADER}kfprobe.test.ts\t${RED_DISPLAY}\n`)
  try {
    const r = runFloor(["1", dir, "kfprobe.test.ts"], list)
    expect(r.code).not.toBe(0)
    expect(r.output).toContain("测量作废")
    expect(r.output).toContain("不合形")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("模块加载崩溃(junit 不落盘)⇒ 清单不吸收,拦住 —— 失败必须可逐测试归因", { timeout: 120_000 }, () => {
  const { dir, list } = fixture('throw new Error("kf module load boom")\n', LIST_HEADER + LIST_ENTRY)
  try {
    const r = runFloor(["1", dir, "kfprobe.test.ts"], list)
    expect(r.code).not.toBe(0)
    expect(r.output).toContain("junit 报告缺失")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("console 里嵌入的子进程 (fail) 行不是判据 —— junit 权威,宿主回显不制造假新红", { timeout: 120_000 }, () => {
  // 复刻真实污染形状:base 上 ui-mac 全量的日志里就嵌着一段子进程的
  // `(fail) …` + `13 pass / 1 fail / Ran 14 tests across 1 file`,而外层 summary 只算外层。
  const noisy = `import { test, expect } from "bun:test"
test("echoing host stays green", () => {
  console.log("(fail) embedded child probe red [1.00ms]")
  console.log(" 13 pass")
  console.log(" 1 fail")
  console.log("Ran 14 tests across 1 file. [2.00s]")
  expect(true).toBe(true)
})
`
  const { dir, list } = fixture(noisy, LIST_HEADER) // 空清单:若判据在裸 grep console,这里必然误拦
  try {
    const r = runFloor(["1", dir, "kfprobe.test.ts"], list)
    expect(r.code).toBe(0)
    expect(r.output).not.toContain("清单外新红")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("精确条数模式(=N)与清单互斥 —— 登记簿的逐文件点名不得被容忍语义软化", { timeout: 120_000 }, () => {
  const { dir, list } = fixture(FIXTURE_GREEN, LIST_HEADER + LIST_ENTRY)
  try {
    const r = runFloor(["=1", dir, "kfprobe.test.ts"], list)
    expect(r.code).not.toBe(0)
    expect(r.output).toContain("互斥")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("仓内真实清单必须合形:三列齐、逐列非空、file 指向真实存在的测试文件", () => {
  const rows = readFileSync(REAL_LIST, "utf8")
    .split("\n")
    .filter((line) => line.trim() && !line.trimStart().startsWith("#"))
  expect(rows.length).toBeGreaterThan(0)
  const seen = new Set<string>()
  for (const row of rows) {
    const cols = row.split("\t")
    expect(cols.length, `清单行不是三列:${row}`).toBeGreaterThanOrEqual(3)
    for (const col of cols.slice(0, 3)) expect(col.trim(), `清单列为空:${row}`).not.toBe("")
    const key = `${cols[0]}\t${cols[1]}`
    expect(seen.has(key), `清单重复登记:${key}`).toBe(false)
    seen.add(key)
    // file 列相对 bun 的工作目录(packages/ui-mac)。指向不存在的文件 = 清单在骗人 ——
    // 那条红的载体早没了,行却还在吃着「基线既有」的豁免名额。
    expect(existsSync(join(UI_MAC, cols[0]!.trim())), `清单指向不存在的文件:${cols[0]}`).toBe(true)
  }
})
