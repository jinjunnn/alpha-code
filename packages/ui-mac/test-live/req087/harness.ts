// REQ-087 C2 live-engine characterization harness(Issue alpha-code#181 激活前置 C2)。
//
// 「真引擎」承诺(与 req087-characterization.test.ts 底部原 test.todo 的口径一致):
// - 引擎 = 真实 `bun run packages/opencode/src/index.ts serve`(真实 storage/SSE/PTY/权限机),
//   XDG_* 全部指向临时目录,与开发者本机数据隔离;
// - 前端 = 冻结 packages/app 的真实 renderer(vite dev,上游自身支持的 web 运行态),
//   在真实 Chromium(Playwright channel "chrome")中驱动 —— 不是 happy-dom,不是 mock server;
// - 消息种子 = 引擎公开 API(/session/:id/shell)产生的真实消息;
// - LLM 流 = 引擎完整 streaming 管线,唯一被脚本化的是模型 token 端点
//   (OpenAI-compatible SSE fixture;工具调用/权限询问/abort 全部走引擎真实机制)。
//
// 运行前提(见 scripts/req087-live-characterization.sh):
// - macOS 安装了 Google Chrome(channel "chrome",不额外下载浏览器);
// - 仓库已 bun install;
// - 不在 alpha-check 权威门内(bun test src 不含本目录),按需执行:
//   bun run --cwd packages/ui-mac test:live:req087
//
// REQ-088 T3/T4(adapter 对比)扩展 —— 两个环境参数(默认全关 = C2 原语义,零变化):
// - REQ088_HOST=webhost:前端改跑 test-live/req087/webhost/(harness 自有 web 入口,复刻冻结
//   entry.tsx 并经公开 surfaces prop 支持注入;见 webhost/main.tsx 头注释)。默认 frozen =
//   冻结 packages/app 自身 vite dev(C2 基线运行态)。
// - REQ088_SURFACE=adapter:每个浏览器 context 预置 localStorage["ALPHA_SESSION_SPIKE"]="1"
//   (双闸的 renderer 半边)⇒ webhost 注入真 AlphaSessionWorkspace。默认 legacy = 不注入。
//   adapter 仅在 webhost 下有意义(冻结入口不传 surfaces,结构上无法注入)—— 组合非法时直接 throw。
// 对比方法论:adapter/legacy 两半边都跑 webhost(同 host、同引擎、同浏览器、同会话数据,唯一
// 差异 = localStorage 闸);frozen legacy 只作历史锚点(baselines/legacy-baseline.json)的复采参照。
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core"

export const REPO_ROOT = join(import.meta.dir, "../../../..")

const PORT_BASE = Number(process.env.REQ087_LIVE_PORT_BASE ?? 14700)
export const ENGINE_PORT = PORT_BASE
export const MODEL_PORT = PORT_BASE + 1
export const APP_PORT = PORT_BASE + 2

export type Req088Host = "frozen" | "webhost"
export type Req088Surface = "legacy" | "adapter"
export const HOST: Req088Host = process.env.REQ088_HOST === "webhost" ? "webhost" : "frozen"
export const SURFACE: Req088Surface = process.env.REQ088_SURFACE === "adapter" ? "adapter" : "legacy"
/** 运行风味标识(基线文件名/日志标签):frozen-legacy | webhost-legacy | webhost-adapter。 */
export const FLAVOR = `${HOST}-${SURFACE}`
if (SURFACE === "adapter" && HOST !== "webhost") {
  throw new Error("REQ088_SURFACE=adapter requires REQ088_HOST=webhost (frozen entry cannot inject surfaces)")
}

/** AlphaSessionWorkspace 的 DOM 锚点(全部 data-alpha-*,R2 红线保证与上游锚点不同名)。 */
export const ADAPTER_SEL = {
  workspace: "[data-alpha-session-workspace]",
  chrome: "[data-alpha-session-workspace-chrome]",
  leaf: "[data-alpha-session-workspace-leaf]",
  guard: "[data-alpha-session-workspace-guard]",
} as const

