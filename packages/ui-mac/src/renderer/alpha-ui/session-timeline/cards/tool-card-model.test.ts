// REQ-125 C6 — 工具卡纯模型:分派表全类型、四态、有界输出体、未知工具 fail-closed。
import { describe, expect, test } from "bun:test"
import type { ToolPart, ToolState } from "@opencode-ai/sdk/v2/client"
import {
  boundedBlock,
  contextGroupSummaryOf,
  contextRowOf,
  DIAG_FILES_SCAN_MAX,
  DIAG_MAX_ROWS,
  diagnosticsOf,
  extractHttpUrls,
  mediaLabelOf,
  mediaThumbable,
  OPEN_TARGET_MAX_CHARS,
  openTargetOf,
  taskCardInfoOf,
  TOOL_BODY_MAX_CHARS,
  TOOL_BODY_MAX_LINES,
  TOOL_ERROR_MAX_CHARS,
  TOOL_ITEM_MAX_CHARS,
  TOOL_LINKS_MAX,
  TOOL_LIST_MAX_ITEMS,
  TOOL_LIST_SCAN_MAX,
  TOOL_SCAN_MAX_CHARS,
  TOOL_URL_MAX_CHARS,
  TOOL_ERROR_SCAN_MAX_CHARS,
  TOOL_ERROR_TITLE_GATEWAY,
  TOOL_ERROR_TITLE_GENERIC,
  toolCardBodyOf,
  toolCardHeadOf,
  toolCardKindOf,
  toolCardStatusOf,
  toolErrorSummaryOf,
  type ToolCardKind,
} from "./tool-card-model"
import { DIFF_MAX_ROWS, DIFF_PATCH_MAX_CHARS, diffViewOf } from "./tool-diff"

function part(tool: string, state?: Partial<ToolState> & { status?: ToolState["status"] }): ToolPart {
  const base: ToolState =
    state?.status === "pending"
      ? { status: "pending", input: (state.input as Record<string, unknown>) ?? {}, raw: "" }
      : state?.status === "running"
        ? {
            status: "running",
            input: (state.input as Record<string, unknown>) ?? {},
            metadata: (state as { metadata?: Record<string, unknown> }).metadata,
            time: { start: 0 },
          }
        : state?.status === "error"
          ? {
              status: "error",
              input: (state.input as Record<string, unknown>) ?? {},
              error: (state as { error?: string }).error ?? "boom",
              time: { start: 0, end: 1 },
            }
          : {
              status: "completed",
              input: (state?.input as Record<string, unknown>) ?? {},
              output: (state as { output?: string })?.output ?? "",
              title: tool,
              metadata: (state as { metadata?: Record<string, unknown> })?.metadata ?? {},
              time: { start: 0, end: 1 },
            }
  return { id: "prt_1", sessionID: "ses_1", messageID: "msg_1", type: "tool", callID: "call_1", tool, state: base }
}

describe("REQ-125 C6 分派表与四态", () => {
  test("已知工具全类型分派;未知/MCP 工具 fail-closed 落 unknown", () => {
    const table: Record<string, ToolCardKind> = {
      read: "read",
      list: "list",
      glob: "glob",
      grep: "grep",
      webfetch: "webfetch",
      websearch: "websearch",
      bash: "bash",
      edit: "edit",
      write: "write",
      apply_patch: "apply_patch",
      skill: "skill",
      task: "task",
      question: "unknown",
      cloud_await: "unknown",
      "context7_resolve-library-id": "unknown",
      lsp: "unknown",
    }
    Object.entries(table).forEach(([tool, kind]) =>
      expect({ tool, kind: toolCardKindOf(tool) }).toEqual({ tool, kind }),
    )
  })

  test("敌意工具名(原型继承键)不可能命中分派表,一律 fail-closed 落 unknown", () => {
    const hostile = ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "valueOf"]
    hostile.forEach((tool) => expect({ tool, kind: toolCardKindOf(tool) }).toEqual({ tool, kind: "unknown" }))
  })

  test("四态映射:pending/running/error/completed→success", () => {
    expect(toolCardStatusOf(part("bash", { status: "pending" }).state)).toBe("pending")
    expect(toolCardStatusOf(part("bash", { status: "running" }).state)).toBe("running")
    expect(toolCardStatusOf(part("bash", { status: "error" }).state)).toBe("error")
    expect(toolCardStatusOf(part("bash").state)).toBe("success")
  })
})

