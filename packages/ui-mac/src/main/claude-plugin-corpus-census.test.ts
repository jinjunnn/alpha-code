// `#826` / `#848` —— 真实 Claude 插件语料的**规模与字节保真闸**
// (ADR-040 「Bundle 是唯一形态」的地基数字)。
//
// 这道闸守两件事,少一件另一件就没有意义:
//
// ① **语料里的 `.mcp.json` 必须是原样字节。** 生成器原先把它归进「占位」档(只留 size/mode),
//    于是这份语料在结构上**表示不了**「一份 `.mcp.json` 声明了几个 server」—— 而每个 server
//    在 Bundle 里是一个独立组件。用这把丢了刻度的尺子量出来的组件规模只能是个下界,
//    再拿下界去定信封上限,定出来的界本身就是错的。
//
// ② **组件规模的口径必须钉死。** 「一个插件有几个组件」随口径剧烈变化:
//    把今天**没有 profile** 的种类(`commands/`、`hooks/`)算进去,同一份语料给出
//    「7/62 超过 16、最大 22」;只算今天合法的四个 profile,给出「0/62 超过 16、最大 13」。
//    两个数都对,口径不同 —— 所以口径必须是可执行的断言,不是散文。
//
// ── 为什么断言落在**摊开后的目录树**上,而不是夹具 JSON 的字段上 ──────────────────
// 语料的全部消费者读的都是 `materializeCorpus()` 摊出来的**真目录**。只断言 JSON 里
// 「有没有 text 字段」,等于自己拼一条等价链:摊开那一步把 text 丢掉照样全绿。
// 所以主判据是「从摊开的树里读出来的字节」;JSON 字段那一条只作为**具名**降级形态的补充。
//
// ── 期望值从哪来(不能是被测对象自己)────────────────────────────────────────────
// 下面所有字面量都来自**独立一轴**:在 `~/.claude/plugins/marketplaces` 上直接用 Python
// 数一遍(不同语言、不同数据源、不读仓内夹具)。本文件从夹具算,两轴对上才算数。
// 口径与逐插件明细见 docs/architecture/claude-plugin-corpus-component-scale.md。

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { afterAll, describe, expect, test } from "bun:test"

import { loadCorpusFixture, materializeCorpus, pluginRootsIn } from "../../test-component/claude-plugin-corpus.fixture"
import { agentMdToEntry } from "./agent-md-entry"

const corpus = materializeCorpus()
afterAll(corpus.cleanup)

const rel = (abs: string): string => path.relative(corpus.root, abs)

function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return []
  const out: string[] = []
  const walk = (abs: string): void => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = path.join(abs, e.name)
      if (e.isDirectory()) walk(child)
      else if (e.isFile()) out.push(child)
    }
  }
  walk(dir)
  return out.sort()
}

// ── 组件口径(v1)──────────────────────────────────────────────────────────────────
// 今天合法的 profile 只有四个:skill / agent / mcp-local / mcp-remote。
//   skill      ← <root>/skills/<name>/SKILL.md
//   agent      ← <root>/agents/**/*.md
//   mcp-local  ← <root>/.mcp.json 里声明了 `command` 的 server
//   mcp-remote ← <root>/.mcp.json 里声明了 `url` 的 server
// 不计入:commands/**、hooks/**(今天没有任何 profile 描述得了它们)。

type McpShape = "wrapped" | "bare" | "malformed" | "absent"

