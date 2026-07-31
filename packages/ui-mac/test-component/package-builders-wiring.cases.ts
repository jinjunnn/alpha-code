// REQ-128 #705 production wiring gate.
//
// 判据不是「builders 与 router 能用」——那是单元测试。判据是**生产接线真的经过它们**:
//   ① 真实注册的 `ext-install-catalog` IPC 装一个 agent package,必须经 buildAgentTxItems;
//   ② 同一通道装一个带密钥的 MCP package,必须经 buildMcpTxItems;
//   ③ `registerExtIpcHandlers` 的恢复接线(recoveryOpts)必须由 extensionHealthProbeRouter 造探针;
//   ④ 装 agent 时引擎真正调到的那个探针,必须是 router 造出来的那一个(pre-switch + post-switch)。
//
// 反向确认过:把 package-admission 的 builder 调用换回内联构造、或把 ext-ipc 的 recoveryOpts.probe
// 换回手写组合,以上计数分别归零 —— 本文件转红。计数器包着**真实现**转调,所以行为不被改写。
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, mock, test } from "bun:test"
import type { PackageAdmissionPreviewV1 } from "../src/shared/package-admission"

type IpcHandler = (event: { sender: { id: number } }, ...args: unknown[]) => unknown

const handlers = new Map<string, IpcHandler>()
const tmp = mkdtempSync(join(tmpdir(), "req128-705-wiring-"))
const userData = join(tmp, "user-data")

