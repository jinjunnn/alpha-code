// #535 / REQ-109 T6:G1 用户全局 MCP default-deny。
// 全部使用真临时目录;无网络、无 HOME 改写。仅不可读分支注入 readFile 以稳定模拟 EACCES。
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { injectMcpDefaultDeny } from "./mcp-default-deny"

let root: string
let alphaConfigPath: string
let userConfigDir: string
let logs: string[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mcp-default-deny-"))
  alphaConfigPath = join(root, "alpha.jsonc")
  userConfigDir = join(root, "real-user-config")
  mkdirSync(userConfigDir, { recursive: true })
  writeFileSync(alphaConfigPath, "{}")
  logs = []
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const apply = (
  config: { mcp?: Record<string, unknown> },
  options: Partial<Parameters<typeof injectMcpDefaultDeny>[1]> = {},
) =>
  injectMcpDefaultDeny(config, {
    alphaConfigPath,
    userConfigDir,
    logError: (message) => logs.push(message),
    ...options,
  })

describe("injectMcpDefaultDeny — G1 default-deny", () => {
  test("枚举三个用户全局文件的 mcp 并集,非治理项注入 lone enabled:false", () => {
    writeFileSync(join(userConfigDir, "config.json"), JSON.stringify({ mcp: { fetch: { type: "local" } } }))
    writeFileSync(join(userConfigDir, "opencode.json"), JSON.stringify({ mcp: { github: { type: "local" } } }))
    writeFileSync(join(userConfigDir, "opencode.jsonc"), JSON.stringify({ mcp: { markitdown: { type: "local" } } }))
    const config: { mcp?: Record<string, unknown> } = {}

    apply(config)

    expect(config.mcp).toEqual({
      fetch: { enabled: false },
      github: { enabled: false },
      markitdown: { enabled: false },
    })
    expect(logs).toEqual([
      '[req109-535] default-denied user-global MCP names=["fetch","github","markitdown"]',
    ])
  })

  test("回归:仅写 G1 denial,alpha.jsonc 治理项不复制且既有 cloud/injected 不写 timeout", () => {
    writeFileSync(
      alphaConfigPath,
      JSON.stringify({ mcp: { governed: { type: "local", command: ["alpha-governed"] } } }),
    )
    writeFileSync(
      join(userConfigDir, "config.json"),
      JSON.stringify({
        mcp: {
          governed: { type: "local", command: ["global-collision"] },
          cloud: { type: "remote", url: "https://user.example/mcp" },
          injected: { type: "local", command: ["global-collision"] },
          stray: { type: "local", command: ["stray"] },
        },
      }),
    )
    const config = {
      mcp: {
        cloud: { type: "remote", url: "https://alpha.example/mcp", enabled: true },
        injected: { type: "local", command: ["alpha-injected"] },
      } as Record<string, unknown>,
    }

    // #223 R6:`cloud` 不再被写死成治理名 —— 注入面真放进 config.mcp 时才把它报进 injectedMcpNames
    // (代付的两条分支都会,kill-switch 下放的是中和条目)。
    apply(config, { injectedMcpNames: ["injected", "cloud"] })

    expect(config.mcp.governed).toBeUndefined()
    expect(config.mcp.cloud).toEqual({
      type: "remote",
      url: "https://alpha.example/mcp",
      enabled: true,
    })
    expect(config.mcp.injected).toEqual({
      type: "local",
      command: ["alpha-injected"],
    })
    expect(config.mcp.stray).toEqual({ enabled: false })
    expect(
      Object.values(config.mcp).every(
        (value) =>
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          !Object.hasOwn(value, "timeout"),
      ),
    ).toBe(true)
  })

  // #223 R6 Major:名字不是治理凭据。以前 `"cloud"` 是写死的治理名,于是**不代付时**用户全局配置
  // 里一个自称 cloud 的第三方 server 被永久豁免默认拒绝 —— 连 enabled:false 都不写。
  test("回归:注入面这一轮没放 cloud 时,用户全局的同名 server 照样进默认拒绝", () => {
    writeFileSync(alphaConfigPath, JSON.stringify({ mcp: {} }))
    writeFileSync(
      join(userConfigDir, "config.json"),
      JSON.stringify({ mcp: { cloud: { type: "remote", url: "https://user.example/mcp" } } }),
    )
    const config: { mcp?: Record<string, unknown> } = {}

    apply(config, {})

    expect(config.mcp!.cloud).toEqual({ enabled: false })
  })
})

describe("injectMcpDefaultDeny — JSONC 与失败隔离", () => {
  test("comments/trailing commas 可解析;坏 JSONC 与不可读文件各自跳过,其余文件继续", () => {
    writeFileSync(join(userConfigDir, "config.json"), '{"mcp":{"broken":')
    writeFileSync(join(userConfigDir, "opencode.json"), JSON.stringify({ mcp: { unreadable: {} } }))
    writeFileSync(
      join(userConfigDir, "opencode.jsonc"),
      `{
        // user-global local tool
        "mcp": {
          "jsonc-ok": {
            "type": "local",
            "command": ["uvx", "safe-name"],
          },
        },
      }`,
    )
    const config: { mcp?: Record<string, unknown> } = {}
    const readFile = (file: string) => {
      if (basename(file) === "opencode.json") {
        const error = new Error("denied") as NodeJS.ErrnoException
        error.code = "EACCES"
        throw error
      }
      return readFileSync(file, "utf8")
    }

    expect(() => apply(config, { readFile })).not.toThrow()
    expect(config.mcp).toEqual({ "jsonc-ok": { enabled: false } })
    expect(logs.some((message) => message.includes("unparseable user-global MCP config skipped"))).toBe(true)
    expect(logs.some((message) => message.includes("unreadable user-global MCP config skipped"))).toBe(true)
    expect(logs.at(-1)).toBe('[req109-535] default-denied user-global MCP names=["jsonc-ok"]')
  })

  test("显式真实用户目录优先,完全忽略 OPENCODE_CONFIG_DIR decoy", () => {
    const saved = process.env.OPENCODE_CONFIG_DIR
    const decoy = join(root, "decoy")
    mkdirSync(decoy)
    writeFileSync(join(decoy, "config.json"), JSON.stringify({ mcp: { decoy: {} } }))
    writeFileSync(join(userConfigDir, "config.json"), JSON.stringify({ mcp: { real: {} } }))
    process.env.OPENCODE_CONFIG_DIR = decoy
    const config: { mcp?: Record<string, unknown> } = {}
    try {
      apply(config)
    } finally {
      if (saved === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = saved
    }

    expect(config.mcp).toEqual({ real: { enabled: false } })
    expect(config.mcp?.decoy).toBeUndefined()
  })

  test("空或不存在的用户全局目录 no-op 且不抛", () => {
    const config = { mcp: { keep: { type: "local" } } as Record<string, unknown> }

    expect(() => apply(config, { userConfigDir: join(root, "missing") })).not.toThrow()
    expect(config.mcp).toEqual({ keep: { type: "local" } })
    expect(logs).toEqual([])
  })
})
