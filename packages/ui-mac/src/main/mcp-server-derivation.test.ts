// `#1381`(`#1383` 基线 §四 子票 4)—— 远程 MCP 服务器从真源派生的**端到端**判据,与 custom-provider-derivation.test.ts 同形:
//   正样本:真源里有一条远程 MCP ⇒ ①它的地址进了这一代放行集合;②引擎拿到的配置里有这条连接器(完整 type / url / headers,enabled:true)。
//   反样本(承重):往 alpha.jsonc 写一条 `type:"remote"` 的 MCP ⇒ **既不进放行集合,也不被引擎当成已治理的连接器启用**
//   (引擎原生仍会合并 OPENCODE_CONFIG,所以「不启用」只能靠末序注入 `enabled:false` 压住 —— 这里把**真引擎**拉起来问它合并后的配置:
//   `bun run packages/opencode/src/index.ts debug config`,env 照 sidecar 的接线给:OPENCODE_CONFIG = alpha.jsonc、OPENCODE_CONFIG_CONTENT =
//   生产 injectAlphaConfig 的产物、XDG_CONFIG_HOME 指向也写了同名条目的用户全局目录)。
// 手段自证先于判据:同一台引擎、同一份 alpha.jsonc,把注入面换成 `#1381` 之前的形状(不压 alpha.jsonc 的远程条目)⇒ 那条 exfil
// 连接器在合并后的配置里**真的**是一条活的远程条目;把配置文件里的块当真源喂进派生 ⇒ 它的地址真的被放行。证明这台仪器看得见「已知的坏」。
// 真引擎离线跑(OPENCODE_MODELS_PATH 指向仓内真快照,debug config 不发任何网络请求)。期望值手写字面量。

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { injectAlphaConfig } from "./alpha-config-injection"
import { environmentMutableRoot } from "./alpha-environment"
import { readMcpServerRecords, resolveMcpServerTruthLocation } from "./mcp-server-records"
import { writeMcpServerTruth } from "./mcp-server-truth-write"
import { deriveMcpEgressDestinations, isEgressAuthorizedForSidecar, setConfiguredEgressDestinations } from "./network-egress-derived"

const repoRoot = path.resolve(import.meta.dir, "../../../..")
const engineEntry = path.resolve(repoRoot, "packages/opencode/src/index.ts")
const modelsFixture = path.resolve(repoRoot, "packages/opencode/test/tool/fixtures/models-api.json")
const BUN_EXEC = process.execPath
const PATH_AT_LOAD = process.env.PATH ?? ""

const MANAGED = [
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_MODELS_PATH",
  "ALPHA_IDENTITY_DISABLE",
  "ALPHA_BEHAVIOR_DISABLE",
  "ALPHA_MODELS_DISABLE",
  "ALPHA_AUTOMATION_DISABLE",
  "ALPHA_READONLY_DISABLE",
  "ALPHA_WEBSEARCH_DISABLE",
  "OPENCODE_ENABLE_EXA",
  "OPENCODE_EXPERIMENTAL",
  "ALPHA_CLOUD_MCP_URL",
  "ALPHA_CLOUD_MCP_ARM",
  "ALPHA_CLOUD_MCP_DEF",
  "ALPHA_CLOUD_MCP_SERVER",
  "ALPHA_BASE_URL",
  "ALPHA_DEFAULT_MODEL",
  "ALPHA_GLOBAL_DIR",
  "ALPHA_OPENCODE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
]
const saved: Record<string, string | undefined> = {}
let root = ""
let userData = ""
let stateRoot = ""
let envRoot = ""
let truthPath = ""
let alphaJsonc = ""
let xdgConfigHome = ""
let xdgUserGlobal = ""

const MY_MCP = { name: "my-mcp", url: "https://mcp.example.com/mcp", headers: { "X-Token": "t" } }
/** 围栏内一行 `printf … > file` 能写出的完整远程条目 —— 引擎原生合并它时什么都不缺。 */
const EXFIL_MCP = { type: "remote", url: "https://exfil-mcp.example/mcp" }

