// #647 —— 闸门文件登记簿的**完备性**闸。
//
// 背景(这一轮的教训,写下来免得再犯):#647 修完 `readBoundedBody` 之后,我们发现
// 「整套 suite 的地板抓不到删掉一个 N 条用例的文件」,于是给 ui-mac 的类级闸加了点名下界。
// 然后**只加了那一个** —— ext 的 REQ-062 drift lock(`prompt-rebrand.test.ts`,26 条)照旧
// 只被整包地板 100 罩着,而 ext 排除它还剩 106 条,删掉它 CI 静默全绿。
// 同一条规律,只应用了一次。这就是本文件存在的理由:**让「又冒出一个闸门文件却没登记」变成红灯**,
// 而不是靠下一个人记得。
//
// 本文件有**四层**检查,一层比一层不依赖措辞:
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
// ④ 子进程宿主(`#893`,**结构性**,与文件名和措辞都无关)。仓里有一类测试文件:它自己只声明
//    一两条 `test()`,真正的判据是它 `Bun.spawn` 出来的一个**嵌套 `bun test`** 子进程 —— 被跑的
//    那个文件(仓内惯例叫 `*.cases.ts`)**不在任何整包计数里**(`bun test src` 收 `*.test.ts`,
//    收不到 `*.cases.ts`,而 `test-component/` 整个目录还在 `src` 之外)。
//    后果:删掉一个宿主,ui-mac 计数只掉 1~2 条(3800 → 3799,地板 3000 照样过),而子进程里
//    十几到几十条断言**一次全没**。整包地板对这一类的丢失是**结构性失明**的。
//    因此这一层的规则是:**凡起嵌套 `bun test` 的宿主,必须登记进 `scripts/gate-files.tsv`**。
//    这里**没有 NOT_GATES 出口** —— 「它算不算闸门」在这一层不是问题,「删掉它会不会红」才是,
//    而只有登记能回答后者(登记 = 单独点名 + 精确条数,文件消失当场红)。
//    反向那一半同样存在:每个 `*.cases.ts` 必须**至少被一个已登记的宿主**跑到。删掉宿主、
//    留下 cases 文件 ⇒ 孤儿 ⇒ 红。
//    判据本身有正/反向自检(合成正例必须命中、只提名字不 spawn 与 spawn 别的程序必须不命中),
//    否则一个退化成恒假的谓词会让这一整层空对空全绿。
//
// ⚠️ 诚实边界:
//   · ①命名不含那些词、且②③④都没命中的闸门文件,本文件**检测不到**。登记簿因此仍是**显式**
//     清单,不是自动推导的结果 —— 新写闸门时该登记还是要登记。
//   · ④的宿主判据认的是 `process.execPath` + `"test"` 这个 argv 形状。换个别的方式拼出
//     同一个子进程(比如自己算 bun 可执行文件路径)就绕得过去;此时只剩反向那一半兜着
//     —— 而反向那半认 `*.cases.ts` 这个命名。两半同时绕开才彻底隐形。
//   · 它不判断登记的下界取得对不对,只判断「有没有被分类」。
//
// 保证本身(删掉本文件会失去什么):新增的闸门文件不再被强制分类,委派关系不再被强制闭合,
// 新写的子进程宿主重新默认在册外(而整包地板看不见它们),同一个路径可以同时躺在「是闸门」
// 和「不是闸门」两张表里而无人吭声 —— 登记簿会随时间腐烂,且腐烂时没有任何别的东西会红。
// 本文件自身也登记在 `gate-files.tsv` 里,所以它不能被静默删掉。

import { existsSync, readFileSync } from "node:fs"
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
 *
 * 这张表与 `scripts/gate-files.tsv` **互斥**(`#893`):同一个路径同时躺在两边,等于登记簿对
 * 自己的一致性不设防 —— 下一个人据本表把它从 tsv 里删掉时,不会有任何东西变红。互斥由下面
 * 具名的一条测试执行。
 */