/** 读一个插件根的 `.mcp.json`,交出它声明的 server 与**它用的是哪种摆法**。 */
function mcpServersOf(root: string): { shape: McpShape; servers: Array<{ name: string; profile: string }> } {
  const file = path.join(root, ".mcp.json")
  if (!fs.existsSync(file)) return { shape: "absent", servers: [] }
  const raw = fs.readFileSync(file)
  let doc: unknown
  try {
    doc = JSON.parse(raw.toString("utf8"))
  } catch {
    // 语料里真的有一份不是合法 JSON 的 `.mcp.json`(见 G5)。**不猜**它想声明什么:
    // 猜就是替别人写文法。它按 0 个 server 计,并在 G5 里被具名点出来。
    return { shape: "malformed", servers: [] }
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return { shape: "malformed", servers: [] }
  const outer = doc as Record<string, unknown>
  const inner = outer["mcpServers"]
  // 实测:22 份里 9 份有 `mcpServers` 包裹层,12 份把 server 直接摆在顶层。
  // 只读 `mcpServers` 的实现会把 19 个 server 数成 7 个 —— 那正是「观测手段自己有盲区」。
  const wrapped = typeof inner === "object" && inner !== null && !Array.isArray(inner)
  const map = (wrapped ? inner : outer) as Record<string, unknown>
  const servers: Array<{ name: string; profile: string }> = []
  for (const name of Object.keys(map).sort()) {
    const spec = map[name]
    if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
      servers.push({ name, profile: "unknown-shape" })
      continue
    }
    const s = spec as Record<string, unknown>
    servers.push({ name, profile: "command" in s ? "mcp-local" : "url" in s ? "mcp-remote" : "unknown-shape" })
  }
  return { shape: wrapped ? "wrapped" : "bare", servers }
}

type Census = {
  plugin: string
  skills: number
  agents: number
  servers: Array<{ name: string; profile: string }>
  shape: McpShape
  commands: number
  hooks: number
  /** 四个合法 profile 口径下的组件数。 */
  components: number
  /** 把今天没有 profile 的种类也算进去(= ADR-040 §6 那个数的口径)。 */
  inflated: number
}

const CENSUS: Census[] = pluginRootsIn(corpus.root)
  .map((root) => {
    const skillsDir = path.join(root, "skills")
    const skills = (fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir).sort() : []).filter((n) =>
      fs.existsSync(path.join(skillsDir, n, "SKILL.md")),
    )
    const agents = filesUnder(path.join(root, "agents")).filter((p) => p.endsWith(".md"))
    const commands = filesUnder(path.join(root, "commands"))
    const hooks = filesUnder(path.join(root, "hooks"))
    const { shape, servers } = mcpServersOf(root)
    const components = skills.length + agents.length + servers.length
    return {
      plugin: rel(root),
      skills: skills.length,
      agents: agents.length,
      servers,
      shape,
      commands: commands.length,
      hooks: hooks.length,
      components,
      inflated: components + commands.length + hooks.length + (shape === "absent" ? 0 : 1) - servers.length,
    }
  })
  .sort((a, b) => (a.plugin < b.plugin ? -1 : 1))

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

describe("G1 `.mcp.json` 在语料里是**原样字节**,没有被降级成只剩 size/mode", () => {
  const mcpFiles = (() => {
    const out: string[] = []
    const walk = (abs: string): void => {
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        const child = path.join(abs, e.name)
        if (e.isDirectory()) walk(child)
        else if (e.isFile() && e.name === ".mcp.json") out.push(child)
      }
    }
    walk(corpus.root)
    return out.sort()
  })()

  test("摊开的语料树里有 22 份 `.mcp.json`,合计 3704 字节", () => {
    expect(mcpFiles.length).toBe(22)
    expect(mcpFiles.reduce((n, p) => n + fs.statSync(p).size, 0)).toBe(3704)
  })

  // 这一条才是「字节是原样的」。占位档摊出来是 `Buffer.alloc(size, 0x61)`(全 'a'),
  // 体积一模一样、路径一模一样、JSON 里也照样有这个键 —— 只有内容哈希会变。
  // 期望值来自独立一轴:在 ~/.claude/plugins/marketplaces 上用 Python 算的同一个聚合哈希。
  test("22 份 `.mcp.json` 的字节聚合哈希 == 独立一轴在真实语料上算出的值", () => {
    const lines = mcpFiles.map((p) => `${rel(p)}\u0000${crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")}`)
    expect(crypto.createHash("sha256").update(lines.join("\n")).digest("hex")).toBe(
      "13582264113e9d7de3659ebf4f52e5ccec010033c422c496975a940c4b77b375",
    )
  })

  test("没有任何一份 `.mcp.json` 是占位填充字节", () => {
    const filler = mcpFiles.filter((p) => {
      const buf = fs.readFileSync(p)
      return buf.length > 0 && buf.every((b) => b === 0x61)
    })
    expect(filler.map(rel)).toEqual([])
  })

  test("夹具 JSON 里 22 条 `.mcp.json` 全部带 text、无一条只剩 size", () => {
    const entries = loadCorpusFixture().entries.filter((e) => e.path.endsWith("/.mcp.json") || e.path === ".mcp.json")
    expect(entries.length).toBe(22)
    expect(entries.filter((e) => !("text" in e)).map((e) => e.path)).toEqual([])
  })
})

