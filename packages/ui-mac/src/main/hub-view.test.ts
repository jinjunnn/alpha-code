// REQ-234 `#1529`(基线 §2.5 / §2.3 / §2.2;不变量 I4、I6、I9 的 main 半边)。
//
// 夹具:真盘账本(upsertRecordV2)+ 引擎在 HTTP 层的替身(只替换 fetch,SDK 客户端与 tool-policy 客户端都是生产的)。
// 定制中心那一侧的调用**只带目录**(renderer 从不发送会话字段);agent 那一侧带 sessionID / agent。
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Wildcard } from "../../../core/src/util/wildcard"
import { CLOUD_DISPATCH_REMOTE_TOOL } from "../../../ext/src/cloud-contract-hook"
import type { CatalogEntry } from "../renderer/extensions/catalog-types"
import { AGENT_NOTE_DENIED, AGENT_NOTE_UNVERIFIED, type AlphaSidecarOutbound, type HubViewRow } from "./alpha-sidecar-messages"
import { applyPackageMutation, projectScopeIdentity, upsertRecordV2, type UpsertInput } from "./ext-receipt-v2"
import { bundleOwner, computeInstalledGraphDigest } from "./ext-package-ledger-v3"
import type { CatalogPackageViewV1 } from "../shared/catalog-package-view"
import { decodePackageProfilePayloadV1 } from "../shared/host-extension-package-contract/decoder"
import {
  CLOUD_DISPATCH_TOOL,
  createAlphaSidecarHost,
  createHubRequestStages,
  createHubViewService,
  skillActionFor,
  wildcardMatch,
  type HubViewDeps,
} from "./hub-view"
import { createReloadCoordinator } from "./reload-coordinator"

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "hub-view-")))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const entry = (over: Partial<CatalogEntry> & { id: string; type: CatalogEntry["type"]; name: string }): CatalogEntry => ({
  displayName: `${over.name} display`,
  description: `${over.name} description`,
  source: "official",
  category: "test",
  ...over,
})

const CATALOG: CatalogEntry[] = [
  entry({ id: "skill:writer", type: "skill", name: "writer" }),
  entry({ id: "skill:twin", type: "skill", name: "twin" }),
  entry({ id: "mcp:files", type: "mcp", name: "files", installSpec: { kind: "mcp", mcpType: "local", command: ["x"], requiredEnvVars: ["FILES_TOKEN"] } }),
  entry({ id: "mcp:off", type: "mcp", name: "off", installSpec: { kind: "mcp", mcpType: "local", command: ["x"] } }),
  entry({ id: "agent:planner", type: "agent", name: "planner" }),
  entry({ id: "cloud:docs", type: "cloud", name: "cloud-docs" }),
  entry({ id: "skill:browse-only", type: "skill", name: "browse-only" }),
  entry({ id: "skill:unverified", type: "skill", name: "unverified", _verify: "claim not checked" }),
]

const record = (root: string, over: Partial<UpsertInput> & Pick<UpsertInput, "id" | "name" | "kind">) => {
  const result = upsertRecordV2(root, {
    environment: "prod",
    scope: { kind: "global" },
    desiredState: "enabled",
    origin: "catalog",
    installedAt: "2026-10-14T00:00:00.000Z",
    ...over,
  })
  if (!result.ok) throw new Error(result.reason)
}

type Engine = {
  mcp: Record<string, { status: string; error?: string }>
  skills: Array<{ name: string; location: string }>
  agents: Array<Record<string, unknown>>
  commands: Array<{ name: string }>
  sessions: Record<string, { permission?: unknown }>
  cloudDispatch?: "enabled" | "ask" | "disabled"
}

function engineFetch(engine: Engine, seen: string[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const directory = url.searchParams.get("directory") ?? decodeURIComponent(request.headers.get("x-opencode-directory") ?? "")
    seen.push(`${url.pathname}@${directory}`)
    if (url.pathname === "/mcp") return Response.json(engine.mcp)
    if (url.pathname === "/skill") return Response.json(engine.skills)
    if (url.pathname === "/agent") return Response.json(engine.agents)
    if (url.pathname === "/command") return Response.json(engine.commands)
    if (url.pathname.startsWith("/session/")) {
      const session = engine.sessions[url.pathname.slice("/session/".length)]
      return session ? Response.json({ id: "x", ...session }) : Response.json({ message: "not found" }, { status: 404 })
    }
    if (url.pathname === "/api/permission/tool-policy/inventory")
      return Response.json({
        data: {
          version: 1,
          partition: { account: "anonymous", workspace: "prj_1" },
          user: { status: "absent" },
          managed: { status: "ok" },
          classRecords: [],
          services: engine.cloudDispatch
            ? [
                {
                  source: "mcp",
                  origin: "cloud",
                  class: "codepuppy-cloud",
                  authority: { kind: "not-asserted" },
                  tools: [
                    {
                      canonical: "mcp:cloud:cloud_dispatch",
                      identity: { source: "mcp", origin: "cloud", name: "cloud_dispatch" },
                      technicalId: "cloud_cloud_dispatch",
                      authority: { kind: "not-asserted" },
                      effective: { state: engine.cloudDispatch, action: "allow", reason: { kind: "default", class: "codepuppy-cloud" } },
                      newlyDiscovered: false,
                    },
                  ],
                },
              ]
            : [],
          invalid: { count: 0, entries: [] },
        },
      })
    return new Response("not found", { status: 404 })
  }) as typeof fetch
}

