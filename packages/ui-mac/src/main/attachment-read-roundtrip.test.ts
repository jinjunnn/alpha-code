// REQ-236 `#1553` AC4 真实读取往返:暂存(main 生产函数)→ 读取指令(ext 生产函数)→ 真 server.py 按指令里的路径读
// → 时间线附件卡(renderer 生产投影)判「已读取」。三段各用生产代码,中间不换替身:路径若在任何一段被各写一份,
// 这里就红(方案 §2.6 F4 / §四 ⑤「真实读取往返」)。
//
// 样本来源:DOCX / PDF 由同一个随包 server.py 的 write_docx / write_pdf 现场写出(生产写入器的真产物,不手写 OOXML / PDF 字节),
// 再作为「用户拖进来的文件」的字节交给暂存。解释器同 office-mcp.test.ts:生产 build-office-runtime.ts 给出本机架构那份,
// PATH 里没有 uv / Homebrew。随包运行时只进 mac 包,本文件只在 darwin 上跑。
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { buildOfficeRuntime } from "../../scripts/build-office-runtime"
import { attachmentInstruction } from "../../../ext/src/attachment-reader-hooks"
import { mcpEngineToolId } from "../../../ext/src/cloud-websearch-kill"
import { buildAttachmentParts } from "../renderer/alpha-ui/composer-attachments-core"
import { projectTimelineRows } from "../renderer/alpha-ui/session-timeline/timeline-model"
import { alphaOfficeInstallCommand, ALPHA_OFFICE_PYTHON_SLOT, ALPHA_OFFICE_SERVER_SLOT, WORKSPACE_MARKER, type AlphaOfficeFormat } from "../shared/office-advisories"
import { stageComposerAttachment } from "./composer-attachment-stage"

const darwin = process.platform === "darwin"
const server = resolve(import.meta.dir, "../../resources/office-mcp/server.py")
let python = ""
let project = ""

beforeAll(() => {
  if (!darwin) return
  python = join(buildOfficeRuntime({ arch: process.arch === "x64" ? "x64" : "arm64" }).dir, "bin", "python3")
  project = realpathSync(mkdtempSync(join(tmpdir(), "alpha-attach-roundtrip-")))
}, 900_000)
afterAll(() => {
  if (project) rmSync(project, { recursive: true, force: true })
})

type Response = { id: number; result?: { content?: Array<{ text: string }>; isError?: boolean } }

/** 生产模板的命令,workspace = 会话实例目录(引擎把 `{workspace}` 换成 InstanceState.directory)。 */
async function callTool(format: AlphaOfficeFormat, name: string, args: Record<string, unknown>): Promise<Response["result"]> {
  const command = alphaOfficeInstallCommand(format).map((argument) =>
    argument === ALPHA_OFFICE_PYTHON_SLOT ? python : argument === ALPHA_OFFICE_SERVER_SLOT ? server : argument === WORKSPACE_MARKER ? project : argument,
  )
  const child = Bun.spawn(command, { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin", HOME: project, TMPDIR: project } })
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
  ]
  child.stdin.write(`${requests.map((r) => JSON.stringify(r)).join("\n")}\n`)
  child.stdin.end()
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`office MCP exited ${code}: ${stderr}`)
  return (stdout.trim().split("\n").map((line) => JSON.parse(line) as Response).find((r) => r.id === 2) ?? {}).result
}

/** 指令里给模型的工具 id 与 path(模型照抄它们发起调用)。 */
function instructed(text: string) {
  const match = /调用工具 (\S+) 读取它,参数 path 填写:(.+)\n/.exec(text)
  if (!match) throw new Error(`instruction shape changed: ${text}`)
  return { toolId: match[1]!, path: match[2]! }
}

