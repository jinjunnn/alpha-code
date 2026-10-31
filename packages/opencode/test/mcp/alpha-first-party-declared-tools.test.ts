// #1565(REQ-236 §2.3)—— 第一方文档工具「可发现与可执行分开」的运行期判据。每条都跑生产 `MCP.Service`(真 layer)
// 与真 stdio 子进程;条目命令按 main 写入的形状(ui-mac office-advisories 的 alphaOfficeInstallCommand,资源槽换成
// 一个临时「应用包」的 Resources),声明来自入库的 resources/office-mcp/tools.json 与 server.py 的拷贝,经
// ALPHA_OFFICE_MCP_MANIFEST 指过去 —— 与生产同一条链。随包解释器是一个 shim:真 python3 跑真 server.py(身份对照
// 那条),或换成 test/fixture/alpha-mcp-startup-stdio.ts(要控制握手快慢与它报出的定义时)。
//
//   AC2  连接中的文档工具以声明定义出现在 mcp.tools() 与 Code Mode 子目录,身份/授权/代号/摘要与连上后相同;
//        命令多一个 token、或 server.py 与清单摘要不符 ⇒ 无声明定义
//   AC3  调用声明工具只等它自己的服务(另一台还在握手);连上后定义与声明不符 ⇒ 该次调用失败、之后只给实际定义,
//        再次连接中也不再给声明(普通工具经真 SessionTools、Code Mode 经真 CodeModeTool 各一)
//   AC4  第三方服务(即使报的定义与文档工具一模一样)首次握手前不在工具表里
//
// 删掉对应行为时会红的那一处,写在每条用例上方。本文件 alpha 自有(`alpha-*`,ADR-043),登记在 scripts/gate-files.tsv。

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { OFFICE_MCP_MANIFEST_ENV } from "../../src/mcp/alpha-first-party-mcp"
import { classifyTool } from "@opencode-ai/schema/alpha-tool-policy"
import {
  ALPHA_OFFICE_PYTHON_SLOT,
  ALPHA_OFFICE_SERVER_SLOT,
  alphaOfficeInstallCommand,
  type AlphaOfficeFormat,
} from "../../../ui-mac/src/shared/office-advisories"
import { Agent } from "../../src/agent/agent"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { MCP } from "../../src/mcp/index"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import type { Provider } from "../../src/provider/provider"
import { MessageID, SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import type { SessionProcessor } from "../../src/session/processor"
import { SessionTools } from "../../src/session/tools"
import { CodeModeTool } from "../../src/tool/code-mode"
import { ToolRegistry } from "../../src/tool/registry"
import { Tool } from "../../src/tool/tool"
import * as Truncate from "../../src/tool/truncate"
import { inMemoryToolPolicyLayer } from "../fixture/alpha-tool-policy"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(MCP.node))
const fixture = path.join(import.meta.dir, "../fixture/alpha-mcp-startup-stdio.ts")
const shipped = path.join(import.meta.dir, "../../../ui-mac/resources/office-mcp")
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-1565-"))

type Manifest = { formats: Record<AlphaOfficeFormat, { tools: Array<{ name: string; description?: string }> }> }
const manifest = JSON.parse(fs.readFileSync(path.join(shipped, "tools.json"), "utf8")) as Manifest