describe("REQ-125 C6 头部投影(逐分支的数据差异)", () => {
  test("read/edit/write 取文件名与目录;bash 取命令与退出码;grep/glob 取计数", () => {
    const read = toolCardHeadOf(part("read", { status: "completed", input: { filePath: "/a/b/c.py" } }))
    expect([read.titleKey, read.target, read.detail]).toEqual(["alpha.timeline.tool.read", "c.py", "/a/b/"])

    const bash = toolCardHeadOf(
      part("bash", { status: "completed", input: { command: "ls -la" }, metadata: { exit: 0 } }),
    )
    expect([bash.target, bash.exit]).toEqual(["ls -la", 0])

    const grep = toolCardHeadOf(
      part("grep", { status: "completed", input: { pattern: "image", include: "docker*" }, metadata: { matches: 2 } }),
    )
    expect([grep.target, grep.detail, grep.count]).toEqual(["image", "include=docker*", { unit: "matches", value: 2 }])

    const glob = toolCardHeadOf(
      part("glob", { status: "completed", input: { pattern: "**/*.ts" }, metadata: { count: 4 } }),
    )
    expect(glob.count).toEqual({ unit: "files", value: 4 })

    const edit = toolCardHeadOf(
      part("edit", {
        status: "completed",
        input: { filePath: "/tmp/x.txt" },
        metadata: { filediff: { file: "x.txt", patch: "", additions: 1, deletions: 1 } },
      }),
    )
    expect(edit.stat).toEqual({ additions: 1, deletions: 1 })

    const write = toolCardHeadOf(
      part("write", { status: "completed", input: { filePath: "/tmp/y.md", content: "a\nb\nc" } }),
    )
    expect(write.stat).toEqual({ additions: 3, deletions: 0 })

    const websearch = toolCardHeadOf(part("websearch", { status: "completed", input: { query: "solid a11y" } }))
    expect(websearch.target).toBe("solid a11y")

    const webfetch = toolCardHeadOf(part("webfetch", { status: "completed", input: { url: "https://x.dev/a" } }))
    expect(webfetch.target).toBe("https://x.dev/a")

    const unknown = toolCardHeadOf(part("mystery_tool"))
    expect([unknown.kind, unknown.titleKey, unknown.toolName]).toEqual(["unknown", undefined, "mystery_tool"])
  })

  test("恶意/畸形 input 与 metadata 防御读取:非法类型一律忽略", () => {
    const head = toolCardHeadOf(
      part("grep", {
        status: "completed",
        input: { pattern: 42, include: {} },
        metadata: { matches: "many" },
      }),
    )
    expect([head.target, head.detail, head.count]).toEqual([undefined, undefined, undefined])
  })
})

