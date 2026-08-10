// REQ-125 C6 — cards/ 目录的 I1/I3/I5/I6 静态棘轮(与 C5 session-timeline 同一清单,
// 外加本票的两条:jsdiff 是 cards 里唯一允许的内容引擎;外链只允许显式外开形态)。
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const dir = import.meta.dir
const sourceFiles = readdirSync(dir)
  .filter((name) => /\.(ts|tsx|css)$/.test(name) && !/\.test\./.test(name))
  .sort()
const sources = new Map(sourceFiles.map((name) => [name, readFileSync(join(dir, name), "utf8")] as const))
const codeSource = [...sources.entries()]
  .filter(([name]) => !name.endsWith(".css"))
  .map(([, source]) => source)
  .join("\n")
const css = sources.get("cards.css")!

describe("REQ-125 C6 I1 白名单静态棘轮(cards)", () => {
  test("零上游 session 组件/DOM 依赖,零命令式 DOM 查询", () => {
    const forbidden = [
      "app/src/pages/session",
      "@opencode-ai/app",
      "@opencode-ai/session-ui",
      "@opencode-ai/ui",
      "MessageTimeline",
      "MessagePart",
      "message-part",
      "basic-tool",
      "tool-error-card",
      "querySelector",
      "MutationObserver",
      "data-component=",
      "data-slot=",
    ]
    forbidden.forEach((token) =>
      expect({ token, present: codeSource.includes(token) }).toEqual({ token, present: false }),
    )
  })

  test("内容引擎白名单:jsdiff 是唯一引擎依赖,且只在 tool-diff 引用", () => {
    for (const [name, source] of sources) {
      if (name.endsWith(".css")) continue
      expect({ name, importsJsdiff: source.includes(`from "diff"`) }).toEqual({
        name,
        importsJsdiff: name === "tool-diff.ts",
      })
    }
  })
})

describe("REQ-125 C6 I3/I6 安全渲染静态棘轮(cards)", () => {
  test("不存在绕过 sanitizer 管线的 HTML 注入路径", () => {
    // 禁用清单字面量(断言源码中不存在),不是调用。
    const forbidden = [
      "innerHTML",
      "outerHTML",
      "insertAdjacentHTML",
      "document.write",
      "eval(",
      "new Function",
      "srcdoc",
    ]
    forbidden.forEach((token) =>
      expect({ token, present: codeSource.includes(token) }).toEqual({ token, present: false }),
    )
  })

  test("外链只以显式外开形态出现(target=_blank + noopener);不出现应用内导航 API", () => {
    const anchors = [...codeSource.matchAll(/<a\s[^>]*>/g)].map((match) => match[0])
    anchors.forEach((anchor) => {
      expect(anchor).toContain(`target="_blank"`)
      expect(anchor).toContain("noopener")
    })
    expect(codeSource).not.toContain("window.open")
    expect(codeSource).not.toContain("location.href")
  })

  test("媒体缩略只认受限 data:image(mediaThumbable 是唯一 img 来源开关)", () => {
    const cards = sources.get("tool-cards.tsx")!
    expect(cards).toContain("mediaThumbable(props.media.url)")
    const model = sources.get("tool-card-model.ts")!
    expect(model).toContain(`url.startsWith("data:image/")`)
  })
})

describe("REQ-125 C6 I5 令牌白名单与运动契约(cards.css)", () => {
  test("CSS 只消费 --a-* 令牌,无原始颜色字面量", () => {
    expect(
      [...css.matchAll(/var\((--[^,)]+)/g)].map((match) => match[1]).filter((token) => !token.startsWith("--a-")),
    ).toEqual([])
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|oklch\(/i)
  })

  test("reduced-motion:关键帧动画显式关断,过渡时长全部走 --a-dur 令牌", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce)")
    const transitions = [...css.matchAll(/transition:\s*([^;]+);/g)].map((match) => match[1])
    transitions.forEach((value) => expect(value).toContain("var(--a-dur"))
  })

  test("#865 产物行复用 renderer 决策；fallback 保持可聚焦但使用中性态", () => {
    const cards = sources.get("tool-cards.tsx")!
    expect(cards).toContain(`import { routeArtifact } from "../../artifact-workbench/renderers/registry"`)
    expect(cards).toContain(`routeArtifact({ name: link.name }).rendererId !== "fallback"`)

    const neutral = css.match(/\.a-artrow\[data-previewable="false"\] \{[^}]*\}/)?.[0] ?? ""
    expect(neutral).toContain("color: var(--a-text-secondary)")
    expect(neutral).toContain("font-weight: var(--a-weight-normal)")
    expect(css).toContain(`.a-artrow[data-previewable="false"]:hover:not(:disabled)`)
    expect(css).toContain("background: var(--a-bg-muted)")
  })
})