beforeAll(() => {
  for (const key of MANAGED) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-server-derivation-")))
  userData = path.join(root, "userdata")
  stateRoot = path.join(root, "alpha-code-state")
  envRoot = environmentMutableRoot("dev", stateRoot)
  truthPath = path.join(stateRoot, "mcp-servers", "dev.json")
  alphaJsonc = path.join(envRoot, "alpha.jsonc")
  xdgConfigHome = path.join(root, "xdg-config")
  xdgUserGlobal = path.join(xdgConfigHome, "opencode", "config.json")
  for (const dir of [userData, envRoot, path.dirname(xdgUserGlobal), path.join(root, "dot-opencode"), path.join(root, "xdg-data"), path.join(root, "home"), path.join(root, "proj")])
    fs.mkdirSync(dir, { recursive: true })
  process.env.ALPHA_GLOBAL_DIR = envRoot
  process.env.XDG_CONFIG_HOME = xdgConfigHome
  process.env.XDG_DATA_HOME = path.join(root, "xdg-data")
  process.env.ALPHA_OPENCODE_HOME = path.join(root, "dot-opencode")
})

afterAll(() => {
  setConfiguredEgressDestinations([])
  for (const key of MANAGED) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  fs.rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  setConfiguredEgressDestinations([])
  for (const file of [truthPath, alphaJsonc, xdgUserGlobal]) fs.rmSync(file, { force: true })
  delete process.env.OPENCODE_CONFIG_CONTENT
  delete process.env.OPENCODE_CONFIG
  delete process.env.OPENCODE_CONFIG_DIR
})

type McpMap = Record<string, Record<string, unknown>>

/** 生产注入面(sidecar 里 injectAlphaConfig 跑的那一份),只取它写进 OPENCODE_CONFIG_CONTENT 的 mcp 表。 */
function injectedMcp(): { content: string; mcp: McpMap; stderr: string[] } {
  const stderr: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => void stderr.push(args.map(String).join(" "))
  try {
    const result = injectAlphaConfig(userData, undefined, "stable")
    expect(result).toEqual({ ok: true })
  } finally {
    console.error = original
  }
  const content = process.env.OPENCODE_CONFIG_CONTENT!
  return { content, mcp: (JSON.parse(content) as { mcp?: McpMap }).mcp ?? {}, stderr }
}

/** 一次真引擎 `debug config`:引擎自己合并 XDG 用户全局 + OPENCODE_CONFIG(alpha.jsonc),再合并 OPENCODE_CONFIG_CONTENT(最后)。 */
async function engineMergedMcp(content: string): Promise<{ rc: number; mcp: McpMap; log: string }> {
  const dir = fs.mkdtempSync(path.join(root, "run-"))
  for (const sub of ["xdg-data", "xdg-cache", "xdg-state"]) fs.mkdirSync(path.join(dir, sub), { recursive: true })
  const proc = Bun.spawn([BUN_EXEC, "run", engineEntry, "debug", "config"], {
    cwd: path.join(root, "proj"),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: PATH_AT_LOAD,
      HOME: path.join(root, "home"),
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_DATA_HOME: path.join(dir, "xdg-data"),
      XDG_CACHE_HOME: path.join(dir, "xdg-cache"),
      XDG_STATE_HOME: path.join(dir, "xdg-state"),
      NO_COLOR: "1",
      OPENCODE_CONFIG: alphaJsonc,
      OPENCODE_CONFIG_CONTENT: content,
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_MODELS_PATH: modelsFixture,
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DB: path.join(dir, "engine.db"),
    },
  })
  const killer = setTimeout(() => proc.kill(), 90_000)
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const rc = await proc.exited
  clearTimeout(killer)
  let mcp: McpMap = {}
  try {
    mcp = (JSON.parse(stdout) as { mcp?: McpMap }).mcp ?? {}
  } catch {
    /* rc / log 会说明 */
  }
  return { rc, mcp, log: `${stdout}\n${stderr}`.slice(-1500) }
}

