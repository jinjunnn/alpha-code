// #583/#584/#586 — list 目录网格 / grep 命中高亮 / websearch 富链接的视觉 harness
// (真组件挂载,零生产代码改动;与已批 2026-08-12-587 harness 同一模式)。
//
// 挂载现役生产组件 SessionTimelineView 与现役生产 CSS(组件自身 import 原样加载),
// fixture 是带 #878 ToolDisplaySnapshotV1 快照的时间线行。只在 loopback Vite 构建 +
// Chrome --headless=new 下截图;不启动 Electron、不用任何账号/API key。
// 用法:?state=<key>&theme=light|dark&width=narrow|wide
/* @jsxImportSource solid-js */
import { render } from "solid-js/web"
import { MarkedProvider } from "../../../../packages/ui/src/context/marked"
import { SessionTimelineView } from "../../../../packages/ui-mac/src/renderer/alpha-ui/session-timeline/session-timeline-view"
import type { TimelineRow } from "../../../../packages/ui-mac/src/renderer/alpha-ui/session-timeline/timeline-model"
import { setLocale } from "../../../../packages/ui-mac/src/renderer/i18n"

setLocale("zh")

const params = new URLSearchParams(location.search)
const state = params.get("state") ?? "list"
const theme = params.get("theme") === "dark" ? "dark" : "light"
const width = params.get("width") === "narrow" ? 420 : 900

document.documentElement.dataset.colorScheme = theme
document.documentElement.style.colorScheme = theme
document.body.style.margin = "0"

// ── fixture 辅助:带 builtin 快照的工具行 ───────────────────────────────────
type Snapshot = {
  identity: { source: string; origin: string; name: string }
  technicalId: string
  authority: { kind: string }
}

const builtinSnap = (name: string): Snapshot => ({
  identity: { source: "builtin", origin: "", name },
  technicalId: name,
  authority: { kind: "not-asserted" },
})

const tool = (key: string, toolName: string, stateValue: Record<string, unknown>): TimelineRow =>
  ({
    kind: "tool",
    key,
    rev: "1",
    tool: toolName,
    part: {
      id: key,
      type: "tool",
      tool: toolName,
      display: builtinSnap(toolName),
      state: stateValue,
    } as never,
  }) as never

const completed = (input: Record<string, unknown>, output = "", metadata: Record<string, unknown> = {}) => ({
  status: "completed",
  input,
  output,
  title: "远端标题",
  metadata,
  time: { start: 0, end: 1 },
})

// ── 各 state 的行集 ─────────────────────────────────────────────────────────
const STATES: Record<string, TimelineRow[]> = {
  // #583 G6:目录网格 + 目录/文件分类图标 + 「共 N 项」(头部徽标与 footer)。
  list: [
    tool(
      "l1",
      "list",
      completed(
        { path: "/Users/kai/app/kama-bot-local" },
        [".claude/", "app/", "docs/", "tests/", "docker-compose.yml", "pyproject.toml", "README.md", "(7 entries)"].join(
          "\n",
        ),
      ),
    ),
  ],
  // #584 G7:文件名/行号分色 + 命中高亮(引擎 grep.ts 行文法)。
  grep: [
    tool(
      "g1",
      "grep",
      completed(
        { pattern: "image", include: "docker-compose*" },
        [
          "Found 2 matches",
          "",
          "/Users/kai/app/kama-bot-local/docker-compose.yml:",
          "  Line 6: redis image: redis:7.4-alpine",
          "  Line 21: postgres image: postgres:16-alpine",
        ].join("\n"),
        { matches: 2 },
      ),
    ),
  ],
  // #584 基线补的「已隐藏」态:路径 redactor 失败 ⇒ 整字段隐藏 + 确定标记。
  "grep-hidden": [
    tool(
      "g2",
      "grep",
      completed(
        { pattern: "secret" },
        `Found 1 matches\n\n/w/${"s".repeat(1_200)}/vault.ts:\n  Line 8: secret = 1`,
        { matches: 1 },
      ),
    ),
  ],
  // #586 G17:字母徽 + 宿主允许的标题 + 域名,头部「N 条结果」(无供应商名)。
  websearch: [
    tool(
      "w1",
      "websearch",
      completed(
        { query: "solid-js loading a11y" },
        JSON.stringify({
          results: [
            { title: "aria-busy & loading buttons", url: "https://www.w3.org/WAI/tutorials/" },
            { title: "SolidJS Suspense & pending UI", url: "https://docs.solidjs.com/guides/suspense" },
            { title: "Accessible loading states", url: "https://web.dev/articles/aria-live" },
          ],
        }),
        { provider: "exa" },
      ),
    ),
  ],
  // 三卡合帧(list 与 grep 之间隔 websearch,避开「已探索」折叠成组)。
  all: [],
}
STATES.all = [...STATES.list!, ...STATES.websearch!, ...STATES.grep!]

const rows = STATES[state]
if (!rows) throw new Error(`unknown state: ${state} (known: ${Object.keys(STATES).join(", ")})`)

document.body.style.background = "var(--a-bg-canvas)"
const host = document.createElement("div")
host.className = "a-ui"
host.style.cssText = `width:${width}px;min-height:640px;margin:0 auto;display:flex;flex-direction:column;padding:16px 0`
document.body.appendChild(host)

render(
  () => (
    <MarkedProvider>
      <SessionTimelineView
        rows={rows}
        ready={true}
        epoch="harness"
        emptyTitle="tool-cards harness"
        history={{ more: false, loading: false }}
        onLoadOlder={() => Promise.resolve()}
        intents={{}}
        displayNames={{ agent: (agent) => agent, model: (_p, modelID) => modelID }}
      />
    </MarkedProvider>
  ),
  host,
)

setTimeout(() => {
  // 展开全部有体卡片(list/grep/websearch 的体默认折叠;grep-hidden 无展开体)。
  document.querySelectorAll<HTMLButtonElement>("button.a-tc-head").forEach((head) => head.click())
  setTimeout(() => {
    document.documentElement.dataset.visualReady = "true"
  }, 80)
}, 150)