/** 一个临时应用包的 Resources:入库的 server.py 与 tools.json 拷贝,外加 `office-runtime/bin/python3` shim。 */
function bundle(interpreter: "python3" | "fixture") {
  const resources = path.join(scratch, `Code Puppy-${crypto.randomUUID()}.app`, "Contents", "Resources")
  const office = path.join(resources, "office-mcp")
  const python = path.join(resources, "office-runtime", "bin", "python3")
  fs.mkdirSync(office, { recursive: true })
  fs.mkdirSync(path.dirname(python), { recursive: true })
  for (const file of ["server.py", "tools.json"]) fs.copyFileSync(path.join(shipped, file), path.join(office, file))
  const target = interpreter === "python3" ? `exec python3 "$@"` : `exec '${process.execPath}' '${fixture}' "$@"`
  fs.writeFileSync(python, `#!/bin/sh\n${target}\n`, { mode: 0o755 })
  const server = path.join(office, "server.py")
  return {
    manifest: path.join(office, "tools.json"),
    server,
    /** main 写进配置的命令:模板的两个资源槽换成这个包,`{workspace}` 原样(ext-mcp-policy 同一种替换)。 */
    command: (format: AlphaOfficeFormat) =>
      alphaOfficeInstallCommand(format).map((token) =>
        token === ALPHA_OFFICE_PYTHON_SLOT ? python : token === ALPHA_OFFICE_SERVER_SLOT ? server : token,
      ),
  }
}

const toolsFile = (tools: unknown) => {
  const file = path.join(scratch, `tools-${crypto.randomUUID()}.json`)
  fs.writeFileSync(file, JSON.stringify(tools))
  return file
}
const wordTools = toolsFile(manifest.formats.word.tools)
// 连上后报的定义与声明不同:read_docx 的描述被改过(「声明与实际不一致」的那台服务)。
const driftedWordTools = toolsFile(
  manifest.formats.word.tools.map((tool) =>
    tool.name === "read_docx" ? { ...tool, description: `${tool.description} (drifted)` } : tool,
  ),
)

const office = (
  pack: ReturnType<typeof bundle>,
  format: AlphaOfficeFormat,
  environment: Record<string, string> = {},
  extra: string[] = [],
) => ({ type: "local" as const, command: [...pack.command(format), ...extra], environment })
const thirdParty = (environment: Record<string, string>) => ({
  type: "local" as const,
  command: [process.execPath, fixture],
  environment,
})
const HANG = { ALPHA_MCP_HANG: "1" }
const slowStart = (ms: number, tools = wordTools) => ({ ALPHA_MCP_TOOLS_FILE: tools, ALPHA_MCP_INIT_DELAY_MS: String(ms) })

/** 生产里 main 在 fork 时注入;这里对一条用例设上、用完还原。 */
const withManifest = <A, E, R>(manifestPath: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env[OFFICE_MCP_MANIFEST_ENV]
      process.env[OFFICE_MCP_MANIFEST_ENV] = manifestPath
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[OFFICE_MCP_MANIFEST_ENV]
        else process.env[OFFICE_MCP_MANIFEST_ENV] = previous
      }),
  )

const statusOf = (name: string) => MCP.Service.use((mcp) => mcp.status()).pipe(Effect.map((all) => all[name]))
const waitFor = (name: string, status: MCP.Status["status"]) =>
  pollWithTimeout(
    statusOf(name).pipe(Effect.map((current) => (current?.status === status ? current : undefined))),
    `${name} never reached ${status}`,
    "10 seconds",
  )
const keysOf = (tools: Record<string, MCP.McpTool>, server: string) =>
  Object.keys(tools)
    .filter((key) => key.startsWith(`${server}_`))
    .sort()
/** 工具表里与身份有关的全部字段(不含 client:声明工具没有连接)。 */
const offered = ({ def, identity, authority, generation, defDigest, timeout }: MCP.McpTool) => ({
  def,
  identity,
  authority,
  generation,
  defDigest,
  timeout,
})

const CHANGED = /changed after this request was prepared/