async function roundTrip(format: "word" | "pdf", name: string, sample: Record<string, unknown>, expectText: string) {
  const remote = format === "word" ? { write: "write_docx", read: "read_docx", ext: ".docx" } : { write: "write_pdf", read: "read_pdf", ext: ".pdf" }
  // 1. 样本:生产写入器写进工作区里的另一处子目录(不在隐藏目录),读出字节 = 「用户拖进来的文件」。
  mkdirSync(join(project, "samples"), { recursive: true })
  const source = join(project, "samples", `sample${remote.ext}`)
  expect((await callTool(format, remote.write, { path: source, ...sample }))?.isError).not.toBe(true)
  const bytes = readFileSync(source)

  // 2. 暂存(main)→ 用户消息里的记录(renderer 提交形状)。
  const staged = stageComposerAttachment(project, name, format, bytes)
  if (!staged.ok) throw new Error(`stage failed: ${staged.reason}`)
  const [recordPart] = buildAttachmentParts([
    { id: "a", name, mime: "x", kind: "document", size: bytes.byteLength, reader: format, directory: project, path: staged.path },
  ]) as Array<{ metadata: Record<string, unknown> }>
  const meta = recordPart!.metadata["codepuppy.attachment"] as Parameters<typeof attachmentInstruction>[0]

  // 3. 读取指令(ext):工具 id 由推导函数得出,path 由共享路径函数得出。
  const service = format === "word" ? "alpha-word" : "alpha-pdf"
  const { toolId, path } = instructed(attachmentInstruction(meta, project, { [service]: { status: "connected" } }))
  expect(toolId).toBe(mcpEngineToolId(service, remote.read))

  // 4. 真 server.py 按指令里的路径读:成功、内容就是样本。
  const result = await callTool(format, remote.read, { path })
  expect(result?.isError, JSON.stringify(result)).not.toBe(true)
  const output = result!.content![0]!.text
  expect(output).toContain(expectText)

  // 5. 时间线(renderer 生产投影):这次成功调用被判「已读取」;换一个不相干的路径就不是。
  const messages = [
    { id: "msg_u", sessionID: "ses", role: "user", time: { created: 1 }, agent: "build", model: { providerID: "p", modelID: "m" } },
    { id: "msg_a", sessionID: "ses", role: "assistant", parentID: "msg_u", time: { created: 2, completed: 3 }, modelID: "m", providerID: "p", mode: "build", agent: "build", path: { cwd: project, root: project }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
  ] as unknown as Message[]
  const toolPart = (input: string) =>
    ({
      id: "prt_t",
      sessionID: "ses",
      messageID: "msg_a",
      type: "tool",
      callID: "c1",
      tool: toolId,
      display: { identity: { source: "mcp", origin: service, name: remote.read }, technicalId: toolId, authority: { kind: "not-asserted" } },
      state: { status: "completed", input: { path: input }, output, title: "", metadata: {}, time: { start: 0, end: 1 } },
    }) as unknown as Part
  const userParts = [{ id: "prt_u", sessionID: "ses", messageID: "msg_u", type: "text", text: "看看这份" }, { id: "prt_r", sessionID: "ses", messageID: "msg_u", ...recordPart }] as unknown as Part[]
  const chip = (input: string) => {
    const rows = projectTimelineRows({
      messages,
      partsOf: (id) => (id === "msg_u" ? userParts : [toolPart(input)]),
      status: "idle",
      attachments: { directory: project, services: { [service]: { status: "connected" } } },
    })
    const user = rows.find((row) => row.kind === "user")
    return user?.kind === "user" ? user.attachments.map((a) => a.read?.kind) : []
  }
  expect(chip(path)).toEqual(["read"])
  expect(chip(source)).toEqual(["not-read"])
}

describe("#1553 真实读取往返(随包解释器 + server.py)", () => {
  test.skipIf(!darwin)("Word:暂存的 DOCX 按指令里的路径读成功,时间线判「已读取」", async () => {
    await roundTrip("word", "2026 第三季度经营复盘.docx", { title: "经营复盘", paragraphs: ["转化率下降的主因在首屏"] }, "转化率下降的主因在首屏")
  }, 60_000)
  test.skipIf(!darwin)("PDF:暂存的 PDF 按指令里的路径读成功,时间线判「已读取」", async () => {
    await roundTrip("pdf", "供应商合同(终版).pdf", { pages: ["Contract term: 24 months"] }, "Contract term: 24 months")
  }, 60_000)
})