const sha = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex")
const canonicalBytes = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`)

const AGENT_MD = "---\nname: wired-agent\ndescription: REQ-128 705 wiring fixture\nmode: subagent\n---\nprompt body\n"
const agentAssetBytes = new TextEncoder().encode(AGENT_MD)
const secretCanary = "REQ128_705_WIRING_SECRET_4a71c9"

const agentPayload = {
  schema: "alpha.host-extension-package.payload.agent.v1",
  behavior: {
    targetDir: "alpha-agents",
    asset: {
      sha256: sha(agentAssetBytes),
      bytes: agentAssetBytes.byteLength,
      mediaType: "text/markdown",
      url: "https://assets.test/req128-705/agent.md",
    },
  },
}
const mcpPayload = {
  schema: "alpha.host-extension-package.payload.mcp-remote.v1",
  behavior: {
    url: "https://mcp.example.invalid/service",
    headersTemplate: { Authorization: "Bearer {A_KEY}" },
    requiredSecrets: ["A_KEY"],
    auth: "none",
  },
}
const agentPayloadBytes = canonicalBytes(agentPayload)
const mcpPayloadBytes = canonicalBytes(mcpPayload)

const envelope = (
  packageId: string,
  componentId: string,
  profileId: string,
  payloadBytes: Uint8Array,
  capabilities: string[],
  payloadUrl: string,
) => ({
  schema: "alpha.host-extension-package.v1",
  prelude: { packageId, version: "1.0.0" },
  presentation: { displayName: componentId, description: "REQ-128 #705 wiring fixture" },
  components: [
    {
      id: componentId,
      required: true,
      dependencies: [],
      profileId,
      profileVersion: 1,
      capabilities,
      payloadRef: {
        sha256: sha(payloadBytes),
        bytes: payloadBytes.byteLength,
        mediaType: `application/vnd.alpha.host-extension-package.${profileId}.v1+json`,
        url: payloadUrl,
      },
    },
  ],
  capabilities,
})

const agentEnvelope = envelope(
  "package:wired-agent",
  "agent:wired-agent",
  "agent",
  agentPayloadBytes,
  [],
  "https://assets.test/req128-705/agent-payload.json",
)
const mcpEnvelope = envelope(
  "package:wired-mcp",
  "mcp:wired-mcp",
  "mcp-remote",
  mcpPayloadBytes,
  ["alpha.secret-prerequisite.v1"],
  "https://assets.test/req128-705/mcp-payload.json",
)
const snapshotDigest = "4".repeat(64)

// ── 计数器:包住真实现,不改写行为 ────────────────────────────────────────────────────────────
const builderCalls = { skill: 0, agent: 0, mcp: 0 }
const routerCalls = { built: 0, invoked: [] as Array<{ key: string; action: string; phase: string }> }

// mock.module 会就地改写已导入的命名空间对象 —— 真实现必须先取成本地引用,否则包装器会自调。
const buildersModule = await import("../src/main/ext-package-tx-builders")
const realSkillBuilder = buildersModule.buildSkillTxItems
const realAgentBuilder = buildersModule.buildAgentTxItems
const realMcpBuilder = buildersModule.buildMcpTxItems
mock.module("../src/main/ext-package-tx-builders", () => ({
  ...buildersModule,
  buildSkillTxItems: (...args: Parameters<typeof realSkillBuilder>) => {
    builderCalls.skill++
    return realSkillBuilder(...args)
  },
  buildAgentTxItems: (...args: Parameters<typeof realAgentBuilder>) => {
    builderCalls.agent++
    return realAgentBuilder(...args)
  },
  buildMcpTxItems: (...args: Parameters<typeof realMcpBuilder>) => {
    builderCalls.mcp++
    return realMcpBuilder(...args)
  },
}))

const routerModule = await import("../src/main/ext-health-probe-router")
const realRouterFactory = routerModule.extensionHealthProbeRouter
mock.module("../src/main/ext-health-probe-router", () => ({
  ...routerModule,
  extensionHealthProbeRouter: (root: string) => {
    routerCalls.built++
    const probe = realRouterFactory(root)
    return async (input: Parameters<typeof probe>[0]) => {
      routerCalls.invoked.push({ key: input.key, action: input.action, phase: input.phase })
      return probe(input)
    }
  },
}))

mock.module("electron", () => ({
  BrowserWindow: class {
    static fromWebContents() {
      return undefined
    }
  },
  dialog: {
    showMessageBox: async () => ({ response: 1, checkboxChecked: false }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  },
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler),
  },
}))

mock.module("../src/main/ipc", () => ({
  pickedFiles: {
    read: async () => {
      throw new Error("unexpected picked-file read")
    },
  },
}))

mock.module("../src/main/logging", () => ({
  getLogger: () => ({ error: () => {}, log: () => {}, warn: () => {} }),
}))

mock.module("../src/main/ext-advisory-gate", () => ({
  listAdvisoryBlockedFacts: () => ({ ids: [], fresh: true }),
  makeAdvisoryGate: () => () => ({ allowed: true }),
}))

mock.module("../src/main/remote-catalog", () => ({
  downloadRemoteAsset: async () => ({ ok: false, reason: "unexpected remote asset download" }),
  readCachedCatalog: () => null,
  registerPackageCatalogReadIpcHandlers: (
    register: (channel: string, handler: IpcHandler) => void,
    refresh: () => Promise<unknown>,
  ) => {
    register("ext-remote-catalog", () => refresh())
    register("ext-package-detail", () => null)
  },
  refreshRemoteCatalog: async () => ({
    source: "remote",
    catalog: { version: "2026-07-31", entries: [{}], packages: [agentEnvelope, mcpEnvelope] },
    version: "2026-07-31",
    fetchedAt: "2026-07-31T00:00:00.000Z",
    via: "channel-dev",
    channel: "dev",
    snapshotDigest,
  }),
}))

mock.module("../src/main/ext-mcp-activation", () => ({
  reloadInstalledMcp: async (name: string) => ({ reference: name, status: "connected" }),
}))

const originalFetch = globalThis.fetch
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  expect(init?.redirect).toBe("error")
  const url = String(input)
  if (url.endsWith("agent-payload.json")) return new Response(agentPayloadBytes, { status: 200 })
  if (url.endsWith("mcp-payload.json")) return new Response(mcpPayloadBytes, { status: 200 })
  if (url.endsWith("agent.md")) return new Response(agentAssetBytes, { status: 200 })
  throw new Error(`unexpected fetch: ${url}`)
}) as typeof fetch

const { initAlphaEnvironment, getAlphaEnvironment } = await import("../src/main/alpha-environment")
const { registerExtIpcHandlers } = await import("../src/main/ext-ipc")

delete process.env.ALPHA_GLOBAL_DIR
initAlphaEnvironment({
  isPackaged: false,
  channel: "dev",
  appDataDir: tmp,
  baseRoot: join(tmp, "alpha-code-state"),
  homeDir: join(tmp, "home"),
})
// 注册即触发启动期事务恢复 —— recoveryOpts 在这里构造。
const routerBuildsBeforeRegister = routerCalls.built
registerExtIpcHandlers(
  userData,
  "dev",
  async () => ({ url: "http://127.0.0.1:39118", username: "opencode", password: "route-password" }),
  join(tmp, "home"),
)
const routerBuildsAtRegister = routerCalls.built - routerBuildsBeforeRegister

afterAll(() => {
  globalThis.fetch = originalFetch
  rmSync(tmp, { recursive: true, force: true })
})

async function install(catalogId: string, attemptId: string, secrets?: Record<string, string>) {
  const handler = handlers.get("ext-install-catalog")
  if (!handler) throw new Error("ext-install-catalog handler was not registered")
  const intent = { catalogId, scope: { scope: "global" as const }, attemptId }
  const first = await handler({ sender: { id: 1 } }, intent)
  const preview = first as {
    ok: false
    stage: string
    authorization: Array<{ key: string; requested: string[] }>
    packageAuthorization: PackageAdmissionPreviewV1
  }
  if (preview.stage !== "authorize") throw new Error(`expected preview, got ${JSON.stringify(first)}`)
  return handler(
    { sender: { id: 1 } },
    {
      ...intent,
      ...(secrets ? { grants: { secrets } } : {}),
      authorization: {
        confirmed: Object.fromEntries(preview.authorization.map((item) => [item.key, item.requested])),
        binding: preview.packageAuthorization.binding,
      },
    },
  )
}

test("the production recovery wiring builds its probe from extensionHealthProbeRouter", () => {
  expect(routerBuildsAtRegister).toBeGreaterThan(0)
})

test("the real ext-install-catalog IPC installs an agent package through buildAgentTxItems and the router probe", async () => {
  const before = { ...builderCalls }
  routerCalls.invoked.length = 0
  const result = await install("package:wired-agent", "wiring-agent-1")
  expect(result).toMatchObject({ ok: true, kind: "agent", name: "wired-agent" })
  // ① builder 真的被生产路径调用(而且只调 agent 那一支)。
  expect(builderCalls.agent - before.agent).toBe(1)
  expect(builderCalls.skill - before.skill).toBe(0)
  expect(builderCalls.mcp - before.mcp).toBe(0)
  // ② 引擎真的调到了 router 造的探针 —— file item,两个相位都有。
  const agentProbes = routerCalls.invoked.filter((c) => c.key === "agent--wired-agent" && c.action === "file")
  expect(agentProbes.map((c) => c.phase).sort()).toEqual(["post-switch", "pre-switch"])
  // ③ 真的装出来了(计划不是空转):md 落盘 + config 叶在场 + 账本有记录。
  const root = getAlphaEnvironment().mutableRoot
  expect(readFileSync(join(root, "agents", "wired-agent.md"), "utf8")).toBe(AGENT_MD)
  const config = readFileSync(join(root, "alpha.jsonc"), "utf8")
  expect(config).toContain("wired-agent")
  expect(existsSync(join(root, "installs.json"))).toBe(true)
})

test("the real ext-install-catalog IPC installs a secret-bearing MCP package through buildMcpTxItems", async () => {
  const before = { ...builderCalls }
  const result = await install("package:wired-mcp", "wiring-mcp-1", { "mcp:wired-mcp#A_KEY": secretCanary })
  expect(result).toMatchObject({ ok: true, kind: "mcp", name: "wired-mcp" })
  expect(builderCalls.mcp - before.mcp).toBe(1)
  expect(builderCalls.agent - before.agent).toBe(0)
  const root = getAlphaEnvironment().mutableRoot
  const serverDir = join(userData, "alpha-mcp-secrets", "wired-mcp")
  const versions = readdirSync(serverDir)
  expect(versions).toHaveLength(1)
  const secretFile = join(serverDir, versions[0]!, "A_KEY")
  expect(readFileSync(secretFile, "utf8")).toBe(secretCanary)
  const config = readFileSync(join(root, "alpha.jsonc"), "utf8")
  expect(config).toContain(`{file:${secretFile}}`)
  expect(config).not.toContain(secretCanary)
})
