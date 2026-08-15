// #607:alpha 注入的**执行级**闸门。#603 R2 勘破的缺口:全仓没有任何测试 import 过 sidecar.ts
// (它的第一个 import 就是 bun 未实现的 `node:module` registerHooks,顶层还有 getParentPort()),
// 于是「注入到底有没有跑起来」零覆盖 —— 而 injectAlphaConfig 有一层**函数级 catch**,内部任何
// 抛错都被静默吞掉,可见症状只是「模型全灰 / 正在同步」(2026-07-24 事故的表现)。
//
// 本文件执行的是**生产 composition**:真 injectAlphaConfig + 真 12 个 sibling 模块 + 真临时盘,
// **零模块/依赖 mock**、不重写任何接线(rev2c ③″3-1 禁止镜像)。
// 唯一的替身是反向闸门里拦截 `console.warn` 这个**日志 sink** —— 它证明生产代码调用了 warn,
// 不证明真实 stderr 输出。不写「零替身」:那句话与下方的拦截冲突,而交付物不得声称未达成的状态
// (rev2c ③″3-6/12)。
//   · 正向闸门:content 必须携带 model / enabled_providers / provider / 三个 alpha agent / {file:} ref。
//   · 反向闸门(rev2c ③″3-7):用真实故障(userDataPath 的父级是普通文件 → 生产代码 mkdirSync 抛
//     ENOTDIR)触发那层 catch,并要求 ①失败必须出声 ②正向闸门的断言体在这条路径上**真的转红**。
//
// 边界,不谎报:catch 语义本票不改(#607 明令等价搬迁),**生产端仍然会吞掉抛错**。本文件改变的
// 是「吞掉之后无人知晓」——从此任何让注入抛错的回归都会撞红正向闸门。
//
// #613 追加:生产侧不再沉默 —— injectAlphaConfig 把结果作为返回值交出(sidecar.ts 随 ready IPC
// 上报 main,终态生产者发布 "injection-failed")。本文件锁链条的第一环:返回值,含 R1 Blocker 1
// 的 v2 桥反向闸门(v1 成功 + v2 桥失败曾被自吞 catch 报成 ok:true,而 picker 只经 v2 目录读模型)。
// 第二环(sidecar.ts 转发)在 R1 后一分为二:「失败值真的上车」由可真执行的 buildReadyMessage
// 运行时闸门守(sidecar-ready-message.test.ts —— 纯文本锚被 `injection.error && undefined`
// 变异实证绕过);留在本文件的源码锚只锁 bun 无法运行时验证的接线事实(唯一通路 + 捕获值整体入参)。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Config } from "../../../core/src/config"
import { ModelV2 } from "../../../core/src/model"
import { Provider as ModelsDevProvider } from "../../../core/src/models-dev"
import { ProviderV2 } from "../../../core/src/provider"
import { ConfigV1 } from "../../../core/src/v1/config/config"
import { ConfigMigrateV1 } from "../../../core/src/v1/config/migrate"
import { Schema } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { ALPHA_V2_CATALOG_READY_PROVIDER_ID } from "../shared/alpha-config"
import { injectAlphaConfig } from "./alpha-config-injection"
import { secretFilePath } from "./alpha-secret-files"
import {
  CLOUD_MCP_ARM_ENV,
  CLOUD_MCP_DEF_ENV,
  CLOUD_MCP_SERVER_ENV,
  CLOUD_WEB_SEARCH_TOOL_ID,
  cloudMcpToolId,
  WITHHELD_CLOUD_MCP,
} from "./cloud-web-search"
// #650:云工具 id 从远端工具名**推导**(引擎按 `McpCatalog.toolName(server, remote)` 拼)。
// 这里以前手写 `cloud_web_search` / `cloud_dispatch` 字面量,与生产代码同错,于是恒绿。
const CLOUD_DISPATCH_TOOL_ID = cloudMcpToolId("cloud_dispatch")