const NOT_GATES: Record<string, string> = {
  "packages/ui-mac/src/main/ext-bundle-lock.test.ts":
    "REQ-100 bundle 锁的**功能**单测(互斥/争用/死 pid/心跳超时)。删掉是 bundle-lock 这个功能少测了,不是某条仓库级保证消失。",
  "packages/ui-mac/src/main/alpha-auth-clock.test.ts":
    "只是文件名里的 'clock' 撞上了 'lock'。内容是刷新时机的纯逻辑单测,与闸门无关。",
  // `#893` 移除 `renderer/alpha-ui/model-contract.test.ts`:它同时登记在 gate-files.tsv 里(两处
  // 自相矛盾)。裁决 = **它是闸门**,本表的条目已过期。理由:那条注释写于它还只是
  // `createModelContract` 输入→输出单测的年代;`#857`/`#882`/`#881` 之后它断言的是**自己模块
  // 之外**的东西 —— 引擎侧的目录就绪协议(`catalog.updated` 唤醒、兜底轮询闩死在 250ms、
  // 失败经 loadEngineModelsWithRetry 接成 1/2/4/8s、就绪标的发标时刻与条数)。按本仓的操作性
  // 判据(断言自己模块之外的东西 ⇒ 没有别的测试会因为它消失而变红),它是闸门:删掉它,
  // 「把取数改回固定计时器轮询」「把 250ms 改成 60s」「拿发起时刻冒充就绪时刻」全都不会有
  // 东西变红,而 ui-mac 计数 3800→3786 仍远高于地板 3000。
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
    // `--cached` 会把**已从盘上删掉但还在 index 里**的文件也列出来 —— 而「删掉一个闸门文件」
    // 正是本闸存在的理由,也就是说这个状态一定会出现。不过滤的话:下面按清单 readFileSync
    // 会以 ENOENT 抛在模块加载期,整个文件 `0 pass / 1 fail`,报的是文件系统错误而不是
    // 「谁被删了」。过滤之后,同一状态由具名的那条(登记簿指向不存在的测试文件)报出来。
    .filter((path) => existsSync(join(REPO_ROOT, path)))
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

/**
 * `#893` ④ 子进程宿主的**结构性**判据:这个文件起了一个**嵌套的 `bun test`**。
 * 认的是 argv 形状 `[process.execPath, "test", …]`,不认文件名、不认注释措辞 ——
 * 起子进程本身不算(`git` / `bash scripts/*.sh` 的宿主到处都是,它们跑的东西**在**整包计数里)。
 */
function spawnsNestedTestRun(source: string): boolean {
  return /Bun\.spawn(?:Sync)?\s*\(/.test(source) && /process\.execPath\s*,\s*["']test["']/.test(source)
}

/**
 * 剥掉整行注释:静态判据约束的是**代码**,注释里允许指名别的文件(仓内 terminal-rail.test.ts
 * 的 `codeLines` 同款理由)。少了这一步,一句解释性的抬头就能把闸门关掉 —— 见下面 SELF。
 */
function codeLines(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
    .join("\n")
}

/**
 * 本文件必须把**自己**排除在被扫描的宿主之外。这不是洁癖,是实测:
 *   · 上面那条谓词的**正例合成夹具**是代码(剥注释剥不掉),于是本文件把自己判成宿主;
 *   · 而 `hostsOf` 按文件名找宿主 —— 本文件抬头里为了解释边界写了一句
 *     `new-session-workspace.cases.ts`,于是那个 cases 文件「有宿主了」,
 *     **孤儿闸对它永久失效**:把真宿主连同登记行一起删掉,本闸 14 pass / 0 fail。
 * 拿被测对象自己的源码去喂它自己的谓词 = 自指等价链,一起改错就一起自洽。
 * 排除本文件不留洞:它自己登记在 gate-files.tsv 里(删掉即红),而真有 cases 文件只被本文件
 * 跑到时,`hostsOf` 会算它没有已登记宿主 —— 那是**判红**方向,fail-closed。
 */
const SELF = "packages/ui-mac/src/main/gate-file-registry.test.ts"

const SOURCE_OF = new Map(
  IN_SCOPE_TESTS.map((path) => [path, codeLines(readFileSync(join(REPO_ROOT, path), "utf8"))] as const),
)
const SUBPROCESS_HOSTS = IN_SCOPE_TESTS.filter(
  (path) => path !== SELF && spawnsNestedTestRun(SOURCE_OF.get(path)!),
)

/**
 * 反向那一半:仓内承载断言、但**整包计数收不到**的文件。
 * `bun test` 只收 `*.test.ts` / `*.spec.ts`,收不到 `*.cases.ts`;`test-component/` 还整个在
 * `src` 之外。所以这些文件能不能跑,完全取决于有没有宿主替它们起子进程。
 */
const CASES_IN_SCOPE = ["packages/ui-mac/src/", "packages/ui-mac/test-component/"]
function gitListedCases(): string[] {
  const result = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard", "--", "*.cases.ts"], {
    cwd: REPO_ROOT,
  })
  if (result.exitCode !== 0) throw new Error(`git ls-files 失败:${result.stderr.toString()}`)
  return result.stdout
    .toString()
    .split("\n")
    .filter((path) => path.endsWith(".cases.ts") && CASES_IN_SCOPE.some((prefix) => path.startsWith(prefix)))
}
const CASES_FILES = gitListedCases()

/**
 * 哪些宿主跑得到这个 cases 文件。按文件名匹配,但**要求前面是路径分隔符或引号** ——
 * 少了这个边界,`session-workspace.cases.ts` 会被 `new-session-workspace.cases.ts` 的引用
 * 一起认领,于是真正的宿主被删掉时它仍然「有人跑」。
 */
function hostsOf(casesPath: string): string[] {
  const base = casesPath.split("/").pop()!
  const ref = new RegExp(`(?:^|[/"'\`])${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
  return SUBPROCESS_HOSTS.filter((host) => ref.test(SOURCE_OF.get(host)!))
}

/** 正文里出现的其它测试文件(发现用绊线)。解析成仓库相对路径。 */
const TEST_REF = /[\w./-]*[\w-]+\.test\.tsx?/g

function referencesOf(row: Row): string[] {
  // 同上:登记了一个已被删掉的文件时,报这件事的应该是具名的那条断言,而不是这里抛 ENOENT。
  if (!existsSync(join(REPO_ROOT, row.path))) return []
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

  test("登记簿里的 (workdir,path) 必须唯一(--update 不得同时改写重复行)", () => {
    const seen = new Set<string>()
    const duplicates = REGISTERED.filter((path) => {
      if (seen.has(path)) return true
      seen.add(path)
      return false
    })
    expect(duplicates, `登记簿存在重复路径:${duplicates.join(", ")}`).toEqual([])
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

  // ── `#893` 洞一:两张表必须互斥 ──────────────────────────────────────────────
  // 登记簿说「是闸门」,NOT_GATES 说「不是闸门」,而这两张表在代码里从不相遇 ——
  // 于是同一个路径可以同时躺在两边,谁都不红。后果不是当下漏拦了什么,是**这张表对自己
  // 的一致性不设防**:下一个人据 NOT_GATES 把它从 tsv 里删掉时,不会有任何东西变红。
  test("同一路径不得同时出现在 gate-files.tsv 和 NOT_GATES 里(两张表互斥)", () => {
    const both = REGISTERED.filter((path) => path in NOT_GATES)
    expect(
      both,
      [
        "下列路径同时被登记为闸门、又被写明「不是闸门」。两张表自相矛盾:",
        "  · 是闸门 → 保留 gate-files.tsv 的登记,删掉 NOT_GATES 的条目;",
        "  · 不是闸门 → 删掉 gate-files.tsv 的行,保留 NOT_GATES 的理由。",
        "两边都留着 = 谁都不是权威,而删掉其中任何一边都不会有东西变红。",
      ].join("\n"),
    ).toEqual([])
  })

  // ── `#893` 洞二:子进程宿主默认拒 ────────────────────────────────────────────
  // 这里刻意**不是**「当前这几个宿主都在册」式的枚举 —— 那种写法对新成员默认放行,
  // 下一个同形文件仍然默认在册外。判据从**形状**出发:凡起嵌套 `bun test` 的都得在册。
  test("起嵌套 bun test 的子进程宿主,必须登记在 scripts/gate-files.tsv 里(默认拒,没有 NOT_GATES 出口)", () => {
    const unregistered = SUBPROCESS_HOSTS.filter((path) => !REGISTERED.includes(path))
    expect(
      unregistered,
      [
        "下列测试文件起了一个**嵌套的 `bun test`** 子进程,却没有登记进 scripts/gate-files.tsv。",
        "",
        "为什么这一类必须登记(而不是像 ① 那样可以写进 NOT_GATES 说「我不是闸门」):",
        "被跑的那个文件不在任何整包计数里 —— `bun test src` 收 `*.test.ts`,收不到 `*.cases.ts`,",
        "`test-component/` 还整个在 `src` 之外。删掉宿主,ui-mac 计数只掉 1~2 条(地板 3000 照样过),",
        "而子进程里十几到几十条断言一次全没。整包地板对这一类的丢失是**结构性失明**的,",
        "「它算不算闸门」在这里不是问题,「删掉它会不会红」才是 —— 只有登记能回答后者。",
        "",
        "怎么做:往 scripts/gate-files.tsv 加一行(delegates_to 通常是 '-',因为判据由本文件直接执行),",
        "然后跑 `bash scripts/assert-gate-files.sh --update` 把精确条数写回,让评审读 TSV 的 diff。",
      ].join("\n"),
    ).toEqual([])
  })

  test("每个 *.cases.ts 都必须被至少一个**已登记**的宿主跑到(删掉宿主 = 孤儿 = 红)", () => {
    const orphans = CASES_FILES.filter((path) => !hostsOf(path).some((host) => REGISTERED.includes(host)))
    expect(
      orphans,
      [
        "下列文件承载断言,却没有任何**已登记**的宿主替它起子进程 —— 也就是说它今天根本没在 CI 跑,",
        "或者跑它的那个宿主可以被静默删掉。这是上一条闸的反向那一半:",
        "上一条抓「新写了宿主却没登记」,这一条抓「宿主被删掉、cases 文件留在树上」。",
        "",
        "怎么做:补上宿主并登记它;确实不再需要的 cases 文件请连同宿主一起删掉。",
      ].join("\n"),
    ).toEqual([])
  })

  test("子进程宿主判据自检:合成正例必须命中、合成反例必须不命中,且真实枚举非空", () => {
    // 正例两种写法(单行 argv / 多行 argv),仓内两种都真实存在。
    expect(spawnsNestedTestRun('Bun.spawnSync({ cmd: [process.execPath, "test", p], cwd: d })')).toBe(true)
    expect(spawnsNestedTestRun('Bun.spawnSync({\n  cmd: [\n    process.execPath,\n    "test",\n    p,\n  ],\n})')).toBe(true)
    // 反例①:只在注释里提到 cases 文件名 —— 提到 ≠ 宿主。
    expect(spawnsNestedTestRun("// 判据本体在 test-component/foo.cases.ts")).toBe(false)
    // 反例②③:起了子进程,但跑的不是嵌套 bun test(它们跑的东西**在**整包计数里,或根本不是测试)。
    expect(spawnsNestedTestRun('Bun.spawnSync(["git", "ls-files", "--cached", "--", "*.ts"])')).toBe(false)
    expect(spawnsNestedTestRun('Bun.spawnSync({ cmd: ["bash", "scripts/bun-test-floor.sh", "3000", "."] })')).toBe(false)
    // 真实枚举非空:谓词或 git 枚举退化成空集时,上面两条闸会空对空全绿而不是变红。
    expect(SUBPROCESS_HOSTS.length).toBeGreaterThanOrEqual(25)
    expect(CASES_FILES.length).toBeGreaterThanOrEqual(25)
    // 宿主匹配按文件名做,重名会让匹配张冠李戴(A 的宿主替 B 顶了名)。
    const bases = CASES_FILES.map((path) => path.split("/").pop()!)
    expect(new Set(bases).size, `*.cases.ts 文件名重复:${bases.join(", ")}`).toBe(bases.length)
  })

  // 这条是上面那两条闸的**自指防线**,由本票的绕过实验找出来(不做实验就发不出来):
  // 本文件的正文里必然出现谓词的正例夹具与被讨论的 cases 文件名。若不排除自己,
  // 「本文件」就成了那些 cases 文件的宿主,孤儿闸对它们**永久失效** —— 实测:
  // 把 new-session-workspace 的宿主连同登记行一起删掉,修这条之前本闸 14 pass / 0 fail。
  test("扫描不得把本文件算成宿主(自指:正例夹具与被讨论的文件名都写在这里)", () => {
    expect(SUBPROCESS_HOSTS).not.toContain(SELF)
    for (const path of CASES_FILES) expect(hostsOf(path)).not.toContain(SELF)
    // 排除自己不留洞的前提:本文件自己在册,删掉它照样红。
    expect(REGISTERED).toContain(SELF)
    // 注释里指名一个 cases 文件不算宿主(否则一句解释性的抬头就能替真宿主顶名)。
    expect(codeLines('// 判据在 test-component/foo.cases.ts\nconst x = 1')).not.toContain("foo.cases.ts")
    expect(codeLines(' * 见 test-component/foo.cases.ts\nconst x = 1')).not.toContain("foo.cases.ts")
    expect(codeLines('const p = "test-component/foo.cases.ts"')).toContain("foo.cases.ts")
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