describe("REQ-125 C6 输出体(有界 + 分支)", () => {
  test("bash:运行中吃 metadata.output 流(streaming),完成吃 output 定格", () => {
    const running = toolCardBodyOf(
      part("bash", { status: "running", input: { command: "bun test" }, metadata: { output: "✓ one\n" } }),
    )
    expect(running).toEqual({ type: "term", output: "✓ one\n", truncated: false, streaming: true })

    const done = toolCardBodyOf(part("bash", { status: "completed", output: "app/  docs/", metadata: { exit: 0 } }))
    expect(done).toEqual({ type: "term", output: "app/  docs/", truncated: false, streaming: false })
  })

  test("错误态优先:任何工具的 error 状态 → 有界错误体", () => {
    const body = toolCardBodyOf(part("read", { status: "error", error: "e".repeat(TOOL_ERROR_MAX_CHARS + 10) }))
    if (body.type !== "error") throw new Error("expected error body")
    expect(body.message.length).toBe(TOOL_ERROR_MAX_CHARS)
    expect(body.truncated).toBe(true)
  })

  test("read loaded 文件列表(读取徽章)/ glob 匹配列表 有界;webfetch 无输出体", () => {
    const read = toolCardBodyOf(
      part("read", {
        status: "completed",
        metadata: { loaded: Array.from({ length: TOOL_LIST_MAX_ITEMS + 5 }, (_, i) => `/f${i}`) },
      }),
    )
    if (read.type !== "files") throw new Error("expected files body")
    expect(read.files.length).toBe(TOOL_LIST_MAX_ITEMS)
    expect(read.truncated).toBe(true)
    expect(read.badge).toBe("read")

    const glob = toolCardBodyOf(
      part("glob", { status: "completed", output: "/a/x.ts\n/a/y.ts\n\n(Results are truncated…)" }),
    )
    expect(glob).toEqual({ type: "files", files: ["/a/x.ts", "/a/y.ts"], truncated: false })

    expect(toolCardBodyOf(part("webfetch", { status: "completed", output: "<html>…</html>" }))).toEqual({
      type: "none",
    })
  })

  test("I7 单项帽:read 列表项 / glob 行 / 头部目标 逐项截断,不整串进 DOM", () => {
    const longItem = "/a/" + "x".repeat(TOOL_ITEM_MAX_CHARS * 3)
    const read = toolCardBodyOf(part("read", { status: "completed", metadata: { loaded: [longItem, 42, "/ok"] } }))
    if (read.type !== "files") throw new Error("expected files body")
    expect(read.files.length).toBe(2)
    expect(read.files[0]!.length).toBe(TOOL_ITEM_MAX_CHARS)
    expect(read.files[1]).toBe("/ok")

    const glob = toolCardBodyOf(
      part("glob", { status: "completed", output: `/a/${"y".repeat(TOOL_ITEM_MAX_CHARS * 3)}\n/a/ok.ts` }),
    )
    if (glob.type !== "files") throw new Error("expected files body")
    expect(glob.files[0]!.length).toBeLessThanOrEqual(TOOL_ITEM_MAX_CHARS)
    expect(glob.files[1]).toBe("/a/ok.ts")

    const bash = toolCardHeadOf(
      part("bash", { status: "completed", input: { command: "c".repeat(TOOL_ITEM_MAX_CHARS * 10) } }),
    )
    expect(bash.target!.length).toBe(TOOL_ITEM_MAX_CHARS)
  })

  test("I7 扫描预算:glob 行切与 websearch URL 扫描不吃超预算尾部", () => {
    const glob = toolCardBodyOf(
      part("glob", { status: "completed", output: "x".repeat(TOOL_SCAN_MAX_CHARS) + "\n/tail/after-budget.ts" }),
    )
    if (glob.type !== "files") throw new Error("expected files body")
    expect(glob.truncated).toBe(true)
    expect(glob.files.some((file) => file.includes("after-budget"))).toBe(false)

    const urls = extractHttpUrls("x".repeat(TOOL_SCAN_MAX_CHARS) + " https://late.example/only-after-budget")
    expect(urls).toEqual([])
  })

  test("I6 跨扫描边界的 URL 整条丢弃(可能是半个 URL,fail-closed);边界内完整 URL 保留", () => {
    // URL 起于边界前 30 字符、延伸过边界 → 截串后命中触达边界 → 丢弃。
    const crossing = "x".repeat(TOOL_SCAN_MAX_CHARS - 30) + "https://cut.example/" + "a".repeat(60)
    expect(extractHttpUrls(crossing)).toEqual([])

    // 完整落在预算内(结束于边界之前)且原文更长 → 保留。
    const inside = "x".repeat(TOOL_SCAN_MAX_CHARS - 60) + "https://ok.example/x " + "y".repeat(100)
    expect(extractHttpUrls(inside)).toEqual(["https://ok.example/x"])

    // 恰好整串就是一个 URL 且未被截(原文未超预算)→ 保留。
    expect(extractHttpUrls("https://exact.example/end")).toEqual(["https://exact.example/end"])
  })

  test("I7 迭代预算:50 有效 + 海量非法尾提前终止(项数帽 + 总迭代帽双约束)", () => {
    const valid = Array.from({ length: TOOL_LIST_MAX_ITEMS }, (_, i) => `/f${i}`)
    const hugeInvalidTail = new Array<number>(100_000).fill(0)
    expect(hugeInvalidTail.length).toBeGreaterThan(TOOL_LIST_SCAN_MAX)
    const read = toolCardBodyOf(
      part("read", { status: "completed", metadata: { loaded: [...valid, ...hugeInvalidTail] } }),
    )
    if (read.type !== "files") throw new Error("expected files body")
    expect(read.files.length).toBe(TOOL_LIST_MAX_ITEMS)
    expect(read.truncated).toBe(true)

    // 有效项不足项数帽时,总迭代帽兜底(不全扫非法尾)。
    const sparse = toolCardBodyOf(
      part("read", { status: "completed", metadata: { loaded: ["/only", ...hugeInvalidTail] } }),
    )
    if (sparse.type !== "files") throw new Error("expected files body")
    expect(sparse.files).toEqual(["/only"])
    expect(sparse.truncated).toBe(true)

    // 同类:apply_patch 文件数组的非法尾同样受迭代预算约束。
    const patch = toolCardBodyOf(
      part("apply_patch", {
        status: "completed",
        metadata: { files: [{ relativePath: "a.ts", type: "add", additions: 1, deletions: 0 }, ...hugeInvalidTail] },
      }),
    )
    if (patch.type !== "patch") throw new Error("expected patch body")
    expect(patch.files.map((file) => file.path)).toEqual(["a.ts"])
    expect(patch.truncated).toBe(true)
  })

  test("websearch:只认 http(s) URL,数量有界,超长 URL 丢弃(I6/I7)", () => {
    const urls = Array.from({ length: TOOL_LINKS_MAX + 3 }, (_, i) => `https://site${i}.dev/page`).join("\n")
    const body = toolCardBodyOf(
      part("websearch", { status: "completed", output: `${urls}\njavascript:alert(1)\nfile:///etc/passwd` }),
    )
    if (body.type !== "links") throw new Error("expected links body")
    expect(body.urls.length).toBe(TOOL_LINKS_MAX)
    expect(body.truncated).toBe(true)
    expect(body.urls.every((url) => url.startsWith("https://"))).toBe(true)
    expect(extractHttpUrls("javascript:x data:y vbscript:z")).toEqual([])
    expect(extractHttpUrls(`https://long.example/${"p".repeat(TOOL_URL_MAX_CHARS)}`)).toEqual([])
  })

  test("edit → diff 体;write → 徽章路径 + 前 2 行预览 + 总行数;apply_patch → 徽章文件行", () => {
    const edit = toolCardBodyOf(
      part("edit", { status: "completed", metadata: { diff: "--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n" } }),
    )
    expect(edit.type).toBe("diff")

    const write = toolCardBodyOf(
      part("write", { status: "completed", input: { filePath: "/t/a.md", content: "l1\nl2\nl3\nl4" } }),
    )
    expect(write).toEqual({ type: "write", path: "/t/a.md", preview: ["l1", "l2"], totalLines: 4, approx: false })

    const patch = toolCardBodyOf(
      part("apply_patch", {
        status: "completed",
        metadata: {
          files: [
            { relativePath: "src/main/proxy.ts", type: "add", additions: 30, deletions: 0 },
            { relativePath: "src/main/ipc.ts", type: "update", additions: 14, deletions: 2 },
            { relativePath: "src/main/legacy.ts", type: "delete", additions: 0, deletions: 10 },
            { relativePath: "src/main/util.ts", type: "move", additions: 0, deletions: 0 },
            { relativePath: "bad", type: "explode", additions: 0, deletions: 0 },
          ],
        },
      }),
    )
    if (patch.type !== "patch") throw new Error("expected patch body")
    expect(patch.files.map((file) => file.badge)).toEqual(["add", "modify", "delete", "move"])
  })

  test("apply_patch 敌意 type(原型键)不产原型徽章,行被丢弃(fail-closed)", () => {
    const patch = toolCardBodyOf(
      part("apply_patch", {
        status: "completed",
        metadata: {
          files: [
            { relativePath: "a.ts", type: "__proto__", additions: 1, deletions: 0 },
            { relativePath: "b.ts", type: "constructor", additions: 1, deletions: 0 },
            { relativePath: "c.ts", type: "add", additions: 1, deletions: 0 },
          ],
        },
      }),
    )
    if (patch.type !== "patch") throw new Error("expected patch body")
    expect(patch.files.map((file) => [file.path, file.badge])).toEqual([["c.ts", "add"]])
  })

  test("I7 write:超扫描预算 → 总行数 approx、头部统计徽标诚实缺席", () => {
    const big = "line\n".repeat(TOOL_SCAN_MAX_CHARS / 4)
    const body = toolCardBodyOf(part("write", { status: "completed", input: { filePath: "/t/big.md", content: big } }))
    if (body.type !== "write") throw new Error("expected write body")
    expect(body.approx).toBe(true)
    expect(body.preview).toEqual(["line", "line"])

    const head = toolCardHeadOf(part("write", { status: "completed", input: { filePath: "/t/big.md", content: big } }))
    expect(head.stat).toBeUndefined()

    const small = toolCardHeadOf(
      part("write", { status: "completed", input: { filePath: "/t/a.md", content: "a\nb" } }),
    )
    expect(small.stat).toEqual({ additions: 2, deletions: 0 })
  })

  test("未知工具 fail-closed:有界纯文本通用卡,超限截断", () => {
    const body = toolCardBodyOf(
      part("mystery_tool", { status: "completed", output: "x".repeat(TOOL_BODY_MAX_CHARS + 100) }),
    )
    if (body.type !== "text") throw new Error("expected text body")
    expect(body.text.length).toBe(TOOL_BODY_MAX_CHARS)
    expect(body.truncated).toBe(true)
  })

  test("boundedBlock 行数帽:超行截断并标记", () => {
    const many = Array.from({ length: TOOL_BODY_MAX_LINES + 20 }, (_, i) => `line${i}`).join("\n")
    const block = boundedBlock(many)
    expect(block.truncated).toBe(true)
    expect(block.text.split("\n").length).toBeLessThanOrEqual(TOOL_BODY_MAX_LINES)
  })
})

