import { describe, expect, test } from "bun:test"
import {
  ToolAliasCollisionError,
  ToolAliasLedger,
  ToolDisplaySnapshotV1,
  canonicalToolIdentity,
  parseToolIdentity,
  type ToolIdentity,
} from "@opencode-ai/schema/tool-identity"
import { authorityForMcp } from "../../src/mcp"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Permission } from "../../src/permission"
import { Schema } from "effect"
import { workflowPreapprovedToolNames } from "../../src/session/llm"
import { attachToolDisplay, getToolDisplay } from "../../src/session/tool-display"
import type { Tool as AITool } from "ai"
import { SessionPrompt } from "../../src/session/prompt"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { governedMcpEvidence } from "@opencode-ai/plugin/alpha-cloud-authority"
import { ConfigVariable } from "../../src/config/variable"
import { ConfigParse } from "../../src/config/parse"
import { materializeCloudMcpConfig } from "../../../ui-mac/src/main/cloud-sidecar-config"
import { installCloudMcp } from "../../../ext/src/cloud-websearch-kill"
import { OFFICE_MCP_MANIFEST_ENV } from "../../src/mcp/alpha-first-party-mcp"
import {
  ALPHA_OFFICE_PYTHON_SLOT,
  ALPHA_OFFICE_SERVER_SLOT,
  alphaOfficeInstallCommand,
  type AlphaOfficeFormat,
} from "../../../ui-mac/src/shared/office-advisories"

const INJECTION_MODULE = path.resolve(import.meta.dir, "..", "..", "..", "ui-mac", "src", "main", "alpha-config-injection.ts")
const { injectAlphaConfig } = (await import(INJECTION_MODULE)) as {
  injectAlphaConfig: (userDataPath: string) => { ok: boolean }
}

const identity = (origin: string, name: string): ToolIdentity => ({ source: "mcp", origin, name })

/**
 * #1578 AC1:一个临时应用包的 Resources —— 入库的 `resources/office-mcp/server.py` 与 `tools.json`(构建期从 server.py
 * 导出的随包清单)原样拷贝;条目命令由生产的 `alphaOfficeInstallCommand` 产出,两个资源槽换成这个包(main 写策略
 * 同一种替换,`{workspace}` 原样)。env 只有 main 在 fork 时注入的那一个键。
 */
function officeBundle(tmp: string) {
  const shipped = path.join(import.meta.dir, "..", "..", "..", "ui-mac", "resources", "office-mcp")
  const resources = path.join(tmp, "Code Puppy.app", "Contents", "Resources")
  const office = path.join(resources, "office-mcp")
  fs.mkdirSync(office, { recursive: true })
  for (const file of ["server.py", "tools.json"]) fs.copyFileSync(path.join(shipped, file), path.join(office, file))
  const python = path.join(resources, "office-runtime", "bin", "python3")
  const server = path.join(office, "server.py")
  return {
    server,
    env: { [OFFICE_MCP_MANIFEST_ENV]: path.join(office, "tools.json") },
    entry: (format: AlphaOfficeFormat, extra: string[] = []) => ({
      type: "local" as const,
      command: [
        ...alphaOfficeInstallCommand(format).map((token) =>
          token === ALPHA_OFFICE_PYTHON_SLOT ? python : token === ALPHA_OFFICE_SERVER_SLOT ? server : token,
        ),
        ...extra,
      ],
    }),
  }
}

/**
 * #1576 AC1:生产注入形状 —— 真 `injectAlphaConfig` 写出 `OPENCODE_CONFIG_CONTENT` 与同次的
 * `ALPHA_CLOUD_MCP_DEF`,再经引擎真 `ConfigVariable.substitute`(`{file:}` 在文本阶段换成令牌)、
 * 真 jsonc 解析与 MCP 条目 schema 得到装载后的 `cloud` 条目;kill-switch 分支则由 ext 的真
 * `installCloudMcp` 写回。返回装载条目与那一刻的 env 快照。整个 process.env 在调用前后还原。
 */
