// REQ-037 — 治理层单测:保护名单硬校验、物化叶子计算(denylist/allowlist)、apply/reset 端到端
// (真临时目录:ALPHA_GLOBAL_DIR + 受控 home jsonc;验收③⑥⑦ 的机制面)。
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_BUILTIN_POLICY,
  applyBuiltinPolicy,
  effectiveFactoryDenied,
  materializeEdits,
  normalizeBuiltinPolicy,
  resetBuiltinPolicy,
  validateBuiltinPolicy,
  type BuiltinPolicy,
} from "./alpha-builtin-policy"

let tmp: string
const gov = (over: Partial<BuiltinPolicy> = {}): BuiltinPolicy => ({
  ...structuredClone(DEFAULT_BUILTIN_POLICY),
  ...over,
})

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "alpha-gov-"))
  process.env.ALPHA_GLOBAL_DIR = join(tmp, "alpha-global")
  // ext-config 的 home jsonc 目标经 opencodeHomeDir() —— 测试用 ALPHA_OPENCODE_HOME 隔离(现成覆盖点)
  process.env.ALPHA_OPENCODE_HOME = join(tmp, "home", ".opencode")
  mkdirSync(join(tmp, "home"), { recursive: true })
})
afterEach(() => {
  delete process.env.ALPHA_GLOBAL_DIR
  delete process.env.ALPHA_OPENCODE_HOME
  rmSync(tmp, { recursive: true, force: true })
})

// REQ-059:治理键(mcpPluginTargetPath)随 alpha 真源迁 ~/.alpha/alpha.jsonc(默认无逃生)。
const jsoncPath = () => join(tmp, "alpha-global", "alpha.jsonc")
const readJsonc = () => JSON.parse(readFileSync(jsoncPath(), "utf8"))

describe("validateBuiltinPolicy — 保护名单硬校验(验收③)", () => {
  test("disable compaction/title/summary → loud 拒绝", () => {
    const v = validateBuiltinPolicy(gov({ agents: { hide: [], disable: ["compaction"], allow: [], override: {} } }), false)
    expect(v.length).toBe(1)
    expect(v[0].reason).toContain("compaction")
  })
  test("disable/hide alpha-automation → 拒绝(S18 X2)", () => {
    expect(validateBuiltinPolicy(gov({ agents: { hide: ["alpha-automation"], disable: [], allow: [], override: {} } }), false).length).toBe(1)
    expect(validateBuiltinPolicy(gov({ agents: { hide: [], disable: ["alpha-automation"], allow: [], override: {} } }), false).length).toBe(1)
  })
  test("disable build:未确认拒绝,确认后放行", () => {
    const g = gov({ agents: { hide: [], disable: ["build"], allow: [], override: {} } })
    expect(validateBuiltinPolicy(g, false).length).toBe(1)
    expect(validateBuiltinPolicy(g, true).length).toBe(0)
  })
})

describe("materializeEdits — 物化叶子计算", () => {
  test("denylist:hide/disable/override → agent.<n>.<字段> 叶子", () => {
    const g = gov({
      agents: { hide: ["build"], disable: ["explore"], allow: [], override: { plan: { prompt: "自定义" } } },
    })
    const paths = materializeEdits(g, ["build", "plan", "general", "explore"]).map((e) => e.path.join("."))
    expect(paths).toContain("agent.build.hidden")
    expect(paths).toContain("agent.explore.disable")
    expect(paths).toContain("agent.plan.prompt")
    expect(paths).not.toContain("agent.general.hidden") // denylist:未列名不动
  })
  test("allowlist:可见未列名一律 hidden,保护/alpha 注入豁免(验收⑦)", () => {
    const g = gov({ mode: "allowlist", agents: { hide: [], disable: [], allow: ["build"], override: {} } })
    const paths = materializeEdits(g, ["build", "plan", "general", "alpha-automation", "compaction"]).map((e) => e.path.join("."))
    expect(paths).not.toContain("agent.build.hidden") // 在 allow
    expect(paths).toContain("agent.plan.hidden")
    expect(paths).toContain("agent.general.hidden")
    expect(paths).not.toContain("agent.alpha-automation.hidden") // 豁免
    expect(paths).not.toContain("agent.compaction.hidden") // 豁免
  })
  test("skill deny → permission.skill.<n>=deny + 同名 command 占位模板(泄漏缓解,验收④)", () => {
    const g = gov({ skills: { deny: ["customize-opencode"] } })
    const edits = materializeEdits(g, [])
    const m = new Map(edits.map((e) => [e.path.join("."), e.value]))
    expect(m.get("permission.skill.customize-opencode")).toBe("deny")
    expect(String(m.get("command.customize-opencode.template"))).toContain("已在 alpha 的治理设置中被禁用")
    expect(edits.find((e) => e.path.join(".") === "permission.skill.*")?.onlyIfAbsent).toBe(true)
  })
  test("command override → command.<n>.template(重写 /init,验收⑤)", () => {
    const g = gov({ commands: { override: { init: { template: "alpha 版 init 模板" } } } })
    const m = new Map(materializeEdits(g, []).map((e) => [e.path.join("."), e.value]))
    expect(m.get("command.init.template")).toBe("alpha 版 init 模板")
  })
})

