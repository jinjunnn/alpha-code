// `#1391` —— 自定义节点真源(读端)的判据。
//   ① I2:真源路径不在可写集任何**固定行**之下 —— 对着生产渲染的 profile,枚举 `(allow file-write*` 块里每条规则的 W-id
//      (18 个固定 id 手写登记;W1 是运行时成员,由 `#1390` 规则 5b 兜,本条不含),默认 base 与 dev 覆盖 base、XDG_STATE_HOME
//      两种形态都过。词法判据偏向判「覆盖」(大小写不敏感、按路径段比);「覆盖」的最终裁判是 seatbelt 本身,在
//      custom-provider-truth-fence.test.ts 真跑。每条「不覆盖」都先证明手段测得出「覆盖」。
//   ② 严格读:缺失 = 没有记录(ok、空清单、零日志);坏 JSON / 版本不对 / providers 不是数组 / 字段不合法 / 同 id 重复 ⇒
//      ok:false(**不是空数组**)且日志恰一行说得出原因。
// 全平台、electron-free、真文件系统(临时目录)。期望值手写字面量。

import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import { environmentMutableRoot } from "./alpha-environment"
import { customProviderTruthPath, readCustomProviderTruth, type CustomProviderRecord } from "./custom-provider-truth"
import { writeCustomProviderTruth } from "./custom-provider-truth-write"
import { WRITABLE_ROOT_IDS, renderProcessFenceProfile, type ProcessFenceProfileInput } from "./process-fence-profile"

const HOME = "/Users/alpha"
/** 默认 base:alpha-environment.ts defaultAlphaBaseRoot(<appData>/alpha-code-state)。 */
const DEFAULT_STATE_ROOT = `${HOME}/Library/Application Support/alpha-code-state`
/** dev 态 ALPHA_ENV_BASE_DIR 可改 base —— 真源跟着**实际** base 走,不是默认常量(基线 I2)。 */
const OVERRIDE_STATE_ROOT = `${HOME}/dev/alpha-base`
const USER_DATA = `${HOME}/Library/Application Support/ai.opencode.desktop`

function withTemp<T>(run: (dir: string) => T): T {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "custom-providers-")))
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

/** 词法覆盖判据,**偏向判「覆盖」**(fail-closed):大小写不敏感(APFS)、按路径段比(不是字符串前缀)。 */
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

/** 可写集的 18 条固定行(`#1383` 基线 §1.1「18 条静态行」),手写 —— 将来加一行,这里先红,再回答「它罩不罩得到真源」。 */
const FIXED_ROW_IDS = ["W2", "W3", "W4", "W5", "W6", "W7", "W8", "W10", "W11", "W12", "W13", "W14", "W15", "W16", "W17", "W18", "W19"]