describe("REQ-125 C6 diff 视图(jsdiff 白名单通道,有界)", () => {
  const patch = ["--- a/x.txt", "+++ b/x.txt", "@@ -1,2 +1,2 @@", " ctx", "-old", "+new", ""].join("\n")

  test("解析出 add/del/context 行与行号", () => {
    const view = diffViewOf(patch)
    expect(view.unavailable).toBe(false)
    expect(view.rows.map((row) => row.kind)).toEqual(["context", "del", "add"])
    expect(view.rows[1]).toMatchObject({ kind: "del", oldLine: 2, text: "old" })
    expect(view.rows[2]).toMatchObject({ kind: "add", newLine: 2, text: "new" })
  })

  test("超限补丁不进解析器;行数硬帽截断", () => {
    expect(diffViewOf("x".repeat(DIFF_PATCH_MAX_CHARS + 1)).unavailable).toBe(true)
    expect(diffViewOf("not a patch at all").rows).toEqual([])

    const bigLines = Array.from({ length: DIFF_MAX_ROWS + 40 }, (_, i) => `+l${i}`).join("\n")
    const big = diffViewOf(`--- a/x\n+++ b/x\n@@ -0,0 +1,${DIFF_MAX_ROWS + 40} @@\n${bigLines}\n`)
    expect(big.truncated).toBe(true)
    expect(big.rows.length).toBe(DIFF_MAX_ROWS)
  })
})