describe("G2 `.mcp.json` 的 server 清单(每个 server = 一个组件)", () => {
  // 逐插件的期望值来自独立一轴。它同时钉住三件事:server 名字、profile 归类、以及
  // **两种摆法都被读到**(只认 `mcpServers` 的实现会在这里少 12 行)。
  const EXPECTED: Array<[string, string[]]> = [
    ["claude-for-financial-services/plugins/partner-built/lseg", ["lseg:mcp-remote"]],
    ["claude-for-financial-services/plugins/partner-built/spglobal", ["spglobal:mcp-remote"]],
    ["claude-for-financial-services/plugins/vertical-plugins/financial-analysis", []],
    ["claude-for-financial-services/plugins/vertical-plugins/investment-banking", []],
    ["claude-for-financial-services/plugins/vertical-plugins/private-equity", []],
    ["claude-plugins-official/external_plugins/asana", ["asana:mcp-remote"]],
    ["claude-plugins-official/external_plugins/context7", ["context7:mcp-local"]],
    ["claude-plugins-official/external_plugins/discord", ["discord:mcp-local"]],
    ["claude-plugins-official/external_plugins/fakechat", ["fakechat:mcp-local"]],
    ["claude-plugins-official/external_plugins/firebase", ["firebase:mcp-local"]],
    ["claude-plugins-official/external_plugins/github", ["github:mcp-remote"]],
    ["claude-plugins-official/external_plugins/gitlab", ["gitlab:mcp-remote"]],
    ["claude-plugins-official/external_plugins/greptile", ["greptile:mcp-remote"]],
    ["claude-plugins-official/external_plugins/imessage", ["imessage:mcp-local"]],
    ["claude-plugins-official/external_plugins/laravel-boost", ["laravel-boost:mcp-local"]],
    ["claude-plugins-official/external_plugins/linear", ["linear:mcp-remote"]],
    ["claude-plugins-official/external_plugins/playwright", ["playwright:mcp-local"]],
    ["claude-plugins-official/external_plugins/serena", ["serena:mcp-local"]],
    ["claude-plugins-official/external_plugins/telegram", ["telegram:mcp-local"]],
    ["claude-plugins-official/external_plugins/terraform", ["terraform:mcp-local"]],
    ["claude-plugins-official/plugins/example-plugin", ["example-server:mcp-remote"]],
    ["tide-plugin", ["tide:mcp-remote"]],
  ]

  test("逐插件的 server 名字与 profile 归类,与独立一轴逐字相同", () => {
    const actual = CENSUS.filter((c) => c.shape !== "absent").map(
      (c) => [c.plugin, c.servers.map((s) => `${s.name}:${s.profile}`)] as [string, string[]],
    )
    expect(actual).toEqual(EXPECTED)
  })

  test("合计 19 个 server = 10 个 mcp-local + 9 个 mcp-remote,零个形状不明", () => {
    const all = CENSUS.flatMap((c) => c.servers)
    expect(all.length).toBe(19)
    expect(all.filter((s) => s.profile === "mcp-local").length).toBe(10)
    expect(all.filter((s) => s.profile === "mcp-remote").length).toBe(9)
    expect(all.filter((s) => s.profile === "unknown-shape")).toEqual([])
  })

  // 只读 `mcpServers` 的实现在真实语料上会漏掉 12/19 个 server —— 这不是理论风险,
  // 是这份语料里**实际的多数形状**。把两种摆法的分布钉住,免得有人「简化」掉一支。
  test("摆法分布:9 份带 `mcpServers` 包裹层 / 12 份直接摆顶层 / 1 份不是合法 JSON", () => {
    const byShape = (s: McpShape): number => CENSUS.filter((c) => c.shape === s).length
    expect(byShape("wrapped")).toBe(9)
    expect(byShape("bare")).toBe(12)
    expect(byShape("malformed")).toBe(1)
    const wrappedServers = CENSUS.filter((c) => c.shape === "wrapped").reduce((n, c) => n + c.servers.length, 0)
    expect(wrappedServers).toBe(7)
  })
})