// 注入读到的每一个 env 输入 + 它自己写出的 env 输出:逐个快照/清空/还原,
// 既隔离宿主机真实配置,也不把注入结果泄漏给同进程的其它测试文件。
const MANAGED = [
  "ALPHA_JSONC_TRUTH_DISABLE",
  "ALPHA_LEGACY_INSTALL_ROOT",
  "ALPHA_GLOBAL_DIR",
  "ALPHA_OPENCODE_HOME",
  "XDG_CONFIG_HOME",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_MODELS_PATH",
  "ALPHA_IDENTITY_DISABLE",
  "ALPHA_BEHAVIOR_DISABLE",
  "ALPHA_MODELS_DISABLE",
  "ALPHA_AUTOMATION_DISABLE",
  "ALPHA_READONLY_DISABLE",
  "ALPHA_WEBSEARCH_DISABLE",
  "OPENCODE_ENABLE_EXA",
  "OPENCODE_EXPERIMENTAL",
  "ALPHA_CLOUD_MCP_URL",
  // #223 R4/R5:注入面自己置位/删除的 ext 装载握手通道 + 云 server 身份(输出之三)。
  "ALPHA_CLOUD_MCP_ARM",
  "ALPHA_CLOUD_MCP_DEF",
  "ALPHA_CLOUD_MCP_SERVER",
  "ALPHA_BASE_URL",
  "ALPHA_DEFAULT_MODEL",
] as const

const PLATFORM_KEY = "sk-platform-injection-gate"
const BYOK_KEY = "sk-deepseek-injection-gate"
const DEFAULT_MODEL = "deepseek/deepseek-chat"

const saved: Record<string, string | undefined> = {}
let tmp = ""
let userData = ""

/** 按 main 的 syncSecretFiles 姿势把密钥种进 {file:} 通道(A6:env 里从不出现密钥值)。 */
const plantSecret = (varName: string, value: string) => {
  const file = secretFilePath(userData, varName)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, value, { mode: 0o600 })
}

beforeEach(() => {
  for (const k of MANAGED) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alpha-inject-")))
  // 当前环境根(alpha.jsonc 真源 = OPENCODE_CONFIG 的注入目标)。
  process.env.ALPHA_GLOBAL_DIR = path.join(tmp, "alpha-code-state", "env", "dev")
  fs.mkdirSync(process.env.ALPHA_GLOBAL_DIR, { recursive: true })
  // 用户全局引擎配置面(readUserProviderIds / injectMcpDefaultDeny 的枚举源)—— 指向空目录,
  // 宿主机 ~/.config/opencode 与 ~/.opencode 不得渗进断言。
  process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg")
  process.env.ALPHA_OPENCODE_HOME = path.join(tmp, "opencode-home")
  for (const d of [process.env.XDG_CONFIG_HOME, process.env.ALPHA_OPENCODE_HOME]) fs.mkdirSync(d, { recursive: true })
  userData = path.join(tmp, "userdata")
  fs.mkdirSync(userData, { recursive: true })
})

