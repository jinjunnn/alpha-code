// REQ-125 C3-term(#550)—— 终端面板:页签状态机(纯模型)+ 真 Solid 挂载外壳 + I1/I5 静态断言。
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { sameSessionIdentity, type AlphaSessionIdentity } from "../../session-workspace/session-workspace-core"
import {
  acceptedEngineChannel,
  anyTerminalRunning,
  formatTerminalSize,
  resolveActiveInstance,
  type AlphaTerminalEngineChannel,
  type AlphaTerminalInstance,
} from "./terminal-rail-core"

const panel = readFileSync(join(import.meta.dir, "terminal-rail-panel.tsx"), "utf8")
const core = readFileSync(join(import.meta.dir, "terminal-rail-core.ts"), "utf8")
const runtimeSource = readFileSync(join(import.meta.dir, "terminal-rail-test-runtime.tsx"), "utf8")
const css = readFileSync(join(import.meta.dir, "terminal-rail.css"), "utf8")
const shell = readFileSync(join(import.meta.dir, "../../session-workspace/session-workspace-shell.tsx"), "utf8")

const instance = (id: string, running = false): AlphaTerminalInstance => ({ id, title: id, running })

// 剥掉注释行:静态断言约束的是代码;注释里允许指名上游落点(勘破记录)。
const codeLines = (source: string) =>
  source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
    .join("\n")

describe("REQ-125 C3-term tab state machine", () => {
  test("active resolution: empty list, stale active, and direct hit", () => {
    expect(resolveActiveInstance([], "pty_1")).toBeUndefined()
    expect(resolveActiveInstance([], undefined)).toBeUndefined()

    const all = [instance("pty_1"), instance("pty_2")]
    expect(resolveActiveInstance(all, "pty_2")?.id).toBe("pty_2")
    expect(resolveActiveInstance(all, undefined)?.id).toBe("pty_1")
    expect(resolveActiveInstance(all, "pty_gone")?.id).toBe("pty_1")
  })

  test("any-running rolls up per-instance run indicators", () => {
    expect(anyTerminalRunning([])).toBe(false)
    expect(anyTerminalRunning([instance("a"), instance("b")])).toBe(false)
    expect(anyTerminalRunning([instance("a"), instance("b", true)])).toBe(true)
  })

  test("engine channel is only consumable with an accepted identity triple (I8 fail-closed)", () => {
    const identity: AlphaSessionIdentity = { serverKey: "sidecar", directory: "/tmp/workspace", sessionID: "ses_a" }
    const channel = { identity } as AlphaTerminalEngineChannel
    const acceptsOnly = (live: AlphaSessionIdentity) => (candidate: AlphaSessionIdentity) =>
      sameSessionIdentity(candidate, live)

    // channel 缺席 / 校验器缺席 → 一律拒绝(fail-closed)。
    expect(acceptedEngineChannel(undefined, acceptsOnly(identity))).toBeUndefined()
    expect(acceptedEngineChannel(channel, undefined)).toBeUndefined()

    // 三元组任一维不符 → 拒绝;完全一致才放行。
    expect(acceptedEngineChannel(channel, acceptsOnly({ ...identity, sessionID: "ses_b" }))).toBeUndefined()
    expect(acceptedEngineChannel(channel, acceptsOnly({ ...identity, directory: "/tmp/other" }))).toBeUndefined()
    expect(acceptedEngineChannel(channel, acceptsOnly({ ...identity, serverKey: "remote" }))).toBeUndefined()
    expect(acceptedEngineChannel(channel, acceptsOnly(identity))).toBe(channel)
  })

  test("foot size renders only from sane cols×rows", () => {
    expect(formatTerminalSize(80, 24)).toBe("80×24")
    expect(formatTerminalSize(undefined, 24)).toBeUndefined()
    expect(formatTerminalSize(80, undefined)).toBeUndefined()
    expect(formatTerminalSize(0, 24)).toBeUndefined()
    expect(formatTerminalSize(-80, 24)).toBeUndefined()
    expect(formatTerminalSize(80.5, 24)).toBeUndefined()
    expect(formatTerminalSize(Number.NaN, 24)).toBeUndefined()
  })
})