describe("#1381 真源位置:sidecar(ALPHA_GLOBAL_DIR 逆映射)与自定义节点同一份解析;形状不对 ⇒ 位置未知,不猜", () => {
  test("位置 = <casBaseRoot>/mcp-servers/<env>.json,逐字等于手写路径;ALPHA_GLOBAL_DIR 形状不对 ⇒ ok:false + 一行日志 + 什么都不派生", () => {
    expect(resolveMcpServerTruthLocation()).toEqual({ ok: true, path: truthPath, casBaseRoot: stateRoot, environment: "dev" })
    writeMcpServerTruth(truthPath, [MY_MCP], fs)
    expect(readMcpServerRecords(() => {})).toEqual([MY_MCP])
    const odd = path.join(root, "odd-root")
    fs.mkdirSync(odd, { recursive: true })
    process.env.ALPHA_GLOBAL_DIR = odd
    try {
      const logs: string[] = []
      const location = resolveMcpServerTruthLocation()
      expect(location).toEqual({ ok: false, reason: `ALPHA_GLOBAL_DIR ${odd} is not of the form <base>/env/<prod|beta|dev>; the remote MCP server truth location is unknown` })
      expect(readMcpServerRecords((l) => void logs.push(l))).toEqual([])
      expect(logs).toEqual([
        `remote MCP servers: truth location unresolved — ALPHA_GLOBAL_DIR ${odd} is not of the form <base>/env/<prod|beta|dev>; the remote MCP server truth location is unknown; no remote MCP server is injected or authorized this generation`,
      ])
    } finally {
      process.env.ALPHA_GLOBAL_DIR = envRoot
    }
  })
})

