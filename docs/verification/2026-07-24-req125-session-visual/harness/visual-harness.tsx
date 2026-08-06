// REQ-125 #547 close-out harness. It mounts current production Solid components in a
// loopback-only Vite page and is captured exclusively with Chrome --headless=new.
// No Electron, Alpha Code process, account, API key, or owner desktop state is involved.
/* @jsxImportSource solid-js */
import { createSignal, onMount } from "solid-js"
import { render } from "solid-js/web"
import { MarkedProvider } from "../../../../packages/ui/src/context/marked"
import { setLocale } from "../../../../packages/ui-mac/src/renderer/i18n"
import { PermissionWatcher } from "../../../../packages/ui-mac/src/renderer/alpha-ui/permission-watcher"
import { SessionTimelineView } from "../../../../packages/ui-mac/src/renderer/alpha-ui/session-timeline/session-timeline-view"
import type { TimelineRow } from "../../../../packages/ui-mac/src/renderer/alpha-ui/session-timeline/timeline-model"
import type { TimelineIntents } from "../../../../packages/ui-mac/src/renderer/alpha-ui/session-timeline/cards/timeline-intents"
import { SessionComposerDock } from "../../../../packages/ui-mac/src/renderer/alpha-ui/session-workspace/session-composer-dock"
import {
  SessionWorkspaceShell,
  type AlphaSessionLiveContext,
  type SessionRailApi,
} from "../../../../packages/ui-mac/src/renderer/alpha-ui/session-workspace/session-workspace-shell"
import type { AlphaSessionIdentity } from "../../../../packages/ui-mac/src/renderer/alpha-ui/session-workspace/session-workspace-core"
import { SessionRailReviewPanelView } from "../../../../packages/ui-mac/src/renderer/alpha-ui/session-rail/review/review-panel-view"
import { defaultReviewChanges } from "../../../../packages/ui-mac/src/renderer/alpha-ui/session-rail/review/review-test-runtime"
import { createFilesPanelState } from "../../../../packages/ui-mac/src/renderer/alpha-ui/session-rail/files/files-state"
import { SessionRailFilesView } from "../../../../packages/ui-mac/src/renderer/alpha-ui/session-rail/files/files-view"
import { TerminalRailPanel } from "../../../../packages/ui-mac/src/renderer/alpha-ui/session-rail/terminal/terminal-rail-panel"
import type { AlphaTerminalEngineChannel } from "../../../../packages/ui-mac/src/renderer/alpha-ui/session-rail/terminal/terminal-rail-core"
import { SessionRailArtifactsView } from "../../../../packages/ui-mac/src/renderer/alpha-ui/session-rail/artifacts/artifacts-panel-view"
import type { PreviewContext } from "../../../../packages/ui-mac/src/renderer/alpha-ui/artifact-workbench/renderers/renderer-views"
import type { ArtifactCard } from "../../../../packages/ui-mac/src/renderer/alpha-ui/artifact-workbench/workbench-core"
import "../../../../packages/ui-mac/src/renderer/alpha-ui/session-workspace/session-workspace.css"
import "../../../../packages/ui-mac/src/renderer/alpha-ui/session-rail/files/session-rail-files.css"

setLocale("zh")

const params = new URLSearchParams(location.search)
const state = (params.get("state") ?? "A1").toUpperCase()
const theme = params.get("theme") === "dark" ? "dark" : "light"
document.documentElement.dataset.colorScheme = theme
document.documentElement.style.colorScheme = theme
document.body.style.margin = "0"
document.body.style.width = "1440px"
document.body.style.height = "900px"
document.body.style.overflow = "hidden"
document.body.style.background = "var(--a-bg-canvas)"

const identity: AlphaSessionIdentity = {
  serverKey: "sidecar",
  directory: "/tmp/req125-visual",
  sessionID: "ses_visual",
}
const running = state === "B2" || state === "C3" || state === "J2" || state === "J6"
const snapshot = {
  identity,
  project: "alpha-code",
  title: "REQ-125 视觉验收",
  activity: running ? "running" : "idle",
} as const
const live: AlphaSessionLiveContext = {
  current: () => snapshot,
  accepts: (candidate) =>
    candidate.serverKey === identity.serverKey &&
    candidate.directory === identity.directory &&
    candidate.sessionID === identity.sessionID,
}
const projects = { sdk: () => inertClient } as never