afterEach(() => {
  for (const k of MANAGED) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

/** main 在 fork 时给 sidecar 的那组输入,种成真实的盘上/env 状态(见 sidecar-env.ts 的转发清单)。 */
const givenLoggedInWithByok = () => {
  plantSecret("ALPHA_API_KEY", PLATFORM_KEY)
  plantSecret("DEEPSEEK_API_KEY", BYOK_KEY)
  process.env.ALPHA_BASE_URL = "https://gateway.example.invalid/v1"
  process.env.ALPHA_DEFAULT_MODEL = DEFAULT_MODEL
}

/**
 * 正向闸门的断言体。**反向用例会把同一个函数对着「注入抛错之后」的 env 再跑一遍并要求它抛** ——
 * 所以这里每一条 expect 既是正向锁也是反向锁,不得改成宽松断言(改宽 = 两个闸门同时失效)。
 */
function assertInjectedFacts(content: string | undefined, userDataPath: string): void {
  expect(content).toBeDefined()
  const config: {
    model?: unknown
    enabled_providers?: unknown
    provider?: Record<string, { options?: { apiKey?: unknown } }>
    agent?: Record<string, unknown>
  } = JSON.parse(content!)
  // model:picker 的默认模型(main 经 sidecar-env 转发 ALPHA_DEFAULT_MODEL)。
  expect(config.model).toBe(DEFAULT_MODEL)
  // enabled_providers:引擎对该键是 REPLACE 而非 union —— 表空/缺项 = 模型全灰。
  expect(config.enabled_providers).toEqual(expect.arrayContaining(["alpha", "deepseek-byok"]))
  // provider:白名单里的每个 id 必须真有节点定义,否则白名单是空头支票。
  expect(Object.keys(config.provider ?? {})).toEqual(expect.arrayContaining(["alpha", "deepseek-byok"]))
  // 三个 alpha agent(automation 只读 / composer 只读 / automation 可写)。
  expect(Object.keys(config.agent ?? {})).toEqual(
    expect.arrayContaining(["alpha-automation", "alpha-readonly", "alpha-automation-standard"]),
  )
  // A6:密钥以 {file:} ref 进 content,明文永不进(此处是**组合体**层面的锁,
  // alpha-models.test.ts 锁的是单件 buildAlphaModelConfig)。
  expect(config.provider!.alpha.options!.apiKey).toBe(`{file:${secretFilePath(userDataPath, "ALPHA_API_KEY")}}`)
  expect(config.provider!["deepseek-byok"].options!.apiKey).toBe(
    `{file:${secretFilePath(userDataPath, "DEEPSEEK_API_KEY")}}`,
  )
  expect(content).not.toContain(PLATFORM_KEY)
  expect(content).not.toContain(BYOK_KEY)
}

describe("injectAlphaConfig —— 注入组合体的执行级闸门(#607)", () => {
  test("正向闸门:生产 composition 跑通,content 携带 model/enabled_providers/provider/三个 alpha agent/{file:} ref", () => {
    givenLoggedInWithByok()

    const result = injectAlphaConfig(userData, undefined, "stable")

    // #613:成功路径返回 ok —— sidecar 据此不在 ready IPC 上挂 injectionFailure。
    expect(result).toEqual({ ok: true })
    assertInjectedFacts(process.env.OPENCODE_CONFIG_CONTENT, userData)
    // 组合体的另外两个 env 产物:v1 文件通道(alpha.jsonc)与 v2 目录桥,缺一都会让引擎看不见 provider。
    expect(process.env.OPENCODE_CONFIG).toBe(path.join(process.env.ALPHA_GLOBAL_DIR, "alpha.jsonc"))
    expect(process.env.OPENCODE_CONFIG_DIR).toBe(path.join(userData, "alpha-engine-config"))
    expect(process.env.OPENCODE_MODELS_PATH).toBe(path.join(userData, "alpha-engine-config", "models.json"))

    // I7 是「v2 桥目录已物化」,不是「env 里有那个字符串」(#607 R1)。只断言 OPENCODE_CONFIG_DIR
    // 的值,会让「删掉写 opencode.jsonc 的 writeFileSync、保留下一行赋值」全绿通过 ——
    // 而 v2 `/api/model` 实际读的正是那份文件,缺了它 alpha/BYOK 模型照样全灰。
    // 锁行为不锁形状(rev2c ③″3-2):读回生成的文件,断言它真带着 model 与必需 provider 节点。
    const v2Path = path.join(process.env.OPENCODE_CONFIG_DIR, "opencode.jsonc")
    expect(fs.existsSync(v2Path)).toBe(true)
    const v2 = JSON.parse(fs.readFileSync(v2Path, "utf8"))
    expect(typeof v2.model).toBe("string")
    expect(v2.model.length).toBeGreaterThan(0)
    expect(Object.keys(v2.provider ?? {})).toEqual(expect.arrayContaining(["alpha", "deepseek-byok"]))
    // #857:internal V2-only marker is committed by ConfigProvider in the same local batch as the
    // governed catalog. Empty env + zero models keeps it unavailable and invisible to model.list.
    expect(v2.provider[ALPHA_V2_CATALOG_READY_PROVIDER_ID]).toEqual({
      name: "Alpha catalog readiness marker",
      env: [],
    })
    const decodedV1 = Schema.decodeUnknownSync(ConfigV1.Info)(v2)
    const decodedV2 = Schema.decodeUnknownSync(Config.Info)(ConfigMigrateV1.migrate(decodedV1))
    expect(decodedV2.providers?.[ALPHA_V2_CATALOG_READY_PROVIDER_ID]?.env).toEqual([])
    const v1 = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "")
    expect(v1.provider?.[ALPHA_V2_CATALOG_READY_PROVIDER_ID]).toBeUndefined()
    // v2 投影是**刻意 keyless** 的(契约 docs/contracts/engine-config-channels.md:41-42):
    // 推理走 v1 的 {file:} 通道,v2 只供 picker 列目录,所以这份文件里既不该有明文密钥,
    // 也不该有 apiKey 字段本身。断言两者,而不是断言「有 {file: ref」——
    // (作者第一版就把 v1 的形态套到了 v2 上,被这条断言当场证伪。)
    const v2Raw = fs.readFileSync(v2Path, "utf8")
    expect(v2Raw).not.toContain(PLATFORM_KEY)
    expect(v2Raw).not.toContain(BYOK_KEY)
    expect(v2Raw).not.toContain("apiKey")
    // #857:the first request must not pay to decode the bundled 6,132-row models.dev snapshot or
    // wait for the late ConfigProvider commit. The early base is mechanically derived from the
    // SAME provider projection; it carries exact identities + marker, never a key or second policy.
    const modelsBaseRaw = fs.readFileSync(process.env.OPENCODE_MODELS_PATH!, "utf8")
    const modelsBase = JSON.parse(modelsBaseRaw) as Record<string, any>
    expect(Object.keys(modelsBase).sort()).toEqual(
      ["alpha", "deepseek-byok", ALPHA_V2_CATALOG_READY_PROVIDER_ID].sort(),
    )
    expect(modelsBase[ALPHA_V2_CATALOG_READY_PROVIDER_ID]).toEqual({
      id: ALPHA_V2_CATALOG_READY_PROVIDER_ID,
      name: "Alpha catalog readiness marker",
      env: [],
      models: {},
    })
    for (const id of ["alpha", "deepseek-byok"]) {
      expect(Object.keys(modelsBase[id].models).sort()).toEqual(Object.keys(v2.provider[id].models).sort())
      for (const [modelID, early] of Object.entries(modelsBase[id].models) as Array<[string, any]>) {
        // These providers are custom config projections, so before #857 their settled catalog rows
        // started from ModelV2.Info.empty() and ConfigProvider overlaid only declared fields. Keep
        // the early ModelsDev base capability/limit values byte-for-byte equivalent to that prior
        // settled default; this prevents the fast first commit from inventing a second metadata
        // authority while still proving it did not regress the final catalog.
        const settledDefault = ModelV2.Info.empty(ProviderV2.ID.make(id), ModelV2.ID.make(modelID))
        expect({
          tool_call: early.tool_call,
          limit: early.limit,
          modalities: early.modalities,
          released: Date.parse(early.release_date),
        }).toEqual({
          tool_call: settledDefault.capabilities.tools,
          limit: settledDefault.limit,
          modalities: {
            input: settledDefault.capabilities.input,
            output: settledDefault.capabilities.output,
          },
          released: settledDefault.time.released,
        })
      }
      Schema.decodeUnknownSync(ModelsDevProvider)(modelsBase[id])
    }
    Schema.decodeUnknownSync(ModelsDevProvider)(modelsBase[ALPHA_V2_CATALOG_READY_PROVIDER_ID])
    expect(modelsBaseRaw).not.toContain(PLATFORM_KEY)
    expect(modelsBaseRaw).not.toContain(BYOK_KEY)
    expect(modelsBaseRaw).not.toContain("apiKey")
  })

  test("enabled user/file provider missing from the in-memory projection keeps the late barrier fail-closed", () => {
    givenLoggedInWithByok()
    fs.writeFileSync(
      path.join(process.env.ALPHA_GLOBAL_DIR!, "alpha.jsonc"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        provider: {
          "user-file-provider": {
            npm: "@ai-sdk/openai-compatible",
            models: { "user-model": { name: "User Model" } },
          },
        },
      }),
    )

    expect(injectAlphaConfig(userData, undefined, "stable")).toEqual({ ok: true })
    expect(process.env.OPENCODE_MODELS_PATH).toBeUndefined()
    expect(fs.existsSync(path.join(userData, "alpha-engine-config", "models.json"))).toBe(false)
    expect(JSON.parse(process.env.OPENCODE_CONFIG_CONTENT!).enabled_providers).toContain("user-file-provider")
    expect(
      JSON.parse(fs.readFileSync(path.join(process.env.OPENCODE_CONFIG_DIR!, "opencode.json"), "utf8")).provider[
        "user-file-provider"
      ],
    ).toBeDefined()
  })

  test("ALPHA_MODELS_DISABLE preserves the upstream models path escape hatch", () => {
    process.env.ALPHA_MODELS_DISABLE = "1"
    process.env.OPENCODE_MODELS_PATH = "/operator/upstream-models.json"

    expect(injectAlphaConfig(userData, undefined, "stable")).toEqual({ ok: true })
    expect(process.env.OPENCODE_MODELS_PATH).toBe("/operator/upstream-models.json")
    expect(fs.existsSync(path.join(userData, "alpha-engine-config", "models.json"))).toBe(false)
  })

  test("反向闸门:注入内部抛错时失败必须出声,且正向闸门的断言体真的转红(函数级 catch 不再能瞒过测试)", () => {
    givenLoggedInWithByok()
    // 真实故障、零模块/依赖 mock(仅拦截日志 sink,见下):userDataPath 的父级是一个普通文件 → 生产代码里的
    // `fs.mkdirSync(userDataPath, { recursive: true })` 抛 ENOTDIR,正落进那层函数级 catch。
    const parentIsAFile = path.join(tmp, "not-a-directory")
    fs.writeFileSync(parentIsAFile, "")
    const brokenUserData = path.join(parentIsAFile, "userdata")

    const warned: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warned.push(args.map((a) => String(a)).join(" "))
    }
    let result: ReturnType<typeof injectAlphaConfig>
    try {
      result = injectAlphaConfig(brokenUserData, undefined, "stable")
    } finally {
      console.warn = originalWarn
    }

    // ① 失败必须出声。catch 本身保持不删(裸崩溃被票面禁止),但它不得静音。
    expect(warned.some((w) => w.includes("failed to inject alpha config"))).toBe(true)
    // ①′ #613 反向闸门(退出条件 1 的第一环):失败必须以结构化返回值离开本进程 ——
    //     把 catch 改回「只 warn 不返回」(生产侧重新沉默),本断言当场转红。
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.message.length).toBeGreaterThan(0)
    }
    // ② catch 的真实爆炸半径:整个注入丢失 —— content 与 v2 桥都没写出去。
    //    这正是「模型全灰 / 正在同步」的成因,不是局部降级。
    expect(process.env.OPENCODE_CONFIG_CONTENT).toBeUndefined()
    expect(process.env.OPENCODE_CONFIG_DIR).toBeUndefined()
    // ③ 本票的核心:把正向闸门的断言体对着这条被吞掉的路径再跑一遍,它**必须**转红。
    //    于是「注入内部抛错 ⇒ 有测试变红」每次 CI 都被现场证明一遍,而不是一句声称(rev2c ③″3-8)。
    expect(() => assertInjectedFacts(process.env.OPENCODE_CONFIG_CONTENT, brokenUserData)).toThrow()
  })

  // #613 R1 Blocker 1 反向闸门:v1 全部成功、只有 v2 桥失败 —— 这条真实失败路径曾被
  // materializeV2EngineConfig 的自吞 catch 报成 {ok:true}。权威契约(engine-config-channels.md):
  // picker 只经 v2 目录读模型,丢 v2 = alpha/BYOK 模型全灰 = 票面事故症状,
  // 「只损失 v2 目录」不是可忽略的局部降级。把那层自吞 catch 加回去,断言①当场转红。
  test("#613 反向闸门:v2 桥失败必须以 ok:false 离开进程,且不得撤销已写出的 v1 注入", () => {
    givenLoggedInWithByok()
    // 真实故障、零模块/依赖 mock(仅拦截日志 sink):v2 桥的目标目录位置被一个普通文件占住 →
    // 生产代码 `fs.mkdirSync(<userData>/alpha-engine-config, { recursive: true })` 抛 EEXIST。
    // 走到桥时上方 v1 注入(OPENCODE_CONFIG / OPENCODE_CONFIG_CONTENT)已全部完成 —— 正是 R1 实证的路径。
    fs.writeFileSync(path.join(userData, "alpha-engine-config"), "")

    const warned: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warned.push(args.map((a) => String(a)).join(" "))
    }
    let result: ReturnType<typeof injectAlphaConfig>
    try {
      result = injectAlphaConfig(userData, undefined, "stable")
    } finally {
      console.warn = originalWarn
    }

    // ① 失败以结构化结果离开进程(→ ready IPC 的 injectionFailure → "injection-failed" 终态)。
    expect(result.ok).toBe(false)
    // ①′ 错误信息自证抛点(fs 错误自带路径),main 的 error 日志无需猜是哪层死的。
    if (!result.ok) expect(result.error.message).toContain("alpha-engine-config")
    // ② 失败出声(外层 catch 的 warn;桥内不再有自己的静音 console.error)。
    expect(warned.some((w) => w.includes("failed to inject alpha config"))).toBe(true)
    // ③ 顺序锁:桥排在 content 写出之后,失败不得撤销已就位的 v1 注入 ——
    //    把 materializeV2EngineConfig 挪到 content 写出之前,本断言体当场转红。
    assertInjectedFacts(process.env.OPENCODE_CONFIG_CONTENT, userData)
    // ④ 半成品目录不得被指为权威:OPENCODE_CONFIG_DIR 保持未设置。
    expect(process.env.OPENCODE_CONFIG_DIR).toBeUndefined()
  })

  // #613 接线锚(R1 后收窄):sidecar.ts 无法被 bun import(首个 import 即 registerHooks,
  // 顶层 getParentPort 必抛)。R1 实证纯文本锚锁不住值上车 —— 「失败字段真的在 ready 消息上」
  // 已迁入真执行的 buildReadyMessage(sidecar-ready-message.test.ts)。留给源码锚的只剩
  // bun 无法运行时验证的接线事实,按 rev2c ③″3-2 锁位置/顺序与唯一通路:
  // 分类与「这处锚守不住什么」登记在 ./source-text-anchors.ts(`#968` 第 ⑤ 层机械校验)。
  test("ANCHOR (not a gate): #613 sidecar.ts 的 ready 上报必须走 buildReadyMessage(injection),别无通路", () => {
    const source = fs.readFileSync(path.join(import.meta.dir, "sidecar.ts"), "utf8")

    // ① start() 捕获注入结果,ready 发送在捕获之后、以捕获值**整体**入参 —— 精确到字符:
    //    `buildReadyMessage(injection && …)` / `(injection ?? …)` 等义改写都无法命中该子串。
    //    #881:第二个入参是 prewarm 的结局(同样整体入参,同样精确到字符)。
    const capture = source.indexOf("const injection = prepareSidecarEnv(")
    const ready = source.indexOf("parentPort.postMessage(buildReadyMessage(injection, prewarmResult))")
    expect(capture).toBeGreaterThan(-1)
    expect(ready).toBeGreaterThan(capture)
    // ② 被调用的必须是 sidecar-ready-message 导出的那一个(换源 import = 红),
    //    且本文件不得 shadow 重定义同名函数(重定义 = 红)。
    expect(source).toMatch(/import \{ buildReadyMessage[^}]*\} from "\.\/sidecar-ready-message"/)
    expect(source).not.toMatch(/(?:function|const|let|var)\s+buildReadyMessage/)
    // ③ 唯一通路:本文件不得再出现字面量构造的 ready 消息 —— R1 的绕过手法
    //    (另发 {type:"ready"} 裸消息、把旧表达式留在注释里)从此撞红。
    expect(source).not.toMatch(/postMessage\(\s*\{\s*type:\s*"ready"/)
    // ④ 中间环节不得吞:prepareSidecarEnv 以 injectAlphaConfig 的结果作为函数**最后一条语句**
    //    整体返回(锁到行尾 + 函数闭括号:`return injectAlphaConfig(...), {ok:true}` 逗号改写、
    //    换行续写表达式,都无处容身)。
    expect(source).toMatch(/return injectAlphaConfig\(userDataPath, extPluginPath, registryChannel\)\n\}/)
  })
})

