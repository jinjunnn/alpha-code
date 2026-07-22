// REQ-088 T2(#181):AlphaSessionWorkspace 宿主红线钉测。
//
// T6 共存审计(docs/audits/2026-07-13-s48-req088-t6-takeover-coexistence.md §3/§7.2)把三条
// 宿主约束点名给 T2 落静态测试 —— takeover 的选择器/可见性口径依赖这些不变量:
//   R1 活叶包裹保持普通文档流(flex:1 + min-height:0;禁隐藏活叶、禁脱流定位);
//   R2 chrome 一律 alpha 命名空间(a-swk-* 类 + data-alpha-* 属性),不与上游锚点同名;
//   R7 三个 takeover 不移进叶/workspace 内(挂载通道零耦合,另有 takeover-adapter-coexistence
//      测试①钉 children 通道;此处钉 workspace 侧不 import)。
// 另钉:单一 release-state seam、SurfaceBoundary 组合、跨 server 引导的 rethrow 纪律、窄导出唯一消费、
// C4 携带项③ 的侧栏预热接线。断言红 = 红线破坏,回 T6 审计 §3 重评,不得只改测试。

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const here = import.meta.dir
const tsx = readFileSync(join(here, "alpha-session-workspace.tsx"), "utf8")
const css = readFileSync(join(here, "session-workspace.css"), "utf8")
const rendererIndex = readFileSync(join(here, "../../index.tsx"), "utf8")
const sidebar = readFileSync(join(here, "../../sidebar/alpha-sidebar.tsx"), "utf8")

describe("R1 活叶包裹保持普通流(takeover offsetParent 口径的前提)", () => {
  test("外框 = flex 列 + height:100% + min-height:0;叶包裹 = flex:1 + min-height:0(与 spike 实证形态一致)", () => {
    expect(tsx).toContain(`<div class="a-swk-root" data-alpha-session-workspace>`)
    expect(tsx).toContain(`<div class="a-swk-leaf" data-alpha-session-workspace-leaf>`)
    const rootRule = css.match(/\.a-swk-root \{[^}]*\}/)?.[0] ?? ""
    expect(rootRule).toContain("display: flex")
    expect(rootRule).toContain("flex-direction: column")
    expect(rootRule).toContain("height: 100%")
    expect(rootRule).toContain("min-height: 0")
    const leafRule = css.match(/\.a-swk-leaf \{[^}]*\}/)?.[0] ?? ""
    expect(leafRule).toContain("flex: 1")
    expect(leafRule).toContain("min-height: 0")
  })

  test("不隐藏、不脱流:workspace 的 tsx/css 全文不得出现 display:none 或 position:fixed", () => {
    for (const src of [tsx, css]) {
      expect(src).not.toMatch(/display:\s*none/)
      expect(src).not.toMatch(/position:\s*fixed/)
      expect(src).not.toMatch(/visibility:\s*hidden/)
    }
  })

  test("同 document 前提:无 iframe", () => {
    expect(tsx).not.toContain("<iframe")
  })
})

describe("R2 chrome 全部 alpha 命名空间(不与上游锚点同名)", () => {
  test("workspace 自渲染的 data-* 属性一律以 data-alpha- 开头(tsx + css)", () => {
    for (const [name, src] of Object.entries({ tsx, css })) {
      const offenders = [...src.matchAll(/data-(?!alpha-)[a-z][a-z0-9-]*/g)].map((m) => m[0])
      expect({ name, offenders }).toEqual({ name, offenders: [] })
    }
  })

  test("上游锚点名(REQ-012 manifest 内外)零出现 —— takeover/anchor-audit 不会误收 chrome", () => {
    // T6 审计 §2 逐 takeover 依赖的选择器面:manifest 内(prompt-input-v2 等)+ manifest 外补钉。
    const upstreamAnchorTokens = [
      "session-prompt-dock",
      "prompt-input-v2",
      "progress-circle",
      "a-chip-model",
      "terminal-panel",
      "review-panel",
      "tool-error-card",
      "session-turn",
      "user-message",
      "list-item",
      "list-scroll",
    ]
    for (const token of upstreamAnchorTokens) {
      for (const [name, src] of Object.entries({ tsx, css })) {
        expect({ name, token, present: src.includes(token) }).toEqual({ name, token, present: false })
      }
    }
  })
})