describe("真源位置(I2):<casBaseRoot>/custom-providers/<env>.json 不在可写集任何固定行之下", () => {
  test("路径 = <casBaseRoot>/custom-providers/<env>.json;与三个 env 根、cas/、fence-workspaces/ 同级(相对每个都以 .. 开头)", () => {
    expect(customProviderTruthPath(DEFAULT_STATE_ROOT, "prod")).toBe("/Users/alpha/Library/Application Support/alpha-code-state/custom-providers/prod.json")
    expect(customProviderTruthPath(DEFAULT_STATE_ROOT, "beta")).toBe("/Users/alpha/Library/Application Support/alpha-code-state/custom-providers/beta.json")
    expect(customProviderTruthPath(OVERRIDE_STATE_ROOT, "dev")).toBe("/Users/alpha/dev/alpha-base/custom-providers/dev.json")
    for (const env of ["prod", "beta", "dev"] as const) {
      const truth = customProviderTruthPath(DEFAULT_STATE_ROOT, env)
      for (const sibling of [environmentMutableRoot(env, DEFAULT_STATE_ROOT), join(DEFAULT_STATE_ROOT, "cas"), join(DEFAULT_STATE_ROOT, "fence-workspaces")]) {
        expect(relative(sibling, truth).startsWith(".."), `${env}: ${sibling}`).toBe(true)
      }
    }
  })

  test("固定行的枚举是完备的:WRITABLE_ROOT_IDS 去掉 W1 = 手写的 17 个 id(+W3 的 XDG_STATE_HOME 形态仍是 W3)= 渲染出的 profile 里的 id 集合", () => {
    expect(Object.keys(WRITABLE_ROOT_IDS).filter((id) => id !== "W1").sort()).toEqual([...FIXED_ROW_IDS].sort())
    for (const stateHome of [USER_DATA, `${HOME}/.local/state`]) {
      const ids = [...new Set(fileWriteRules(profileFor(DEFAULT_STATE_ROOT, "prod", { stateHome })).map((r) => r.id))]
      expect(ids.filter((id) => id !== "W1").sort(), `stateHome=${stateHome}`).toEqual([...FIXED_ROW_IDS].sort())
      expect(ids).toContain("W1")
    }
  })

  test("默认 base 与覆盖 base、两种 XDG_STATE_HOME 形态:没有任何固定行覆盖真源文件或它的目录(逐条规则,W1 除外)", () => {
    for (const [stateRoot, env] of [
      [DEFAULT_STATE_ROOT, "prod"],
      [OVERRIDE_STATE_ROOT, "dev"],
    ] as const) {
      for (const stateHome of [USER_DATA, `${HOME}/.local/state`]) {
        const rules = fileWriteRules(profileFor(stateRoot, env, { stateHome })).filter((r) => r.id !== "W1")
        // 至少要真的看过 17 条规则以上,否则「没覆盖」是空集上的真
        expect(rules.length, `${stateRoot}/${env}/${stateHome}`).toBeGreaterThanOrEqual(17)
        const truth = customProviderTruthPath(stateRoot, env)
        const dir = join(stateRoot, "custom-providers")
        expect(rules.filter((r) => covers(r, truth)).map(describeRule), `truth file ${truth}`).toEqual([])
        expect(rules.filter((r) => covers(r, dir)).map(describeRule), `truth dir ${dir}`).toEqual([])
        // 对照:同一批规则里 W2 确实罩着 alpha.jsonc 的家(手段不是对什么都答「没覆盖」)
        expect(rules.filter((r) => covers(r, join(environmentMutableRoot(env, stateRoot), "alpha.jsonc"))).map(describeRule)).toEqual([
          `W2 subpath ${environmentMutableRoot(env, stateRoot)}`,
        ])
      }
    }
  })

  test("控制臂:往 profile 里塞一行罩住状态根 / 大小写变形 / regex / literal,判据各自点名;没 W-id 或解析不出的行让手段抛,不算「没覆盖」", () => {
    const profile = profileFor(DEFAULT_STATE_ROOT, "prod")
    const truth = customProviderTruthPath(DEFAULT_STATE_ROOT, "prod")
    const inject = (line: string) => profile.replace("(allow file-write*\n", `(allow file-write*\n${line}\n`)
    const offenders = (p: string) => fileWriteRules(p).filter((r) => r.id !== "W1" && covers(r, truth)).map(describeRule)
    expect(offenders(profile)).toEqual([])
    expect(offenders(inject(`  (subpath "${DEFAULT_STATE_ROOT}")   ; W2`))).toEqual([`W2 subpath ${DEFAULT_STATE_ROOT}`])
    expect(offenders(inject(`  (subpath "/users/alpha/library/application support/alpha-code-state/custom-providers")   ; W3`))).toEqual([
      "W3 subpath /users/alpha/library/application support/alpha-code-state/custom-providers",
    ])
    expect(offenders(inject(`  (regex #"^/Users/alpha/Library")   ; W8`))).toEqual(["W8 regex ^/Users/alpha/Library"])
    expect(offenders(inject(`  (literal "${truth}")   ; W13`))).toEqual([`W13 literal ${truth}`])
    // 字符串前缀不算覆盖:`alpha-code-state-2` 不是 `alpha-code-state` 的子路径(按段比,不是 startsWith)
    expect(offenders(inject(`  (subpath "${DEFAULT_STATE_ROOT}-2")   ; W2`))).toEqual([])
    expect(() => fileWriteRules(inject(`  (subpath "${DEFAULT_STATE_ROOT}")`))).toThrow("without a W-id")
    expect(() => fileWriteRules(inject(`  (allow-something "${DEFAULT_STATE_ROOT}")   ; W2`))).toThrow("no parsable rule")
  })
})

// ── 严格读 ─────────────────────────────────────────────────────────────────────

