// `#1381` —— 远程 MCP 服务器真源(读端 + 写端)的判据,与 custom-provider-truth(-write).test.ts 同形:
//   ① I2:真源路径 <casBaseRoot>/mcp-servers/<env>.json 不在可写集任何**固定行**之下 —— 对着生产渲染的 profile 枚举
//      `(allow file-write*` 块里每条规则的 W-id(17 个固定 id;W1 是运行时成员,由 `#1390` 规则 5b 兜),默认 base 与 dev 覆盖 base、
//      XDG_STATE_HOME 两种形态都过;词法判据偏向判「覆盖」。「覆盖」的最终裁判是 seatbelt 本身 —— custom-provider-truth-fence.test.ts
//      对同一个父目录下的兄弟文件真跑过,两个真源在围栏眼里是同一条规则(W2 只罩 env/<env>)。
//   ② 严格读:缺失 = 没有记录(ok、absent、空清单、零日志);坏 JSON / 版本不对 / servers 不是数组 / 字段不合法 / 同名重复 / 多余的键 ⇒
//      ok:false(**不是空数组**)且日志恰一行说得出原因;读错(EISDIR)也拒不当缺失。
//   ③ 写:落盘字节固定字面量、无临时文件残留、原子(rename / write 中途抛 ⇒ 盘上仍是旧内容)、坏记录不落盘(连目录都不建)。
//   ④ 写模块与 main 侧读改写模块**不进 sidecar 的 import 闭包**,读端与生产读取绑定在闭包里 —— 对着生产的闭包工具实测。
// 全平台、electron-free、真文件系统(临时目录)。期望值手写字面量。

import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import { environmentMutableRoot } from "./alpha-environment"
import { customProviderTruthPath } from "./custom-provider-truth"
import { mcpServerTruthPath, readMcpServerTruth, type McpServerRecord } from "./mcp-server-truth"
import { writeMcpServerTruth } from "./mcp-server-truth-write"
import { relativeImportClosure, sidecarSourceFiles } from "./process-fence-write-sites"
import { renderProcessFenceProfile, type ProcessFenceProfileInput } from "./process-fence-profile"

const repoRoot = resolve(import.meta.dir, "../../../..")
const HOME = "/Users/alpha"
const DEFAULT_STATE_ROOT = `${HOME}/Library/Application Support/alpha-code-state`
const OVERRIDE_STATE_ROOT = `${HOME}/dev/alpha-base`
const USER_DATA = `${HOME}/Library/Application Support/ai.opencode.desktop`