function neverSettle() {
  return new Promise<never>(() => {})
}
const inertClient = new Proxy(() => undefined, {
  get(_target, property) {
    if (typeof property === "symbol" || property === "then") return undefined
    return inertClient
  },
  apply() {
    return neverSettle()
  },
})

Object.defineProperty(window, "api", {
  configurable: true,
  writable: true,
  value: {
    models: { catalog: neverSettle },
    providers: { keyStatus: neverSettle },
    auth: { getState: neverSettle, subscribe: () => () => {} },
    contracts: { health: () => Promise.resolve(null), subscribe: () => () => {} },
    runArtifacts: {
      read: () => Promise.resolve({ ok: false, reason: "visual fixture" }),
      quickLook: () => Promise.resolve({ ok: false, code: "PREVIEW_UNAVAILABLE" }),
      openExternal: () => Promise.resolve({ ok: true }),
    },
    openPath: () => Promise.resolve(),
    openLink: () => Promise.resolve(),
    writeClipboard: () => Promise.resolve(),
  },
})

const now = Date.now()
const timelineRows: TimelineRow[] = [
  {
    kind: "user",
    key: "u1",
    rev: "1",
    message: {
      id: "u1",
      role: "user",
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5" },
      time: { created: now - 30_000 },
    },
    text: "核对 README.md,更新会话视觉矩阵并保留最小变更。",
    truncated: false,
    segments: [{ text: "核对 " }, { text: "README.md", kind: "file" }, { text: ",更新会话视觉矩阵并保留最小变更。" }],
    attachments: [],
    comments: [],
  } as never,
  ...(running ? ([{ kind: "thinking", key: "think", rev: "1", userMessageID: "u1" }] as never[]) : []),
  {
    kind: "markdown",
    key: "m1",
    rev: "1",
    streaming: running,
    part: {
      id: "m1",
      type: "text",
      text: "已核对现役实现。\n\n- 保留受保护设计稿\n- 补齐明暗证据\n- 偏差全部路由到父票 #538",
    },
  } as never,
  {
    kind: "tool",
    key: "t1",
    rev: "1",
    tool: "bash",
    part: {
      id: "t1",
      type: "tool",
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "bun run alpha-check" },
        output: "7/7 passed",
        metadata: { exit: 0 },
      },
    },
  } as never,
  {
    kind: "artifacts",
    key: "arts",
    rev: "1",
    partID: "arts",
    links: [
      { runId: "job_visual", name: "季度经营分析.docx" },
      { runId: "job_visual", name: "数据底表.parquet" },
    ],
  } as never,
]

const e8Rows: TimelineRow[] = [
  {
    kind: "user",
    key: "e8",
    rev: "1",
    message: {
      id: "e8",
      role: "user",
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5" },
      time: { created: now },
    },
    text: "GitHub 对照 README.md 核对仓库结构。",
    truncated: false,
    segments: [
      { text: "GitHub", kind: "resource", label: "GitHub" },
      { text: " 对照 " },
      { text: "README.md", kind: "file" },
      { text: " 核对仓库结构。" },
    ],
    attachments: [],
    comments: [],
  } as never,
]

function Timeline(props: { rail?: SessionRailApi; rows?: TimelineRow[] }) {
  const intents: TimelineIntents = {
    focusArtifact: props.rail ? (intent) => props.rail!.focusArtifact(intent.name) : undefined,
    openFile: props.rail ? (intent) => props.rail!.jumpToReview(intent.path) : undefined,
  }
  return (
    <MarkedProvider>
      <SessionTimelineView
        rows={props.rows ?? timelineRows}
        ready
        epoch="req125-visual"
        emptyTitle="REQ-125 视觉验收"
        history={{ more: false, loading: false }}
        onLoadOlder={() => Promise.resolve()}
        intents={intents}
      />
    </MarkedProvider>
  )
}

function ReviewPanel() {
  return (
    <SessionRailReviewPanelView
      phase="changes"
      changes={defaultReviewChanges()}
      resetKey="req125-visual"
      onLineComment={() => {}}
    />
  )
}

