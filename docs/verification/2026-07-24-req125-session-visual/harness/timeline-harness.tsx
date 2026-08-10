// REQ-125 #547 V1 批2 — 时间线组件 harness(真组件挂载,零生产代码改动)。
//
// 用法:dev app 的 Vite dev server 运行时,从同源页面动态 import 本模块
//   await import("/@fs/Users/tide/app/alpha-code/docs/verification/2026-07-24-req125-session-visual/harness/timeline-harness.tsx")
// 之后用 window.__harness.show("<state>") / window.__harness.theme("light"|"dark") 切态。
//
// 证据等级:组件级(-harness)。挂载的是现役生产组件 SessionTimelineView + 现役生产 CSS
// (session-timeline.css / cards.css / tokens.css 经组件自身 import 原样加载),
// fixture 数据对齐 conversation-timeline/design.html 帧内演示值。
// 本文件只存在于 docs/verification(harness-plan 既定落点),不进任何生产 bundle。
/* @jsxImportSource solid-js */
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
// 生产装配同款 Markdown 引擎上下文(packages/app/src/app.tsx 的 MarkedProvider;
// 无 nativeParser 时走同一 JS marked+Shiki 管线)。bare specifier `@opencode-ai/ui`
// 从 docs/ 解析不到(非提升安装),按 exports 映射(./context/* → ./src/context/*.tsx)
// 直接相对引同一物理模块 —— 与 session-ui 内部 import 同一实例。
import { MarkedProvider } from "../../../../packages/ui/src/context/marked"
import { SessionTimelineView } from "../../../../packages/ui-mac/src/renderer/alpha-ui/session-timeline/session-timeline-view"
import type { TimelineRow } from "../../../../packages/ui-mac/src/renderer/alpha-ui/session-timeline/timeline-model"
import { setLocale } from "../../../../packages/ui-mac/src/renderer/i18n"

setLocale("zh")

// ── fixture 辅助 ────────────────────────────────────────────────────────────
const at = (h: number, m: number) => {
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d.getTime()
}

// 4×4 indigo PNG(媒体缩略用;真机通道同为 data:image url)
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFklEQVR4nGP8z8DwnwEJMDGgAdwCAF/uAhHyvE1JAAAAAElFTkSuQmCC"

const userMessage = (over: Record<string, unknown> = {}) =>
  ({
    id: "msg_user",
    role: "user",
    agent: "build",
    model: { providerID: "deepseek", modelID: "deepseek-reasoner" },
    time: { created: at(11, 19) },
    ...over,
  }) as any

const userRow = (key: string, over: Record<string, unknown>): TimelineRow =>
  ({
    kind: "user",
    key,
    rev: "1",
    message: userMessage(),
    text: "",
    copyText: () => String(over.text ?? ""),
    truncated: false,
    segments: [],
    attachments: [],
    comments: [],
    ...over,
  }) as any

const tool = (key: string, toolName: string, state: Record<string, unknown>): TimelineRow =>
  ({
    kind: "tool",
    key,
    rev: "1",
    tool: toolName,
    part: { id: key, type: "tool", tool: toolName, state } as any,
  }) as any

const md = (key: string, text: string, streaming = false): TimelineRow =>
  ({ kind: "markdown", key, rev: "1", streaming, part: { id: key, type: "text", text } as any }) as any

