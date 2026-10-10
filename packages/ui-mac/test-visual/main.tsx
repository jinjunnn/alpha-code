// REQ-229 / REQ-230 视觉 harness 入口。场景经 `?scene=` 选择,`?theme=dark` 切深色。
// 挂的全是生产组件(SessionTimelineView / ProcessRow / PermissionDialog / AlphaComposerRuntime);
// 只有数据(消息、part、模型目录)与 IPC(window.api、SDK)是桩。
import type { ModelV2Info, PermissionV2Request } from "@opencode-ai/sdk/v2/client"
import { render } from "solid-js/web"
import { createSignal, type JSX } from "solid-js"
import { researchTurn } from "../test-component/process-fold.fixture"
import { installPreloadStub } from "../test-component/preload-stub"
import catalogJson from "../src/main/alpha-models.json"
import type { EffectiveCatalog, ProviderKeyStatus } from "../src/shared/alpha-model-types"
import type { AccountSummary } from "../src/preload/types"
import { projectTimelineRows, type TimelineRow, type TimelineTurnWait } from "../src/renderer/alpha-ui/session-timeline/timeline-model"
import { SessionTimelineView } from "../src/renderer/alpha-ui/session-timeline/session-timeline-view"
import { PermissionDialog } from "../src/renderer/alpha-ui/PermissionDialog"
import { AlphaComposerRuntime } from "../src/renderer/alpha-ui/alpha-composer"
import { pushToast, ToastViewport } from "../src/renderer/alpha-ui/Toast"
import type { ModelContract } from "../src/renderer/alpha-ui/model-contract"
// 与生产 index.tsx 同口径:home.css(.a-pop / .a-ic / .a-chip 通用原语)与 composer-reskin 全局在场。
import "../src/renderer/alpha-ui/base.css"
import "../src/renderer/alpha-ui/home.css"
import "../src/renderer/alpha-ui/composer-reskin.css"
import "../src/renderer/alpha-ui/session-workspace/session-workspace.css"
import "./harness.css"

const params = new URLSearchParams(location.search)
const scene = params.get("scene") ?? "fold-collapsed"
if (params.get("theme") === "dark") document.documentElement.dataset.colorScheme = "dark"

// ── 数据桩 ─────────────────────────────────────────────────────────────────────
const catalog = { ...(catalogJson as object), liveSync: { status: "static" }, pricingBasisModelId: null } as EffectiveCatalog
const info = (providerID: string, id: string, name = id): ModelV2Info => ({
  id,
  providerID,
  name,
  api: { id: providerID, type: "aisdk", package: "@ai-sdk/openai-compatible" },
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  request: { headers: {}, body: {} },
  variants: [],
  time: { released: 0 },
  cost: [],
  status: "active",
  enabled: true,
  limit: { context: 128_000, output: 8_192 },
}) as ModelV2Info
const platformModels = catalog.platformModels.map((m) => info(catalog.platformProvider.id, m.id, m.name))
const keys = Object.fromEntries(
  catalog.byokProviders.map((p) => [p.id, { configured: p.id === "deepseek", source: p.id === "deepseek" ? "keychain" : "none" }]),
) as ProviderKeyStatus
const summary: AccountSummary = {
  balanceFen: 0,
  walletUsedFen: 0,
  plan: {
    id: "pro",
    name: "Pro",
    status: "active",
    window5h: { usedCredits: 0, limitCredits: 100, resetsInMin: 0 },
    window7d: { usedCredits: 0, limitCredits: 100, resetsInMin: 0 },
    renewsAt: "",
    daysLeft: 10,
  },
  usage: { todayTokens: 0, weekTokens: 0, tasksThisMonth: 0 },
  usageSeries: [],
} as AccountSummary
installPreloadStub({ catalog, account: summary, providerKeys: keys, auth: { status: "logged-in", mode: "platform" } as never })