function world(
  name: string,
  extra: { packages?: CatalogPackageViewV1[]; projectMcpState?: HubViewDeps["projectMcpState"] } = {},
) {
  const globalRoot = join(tmp, name, "global")
  const projectDir = join(tmp, name, "project")
  const workspace = join(tmp, name, "workspace")
  mkdirSync(globalRoot, { recursive: true })
  mkdirSync(join(projectDir, ".code-puppy"), { recursive: true })
  mkdirSync(workspace, { recursive: true })
  const skillDir = join(globalRoot, "skills", "writer")
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: writer\n---\n")
  const elsewhere = join(tmp, name, "elsewhere", "twin")
  mkdirSync(elsewhere, { recursive: true })
  writeFileSync(join(elsewhere, "SKILL.md"), "---\nname: twin\n---\n")
  mkdirSync(join(globalRoot, "skills", "twin"), { recursive: true })

  record(globalRoot, { id: "skill:writer", name: "writer", kind: "skill" })
  record(globalRoot, { id: "skill:twin", name: "twin", kind: "skill" })
  record(globalRoot, { id: "mcp:files", name: "files", kind: "mcp" })
  record(globalRoot, { id: "mcp:off", name: "off", kind: "mcp", desiredState: "disabled" })
  record(globalRoot, { id: "agent:planner", name: "planner", kind: "agent" })
  record(globalRoot, { id: "cloud:docs", name: "cloud-docs", kind: "cloud" })

  const engine: Engine = {
    mcp: { files: { status: "connected" }, cloud: { status: "connected" } },
    skills: [
      { name: "writer", location: join(skillDir, "SKILL.md") },
      { name: "twin", location: join(elsewhere, "SKILL.md") },
    ],
    agents: [{ name: "planner", mode: "subagent", permission: [], options: {} }],
    commands: [],
    sessions: {},
    cloudDispatch: "enabled",
  }
  const seen: string[] = []
  const coordinator = createReloadCoordinator({ log: () => {}, onChange: () => {} })
  const deps: HubViewDeps = {
    resolveCatalog: async () => ({ entries: CATALOG, channel: "cache", version: "1.0.0", ...(extra.packages ? { packages: extra.packages } : {}) }),
    advisoryBlocked: () => new Set(),
    seedDir: null,
    globalRoot: () => globalRoot,
    projectEntry: (directory) =>
      directory === projectDir ? { ok: true, projectDir, root: join(projectDir, ".code-puppy") } : { ok: false, reason: "not a project" },
    defaultDirectory: () => workspace,
    projectMcpState: extra.projectMcpState ?? (async () => "unverifiable"),
    awaitServer: async () => ({ url: "http://127.0.0.1:39117", username: "opencode", password: "pw" }),
    pendingFor: (directory) => coordinator.pendingFor(directory),
    fetch: engineFetch(engine, seen),
    timeoutMs: 2_000,
  }
  return { globalRoot, projectDir, workspace, engine, seen, coordinator, service: createHubViewService(deps) }
}

const row = (rows: HubViewRow[], id: string) => {
  const found = rows.filter((r) => r.id === id)
  if (found.length !== 1) throw new Error(`expected one row for ${id}, got ${found.length}`)
  return found[0]!
}

