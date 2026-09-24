// `#1412` —— 用户批准的出网目的地真源(读端 + 写端 + 闭包)的判据,与 mcp-server-truth.test.ts 同形:
//   ① I3:真源路径 `<casBaseRoot>/egress-grants/<env>.json` 不在可写集任何**固定行**之下 —— 对着生产渲染的
//      profile 枚举 `(allow file-write*` 块里每条规则的 W-id,默认 base / 覆盖 base / 两种 XDG_STATE_HOME 都过。
//      这一条是整个方案的地基:放在可写根之下 = 围栏内的代码可以给自己批准出网(confused deputy)。
//      对照臂:同一批规则里 W2 确实罩着 `alpha.jsonc` —— 证明这个手段判得出「覆盖」。
//   ② I8 严格读:缺失 = 没批准过(ok、absent、空清单、零日志);坏 JSON / 版本不对 / grants 不是数组 /
//      字段不合法 / 同一 host:port 重复 / 多余的键 ⇒ ok:false(**不是空数组**)且日志恰一行说得出原因。
//   ③ 写:落盘字节固定字面量、无临时文件残留、原子(rename 中途抛 ⇒ 盘上仍是旧内容)、坏记录不落盘(连目录都不建)。
//   ④ 写模块与生产读写绑定**不进 sidecar 的 import 闭包**;读端零 fs(连 import 都没有)。
// 全平台、electron-free、真文件系统(临时目录)。期望值手写字面量。

import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import { environmentMutableRoot } from "./alpha-environment"
import { egressGrantTruthPath, readEgressGrantTruth, type EgressGrantRecord } from "./egress-grant-truth"
import { writeEgressGrantTruth } from "./egress-grant-truth-write"
import { mcpServerTruthPath } from "./mcp-server-truth"
import { relativeImportClosure, sidecarSourceFiles } from "./process-fence-write-sites"
import { renderProcessFenceProfile, type ProcessFenceProfileInput } from "./process-fence-profile"

const repoRoot = resolve(import.meta.dir, "../../../..")
const HOME = "/Users/alpha"
const DEFAULT_STATE_ROOT = `${HOME}/Library/Application Support/alpha-code-state`
const OVERRIDE_STATE_ROOT = `${HOME}/dev/alpha-base`
const USER_DATA = `${HOME}/Library/Application Support/ai.opencode.desktop`

