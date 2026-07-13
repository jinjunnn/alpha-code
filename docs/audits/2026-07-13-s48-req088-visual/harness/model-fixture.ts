// REQ-088 视觉/探针取证的 scripted model fixture(形态沿用 test-live/req087/harness.ts 的
// startScriptedModel,增补 tool-read / tool-edit 脚本与非流式分支)。跑在 127.0.0.1:14930,
// 由隔离 ALPHA_GLOBAL_DIR/alpha.jsonc 的 "scripted" provider 指向 —— 真实 LLM 面零触达。
//
// 指令(取最后一条 user 文本):
//   SCRIPT:tool-bash:<command>                          → bash tool_call;工具结果回来后短文本收尾
//   SCRIPT:tool-read:<path>                             → read tool_call(目录 → 真实 <entries> 输出)
//   SCRIPT:tool-edit:<path>|<old>|<new>                 → edit tool_call
//   SCRIPT:text:<n>                                     → n 个 token
//   其它                                                → 简短 ack(命令模板/标题生成等一律走这)
const PORT = 14930

function lastUserText(messages: { role: string; content: unknown }[]): string {
  const last = [...messages].reverse().find((m) => m.role === "user")
  if (!last) return ""
  if (typeof last.content === "string") return last.content
  if (Array.isArray(last.content))
    return last.content.map((c: any) => (typeof c === "string" ? c : (c?.text ?? ""))).join(" ")
  return JSON.stringify(last.content ?? "")
}

function toolCallFor(text: string): { name: string; args: Record<string, unknown> } | null {
  let m = text.match(/SCRIPT:tool-bash:([^\n]+)/)
  if (m) return { name: "bash", args: { command: m[1].trim(), description: "req088 probe bash" } }
  m = text.match(/SCRIPT:tool-read:([^\n|]+)/)
  if (m) return { name: "read", args: { filePath: m[1].trim() } }
  m = text.match(/SCRIPT:tool-edit:([^\n]+)/)
  if (m) {
    const [filePath, oldString, newString] = m[1].split("|")
    if (filePath && oldString != null && newString != null)
      return { name: "edit", args: { filePath: filePath.trim(), oldString, newString } }
  }
  return null
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 240,
  async fetch(req) {
    const url = new URL(req.url)
    if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
    const body = (await req.json().catch(() => ({}))) as {
      stream?: boolean
      messages?: { role: string; content: unknown }[]
    }
    const messages = body.messages ?? []
    const text = lastUserText(messages)
    const hasToolResult = messages.at(-1)?.role === "tool"
    const tool = hasToolResult ? null : toolCallFor(text)
    console.log(
      `[fixture] stream=${!!body.stream} toolResult=${hasToolResult} tool=${tool?.name ?? "-"} text=${text.slice(0, 80).replace(/\n/g, " ")}`,
    )

    // 非流式(provider 连通性探测等):固定短文本。
    if (!body.stream) {
      return Response.json({
        id: "chatcmpl-scripted",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "scripted-1",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    }

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
        if (tool) {
          send(chunk({ role: "assistant" }))
          send(
            chunk({
              tool_calls: [
                { index: 0, id: `call_${Date.now()}`, type: "function", function: { name: tool.name, arguments: "" } },
              ],
            }),
          )
          send(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(tool.args) } }] }))
          send(chunk({}, "tool_calls"))
        } else {
          send(chunk({ role: "assistant" }))
          if (hasToolResult) {
            send(chunk({ content: "工具已完成。" }))
          } else {
            const m = text.match(/SCRIPT:text:(\d+)/)
            const n = m ? Number(m[1]) : 2
            for (let i = 0; i < n; i++) {
              send(chunk({ content: `tok-${i} ` }))
              await Bun.sleep(20)
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
console.log(`[fixture] scripted model listening on :${server.port}`)