describe("REQ-125 C3-term real Solid mount", () => {
  test("component cases cover tabs, run indicators, engine embed, foot, and fail-closed states", () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "test", resolve(import.meta.dir, "../../../../../test-component/terminal-rail.cases.ts")],
      cwd: resolve(import.meta.dir, "../../../../.."),
      env: process.env,
    })
    const output = `${result.stdout.toString()}${result.stderr.toString()}`
    if (result.exitCode !== 0) throw new Error(output)
    expect(output).toContain("8 pass")
    expect(output).toContain("0 fail")
  })
})

describe("REQ-125 C3-term I1/I5 static ratchets", () => {
  test("terminal shell imports no upstream module and hand-rolls no engine or data channel", () => {
    const sources = codeLines(`${panel}\n${core}\n${runtimeSource}`)
    const forbidden = [
      // I1:零上游 import —— 引擎只能经 typed seam(AlphaTerminalEngineChannel)进入。
      "@opencode-ai/app",
      "@opencode-ai/ui",
      "@opencode-ai/session-ui",
      "app/src/",
      "MessageTimeline",
      "MessagePart",
      "SessionPage",
      // 零查询上游 DOM。
      "querySelector",
      "MutationObserver",
      // 引擎与数据通道不得在 alpha 侧重实现(白名单 = 复用,不是重写)。
      "ghostty-web",
      "new WebSocket",
      "window.api",
    ]
    forbidden.forEach((token) => expect(sources).not.toContain(token))
    expect(panel).toContain("AlphaTerminalEngineChannel")
    // I8:channel 消费必须走身份闸,seam 上必须携带三元身份。
    expect(panel).toContain("acceptedEngineChannel(props.channel, props.accepts)")
    expect(core).toContain("identity: AlphaSessionIdentity")
  })

  test("panel copy is fully externalized to i18n with en/zh parity", () => {
    // 产品面无硬编码文案(CJK 只允许出现在注释外的字符串 = 0;此处直接禁全文件 CJK,注释亦用可审计中文?
    // —— 注释允许中文,故只扫 JSX/字符串行:粗粒度为「非注释行不得含 CJK」。
    const cjkLines = panel
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*"))
      .filter((line) => /[㐀-鿿]/.test(line))
    expect(cjkLines).toEqual([])

    const en = readFileSync(join(import.meta.dir, "../../../i18n/en.ts"), "utf8")
    const zh = readFileSync(join(import.meta.dir, "../../../i18n/zh.ts"), "utf8")
    const keys = [...panel.matchAll(/t\("(alpha\.[a-z.A-Z]+)"/g)].map((match) => match[1])
    expect(keys.length).toBeGreaterThan(0)
    keys.forEach((key) => {
      expect(en).toContain(`"${key}"`)
      expect(zh).toContain(`"${key}"`)
    })
  })

  test("css uses only --a-* tokens; raw colors live only in the theme-invariant stage anchors", () => {
    // I5:一切 var() 引用是 --a-*。
    expect(
      [...css.matchAll(/var\((--[^,)]+)/g)].map((match) => match[1]).filter((token) => !token.startsWith("--a-")),
    ).toEqual([])

    // 颜色字面量只允许出现在 --a-term-stage-* 定义行(双主题恒深底的局部锚)。
    const rawColorLines = codeLines(css)
      .split("\n")
      .filter((line) => /#[0-9a-f]{3,8}\b|rgba?\(|oklch\(/i.test(line))
      .filter((line) => !/^\s*--a-term-stage-[a-z-]+:/.test(line))
    expect(rawColorLines).toEqual([])

    // 深底不随主题条件翻转:文件内禁任何主题条件选择器。
    expect(codeLines(css)).not.toContain("data-theme")
    expect(codeLines(css)).not.toContain("prefers-color-scheme")
    expect(css.match(/\.a-term-stage \{[^}]*\}/s)?.[0]).toContain("background: var(--a-term-stage-bg)")

    // 呼吸点动效在 reduced-motion 下静止。
    expect(css).toContain("@media (prefers-reduced-motion: reduce)")
    expect(css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*$/)?.[0]).toContain("animation: none")
  })

  test("shell mounts the terminal panel only for the terminal rail state, gated by live.accepts", () => {
    expect(shell).toContain(`import { TerminalRailPanel } from "../session-rail/terminal/terminal-rail-panel"`)
    expect(shell).toMatch(
      /activePanel\(\) === "terminal"[\s\S]{0,300}<TerminalRailPanel channel=\{props\.terminalChannel\?\.\(\)\} accepts=\{props\.live\.accepts\} \/>/,
    )
  })
})