describe("REQ-125 C6 task/skill/折叠组/媒体辅助", () => {
  test("task 信息:agent/description/子会话/背景标记(防御读取)", () => {
    const info = taskCardInfoOf(
      part("task", {
        status: "running",
        input: { description: "校验 AGENTS.md", subagent_type: "general" },
        metadata: { sessionId: "ses_child", parentSessionId: "ses_1", background: true },
      }),
    )
    expect(info).toEqual({
      description: "校验 AGENTS.md",
      agent: "general",
      childSessionID: "ses_child",
      background: true,
    })
    expect(taskCardInfoOf(part("task"))).toEqual({
      description: undefined,
      agent: undefined,
      childSessionID: undefined,
      background: false,
    })
  })

  test("折叠组行与计数摘要", () => {
    const parts = [
      part("read", { status: "completed", input: { filePath: "/a/README.md", limit: 30 } }),
      part("grep", { status: "completed", input: { pattern: "image" } }),
      part("list", { status: "completed", input: { path: "/a" } }),
    ]
    expect(contextGroupSummaryOf(parts)).toEqual({ reads: 1, searches: 1, lists: 1 })
    expect(contextRowOf(parts[0]!)).toEqual({
      tool: "read",
      titleKey: "alpha.timeline.tool.read",
      target: "README.md",
      args: ["limit=30"],
    })
    expect(contextRowOf(parts[1]!)).toMatchObject({ target: "image", args: [] })
  })

  test("媒体行:仅受限 data:image 内联缩略;标签由 mime/文件名导出", () => {
    expect(mediaThumbable("data:image/png;base64,xxx")).toBe(true)
    expect(mediaThumbable("https://evil.example/x.png")).toBe(false)
    expect(mediaThumbable(`data:image/png;base64,${"x".repeat(2_000_001)}`)).toBe(false)
    expect(mediaLabelOf("image/png", "shot.png")).toBe("PNG")
    expect(mediaLabelOf("application/pdf", "doc.pdf")).toBe("PDF")
    expect(mediaLabelOf("application/octet-stream", "data.parquet")).toBe("PARQUET")
    expect(mediaLabelOf("application/octet-stream", "noext")).toBe("FILE")
  })
})