// #223 对抗审计 Blocker(2026-07-25):`OPENCODE_EXPERIMENTAL=1` 绕过 web search 主权闸。
// 上游 `runtime-flags.ts` 的 `enableExa = OPENCODE_EXPERIMENTAL || OPENCODE_ENABLE_EXA ||
// OPENCODE_EXPERIMENTAL_EXA`,所以 main 把四个 keyless 专用 flag 覆盖写 `"0"` 之后 umbrella 仍
// 让 `webSearchEnabled()` 注册本地 `websearch` —— 代付态本地+云双活,kill-switch 下云暗而本地仍活。
// 这里跑的是**真实生产 composition**(真 injectAlphaConfig、真密钥文件、真 env),
// 不预置 config.permission。
describe("web search 主权在 umbrella 下仍成立(#223 Blocker)", () => {
  /** main 侧 syncSecretFiles 落盘的登录态 + 主权闸对四个 keyless flag 的 force-off。 */
  const givenPlatformPaysUnderUmbrella = () => {
    givenLoggedInWithByok()
    plantSecret("ALPHA_CLOUD_TOKEN", "cloud-token")
    process.env.ALPHA_CLOUD_MCP_URL = "https://cloud.example/mcp"
    process.env.OPENCODE_EXPERIMENTAL = "1" // 用户 shell 的真 export —— env 层压不掉
    process.env.OPENCODE_ENABLE_EXA = "0" // 主权闸已经写过 "0",仍不足以关闭工具
  }

  /** ext bundle 的真实落点替身(注入只把路径合并进 config.plugin,不读文件内容)。 */
  const extPluginPath = () => {
    const file = path.join(tmp, "alpha-ext", "plugin.js")
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, "export default async () => ({})\n")
    return file
  }

  const injectedPermissions = () => {
    const config: {
      permission?: Record<string, unknown>
      agent?: Record<string, { permission?: Record<string, unknown> }>
      mcp?: Record<string, unknown>
    } = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT!)
    return config
  }

  test("平台代付:本地 websearch 被 deny,云工具与兄弟云工具照常在册", () => {
    givenPlatformPaysUnderUmbrella()

    injectAlphaConfig(userData, undefined, "stable")

    const config = injectedPermissions()
    expect(config.permission?.websearch).toBe("deny")
    // 云工具是代付态的权威 web search —— 不许被顺手关掉。
    expect(config.permission?.[CLOUD_WEB_SEARCH_TOOL_ID]).toBeUndefined()
    expect(config.mcp?.cloud).toBeDefined()
    // agent 级规则排在全局之后:三个 alpha agent 若还写着 allow,全局 deny 对它们无效。
    for (const [name, agent] of Object.entries(config.agent ?? {}))
      expect([name, agent.permission?.websearch]).toEqual([name, "deny"])
  })

  // #223 R4→R5:kill-switch 下云 server 的**完整定义根本不进配置**,只经 ARM/DEF 两个 env 托管给
  // @alpha-code/ext(见 packages/ext/src/cloud-websearch-kill.ts)。R4 那版写一个 `enabled:false`
  // 的条目 —— R5 判其为回归:`MCP.connect()` 会无条件把它复制成 `enabled:true`,而该能力公开为
  // `/mcp/:name/connect` 且产品 UI 真的在调,于是 ext 缺席时用户点一下就能热连起来。
  for (const [name, ext] of [
    ["ext bundle 路径已解析", true],
    ["ext bundle 路径缺席", false],
  ] as const)
    test(`kill-switch(${name}):配置里没有云 server 定义,本地与云两个 web search 都被 deny`, () => {
      givenPlatformPaysUnderUmbrella()
      process.env.ALPHA_WEBSEARCH_DISABLE = "1"
      const errors: unknown[][] = []
      const original = console.error
      console.error = (...args: unknown[]) => void errors.push(args)
      try {
        injectAlphaConfig(userData, ext ? extPluginPath() : undefined, "stable")
      } finally {
        console.error = original
      }

      const config = injectedPermissions()
      expect(config.permission?.websearch).toBe("deny")
      expect(config.permission?.[CLOUD_WEB_SEARCH_TOOL_ID]).toBe("deny")
      expect(config.permission?.[CLOUD_DISPATCH_TOOL_ID]).toBeUndefined()
      // 一个字节的可复活定义都不留:配置里只有那份中和条目(#223 R6 Major:它必须在,
      // 否则继承来源里的同名定义压根不会被覆盖),没有真 URL、没有 Authorization 头。
      expect(config.mcp?.cloud).toEqual({ ...WITHHELD_CLOUD_MCP })
      expect(process.env.OPENCODE_CONFIG_CONTENT).not.toContain("cloud.example")
      expect(process.env.OPENCODE_CONFIG_CONTENT).not.toContain("Authorization")
      // 定义只在 env 里托管,ext 的 config 钩子跑起来才装。
      expect(process.env[CLOUD_MCP_ARM_ENV]).toBe("cloud")
      expect(JSON.parse(process.env[CLOUD_MCP_DEF_ENV]!)).toMatchObject({
        type: "remote",
        url: "https://cloud.example/mcp",
      })
      // `#733`:A6 从「引用而非明文」升级成**根本没有凭证通道** —— 云 MCP 走标准 OAuth,
      // 托管定义里既没有 token 值,也没有 {file:} 引用可解。
      expect(process.env[CLOUD_MCP_DEF_ENV]).not.toContain("{file:")
      expect(process.env[CLOUD_MCP_DEF_ENV]).not.toContain("Authorization")
      expect(process.env[CLOUD_MCP_DEF_ENV]).not.toContain("cloud-token")
      expect(process.env[CLOUD_MCP_SERVER_ENV]).toBe("cloud")
      expect(errors.flat().join("\n")).toContain("WITHHELD from the engine config")
    })

  // #223 R6 Major:R5 只从继承来的 OPENCODE_CONFIG_CONTENT 对象里删键,而引擎的深合并里
  // 「缺少 cloud 键」不会删除 global / alpha.jsonc / 项目 / managed 里先前来源的定义。所以现在
  // 写的是一份压过去的中和条目 —— 深合并里它覆盖的是**连接控制字段**(type/url/enabled/oauth;
  // 继承的 headers/timeout 会留下,#223 R7 措辞更正,URL 已不可用故无处可发)。多源那一半由
  // packages/opencode/test/mcp/alpha-cloud-mcp-multisource.test.ts 用真实 Config 加载证。
  test("kill-switch:继承来的同名云条目被中和条目压掉(连接控制字段)", () => {
    givenPlatformPaysUnderUmbrella()
    process.env.ALPHA_WEBSEARCH_DISABLE = "1"
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      mcp: {
        cloud: {
          type: "remote",
          url: "https://inherited.example/mcp",
          enabled: true,
          headers: { Authorization: "Bearer inherited" },
        },
      },
    })

    injectAlphaConfig(userData, undefined, "stable")

    expect(injectedPermissions().mcp?.cloud).toEqual({ ...WITHHELD_CLOUD_MCP })
    expect(process.env.OPENCODE_CONFIG_CONTENT).not.toContain("inherited.example")
    expect(process.env.OPENCODE_CONFIG_CONTENT).not.toContain("Bearer inherited")
  })

  test("代付但无 kill-switch 时:云 server 直接可用,只托管 def 身份、不置位 arm(不依赖 ext 装载)", () => {
    givenPlatformPaysUnderUmbrella()

    injectAlphaConfig(userData, undefined, "stable")

    expect(injectedPermissions().mcp?.cloud).toMatchObject({ type: "remote", enabled: true })
    // ARM 不置位 ⇒ ext 的 installCloudMcp 什么都不装(ARM/DEF 必须成对)。
    expect(process.env[CLOUD_MCP_ARM_ENV]).toBeUndefined()
    // #223 R6 Blocker:治理豁免绑定的是 DEF 里那份定义的端点身份,所以代付两条分支都托管它。
    expect(JSON.parse(process.env[CLOUD_MCP_DEF_ENV]!)).toMatchObject({
      type: "remote",
      url: "https://cloud.example/mcp",
    })
    // `#733`:同上 —— 托管定义里没有任何凭证通道。
    expect(process.env[CLOUD_MCP_DEF_ENV]).not.toContain("{file:")
    expect(process.env[CLOUD_MCP_DEF_ENV]).not.toContain("Authorization")
    expect(process.env[CLOUD_MCP_DEF_ENV]).not.toContain("cloud-token")
    // 闸要能把「alpha 治理的云 server」与用户自带的 web-search MCP 区分开(R5 Blocker)。
    expect(process.env[CLOUD_MCP_SERVER_ENV]).toBe("cloud")
  })

  // 握手通道的可信度**不**来自 sidecar-env 白名单(逃生阀 ALPHA_ENV_ALLOWLIST_EXTRA 能放行它,
  // 见 sidecar-env.test.ts 的同名事实),而来自:注入面在每次 fork 的每条分支上覆盖或删除它们。
  test("继承/伪造的 arm+def 变量在每条分支上都被注入面覆盖或清掉", () => {
    givenPlatformPaysUnderUmbrella()
    process.env[CLOUD_MCP_ARM_ENV] = "forged"
    process.env[CLOUD_MCP_DEF_ENV] = JSON.stringify({ type: "remote", url: "https://attacker.example/mcp" })
    process.env[CLOUD_MCP_SERVER_ENV] = "forged"

    // ① 代付、无 kill-switch:ARM 被删,DEF/SERVER 被覆盖成 alpha 自己的值(伪造的 URL 不剩)。
    injectAlphaConfig(userData, undefined, "stable")
    expect(process.env[CLOUD_MCP_ARM_ENV]).toBeUndefined()
    expect(process.env[CLOUD_MCP_DEF_ENV]).not.toContain("attacker.example")
    expect(process.env[CLOUD_MCP_DEF_ENV]).toContain("cloud.example")
    expect(process.env[CLOUD_MCP_SERVER_ENV]).toBe("cloud")

    // ② kill-switch:被覆盖成 alpha 自己的名字与定义,伪造的 URL 一点不剩。
    process.env[CLOUD_MCP_ARM_ENV] = "forged"
    process.env[CLOUD_MCP_DEF_ENV] = JSON.stringify({ type: "remote", url: "https://attacker.example/mcp" })
    process.env.ALPHA_WEBSEARCH_DISABLE = "1"
    injectAlphaConfig(userData, undefined, "stable")
    expect(process.env[CLOUD_MCP_ARM_ENV]).toBe("cloud")
    expect(process.env[CLOUD_MCP_DEF_ENV]).not.toContain("attacker.example")

    // ③ 登出 / BYOK(不代付):三个都被删,伪造的通道彻底失效。
    delete process.env.ALPHA_CLOUD_MCP_URL
    injectAlphaConfig(userData, undefined, "stable")
    expect(process.env[CLOUD_MCP_ARM_ENV]).toBeUndefined()
    expect(process.env[CLOUD_MCP_DEF_ENV]).toBeUndefined()
    expect(process.env[CLOUD_MCP_SERVER_ENV]).toBeUndefined()
  })

  test("登出/BYOK:keyless 本地 websearch 保持可用(不误伤登出兜底)", () => {
    givenLoggedInWithByok()
    process.env.OPENCODE_EXPERIMENTAL = "1"

    injectAlphaConfig(userData, undefined, "stable")

    const config = injectedPermissions()
    expect(config.permission?.websearch).toBeUndefined()
    for (const agent of Object.values(config.agent ?? {})) expect(agent.permission?.websearch).toBe("allow")
  })
})