describe("applyBuiltinPolicy / resetBuiltinPolicy — 端到端(叶子写入不破坏用户内容,验收⑥)", () => {
  test("apply 写入受控叶子;用户自有兄弟字段保留;重放清 stale;reset 全量净除", () => {
    // 用户已有的 jsonc 内容(同名 agent 的兄弟字段 + 无关顶键)
    mkdirSync(join(tmp, "alpha-global"), { recursive: true })
    writeFileSync(jsoncPath(), JSON.stringify({ theme: "dark", agent: { explore: { temperature: 0.5 } } }, null, 2))

    const g1 = gov({ agents: { hide: [], disable: ["explore"], allow: [], override: {} }, skills: { deny: ["customize-opencode"] } })
    const r1 = applyBuiltinPolicy(g1, ["build", "explore"])
    expect(r1.ok).toBe(true)
    let cfg = readJsonc()
    expect(cfg.agent.explore.disable).toBe(true)
    expect(cfg.agent.explore.temperature).toBe(0.5) // 用户兄弟字段保留
    expect(cfg.theme).toBe("dark")
    expect(cfg.permission.skill["customize-opencode"]).toBe("deny")
    expect(cfg.command["customize-opencode"].template).toContain("禁用")

    // 重放:撤掉 skill deny → stale 键(permission/command 占位)应被移除,disable 保留
    const g2 = gov({ agents: { hide: [], disable: ["explore"], allow: [], override: {} } })
    const r2 = applyBuiltinPolicy(g2, ["build", "explore"])
    expect(r2.ok).toBe(true)
    expect(r2.removedStale).toBeGreaterThan(0)
    cfg = readJsonc()
    expect(cfg.agent.explore.disable).toBe(true)
    expect(cfg.permission).toBeUndefined() // 空壳剪枝
    expect(cfg.command).toBeUndefined()

    // reset:全量净除,用户内容原样
    const r3 = resetBuiltinPolicy()
    expect(r3.ok).toBe(true)
    cfg = readJsonc()
    expect(cfg.agent.explore.disable).toBeUndefined()
    expect(cfg.agent.explore.temperature).toBe(0.5)
    expect(cfg.theme).toBe("dark")
  })
  test("codex H1 回归:用户预设 permission.skill.* 不入账,reset 不删(用户全局 deny 保留)", () => {
    mkdirSync(join(tmp, "alpha-global"), { recursive: true })
    writeFileSync(jsoncPath(), JSON.stringify({ permission: { skill: { "*": "deny" } } }, null, 2))
    const g = gov({ skills: { deny: ["customize-opencode"] } })
    expect(applyBuiltinPolicy(g, []).ok).toBe(true)
    let cfg = readJsonc()
    expect(cfg.permission.skill["*"]).toBe("deny") // onlyIfAbsent 跳过,用户值不动
    expect(applyBuiltinPolicy(gov(), []).ok).toBe(true) // 撤 deny → stale 清除
    cfg = readJsonc()
    expect(cfg.permission.skill["*"]).toBe("deny") // 用户通配保留(未入账 → 未被当 stale 删)
    expect(cfg.permission.skill["customize-opencode"]).toBeUndefined()
  })
  test("allowlist 漂移环防护:被隐藏 agent 从可见列表消失后,重放不清其 hidden 叶子", () => {
    const g = gov({ mode: "allowlist", agents: { hide: [], disable: [], allow: ["build"], override: {} } })
    expect(applyBuiltinPolicy(g, ["build", "plan"]).ok).toBe(true)
    let cfg = readJsonc()
    expect(cfg.agent.plan.hidden).toBe(true)
    // 第二次 apply:renderer 只报可见的 build(plan 已被隐)—— hidden 叶子必须保留,不得被当 stale 清掉
    expect(applyBuiltinPolicy(g, ["build"]).ok).toBe(true)
    cfg = readJsonc()
    expect(cfg.agent.plan.hidden).toBe(true)
  })
  test("保护违规 → apply 整体拒绝,jsonc 不动", () => {
    const g = gov({ agents: { hide: [], disable: ["compaction"], allow: [], override: {} } })
    const r = applyBuiltinPolicy(g, [])
    expect(r.ok).toBe(false)
    expect(r.reason).toContain("compaction")
  })
})

