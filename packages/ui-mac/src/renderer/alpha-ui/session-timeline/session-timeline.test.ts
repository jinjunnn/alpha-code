// REQ-125 C5 — 组件挂载 spawn + I1/I3/I5/I6 静态棘轮。
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const dir = import.meta.dir
const sourceFiles = readdirSync(dir)
  .filter((name) => /\.(ts|tsx|css)$/.test(name) && !/\.test\./.test(name))
  .sort()
const sources = new Map(sourceFiles.map((name) => [name, readFileSync(join(dir, name), "utf8")] as const))
const allSource = [...sources.entries()]
  .filter(([name]) => !name.endsWith(".css"))
  .map(([, source]) => source)
  .join("\n")
const css = sources.get("session-timeline.css")!
const workspace = readFileSync(join(dir, "../session-workspace/alpha-session-workspace.tsx"), "utf8")
const shell = readFileSync(join(dir, "../session-workspace/session-workspace-shell.tsx"), "utf8")

describe("REQ-125 C5/C6 时间线真实 Solid 挂载(happy-dom 子进程)", () => {
  test("空态/文本类行/历史驻点/连续锚定/引擎窗口化/截断冻结/C6 卡片全集全部通过", () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "test", resolve(dir, "../../../../test-component/session-timeline.cases.ts")],
      cwd: resolve(dir, "../../../.."),
      env: process.env,
    })
    const output = `${result.stdout.toString()}${result.stderr.toString()}`
    if (result.exitCode !== 0) throw new Error(output)
    // #879:metadata-only 降级卡与 matched 错误卡拆成两条用例(41 → 42)。
    // #620:续写不留用户气泡/孤立分隔行 + 其反向控制(42 → 44)。
    // #587:Alpha Cloud 专用卡(T8 DOM 半场)+ 全来源徽标/安全通用卡(44 → 46)。
    // #934 Minor-2:AC5「详情已隐藏」六处标记的渲染接线判据(46 → 47)。
    // #583:list 目录网格 + 分类图标 + 「共 N 项」计数(47 → 48)。
    // #584:grep 展开体分色/高亮 + redactor 失败整字段隐藏(48 → 49)。
    // #586:websearch 富链接(字母徽/标题/域名 + 头部结果数)(49 → 50)。
    // R1 Minor-A #583:截断集下 footer 计数与头部同规则缺席(50 → 51)。
    // R1 Minor-B #586:结构化结果缺 url 键被丢弃时出缺席提示(51 → 52)。
    // #582:E3/E4 斜杠 chip 来源分型(skill 橙/mcp 紫/command 通用 + source 缺席负向)(52 → 56)。
    expect(output).toContain("56 pass")
    expect(output).toContain("0 fail")
  })
})