async function productionCloudEntry(input: { killSwitch: boolean; token: string; tmp: string }) {
  const saved = { ...process.env }
  try {
    process.env.ALPHA_GLOBAL_DIR = path.join(input.tmp, "alpha-code-state", "env", "dev")
    process.env.XDG_CONFIG_HOME = path.join(input.tmp, "xdg")
    process.env.ALPHA_OPENCODE_HOME = path.join(input.tmp, "opencode-home")
    process.env.XDG_DATA_HOME = path.join(input.tmp, "xdg-data")
    process.env.ALPHA_CLOUD_MCP_URL = "https://cloud.example/mcp"
    delete process.env.OPENCODE_CONFIG_CONTENT
    delete process.env.ALPHA_CLOUD_MCP_ARM
    if (input.killSwitch) process.env.ALPHA_WEBSEARCH_DISABLE = "1"
    else delete process.env.ALPHA_WEBSEARCH_DISABLE
    const userData = path.join(input.tmp, "userdata")
    fs.mkdirSync(path.join(userData, "alpha-secrets"), { recursive: true })
    fs.writeFileSync(path.join(userData, "alpha-secrets", "ALPHA_MCP_TOKEN"), `${input.token}\n`)
    expect(injectAlphaConfig(userData).ok).toBe(true)
    const env = { ...process.env }
    const text = await ConfigVariable.substitute({
      text: env.OPENCODE_CONFIG_CONTENT!,
      type: "virtual",
      source: "OPENCODE_CONFIG_CONTENT",
      dir: input.tmp,
    })
    const cfg = ConfigParse.jsonc(text, "OPENCODE_CONFIG_CONTENT") as { mcp: Record<string, unknown> }
    if (input.killSwitch) expect(installCloudMcp(cfg, env)).toBe("codepuppy")
    const entry = Schema.decodeUnknownSync(ConfigMCPV1.Info)(cfg.mcp.codepuppy)
    return { entry, env }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
  }
}

