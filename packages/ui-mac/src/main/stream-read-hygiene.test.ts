// #647 —— **类级**闸:禁止 `Stream.runForEachWhile` 出现在本仓 git 可见的 TypeScript 生产源码里。
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
// ── 这道闸**确切**守住什么(#647 codex 第 1 轮 Major ①:上一版超卖,已改正)────────────
//
// 守住:`git ls-files`(已跟踪 + 未被 .gitignore 忽略的新文件)在**整个仓库**范围内列出的
//       每个 `.ts` / `.tsx` 文件,排除 `*.test.ts` / `*.spec.ts`。
//
// 守不住(明说,别当成它守住了):
//   · **写法层面**:`Stream["runForEachWhile"]`、先取别名再调、动态属性名 —— 都绕得过。
//     它挡的是现实中唯一见过的形态:有人照 API 直觉直接写了它。这是减速带,不是安全边界。
//   · **文件层面**:被 `.gitignore` 忽略的文件、非 TS 文件、测试文件本身。
//
// 上一版的教训(为什么现在用 `git ls-files` 而不是手写 walker):
//   上一版自己走目录树,且**只进 `packages/<一级目录>/src`**,却把结果表述为「全仓生产源码」。
//   实际漏掉 `packages/console/*`、`packages/stats/*`、`packages/sdk/js` 三个**嵌套 workspace**
//   共 353 个生产文件 —— 在 `packages/stats/server/src/ingest.ts` 里写违规代码可以完全绕过,
//   而当时的覆盖面自检(「扫到 >200 个文件 + 两个事故锚在集合里」)**仍然全绿**。
//   那个自检只证明「扫到了一些文件」,不证明「没漏」。现在:枚举交给 git(可证明完备),
//   并把「漏扫」本身做成可观测 —— 见下面 "覆盖面" 一组。
//
// 缺陷本身的**行为**闸(真读多 chunk / 硬限仍是硬限)在
// `packages/opencode/test/tool/alpha-websearch-failure.test.ts` 的 "#647" 一组,那里断言的是
// 可观测结果(字节数、上游被 cancel、pull 次数),不是源码文本。两者缺一不可。

import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, test } from "bun:test"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..")

/**
 * 枚举交给 git,不再手写 walker。`--cached` = 已跟踪;`--others --exclude-standard` = 尚未
 * `git add` 但也没被忽略的新文件(否则「新写的违规文件还没 add」就是一个绕过口)。
 */
function gitListed(): string[] {
  const result = Bun.spawnSync(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "--", "*.ts", "*.tsx"],
    { cwd: REPO_ROOT },
  )
  if (result.exitCode !== 0)
    throw new Error(`git ls-files 失败(exit ${result.exitCode}):${result.stderr.toString()} —— 闸门不得在枚举失败时静默放行`)
  return [...new Set(result.stdout.toString().split("\n").filter(Boolean))]
}

const ALL_LISTED = gitListed()
const FILES = ALL_LISTED.filter((path) => !/\.(test|spec)\.tsx?$/.test(path)).map((path) => ({
  path,
  body: readFileSync(join(REPO_ROOT, path), "utf8"),
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

/**
 * 根 `package.json` 的 workspace 通配符 —— 钉住它,是因为**新增一个 workspace 根**正是上一版
 * 漏扫的成因。这里对不上就说明仓库布局变了:停下来确认枚举确实覆盖到新根,再更新本清单。
 */
const KNOWN_WORKSPACE_GLOBS = ["packages/*", "packages/console/*", "packages/stats/*", "packages/sdk/js", "packages/slack"]

/** 每个 workspace 根都必须**真的**有文件进到 FILES 里 —— 「漏扫某个根」由此变成可观测。 */
const WORKSPACE_ROOT_PREFIXES = ["packages/console/", "packages/stats/", "packages/sdk/js/", "packages/slack/"]

describe("Stream.runForEachWhile 类级禁令 (#647)", () => {
  // ── 覆盖面:先证明这个闸不是空的,且没有漏扫 ──────────────────────────────
  // 「条件门」的典型形态:枚举悄悄少了一块,禁令于是在那一块上恒真。下面四条把前提本身钉死。

  test("枚举来自 git 且规模合理(枚举失败/近乎空集不得静默放行)", () => {
    expect(ALL_LISTED.length).toBeGreaterThan(2_000)
    expect(FILES.length).toBeGreaterThan(2_000)
    // 测试文件确实被排除了 —— 否则本文件会扫到自己的自我变异样本。
    expect(FILES.length).toBeLessThan(ALL_LISTED.length)
    expect(FILES.some((file) => /\.(test|spec)\.tsx?$/.test(file.path))).toBe(false)
  })

  test("workspace 根清单没有变 —— 新增 workspace 根必须先确认枚举覆盖得到", () => {
    const declared = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      workspaces?: { packages?: string[] }
    }
    expect(declared.workspaces?.packages ?? []).toEqual(KNOWN_WORKSPACE_GLOBS)
  })

  test("每个嵌套 workspace 根都真的有文件被扫到(上一版正是在这里漏了 353 个文件)", () => {
    for (const prefix of WORKSPACE_ROOT_PREFIXES) {
      const hits = FILES.filter((file) => file.path.startsWith(prefix))
      expect(hits.length, `workspace 根 ${prefix} 一个文件都没被扫到 —— 枚举漏了这一块`).toBeGreaterThan(0)
    }
    // 上一版可绕过的那个具体文件,现在必须在集合里。
    expect(FILES.map((file) => file.path)).toContain("packages/stats/server/src/ingest.ts")
    // 两次事故现场同样必须在集合里。
    expect(FILES.map((file) => file.path)).toContain("packages/opencode/src/tool/read.ts")
    expect(FILES.map((file) => file.path)).toContain("packages/opencode/src/tool/mcp-websearch.ts")
  })

  test("检测器确实认得出违规写法(自我变异)", () => {
    const violation = "yield* Stream.runForEachWhile(response.stream, (chunk) => Effect.sync(() => true))"
    const benign = "yield* Stream.runForEach(response.stream, (chunk) => Effect.sync(() => {}))"
    expect(CALL.test(violation)).toBe(true)
    expect(CALL.test(benign)).toBe(false)
    expect(MENTION.test(violation)).toBe(true)
  })

  // ── 禁令本体 ──────────────────────────────────────────────────────────────

  test("git 可见的 TS 生产源码零处调用 Stream.runForEachWhile", () => {
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