// ── AC2 ──────────────────────────────────────────────────────────────────────────────────────────────────────
// 删掉 tools() 里的声明分支 ⇒ 连接中 codepuppy-word 一个工具都没有;声明不按 tools/list 的解析走 ⇒ 摘要与连上后不同。
const real = bundle("python3")
it.instance(
  "AC2: a bundled Office server still connecting is offered from its declaration, under the identity it lists once connected",
  () =>
    withManifest(
      real.manifest,
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        const declared = yield* mcp.tools()
        expect((yield* mcp.status())["codepuppy-word"]).toEqual({ status: "pending" })
        expect(keysOf(declared, "codepuppy-word")).toEqual(["codepuppy-word_read_docx", "codepuppy-word_write_docx"])
        expect(declared["codepuppy-word_read_docx"]!.client).toBeUndefined()

        yield* waitFor("codepuppy-word", "connected")
        const listed = yield* mcp.tools()
        expect(keysOf(listed, "codepuppy-word")).toEqual(keysOf(declared, "codepuppy-word"))
        expect(listed["codepuppy-word_read_docx"]!.client).toBeDefined()
        for (const key of keysOf(declared, "codepuppy-word")) expect(offered(declared[key]!)).toEqual(offered(listed[key]!))
      }),
    ),
  { config: { mcp: { "codepuppy-word": office(real, "word") } } },
)

// #1578:执行闸按 bindingFacts 的 authority 判类(session/tools.ts currentSubject)。连接中的声明工具在这里若是 not-asserted,
// 「Code Puppy 文档工具」整组设置在握手完成前不生效。删掉 bindingFacts 的声明分支 ⇒ 这里 not-asserted / third-party-mcp,当场红。
const connecting = bundle("fixture")
it.instance(
  "#1578: while a declared document tool's server is still connecting, bindingFacts carries the offer's codepuppy-bundled authority",
  () =>
    withManifest(
      connecting.manifest,
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        const offered = (yield* mcp.tools())["codepuppy-word_read_docx"]!
        expect(offered.authority?.kind).toBe("codepuppy-bundled")
        expect((yield* mcp.status())["codepuppy-word"]).toEqual({ status: "pending" })
        const facts = yield* mcp.bindingFacts!("codepuppy-word")
        expect(facts?.authority).toEqual(offered.authority)
        expect(classifyTool({ identity: offered.identity!, authority: facts!.authority })).toBe("codepuppy-bundled")
      }),
    ),
  { config: { mcp: { "codepuppy-word": office(connecting, "word", HANG) } } },
)

// 去掉逐 token 的长度/逐项比较 ⇒ 多一个 token 的 codepuppy-excel 也拿到声明;去掉摘要比较 ⇒ server.py 被改过之后仍有声明。
const bound = bundle("fixture")
it.instance(
  "AC2: only the exact bundled command, next to the server.py the manifest was exported from, gets a declaration",
  () =>
    withManifest(
      bound.manifest,
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        const before = yield* mcp.tools()
        expect(keysOf(before, "codepuppy-word")).toEqual(["codepuppy-word_read_docx", "codepuppy-word_write_docx"])
        expect(keysOf(before, "codepuppy-pdf")).toEqual(["codepuppy-pdf_read_pdf", "codepuppy-pdf_write_pdf"])
        expect(keysOf(before, "codepuppy-excel")).toEqual([])

        fs.appendFileSync(bound.server, "\n# not the server.py tools.json was exported from\n")
        const after = yield* mcp.tools()
        expect(keysOf(after, "codepuppy-word")).toEqual([])
        expect(keysOf(after, "codepuppy-pdf")).toEqual([])
        const status = yield* mcp.status()
        for (const name of ["codepuppy-word", "codepuppy-excel", "codepuppy-pdf"]) expect(status[name]).toEqual({ status: "pending" })
      }),
    ),
  {
    config: {
      mcp: {
        "codepuppy-word": office(bound, "word", HANG),
        "codepuppy-excel": office(bound, "excel", HANG, ["--extra"]),
        "codepuppy-pdf": office(bound, "pdf", HANG),
      },
    },
  },
)

// ── AC3 / AC4 rigs ───────────────────────────────────────────────────────────────────────────────────────────
const passThrough = Layer.mergeAll(
  Layer.mock(Plugin.Service, {
    trigger: ((_name: unknown, _input: unknown, output: unknown) =>
      Effect.succeed(output)) as Plugin.Interface["trigger"],
  }),
  Layer.mock(Permission.Service, { ask: (() => Effect.void) as Permission.Interface["ask"] }),
  Layer.mock(Truncate.Service, {
    output: (text: string) => Effect.succeed({ content: text, truncated: false as const }),
  }),
  inMemoryToolPolicyLayer(),
)