describe("G3 组件规模分布(四个合法 profile 口径)", () => {
  test("62 个插件根", () => {
    expect(CENSUS.length).toBe(62)
  })

  test("超过 16 的插件数 0 / 最大 13 / 中位数 2 / 合计 221 个组件", () => {
    const counts = CENSUS.map((c) => c.components)
    expect(counts.filter((c) => c > 16).length).toBe(0)
    expect(Math.max(...counts)).toBe(13)
    expect(median(counts)).toBe(2)
    expect(counts.reduce((a, b) => a + b, 0)).toBe(221)
  })

  test("221 = 159 skill + 43 agent + 10 mcp-local + 9 mcp-remote", () => {
    expect(CENSUS.reduce((n, c) => n + c.skills, 0)).toBe(159)
    expect(CENSUS.reduce((n, c) => n + c.agents, 0)).toBe(43)
    expect(CENSUS.reduce((n, c) => n + c.servers.length, 0)).toBe(19)
  })

  test("最大的五个插件逐个点名(只断言一个 max,写死一个数就能满足)", () => {
    const top = [...CENSUS].sort((a, b) => b.components - a.components || (a.plugin < b.plugin ? -1 : 1)).slice(0, 5)
    expect(top.map((c) => `${c.plugin}=${c.components}`)).toEqual([
      "claude-for-financial-services/plugins/vertical-plugins/financial-analysis=13",
      "claude-for-financial-services/plugins/agent-plugins/pitch-agent=12",
      "tide-plugin=12",
      "claude-for-financial-services/plugins/vertical-plugins/private-equity=10",
      "claude-plugins-official/plugins/plugin-dev=10",
    ])
  })
})

describe("G4 口径本身:今天没有 profile 的种类单独列出,**不**计入组件数", () => {
  test("commands 22 个插件 / 100 个文件;hooks 12 个插件 / 31 个文件", () => {
    expect(CENSUS.filter((c) => c.commands > 0).length).toBe(22)
    expect(CENSUS.reduce((n, c) => n + c.commands, 0)).toBe(100)
    expect(CENSUS.filter((c) => c.hooks > 0).length).toBe(12)
    expect(CENSUS.reduce((n, c) => n + c.hooks, 0)).toBe(31)
  })

  // 这一条是本文件里最重要的一条:它让**口径混淆**变红。
  // 把没有 profile 的种类算进来(整份 `.mcp.json` 算 1 个),同一份语料给出
  // 「7/62 超过 16、最大 22、中位数 3」—— 那正是 ADR-040 §6 登记的数。
  // 两个数都对,但它们回答的不是同一个问题;谁把两者混在一起用,这里当场红。
  test("换成「含 commands/hooks、整份 .mcp.json 算 1 个」的旧口径 ⇒ 7/62 超过 16、最大 22、中位数 3", () => {
    const inflated = CENSUS.map((c) => c.inflated)
    expect(inflated.filter((c) => c > 16).length).toBe(7)
    expect(Math.max(...inflated)).toBe(22)
    expect(median(inflated)).toBe(3)
  })

  test("两个口径给出的答案确实不同(否则上面两条一起写死也能满足)", () => {
    const legal = CENSUS.map((c) => c.components)
    const inflated = CENSUS.map((c) => c.inflated)
    expect(legal.filter((c) => c > 16).length).not.toBe(inflated.filter((c) => c > 16).length)
    expect(Math.max(...legal)).toBeLessThan(Math.max(...inflated))
  })
})