function withTemp<T>(run: (dir: string) => T): T {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mcp-servers-")))
  try {
    return run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── I2 ─────────────────────────────────────────────────────────────────────────

type Rule = { id: string; kind: "subpath" | "literal" | "regex"; value: string }

/** 取 `(allow file-write*` 块里每条规则与它的 `; Wn` 注释。解析不出来的行当场抛 —— 手段瞎了不算「没覆盖」。 */
function fileWriteRules(profile: string): Rule[] {
  const lines = profile.split("\n")
  const start = lines.indexOf("(allow file-write*")
  const end = lines.indexOf(")", start)
  if (start < 0 || end < 0) throw new Error("profile has no (allow file-write* … ) block")
  const rules: Rule[] = []
  for (const line of lines.slice(start + 1, end)) {
    const id = /;\s*(W\d+)\b/.exec(line)?.[1]
    if (!id) throw new Error(`file-write line without a W-id comment: ${line}`)
    const found = [...line.matchAll(/\((subpath|literal) "([^"]*)"\)|\(regex #"([^"]*)"\)/g)]
    if (!found.length) throw new Error(`file-write line with no parsable rule: ${line}`)
    for (const m of found) rules.push(m[3] !== undefined ? { id, kind: "regex", value: m[3] } : { id, kind: m[1] as "subpath" | "literal", value: m[2]! })
  }
  return rules
}

/** 词法覆盖判据,**偏向判「覆盖」**(fail-closed):大小写不敏感(APFS)、按路径段比。 */
function covers(rule: Rule, target: string): boolean {
  if (rule.kind === "regex") return new RegExp(rule.value, "i").test(target)
  const v = rule.value.toLowerCase()
  const t = target.toLowerCase()
  if (rule.kind === "literal") return v === t
  const rel = relative(v, t)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

const describeRule = (r: Rule) => `${r.id} ${r.kind} ${r.value}`

const profileFor = (stateRoot: string, env: "prod" | "dev", over: Partial<ProcessFenceProfileInput> = {}) =>
  renderProcessFenceProfile({
    workspaces: [`${HOME}/code-puppy`, `${HOME}/app/alpha-code`],
    alphaGlobalRoot: environmentMutableRoot(env, stateRoot),
    userDataPath: USER_DATA,
    stateHome: USER_DATA,
    roots: { home: HOME, dataHome: `${HOME}/.local/share`, cacheHome: `${HOME}/.cache`, configHome: `${HOME}/.config` },
    egressProxyPort: 4443,
    ...over,
  })

describe("真源位置(I2):<casBaseRoot>/mcp-servers/<env>.json 不在可写集任何固定行之下", () => {
  test("路径 = <casBaseRoot>/mcp-servers/<env>.json;与三个 env 根、cas/、fence-workspaces/、custom-providers/ 同级(相对每个都以 .. 开头)", () => {
    expect(mcpServerTruthPath(DEFAULT_STATE_ROOT, "prod")).toBe("/Users/alpha/Library/Application Support/alpha-code-state/mcp-servers/prod.json")
    expect(mcpServerTruthPath(DEFAULT_STATE_ROOT, "beta")).toBe("/Users/alpha/Library/Application Support/alpha-code-state/mcp-servers/beta.json")
    expect(mcpServerTruthPath(OVERRIDE_STATE_ROOT, "dev")).toBe("/Users/alpha/dev/alpha-base/mcp-servers/dev.json")
    for (const env of ["prod", "beta", "dev"] as const) {
      const truth = mcpServerTruthPath(DEFAULT_STATE_ROOT, env)
      for (const sibling of [
        environmentMutableRoot(env, DEFAULT_STATE_ROOT),
        join(DEFAULT_STATE_ROOT, "cas"),
        join(DEFAULT_STATE_ROOT, "fence-workspaces"),
        join(DEFAULT_STATE_ROOT, "custom-providers"),
      ]) {
        expect(relative(sibling, truth).startsWith(".."), `${env}: ${sibling}`).toBe(true)
      }
      // 与自定义节点真源是同一个父目录下的两个文件,不是同一个文件(两种记录形状不同)
      expect(relative(customProviderTruthPath(DEFAULT_STATE_ROOT, env), truth)).toBe(join("..", "..", "mcp-servers", `${env}.json`))
    }
  })

  test("默认 base 与覆盖 base、两种 XDG_STATE_HOME 形态:没有任何固定行覆盖真源文件或它的目录(逐条规则,W1 除外);对照:W2 罩着 alpha.jsonc", () => {
    for (const [stateRoot, env] of [
      [DEFAULT_STATE_ROOT, "prod"],
      [OVERRIDE_STATE_ROOT, "dev"],
    ] as const) {
      for (const stateHome of [USER_DATA, `${HOME}/.local/state`]) {
        const rules = fileWriteRules(profileFor(stateRoot, env, { stateHome })).filter((r) => r.id !== "W1")
        expect(rules.length, `${stateRoot}/${env}/${stateHome}`).toBeGreaterThanOrEqual(17)
        const truth = mcpServerTruthPath(stateRoot, env)
        const dir = join(stateRoot, "mcp-servers")
        expect(rules.filter((r) => covers(r, truth)).map(describeRule), `truth file ${truth}`).toEqual([])
        expect(rules.filter((r) => covers(r, dir)).map(describeRule), `truth dir ${dir}`).toEqual([])
        expect(rules.filter((r) => covers(r, join(environmentMutableRoot(env, stateRoot), "alpha.jsonc"))).map(describeRule)).toEqual([
          `W2 subpath ${environmentMutableRoot(env, stateRoot)}`,
        ])
      }
    }
  })

  test("控制臂:往 profile 里塞一行罩住状态根,判据当场点名它", () => {
    const profile = profileFor(DEFAULT_STATE_ROOT, "prod")
    const truth = mcpServerTruthPath(DEFAULT_STATE_ROOT, "prod")
    const forged = profile.replace("(allow file-write*\n", `(allow file-write*\n  (subpath "${DEFAULT_STATE_ROOT}") ; W99\n`)
    expect(fileWriteRules(forged).filter((r) => r.id !== "W1" && covers(r, truth)).map(describeRule)).toEqual([`W99 subpath ${DEFAULT_STATE_ROOT}`])
  })
})

// ── 严格读 ───────────────────────────────────────────────────────────────────

const A: McpServerRecord = { name: "my-mcp", url: "https://mcp.example.com/mcp", headers: { "X-Token": "t" } }
const B: McpServerRecord = { name: "deepwiki", url: "https://mcp.deepwiki.com/mcp" }
const AB_BYTES = '{"v":1,"servers":[{"name":"my-mcp","url":"https://mcp.example.com/mcp","headers":{"X-Token":"t"}},{"name":"deepwiki","url":"https://mcp.deepwiki.com/mcp"}]}\n'

function readAt(dir: string, text: string | undefined) {
  const path = join(dir, "mcp-servers", "prod.json")
  if (text !== undefined) {
    mkdirSync(join(dir, "mcp-servers"), { recursive: true })
    writeFileSync(path, text)
  }
  const logs: string[] = []
  const read = readMcpServerTruth(path, { ...fs, log: (l) => void logs.push(l) })
  return { path, read, logs }
}

describe("严格读:缺失 = 没有记录;任何不对 = 「没问出来」(ok:false + 恰一行日志),不是空清单", () => {
  test("缺失 ⇒ ok、absent、空清单、零日志", () => {
    withTemp((dir) => {
      const { read, logs } = readAt(dir, undefined)
      expect(read).toEqual({ ok: true, absent: true, servers: [] })
      expect(logs).toEqual([])
    })
  })

  test("正样本:两条记录逐字读回(键序乱 → 固定键序;没有 headers 就没有那个键)", () => {
    withTemp((dir) => {
      const shuffled = JSON.stringify({
        servers: [
          { headers: { "X-Token": "t" }, url: "https://mcp.example.com/mcp", name: "my-mcp" },
          { url: "https://mcp.deepwiki.com/mcp", name: "deepwiki" },
        ],
        v: 1,
      })
      const { read, logs } = readAt(dir, shuffled)
      expect(read).toEqual({ ok: true, absent: false, servers: [A, B] })
      expect(logs).toEqual([])
    })
  })

  const bad: Array<[string, string, string]> = [
    ["坏 JSON", "{ not json", "not JSON ("],
    ["顶层不是对象", "[]", "not a JSON object"],
    ["版本 2", JSON.stringify({ v: 2, servers: [] }), "unsupported version 2 (expected 1)"],
    ["缺版本", JSON.stringify({ servers: [] }), "unsupported version undefined (expected 1)"],
    ["顶层多余键", JSON.stringify({ v: 1, servers: [], enabled: true }), "unexpected top-level key(s): enabled"],
    ["servers 不是数组", JSON.stringify({ v: 1, servers: {} }), "`servers` is not an array"],
    ["记录不是对象", JSON.stringify({ v: 1, servers: ["x"] }), "servers[0] is not an object"],
    ["name 不是扩展名", JSON.stringify({ v: 1, servers: [{ name: "bad name!", url: "https://x.example/mcp" }] }), 'servers[0].name is not an extension name: "bad name!"'],
    ["url 不是 URL", JSON.stringify({ v: 1, servers: [{ name: "x", url: "mcp.example.com" }] }), 'servers[0].url is not a URL: "mcp.example.com"'],
    ["headers 不是对象", JSON.stringify({ v: 1, servers: [{ name: "x", url: "https://x.example/mcp", headers: ["a"] }] }), "servers[0].headers is not an object"],
    ["headers 值不是字符串", JSON.stringify({ v: 1, servers: [{ name: "x", url: "https://x.example/mcp", headers: { A: 1 } }] }), 'servers[0].headers["A"] is not a string'],
    ["记录多余键(enabled 不归这里)", JSON.stringify({ v: 1, servers: [{ name: "x", url: "https://x.example/mcp", enabled: false }] }), "servers[0] has unexpected key(s): enabled"],
    ["同名重复", JSON.stringify({ v: 1, servers: [B, { ...B }] }), 'servers[1].name duplicates an earlier record: "deepwiki"'],
  ]
  test.each(bad)("%s ⇒ ok:false,reason 点名文件与哪一项,日志恰一行同一原因", (_label, text, reason) => {
    withTemp((dir) => {
      const { path, read, logs } = readAt(dir, text)
      expect(read.ok).toBe(false)
      if (read.ok) throw new Error("unreachable")
      expect(read.reason.startsWith(`${path}: ${reason}`), read.reason).toBe(true)
      expect(logs.length).toBe(1)
      expect(logs[0]!.startsWith(`remote MCP servers: truth file ${path} rejected — ${reason}`), logs[0]).toBe(true)
      expect(logs[0]).toContain('this is "unanswerable", not an empty list')
    })
  })

  test("读错(EISDIR:路径是个目录)⇒ 拒,不当缺失", () => {
    withTemp((dir) => {
      const path = join(dir, "mcp-servers", "prod.json")
      mkdirSync(path, { recursive: true })
      const logs: string[] = []
      const read = readMcpServerTruth(path, { ...fs, log: (l) => void logs.push(l) })
      expect(read.ok).toBe(false)
      if (read.ok) throw new Error("unreachable")
      expect(read.reason).toContain("read failed (EISDIR")
      expect(logs.length).toBe(1)
    })
  })
})

// ── 写端 ─────────────────────────────────────────────────────────────────────

describe("原子写:字节固定、无残留、失败不留半截、坏记录不落盘", () => {
  test("写 → 落盘文本是固定字面量(输入键序乱也一样);目录里没有临时文件;覆盖写整份换;读端读得回", () => {
    withTemp((dir) => {
      const path = join(dir, "mcp-servers", "prod.json")
      const shuffled = [{ headers: { "X-Token": "t" }, url: "https://mcp.example.com/mcp", name: "my-mcp" }, B]
      writeMcpServerTruth(path, shuffled, fs)
      expect(readFileSync(path, "utf8")).toBe(AB_BYTES)
      expect(readdirSync(join(dir, "mcp-servers"))).toEqual(["prod.json"])
      expect(readMcpServerTruth(path, { ...fs, log: () => {} })).toEqual({ ok: true, absent: false, servers: [A, B] })
      writeMcpServerTruth(path, [], fs)
      expect(readFileSync(path, "utf8")).toBe('{"v":1,"servers":[]}\n')
      expect(readdirSync(join(dir, "mcp-servers"))).toEqual(["prod.json"])
    })
  })

  test("rename / writeFileSync 中途抛 ⇒ 盘上仍是旧内容、临时文件收走、错误原样抛;对照:正常 fs 会写", () => {
    withTemp((dir) => {
      const path = join(dir, "prod.json")
      writeMcpServerTruth(path, [A, B], fs)
      const renameFails = { ...fs, renameSync: () => { throw new Error("EROFS: read-only file system") } }
      expect(() => writeMcpServerTruth(path, [], renameFails)).toThrow("EROFS")
      expect(readFileSync(path, "utf8")).toBe(AB_BYTES)
      expect(readdirSync(dir)).toEqual(["prod.json"])
      const writeFails = { ...fs, writeFileSync: () => { throw new Error("ENOSPC: no space left on device") } }
      expect(() => writeMcpServerTruth(path, [], writeFails)).toThrow("ENOSPC")
      expect(readFileSync(path, "utf8")).toBe(AB_BYTES)
      expect(readdirSync(dir)).toEqual(["prod.json"])
      writeMcpServerTruth(path, [], fs)
      expect(readFileSync(path, "utf8")).toBe('{"v":1,"servers":[]}\n')
    })
  })

  test("坏记录不落盘:读端同一份判据在写之前把关,连目录都不建;同名重复也拒,旧内容一个字节不动", () => {
    withTemp((dir) => {
      const path = join(dir, "mcp-servers", "prod.json")
      const bad = [{ ...B, enabled: false } as unknown as McpServerRecord]
      expect(() => writeMcpServerTruth(path, bad, fs)).toThrow(`remote MCP servers: refusing to write ${path} — servers[0] has unexpected key(s): enabled`)
      expect(existsSync(join(dir, "mcp-servers"))).toBe(false)
      writeMcpServerTruth(path, [A, B], fs)
      expect(() => writeMcpServerTruth(path, [A, B, { ...B, url: "https://again.example/mcp" }], fs)).toThrow('servers[2].name duplicates an earlier record: "deepwiki"')
      expect(readFileSync(path, "utf8")).toBe(AB_BYTES)
      expect(readdirSync(join(dir, "mcp-servers"))).toEqual(["prod.json"])
    })
  })
})

// ── 闭包 ─────────────────────────────────────────────────────────────────────

describe("写模块与 main 侧读改写模块不在 sidecar 的 import 闭包里;读端与生产读取绑定在(生产的闭包工具实测)", () => {
  test("sidecarSourceFiles 含 mcp-server-truth / mcp-server-records / alpha-config-injection(集合是活的),不含 -write / -lifecycle / ext-config / ext-install-planner", () => {
    const files = sidecarSourceFiles(repoRoot)
    expect(files).toContain("packages/ui-mac/src/main/alpha-config-injection.ts")
    expect(files).toContain("packages/ui-mac/src/main/mcp-server-truth.ts")
    expect(files).toContain("packages/ui-mac/src/main/mcp-server-records.ts")
    expect(files).not.toContain("packages/ui-mac/src/main/mcp-server-truth-write.ts")
    expect(files).not.toContain("packages/ui-mac/src/main/mcp-server-lifecycle.ts")
    expect(files).not.toContain("packages/ui-mac/src/main/ext-config.ts")
    expect(files).not.toContain("packages/ui-mac/src/main/ext-install-planner.ts")
  })

  test("读端自己的相对 import 闭包 = 它自己 + 扩展名判据;生产读取绑定的闭包不含写模块", () => {
    const rel = (files: string[]) => files.map((p) => relative(repoRoot, p)).sort()
    expect(rel(relativeImportClosure(join(repoRoot, "packages/ui-mac/src/main/mcp-server-truth.ts")))).toEqual([
      "packages/ui-mac/src/main/mcp-server-truth.ts",
      "packages/ui-mac/src/shared/extension-name.ts",
    ])
    const records = rel(relativeImportClosure(join(repoRoot, "packages/ui-mac/src/main/mcp-server-records.ts")))
    expect(records).toContain("packages/ui-mac/src/main/mcp-server-truth.ts")
    expect(records).not.toContain("packages/ui-mac/src/main/mcp-server-truth-write.ts")
    expect(records).not.toContain("packages/ui-mac/src/main/mcp-server-lifecycle.ts")
  })
})