describe("R7 / Stage C-1:takeover 不进 workspace;本期不自渲染 AlphaComposer", () => {
  test("workspace 不 import 三个 takeover 模块(生命周期仍归 AppInterface children,审计不变量①)", () => {
    expect(tsx).not.toMatch(/from\s+"[^"]*(composer-takeover|model-picker-inject|timeline-inject)"/)
  })

  test("workspace 不 import / 不渲染 AlphaComposer(Stage C-1 要求与 takeover gate 同 PR,见审计 §4.1)", () => {
    expect(tsx).not.toMatch(/from\s+"[^"]*alpha-composer"/)
    expect(tsx).not.toContain("<AlphaComposer")
  })
})

describe("single release-state seam contract", () => {
  test("factory returns a preloadable component without localStorage", () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "--eval",
        `import { mock } from "bun:test";
mock.module("react/jsx-dev-runtime", () => ({ Fragment: Symbol(), jsxDEV: () => ({}) }));
mock.module("@solidjs/router", () => ({ useLocation: () => ({ pathname: "" }), useNavigate: () => () => {} }));
const module = await import("./src/renderer/alpha-ui/session-workspace/alpha-session-workspace.tsx");
const component = module.alphaSessionWorkspaceSurface();
console.log(JSON.stringify({ localStorage: typeof globalThis.localStorage, component: typeof component, preload: typeof component.preload }));`,
      ],
      cwd: join(here, "../../../.."),
      env: process.env,
    })
    expect(result.stderr.toString()).toBe("")
    expect(JSON.parse(result.stdout.toString())).toEqual({
      localStorage: "undefined",
      component: "function",
      preload: "function",
    })
    expect(tsx).not.toContain("isSessionSpikeEnabled")
    expect(tsx).not.toContain("ALPHA_SESSION_SPIKE")
  })

  test("index.tsx calls the factory only when resolved.session.mode is alpha", () => {
    expect(rendererIndex).toContain(`if (resolved?.session.mode !== "alpha") return undefined`)
    expect(rendererIndex).toContain(`return alphaSessionWorkspaceSurface()`)
    expect(rendererIndex).toContain(`const session = productionRoutes.session.mount(resolved)`)
    expect(rendererIndex.match(/return alphaSessionWorkspaceSurface\(\)/g)).toHaveLength(1)
    expect(rendererIndex).not.toContain("SessionSpikeHost")
  })

  test("SurfaceBoundary 语义保持(C4 真机实证链路):workspace 最外层即 surface 边界", () => {
    expect(tsx).toContain(`<SurfaceBoundary surface="session">`)
  })

  test("seam preload 契约对齐(app.tsx `preload: () => Leaf.preload?.()`)", () => {
    expect(tsx).toContain("Comp.preload = preloadSessionLeaf")
  })

  test("窄导出在本文件恰好消费一次(唯一消费点断言另见 req087-characterization §6 全仓扫描)", () => {
    const occurrences = tsx.split("@opencode-ai/app/surface/session").length - 1
    expect(occurrences).toBe(1)
    expect(tsx).toContain(`const upstreamLeafImport = () => import("@opencode-ai/app/surface/session")`)
  })
})

describe("C4 携带项②/③ 的接线", () => {
  test("②跨 server 引导:识别不到的错误在 fallback 内同步 rethrow(SurfaceBoundary 兜底不变)", () => {
    expect(tsx).toContain("if (!isCrossServerSessionError(error)) throw error")
    expect(tsx).toContain('console.warn("ALPHA_CROSS_SERVER_SESSION_BLOCKED")')
    expect(tsx).not.toContain('console.warn("ALPHA_CROSS_SERVER_SESSION_BLOCKED", error)')
    expect(tsx).toContain("onClick={() => navigate(hrefFor.home())}")
  })

  test("③侧栏预热:session 行 hover + 打开/新建路径接 preloadSessionLeaf(消 C4 冷入场 0ms 采样)", () => {
    expect(sidebar).toContain(`import { preloadSessionLeaf } from "../alpha-ui/session-workspace/alpha-session-workspace"`)
    expect(sidebar).toContain("onMouseEnter={preloadSessionLeaf}")
    // 无 hover 路径(键盘/新建会话)兜底
    expect(sidebar.split("preloadSessionLeaf()").length - 1).toBeGreaterThanOrEqual(2)
  })
})
