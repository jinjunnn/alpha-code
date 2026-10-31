// REQ-234 `#1531`:agent 的三个定制中心工具(hub-tools.ts)。
//   I2 参数只有字符串标识(键集合精确相等,没有任何密钥形状的字段);
//   I3 确认框一定会出现:钉子在真 AlphaExt 的 config 钩子里、在末位、自动化 agent 是 deny;拿掉钉子 ⇒ ask 直接放行 ⇒
//      查不到记录 ⇒「not installed: no confirmation box ran」(工具自己装不了任何东西);
//   I7 always: [];
//   I9 结局以 main 记录的 requestId 阶段为准:submitted / committed 之后醒来(期限到 / reject 回执)不报「用户拒绝」。
// 真 Permission.ask 那一半(默认配置下引擎真的发布请求;回复 always 不抵消下一次)在
// packages/opencode/test/permission/alpha-hub-install-ask.test.ts。
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HubRequestRecord, HubView, HubViewRow } from "../../ui-mac/src/main/alpha-sidecar-messages"
import type { HubBridge } from "./hub-bridge"
import { createHubTools, HUB_INSTALL_OUTCOME, HUB_NEXT_MESSAGE_HINT, HUB_PRICE_NOTE_MISSING, pinHubInstallPermission } from "./hub-tools"

const row = (patch: Partial<HubViewRow>): HubViewRow => ({
  id: "mcp:github",
  scope: null,
  name: "github",
  kind: "mcp",
  displayName: "GitHub",
  description: "repos",
  installed: false,
  enabled: false,
  state: "not-installed",
  authorization: "secret:GITHUB_TOKEN",
  ...patch,
})

function bridgeWith(script: { views: HubView[]; record?: HubRequestRecord | null }) {
  const calls = { view: [] as unknown[], request: [] as string[] }
  const bridge: HubBridge = {
    available: true,
    view: async (input) => {
      calls.view.push(input)
      const next = script.views.length > 1 ? script.views.shift()! : script.views[0]!
      return { ok: true, view: next }
    },
    request: async (requestId) => {
      calls.request.push(requestId)
      return { ok: true, record: script.record === undefined ? null : script.record && { ...script.record, requestId } }
    },
    report: () => {},
    onReloadRequest: () => {},
  }
  return { bridge, calls }
}

function ctxWith(ask: (input: unknown) => Promise<void>) {
  const asks: Array<{ permission: string; patterns: string[]; always: string[]; metadata: Record<string, any> }> = []
  return {
    asks,
    ctx: {
      sessionID: "ses_1",
      messageID: "msg_1",
      agent: "build",
      directory: "/work/a",
      worktree: "/work/a",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async (input: (typeof asks)[number]) => {
        asks.push(input)
        await ask(input)
      },
    },
  }
}

const outputOf = (r: unknown) => (typeof r === "string" ? r : (r as { output: string }).output)
const view = (rows: HubViewRow[]): HubView => ({ directory: "/work/a", rows, warnings: [] })

describe("I2:参数只有字符串标识", () => {
  test("三个工具的参数键集合精确相等,且没有任何密钥形状的字段名", () => {
    const tools = createHubTools(bridgeWith({ views: [view([])] }).bridge)
    expect(Object.keys(tools).sort()).toEqual(["codepuppy_hub_install", "codepuppy_hub_search", "codepuppy_hub_status"])
    expect(Object.keys(tools.codepuppy_hub_search.args)).toEqual(["query"])
    expect(Object.keys(tools.codepuppy_hub_install.args)).toEqual(["catalogId"])
    expect(Object.keys(tools.codepuppy_hub_status.args)).toEqual(["catalogId"])
    for (const t of Object.values(tools))
      for (const key of Object.keys(t.args)) expect(key).not.toMatch(/secret|token|key|password|dsn|env|grant/i)
  })
})