// ── 各 state 的行集(fixture 值对齐 CT design.html 帧内演示数据) ─────────────
const STATES: Record<string, TimelineRow[]> = {
  // E1 命令 chip · 内置(含展开体):点 chip 展开
  e1: [
    userRow("e1", {
      slash: { command: "init" },
      text: "Create or update `AGENTS.md` for this repository.(内置命令的展开模板,默认折叠 ~80 行)",
      segments: [
        { text: "Create or update `AGENTS.md` for this repository.(内置命令的展开模板,默认折叠 ~80 行)" },
      ],
    }),
  ],
  // E2 配置命令带 args
  e2: [userRow("e2", { slash: { command: "review", arguments: "pr 12" } })],
  // E3 技能 chip(实现无 skill 变体 → 通用命令 chip 形态,记 finding)
  e3: [userRow("e3", { slash: { command: "cloudflare" } })],
  // E4 MCP chip(实现无 mcp 变体,记 finding)
  e4: [userRow("e4", { slash: { command: "context7", arguments: "resolve-library-id" } })],
  // E5 用户文本气泡 + 脚注(hover 显操作)
  e5: [
    userRow("e5", {
      text: "对照 README.md 核对仓库结构,交给 @build 写一句话简介。",
      segments: [{ text: "对照 README.md 核对仓库结构,交给 @build 写一句话简介。" }],
    }),
  ],
  // E6 附件卡 · 文件 / E7 附件卡 · 图片
  e6: [
    userRow("e6", {
      text: "按这份 compose 配置核对服务清单。",
      segments: [{ text: "按这份 compose 配置核对服务清单。" }],
      attachments: [{ partID: "att1", name: "docker-compose.yml", media: "file", label: "YML" }],
    }),
  ],
  e7: [
    userRow("e7", {
      text: "对照这张截图看布局。",
      segments: [{ text: "对照这张截图看布局。" }],
      attachments: [{ partID: "att2", name: "界面截图.png", media: "image", label: "PNG" }],
    }),
  ],
  // E8 连接器 chip(资源提及;来源名 = MCP clientName)
  e8: [
    userRow("e8", {
      text: "GitHub 对照 README.md 核对仓库结构。",
      segments: [
        { text: "GitHub", kind: "resource", label: "GitHub" },
        { text: " 对照 " },
        { text: "README.md", kind: "file" },
        { text: " 核对仓库结构。" },
      ],
    }),
  ],
  // E9/E10 内联提及
  e9: [
    userRow("e9", {
      text: "对照 README.md 核对仓库结构。",
      segments: [{ text: "对照 " }, { text: "README.md", kind: "file" }, { text: " 核对仓库结构。" }],
    }),
  ],
  e10: [
    userRow("e10", {
      text: "交给 @build 写一句话简介。",
      segments: [{ text: "交给 " }, { text: "@build", kind: "agent" }, { text: " 写一句话简介。" }],
    }),
  ],
  // E11 内联代码评论卡
  e11: [
    userRow("e11", {
      text: "按这条评论改,其余保持不动。",
      segments: [{ text: "按这条评论改,其余保持不动。" }],
      comments: [
        { partID: "cm1", path: "alpha-ui/button.css", comment: "这里改成可见的焦点环,别再隐藏。", startLine: 42 },
      ],
    }),
  ],

  // F1 Thinking 流式态
  f1: [{ kind: "thinking", key: "f1", rev: "1", userMessageID: "msg_user" } as any],
  // F2 推理折叠卡(6 秒;点头部展开)
  f2: [
    {
      kind: "reasoning",
      key: "f2",
      rev: "1",
      streaming: false,
      part: {
        id: "f2",
        type: "reasoning",
        text: "**规划探查顺序**\n\n先列目录看结构,再读 README 与 compose 抓事实,最后浓缩成简介。",
        time: { start: at(11, 20), end: at(11, 20) + 6000 },
      } as any,
    } as any,
  ],
  // F3 Markdown 正文 + 表格(真引擎)
  f3: [
    md(
      "f3",
      [
        "**kama-bot-local** 是单用户 KAMA+EMA55 趋势跟踪交易机器人。三项次要发现:",
        "",
        "| 严重性 | 位置 | 问题 |",
        "| --- | --- | --- |",
        "| 中 | `prompt_builder.py:100` | render_iter 省略了 `kama_latest` 等字段 |",
        "| 低 | `constants.py:14` | 阈值 60→180s,掩盖陈旧 bug 风险 |",
      ].join("\n"),
    ),
  ],
  // F4 代码块(语言标签 + 复制头条归引擎)
  f4: [
    md(
      "f4",
      ["修复后的最小补丁:", "", "```python", "def render_admission(self):", '    return {"kama": self.kama_latest, ...}', "```"].join(
        "\n",
      ),
    ),
  ],
  // F5 Markdown 富元素
  f5: [
    md(
      "f5",
      [
        "### 实现要点",
        "",
        "- 渲染层只动 `data-slot` 钩子,[零改源码](https://example.com)(ADR-016)",
        "- 深浅色全由 `--a-*` token 自动适配",
        "",
        "> 长 diff / 多文件一律「在面板打开」,左侧对话保持紧凑。",
        "",
        "---",
        "",
        "有序步骤:",
        "",
        "1. 探查目录结构",
        "2. 读关键文件",
        "3. 浓缩成一句话简介",
      ].join("\n"),
    ),
  ],
  // F6 助手富脚注(hover 显复制)
  f6: [
    md("f6-body", "已完成结构核对,结论如上。"),
    {
      kind: "footnote",
      key: "f6",
      rev: "1",
      userMessageID: "msg_user",
      footnote: {
        provider: "deepseek",
        agent: "build",
        model: "DeepSeek Reasoner",
        cacheHit: 75,
        durationMs: 5200,
        tokens: 3200,
      },
      copyText: () => "已完成结构核对,结论如上。",
    } as any,
  ],
  // F7 媒体预览行
  f7: [
    {
      kind: "media",
      key: "f7",
      rev: "1",
      media: { partID: "f7", name: "界面截图.png", mime: "image/png", url: TINY_PNG },
    } as any,
  ],
  // F8 流式输出光标(真引擎 streaming)
  f8: [md("f8", "正在补 `data-loading` 态的 a11y 处理", true)],
  // F9 中断态
  f9: [
    md("f9-body", "环颜色应跟随当前文字色,这样各 variant 自适应…"),
    { kind: "divider", key: "f9", rev: "1", userMessageID: "msg_user", label: "interrupted" } as any,
  ],
  // F10 重试卡(429 自动重试)
  f10: [
    { kind: "retry", key: "f10", rev: "1", userMessageID: "msg_user", attempt: 2, message: "网关 429" } as any,
  ],
  // F11 回合级错误卡
  f11: [
    {
      kind: "turnError",
      key: "f11",
      rev: "1",
      userMessageID: "msg_user",
      name: "rate_limit_exceeded",
      message: "请求频率达到上限,模型暂时不可用;稍后重新发送这条消息即可。",
    } as any,
  ],

  // G1 通用运行态
  g1: [tool("g1", "read", { status: "running", input: { filePath: "app/prompt_builder.py" } })],
  // G2 bash 完成态(退出 0 + 描述行 + 输出体)
  g2: [
    tool("g2", "bash", {
      status: "completed",
      input: { command: "ls -la", description: "列出当前目录全部文件" },
      metadata: { exit: 0 },
      output: "app/  docs/  tests/  docker-compose.yml  pyproject.toml",
    }),
  ],
  // G3 bash 流式运行态(实时增行 + 尾行光标)
  g3: [
    tool("g3", "bash", {
      status: "running",
      input: { command: "bun test src", description: "跑一遍单元测试,输出实时可见" },
      metadata: {
        output: "✓ indicators · kama 收敛 (12ms)\n✓ prompt_builder · 字段齐全 (8ms)\nadmission · 阈值边界 …",
      },
    }),
  ],
  // G4 工具级错误卡
  g4: [
    tool("g4", "bash", {
      status: "error",
      input: { command: "curl gateway/models" },
      error: '{"detail":"Not Found"} — 代理 baseURL 或模型 ID 不存在',
    }),
  ],
  // G5 read 卡(折叠头 + .loaded 列表)
  g5: [
    tool("g5", "read", {
      status: "completed",
      input: {},
      metadata: { loaded: ["app/README.md", "app/docker-compose.yml"] },
      output: "",
    }),
  ],
  // G6 list 目录
  g6: [
    tool("g6", "list", {
      status: "completed",
      input: { path: "~/app/kama-bot-local" },
      output: ".claude/\napp/\ndocs/\ndocker-compose.yml\npyproject.toml\nREADME.md",
    }),
  ],
  // G7 grep 检索卡
  g7: [
    tool("g7", "grep", {
      status: "completed",
      input: { pattern: "image", include: "docker-compose*" },
      metadata: { matches: 2 },
      output: "docker-compose.yml:6 redis image: redis:7.4-alpine\ndocker-compose.yml:21 postgres image: postgres:16-alpine",
    }),
  ],
  // G8 glob 匹配文件卡
  g8: [
    tool("g8", "glob", {
      status: "completed",
      input: { pattern: "**/*.test.ts" },
      metadata: { count: 4 },
      output: "app/indicators.test.ts\napp/prompt_builder.test.ts\ntests/admission.test.ts\ntests/exit_rules.test.ts",
    }),
  ],
  // G9 write 紧凑卡(+96 · 在面板打开 · 2 行预览)
  g9: [
    tool("g9", "write", {
      status: "completed",
      input: {
        filePath: "AGENTS.md",
        content: "# AGENTS.md · kama-bot-local\n## Architecture (1 sentence)\n" + "…\n".repeat(94),
      },
      metadata: {},
      output: "",
    }),
  ],
  // G10 edit 紧凑 diff 卡(+1/−1)
  g10: [
    tool("g10", "edit", {
      status: "completed",
      input: { filePath: "/tmp/alpha-audit-test.txt" },
      metadata: {
        filediff: { additions: 1, deletions: 1 },
        diff: [
          "--- a/tmp/alpha-audit-test.txt",
          "+++ b/tmp/alpha-audit-test.txt",
          "@@ -1,3 +1,3 @@",
          " line one",
          "-line two",
          "+hello world",
          " line three",
        ].join("\n"),
      },
      output: "",
    }),
  ],
  // G11 apply_patch 多文件卡
  g11: [
    tool("g11", "apply_patch", {
      status: "completed",
      input: {},
      metadata: {
        files: [
          { relativePath: "src/main/proxy.ts", type: "add", additions: 30, deletions: 0 },
          { relativePath: "src/main/ipc.ts", type: "update", additions: 14, deletions: 2 },
          { relativePath: "src/main/legacy.ts", type: "delete", additions: 0, deletions: 10 },
        ],
      },
      output: "",
    }),
  ],
  // G12 文件行徽章六态一览(读取/写入 + 新增/修改/删除/移动 并列)
  g12: [
    tool("g12-read", "read", {
      status: "completed",
      input: {},
      metadata: { loaded: ["app/prompt_builder.py"] },
      output: "",
    }),
    tool("g12-write", "write", {
      status: "completed",
      input: { filePath: "AGENTS.md", content: "# AGENTS.md\n…" },
      metadata: {},
      output: "",
    }),
    tool("g12-patch", "apply_patch", {
      status: "completed",
      input: {},
      metadata: {
        files: [
          { relativePath: "src/main/util.ts", type: "move", additions: 0, deletions: 0 },
          { relativePath: "src/main/proxy.ts", type: "add", additions: 30, deletions: 0 },
          { relativePath: "src/main/ipc.ts", type: "update", additions: 14, deletions: 2 },
          { relativePath: "src/main/legacy.ts", type: "delete", additions: 0, deletions: 10 },
        ],
      },
      output: "",
    }),
  ],
  // G13 webfetch 触发行
  g13: [
    tool("g13", "webfetch", {
      status: "completed",
      input: { url: "https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Attributes/aria-busy" },
      output: "",
    }),
  ],
  // G14 诊断列表(ERR loc msg)
  g14: [
    tool("g14", "edit", {
      status: "completed",
      input: { filePath: "app/prompt_builder.py" },
      metadata: {
        filediff: { additions: 2, deletions: 1 },
        diff: "--- a/app/prompt_builder.py\n+++ b/app/prompt_builder.py\n@@ -100,2 +100,3 @@\n-    render_iter()\n+    render_admission()\n+    kama = self.kama_latest",
        diagnostics: {
          "app/prompt_builder.py": [
            { severity: 1, message: '"kama_latest" is possibly unbound', range: { start: { line: 101 } } },
          ],
        },
      },
      output: "",
    }),
  ],
  // G15 技能工具卡(执行态 · 已加载)
  g15: [tool("g15", "skill", { status: "completed", input: { name: "cloudflare" }, metadata: {}, output: "" })],
  // G16 子任务卡 v2 运行态(agent 色点 + 环形 + 打开子会话)
  g16: [
    tool("g16", "task", {
      status: "running",
      input: { description: "校验 AGENTS.md", subagent_type: "general" },
      metadata: { sessionId: "ses_child_demo" },
    }),
  ],
  // G17 websearch 结果列表
  g17: [
    tool("g17", "websearch", {
      status: "completed",
      input: { query: "solid-js loading a11y" },
      output:
        "aria-busy & loading buttons https://www.w3.org/WAI/ARIA/apg/\nSolidJS Suspense & pending UI https://www.solidjs.com/docs/latest/api",
    }),
  ],
  // G18 MCP 通用工具卡(未知工具 fail-closed 通道)
  g18: [
    tool("g18", "mcp__context7__resolve-library-id", {
      status: "completed",
      input: { libraryName: "solid-js" },
      output: "/solidjs/solid · Solid 官方文档库 · trust 9.8",
    }),
  ],
  // C6 未知工具 fail-closed 卡(回归档,不入矩阵判定)
  c6unknown: [
    tool("c6", "hostile_tool_v9", {
      status: "completed",
      input: {},
      output: "unrecognized payload: <script>alert(1)</script> renders as plain text only",
    }),
  ],

  // H1 回合分隔条
  h1: [
    { kind: "turn", key: "h1", rev: "1", userMessageID: "msg_user", createdAt: at(9, 24) } as any,
    md("h1-body", "新一轮从这里开始。"),
  ],
  // H2 已探索分组(2 次读取 · 1 次搜索;点头展开)
  h2: [
    {
      kind: "toolgroup",
      key: "h2",
      rev: "1",
      parts: [
        {
          id: "h2a",
          type: "tool",
          tool: "read",
          state: { status: "completed", input: { filePath: "README.md", limit: 30 }, metadata: {}, output: "" },
        },
        {
          id: "h2b",
          type: "tool",
          tool: "read",
          state: { status: "completed", input: { filePath: "docker-compose.yml" }, metadata: {}, output: "" },
        },
        {
          id: "h2c",
          type: "tool",
          tool: "grep",
          state: { status: "completed", input: { pattern: "image" }, metadata: { matches: 2 }, output: "" },
        },
      ],
    } as any,
  ],
  // H3 本回合改动汇总 diffsum(3 文件 +105 −5;点头展开)
  h3: [
    {
      kind: "diffsum",
      key: "h3",
      rev: "1",
      userMessageID: "msg_user",
      files: [
        { file: "AGENTS.md", additions: 96, deletions: 0 },
        { file: "alpha-ui/button.css", additions: 8, deletions: 2 },
        { file: "prompts/INSTRUCTIONS.md", additions: 1, deletions: 3 },
      ],
      additions: 105,
      deletions: 5,
      truncated: false,
    } as any,
  ],
  // H4 上下文压缩分隔
  h4: [
    md("h4-a", "此前的探查结论已并入摘要。"),
    {
      kind: "divider",
      key: "h4",
      rev: "2",
      userMessageID: "msg_user",
      label: "compaction",
      summaryParts: [
        {
          id: "h4-summary",
          sessionID: "ses_harness",
          messageID: "msg_compaction",
          type: "text",
          text: "## 保留要点\n\n- 已确认安全边界\n- 下一步补 AGENTS.md 的硬约束一节",
        },
      ],
    } as any,
    md("h4-b", "继续:下一步补 AGENTS.md 的硬约束一节。"),
  ],
  // H5 回到底部按钮(渲染长内容后向上滚动触发)
  h5: [
    ...Array.from({ length: 14 }, (_, i) =>
      md(`h5-${i}`, `第 ${i + 1} 段:结构核对的中间结论,占位保证滚动高度。\n\n- 要点一\n- 要点二`),
    ),
  ],

  // I1 产物链接行(6 类型含 parquet)
  i1: [
    md("i1-body", "已完成:分析写进了文档,配图与网页原型一并生成,数据底表和打印版也在下面。"),
    {
      kind: "artifacts",
      key: "i1",
      rev: "1",
      partID: "i1",
      links: [
        { runId: "job_7f3a", name: "季度经营分析.docx" },
        { runId: "job_7f3a", name: "营收对比图.png" },
        { runId: "job_7f3a", name: "网页原型.html" },
        { runId: "job_7f3a", name: "分析摘要.md" },
        { runId: "job_7f3a", name: "打印版.pdf" },
        { runId: "job_7f3a", name: "数据底表.parquet" },
      ],
    } as any,
  ],
}