function withTemp<T>(run: (dir: string) => T): T {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "egress-grants-")))
  try {
    return run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── I3:位置 ────────────────────────────────────────────────────────────────────

type Rule = { id: string; kind: "subpath" | "literal" | "regex"; value: string }

/** 取 `(allow file-write*` 块里每条规则与它的 `; Wn` 注释。解析不出来当场抛 —— 手段瞎了不算「没覆盖」。 */
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

describe("真源位置(I3):<casBaseRoot>/egress-grants/<env>.json 不在可写集任何固定行之下", () => {
  test("路径 = <casBaseRoot>/egress-grants/<env>.json;与 env 根、mcp-servers/、cas/ 同级(相对每个都以 .. 开头)", () => {
    expect(egressGrantTruthPath(DEFAULT_STATE_ROOT, "prod")).toBe("/Users/alpha/Library/Application Support/alpha-code-state/egress-grants/prod.json")
    expect(egressGrantTruthPath(DEFAULT_STATE_ROOT, "beta")).toBe("/Users/alpha/Library/Application Support/alpha-code-state/egress-grants/beta.json")
    expect(egressGrantTruthPath(OVERRIDE_STATE_ROOT, "dev")).toBe("/Users/alpha/dev/alpha-base/egress-grants/dev.json")
    for (const env of ["prod", "beta", "dev"] as const) {
      const truth = egressGrantTruthPath(DEFAULT_STATE_ROOT, env)
      for (const sibling of [
        environmentMutableRoot(env, DEFAULT_STATE_ROOT),
        join(DEFAULT_STATE_ROOT, "cas"),
        join(DEFAULT_STATE_ROOT, "fence-workspaces"),
        join(DEFAULT_STATE_ROOT, "custom-providers"),
        join(DEFAULT_STATE_ROOT, "mcp-servers"),
      ]) {
        expect(relative(sibling, truth).startsWith(".."), `${env}: ${sibling}`).toBe(true)
      }
      // 与远程 MCP 真源是同一个父目录下的两个文件,不是同一个文件(两种记录形状不同)
      expect(relative(mcpServerTruthPath(DEFAULT_STATE_ROOT, env), truth)).toBe(join("..", "..", "egress-grants", `${env}.json`))
    }
  })

  test("默认 base 与覆盖 base、两种 XDG_STATE_HOME:没有任何固定行覆盖真源文件或它的目录(W1 除外);对照:W2 罩着 alpha.jsonc", () => {
    for (const [stateRoot, env] of [
      [DEFAULT_STATE_ROOT, "prod"],
      [OVERRIDE_STATE_ROOT, "dev"],
    ] as const) {
      for (const stateHome of [USER_DATA, `${HOME}/.local/state`]) {
        const rules = fileWriteRules(profileFor(stateRoot, env, { stateHome })).filter((r) => r.id !== "W1")
        expect(rules.length, `${stateRoot}/${env}/${stateHome}`).toBeGreaterThanOrEqual(17)
        const truth = egressGrantTruthPath(stateRoot, env)
        const dir = join(stateRoot, "egress-grants")
        expect(rules.filter((r) => covers(r, truth)).map(describeRule), `truth file ${truth}`).toEqual([])
        expect(rules.filter((r) => covers(r, dir)).map(describeRule), `truth dir ${dir}`).toEqual([])
        expect(rules.filter((r) => covers(r, join(environmentMutableRoot(env, stateRoot), "alpha.jsonc"))).map(describeRule)).toEqual([
          `W2 subpath ${environmentMutableRoot(env, stateRoot)}`,
        ])
      }
    }
  })

  test("控制臂:profile 里多一行罩住状态根 ⇒ 同一判据当场点名它(证明这个手段判得出覆盖)", () => {
    const rules = fileWriteRules(profileFor(DEFAULT_STATE_ROOT, "prod")).filter((r) => r.id !== "W1")
    const planted: Rule[] = [...rules, { id: "W99", kind: "subpath", value: DEFAULT_STATE_ROOT }]
    const truth = egressGrantTruthPath(DEFAULT_STATE_ROOT, "prod")
    expect(planted.filter((r) => covers(r, truth)).map(describeRule)).toEqual([`W99 subpath ${DEFAULT_STATE_ROOT}`])
  })
})

// ── I8:严格读 ─────────────────────────────────────────────────────────────────

const A: EgressGrantRecord = { host: "en.wikipedia.org", port: 443, at: "2026-09-23T10:00:00.000Z" }
const B: EgressGrantRecord = { host: "example.com", port: 443, at: "2026-09-23T10:01:00.000Z" }
const AB_BYTES =
  '{"v":1,"grants":[{"host":"en.wikipedia.org","port":443,"at":"2026-09-23T10:00:00.000Z"},{"host":"example.com","port":443,"at":"2026-09-23T10:01:00.000Z"}]}\n'

function readWithLog(path: string) {
  const lines: string[] = []
  const read = readEgressGrantTruth(path, { readFileSync, log: (l) => lines.push(l) })
  return { read, lines }
}

describe("严格读(I8):缺失 = 没批准过;其余任何不对 = 没问出来,不是空记录", () => {
  test("缺失 ⇒ ok + absent + 空清单 + 零日志", () => {
    withTemp((dir) => {
      const { read, lines } = readWithLog(join(dir, "egress-grants", "prod.json"))
      expect(read.ok).toBe(true)
      expect(read.ok && read.absent).toBe(true)
      expect(read.ok && read.grants).toEqual([])
      expect(lines).toEqual([])
    })
  })

  test("正样本:键序乱也读回固定键序,两条记录逐字", () => {
    withTemp((dir) => {
      const path = join(dir, "prod.json")
      writeFileSync(path, '{"grants":[{"at":"2026-09-23T10:00:00.000Z","port":443,"host":"en.wikipedia.org"}],"v":1}')
      const { read, lines } = readWithLog(path)
      expect(read.ok && read.grants).toEqual([A])
      expect(read.ok && JSON.stringify(read.grants[0])).toBe('{"host":"en.wikipedia.org","port":443,"at":"2026-09-23T10:00:00.000Z"}')
      expect(lines).toEqual([])
    })
  })

  test("十种坏形状各一臂 ⇒ ok:false、reason 点名哪一项、日志恰一行", () => {
    const cases: Array<[string, string, string]> = [
      ["not JSON", "{", "not JSON"],
      ["顶层不是对象", "[]", "not a JSON object"],
      ["版本 2", '{"v":2,"grants":[]}', "unsupported version 2 (expected 1)"],
      ["缺版本", '{"grants":[]}', "unsupported version undefined (expected 1)"],
      ["顶层多余键", '{"v":1,"grants":[],"extra":1}', "unexpected top-level key(s): extra"],
      ["grants 不是数组", '{"v":1,"grants":{}}', "`grants` is not an array"],
      ["记录不是对象", '{"v":1,"grants":["x"]}', "grants[0] is not an object"],
      ["记录多余键", '{"v":1,"grants":[{"host":"a.example","port":443,"at":"t","why":"x"}]}', "grants[0] has unexpected key(s): why"],
      ["port 越界", '{"v":1,"grants":[{"host":"a.example","port":0,"at":"t"}]}', "grants[0].port is not a port number: 0"],
      ["at 缺失", '{"v":1,"grants":[{"host":"a.example","port":443}]}', "grants[0].at is not a timestamp: undefined"],
    ]
    withTemp((dir) => {
      for (const [label, text, reason] of cases) {
        const path = join(dir, `${label.replace(/[^a-z0-9]/gi, "_")}.json`)
        writeFileSync(path, text)
        const { read, lines } = readWithLog(path)
        expect(read.ok, label).toBe(false)
        expect(!read.ok && read.reason, label).toStartWith(`${path}: ${reason}`)
        expect(lines.length, label).toBe(1)
        expect(lines[0], label).toContain('this is "unanswerable", not "nothing approved"')
      }
    })
  })

  test("同一 host:port 重复 ⇒ 拒;读错(目录当文件)也拒,不当缺失", () => {
    withTemp((dir) => {
      const dup = join(dir, "dup.json")
      writeFileSync(dup, '{"v":1,"grants":[{"host":"a.example","port":443,"at":"t"},{"host":"A.EXAMPLE","port":443,"at":"t2"}]}')
      const { read } = readWithLog(dup)
      expect(!read.ok && read.reason).toBe(`${dup}: grants[1] duplicates an earlier record: "a.example:443"`)
      const { read: dirRead, lines } = readWithLog(dir)
      expect(dirRead.ok).toBe(false)
      expect(lines.length).toBe(1)
    })
  })
})

// ── 写 ────────────────────────────────────────────────────────────────────────

describe("写:字节确定、原子、坏记录不落盘", () => {
  test("落盘字节是固定字面量;父目录不在就建;无临时文件残留", () => {
    withTemp((dir) => {
      const path = egressGrantTruthPath(dir, "prod")
      writeEgressGrantTruth(path, [A, B], fs)
      expect(readFileSync(path, "utf8")).toBe(AB_BYTES)
      expect(readdirSync(join(dir, "egress-grants"))).toEqual(["prod.json"])
    })
  })

  test("坏记录不落盘,连目录都不建;rename 中途抛 ⇒ 盘上仍是旧内容", () => {
    withTemp((dir) => {
      const path = egressGrantTruthPath(dir, "prod")
      expect(() => writeEgressGrantTruth(path, [{ host: "a.example", port: 443, at: "t", extra: 1 } as never], fs)).toThrow(
        `egress grants: refusing to write ${path} — grants[0] has unexpected key(s): extra`,
      )
      expect(existsSync(join(dir, "egress-grants"))).toBe(false)
      writeEgressGrantTruth(path, [A, B], fs)
      const boom = {
        ...fs,
        renameSync: () => {
          throw new Error("rename exploded")
        },
      }
      expect(() => writeEgressGrantTruth(path, [A], boom)).toThrow("rename exploded")
      expect(readFileSync(path, "utf8")).toBe(AB_BYTES)
      expect(readdirSync(join(dir, "egress-grants"))).toEqual(["prod.json"])
    })
  })
})

// ── 闭包 ─────────────────────────────────────────────────────────────────────

describe("写端与生产绑定不在 sidecar 的 import 闭包里(生产的闭包工具实测)", () => {
  test("sidecarSourceFiles 不含 egress-grant-truth-write / egress-grant-records / egress-approval-dialog", () => {
    const files = sidecarSourceFiles(repoRoot)
    // 集合是活的:先证明这个手段看得见东西,再断言它看不见我们关心的那几个
    expect(files).toContain("packages/ui-mac/src/main/alpha-config-injection.ts")
    expect(files).not.toContain("packages/ui-mac/src/main/egress-grant-truth-write.ts")
    expect(files).not.toContain("packages/ui-mac/src/main/egress-grant-records.ts")
    expect(files).not.toContain("packages/ui-mac/src/main/egress-approval-dialog.ts")
  })

  test("读端自己的相对 import 闭包 = 它自己(零 fs、零判据依赖);生产绑定的闭包含读端与写端", () => {
    const rel = (files: string[]) => files.map((p) => relative(repoRoot, p)).sort()
    expect(rel(relativeImportClosure(join(repoRoot, "packages/ui-mac/src/main/egress-grant-truth.ts")))).toEqual([
      "packages/ui-mac/src/main/egress-grant-truth.ts",
    ])
    const records = rel(relativeImportClosure(join(repoRoot, "packages/ui-mac/src/main/egress-grant-records.ts")))
    expect(records).toContain("packages/ui-mac/src/main/egress-grant-truth.ts")
    expect(records).toContain("packages/ui-mac/src/main/egress-grant-truth-write.ts")
  })
})