describe("I3:确认框一定会出现(钉子)", () => {
  test("pinHubInstallPermission:全局与每个 agent 末位;用户写的 allow 被移到前面压住;codepuppy-automation* 是 deny", () => {
    const cfg: Record<string, unknown> = {
      permission: { codepuppy_hub_install: "allow", "*": "allow" },
      agent: { build: { permission: { "*": "allow" } }, "codepuppy-automation": { permission: { "*": "allow" } }, "codepuppy-automation-standard": {}, plan: {} },
    }
    pinHubInstallPermission(cfg)
    expect(Object.entries(cfg.permission as object).at(-1)).toEqual(["codepuppy_hub_install", "ask"])
    expect(Object.keys(cfg.permission as object)).toEqual(["*", "codepuppy_hub_install"])
    const agents = cfg.agent as Record<string, { permission: Record<string, string> }>
    expect(Object.entries(agents.build!.permission).at(-1)).toEqual(["codepuppy_hub_install", "ask"])
    expect(agents.plan!.permission).toEqual({ codepuppy_hub_install: "ask" })
    expect(agents["codepuppy-automation"]!.permission.codepuppy_hub_install).toBe("deny")
    expect(agents["codepuppy-automation-standard"]!.permission).toEqual({ codepuppy_hub_install: "deny" })
    const stringy: Record<string, unknown> = { permission: "allow" }
    pinHubInstallPermission(stringy)
    expect(stringy.permission).toEqual({ "*": "allow", codepuppy_hub_install: "ask" })
  })

  const SANITIZE = ["ALPHA_GLOBAL_DIR", "ALPHA_FACTORY_SKILL_DIRS", "ALPHA_FACTORY_DENY_SKILLS"] as const
  const saved = new Map<string, string | undefined>()
  let root = ""
  beforeEach(() => {
    for (const k of SANITIZE) saved.set(k, process.env[k])
    for (const k of SANITIZE) delete process.env[k]
    root = realpathSync(mkdtempSync(join(tmpdir(), "alpha-hub-pin-")))
    const global = join(root, "alpha-code-state", "env", "dev")
    mkdirSync(global, { recursive: true })
    mkdirSync(join(root, "project"), { recursive: true })
    process.env.ALPHA_GLOBAL_DIR = global
  })
  afterEach(() => {
    for (const k of SANITIZE) {
      const v = saved.get(k)
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(root, { recursive: true, force: true })
  })

  test("真 AlphaExt 的 config 钩子钉住它(在 finally 里:项目配置读不了的 early return 也照钉);工具表里有三个工具", async () => {
    const { AlphaExt } = await import("./plugin")
    const hooks = (await AlphaExt({
      directory: join(root, "project"),
      worktree: join(root, "project"),
      client: { instance: { dispose: async () => {} }, provider: { list: async () => ({ data: { all: [] } }) } },
    } as unknown as Parameters<typeof AlphaExt>[0])) as unknown as {
      config: (cfg: unknown) => Promise<void>
      tool: Record<string, unknown>
    }
    const cfg: Record<string, unknown> = { permission: { "*": "allow" }, agent: { mine: { permission: { "*": "allow" } } } }
    await hooks.config(cfg)
    expect(Object.entries(cfg.permission as object).at(-1)).toEqual(["codepuppy_hub_install", "ask"])
    const agents = cfg.agent as Record<string, { permission: Record<string, string> }>
    expect(Object.entries(agents.mine!.permission).at(-1)).toEqual(["codepuppy_hub_install", "ask"])
    for (const name of ["codepuppy_hub_search", "codepuppy_hub_install", "codepuppy_hub_status"]) expect(Object.keys(hooks.tool)).toContain(name)

    // 项目配置读不了(alpha.jsonc 是个目录 ⇒ 读失败分支)⇒ try 体后半段整段跳过(提示词接管没跑 = 走的确实是那条分支),钉子照钉
    mkdirSync(join(root, "project", ".code-puppy", "alpha.jsonc"), { recursive: true })
    const broken: Record<string, unknown> = { permission: { "*": "allow" } }
    await hooks.config(broken)
    expect((broken.agent as Record<string, unknown> | undefined)?.general).toBeUndefined()
    expect(Object.entries(broken.permission as object).at(-1)).toEqual(["codepuppy_hub_install", "ask"])
  })

  test("拿掉钉子(规则放行 ⇒ ctx.ask 直接返回)⇒ 查不到记录 ⇒ not installed: no confirmation box ran", async () => {
    const { bridge, calls } = bridgeWith({ views: [view([row({})])], record: null })
    const { ctx, asks } = ctxWith(async () => {})
    const out = outputOf(await createHubTools(bridge).codepuppy_hub_install.execute({ catalogId: "mcp:github" }, ctx))
    expect(out.split("\n")[0]).toBe(HUB_INSTALL_OUTCOME.noBox)
    expect(asks).toHaveLength(1)
    // I7 + 运输形状:always 恒空;metadata 只有 alphaHub 的 catalogId 与 requestId;查的正是这一次的 requestId
    expect(asks[0]).toEqual({
      permission: "codepuppy_hub_install",
      patterns: ["mcp:github"],
      always: [],
      metadata: { alphaHub: { catalogId: "mcp:github", requestId: calls.request[0] } },
    })
    expect(calls.request[0]).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
  })

  test("目录里没有的 id ⇒ unknown entry,根本不发审批请求", async () => {
    const { bridge, calls } = bridgeWith({ views: [view([row({})])] })
    const { ctx, asks } = ctxWith(async () => {})
    const out = outputOf(await createHubTools(bridge).codepuppy_hub_install.execute({ catalogId: "mcp:nope" }, ctx))
    expect(out.split("\n")[0]).toBe(HUB_INSTALL_OUTCOME.unknownEntry)
    expect(asks).toHaveLength(0)
    expect(calls.request).toHaveLength(0)
  })
})

describe("I9:结局以 main 的阶段记录为准", () => {
  const reject = async () => {
    throw new Error("rejected")
  }
  const cases: Array<{ name: string; record: HubRequestRecord; after: HubViewRow[]; ask: () => Promise<void>; want: string }> = [
    { name: "submitted + 期限到(ask 抛)⇒ 已提交,结果待定 —— 不是拒绝", record: { requestId: "x", catalogId: "mcp:github", stage: "submitted" }, after: [], ask: reject, want: HUB_INSTALL_OUTCOME.submitted },
    {
      name: "committed + reject 回执 ⇒ 按该行(id, scope)此刻的档:available",
      record: { requestId: "x", catalogId: "mcp:github", stage: "committed", scope: "global" },
      after: [row({ scope: "global", installed: true, enabled: true, state: "available" })],
      ask: reject,
      want: HUB_INSTALL_OUTCOME.available,
    },
    {
      name: "committed ⇒ reload pending(带原因)",
      record: { requestId: "x", catalogId: "mcp:github", stage: "committed", scope: "global" },
      after: [row({ scope: "global", installed: true, enabled: true, state: "reload-pending", stateReason: { code: "reload-waiting", detail: "1 session(s) busy" } })],
      ask: async () => {},
      want: `${HUB_INSTALL_OUTCOME.reloadPending} (waiting: 1 session(s) busy)`,
    },
    {
      name: "committed ⇒ 装完即停用",
      record: { requestId: "x", catalogId: "mcp:github", stage: "committed", scope: "global" },
      after: [row({ scope: "global", installed: true, enabled: false, state: "installed", stateReason: { code: "disabled" } })],
      ask: async () => {},
      want: HUB_INSTALL_OUTCOME.disabledByPolicy,
    },
    {
      name: "committed 到项目作用域 ⇒ 读的是 project 那一行,不是同名 global",
      record: { requestId: "x", catalogId: "mcp:github", stage: "committed", scope: "project" },
      after: [
        row({ scope: "global", installed: true, enabled: true, state: "available" }),
        row({ scope: "project", installed: true, enabled: true, state: "reload-pending", stateReason: { code: "not-loaded", detail: "MCP failed" } }),
      ],
      ask: async () => {},
      want: `${HUB_INSTALL_OUTCOME.reloadPending} (not loaded in this directory: MCP failed)`,
    },
    { name: "declined ⇒ declined", record: { requestId: "x", catalogId: "mcp:github", stage: "declined" }, after: [], ask: reject, want: HUB_INSTALL_OUTCOME.declined },
    {
      name: "failed ⇒ declined 带原因",
      record: { requestId: "x", catalogId: "mcp:github", stage: "failed", reason: "runtime missing: uv" },
      after: [],
      ask: reject,
      want: `${HUB_INSTALL_OUTCOME.declined}: install failed — runtime missing: uv`,
    },
  ]
  for (const c of cases)
    test(c.name, async () => {
      const { bridge } = bridgeWith({ views: [view([row({})]), view(c.after)], record: c.record })
      const { ctx } = ctxWith(c.ask)
      const out = outputOf(await createHubTools(bridge).codepuppy_hub_install.execute({ catalogId: "mcp:github" }, ctx))
      expect(out).toBe(`${c.want}\n${HUB_NEXT_MESSAGE_HINT}`)
    })
})

describe("codepuppy_hub_search / codepuppy_hub_status", () => {
  test("#1533:价格说明逐字输出;缺说明才给末尾缺项句(混合列表与 warnings 同样成立)", async () => {
    const priced = row({ id: "cloud:html", kind: "cloud", priceNote: "预留 US$1.00,按实际用量结算;失败时已产生的费用仍会结算" })
    const missing = row({ id: "cloud:docs", kind: "cloud" })
    for (const rows of [[priced], [missing], [priced, missing]]) {
      const input = { ...view(rows), warnings: ["unreadable ledger"] }
      const tools = createHubTools(bridgeWith({ views: [input] }).bridge)
      const { ctx } = ctxWith(async () => {})
      const out = outputOf(await tools.codepuppy_hub_search.execute({ query: "" }, ctx))
      for (const [index, item] of rows.entries()) {
        const parsed = JSON.parse(out.split("\n")[index]!)
        if (item.priceNote !== undefined) expect(parsed.priceNote).toBe(item.priceNote)
        else expect(parsed).not.toHaveProperty("priceNote")
      }
      expect(out.includes(HUB_PRICE_NOTE_MISSING)).toBe(rows.includes(missing))
      if (rows.includes(missing)) expect(out.split("\n").at(-1)).toBe("本目录尚未提供价格说明;费用以服务端为准")
      expect(outputOf(await tools.codepuppy_hub_status.execute({ catalogId: rows[0]!.id }, ctx)).includes(HUB_PRICE_NOTE_MISSING)).toBe(rows[0] === missing)
    }
  })

  test("search:按会话目录问、带 sessionID / agent;每行只含视图字段;云条目在场时末尾固定缺项句;main 的 warnings 不原样外发", async () => {
    const rows = [
      row({ scope: "global", installed: true, enabled: true, state: "reload-pending", stateReason: { code: "reload-failed", detail: "reload failed 3 times — restart the app to apply" } }),
      row({ id: "cloud:ocr", name: "ocr", kind: "cloud", displayName: "OCR", authorization: "platform-login" }),
    ]
    const { bridge, calls } = bridgeWith({ views: [{ directory: "/work/a", rows, warnings: ["ledger /Users/x/installs.json unreadable"] }] })
    const { ctx } = ctxWith(async () => {})
    const out = outputOf(await createHubTools(bridge).codepuppy_hub_search.execute({ query: "o" }, ctx))
    expect(calls.view[0]).toEqual({ directory: "/work/a", sessionID: "ses_1", agent: "build", query: "o" })
    const lines = out.split("\n")
    expect(JSON.parse(lines[0]!)).toEqual({
      id: "mcp:github",
      scope: "global",
      name: "GitHub",
      type: "mcp",
      description: "repos",
      installed: true,
      enabled: true,
      state: "reload-pending",
      reason: "last reload failed: reload failed 3 times — restart the app to apply",
      authorization: "secret:GITHUB_TOKEN",
    })
    expect(lines).toContain(HUB_PRICE_NOTE_MISSING)
    expect(out).not.toContain("installs.json")
  })

  test("status:只回该 id 的行(同名 global / project 各一行);不认识 ⇒ unknown entry;无 parentPort 宿主 ⇒ 如实说不可用", async () => {
    const rows = [row({ scope: "global", installed: true, enabled: true, state: "available" }), row({ scope: "project", installed: true, enabled: true, state: "available" }), row({ id: "skill:x", kind: "skill" })]
    const { bridge } = bridgeWith({ views: [view(rows)] })
    const { ctx } = ctxWith(async () => {})
    const out = outputOf(await createHubTools(bridge).codepuppy_hub_status.execute({ catalogId: "mcp:github" }, ctx))
    expect(out.split("\n").map((line) => JSON.parse(line).scope)).toEqual(["global", "project"])
    expect(outputOf(await createHubTools(bridge).codepuppy_hub_status.execute({ catalogId: "nope" }, ctx)).split("\n")[0]).toBe(HUB_INSTALL_OUTCOME.unknownEntry)
    const none: HubBridge = { ...bridge, available: false }
    for (const t of Object.values(createHubTools(none)))
      expect(outputOf(await t.execute({ query: "", catalogId: "mcp:github" } as never, ctx))).toBe("The Customization Center is not available in this engine host.")
  })
})