describe("G5 语料里真实存在的两个边角,必须具名,不许被平均掉", () => {
  const FA = "claude-for-financial-services/plugins/vertical-plugins/financial-analysis"

  test("有一份 `.mcp.json` 不是合法 JSON —— 它按 0 个 server 计,而不是被当成不存在", () => {
    const row = CENSUS.find((c) => c.plugin === FA)!
    expect(row.shape).toBe("malformed")
    expect(row.servers).toEqual([])
    expect(() => JSON.parse(fs.readFileSync(path.join(corpus.root, FA, ".mcp.json"), "utf8"))).toThrow()
  })

  // 「0/62 超过 16」这句话**只在这份文件坏着的时候成立**。它的字节里躺着 12 个 https server;
  // 修好一个逗号,这个插件就是 13 + 12 = 25 个组件,直接越过 16。
  // 上限票拿走「最大 13」而不知道这一条,等于拿一个偶然值定界。
  test("那份坏文件的字节里声明了 12 个 https server ⇒ 它若可解析,该插件是 25 个组件", () => {
    const text = fs.readFileSync(path.join(corpus.root, FA, ".mcp.json"), "utf8")
    expect((text.match(/"url"\s*:\s*"https:\/\//g) ?? []).length).toBe(12)
    const row = CENSUS.find((c) => c.plugin === FA)!
    expect(row.components).toBe(13)
    expect(row.components + 12).toBe(25)
    expect(row.components + 12).toBeGreaterThan(16)
  })

  test("语料里有 2 个 SKILL.md 不属于任何带清单的插件根(无清单插件),它们不在这 62 个里", () => {
    const all: string[] = []
    const walk = (abs: string): void => {
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        const child = path.join(abs, e.name)
        if (e.isDirectory()) walk(child)
        else if (e.isFile() && e.name === "SKILL.md") all.push(child)
      }
    }
    walk(corpus.root)
    const roots = pluginRootsIn(corpus.root)
    const orphans = all.filter((p) => !roots.some((r) => p.startsWith(`${r}${path.sep}`))).map(rel).sort()
    expect(all.length).toBe(162)
    expect(orphans).toEqual([
      "claude-plugins-official/plugins/receipts/skills/receipts/SKILL.md",
      "claude-plugins-official/plugins/session-report/skills/session-report/SKILL.md",
    ])
    // 62 个插件根里数到的 skill 组件 159 + 无清单插件 2 + 非标准布局 1 = 162。
    expect(CENSUS.reduce((n, c) => n + c.skills, 0) + orphans.length + 1).toBe(162)
  })
})

// ── G6:这份语料**整体**的保真档位 ─────────────────────────────────────────────────
//
// 上面五组守的是 `.mcp.json` 这一格。但生成器的分档是**全局**的:一份白名单决定谁逐字、
// 谁只剩 size/mode。只钉住自己关心的那一格,等于让下一个人重蹈同一个覆辙 ——
// 他会从这份语料里量出一个**字节层面的数**,而那一格的字节根本是假的。
//
// 所以这一组把**完整分类**钉死:白名单是哪三个名字、被降级的是哪些扩展名各几个,
// 以及一条最重要的性质 —— **占位档的 size 是忠实的,content 是已知假的**。
// 这两句话决定了哪些下游数字可信:
//   可信(名字/存在性/体积/可执行位/计数):文件数、总字节、单文件最大字节、路径深度;
//   不可信(内容):任何需要**解析**这些文件才能得出的数(frontmatter、脚本内容、清单条目)。
// 拿占位档的字节去解析,得到的不是「下界」,是**一个假的零** —— 那更坏。
describe("G6 语料的保真档位:谁逐字、谁只剩 size/mode", () => {
  const fixture = loadCorpusFixture()
  const verbatim = fixture.entries.filter((e) => "text" in e)
  const placeholder = fixture.entries.filter((e) => !("text" in e))

  test("逐字白名单恰好是三个固定文件名 + plugin-level agent + marketplace 根 LICENSE,条数逐类点名", () => {
    const pluginRoots = fixture.entries
      .filter((e) => e.path.endsWith("/.claude-plugin/plugin.json"))
      .map((e) => e.path.slice(0, -"/.claude-plugin/plugin.json".length))
    const byClass = new Map<string, number>()
    const unknown: string[] = []
    for (const e of verbatim) {
      const base = e.path.split("/").pop()!
      const cls =
        base === ".mcp.json"
          ? ".mcp.json"
          : base === "SKILL.md"
            ? "SKILL.md"
            : base === "plugin.json"
              ? "plugin.json"
              : pluginRoots.some((root) => e.path.startsWith(`${root}/agents/`) && e.path.endsWith(".md"))
                ? "plugin-level agents/**/*.md"
                : e.path.split("/").length === 2 && /^LICENSE/.test(base)
                  ? "marketplace root LICENSE*"
                  : undefined
      if (!cls) unknown.push(e.path)
      else byClass.set(cls, (byClass.get(cls) ?? 0) + 1)
    }
    expect(unknown).toEqual([])
    expect([...byClass.entries()].sort()).toEqual([
      [".mcp.json", 22],
      ["SKILL.md", 162],
      ["marketplace root LICENSE*", 3],
      ["plugin-level agents/**/*.md", 43],
      ["plugin.json", 62],
    ])
    expect(verbatim.length).toBe(292)
  })

  test("被降级成 size/mode 的 596 条,按扩展名逐类点名(新增一类而没人复核即红)", () => {
    const ext = (p: string): string => {
      const base = p.split("/").pop()!
      if (base.startsWith(".") && base.split(".").length === 2) return base
      const dot = base.lastIndexOf(".")
      return dot > 0 ? base.slice(dot) : ""
    }
    const hist = new Map<string, number>()
    for (const e of placeholder) hist.set(ext(e.path), (hist.get(ext(e.path)) ?? 0) + 1)
    expect([...hist.entries()].sort()).toEqual([
      ["", 51],
      [".example", 1],
      [".gcs-sha", 1],
      [".gitignore", 5],
      [".html", 5],
      [".jpg", 1],
      [".js", 7],
      [".json", 38],
      [".lock", 4],
      [".md", 309],
      [".mjs", 33],
      [".npmrc", 4],
      [".png", 4],
      [".ps1", 3],
      [".py", 51],
      [".sh", 23],
      [".ts", 5],
      [".txt", 7],
      [".yaml", 40],
      [".yml", 4],
    ])
    expect(placeholder.length).toBe(596)
  })

  // 「size 忠实、content 已知假」不是一句自我介绍,是两条可执行的断言。
  // 少了前一条,基于体积的界会悄悄错;少了后一条,会有人把 'aaaa…' 当成真内容去解析。
  test("占位档:摊出来的体积**逐字节等于**记录值,而内容**全部是**已知的填充字节", () => {
    const sizeMismatch: string[] = []
    const notFiller: string[] = []
    for (const e of placeholder) {
      const abs = path.join(corpus.root, e.path)
      const buf = fs.readFileSync(abs)
      if (buf.length !== (e as { size: number }).size) sizeMismatch.push(e.path)
      if (buf.length > 0 && !buf.every((b) => b === 0x61)) notFiller.push(e.path)
    }
    expect(sizeMismatch).toEqual([])
    expect(notFiller).toEqual([])
    expect(placeholder.reduce((n, e) => n + (e as { size: number }).size, 0)).toBe(6374353)
  })

  // 生成器抬头声明「.git / node_modules / __pycache__ 在技能目录内 0 命中」,
  // 且「真实语料 symlink 全域 0 例」。全称命题必须跑一遍,不能当散文留着。
  test("跳过规则的前提为真:摊开的树里没有 symlink,也没有被跳过的目录名", () => {
    const symlinks: string[] = []
    const skipped: string[] = []
    const walk = (abs: string): void => {
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        const child = path.join(abs, e.name)
        if (e.isSymbolicLink()) symlinks.push(rel(child))
        else if (e.isDirectory()) {
          if ([".git", "node_modules", "__pycache__"].includes(e.name)) skipped.push(rel(child))
          walk(child)
        }
      }
    }
    walk(corpus.root)
    expect(symlinks).toEqual([])
    expect(skipped).toEqual([])
  })
})

describe("G7 `#848`:plugin-level agent 是真实字节,不是 size/mode 占位档", () => {
  const fixture = loadCorpusFixture()
  const pluginRoots = fixture.entries
    .filter((e) => e.path.endsWith("/.claude-plugin/plugin.json"))
    .map((e) => e.path.slice(0, -"/.claude-plugin/plugin.json".length))
  const agentEntries = fixture.entries
    .filter((e) => pluginRoots.some((root) => e.path.startsWith(`${root}/agents/`) && e.path.endsWith(".md")))
    .sort((a, b) => (a.path < b.path ? -1 : 1))
  const agentTextEntries = agentEntries.filter((e): e is typeof e & { text: string } => "text" in e)

  test("43 份 agent 合计 169124 字节,且每一份都携带 text", () => {
    expect(agentEntries.length).toBe(43)
    expect(agentTextEntries.length).toBe(43)
    expect(agentTextEntries.reduce((n, e) => n + Buffer.byteLength(e.text), 0)).toBe(169124)
  })

  test("43 份 agent 的路径+逐文件 sha256 聚合值等于独立真实语料轴", () => {
    expect(agentTextEntries.length).toBe(43)
    const lines = agentTextEntries.map((e) => {
      return `${e.path}\u0000${crypto.createHash("sha256").update(e.text).digest("hex")}`
    })
    expect(crypto.createHash("sha256").update(lines.join("\n")).digest("hex")).toBe(
      "fa30d60c7e60a8c1789d457da6f50627b67d6b3725e4e0d31369ba7b84d433f6",
    )
  })

  test("摊开的目录树仍逐字可读,没有退回全 `a` 填充", () => {
    expect(agentTextEntries.length).toBe(43)
    const filler: string[] = []
    for (const entry of agentTextEntries) {
      const buf = fs.readFileSync(path.join(corpus.root, entry.path))
      if (buf.length > 0 && buf.every((b) => b === 0x61)) filler.push(entry.path)
      expect(buf.equals(Buffer.from(entry.text, "utf8"))).toBe(true)
    }
    expect(filler).toEqual([])
  })

  test("生产 agentMdToEntry 独立复算:9/43 通过;tools 23、effort 7、块式 frontmatter 4 被拒", () => {
    expect(agentTextEntries.length).toBe(43)
    const results = agentTextEntries.map((e) => agentMdToEntry(e.text))
    const reasons = results.filter((r) => !r.ok).map((r) => r.reason)
    expect(results.filter((r) => r.ok).length).toBe(9)
    expect(reasons.filter((r) => r === "unsupported frontmatter key: tools").length).toBe(23)
    expect(reasons.filter((r) => r === "unsupported frontmatter key: effort").length).toBe(7)
    expect(reasons.filter((r) => r.startsWith("unexpected indentation at frontmatter line:")).length).toBe(4)
    expect(reasons.length).toBe(34)
  })
})
