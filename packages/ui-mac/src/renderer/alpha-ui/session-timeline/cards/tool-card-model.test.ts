// REQ-125 C6 / #879 — 工具卡纯模型:identity 分派、四态、有界输出体、redactor 接线。
// T1/T2/T5/T6/T7 的 mutation/negative gates 在 tool-card-provenance-gates.test.ts。
import { describe, expect, test } from "bun:test"
import type { ToolDisplaySnapshotV1, ToolPart, ToolState } from "@opencode-ai/sdk/v2/client"
import {
  boundedBlock,
  contextGroupSummaryOf,
  contextRowOf,
  DIAG_FILES_SCAN_MAX,
  DIAG_MAX_ROWS,
  diagnosticsOf,
  extractHttpUrls,
  hitSpansOf,
  mediaLabelOf,
  mediaThumbable,
  OPEN_TARGET_MAX_CHARS,
  openTargetOf,
  taskCardInfoOf,
  TOOL_BODY_MAX_LINES,
  TOOL_ERROR_MAX_CHARS,
  TOOL_ITEM_MAX_CHARS,
  TOOL_LINKS_MAX,
  TOOL_LIST_MAX_ITEMS,
  TOOL_LIST_SCAN_MAX,
  TOOL_SCAN_MAX_CHARS,
  TOOL_URL_MAX_CHARS,
  toolCardBodyOf,
  toolCardDispatchOf,
  toolCardHeadOf,
  toolCardStatusOf,
  type ToolCardKind,
} from "./tool-card-model"
import { DIFF_MAX_ROWS, DIFF_PATCH_MAX_CHARS, diffViewOf } from "./tool-diff"

/** builtin 快照(#878 铸造形状):identity 驱动分派的默认正向夹具。 */
function builtinDisplay(name: string): ToolDisplaySnapshotV1 {
  return {
    identity: { source: "builtin", origin: "", name },
    technicalId: name,
    authority: { kind: "not-asserted" },
  }
}

function part(
  tool: string,
  state?: Partial<ToolState> & { status?: ToolState["status"] },
  display?: ToolDisplaySnapshotV1 | null,
): ToolPart {
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
  return {
    id: "prt_1",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "tool",
    callID: "call_1",
    tool,
    display: display === null ? undefined : (display ?? builtinDisplay(tool)),
    state: base,
  }
}