// ═══════════════ #568 — 「在面板打开」目标 / 诊断行(T19) ═══════════════

describe("#568 openTargetOf(T8 pill 目标)", () => {
  test("write/edit 返回原始 filePath;其余工具/非法路径 fail-closed", () => {
    expect(openTargetOf(part("write", { input: { filePath: "/repo/AGENTS.md" } }))).toBe("/repo/AGENTS.md")
    expect(openTargetOf(part("edit", { input: { filePath: "/tmp/x.txt" } }))).toBe("/tmp/x.txt")
    expect(openTargetOf(part("read", { input: { filePath: "/repo/AGENTS.md" } }))).toBeUndefined()
    expect(openTargetOf(part("write", { input: {} }))).toBeUndefined()
    expect(openTargetOf(part("write", { input: { filePath: 42 } }))).toBeUndefined()
    expect(openTargetOf(part("write", { input: { filePath: "x".repeat(OPEN_TARGET_MAX_CHARS + 1) } }))).toBeUndefined()
  })
})

describe("#568 diagnosticsOf(T19 诊断行)", () => {
  const issue = (severity: number, line: number, message: string) => ({
    severity,
    message,
    range: { start: { line, character: 4 }, end: { line, character: 9 } },
  })

  test("只取本卡文件的 ERROR 级;行号 1 基;其他文件与低级别忽略", () => {
    const result = diagnosticsOf(
      part("edit", {
        input: { filePath: "/repo/app/prompt_builder.py" },
        metadata: {
          diagnostics: {
            "/repo/app/prompt_builder.py": [issue(1, 101, '"kama_latest" is possibly unbound'), issue(2, 5, "warn")],
            "/repo/other.py": [issue(1, 1, "elsewhere")],
          },
        },
      }),
    )
    expect(result.rows).toEqual([
      { file: "prompt_builder.py", line: 102, message: '"kama_latest" is possibly unbound' },
    ])
    expect(result.truncated).toBe(false)
  })

  test("条数帽 + 截断标记;非法形状 fail-closed 为空", () => {
    const many = Array.from({ length: DIAG_MAX_ROWS + 4 }, (_, index) => issue(1, index, `e${index}`))
    const capped = diagnosticsOf(
      part("write", { input: { filePath: "/a/b.ts" }, metadata: { diagnostics: { "/a/b.ts": many } } }),
    )
    expect(capped.rows).toHaveLength(DIAG_MAX_ROWS)
    expect(capped.truncated).toBe(true)

    expect(diagnosticsOf(part("bash", { metadata: { diagnostics: { x: [issue(1, 1, "m")] } } })).rows).toEqual([])
    expect(diagnosticsOf(part("edit", { input: { filePath: "/a.ts" }, metadata: {} })).rows).toEqual([])
    expect(
      diagnosticsOf(part("edit", { input: { filePath: "/a.ts" }, metadata: { diagnostics: "junk" } })).rows,
    ).toEqual([])
    expect(
      diagnosticsOf(part("edit", { input: { filePath: "/a.ts" }, metadata: { diagnostics: { "/a.ts": "junk" } } }))
        .rows,
    ).toEqual([])
    expect(
      diagnosticsOf(
        part("edit", {
          input: { filePath: "/a.ts" },
          metadata: { diagnostics: { "/a.ts": [null, { severity: 1 }, { severity: 1, message: 42 }] } },
        }),
      ).rows,
    ).toEqual([])
    // 运行中(未完成)不出诊断行。
    expect(
      diagnosticsOf(part("edit", { status: "running", input: { filePath: "/a.ts" } })).rows,
    ).toEqual([])
  })

  test("Windows 分隔符归一后仍能对上本卡文件;缺 range 行号诚实缺席", () => {
    const result = diagnosticsOf(
      part("edit", {
        input: { filePath: "C:\\repo\\x.ts" },
        metadata: { diagnostics: { "C:/repo/x.ts": [{ severity: 1, message: "broken" }] } },
      }),
    )
    expect(result.rows).toEqual([{ file: "x.ts", line: undefined, message: "broken" }])
  })
})