const openai: CustomProviderRecord = { id: "my-openai", name: "My OpenAI", compat: "openai", baseURL: "https://api.openai.com/v1", models: ["gpt-5.4", "gpt-5.4-mini"] }
const anthropic: CustomProviderRecord = { id: "my-claude", name: "My Claude", compat: "anthropic", baseURL: "https://api.anthropic.com", models: ["claude-fable-5-1"] }

describe("严格读:缺失 = 没有记录;坏了 = 没问出来(不是空数组)+ 一行日志", () => {
  test("缺失 ⇒ ok / absent / 空清单,零日志(用户没加过节点是正常状态)", () => {
    withTemp((dir) => {
      const logs: string[] = []
      const path = join(dir, "custom-providers", "prod.json")
      expect(readCustomProviderTruth(path, { ...fs, log: (l) => void logs.push(l) })).toEqual({ ok: true, absent: true, providers: [] })
      expect(logs).toEqual([])
    })
  })

  test("正样本:两条记录逐字读回(文件里键序乱、读回固定键序);零日志", () => {
    withTemp((dir) => {
      const logs: string[] = []
      const path = join(dir, "prod.json")
      writeFileSync(
        path,
        JSON.stringify({
          providers: [
            { models: ["gpt-5.4", "gpt-5.4-mini"], baseURL: "https://api.openai.com/v1", compat: "openai", name: "My OpenAI", id: "my-openai" },
            { id: "my-claude", compat: "anthropic", name: "My Claude", models: ["claude-fable-5-1"], baseURL: "https://api.anthropic.com" },
          ],
          v: 1,
        }),
      )
      const read = readCustomProviderTruth(path, { ...fs, log: (l) => void logs.push(l) })
      expect(read).toEqual({ ok: true, absent: false, providers: [openai, anthropic] })
      if (read.ok) expect(Object.keys(read.providers[0]!)).toEqual(["id", "name", "compat", "baseURL", "models"])
      expect(logs).toEqual([])
      // 写端写出来的也读得回(往返)
      writeCustomProviderTruth(path, [anthropic], fs)
      expect(readCustomProviderTruth(path, { ...fs, log: (l) => void logs.push(l) })).toEqual({ ok: true, absent: false, providers: [anthropic] })
      expect(logs).toEqual([])
    })
  })

  test("十六种坏形状各一臂:ok:false、reason 点名文件与哪一项、日志恰一行含同一原因;没有一种退化成空清单", () => {
    withTemp((dir) => {
      const path = join(dir, "prod.json")
      const rec = (over: Record<string, unknown>) => JSON.stringify({ v: 1, providers: [{ ...openai, ...over }] })
      const bad: Array<[string, string]> = [
        ["{not json", "not JSON"],
        ["[]", "not a JSON object"],
        ['{"v":2,"providers":[]}', "unsupported version 2 (expected 1)"],
        ['{"providers":[]}', "unsupported version undefined (expected 1)"],
        ['{"v":1,"providers":{}}', "`providers` is not an array"],
        ['{"v":1,"providers":[],"apiKeys":{}}', "unexpected top-level key(s): apiKeys"],
        ['{"v":1,"providers":[42]}', "providers[0] is not an object"],
        [rec({ id: "" }), "providers[0].id is not a non-empty string"],
        [rec({ name: 7 }), "providers[0].name is not a non-empty string"],
        [rec({ compat: "ollama" }), 'providers[0].compat is not one of openai | anthropic: "ollama"'],
        [rec({ baseURL: "not a url" }), 'providers[0].baseURL is not a URL: "not a url"'],
        [rec({ models: "gpt-5.4" }), "providers[0].models is not a non-empty array"],
        [rec({ models: [] }), "providers[0].models is not a non-empty array"],
        [rec({ models: ["gpt-5.4", 3] }), "providers[0].models[1] is not a non-empty string"],
        [rec({ apiKey: "sk-live-…" }), "providers[0] has unexpected key(s): apiKey (secrets never live here)"],
        [JSON.stringify({ v: 1, providers: [openai, { ...anthropic, id: "my-openai" }] }), 'providers[1].id duplicates an earlier record: "my-openai"'],
      ]
      expect(bad.length).toBe(16)
      for (const [text, reason] of bad) {
        writeFileSync(path, text)
        const logs: string[] = []
        const read = readCustomProviderTruth(path, { ...fs, log: (l) => void logs.push(l) })
        expect(read.ok, text).toBe(false)
        if (read.ok) continue
        // 「not JSON」那一臂的括号里是运行时自己的解析错误原文(bun 与 node 措辞不同),所以比前缀;其余臂前缀 = 全文
        expect(read.reason.startsWith(`${path}: ${reason}`), `${text} → ${read.reason}`).toBe(true)
        expect(logs.length, text).toBe(1)
        expect(logs[0]!.startsWith(`custom providers: truth file ${path} rejected — ${reason}`), `${text} → ${logs[0]}`).toBe(true)
        expect(logs[0]!.endsWith('; nothing is derived from it (this is "unanswerable", not an empty list) until the app rewrites it'), text).toBe(true)
      }
    })
  })

  test("读错(不是缺失):路径是个目录 ⇒ ok:false + 一行日志,不当成「没有记录」", () => {
    withTemp((dir) => {
      const path = join(dir, "prod.json")
      mkdirSync(path)
      const logs: string[] = []
      const read = readCustomProviderTruth(path, { ...fs, log: (l) => void logs.push(l) })
      expect(read.ok).toBe(false)
      if (!read.ok) expect(read.reason).toMatch(new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: read failed \\(EISDIR`))
      expect(logs.length).toBe(1)
      expect(logs[0]).toContain("read failed (EISDIR")
    })
  })
})

// REQ-228 `#1420`:`imageInput` = 用户显式声明能看图的模型。只有一种合法形状(⊂ models、非空、无重复);缺席 = 一个都不能。
describe("REQ-228 #1420:imageInput 的严格形状", () => {
  test("正样本:读回带 imageInput、键序固定(imageInput 在 models 之后);写端往返逐字;缺席的记录读回也没有这个键", () => {
    withTemp((dir) => {
      const logs: string[] = []
      const path = join(dir, "prod.json")
      const vision: CustomProviderRecord = { ...openai, imageInput: ["gpt-5.4"] }
      writeFileSync(path, JSON.stringify({ v: 1, providers: [{ imageInput: ["gpt-5.4"], ...openai }, anthropic] }))
      const read = readCustomProviderTruth(path, { ...fs, log: (l) => void logs.push(l) })
      expect(read).toEqual({ ok: true, absent: false, providers: [vision, anthropic] })
      if (read.ok) {
        expect(Object.keys(read.providers[0]!)).toEqual(["id", "name", "compat", "baseURL", "models", "imageInput"])
        expect("imageInput" in read.providers[1]!).toBe(false)
      }
      writeCustomProviderTruth(path, [vision], fs)
      expect(readFileSync(path, "utf8")).toBe(
        '{"v":1,"providers":[{"id":"my-openai","name":"My OpenAI","compat":"openai","baseURL":"https://api.openai.com/v1","models":["gpt-5.4","gpt-5.4-mini"],"imageInput":["gpt-5.4"]}]}\n',
      )
      expect(logs).toEqual([])
    })
  })

  test("四种坏形状各一臂:ok:false、reason 点名哪一项、日志恰一行;没有一种退化成「能看图」或空清单", () => {
    withTemp((dir) => {
      const path = join(dir, "prod.json")
      const rec = (imageInput: unknown) => JSON.stringify({ v: 1, providers: [{ ...openai, imageInput }] })
      const bad: Array<[string, string]> = [
        [rec("gpt-5.4"), "providers[0].imageInput is not a non-empty array"],
        [rec([]), "providers[0].imageInput is not a non-empty array"],
        [rec(["gpt-5.4", "claude-fable-5-1"]), 'providers[0].imageInput[1] is not one of models: "claude-fable-5-1"'],
        [rec(["gpt-5.4", "gpt-5.4"]), 'providers[0].imageInput[1] duplicates an earlier entry: "gpt-5.4"'],
      ]
      for (const [text, reason] of bad) {
        writeFileSync(path, text)
        const logs: string[] = []
        const read = readCustomProviderTruth(path, { ...fs, log: (l) => void logs.push(l) })
        expect(read.ok, text).toBe(false)
        if (!read.ok) expect(read.reason, text).toBe(`${path}: ${reason}`)
        expect(logs.length, text).toBe(1)
      }
    })
  })
})