describe("REQ-125 C6/#879 identity 分派与四态", () => {
  test("builtin identity 全类型分派;无规则 builtin 与快照缺失一律 metadata-only", () => {
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
    }
    Object.entries(table).forEach(([tool, kind]) => {
      const dispatch = toolCardDispatchOf(part(tool))
      expect({ tool, kind: dispatch.kind, metadataOnly: dispatch.metadataOnly }).toEqual({
        tool,
        kind,
        metadataOnly: false,
      })
    })
    // 无宿主规则的 builtin(question/todowrite/lsp)→ metadata-only,分类仍是 builtin。
    for (const name of ["question", "todowrite", "lsp"]) {
      const dispatch = toolCardDispatchOf(part(name))
      expect({ name, kind: dispatch.kind, metadataOnly: dispatch.metadataOnly, category: dispatch.category }).toEqual({
        name,
        kind: "unknown",
        metadataOnly: true,
        category: "builtin",
      })
    }
    // 快照缺失(历史行 / 引擎未铸造)→ 未知来源。
    const missing = toolCardDispatchOf(part("cloud_await", undefined, null))
    expect([missing.kind, missing.metadataOnly, missing.category]).toEqual(["unknown", true, "unknown"])
  })

  test("敌意工具名(原型继承键)不可能命中规则表,一律 metadata-only", () => {
    const hostile = ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "valueOf"]
    hostile.forEach((name) => {
      expect({ name, viaIdentity: toolCardDispatchOf(part(name)).kind }).toEqual({ name, viaIdentity: "unknown" })
      expect({ name, viaMissing: toolCardDispatchOf(part(name, undefined, null)).kind }).toEqual({
        name,
        viaMissing: "unknown",
      })
    })
  })

  test("mcp identity 按 authority 分类:alpha-cloud 徽标只认持久化证明", () => {
    const thirdParty = toolCardDispatchOf(
      part("srv_search", undefined, {
        identity: { source: "mcp", origin: "srv", name: "search" },
        technicalId: "srv_search",
        authority: { kind: "not-asserted" },
      }),
    )
    expect([thirdParty.category, thirdParty.metadataOnly, thirdParty.origin]).toEqual(["mcp", true, "srv"])

    const cloud = toolCardDispatchOf(
      part("cloud_web_search", undefined, {
        identity: { source: "mcp", origin: "alpha-cloud", name: "web_search" },
        technicalId: "cloud_web_search",
        authority: { kind: "alpha-cloud", bindingId: "mcp:alpha-cloud", evidenceDigest: `sha256:${"a".repeat(64)}` },
      }),
    )
    expect([cloud.category, cloud.metadataOnly]).toEqual(["alpha-cloud", true])
  })

  test("名称是远端输入:控制字符与双向覆盖字符被剥离,超长截断", () => {
    const dispatch = toolCardDispatchOf(
      part("evil", undefined, {
        identity: { source: "plugin", origin: "pkg", name: "safe\u202egnp.exe\u0007" + "n".repeat(600) },
        technicalId: "evil",
        authority: { kind: "not-asserted" },
      }),
    )
    expect(dispatch.name.includes("\u202e")).toBe(false)
    expect(dispatch.name.includes("\u0007")).toBe(false)
    expect(dispatch.name.length).toBeLessThanOrEqual(TOOL_ITEM_MAX_CHARS)
    expect(dispatch.name.startsWith("safegnp.exe")).toBe(true)
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

    const unknown = toolCardHeadOf(part("mystery_tool", undefined, null))
    expect([unknown.kind, unknown.titleKey, unknown.toolName, unknown.metadataOnly]).toEqual([
      "unknown",
      undefined,
      "mystery_tool",
      true,
    ])
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

  test("I7+AC5 超长单 token 目标:无安全切点 → 整字段隐藏(targetHidden),不显示半截", () => {
    const bash = toolCardHeadOf(
      part("bash", { status: "completed", input: { command: "c".repeat(TOOL_ITEM_MAX_CHARS * 10) } }),
    )
    expect([bash.target, bash.targetHidden]).toEqual([undefined, true])

    // 有空白边界的超长命令:在安全切点截断,前缀仍可见。
    const spaced = toolCardHeadOf(
      part("bash", { status: "completed", input: { command: `ls -la ${"/deep/dir ".repeat(200)}` } }),
    )
    expect(spaced.targetHidden).toBeUndefined()
    expect(spaced.target!.startsWith("ls -la")).toBe(true)
    expect(spaced.target!.length).toBeLessThanOrEqual(TOOL_ITEM_MAX_CHARS)
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

  test("错误态优先(matched 卡):有界错误体,截断回退到安全切点", () => {
    const body = toolCardBodyOf(
      part("read", { status: "error", error: "err ".repeat(TOOL_ERROR_MAX_CHARS / 2) }),
    )
    if (body.type !== "error") throw new Error("expected error body")
    expect(body.truncated).toBe(true)
    expect(body.message.length).toBeLessThanOrEqual(TOOL_ERROR_MAX_CHARS)
    expect(body.message.length).toBeGreaterThan(TOOL_ERROR_MAX_CHARS - 8)
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

  test("I7 单项帽:read 列表项 / glob 行 逐项截断,不整串进 DOM", () => {
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
    const crossing = "x".repeat(TOOL_SCAN_MAX_CHARS - 30) + "https://cut.example/" + "a".repeat(60)
    expect(extractHttpUrls(crossing)).toEqual([])

    const inside = "x".repeat(TOOL_SCAN_MAX_CHARS - 60) + "https://ok.example/x " + "y".repeat(100)
    expect(extractHttpUrls(inside)).toEqual(["https://ok.example/x"])

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

    const sparse = toolCardBodyOf(
      part("read", { status: "completed", metadata: { loaded: ["/only", ...hugeInvalidTail] } }),
    )
    if (sparse.type !== "files") throw new Error("expected files body")
    expect(sparse.files).toEqual(["/only"])
    expect(sparse.truncated).toBe(true)

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
    expect(body.links.length).toBe(TOOL_LINKS_MAX)
    expect(body.truncated).toBe(true)
    expect(body.links.every((link) => link.href.startsWith("https://"))).toBe(true)
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

  test("AC2 快照缺失的完成态输出不再有任何 body(旧「未知工具纯文本体」已删除)", () => {
    const body = toolCardBodyOf(
      part("mystery_tool", { status: "completed", output: "leaky raw output 4f2c" }, null),
    )
    expect(body).toEqual({ type: "none" })
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
    // #879:identity 不是 task 的调用,不产 task 信息(冒名 task 无子会话入口)。
    expect(
      taskCardInfoOf(
        part(
          "task",
          { status: "running", input: { description: "x" }, metadata: { sessionId: "ses_fake" } },
          {
            identity: { source: "plugin", origin: "evil", name: "task" },
            technicalId: "task",
            authority: { kind: "not-asserted" },
          },
        ),
      ),
    ).toEqual({ background: false })
  })

  test("折叠组行与计数摘要", () => {
    const parts = [
      part("read", { status: "completed", input: { filePath: "/a/README.md", limit: 30 } }),
      part("grep", { status: "completed", input: { pattern: "image" } }),
      part("list", { status: "completed", input: { path: "/a" } }),
    ]
    expect(contextGroupSummaryOf(parts)).toEqual({ reads: 1, searches: 1, lists: 1 })
    expect(contextRowOf(parts[0]!)).toEqual({
      kind: "read",
      tool: "read",
      titleKey: "alpha.timeline.tool.read",
      target: "README.md",
      args: ["limit=30"],
    })
    expect(contextRowOf(parts[1]!)).toMatchObject({ target: "image", args: [] })
    // 冒名 read(plugin identity)不计入摘要、行内无目标。
    const impostor = part(
      "read",
      { status: "completed", input: { filePath: "/Users/eve/private-notes.md" } },
      {
        identity: { source: "plugin", origin: "pkg", name: "read" },
        technicalId: "read",
        authority: { kind: "not-asserted" },
      },
    )
    expect(contextGroupSummaryOf([impostor])).toEqual({ reads: 0, searches: 0, lists: 0 })
    expect(contextRowOf(impostor)).toEqual({ kind: "unknown", tool: "read", args: [] })
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
  test("write/edit 返回原始 filePath;其余工具/非法路径/冒名 identity fail-closed", () => {
    expect(openTargetOf(part("write", { input: { filePath: "/repo/AGENTS.md" } }))).toBe("/repo/AGENTS.md")
    expect(openTargetOf(part("edit", { input: { filePath: "/tmp/x.txt" } }))).toBe("/tmp/x.txt")
    expect(openTargetOf(part("read", { input: { filePath: "/repo/AGENTS.md" } }))).toBeUndefined()
    expect(openTargetOf(part("write", { input: {} }))).toBeUndefined()
    expect(openTargetOf(part("write", { input: { filePath: 42 } }))).toBeUndefined()
    expect(openTargetOf(part("write", { input: { filePath: "x".repeat(OPEN_TARGET_MAX_CHARS + 1) } }))).toBeUndefined()
    // #879:plugin 冒名 write 不产 pill(identity 分派不是别名分派)。
    expect(
      openTargetOf(
        part(
          "write",
          { input: { filePath: "/repo/AGENTS.md" } },
          {
            identity: { source: "plugin", origin: "pkg", name: "write" },
            technicalId: "write",
            authority: { kind: "not-asserted" },
          },
        ),
      ),
    ).toBeUndefined()
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

describe("#583 list 目录网格模型(G6:目录/文件分类 + 计数 + 有界)", () => {
  test("条目按尾随 / 分类;注记行不算条目;头部完成态出「共 N 项」计数", () => {
    const output = ".claude/\napp/\ndocs/\ndocker-compose.yml\npyproject.toml\nREADME.md\n\n(6 entries)"
    const body = toolCardBodyOf(part("list", { status: "completed", input: { path: "/w/demo" }, output }))
    if (body.type !== "dir") throw new Error("expected dir body")
    expect(body.entries).toEqual([
      { name: ".claude", dir: true },
      { name: "app", dir: true },
      { name: "docs", dir: true },
      { name: "docker-compose.yml", dir: false },
      { name: "pyproject.toml", dir: false },
      { name: "README.md", dir: false },
    ])
    expect(body.truncated).toBe(false)

    const head = toolCardHeadOf(part("list", { status: "completed", input: { path: "/w/demo" }, output }))
    expect(head.count).toEqual({ unit: "items", value: 6 })
  })

  test("home 前缀路径折叠为 ~(基线:不显示带用户名的 home 前缀);脱敏失败项丢弃并标记截断", () => {
    const head = toolCardHeadOf(
      part("list", { status: "completed", input: { path: "/Users/kai/app/kama-bot-local" }, output: "src/\n" }),
    )
    expect(head.target).toBe("~/app/kama-bot-local")
    expect(head.target).not.toContain("/Users/")

    // 控制字符条目 redactPath 失败 → 整项丢弃 + truncated;计数诚实缺席(不低报总量)。
    const withBad = "ok.txt\nbad\u0007name\nzz/"
    const bad = toolCardBodyOf(part("list", { status: "completed", input: { path: "/w" }, output: withBad }))
    if (bad.type !== "dir") throw new Error("expected dir body")
    expect(bad.entries).toEqual([
      { name: "ok.txt", dir: false },
      { name: "zz", dir: true },
    ])
    expect(bad.truncated).toBe(true)
    const badHead = toolCardHeadOf(part("list", { status: "completed", input: { path: "/w" }, output: withBad }))
    expect(badHead.count).toBeUndefined()
  })

  test("引擎「(Showing X of Y entries…)」注记 = 截断;项数帽有界(I7)", () => {
    const truncatedByEngine = toolCardBodyOf(
      part("list", { status: "completed", input: { path: "/w" }, output: "a/\nb.txt\n(Showing 2 of 40 entries. …)" }),
    )
    if (truncatedByEngine.type !== "dir") throw new Error("expected dir body")
    expect(truncatedByEngine.entries).toHaveLength(2)
    expect(truncatedByEngine.truncated).toBe(true)

    const flood = Array.from({ length: TOOL_LIST_MAX_ITEMS + 9 }, (_, i) => `f${i}.ts`).join("\n")
    const capped = toolCardBodyOf(part("list", { status: "completed", input: { path: "/w" }, output: flood }))
    if (capped.type !== "dir") throw new Error("expected dir body")
    expect(capped.entries).toHaveLength(TOOL_LIST_MAX_ITEMS)
    expect(capped.truncated).toBe(true)
  })
})

describe("#584 grep 命中高亮模型(G7:文件/行号结构化 + 字面量高亮 + 失败整字段隐藏)", () => {
  test("引擎行文法解析:header 跳过、文件行脱敏分组、匹配行带行号与命中 span", () => {
    const output = [
      "Found 3 matches",
      "",
      "/Users/kai/proj/docker-compose.yml:",
      "  Line 6: redis image: redis:7.4-alpine",
      "  Line 21: postgres image: postgres:16-alpine",
      "",
      "/Users/kai/proj/Makefile:",
      "  Line 2: build-image: docker build .",
    ].join("\n")
    const body = toolCardBodyOf(
      part("grep", { status: "completed", input: { pattern: "image" }, metadata: { matches: 3 }, output }),
    )
    if (body.type !== "grep") throw new Error("expected grep body")
    expect(body.rows[0]).toEqual({ kind: "file", path: "~/proj/docker-compose.yml" })
    const first = body.rows[1]
    if (first === undefined || first.kind !== "match") throw new Error("expected match row")
    expect(first.line).toBe(6)
    expect(first.spans).toEqual([
      { text: "redis ", hit: false },
      { text: "image", hit: true },
      { text: ": redis:7.4-alpine", hit: false },
    ])
    expect(body.rows[3]).toEqual({ kind: "file", path: "~/proj/Makefile" })
    const last = body.rows[4]
    if (last === undefined || last.kind !== "match") throw new Error("expected match row")
    expect(last.spans.filter((span) => span.hit)).toEqual([{ text: "image", hit: true }])
    expect(body.truncated).toBe(false)
  })

  test("pattern 绝不当正则执行:正则形态字面量匹配不上就诚实不高亮;摘录里的 secret 已被替换", () => {
    // 正则元字符 pattern:字面量搜索找不到 → 单 span 无高亮(不执行不可信正则)。
    expect(hitSpansOf("redis image: redis", "(image|img)+")).toEqual([{ text: "redis image: redis", hit: false }])
    // 摘录先过共享 redactor:secret 赋值 span 已替换,高亮扫描只看展示文本。
    const body = toolCardBodyOf(
      part("grep", {
        status: "completed",
        input: { pattern: "deploy_key" },
        output: "Found 1 matches\n\n/w/ci.env:\n  Line 4: deploy_key=sk-abcdefghijklmnop1234",
      }),
    )
    if (body.type !== "grep") throw new Error("expected grep body")
    const row = body.rows[1]
    if (row === undefined || row.kind !== "match") throw new Error("expected match row")
    const shown = row.spans.map((span) => span.text).join("")
    expect(shown).not.toContain("sk-abcdefghijklmnop1234")
    expect(shown).toContain("[已隐藏]")
  })

  test("路径 redactor 失败 ⇒ 整字段隐藏(不逐项降级);未识别行整行丢弃并标记截断", () => {
    const overlong = `/w/${"a".repeat(1_100)}/hit.ts`
    const hidden = toolCardBodyOf(
      part("grep", {
        status: "completed",
        input: { pattern: "x" },
        output: `Found 1 matches\n\n${overlong}:\n  Line 3: x = 1`,
      }),
    )
    expect(hidden).toEqual({ type: "hidden" })

    const stray = toolCardBodyOf(
      part("grep", {
        status: "completed",
        input: { pattern: "x" },
        output: "Found 1 matches\n\n/w/ok.ts:\n  Line 1: x = 2\nstray unformatted output",
      }),
    )
    if (stray.type !== "grep") throw new Error("expected grep body")
    expect(stray.rows).toHaveLength(2)
    expect(stray.truncated).toBe(true)
  })

  test("超长无空白匹配行(minify/base64)被截成空 ⇒ 该行缺席且整体标记截断,不渲染空命中", () => {
    // safeTruncate 对无空白行回退整个 lookback 窗口 ⇒ 空串;旧行为渲染出「:7」空行且不标截断。
    const minified = `export_const_config={api:{bodyParser:false}};${"z".repeat(430)}`
    const body = toolCardBodyOf(
      part("grep", {
        status: "completed",
        input: { pattern: "bodyParser" },
        output: `Found 1 matches\n\n/w/dist/bundle.min.js:\n  Line 7: ${minified}`,
      }),
    )
    if (body.type !== "grep") throw new Error("expected grep body")
    expect(body.rows.filter((row) => row.kind === "match")).toHaveLength(0)
    expect(body.rows).toHaveLength(1)
    expect(body.truncated).toBe(true)
  })

  test("超长但有空白的匹配行:保留截断前缀并标记截断(诚实截断,不静默丢尾)", () => {
    const spaced = `retryBudget exceeded ${"backoff wait ".repeat(40)}`
    const body = toolCardBodyOf(
      part("grep", {
        status: "completed",
        input: { pattern: "retryBudget" },
        output: `Found 1 matches\n\n/w/svc/queue.ts:\n  Line 12: ${spaced}`,
      }),
    )
    if (body.type !== "grep") throw new Error("expected grep body")
    const row = body.rows[1]
    if (row === undefined || row.kind !== "match") throw new Error("expected match row")
    expect(row.spans).toContainEqual({ text: "retryBudget", hit: true })
    const shown = row.spans.map((span) => span.text).join("")
    expect(shown.length).toBeLessThanOrEqual(TOOL_ITEM_MAX_CHARS)
    expect(shown.length).toBeLessThan(spaced.length)
    expect(body.truncated).toBe(true)
  })
})

describe("#586 websearch 富链接模型(G17:结构化标题 allowlist + 字母徽/域名导出 + 结果数)", () => {
  test("结构化 results 出「宿主允许的标题」;host/字母徽从清洗后 URL 导出;头部出结果数", () => {
    const output = JSON.stringify({
      results: [
        { title: "aria-busy & loading buttons", url: "https://www.w3.org/WAI/tutorials/?utm=x#top" },
        { title: "SolidJS Suspense & pending UI", url: "https://docs.solidjs.com/guides/suspense" },
        { url: "https://untitled.example.io/post" },
      ],
    })
    const body = toolCardBodyOf(part("websearch", { status: "completed", input: { query: "solid a11y" }, output }))
    if (body.type !== "links") throw new Error("expected links body")
    expect(body.links).toEqual([
      // query/fragment 已清洗;www. 前缀不进展示 host;字母徽 = host 首字符。
      { href: "https://www.w3.org/WAI/tutorials/", host: "w3.org", letter: "W", title: "aria-busy & loading buttons" },
      {
        href: "https://docs.solidjs.com/guides/suspense",
        host: "docs.solidjs.com",
        letter: "D",
        title: "SolidJS Suspense & pending UI",
      },
      // title 缺席的结构化行:无标题字段,不编造。
      { href: "https://untitled.example.io/post", host: "untitled.example.io", letter: "U" },
    ])
    expect(body.truncated).toBe(false)

    const head = toolCardHeadOf(part("websearch", { status: "completed", input: { query: "solid a11y" }, output }))
    expect(head.count).toEqual({ unit: "results", value: 3 })
    expect(head.target).toBe("solid a11y")
  })

  test("自由文本兜底:只捞裸 URL,永无标题;URL 仍逐条过 redactUrl(userinfo/query 不落 DOM)", () => {
    const body = toolCardBodyOf(
      part("websearch", {
        status: "completed",
        input: { query: "docs" },
        output: "见 https://res.example.net/guide?apikey=ak_88yy 与 https://bob:pw456@mirror.example.org/dl",
      }),
    )
    if (body.type !== "links") throw new Error("expected links body")
    expect(body.links.map((link) => [link.href, link.host, link.letter, link.title])).toEqual([
      ["https://res.example.net/guide", "res.example.net", "R", undefined],
      ["https://mirror.example.org/dl", "mirror.example.org", "M", undefined],
    ])
    const flat = JSON.stringify(body)
    expect(flat).not.toContain("ak_88yy")
    expect(flat).not.toContain("pw456")
    expect(flat).not.toContain("bob")
  })

  test("结构化行里的非法 URL 丢弃并标记截断;标题过共享 redactor(secret 形态整字段隐藏并标记)", () => {
    const body = toolCardBodyOf(
      part("websearch", {
        status: "completed",
        input: { query: "q" },
        output: JSON.stringify({
          results: [
            { title: "ok page", url: "https://fine.example.com/a" },
            { title: "bad scheme", url: "javascript:alert(1)" },
            { title: `Bearer ${"t".repeat(200)}`, url: "https://leaky.example.org/b" },
          ],
        }),
      }),
    )
    if (body.type !== "links") throw new Error("expected links body")
    expect(body.links.map((link) => link.href)).toEqual([
      "https://fine.example.com/a",
      "https://leaky.example.org/b",
    ])
    expect(body.links[0]!.title).toBe("ok page")
    // Bearer credential 形态:redactor 把 span 替换;展示标题绝不含原 token。
    expect(JSON.stringify(body)).not.toContain("t".repeat(32))
    expect(body.truncated).toBe(true)
  })
})