// ── 挂载 ────────────────────────────────────────────────────────────────────
const [rows, setRows] = createSignal<TimelineRow[]>([])
const intents = {
  focusArtifact: (intent: unknown) => console.log("[harness] focusArtifact", intent),
  openSession: (id: string) => console.log("[harness] openSession", id),
  openFile: (intent: unknown) => console.log("[harness] openFile", intent),
  continueTurn: () => console.log("[harness] continueTurn"),
  editUserMessage: (intent: unknown) => console.log("[harness] editUserMessage", intent),
}

document.title = "REQ-125 timeline harness"
document.documentElement.dataset.colorScheme = "light"
document.body.textContent = ""
document.body.style.margin = "0"
const host = document.createElement("div")
host.id = "harness-host"
host.className = "a-ui"
host.style.cssText = "width:900px;height:640px;margin:0 auto;display:flex;flex-direction:column"
document.body.appendChild(host)
document.body.style.background = "var(--a-bg-canvas)"

render(
  () => (
    <MarkedProvider>
      <SessionTimelineView
        rows={rows()}
        ready={true}
        epoch="harness"
        emptyTitle="整理架构说明"
        history={{ more: false, loading: false }}
        onLoadOlder={() => Promise.resolve()}
        intents={intents}
        displayNames={{
          agent: (agent) => agent.slice(0, 1).toUpperCase() + agent.slice(1),
          model: (_providerID, modelID) => (modelID === "deepseek-reasoner" ? "DeepSeek Reasoner" : modelID),
        }}
      />
    </MarkedProvider>
  ),
  host,
)

const harness = {
  show(id: string) {
    const next = STATES[id]
    if (!next) throw new Error(`unknown state: ${id} (known: ${Object.keys(STATES).join(", ")})`)
    setRows(next)
    return id
  },
  theme(mode: "light" | "dark") {
    document.documentElement.dataset.colorScheme = mode
    return mode
  },
  states: Object.keys(STATES),
}
;(window as any).__harness = harness
export default harness