/**
 * 断言页面确实运行在期望的 surface 模式 —— 防「闸没生效却当成 adapter 度量」的静默错半边。
 * adapter:workspace 锚点已挂载且 chrome 可见(高度>0);legacy:workspace 锚点必须为 0。
 * 只在度量点之后调用(mount 计时窗口内不得插入本等待)。
 */
export async function assertSurfaceMode(page: Page, timeoutMs = 20000) {
  if (SURFACE === "adapter") {
    await page.waitForSelector(ADAPTER_SEL.workspace, { timeout: timeoutMs, state: "attached" })
    const chromeHeight = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>("[data-alpha-session-workspace-chrome]")
      return el ? Math.round(el.getBoundingClientRect().height) : -1
    })
    if (chromeHeight <= 0) throw new Error(`adapter chrome not visible (height=${chromeHeight})`)
  } else {
    const count = await page.evaluate(() => document.querySelectorAll("[data-alpha-session-workspace]").length)
    if (count !== 0) throw new Error(`legacy run polluted by adapter workspace (count=${count})`)
  }
}

export function base64Encode(value: string) {
  const bytes = new TextEncoder().encode(value)
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("")
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

// ---------------------------------------------------------------------------
// scripted model:OpenAI-compatible /v1/chat/completions SSE fixture。
// 最后一条 user 文本里的指令决定回复:
//   SCRIPT:text:<n>[:<delayMs>[:<marker>]] → n 个 token(`<marker>-<i>`,默认 tok),间隔 delayMs(默认 30ms)
//   SCRIPT:tool-bash:<command>    → 首轮发 bash tool_call;工具结果回来后发短文本收尾
//   其它                          → 简短 ack 文本
// ---------------------------------------------------------------------------
export interface ModelCall {
  hasToolResult: boolean
  lastUser: string
  toolNames: string[]
}

function startScriptedModel() {
  const calls: ModelCall[] = []
  const server = Bun.serve({
    port: MODEL_PORT,
    idleTimeout: 240,
    async fetch(req) {
      const url = new URL(req.url)
      if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      const body = (await req.json().catch(() => ({}))) as {
        messages?: { role: string; content: unknown }[]
        tools?: { function?: { name?: string } }[]
      }
      const messages = body.messages ?? []
      const lastUser = [...messages].reverse().find((m) => m.role === "user")
      const text = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "")
      // 「工具续轮」判定必须看最后一条消息(刚回来的 tool 结果),不能扫全史 ——
      // shell 种子消息在历史里本来就带 tool 部件。
      const hasToolResult = messages.at(-1)?.role === "tool"
      calls.push({ hasToolResult, lastUser: text, toolNames: (body.tools ?? []).map((t) => t.function?.name ?? "") })

      const enc = new TextEncoder()
      const stream = new ReadableStream({
        async start(controller) {
          const send = (obj: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`))
          const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
            id: "chatcmpl-scripted",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "scripted-1",
            choices: [{ index: 0, delta, finish_reason: finish }],
          })
          const tool = text.match(/SCRIPT:tool-bash:(.+)/)
          if (tool && !hasToolResult) {
            send(chunk({ role: "assistant" }))
            send(chunk({ tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name: "bash", arguments: "" } }] }))
            send(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: tool[1].trim() }) } }] }))
            send(chunk({}, "tool_calls"))
          } else {
            const m = text.match(/SCRIPT:text:(\d+)(?::(\d+))?(?::([a-z0-9-]+))?/)
            const n = m ? Number(m[1]) : 2
            const delay = m?.[2] ? Number(m[2]) : 30
            const marker = m?.[3] ?? "tok"
            send(chunk({ role: "assistant" }))
            if (hasToolResult) {
              send(chunk({ content: "tool finished." }))
            } else {
              for (let i = 0; i < n; i++) {
                send(chunk({ content: `${marker}-${i} ` }))
                if (delay) await Bun.sleep(delay)
              }
            }
            send(chunk({}, "stop"))
          }
          controller.enqueue(enc.encode("data: [DONE]\n\n"))
          controller.close()
        },
      })
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
    },
  })
  return { server, calls }
}

// ---------------------------------------------------------------------------
// engine event recorder(真实 /event SSE 流)
// ---------------------------------------------------------------------------
export interface EngineEvent {
  type: string
  properties?: Record<string, any>
}

class EventRecorder {
  readonly events: EngineEvent[] = []
  private ac = new AbortController()

  constructor(
    private base: string,
    private dirQ: string,
  ) {}

  start() {
    void (async () => {
      const res = await fetch(`${this.base}/event?${this.dirQ}`, { signal: this.ac.signal })
      const reader = res.body!.getReader()
      const dec = new TextDecoder()
      let buf = ""
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          const line = raw.split("\n").find((l) => l.startsWith("data: "))
          if (!line) continue
          try {
            this.events.push(JSON.parse(line.slice(6)) as EngineEvent)
          } catch {
            // non-JSON heartbeat
          }
        }
      }
    })().catch(() => {})
  }

  async wait(predicate: (e: EngineEvent) => boolean, timeoutMs = 15000, from = 0): Promise<EngineEvent | undefined> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const hit = this.events.slice(from).find(predicate)
      if (hit) return hit
      await Bun.sleep(100)
    }
    return undefined
  }

  cursor() {
    return this.events.length
  }

  stop() {
    this.ac.abort()
  }
}

// ---------------------------------------------------------------------------
// world:scripted model + 真引擎 + 冻结 app(vite dev)+ Chrome
// ---------------------------------------------------------------------------
export interface LiveWorld {
  project: string
  engineUrl: string
  appUrl: string
  modelCalls: ModelCall[]
  recorder: EventRecorder
  browser: Browser
  api: (path: string, init?: RequestInit) => Promise<any>
  sessionUrl: (sessionID: string, hash?: string) => string
  createSession: (title: string) => Promise<{ id: string }>
  seedShellTurns: (sessionID: string, turns: number, label?: string) => Promise<void>
  promptText: (sessionID: string, script: string) => Promise<any>
  promptDetached: (sessionID: string, script: string) => Promise<any>
  ptyCount: () => Promise<number>
  newPage: (opts?: { tabSessionIds?: string[] }) => Promise<{ context: BrowserContext; page: Page }>
  /** 新版布局 titlebar 会话 tab 的选择器(配合 newPage({tabSessionIds}) 预置)。 */
  titlebarTab: (sessionID: string) => string
  stop: () => Promise<void>
}

export async function startWorld(): Promise<LiveWorld> {
  const { server: modelServer, calls: modelCalls } = startScriptedModel()

  const root = mkdtempSync(join(tmpdir(), "req087-live-"))
  const project = join(root, "project")
  mkdirSync(project, { recursive: true })
  for (const d of ["data", "config", "state", "cache"]) mkdirSync(join(root, d), { recursive: true })
  writeFileSync(
    join(project, "opencode.json"),
    JSON.stringify(
      {
        provider: {
          scripted: {
            name: "Scripted (REQ-087 live characterization)",
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: `http://127.0.0.1:${MODEL_PORT}/v1`, apiKey: "scripted-key" },
            models: {
              "scripted-1": {
                name: "Scripted One",
                tool_call: true,
                temperature: true,
                limit: { context: 200000, output: 32000 },
                cost: { input: 0, output: 0 },
              },
            },
          },
        },
        model: "scripted/scripted-1",
      },
      null,
      2,
    ),
  )
  writeFileSync(join(project, "README.md"), "# REQ-087 live characterization sandbox\n")
  Bun.spawnSync(["git", "init", "-q"], { cwd: project })
  // 提交种子文件:保持 sandbox git 干净,避免 review/diff 面板因未提交变更自动展开,
  // 让 review-toggle/焦点 characterization 从确定的初始态出发。
  Bun.spawnSync(["git", "add", "-A"], { cwd: project })
  Bun.spawnSync(
    ["git", "-c", "user.email=req087@example.com", "-c", "user.name=req087", "commit", "-q", "-m", "seed"],
    { cwd: project },
  )

  const engineLog = join(root, "engine.log")
  const engine = Bun.spawn(
    ["bun", "run", join(REPO_ROOT, "packages/opencode/src/index.ts"), "serve", "--port", String(ENGINE_PORT), "--hostname", "127.0.0.1"],
    {
      cwd: project,
      env: {
        ...process.env,
        XDG_DATA_HOME: join(root, "data"),
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_STATE_HOME: join(root, "state"),
        XDG_CACHE_HOME: join(root, "cache"),
      },
      stdout: Bun.file(engineLog),
      stderr: Bun.file(engineLog),
    },
  )

  const engineUrl = `http://127.0.0.1:${ENGINE_PORT}`
  const dirQ = `directory=${encodeURIComponent(project)}`
  const api = async (path: string, init?: RequestInit) => {
    const sep = path.includes("?") ? "&" : "?"
    const res = await fetch(`${engineUrl}${path}${sep}${dirQ}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 400)}`)
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  let engineUp = false
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${engineUrl}/config/providers`)
      if (res.ok) {
        engineUp = true
        break
      }
    } catch {
      // booting
    }
    await Bun.sleep(1000)
  }
  if (!engineUp) throw new Error(`engine did not boot; log: ${engineLog}`)

  const recorder = new EventRecorder(engineUrl, dirQ)
  recorder.start()

  const appLog = join(root, "app.log")
  const appEnv = {
    ...process.env,
    VITE_OPENCODE_SERVER_HOST: "127.0.0.1",
    VITE_OPENCODE_SERVER_PORT: String(ENGINE_PORT),
  }
  // webhost:直接以 bun 执行 vite bin(webhost 目录自带 vite.config.ts;--strictPort 防端口漂移
  // 导致静默连错前端);frozen:冻结 packages/app 自身 dev script(C2 原语义)。
  const app =
    HOST === "webhost"
      ? Bun.spawn(
          [
            "bun",
            // 直接路径而非 Bun.resolveSync:vite 的 exports map 不暴露 ./bin/vite.js
            join(REPO_ROOT, "packages/app/node_modules/vite/bin/vite.js"),
            "--host",
            "127.0.0.1",
            "--port",
            String(APP_PORT),
            "--strictPort",
          ],
          {
            cwd: join(import.meta.dir, "webhost"),
            env: appEnv,
            stdout: Bun.file(appLog),
            stderr: Bun.file(appLog),
          },
        )
      : Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(APP_PORT)], {
          cwd: join(REPO_ROOT, "packages/app"),
          env: appEnv,
          stdout: Bun.file(appLog),
          stderr: Bun.file(appLog),
        })
  const appUrl = `http://127.0.0.1:${APP_PORT}`
  let appUp = false
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${appUrl}/`)
      if (res.ok) {
        appUp = true
        break
      }
    } catch {
      // booting
    }
    await Bun.sleep(1000)
  }
  if (!appUp) throw new Error(`frozen-app vite dev did not boot; log: ${appLog}`)

  const browser = await chromium.launch({
    channel: "chrome",
    headless: process.env.REQ087_LIVE_HEADFUL !== "1",
  })

  const world: LiveWorld = {
    project,
    engineUrl,
    appUrl,
    modelCalls,
    recorder,
    browser,
    api,
    sessionUrl: (sessionID, hash) => `${appUrl}/${base64Encode(project)}/session/${sessionID}${hash ?? ""}`,
    createSession: (title) => api("/session", { method: "POST", body: JSON.stringify({ title }) }),
    seedShellTurns: async (sessionID, turns, label = "seed") => {
      for (let i = 0; i < turns; i++) {
        await api(`/session/${sessionID}/shell`, {
          method: "POST",
          body: JSON.stringify({ agent: "build", command: `echo ${label}-${i}` }),
        })
      }
    },
    promptText: (sessionID, script) =>
      api(`/session/${sessionID}/message`, {
        method: "POST",
        body: JSON.stringify({
          parts: [{ type: "text", text: script }],
          model: { providerID: "scripted", modelID: "scripted-1" },
        }),
      }),
    promptDetached: (sessionID, script) =>
      api(`/session/${sessionID}/prompt_async`, {
        method: "POST",
        body: JSON.stringify({
          parts: [{ type: "text", text: script }],
          model: { providerID: "scripted", modelID: "scripted-1" },
        }),
      }),
    ptyCount: async () => ((await api("/pty")) as unknown[]).length,
    newPage: async (opts?: { tabSessionIds?: string[] }) => {
      // locale 钉死 en-US:aria-label/占位符断言不随宿主机系统语言漂移
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" })
      if (SURFACE === "adapter") {
        // 双闸 renderer 半边:每个 context(fresh localStorage)都要预置,否则该 context 会
        // 静默跑成 legacy(assertSurfaceMode 兜底,但预置必须在导航前)。
        await context.addInitScript(() => {
          localStorage.setItem("ALPHA_SESSION_SPIKE", "1")
        })
      }
      if (opts?.tabSessionIds?.length) {
        // 与上游 e2e/smoke 同一通道:预置 titlebar 会话 tab(新版布局的会话切换入口)。
        // 省略 server 字段 → tabs context 载入时回填当前 server key(context/tabs.tsx fallback)。
        const dirBase64 = base64Encode(project)
        await context.addInitScript(
          ({ dirBase64, ids }: { dirBase64: string; ids: string[] }) => {
            localStorage.setItem(
              "opencode.global.dat:tabs",
              JSON.stringify(ids.map((sessionId) => ({ type: "session", dirBase64, sessionId }))),
            )
          },
          { dirBase64, ids: opts.tabSessionIds },
        )
      }
      const page = await context.newPage()
      return { context, page }
    },
    titlebarTab: (sessionID: string) =>
      `[data-slot="titlebar-tabs"] a[href="/${base64Encode(project)}/session/${sessionID}"]`,
    stop: async () => {
      recorder.stop()
      await browser.close().catch(() => {})
      engine.kill()
      app.kill()
      modelServer.stop(true)
    },
  }
  return world
}

// ---------------------------------------------------------------------------
// page helpers(选择器与上游 e2e/smoke 同源:.scroll-view__viewport / data-timeline-row /
// data-timeline-part-id / data-message-id / session-prompt-dock + prompt-input-v2 /
// #terminal-panel / #review-panel)
// ---------------------------------------------------------------------------
export const SEL = {
  timelineRow: "[data-timeline-row]",
  partRow: "[data-timeline-part-id]",
  messageRow: "[data-message-id]",
  composer: '[data-component="session-prompt-dock"] [data-component="prompt-input-v2"]',
  composerInput:
    '[data-component="session-prompt-dock"] [data-component="prompt-input-v2"] [contenteditable="true"]',
  terminalPanel: "#terminal-panel",
  reviewPanel: "#review-panel",
  permissionActions: '[data-slot="permission-footer-actions"]',
} as const

export function timelineScroller(page: Page) {
  return page.locator(".scroll-view__viewport", { has: page.locator(SEL.timelineRow) }).first()
}

/** 等 timeline 渲染出现且布局连续 3 帧稳定(与上游 waitForTimelineStable 同思路的轻量版)。 */
export async function waitTimelineStable(page: Page, timeoutMs = 45000) {
  // attached 而非 visible:虚拟列表测量期行可能瞬时不可见,稳定性由下面的签名环判定
  await page.waitForSelector(SEL.timelineRow, { timeout: timeoutMs, state: "attached" })
  const deadline = Date.now() + timeoutMs
  let last = ""
  let stable = 0
  while (Date.now() < deadline) {
    const sig = await page.evaluate(() => {
      const scroller = [...document.querySelectorAll<HTMLElement>(".scroll-view__viewport")].find((el) =>
        el.querySelector("[data-timeline-row]"),
      )
      if (!scroller) return ""
      return JSON.stringify({
        top: Math.round(scroller.scrollTop),
        height: Math.round(scroller.scrollHeight),
        rows: scroller.querySelectorAll("[data-timeline-row]").length,
      })
    })
    if (sig && sig === last) {
      stable += 1
      if (stable >= 3) return
    } else {
      stable = 0
      last = sig
    }
    await Bun.sleep(120)
  }
  throw new Error("timeline did not stabilize")
}

/** scroller 距底 px(≈0 = 跟底)。 */
export function bottomGap(page: Page) {
  return page.evaluate(() => {
    const scroller = [...document.querySelectorAll<HTMLElement>(".scroll-view__viewport")].find((el) =>
      el.querySelector("[data-timeline-row]"),
    )
    if (!scroller) return Number.NaN
    return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop
  })
}

/** 抓取若干可见 part 相对 scroller 顶部的偏移(锚定断言用,与上游 positions() 同款)。 */
export function partOffsets(page: Page, keys: string[]) {
  return page.evaluate((wanted) => {
    const scroller = [...document.querySelectorAll<HTMLElement>(".scroll-view__viewport")].find((el) =>
      el.querySelector("[data-timeline-row]"),
    )
    if (!scroller) throw new Error("no timeline scroller")
    const top = scroller.getBoundingClientRect().top
    return Object.fromEntries(
      wanted.map((key) => {
        const row = scroller.querySelector<HTMLElement>(`[data-timeline-part-id="${key}"]`)
        if (!row) throw new Error(`missing timeline part: ${key}`)
        return [key, Math.round(row.getBoundingClientRect().top - top)]
      }),
    )
  }, keys)
}

export function visiblePartIds(page: Page) {
  return page.evaluate(() => {
    const scroller = [...document.querySelectorAll<HTMLElement>(".scroll-view__viewport")].find((el) =>
      el.querySelector("[data-timeline-row]"),
    )
    if (!scroller) return [] as string[]
    const rect = scroller.getBoundingClientRect()
    return [...scroller.querySelectorAll<HTMLElement>("[data-timeline-part-id]")]
      .filter((el) => {
        const r = el.getBoundingClientRect()
        return r.bottom >= rect.top && r.top <= rect.bottom && r.height > 0
      })
      .map((el) => el.dataset.timelinePartId!)
  })
}

export function domCounts(page: Page) {
  return page.evaluate(() => {
    const composers = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-component="session-prompt-dock"] [data-component="prompt-input-v2"]',
      ),
    ]
    return {
      composersTotal: composers.length,
      composersVisible: composers.filter((el) => el.offsetParent !== null).length,
      terminalPanels: document.querySelectorAll("#terminal-panel").length,
    }
  })
}

/** 追踪打开中的引擎 SSE(/event)连接数 —— AC4 运行时半边的浏览器侧口径。 */
export function trackOpenEventStreams(page: Page, enginePort: number) {
  const counter = { open: 0, total: 0 }
  const isEvent = (url: string) => {
    try {
      const u = new URL(url)
      return u.port === String(enginePort) && (u.pathname === "/event" || u.pathname === "/global/event")
    } catch {
      return false
    }
  }
  page.on("request", (req) => {
    if (isEvent(req.url())) {
      counter.open += 1
      counter.total += 1
    }
  })
  const done = (req: { url(): string }) => {
    if (isEvent(req.url())) counter.open -= 1
  }
  page.on("requestfinished", done)
  page.on("requestfailed", done)
  return counter
}