describe("normalizeBuiltinPolicy — renderer 原始输入清洗", () => {
  test("非法字段/名字被剔除;坏形状回默认", () => {
    const g = normalizeBuiltinPolicy({
      version: 1,
      mode: "denylist",
      agents: { hide: ["ok-name", "bad/../name"], disable: [], allow: [], override: { x: { prompt: "p", evil: "e" } } },
      skills: { deny: [123, "fine"] },
      commands: { override: { init: { template: "t" }, bad: { notemplate: 1 } } },
    })
    expect(g.agents.hide).toEqual(["ok-name"])
    expect(g.agents.override.x).toEqual({ prompt: "p" })
    expect(g.skills.deny).toEqual(["fine"])
    expect(Object.keys(g.commands.override)).toEqual(["init"])
    expect(normalizeBuiltinPolicy({ mode: "nope" }).mode).toBe("denylist")
  })
})

describe("REQ-067 — 出厂默认禁内置化(deny 零明文)", () => {
  test("normalize:出厂项从 deny 收敛剔除(历史数据自愈);allowFactory 只认出厂清单内的名字", () => {
    const g = normalizeBuiltinPolicy({
      version: 1,
      mode: "denylist",
      agents: { hide: [], disable: [], allow: [], override: {} },
      skills: { deny: ["customize-opencode", "my-own"], allowFactory: ["customize-opencode", "not-factory"] },
      commands: { override: {} },
    })
    expect(g.skills.deny).toEqual(["my-own"]) // 出厂项不入用户 deny
    expect(g.skills.allowFactory).toEqual(["customize-opencode"]) // 清单外的解禁无意义,清洗
  })
  test("effectiveFactoryDenied:默认全禁;用户解禁后移出(env 注入与菜单过滤共用此口径)", () => {
    expect(effectiveFactoryDenied(DEFAULT_BUILTIN_POLICY)).toEqual(["customize-opencode"])
    const g = normalizeBuiltinPolicy({ ...structuredClone(DEFAULT_BUILTIN_POLICY), skills: { deny: [], allowFactory: ["customize-opencode"] } })
    expect(effectiveFactoryDenied(g)).toEqual([])
  })
  test("materializeEdits:出厂项零物化 —— 空治理不产生任何 permission/command 叶子", () => {
    const edits = materializeEdits(structuredClone(DEFAULT_BUILTIN_POLICY), [])
    expect(edits).toEqual([])
  })
})

// ── O4 钉测 — 账实分离自愈(S50 真机白捡)────────────────────────────────────────────
// 现场:REQ-067 前的老 governance 把出厂禁物化进当时的目标文件;REQ-059 迁真源后,新真源
// alpha.jsonc 没这些键但旧账还在 → normalize 洗掉 deny 使 4 键全变 stale 删除 → 修前
// jsonc-parser 对缺父路径的删除 throw,任何 apply/reset 永久失败(治理面全砖)。
describe("O4 — 幽灵旧账不砖治理面,成功 apply 后记账自愈", () => {
  const ledgerPath = () => join(tmp, "alpha-global", "governance-materialized.json")
  const phantomLedger = () =>
    writeFileSync(
      ledgerPath(),
      JSON.stringify({
        keys: [
          ["permission", "skill", "*"],
          ["permission", "skill", "customize-opencode"],
          ["command", "customize-opencode", "description"],
          ["command", "customize-opencode", "template"],
        ],
      }),
    )

  test("apply:幽灵 stale 跳过、真实写入生效、记账收敛只剩实际写入", () => {
    mkdirSync(join(tmp, "alpha-global"), { recursive: true })
    writeFileSync(jsoncPath(), JSON.stringify({ theme: "dark" }, null, 2))
    phantomLedger()
    // 老 governance.json 形状(deny 含出厂项)→ normalize 自愈洗掉 deny
    const legacy = normalizeBuiltinPolicy({
      version: 1,
      mode: "denylist",
      agents: { hide: ["plan"], disable: [], allow: [], override: {} },
      skills: { deny: ["customize-opencode"] },
      commands: { override: {} },
    })
    const r = applyBuiltinPolicy(legacy, ["build", "plan"])
    expect(r.ok).toBe(true)
    const cfg = readJsonc()
    expect(cfg.agent.plan.hidden).toBe(true)
    expect(cfg.theme).toBe("dark") // 用户内容不动
    expect(cfg.permission).toBeUndefined() // 幽灵删除零副作用
    expect(cfg.command).toBeUndefined()
    const ledger = JSON.parse(readFileSync(ledgerPath(), "utf8"))
    expect(ledger.keys).toEqual([["agent", "plan", "hidden"]]) // 幽灵键出账
  })

  test("reset:同样现场不砖,记账清空、用户内容原样", () => {
    mkdirSync(join(tmp, "alpha-global"), { recursive: true })
    writeFileSync(jsoncPath(), JSON.stringify({ theme: "dark" }, null, 2))
    phantomLedger()
    const r = resetBuiltinPolicy()
    expect(r.ok).toBe(true)
    expect(JSON.parse(readFileSync(ledgerPath(), "utf8")).keys).toEqual([])
    expect(readJsonc().theme).toBe("dark")
  })
})