describe("hub-view 三档状态(§2.5)", () => {
  test("各种类按本目录即时核验:可用 / 待重载(带原因)/ 已安装(停用)/ 未安装", async () => {
    const w = world("kinds")
    const view = await w.service.view(w.projectDir)
    expect(view.directory).toBe(w.projectDir)
    expect(row(view.rows, "skill:writer")).toMatchObject({ scope: "global", installed: true, enabled: true, state: "available" })
    // 同名但 location 不在 main 为它装的目录里 = 引擎加载的是另一个技能
    expect(row(view.rows, "skill:twin")).toMatchObject({
      state: "reload-pending",
      stateReason: { code: "not-loaded", detail: "a different skill with this name is loaded" },
    })
    expect(row(view.rows, "mcp:files")).toMatchObject({ state: "available", authorization: "secret:FILES_TOKEN" })
    expect(row(view.rows, "mcp:off")).toMatchObject({ installed: true, enabled: false, state: "installed", stateReason: { code: "disabled" } })
    expect(row(view.rows, "agent:planner")).toMatchObject({ state: "available" })
    expect(row(view.rows, "cloud:docs")).toMatchObject({ state: "available", authorization: "platform-login" })
    expect(row(view.rows, "skill:browse-only")).toMatchObject({
      scope: null,
      installed: false,
      state: "not-installed",
      displayName: "browse-only display",
      description: "browse-only description",
    })
    // 不在可安装视图里的目录条目不出现(未核实声明)
    expect(view.rows.some((r) => r.id === "skill:unverified")).toBe(false)
    // 每一次引擎读都带着查询的目录
    expect(w.seen.length).toBeGreaterThan(0)
    expect(w.seen.every((line) => line.endsWith(`@${w.projectDir}`))).toBe(true)
  })

  test("未装上:无在途重载 ⇒ not-loaded;在途 ⇒ reload-waiting;报告失败 ⇒ reload-failed;报告成功后回到核验细节", async () => {
    const w = world("reasons")
    w.engine.skills = []
    w.engine.mcp.files = { status: "failed" }
    let view = await w.service.view(w.projectDir)
    expect(row(view.rows, "skill:writer").stateReason).toEqual({ code: "not-loaded", detail: "skill not loaded" })
    expect(row(view.rows, "mcp:files").stateReason).toEqual({ code: "not-loaded", detail: "MCP failed" })

    const sent: AlphaSidecarOutbound[] = []
    w.coordinator.attach((m) => void sent.push(m))
    const { generation } = w.coordinator.request({ scope: "global", items: [{ id: "skill:writer", scope: "global" }], reason: "installed skill writer" })
    view = await w.service.view(w.projectDir)
    expect(row(view.rows, "skill:writer")).toMatchObject({ state: "reload-pending", stateReason: { code: "reload-waiting", detail: "queued" } })
    w.coordinator.receiveReport({ type: "alpha.reload.report", generation, scope: "global", outcome: "failed", directories: [], error: "dispose refused" })
    view = await w.service.view(w.projectDir)
    expect(row(view.rows, "skill:writer").stateReason).toEqual({ code: "reload-failed", detail: "dispose refused" })
    expect(row(view.rows, "mcp:files").stateReason).toEqual({ code: "reload-failed", detail: "dispose refused" })
    w.coordinator.receiveReport({ type: "alpha.reload.report", generation, scope: "global", outcome: "reloaded", directories: [] })
    view = await w.service.view(w.projectDir)
    expect(row(view.rows, "skill:writer").stateReason).toEqual({ code: "not-loaded", detail: "skill not loaded" })
    // 核验通过就是可用,与在途重载无关
    w.engine.skills = [{ name: "writer", location: join(w.globalRoot, "skills", "writer", "SKILL.md") }]
    w.coordinator.request({ scope: "global", items: [], reason: "again" })
    view = await w.service.view(w.projectDir)
    expect(row(view.rows, "skill:writer").state).toBe("available")
  })

  test("云条目(基线 §2.5 云行 / DECIDE #1524):连接 ∧ cloud_dispatch 在列且 enabled 才可用;否则最高 installed + 缺什么,不取在途重载的原因", async () => {
    const w = world("cloud")
    w.coordinator.request({ scope: "global", items: [], reason: "x" })
    w.engine.cloudDispatch = "ask"
    expect(row((await w.service.view(w.projectDir)).rows, "cloud:docs")).toMatchObject({
      installed: true,
      enabled: true,
      state: "installed",
      stateReason: { code: "not-loaded", detail: "cloud_dispatch is ask by tool policy" },
    })
    w.engine.cloudDispatch = undefined
    expect(row((await w.service.view(w.projectDir)).rows, "cloud:docs")).toMatchObject({
      state: "installed",
      stateReason: { code: "not-loaded", detail: "cloud_dispatch is not in this directory's tool list" },
    })
    w.engine.cloudDispatch = "enabled"
    w.engine.mcp.cloud = { status: "needs_auth" }
    expect(row((await w.service.view(w.projectDir)).rows, "cloud:docs")).toMatchObject({
      state: "installed",
      stateReason: { code: "not-loaded", detail: "cloud MCP needs_auth" },
    })
    w.engine.mcp.cloud = { status: "connected" }
    expect(row((await w.service.view(w.projectDir)).rows, "cloud:docs").state).toBe("available")
    expect(CLOUD_DISPATCH_TOOL).toBe(CLOUD_DISPATCH_REMOTE_TOOL)
  })

  // `#1531`(#1529 审计 Minor ①②):重载修不好的不给重载 —— MCP 要授权(原状态词透传)、没有核验判据的种类(存量 plugin)
  // 落 installed + 原因,即使有在途重载也不说「等重载」(那会让定制中心出一个只会打断会话的「现在重载」)。
  test("要授权的 MCP / 没有核验判据的种类 ⇒ installed + not-loaded 原因,不取在途重载的原因", async () => {
    const w = world("not-reloadable")
    record(w.globalRoot, { id: "plugin:legacy", name: "legacy", kind: "plugin" })
    w.coordinator.request({ scope: "global", items: [], reason: "x" })
    for (const status of ["needs_auth", "needs_client_registration"]) {
      w.engine.mcp.files = { status }
      expect(row((await w.service.view(w.projectDir)).rows, "mcp:files")).toMatchObject({
        installed: true,
        enabled: true,
        state: "installed",
        stateReason: { code: "not-loaded", detail: `MCP ${status}` },
      })
    }
    // 对照:普通失败仍是待重载、取在途重载的原因
    w.engine.mcp.files = { status: "failed" }
    expect(row((await w.service.view(w.projectDir)).rows, "mcp:files")).toMatchObject({ state: "reload-pending", stateReason: { code: "reload-waiting" } })
    expect(row((await w.service.view(w.projectDir)).rows, "plugin:legacy")).toMatchObject({
      state: "installed",
      stateReason: { code: "not-loaded", detail: 'no verification for kind "plugin"' },
    })
  })

  // `#1563`:引擎在后台启动 MCP 时报 pending。它是准备中,不是失败 —— 落 installed、不出重载入口、不取在途重载
  // 的原因(重载修不好「还没连上」);后台重连的那次带着上一次失败,细节里附上。对照:failed 仍是待重载。
  test("#1563:pending 的 MCP / 云条目 ⇒ installed(准备中),不出重载入口;后台重连附上次失败", async () => {
    const w = world("pending")
    w.coordinator.request({ scope: "global", items: [], reason: "x" })
    w.engine.mcp.files = { status: "pending" }
    expect(row((await w.service.view(w.projectDir)).rows, "mcp:files")).toMatchObject({
      installed: true,
      enabled: true,
      state: "installed",
      stateReason: { code: "not-loaded", detail: "MCP pending" },
    })
    w.engine.mcp.files = { status: "pending", error: "fetch failed: connect ECONNREFUSED 127.0.0.1:443" }
    expect(row((await w.service.view(w.projectDir)).rows, "mcp:files").stateReason).toEqual({
      code: "not-loaded",
      detail: "MCP pending (last failure: fetch failed: connect ECONNREFUSED 127.0.0.1:443)",
    })
    w.engine.cloudDispatch = "enabled"
    w.engine.mcp.cloud = { status: "pending" }
    expect(row((await w.service.view(w.projectDir)).rows, "cloud:docs")).toMatchObject({
      state: "installed",
      stateReason: { code: "not-loaded", detail: "cloud MCP pending" },
    })
    w.engine.mcp.files = { status: "failed" }
    expect(row((await w.service.view(w.projectDir)).rows, "mcp:files")).toMatchObject({
      state: "reload-pending",
      stateReason: { code: "reload-waiting" },
    })
  })

  // 审计 F2:项目范围的 MCP 走既有 D-scoped 判据(projectMcpState)。引擎报 pending 时判据给的是独立的 pending,
  // 不能落成「待重载 + 现在重载」(重载修不好「还没连上」);对照:shadowed 仍是待重载。
  test("#1563:项目范围的 MCP 判据为 pending ⇒ installed(准备中),不出重载入口", async () => {
    let state = "pending"
    const w = world("project-pending", { projectMcpState: async () => state })
    const identity = projectScopeIdentity(w.projectDir)
    if (!identity.ok) throw new Error(identity.reason)
    record(join(w.projectDir, ".code-puppy"), { id: "user:proj", name: "proj", kind: "mcp", origin: "created", scope: identity.scope })
    w.coordinator.request({ scope: "project", items: [], reason: "x" })
    expect(row((await w.service.view(w.projectDir)).rows, "user:proj")).toMatchObject({
      scope: "project",
      state: "installed",
      stateReason: { code: "not-loaded", detail: "project MCP pending" },
    })
    state = "shadowed"
    expect(row((await w.service.view(w.projectDir)).rows, "user:proj")).toMatchObject({ state: "reload-pending" })
  })

  test("#1533:真实 cloud@1 载荷的预留说明进包行与云组件行;旧云条目缺席 priceNote", async () => {
    // 来源:2ddd2fb0cfb79d6af64fcb91569c27202c579772 的
    // docs/verification/2026-10-15-req235-cloud-package-evidence/results/html-preview.json → payloads["cloud:html"]。
    const decoded = decodePackageProfilePayloadV1("cloud", new Uint8Array(await Bun.file(join(import.meta.dir, "fixtures/hub-cloud-payload.json")).arrayBuffer()), [])
    expect(decoded.ok).toBe(true)
    if (!decoded.ok || decoded.payload.schema !== "alpha.host-extension-package.payload.cloud.v1") throw new Error("cloud fixture invalid")
    const pkg: CatalogPackageViewV1 = {
      catalogId: "package:cloud-html",
      verdict: "compatible",
      action: { kind: "install", enabled: true, reasonCode: "package-compatible" },
      components: [{ componentId: "cloud:html", role: "root", required: true, included: true, skipReasonCode: null }],
      prerequisites: { status: "ready", items: [] },
      presentation: { displayName: "云端网页生成", description: "描述页面内容与样式，云端生成可下载的 HTML 网页。", version: "1.0.0" },
      cloud: decoded.payload.behavior,
    }
    const w = world("prices", { packages: [pkg] })
    record(w.globalRoot, { id: "cloud:html", kind: "cloud", name: "html" })
    for (const view of [await w.service.view(w.projectDir), await w.service.viewForAgent({ directory: w.projectDir })]) {
      for (const id of ["package:cloud-html", "cloud:html"])
        expect(row(view.rows, id).priceNote).toBe("预留 US$1.00,按实际用量结算;失败时已产生的费用仍会结算。")
      expect(row(view.rows, "cloud:docs")).not.toHaveProperty("priceNote")
    }
  })

  // 审计 R1 Major 2:签名包(catalog.packages,main 评估过的 CatalogPackageViewV1)也是「客户端可安装的条目」——
  // agent 的视图里必须有它(否则 hub_install 对 package:* 答 unknown entry);装上之后按它的组件行定档。
  test("签名包进视图:可安装 ⇒ not-installed 包行(带前置条件名);装上 ⇒ 按组件行定档(全可用 = available,缺加载 = 待重载 + 组件原因)", async () => {
    const pkg: CatalogPackageViewV1 = {
      catalogId: "package:kit",
      verdict: "compatible",
      action: { kind: "install", enabled: true, reasonCode: "package-compatible" },
      components: [{ componentId: "skill:kit-skill", role: "root", required: true, included: true, skipReasonCode: null }],
      prerequisites: { status: "required-action", items: [{ prerequisiteId: "skill:kit-skill#KIT_TOKEN", label: "Kit token", required: true }] },
      presentation: { displayName: "Kit", description: "a kit", version: "1.0.0" },
    }
    const blocked: CatalogPackageViewV1 = { ...pkg, catalogId: "package:blocked", verdict: "blocked", action: { kind: "none", enabled: false, reasonCode: "package-invalid" } }
    const w = world("packages", { packages: [pkg, blocked] })
    const before = await w.service.viewForAgent({ directory: w.projectDir })
    expect(row(before.rows, "package:kit")).toMatchObject({
      scope: null,
      kind: "package",
      displayName: "Kit",
      description: "a kit",
      installed: false,
      state: "not-installed",
      authorization: "secret:skill:kit-skill#KIT_TOKEN",
    })
    expect(before.rows.some((r) => r.id === "package:blocked")).toBe(false)

    // 生产写器装包:图 + 子记录(组件 skill:kit-skill)
    const digest = `sha256:${"c".repeat(64)}`
    const node = { componentId: "skill:kit-skill", kind: "skill" as const, name: "kit-skill", required: true, manifestDigest: digest }
    const graph = { packageId: "package:kit", envelopeDigest: `sha256:${"d".repeat(64)}`, root: node, children: [] }
    const applied = applyPackageMutation(w.globalRoot, {
      transactionId: "tx-kit-1",
      operation: "install",
      graphBeforeDigest: null,
      graphAfter: { ...graph, installedGraphDigest: computeInstalledGraphDigest(graph) },
      childRecordMutations: [
        {
          op: "upsert",
          input: { id: "skill:kit-skill", name: "kit-skill", kind: "skill", environment: "prod", scope: { kind: "global" }, version: "1.0.0", manifestDigest: digest, desiredState: "enabled", origin: "catalog", installedAt: "2026-10-15T00:00:00.000Z" },
        },
      ],
      claimMutations: [{ op: "acquire", kind: "skill", name: "kit-skill", owner: bundleOwner("package:kit", digest) }],
    })
    if (!applied.ok) throw new Error(applied.reason)
    const kitDir = join(w.globalRoot, "skills", "kit-skill")
    mkdirSync(kitDir, { recursive: true })
    writeFileSync(join(kitDir, "SKILL.md"), "---\nname: kit-skill\n---\n")
    expect(row((await w.service.viewForAgent({ directory: w.projectDir })).rows, "package:kit")).toMatchObject({
      scope: "global",
      kind: "package",
      installed: true,
      enabled: true,
      state: "reload-pending",
      stateReason: { code: "not-loaded", detail: "skill kit-skill: skill not loaded" },
    })
    w.engine.skills.push({ name: "kit-skill", location: join(kitDir, "SKILL.md") })
    const after = await w.service.view(w.projectDir)
    expect(row(after.rows, "package:kit")).toMatchObject({ scope: "global", installed: true, state: "available" })
    // 定制中心那一侧读的是同一档(I4)
    expect(row((await w.service.viewForAgent({ directory: w.projectDir })).rows, "package:kit").state).toBe("available")
  })

  test("引擎读不出 ⇒ 不标可用(核不了 = 待重载 + 原因),停用条目照旧只看账本", async () => {
    const w = world("engine-down")
    const service = createHubViewService({
      resolveCatalog: async () => ({ entries: CATALOG, channel: "cache", version: "1.0.0" }),
      advisoryBlocked: () => new Set(),
      seedDir: null,
      globalRoot: () => w.globalRoot,
      projectEntry: () => ({ ok: false, reason: "no" }),
      defaultDirectory: () => w.workspace,
      projectMcpState: async () => "unverifiable",
      awaitServer: async () => ({ url: "http://127.0.0.1:39117", username: "opencode", password: "pw" }),
      pendingFor: () => undefined,
      fetch: (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch,
      timeoutMs: 500,
    })
    const view = await service.view()
    expect(view.directory).toBe(w.workspace)
    for (const id of ["skill:writer", "mcp:files", "agent:planner"])
      expect(row(view.rows, id)).toMatchObject({ state: "reload-pending", stateReason: { code: "not-loaded" } })
    expect(row(view.rows, "cloud:docs")).toMatchObject({ state: "installed", stateReason: { code: "not-loaded" } })
    expect(row(view.rows, "mcp:off").state).toBe("installed")
  })
})

describe("I4:定制中心与 agent 读同一档,会话只进 agentNote", () => {
  test("同一夹具两侧逐行同档同原因;agent 侧多出的只有技能行的 agentNote", async () => {
    const w = world("i4")
    w.engine.skills = [{ name: "writer", location: join(w.globalRoot, "skills", "writer", "SKILL.md") }]
    w.engine.agents = [
      { name: "planner", mode: "subagent", permission: [], options: {} },
      { name: "build", mode: "primary", permission: [{ permission: "*", pattern: "*", action: "allow" }], options: {} },
    ]
    w.engine.sessions = { ses_1: { permission: [{ permission: "skill", pattern: "writ*", action: "deny" }] } }
    const hub = await w.service.view(w.projectDir)
    const agent = await w.service.viewForAgent({ directory: w.projectDir, sessionID: "ses_1", agent: "build" })
    const strip = (rows: HubViewRow[]) => rows.map(({ agentNote: _note, ...rest }) => rest)
    expect(strip(agent.rows)).toEqual(strip(hub.rows))
    expect(hub.rows.every((r) => r.agentNote === undefined)).toBe(true)
    // 会话规则拒绝 writer:状态词不变(仍 available),只多一条 agentNote
    expect(row(agent.rows, "skill:writer")).toMatchObject({ state: "available", agentNote: AGENT_NOTE_DENIED })
    // twin 没被拒:无 agentNote;非技能行永远没有
    expect(row(agent.rows, "skill:twin").agentNote).toBeUndefined()
    expect(row(agent.rows, "mcp:files").agentNote).toBeUndefined()
  })

  test("缺会话输入 / 会话读不出 / agent 不在:技能行 agentNote = 本会话权限未核验,状态词不变", async () => {
    const w = world("i4-missing")
    const hub = await w.service.view(w.projectDir)
    for (const request of [
      { directory: w.projectDir },
      { directory: w.projectDir, sessionID: "ses_missing", agent: "planner" },
      { directory: w.projectDir, sessionID: "ses_1", agent: "nobody" },
    ]) {
      w.engine.sessions = { ses_1: {} }
      const agent = await w.service.viewForAgent(request)
      expect(row(agent.rows, "skill:writer")).toMatchObject({ state: row(hub.rows, "skill:writer").state, agentNote: AGENT_NOTE_UNVERIFIED })
    }
  })

  test("query 只过滤行,不改任何一行的档", async () => {
    const w = world("query")
    const all = await w.service.view(w.projectDir)
    const filtered = await w.service.viewForAgent({ directory: w.projectDir, query: "FILES" })
    expect(filtered.rows.map((r) => r.id)).toEqual(["mcp:files"])
    expect(row(filtered.rows, "mcp:files").state).toBe(row(all.rows, "mcp:files").state)
  })

  test("技能权限求值与引擎同规则:扁平拼接 + findLast,通用 * 规则参与;wildcard 与上游 match 逐例一致", () => {
    expect(skillActionFor("writer", [{ permission: "*", pattern: "*", action: "allow" }], [])).toBe("allow")
    expect(skillActionFor("writer", [{ permission: "*", pattern: "*", action: "deny" }], [{ permission: "skill", pattern: "writer", action: "allow" }])).toBe("allow")
    expect(skillActionFor("writer", [{ permission: "skill", pattern: "writer", action: "allow" }], [{ permission: "*", pattern: "*", action: "deny" }])).toBe("deny")
    expect(skillActionFor("writer", [], [])).toBe("ask")
    const cases: Array<[string, string]> = [
      ["skill", "*"], ["skill", "skill"], ["skill", "sk?ll"], ["skill", "skills"], ["writer", "wr*"], ["a.b", "a.b"], ["axb", "a.b"],
      ["ls -la", "ls *"], ["ls", "ls *"], ["a\\b", "a/b"], ["(x)", "(x)"], ["x+y", "x+y"], ["line\nbreak", "line*"], ["", "*"], ["$HOME", "$HOME"],
    ]
    for (const [input, pattern] of cases) expect(wildcardMatch(input, pattern)).toBe(Wildcard.match(input, pattern))
  })
})

describe("I9 main 半边:安装请求的阶段只前进、committed 只由安装体写", () => {
  const ID = "req_abcdef12"
  test("confirming → submitted → committed(带作用域);之后的 declined / failed 一律被拒", () => {
    const stages = createHubRequestStages({ log: () => {} })
    expect(stages.record({ requestId: ID, stage: "confirming", catalogId: "skill:writer" })).toEqual({ ok: true })
    expect(stages.record({ requestId: ID, stage: "submitted" })).toEqual({ ok: true })
    // 300 s 期限到了、引擎广播 reject 回执:不得被记成「用户拒绝」
    expect(stages.record({ requestId: ID, stage: "declined" }).ok).toBe(false)
    expect(stages.get(ID)).toEqual({ requestId: ID, catalogId: "skill:writer", stage: "submitted" })
    stages.settleInstall(ID, { ok: true, catalogId: "skill:writer", scope: "global" })
    expect(stages.get(ID)).toEqual({ requestId: ID, catalogId: "skill:writer", stage: "committed", scope: "global" })
    expect(stages.record({ requestId: ID, stage: "declined" }).ok).toBe(false)
    expect(stages.record({ requestId: ID, stage: "failed", reason: "late" }).ok).toBe(false)
    stages.settleInstall(ID, { ok: false, reason: "late failure" })
    expect(stages.get(ID)?.stage).toBe("committed")
  })

  test("renderer 写不了 committed;没有 confirming 就没有记录;catalogId 不可中途换", () => {
    const stages = createHubRequestStages({ log: () => {} })
    expect(stages.record({ requestId: ID, stage: "committed", catalogId: "skill:writer" }).ok).toBe(false)
    expect(stages.record({ requestId: ID, stage: "submitted", catalogId: "skill:writer" }).ok).toBe(false)
    expect(stages.get(ID)).toBeNull()
    stages.settleInstall(ID, { ok: true, catalogId: "skill:writer", scope: "global" })
    expect(stages.get(ID)).toBeNull()
    expect(stages.record({ requestId: ID, stage: "confirming", catalogId: "skill:writer" }).ok).toBe(true)
    expect(stages.record({ requestId: ID, stage: "submitted" }).ok).toBe(true)
    // 已确认、已提交 —— renderer 照样写不了 committed(只有亲眼看到提交成功的安装体能写)
    expect(stages.record({ requestId: ID, stage: "committed", catalogId: "skill:writer" }).ok).toBe(false)
    expect(stages.get(ID)?.stage).toBe("submitted")
    expect(stages.record({ requestId: ID, stage: "failed", catalogId: "mcp:files" }).ok).toBe(false)
    expect(stages.record({ requestId: "bad id", stage: "confirming", catalogId: "x" }).ok).toBe(false)
  })

  test("用户取消:confirming → declined;安装失败:submitted → failed(带原因)", () => {
    const stages = createHubRequestStages({ log: () => {} })
    stages.record({ requestId: ID, stage: "confirming", catalogId: "skill:writer" })
    expect(stages.record({ requestId: ID, stage: "declined" })).toEqual({ ok: true })
    const other = "req_zyxwvu98"
    stages.record({ requestId: other, stage: "confirming", catalogId: "mcp:files" })
    stages.record({ requestId: other, stage: "submitted" })
    stages.settleInstall(other, { ok: false, reason: "missing DSN" })
    expect(stages.get(other)).toEqual({ requestId: other, catalogId: "mcp:files", stage: "failed", reason: "missing DSN" })
  })
})

describe("I6:main 侧 alpha.* 分发只做只读查询与重载记录", () => {
  test("视图请求 → 应答;阶段查询 → 应答(没有记录 = null);重载报告进 coordinator;形状不对丢弃并记一行;不是本族 = false", async () => {
    const w = world("host")
    const logs: string[] = []
    const stages = createHubRequestStages({ log: () => {} })
    const host = createAlphaSidecarHost({ view: w.service, requests: stages, reloads: w.coordinator, log: (line) => logs.push(line) })
    const posted: AlphaSidecarOutbound[] = []
    const post = (m: AlphaSidecarOutbound) => void posted.push(m)

    expect(host.receive({ type: "write-probe-result", id: 1, outcome: "writable" }, post)).toBe(false)
    expect(host.receive({ type: "alpha.hub.install", catalogId: "mcp:files" }, post)).toBe(true)
    expect(host.receive({ type: "alpha.hub.view.request", id: "1", directory: w.projectDir }, post)).toBe(true)
    expect(posted).toEqual([])
    expect(logs.filter((l) => l.includes("dropped malformed")).length).toBe(2)

    expect(host.receive({ type: "alpha.hub.request.request", id: 5, requestId: "req_abcdef12" }, post)).toBe(true)
    expect(posted.pop()).toEqual({ type: "alpha.hub.request.reply", id: 5, record: null })

    host.receive({ type: "alpha.hub.view.request", id: 6, directory: w.projectDir, sessionID: "ses_1", agent: "build" }, post)
    await new Promise((resolve) => setTimeout(resolve, 200))
    const reply = posted.pop()
    if (!reply || reply.type !== "alpha.hub.view.reply" || !("view" in reply)) throw new Error(`expected view reply, got ${JSON.stringify(reply)}`)
    expect(reply.id).toBe(6)
    expect(row(reply.view.rows, "mcp:files").state).toBe("available")

    const sent: AlphaSidecarOutbound[] = []
    host.attach((m) => void sent.push(m))
    const { generation } = w.coordinator.request({ scope: "global", items: [], reason: "x" })
    expect(sent.map((m) => m.type)).toEqual(["alpha.reload.request"])
    host.receive({ type: "alpha.reload.report", generation, scope: "global", outcome: "waiting", directories: [], error: "1 session(s) busy" }, post)
    expect(w.coordinator.pendingFor("/any")).toEqual({ code: "reload-waiting", detail: "1 session(s) busy" })
  })

  test("应答发不出去(sidecar 已退出):记一行,不抛", () => {
    const w = world("host-dead")
    const logs: string[] = []
    const stages = createHubRequestStages({ log: () => {} })
    const host = createAlphaSidecarHost({ view: w.service, requests: stages, reloads: w.coordinator, log: (line) => logs.push(line) })
    expect(() =>
      host.receive({ type: "alpha.hub.request.request", id: 1, requestId: "req_abcdef12" }, () => {
        throw new Error("Cannot post to a dead process")
      }),
    ).not.toThrow()
    expect(logs.some((l) => l.includes("could not be delivered"))).toBe(true)
  })
})
