// #647 —— **类级**闸:禁止 `Stream.runForEachWhile` 再出现在本仓源码里。
//
// 事实(effect 4.0.0-beta.83,脱机对同一个请求三种读法实测):
//
//   | 读法                     | chunk 数 | 字节   |
//   | ------------------------ | -------- | ------ |
//   | `Stream.runForEachWhile` | 1        |  4,090 |
//   | `Stream.runForEach`      | 3        | 18,063 |
//   | `response.text`          | —        | 18,034 |
//
// 它**只消费第一个 chunk 就停**,哪怕谓词恒返回 `true`。没有异常、没有日志 —— 调用方拿到一份
// 静默截断的 body。
//
// 本仓踩了两次:
//   ① `packages/opencode/src/tool/read.ts` —— 作者当场发现,把教训写进注释(read.ts:143
//      「we avoid Stream.runForEachWhile …」),改用 `runForEach` + tagged error 中止上游。
//   ② `packages/opencode/src/tool/mcp-websearch.ts` —— #489 的有界读取照 API 直觉写了它。
//      注释在**另一个文件**里,没人看见。keyless web search 于是把成功的上游响应读成截断 JSON
//      (「invalid response … Unterminated string in JSON」),**并且发了版**。
//
// 「教训写在注释里」不是闸门 —— 这就是本文件存在的全部理由。同一类问题第二次出现,就从逐实例修
// 切到单点修机制:再有人写这个 API,CI 转红,并被直接指向正确形态。
//
// ⚠️ 诚实边界(别把它当成它不是的东西):
//   · 这是**源码文本**闸。`Stream["runForEachWhile"]`、先取别名再调、动态属性名 —— 都绕得过。
//     它挡的是现实中唯一见过的形态:有人照 API 直觉直接写了它。这是减速带,不是安全边界。
//   · 缺陷本身的**行为**闸(真读多 chunk / 硬限仍是硬限)在
//     `packages/opencode/test/tool/alpha-websearch-failure.test.ts` 的 "#647" 一组,那里断言的是
//     可观测结果(字节数、上游被 cancel、pull 次数),不是源码文本。两者缺一不可。

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import { describe, expect, test } from "bun:test"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..")
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", ".git", "gen", "generated"])

function sourceFiles(): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      if (!/\.tsx?$/.test(entry.name)) continue
      // 与 websearch-copies.test.ts 同一取舍:只扫生产源码。测试文件里必须写得出这个名字
      // (本文件的自我变异样本就是),否则闸门连自检都做不了。代价:测试里的用法不被这条禁令
      // 覆盖 —— 那不是生产行为,由行为闸负责。
      if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue
      found.push(join(dir, entry.name))
    }
  }
  for (const pkg of readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true })) {
    if (!pkg.isDirectory() || SKIP_DIRS.has(pkg.name)) continue
    const src = join(REPO_ROOT, "packages", pkg.name, "src")
    try {
      if (!statSync(src).isDirectory()) continue
    } catch {
      continue
    }
    walk(src)
  }
  return found
}

const FILES = sourceFiles().map((path) => ({
  path: relative(REPO_ROOT, path).split(sep).join("/"),
  body: readFileSync(path, "utf8"),
}))

/** 调用形态。prettier 从不在标识符与 `(` 之间留空格,所以真调用一定长这样。 */
const CALL = /runForEachWhile\(/
/** 任何提及(含注释、含带空格的散文写法)。用来强制「新增即分类」。 */
const MENTION = /runForEachWhile/

/**
 * 允许提到这个名字的生产文件:两处事故现场各自的**禁令注释**。两处都必须仍然是禁令而不是调用
 * —— 下面逐个断言,清单本身不构成豁免。
 * 想新增一项?先证明你的用法不是这个缺陷,再来改这个清单;不要为了让 CI 变绿而加条目。
 */
const REGISTERED_MENTIONS = [
  "packages/opencode/src/tool/read.ts", // 第一次:当场发现,教训只留在注释里
  "packages/opencode/src/tool/mcp-websearch.ts", // 第二次:#489 引入 → 静默截断发版 → #647 修
]

describe("Stream.runForEachWhile 类级禁令 (#647)", () => {
  // ── 先证明这个闸不是空的 ──────────────────────────────────────────────────
  // 「条件门」的典型形态:walker 悄悄返回空集,禁令于是恒真。下面两条把前提本身钉死。

  test("扫描器确实读到了源码树(否则下面的禁令恒真)", () => {
    expect(FILES.length).toBeGreaterThan(200)
    const paths = FILES.map((file) => file.path)
    // 两次事故的现场文件必须在集合里 —— 它们不在,说明 walker 覆盖面已经坏了。
    expect(paths).toContain("packages/opencode/src/tool/read.ts")
    expect(paths).toContain("packages/opencode/src/tool/mcp-websearch.ts")
  })

  test("检测器确实认得出违规写法(自我变异)", () => {
    const violation = "yield* Stream.runForEachWhile(response.stream, (chunk) => Effect.sync(() => true))"
    const benign = "yield* Stream.runForEach(response.stream, (chunk) => Effect.sync(() => {}))"
    expect(CALL.test(violation)).toBe(true)
    expect(CALL.test(benign)).toBe(false)
    expect(MENTION.test(violation)).toBe(true)
  })

  // ── 禁令本体 ──────────────────────────────────────────────────────────────

  test("全仓源码零处调用 Stream.runForEachWhile", () => {
    const callers = FILES.filter((file) => CALL.test(file.body)).map((file) => file.path)
    expect(
      callers,
      [
        "`Stream.runForEachWhile` 只消费第一个 chunk 就停(effect 4.0.0-beta.83),静默截断,无异常。",
        "本仓已因此踩过两次:read.ts(当场发现)与 mcp-websearch.ts(#489 引入、静默截断发了版、#647 修)。",
        "正确形态:`Stream.runForEach` + tagged error,在需要停的那一刻中止上游流 ——",
        "  参考 packages/opencode/src/tool/read.ts:146 与 packages/opencode/src/tool/mcp-websearch.ts。",
        "若真需要「读到条件不满足就停」,用 runForEach + tagged error 表达,不要用这个 API。",
      ].join("\n"),
    ).toEqual([])
  })

  test("提到这个名字的文件集合没有变 —— 新增即分类", () => {
    const mentions = FILES.filter((file) => MENTION.test(file.body)).map((file) => file.path)
    expect(mentions.sort()).toEqual([...REGISTERED_MENTIONS].sort())
  })

  for (const path of REGISTERED_MENTIONS)
    test(`${path} 里那处提及仍然是禁令,不是调用`, () => {
      const body = readFileSync(join(REPO_ROOT, path), "utf8")
      expect(MENTION.test(body)).toBe(true)
      expect(CALL.test(body)).toBe(false)
    })
})