const modelContract: ModelContract = {
  list: async () => platformModels,
  current: async () => ({ providerID: catalog.platformProvider.id, id: catalog.platformModels[0]!.id }),
  switch: async () => {},
}
const projects = {
  store: { projects: [], ready: true, error: false },
  reload: async () => {},
  createSession: async () => undefined,
  startChat: async () => undefined,
  sdk: () => undefined,
  renameSession: async () => false,
  shareSession: async () => undefined,
  deleteSession: async () => false,
  copySession: async () => undefined,
}
const command = { options: [], trigger: () => {} }

// ── 进行中回合(与 session-timeline.cases.ts 的 liveTurn 同形) ──────────────────────
function tool(id: string, name: string, state: Record<string, unknown>, display?: Record<string, unknown>) {
  return {
    id,
    sessionID: "ses_1",
    messageID: "msg_a1",
    type: "tool",
    callID: `call_${id}`,
    tool: name,
    display: display ?? { identity: { source: "builtin", origin: "", name }, technicalId: name, authority: { kind: "not-asserted" } },
    state,
  }
}
const reasoning = (id: string, text: string, time: Record<string, number>) => ({
  id,
  sessionID: "ses_1",
  messageID: "msg_a1",
  type: "reasoning",
  text,
  time,
})
const now = Date.now()
const running = (start: number, query: string) => ({ status: "running", input: { query }, title: query, time: { start } })
const done = (query: string, ms = 4_000) => ({
  status: "completed",
  input: { query },
  output: "",
  title: query,
  metadata: {},
  time: { start: 0, end: ms },
})
function liveTurn(parts: unknown[], status = "busy"): TimelineRow[] {
  const startedAt = now - 207_000
  return projectTimelineRows({
    messages: [
      { id: "msg_u1", sessionID: "ses_1", role: "user", time: { created: startedAt }, agent: "build", model: { providerID: "deepseek", modelID: "deepseek-reasoner" } },
      {
        id: "msg_a1",
        sessionID: "ses_1",
        role: "assistant",
        time: { created: startedAt + 1_000 },
        parentID: "msg_u1",
        modelID: "deepseek-reasoner",
        providerID: "deepseek",
        mode: "build",
        agent: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    ] as never,
    partsOf: (id: string) =>
      (id === "msg_u1"
        ? [{ id: "prt_u1", sessionID: "ses_1", messageID: "msg_u1", type: "text", text: "是否支持多级的 criteria,还有请求体都支持哪些字段,我需要完整的。" }]
        : parts) as never,
    status,
  })
}
const liveParts = [
  reasoning("prt_r1", "**Planning the lookup**\n\nThe user wants nested criteria.", { start: 0, end: 2_000 }),
  tool("prt_s0", "websearch", done("docs.typesafe.ai System One API request fields")),
  tool("prt_s1", "websearch", done("typesafe jev nested criteria multi-level")),
  reasoning("prt_r2", "Need the how-to page.", { start: 0, end: 5_000 }),
  tool("prt_s2", "websearch", running(now - 130_000, '"how-to-build-with-system-one" typesafe question')),
  tool("prt_s3", "websearch", running(now - 128_000, "typesafe questions evaluated in parallel")),
  tool("prt_s4", "websearch", running(now - 6_000, "typesafe jev conditional criteria")),
  tool("prt_s5", "websearch", running(now - 4_000, "typesafe jev request schema top level keys")),
]
const waitingParts = [
  reasoning("prt_r1", "Let me check the repo.", { start: 0, end: 2_000 }),
  tool("prt_s0", "websearch", done("typesafe jev request schema")),
  tool("prt_b1", "bash", { status: "running", input: { command: "rm -rf dist && bun run build" }, title: "bash", time: { start: now - 14_000 } }),
]
// AC5:第三方 MCP / 插件 / 来源不明的步骤 + 我方失败步骤,用于 ② 每步一行的来源呈现。
const provenanceParts = [
  reasoning("prt_r1", "Look in Notion first.", { start: 0, end: 3_000 }),
  tool("prt_n1", "notion_search_pages", done("criteria", 2_000), {
    identity: { source: "mcp", origin: "notion", name: "search_pages" },
    technicalId: "notion_search_pages",
    authority: { kind: "not-asserted" },
  }),
  tool("prt_p1", "lint_fix", done("x", 1_000), {
    identity: { source: "plugin", origin: "acme-lint", name: "lint_fix" },
    technicalId: "lint_fix",
    authority: { kind: "not-asserted" },
  }),
  tool("prt_rd", "read", { status: "completed", input: { filePath: "/tmp/src/schema.ts" }, output: "export type Criteria = {}", title: "src/schema.ts", metadata: {}, time: { start: 0, end: 300 } }),
  tool("prt_f1", "webfetch", { status: "error", input: { url: "https://docs.typesafe.ai/api" }, error: "Transport error", time: { start: 0, end: 900 } }),
  { id: "prt_t1", sessionID: "ses_1", messageID: "msg_a1", type: "text", text: "Notion 里没有相关记录;请求体只有三层结构,字段是封闭的一小组。" },
]

// ── 场景 ───────────────────────────────────────────────────────────────────────
const research = researchTurn()
const researchRows = projectTimelineRows({ messages: research.messages, partsOf: (id) => research.parts[id] ?? [], status: "idle" })

function rowsFor(name: string): { rows: TimelineRow[]; wait?: TimelineTurnWait } {
  if (name.startsWith("fold-")) return { rows: researchRows }
  if (name === "live-running") return { rows: liveTurn(liveParts) }
  if (name === "live-waiting" || name === "approval") return { rows: liveTurn(waitingParts), wait: "approval" }
  if (name === "provenance") return { rows: liveTurn(provenanceParts, "idle") }
  return { rows: researchRows }
}

const approvalRequest: PermissionV2Request = {
  id: "per_visual_1",
  sessionID: "ses_1",
  fingerprint: "a".repeat(64),
  subject: { kind: "agent", id: "build" },
  action: "bash",
  resources: ["rm -rf dist && bun run build"],
  scope: { kind: "session", sessionID: "ses_1" },
  expiresAt: now + 5 * 60_000,
  save: ["rm *"],
} as PermissionV2Request

function Workspace(): JSX.Element {
  const { rows, wait } = rowsFor(scene)
  const [sessionID] = createSignal("ses_1")
  const [directory] = createSignal("/Users/me/projects/typesafe-demo")
  const withComposer = scene === "approval" || scene === "toast-tooltip" || scene.startsWith("menu-") || scene.startsWith("live-")
  return (
    <div class="vh-shell" data-scene={scene}>
      <div class="vh-timeline">
        <SessionTimelineView
          rows={rows}
          ready={true}
          epoch="sidecar /tmp ses_visual"
          emptyTitle="整理架构说明"
          history={{ more: false, loading: false }}
          onLoadOlder={() => Promise.resolve()}
          turnWait={wait}
          intents={{}}
          displayNames={{
            agent: (a) => a.slice(0, 1).toUpperCase() + a.slice(1),
            model: (_p, m) => (m === "deepseek-reasoner" ? "DeepSeek Reasoner" : m === "deepseek-flash" ? "DeepSeek Flash" : m),
          }}
        />
      </div>
      {withComposer && (
        <div class="vh-composer">
          <AlphaComposerRuntime
            mode="session"
            projects={projects as never}
            directory={directory}
            sessionID={sessionID}
            command={command as never}
            modelContract={modelContract}
          />
        </div>
      )}
      {scene === "toast-tooltip" && <ToastViewport />}
      {scene === "approval" && (
        <PermissionDialog
          request={approvalRequest}
          projectID="prj_visual"
          onSubmit={() => new Promise(() => {})}
        />
      )}
    </div>
  )
}

render(() => <Workspace />, document.getElementById("root")!)
if (scene === "toast-tooltip") {
  pushToast({ kind: "success", title: "已切换到 deepseek-flash", detail: "下一条消息生效", duration: 600_000 })
  pushToast({ kind: "error", title: "发送失败", detail: "网络断开,内容还在输入框里" })
}
;(window as unknown as { __harnessReady: boolean }).__harnessReady = true