function FilesPanel() {
  const [tabs, setTabs] = createSignal(["file://README.md", "file://alpha-ui/button.css"])
  const [active, setActive] = createSignal("file://alpha-ui/button.css")
  const changes = new Map([
    ["alpha-ui/button.css", "modified"],
    ["docs/verification.md", "added"],
  ] as const)
  const state = createFilesPanelState({
    root: "/tmp/req125-visual",
    stillCurrent: () => true,
    listDir: (path) => {
      if (!path)
        return Promise.resolve([
          { name: "alpha-ui", path: "alpha-ui/", type: "directory", ignored: false },
          { name: "docs", path: "docs/", type: "directory", ignored: false },
          { name: "README.md", path: "README.md", type: "file", ignored: false },
          { name: "package.json", path: "package.json", type: "file", ignored: false },
        ])
      if (path === "alpha-ui")
        return Promise.resolve([{ name: "button.css", path: "alpha-ui/button.css", type: "file", ignored: false }])
      return Promise.resolve([{ name: "verification.md", path: "docs/verification.md", type: "file", ignored: false }])
    },
    findFiles: () => Promise.resolve([]),
    changeKinds: () => changes,
    openedTabs: {
      all: tabs,
      active,
      open: (tab) => {
        setTabs((current) => (current.includes(tab) ? current : [...current, tab]))
        setActive(tab)
      },
      close: (tab) => setTabs((current) => current.filter((item) => item !== tab)),
      setActive,
    },
    jumpToReview: () => {},
    searchDebounceMs: 0,
  })
  return <SessionRailFilesView state={state} />
}

const terminalChannel: AlphaTerminalEngineChannel = {
  identity,
  ready: () => true,
  instances: () => [
    { id: "pty_1", title: "验证", running: true },
    { id: "pty_2", title: "日志", running: false },
  ],
  activeID: () => "pty_1",
  open: () => {},
  close: () => {},
  create: () => {},
  requestFocus: () => {},
  cancelFocus: () => {},
  footStatus: () => ({ running: true, shell: "zsh", cols: 120, rows: 32 }),
  EngineOutput: () => (
    <pre style={{ margin: "0", padding: "18px", color: "#d4d4d8", "font-size": "12px", "line-height": "1.65" }}>
      $ bun run alpha-check{"\n"}✓ docs governance{"\n"}✓ supply-chain gates{"\n"}✓ ui-mac component gates{"\n"}7/7
      passed
    </pre>
  ),
}

function artifactCard(name: string, mime: string): ArtifactCard {
  return {
    key: name,
    name,
    state: "verified",
    bytes: name.endsWith(".docx") ? 1_258_291 : 48_128,
    savedPath: `artifacts/${name}`,
    warnings: [],
    downloadable: false,
    descriptor: {
      schemaVersion: 1,
      id: name,
      source: "cloud",
      name,
      size: 100,
      claimedMime: mime,
      detectedMime: mime,
      trust: "sandboxed",
      role: "primary",
      contentRef: { kind: "http-stream", url: `/visual/${name}`, auth: "bearer" },
      verification: { status: "verified" },
      provenance: { producer: "pipeline", jobId: "job_visual" },
    },
  } as never
}

const officeCard = artifactCard(
  "季度经营分析.docx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
)
const parquetCard = artifactCard("数据底表.parquet", "application/octet-stream")

function previewFor(card: ArtifactCard): PreviewContext {
  const office = card.name.endsWith(".docx")
  return {
    directory: identity.directory,
    runId: "job_visual",
    readRef: { artifactId: card.descriptor!.id },
    name: card.name,
    decision: {
      rendererId: "fallback",
      effectiveMime: card.descriptor!.detectedMime ?? null,
      source: "detected",
      reason: "deterministic visual fixture",
      warnings: [],
      externalOpen: office ? "allowed" : "blocked",
      ...(office ? { ooxmlSubtype: "docx" as const } : {}),
    },
    card,
    officeStructure: office ? { status: "pass", quickLook: true, subtype: "docx" } : null,
  }
}