describe("#568 审计修复:diagnostics 外层文件数扫描预算(Major-3)", () => {
  const issue = { severity: 1, message: "boom", range: { start: { line: 0, character: 0 } } }

  test("万文件诊断映射:需归一匹配的键落在预算外 → 提前终止,零渲染", () => {
    const map: Record<string, unknown> = {}
    for (let index = 0; index < 10_000; index += 1) map[`/proj/f${index}.ts`] = [issue]
    expect(10_000).toBeGreaterThan(DIAG_FILES_SCAN_MAX)
    // 目标键需要 \\→/ 归一才能命中,且按插入序落在 DIAG_FILES_SCAN_MAX 之外。
    map["C:/ws/target.ts"] = [issue]
    const result = diagnosticsOf(
      part("edit", { input: { filePath: "C:\\ws\\target.ts" }, metadata: { diagnostics: map } }),
    )
    expect(result.rows).toEqual([])
  })

  test("精确键命中走 O(1) 快路,不受外层预算影响;预算内的归一匹配仍工作", () => {
    const map: Record<string, unknown> = {}
    for (let index = 0; index < 10_000; index += 1) map[`/proj/f${index}.ts`] = [issue]
    map["/ws/exact.ts"] = [issue]
    const exact = diagnosticsOf(part("edit", { input: { filePath: "/ws/exact.ts" }, metadata: { diagnostics: map } }))
    expect(exact.rows).toHaveLength(1)

    const small: Record<string, unknown> = { "C:/ws/win.ts": [issue] }
    const normalized = diagnosticsOf(
      part("write", { input: { filePath: "C:\\ws\\win.ts" }, metadata: { diagnostics: small } }),
    )
    expect(normalized.rows).toHaveLength(1)
  })
})

describe("#590 工具级错误卡标题行(toolErrorSummaryOf)", () => {
  test("网关语境 + 标准原因短语 → 「模型网关错误」+ 代码副标(CT #tools G4 帧口径)", () => {
    expect(toolErrorSummaryOf('{"detail":"Not Found"} — 代理 baseURL 或模型 ID 不存在')).toEqual({
      titleKey: TOOL_ERROR_TITLE_GATEWAY,
      code: "404 · Not Found",
    })
  })

  test("独立状态码优先于原因短语;粘连片段(v1.404 / x429)不算状态码", () => {
    expect(toolErrorSummaryOf("api error: HTTP 429 rate limited")).toEqual({
      titleKey: TOOL_ERROR_TITLE_GATEWAY,
      code: "429 · Too Many Requests",
    })
    // 粘连数字不认;短语也没有 → 只给类别标题,不编造代码。
    expect(toolErrorSummaryOf("api call failed at proxy v1.404/x429")).toEqual({
      titleKey: TOOL_ERROR_TITLE_GATEWAY,
    })
  })

  test("表外状态码不猜原因;非网关语境一律退回通用标题(command not found 不误判成 404)", () => {
    expect(toolErrorSummaryOf("gateway responded 418 teapot")).toEqual({ titleKey: TOOL_ERROR_TITLE_GATEWAY })
    expect(toolErrorSummaryOf("bash: alphacli: command not found")).toEqual({ titleKey: TOOL_ERROR_TITLE_GENERIC })
    expect(toolErrorSummaryOf("ENOTREACHABLE")).toEqual({ titleKey: TOOL_ERROR_TITLE_GENERIC })
    expect(toolErrorSummaryOf("")).toEqual({ titleKey: TOOL_ERROR_TITLE_GENERIC })
  })

  test("分类只扫开头一段:预算之外的网关线索不参与判定(I7)", () => {
    const far = `${"x".repeat(TOOL_ERROR_SCAN_MAX_CHARS)} http 503 Service Unavailable`
    expect(toolErrorSummaryOf(far)).toEqual({ titleKey: TOOL_ERROR_TITLE_GENERIC })
  })
})