describe("stable tool identity", () => {
  test("canonical form is injective and reversible across the wildcard grammar", () => {
    const values = [
      identity("cloud", "web_search"),
      identity("a:b", "c"),
      identity("a", "b:c"),
      identity("srv", "name*with?wildcards"),
      identity("srv\\windows", "path/to/tool"),
      identity("percent%server", "%tool"),
    ]
    const canonical = values.map(canonicalToolIdentity)
    expect(new Set(canonical).size).toBe(values.length)
    expect(canonical.map(parseToolIdentity)).toEqual(values)
    for (let left = 0; left < canonical.length; left += 1)
      for (let right = 0; right < canonical.length; right += 1)
        expect(Wildcard.match(canonical[left]!, canonical[right]!)).toBe(left === right)
  })

  test("parser rejects malformed, non-normalized, and empty-name identities", () => {
    for (const value of [
      "mcp:only-two",
      "mcp:too:many:segments",
      "unknown:srv:tool",
      "mcp:srv:",
      "mcp:srv:%",
      "mcp:srv:%2a",
      "mcp:srv:%41",
    ])
      expect(() => parseToolIdentity(value)).toThrow()
  })

  test("alias ledger rejects lossy aliases, case peers, and one identity under two aliases", () => {
    const ledger = new ToolAliasLedger()
    ledger.add("foo_bar_baz", identity("foo.bar", "baz"))
    expect(() => ledger.add("foo_bar_baz", identity("foo_bar", "baz"))).toThrow(ToolAliasCollisionError)

    const caseLedger = new ToolAliasLedger()
    caseLedger.add("upper", identity("srv", "Tool"))
    expect(() => caseLedger.add("lower", identity("srv", "tool"))).toThrow(ToolAliasCollisionError)

    const reverseLedger = new ToolAliasLedger()
    reverseLedger.add("first", identity("srv", "tool"))
    expect(() => reverseLedger.add("second", identity("srv", "tool"))).toThrow(ToolAliasCollisionError)
  })

  test("Alpha Cloud authority requires the injected definition proof, not descriptive cues", () => {
    const verified = {
      ALPHA_CLOUD_MCP_SERVER: "cloud",
      ALPHA_CLOUD_MCP_DEF: JSON.stringify({ type: "remote", url: "https://cloud.example/mcp" }),
    }
    expect(authorityForMcp("cloud", { type: "remote", url: "https://cloud.example/mcp" }, verified)).toEqual({
      kind: "codepuppy-cloud",
      bindingId: "mcp:cloud",
      evidenceDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    })

    expect(
      authorityForMcp(
        "cloud",
        {
          type: "remote",
          url: "https://attacker.example/mcp",
          headers: { title: "Alpha Cloud", icon: "cloud", annotation: "official" },
        },
        verified,
      ),
    ).toEqual({ kind: "not-asserted" })
    expect(authorityForMcp("cloud", { type: "remote", url: "https://cloud.example/mcp" }, {})).toEqual({
      kind: "not-asserted",
    })
    expect(
      authorityForMcp(
        "cloud",
        { type: "remote", url: "https://cloud.example/mcp", headers: { title: "Alpha Cloud" } },
        verified,
      ),
    ).toEqual({ kind: "not-asserted" })

    const oauthVerified = {
      ...verified,
      ALPHA_CLOUD_MCP_DEF: JSON.stringify({
        type: "remote",
        url: "https://cloud.example/mcp",
        oauth: { clientId: "verified-client" },
      }),
    }
    const oauthAuthority = authorityForMcp(
      "cloud",
      {
        type: "remote",
        url: "https://cloud.example/mcp",
        oauth: { clientId: "verified-client" },
      },
      oauthVerified,
    )
    expect(oauthAuthority.kind).toBe("codepuppy-cloud")
    if (oauthAuthority.kind === "codepuppy-cloud") {
      const plain = authorityForMcp("cloud", { type: "remote", url: "https://cloud.example/mcp" }, verified)
      expect(plain.kind).toBe("codepuppy-cloud")
      if (plain.kind === "codepuppy-cloud") expect(oauthAuthority.evidenceDigest).not.toBe(plain.evidenceDigest)
    }
  })

  test("#1576 AC1: the production injected shape (file-referenced Authorization, token literal after load) is alpha-cloud", () => {
    const ref = "{file:/x/alpha-secrets/ALPHA_MCP_TOKEN}"
    const def = materializeCloudMcpConfig("https://cloud.example/mcp", ref)
    const env = { ALPHA_CLOUD_MCP_SERVER: "cloud", ALPHA_CLOUD_MCP_DEF: JSON.stringify(def) }
    const loaded = { ...def, headers: { Authorization: "Bearer tok-literal-1" } }
    expect(authorityForMcp("cloud", loaded, env)).toEqual({
      kind: "codepuppy-cloud",
      bindingId: "mcp:cloud",
      evidenceDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    })
  })

  test("#1576 AC1: real injectAlphaConfig → real ConfigVariable.substitute → authorityForMcp is alpha-cloud (production and kill-switch)", async () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alpha-1576-inject-")))
    try {
      for (const killSwitch of [false, true]) {
        const { entry, env } = await productionCloudEntry({ killSwitch, token: "tok-wired-1", tmp })
        // 对照:装载后的条目确实带着令牌字面量(否则这条用例测的不是断点)。
        expect(entry.type === "remote" && entry.headers?.Authorization).toBe("Bearer tok-wired-1")
        expect(env.ALPHA_CLOUD_MCP_DEF).toContain("{file:")
        expect(authorityForMcp("codepuppy", entry, env).kind).toBe("codepuppy-cloud")
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("#1576 AC2: URL, type, other header, key-set or non-reference header mismatch is not-asserted", () => {
    const def = materializeCloudMcpConfig("https://cloud.example/mcp", "{file:/x/ALPHA_MCP_TOKEN}")
    const env = { ALPHA_CLOUD_MCP_SERVER: "cloud", ALPHA_CLOUD_MCP_DEF: JSON.stringify(def) }
    const loaded = { ...def, headers: { Authorization: "Bearer tok" } }
    expect(authorityForMcp("cloud", loaded, env).kind).toBe("codepuppy-cloud")
    const notAsserted = { kind: "not-asserted" as const }
    // URL 不同
    expect(authorityForMcp("cloud", { ...loaded, url: "https://attacker.example/mcp" }, env)).toEqual(notAsserted)
    // 类型不同
    expect(authorityForMcp("cloud", { type: "local", command: ["cloud"] }, env)).toEqual(notAsserted)
    // 多一个 header
    expect(
      authorityForMcp("cloud", { ...loaded, headers: { Authorization: "Bearer tok", "X-Extra": "1" } }, env),
    ).toEqual(notAsserted)
    // 被引用的 header 不是字符串 / 缺席
    expect(authorityForMcp("cloud", { ...loaded, headers: {} }, env)).toEqual(notAsserted)
    // 键集合不同(多一个 timeout)
    expect(authorityForMcp("cloud", { ...loaded, timeout: 30_000 }, env)).toEqual(notAsserted)
    // 注入定义的 header 不是文件引用:值不同就不成立,值相同才成立
    const literalDef = { ...def, headers: { Authorization: "Bearer pinned" } }
    const literalEnv = { ...env, ALPHA_CLOUD_MCP_DEF: JSON.stringify(literalDef) }
    expect(authorityForMcp("cloud", loaded, literalEnv)).toEqual(notAsserted)
    expect(authorityForMcp("cloud", literalDef, literalEnv).kind).toBe("codepuppy-cloud")
  })

  test("#1576 AC2: evidence carries no token value; bindingId and evidenceDigest survive token rotation", async () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alpha-1576-rotate-")))
    try {
      const before = await productionCloudEntry({ killSwitch: false, token: "tok-before-rotation", tmp })
      const after = await productionCloudEntry({ killSwitch: false, token: "tok-after-rotation", tmp })
      expect(before.entry).not.toEqual(after.entry)
      const evidence = governedMcpEvidence("codepuppy", before.entry, before.env)
      expect(evidence).toBeDefined()
      expect(evidence).not.toContain("tok-before-rotation")
      const a = authorityForMcp("codepuppy", before.entry, before.env)
      const b = authorityForMcp("codepuppy", after.entry, after.env)
      expect(a.kind).toBe("codepuppy-cloud")
      expect(b).toEqual(a)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  // #1578 AC1 成立臂:删掉 authorityForMcp 的 codepuppy-bundled 分支 ⇒ 这里是 not-asserted,当场红。
  test("#1578 AC1: a document-tool entry bound to the bundled manifest (command token-equal, server.py digest) is codepuppy-bundled", () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alpha-1578-bundled-")))
    try {
      const pack = officeBundle(tmp)
      for (const format of ["word", "excel", "powerpoint", "pdf"] as const) {
        const authority = authorityForMcp(`alpha-${format}`, pack.entry(format), pack.env)
        expect(authority).toEqual({
          kind: "codepuppy-bundled",
          bindingId: `mcp:alpha-${format}`,
          evidenceDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        })
        // 快照 schema 接受第三种 authority(随首个 ToolPart 持久化的那一份)。
        expect(
          Schema.decodeUnknownSync(ToolDisplaySnapshotV1)({
            identity: identity(`alpha-${format}`, "read"),
            technicalId: `alpha-${format}_read`,
            authority,
          }).authority,
        ).toEqual(authority)
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  // #1578 AC1 不成立臂:每一种都只差一处 —— 命令多一个 token / 少一个 token / server.py 多一个字节 / 没有清单 env。
  test("#1578 AC1: one extra or missing command token, a server.py one byte off, or no manifest is not-asserted", () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alpha-1578-refuted-")))
    try {
      const pack = officeBundle(tmp)
      const notAsserted = { kind: "not-asserted" } as const
      expect(authorityForMcp("codepuppy-word", pack.entry("word"), pack.env).kind).toBe("codepuppy-bundled")
      expect(authorityForMcp("codepuppy-word", pack.entry("word", ["--extra"]), pack.env)).toEqual(notAsserted)
      const short = pack.entry("word")
      expect(authorityForMcp("codepuppy-word", { ...short, command: short.command.slice(0, -1) }, pack.env)).toEqual(
        notAsserted,
      )
      expect(authorityForMcp("codepuppy-word", pack.entry("word"), {})).toEqual(notAsserted)
      fs.appendFileSync(pack.server, " ")
      expect(authorityForMcp("codepuppy-word", pack.entry("word"), pack.env)).toEqual(notAsserted)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("identity-axis deny removes the exact tool without falling back to its alias", () => {
    const subject = { technicalId: "search", identity: { source: "plugin", origin: "acme", name: "search" } as const }
    expect(
      Permission.disabled([subject], [{ permission: "plugin:acme:search", pattern: "*", action: "deny" }]),
    ).toEqual(new Set(["search"]))
    expect(
      Permission.disabled([subject], [{ permission: "plugin:other:search", pattern: "*", action: "deny" }]),
    ).toEqual(new Set())
  })

  test("incomplete authority snapshots are rejected instead of inferred", () => {
    const decode = Schema.decodeUnknownSync(ToolDisplaySnapshotV1)
    expect(() =>
      decode({
        identity: identity("cloud", "web_search"),
        technicalId: "cloud_web_search",
        authority: { kind: "codepuppy-cloud", bindingId: "mcp:cloud" },
      }),
    ).toThrow()
  })

  test("code mode contains no alias-prefix reverse resolver", async () => {
    const source = await Bun.file(new URL("../../src/tool/code-mode.ts", import.meta.url)).text()
    expect(source).toContain("tool.identity.origin")
    expect(source).toContain("tool.identity.name")
    expect(source).not.toContain('startsWith(name + "_")')
    expect(source).not.toMatch(/key\.slice\([^)]*server/)
  })

  test("first-write persistence has no live registry or catalog dependency", async () => {
    const source = await Bun.file(new URL("../../src/session/processor.ts", import.meta.url)).text()
    expect(source).not.toContain('from "@/mcp')
    expect(source).not.toContain('from "@/tool/registry')
    expect(source).not.toContain("McpCatalog")
    expect(source).toContain("ctx.toolDisplays[input.name]")
  })

  test("structured output enters the governed tool path with a complete host identity", () => {
    const structured = SessionPrompt.createStructuredOutputTool({ schema: { type: "object" }, onSuccess() {} })
    expect(getToolDisplay(structured)).toEqual({
      identity: { source: "host", origin: "", name: "StructuredOutput" },
      technicalId: "StructuredOutput",
      authority: { kind: "not-asserted" },
      location: { kind: "local" },
    })
  })

  test("workflow preapproval is keyed only by canonical identity", () => {
    const tools = {
      visible_alias: attachToolDisplay({} as AITool, {
        identity: { source: "mcp", origin: "server", name: "remote_name" },
        technicalId: "visible_alias",
        authority: { kind: "not-asserted" },
      }),
    }
    // #1129:第三参是策略文档轴动作(必传);本用例隔离 ruleset 轴 ⇒ 文档轴给 allow。
    const docAllow = new Map([["visible_alias", "allow" as const]])
    expect(
      workflowPreapprovedToolNames(tools, [{ permission: "mcp:server:remote_name", pattern: "*", action: "ask" }], docAllow),
    ).toEqual([])
    expect(
      workflowPreapprovedToolNames(tools, [{ permission: "visible_alias", pattern: "*", action: "ask" }], docAllow),
    ).toEqual(["visible_alias"])
    // 文档轴 fail-closed:动作缺席 = 不预批(与 ask/deny 同待遇)。
    expect(
      workflowPreapprovedToolNames(tools, [], new Map()),
    ).toEqual([])
    expect(
      workflowPreapprovedToolNames(tools, [], new Map([["visible_alias", "ask" as const]])),
    ).toEqual([])
  })
})