const sessionRig = Layer.mergeAll(
  passThrough,
  Layer.mock(ToolRegistry.Service, { tools: () => Effect.succeed([]) }),
  RuntimeFlags.layer({ experimentalCodeMode: false }),
)

const codeModeRig = Layer.mergeAll(
  passThrough,
  Layer.mock(Agent.Service, { get: () => Effect.succeed({ name: "build", permission: [] } as never) }),
  Layer.mock(Session.Service, { get: () => Effect.succeed({ permission: [] } as never) }),
)

/** 普通工具的生产咽喉:真 `SessionTools.resolve`(一次模型请求的工具集合在这里固定)。 */
const resolveSessionTools = SessionTools.resolve({
  agent: {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  },
  model: { providerID: ProviderV2.ID.make("test"), api: { id: "test-model" } } as Provider.Model,
  session: { id: SessionID.make("ses_alpha_1565"), permission: [] } as unknown as Session.Info,
  processor: {
    message: { id: MessageID.ascending() },
    updateToolCall: () => Effect.void,
    completeToolCall: () => Effect.void,
    registerToolDisplay: () => {},
  } as unknown as Pick<
    SessionProcessor.Handle,
    "message" | "updateToolCall" | "completeToolCall" | "registerToolDisplay"
  >,
  bypassAgentCheck: false,
  messages: [],
  promptOps: {} as never,
})

const runTool = (tool: { execute?: (...args: never[]) => unknown }, args: Record<string, unknown>) =>
  Effect.tryPromise({
    try: () =>
      Promise.resolve(tool.execute!(args as never, { toolCallId: "call_1565", messages: [] } as never)) as Promise<{
        output: string
      }>,
    catch: (error) => error as Error,
  })