function ArtifactsPanel(props: { rail: SessionRailApi }) {
  const requested = () => props.rail.artifactTarget()?.artifactId
  const selected = () => (requested()?.endsWith(".parquet") || state === "I3" ? parquetCard : officeCard)
  return (
    <SessionRailArtifactsView
      phase="cards"
      runs={[
        {
          runId: "job_visual",
          moment: { kind: "today", time: "15:02" },
          ordinal: "latest",
          artifactCount: 2,
          diskBytes: 1_306_419,
          missingCount: 0,
          readOnly: false,
        },
      ]}
      selectedRunId="job_visual"
      onSelectRun={() => {}}
      onRefresh={() => {}}
      newRunHint={false}
      onViewNewRun={() => {}}
      cloudUnavailable={false}
      cards={[officeCard, parquetCard]}
      selectedKey={selected().key}
      onSelect={() => {}}
      onRetry={() => {}}
      verifying={false}
      previewCtx={previewFor(selected())}
      focusSeq={requested() ? 1 : 0}
      onEscape={() => {}}
      downloadPhases={{}}
      onDownload={() => {}}
      onCancelDownload={() => {}}
    />
  )
}

function PermissionSurface() {
  const request = {
    id: "per_req125_visual",
    sessionID: identity.sessionID,
    fingerprint: "a".repeat(64),
    subject: { kind: "agent", id: "build-reviewer" },
    action: "bash",
    resources: ["pwd", "docs/**"],
    scope: { kind: "session", sessionID: identity.sessionID },
    expiresAt: 1_893_456_000_000,
    save: ["docs/**"],
  }
  return (
    <PermissionWatcher
      sessionID={identity.sessionID}
      projectID="prj_alpha"
      client={{
        list: () => Promise.resolve([request] as never),
        reply: () => neverSettle(),
        subscribe: () => () => {},
      }}
    />
  )
}

function DockOnly() {
  return (
    <div class="a-ui" style={{ width: "900px", margin: "160px auto 0" }}>
      <SessionComposerDock live={live} projects={projects} />
    </div>
  )
}

function FullWorkspace() {
  const panels = {
    review: () => <ReviewPanel />,
    files: () => <FilesPanel />,
    terminal: () => <TerminalRailPanel channel={terminalChannel} accepts={live.accepts} />,
    artifacts: (rail: SessionRailApi) => <ArtifactsPanel rail={rail} />,
  }
  onMount(() => {
    queueMicrotask(() => {
      const tab =
        state === "A2" || state === "D5"
          ? "files"
          : state === "A3" || state === "D6"
            ? "terminal"
            : state === "A4" || state === "D8"
              ? "artifacts"
              : undefined
      if (tab) document.querySelector<HTMLButtonElement>(`[data-alpha-session-rail-tab='${tab}']`)?.click()
      if (state === "D1" || state === "D2") {
        document.querySelector<HTMLButtonElement>("[data-review-file='alpha-ui/button.css'] .a-rvw-fhead")?.click()
        if (state === "D2") document.querySelectorAll<HTMLButtonElement>(".a-rvw-seg button")[1]?.click()
      }
      if (state === "I2" || state === "I3") {
        const name = state === "I3" ? "数据底表.parquet" : "季度经营分析.docx"
        Array.from(document.querySelectorAll<HTMLButtonElement>(".a-artrow"))
          .find((row) => row.textContent?.includes(name))
          ?.click()
      }
      document.documentElement.dataset.visualReady = "true"
    })
  })
  return (
    <SessionWorkspaceShell
      live={live}
      timeline={(rail) => <Timeline rail={rail} rows={state === "E8" ? e8Rows : undefined} />}
      composer={() => <SessionComposerDock live={live} projects={projects} />}
      panels={panels}
      railMeta={{ reviewCount: () => 3, terminalRunning: () => true }}
      terminalChannel={() => terminalChannel}
    />
  )
}

const host = document.createElement("div")
host.style.width = "1440px"
host.style.height = "900px"
document.body.append(host)

render(
  () =>
    state === "C2" || state === "J1" ? (
      <div class="a-ui" style={{ width: "100%", height: "100%" }}>
        <PermissionSurface />
      </div>
    ) : ["J2", "J3", "J5", "J6"].includes(state) ? (
      <DockOnly />
    ) : (
      <FullWorkspace />
    ),
  host,
)

setTimeout(() => {
  document.documentElement.dataset.visualReady = "true"
}, 100)