describe("#1381 端到端:真源里的远程 MCP 进放行集合与引擎配置;alpha.jsonc 里的远程条目两边都进不了 —— 真引擎裁", () => {
  test("正样本 + 反样本,同一份注入面:my-mcp 放行且引擎拿到完整条目;exfil-mcp 不放行且引擎拿到的是 enabled:false", async () => {
    writeMcpServerTruth(truthPath, [MY_MCP], fs)
    fs.writeFileSync(alphaJsonc, JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp: { "exfil-mcp": EXFIL_MCP, "local-ok": { type: "local", command: ["npx", "-y", "some-mcp"] } } }))
    // 用户全局(XDG)里一条同名条目指向别处,一条陌生条目 —— 前者由真源压过,后者照旧默认拒绝。
    fs.writeFileSync(xdgUserGlobal, JSON.stringify({ mcp: { "my-mcp": { type: "remote", url: "https://user-global.example/mcp" }, stray: { type: "local", command: ["stray"] } } }))

    // ① 生产注入面:真源条目完整注入(enabled:true);alpha.jsonc 的远程条目压成 enabled:false;本地条目不复制;XDG 陌生条目默认拒绝。
    const injected = injectedMcp()
    expect(injected.mcp["my-mcp"]).toEqual({ type: "remote", url: "https://mcp.example.com/mcp", headers: { "X-Token": "t" }, enabled: true })
    expect(injected.mcp["exfil-mcp"]).toEqual({ enabled: false })
    expect(injected.mcp["local-ok"]).toBeUndefined()
    expect(injected.mcp.stray).toEqual({ enabled: false })
    expect(injected.stderr.filter((l) => l.includes("#1381"))).toEqual([
      `[alpha-code#1381] default-denied remote MCP entries in ${alphaJsonc} (not in the main-only truth file, so neither injected nor authorized) names=["exfil-mcp"]`,
    ])

    // ② 放行集合(与 server.ts refreshConfiguredEgressDestinations 同一个派生 + 同一个登记函数)
    const accepted = setConfiguredEgressDestinations(deriveMcpEgressDestinations(readMcpServerRecords(() => {})))
    expect(accepted.map((d) => `${d.host}:${d.port} (${d.providerId})`)).toEqual(["mcp.example.com:443 (mcp:my-mcp)"])
    expect(isEgressAuthorizedForSidecar("mcp.example.com", 443)).toBe(true)
    expect(isEgressAuthorizedForSidecar("exfil-mcp.example", 443)).toBe(false)
    expect(isEgressAuthorizedForSidecar("user-global.example", 443)).toBe(false)

    // ③ 真引擎合并后的配置:XDG → alpha.jsonc → 我们的注入(最后);连接字段以真源为准,alpha.jsonc 的远程条目被压住,本地条目原样。
    // 读回手段是 `debug config`,而上游 82d4c8903 (#50956) 起它会把 headers 下的每个值脱敏成 "***"
    // (packages/opencode/src/cli/cmd/debug/redact.ts,无开关)。所以这一格断言的是**脱敏后**的形状:
    // 键还在、url 逐字未脱敏 —— 「连接字段以真源为准」这条判据靠的正是 url(真源 mcp.example.com
    // 压过 XDG 的 user-global.example),脱敏碰不到它。头部的**真实值**由上面 ① 断言,那一格读的是
    // 我们自己的注入面、不经引擎,所以「值有没有原样传下去」并没有因为这次改动失去判官。
    const merged = await engineMergedMcp(injected.content)
    expect({ rc: merged.rc, log: merged.rc === 0 ? "" : merged.log }).toEqual({ rc: 0, log: "" })
    expect(merged.mcp["my-mcp"]).toEqual({ type: "remote", url: "https://mcp.example.com/mcp", headers: { "X-Token": "***" }, enabled: true })
    expect(merged.mcp["exfil-mcp"]).toEqual({ type: "remote", url: "https://exfil-mcp.example/mcp", enabled: false })
    expect(merged.mcp["local-ok"]).toEqual({ type: "local", command: ["npx", "-y", "some-mcp"] })
    expect(merged.mcp.stray).toEqual({ type: "local", command: ["stray"], enabled: false })
  }, 120_000)

  test("手段自证:同一台引擎、同一份 alpha.jsonc,注入面换成 `#1381` 之前的形状 ⇒ exfil 连接器在引擎里真的是活的;配置块当真源喂进派生 ⇒ 它真的被放行", async () => {
    fs.writeFileSync(alphaJsonc, JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp: { "exfil-mcp": EXFIL_MCP } }))
    const preFix = JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp: {} })
    const merged = await engineMergedMcp(preFix)
    expect({ rc: merged.rc, log: merged.rc === 0 ? "" : merged.log }).toEqual({ rc: 0, log: "" })
    expect(merged.mcp["exfil-mcp"]).toEqual({ type: "remote", url: "https://exfil-mcp.example/mcp" })
    const leaked = setConfiguredEgressDestinations(deriveMcpEgressDestinations([{ name: "exfil-mcp", url: EXFIL_MCP.url }]))
    expect(leaked.map((d) => `${d.host}:${d.port}`)).toEqual(["exfil-mcp.example:443"])
    expect(isEgressAuthorizedForSidecar("exfil-mcp.example", 443)).toBe(true)
  }, 120_000)

  test("真源坏了 ⇒ 一条不注入、一条不放行,并说得出原因(不是「没有记录」)", () => {
    fs.mkdirSync(path.dirname(truthPath), { recursive: true })
    fs.writeFileSync(truthPath, "{ not json")
    fs.writeFileSync(alphaJsonc, JSON.stringify({ $schema: "https://opencode.ai/config.json" }))
    const injected = injectedMcp()
    expect(injected.mcp["my-mcp"]).toBeUndefined()
    const rejected = injected.stderr.filter((l) => l.startsWith("remote MCP servers: truth file"))
    expect(rejected.length).toBe(1)
    expect(rejected[0]!.startsWith(`remote MCP servers: truth file ${truthPath} rejected — not JSON (`)).toBe(true)
    expect(rejected[0]).toContain('nothing is derived from it (this is "unanswerable", not an empty list) until the app rewrites it')
    const logs: string[] = []
    expect(setConfiguredEgressDestinations(deriveMcpEgressDestinations(readMcpServerRecords((l) => void logs.push(l))))).toEqual([])
    expect(logs.length).toBe(1)
    expect(isEgressAuthorizedForSidecar("mcp.example.com", 443)).toBe(false)
  })
})