const codeModeContext = (): Tool.Context => ({
  sessionID: SessionID.make("ses_alpha_1565"),
  messageID: MessageID.ascending(),
  agent: "build",
  abort: new AbortController().signal,
  callID: "call_1565_code",
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

const runCode = (code: string) =>
  Effect.gen(function* () {
    const tool = yield* Tool.init(yield* CodeModeTool)
    return yield* tool.execute({ code }, codeModeContext()).pipe(Effect.exit)
  })

const READ = `return await tools["codepuppy-word"].read_docx({ path: "/workspace/report.docx" })`

// ── AC3 ──────────────────────────────────────────────────────────────────────────────────────────────────────
// 改成「声明工具执行前等全部服务」⇒ 卡在 hang 的 30 s 连接超时;不给声明 ⇒ 这次请求里根本没有 codepuppy-word_read_docx。
const ordinary = bundle("fixture")
it.instance(
  "AC3: an ordinary call to a declared tool waits only for its own server while another is still connecting",
  () =>
    withManifest(
      ordinary.manifest,
      Effect.gen(function* () {
        const tools = yield* resolveSessionTools
        expect(yield* statusOf("codepuppy-word")).toEqual({ status: "pending" })
        expect((yield* runTool(tools["codepuppy-word_read_docx"]!, { path: "/workspace/report.docx" })).output).toBe(
          "read_docx",
        )
        expect(yield* statusOf("codepuppy-word")).toEqual({ status: "connected" })
        expect(yield* statusOf("hang")).toEqual({ status: "pending" })
      }).pipe(Effect.provide(sessionRig)),
    ),
  { config: { mcp: { "codepuppy-word": office(ordinary, "word", slowStart(800)), hang: thirdParty(HANG) } } },
)

// Code Mode 的子目录在 execute 开头固定:那一刻 codepuppy-word 还在握手,子目录里有它,只因为它有声明定义。
const coded = bundle("fixture")
it.instance(
  "AC3: a Code Mode child call to a declared tool runs while another server is still connecting",
  () =>
    withManifest(
      coded.manifest,
      Effect.gen(function* () {
        expect(yield* statusOf("codepuppy-word")).toEqual({ status: "pending" })
        const exit = yield* runCode(READ)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) expect(exit.value.output).toBe("read_docx")
        expect(yield* statusOf("hang")).toEqual({ status: "pending" })
      }).pipe(Effect.provide(codeModeRig)),
    ),
  { config: { mcp: { "codepuppy-word": office(coded, "word", slowStart(800)), hang: thirdParty(HANG) } } },
)

// 去掉 callTool 对声明工具的摘要核对 ⇒ 按声明规划的调用照样跑到改过定义的服务上(不红);去掉 refuted ⇒ 再次连接中又给出声明。
const drifted = bundle("fixture")
it.instance(
  "AC3: an ordinary call planned against a declaration the server contradicts fails, and the declaration is dropped",
  () =>
    withManifest(
      drifted.manifest,
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        const planned = yield* resolveSessionTools
        const exit = yield* runTool(planned["codepuppy-word_read_docx"]!, { path: "/workspace/report.docx" }).pipe(
          Effect.exit,
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toMatch(CHANGED)

        // 之后只给实际定义,按它规划的调用照常完成。
        const actual = (yield* mcp.tools())["codepuppy-word_read_docx"]!
        expect(actual.def.description).toEndWith("(drifted)")
        const replanned = yield* resolveSessionTools
        expect((yield* runTool(replanned["codepuppy-word_read_docx"]!, { path: "/workspace/report.docx" })).output).toBe(
          "read_docx",
        )

        // 再次连接中(新一代还在握手)也不再给声明。
        const reconnect = yield* mcp.connect("codepuppy-word").pipe(Effect.forkScoped)
        yield* waitFor("codepuppy-word", "pending")
        expect(keysOf(yield* mcp.tools(), "codepuppy-word")).toEqual([])
        yield* Fiber.join(reconnect)
        expect((yield* mcp.tools())["codepuppy-word_read_docx"]!.def.description).toEndWith("(drifted)")
      }).pipe(Effect.provide(sessionRig)),
    ),
  { config: { mcp: { "codepuppy-word": office(drifted, "word", slowStart(800, driftedWordTools)) } } },
)

const driftedCode = bundle("fixture")
it.instance(
  "AC3: a Code Mode child call planned against a declaration the server contradicts fails, and the declaration is dropped",
  () =>
    withManifest(
      driftedCode.manifest,
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        const exit = yield* runCode(READ)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toMatch(CHANGED)
        expect((yield* mcp.tools())["codepuppy-word_read_docx"]!.def.description).toEndWith("(drifted)")
        const again = yield* runCode(READ)
        expect(Exit.isSuccess(again)).toBe(true)
        if (Exit.isSuccess(again)) expect(again.value.output).toBe("read_docx")
      }).pipe(Effect.provide(codeModeRig)),
    ),
  { config: { mcp: { "codepuppy-word": office(driftedCode, "word", slowStart(800, driftedWordTools)) } } },
)

// ── AC4 ──────────────────────────────────────────────────────────────────────────────────────────────────────
// 让声明对任意本机条目生效(不按命令绑定)⇒ 这台报着同样定义的第三方服务在握手前就出现。
const foreign = bundle("fixture")
it.instance(
  "AC4: a third-party server is not in the tool list before its first handshake, even with the same definitions",
  () =>
    withManifest(
      foreign.manifest,
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        expect(keysOf(yield* mcp.tools(), "third")).toEqual([])
        expect(yield* statusOf("third")).toEqual({ status: "pending" })
        yield* waitFor("third", "connected")
        expect(keysOf(yield* mcp.tools(), "third")).toEqual(["third_read_docx", "third_write_docx"])
      }),
    ),
  { config: { mcp: { third: thirdParty(slowStart(800)) } } },
)