describe("REQ-125 C5 I1 白名单静态棘轮", () => {
  test("零上游 session 组件/DOM 依赖,零命令式 DOM 查询", () => {
    const forbidden = [
      "app/src/pages/session",
      "@opencode-ai/app/surface/session",
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
    forbidden.forEach((token) => expect(allSource).not.toContain(token))
  })

  test("内容引擎白名单:session-ui 只允许 markdown 通道,且只在 timeline-markdown 引用", () => {
    const specifiers = [...allSource.matchAll(/@opencode-ai\/session-ui\/[\w./-]+/g)].map((match) => match[0])
    expect(specifiers.length).toBeGreaterThan(0)
    expect(new Set(specifiers)).toEqual(new Set(["@opencode-ai/session-ui/markdown"]))
    for (const [name, source] of sources) {
      if (name === "timeline-markdown.tsx" || name.endsWith(".css")) continue
      expect({ name, importsEngine: source.includes("@opencode-ai/session-ui") }).toEqual({
        name,
        importsEngine: false,
      })
    }
  })

  test("数据面只经公开 typed hooks(useServerSync/useServerSDK)进入", () => {
    const binding = sources.get("session-timeline.tsx")!
    expect(binding).toContain(`import { useServerSDK, useServerSync } from "@opencode-ai/app"`)
    const appImports = [...allSource.matchAll(/from "@opencode-ai\/app[^"]*"/g)].map((match) => match[0])
    expect(new Set(appImports)).toEqual(new Set([`from "@opencode-ai/app"`]))
  })
})

describe("REQ-125 C5 I3/I6 安全渲染静态棘轮", () => {
  test("alpha 侧不存在绕过 sanitizer 管线的 HTML 注入路径", () => {
    // 下列 token 是「禁用清单」字面量(断言源码中不存在),不是调用。
    const forbidden = [
      "innerHTML",
      "outerHTML",
      "insertAdjacentHTML",
      "document.write",
      "eval(",
      "new Function",
      "srcdoc",
    ]
    forbidden.forEach((token) => expect(allSource).not.toContain(token))
  })

  test("Markdown 只经 timeline-markdown 的引擎通道渲染,且进引擎前有界", () => {
    const markdown = sources.get("timeline-markdown.tsx")!
    expect(markdown).toContain(`import { Markdown } from "@opencode-ai/session-ui/markdown"`)
    expect(markdown).toContain("boundedText(props.text, MARKDOWN_MAX_CHARS)")
    const view = sources.get("session-timeline-view.tsx")!
    expect(view).toContain("<TimelineMarkdown")
    expect(view).not.toContain(`from "@opencode-ai/session-ui/markdown"`)
  })
})

describe("REQ-125 C5 I5 令牌白名单与运动契约", () => {
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

  test("#861 命令展开体固定为中性面板,恢复强调色用户气泡即失败", () => {
    const bodyRule = css.match(/\.a-tl-cmd-body\s*\{([^}]*)\}/)?.[1] ?? ""
    expect(bodyRule).toContain("border: 1px solid var(--a-border-faint)")
    expect(bodyRule).toContain("background: var(--a-bg-subtle)")
    expect(bodyRule).toContain("color: var(--a-text-secondary)")
    expect(bodyRule).not.toContain("--a-accent")
  })
})

describe("REQ-125 C5 shell 接线(最小增量)", () => {
  test("workspace 把时间线挂进 timeline 宿主(#568:renderer 形态携带 rail api + C7 斜杠真供给),宿主仍是唯一挂载点", () => {
    expect(workspace).toContain(`import { AlphaSessionTimeline } from "../session-timeline/session-timeline"`)
    expect(workspace).toMatch(
      /timeline=\{\(rail\) => \([\s\S]*?<AlphaSessionTimeline[\s\S]*?rail=\{rail\}[\s\S]*?slashOriginsFor=\{sessionSlashOriginsFor\}[\s\S]*?onEditUserMessage=/,
    )
    expect(workspace).toContain(`import { sessionSlashOriginsFor } from "./session-slash-origin"`)
    expect(shell).toContain(`typeof props.timeline === "function" ? props.timeline(rail) : props.timeline`)
    expect(shell.match(/data-alpha-session-timeline-host/g)).toHaveLength(1)
  })

  test("#862 用户脚注保持安静,hover/focus 才显动作；动作样式只用 --a-* token", () => {
    const meta = css.match(/\.a-tl-user-meta \{[^}]*\}/)?.[0] ?? ""
    expect(meta).toContain("opacity: 0")
    expect(css).toMatch(
      /\.a-tl-user:hover \.a-tl-user-meta,[\s\S]*?\.a-tl-user:focus-within \.a-tl-user-meta \{\s*opacity: 1;/,
    )
    const actions = css.match(/\.a-tl-user-actions button \{[^}]*\}/)?.[0] ?? ""
    expect(actions).toContain("width: 22px")
    expect(actions).toContain("height: 22px")
    expect(actions).toContain("background: transparent")
  })
})
