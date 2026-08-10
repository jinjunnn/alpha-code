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

const identity = (origin: string, name: string): ToolIdentity => ({ source: "mcp", origin, name })

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
      kind: "alpha-cloud",
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
    expect(oauthAuthority.kind).toBe("alpha-cloud")
    if (oauthAuthority.kind === "alpha-cloud") {
      const plain = authorityForMcp("cloud", { type: "remote", url: "https://cloud.example/mcp" }, verified)
      expect(plain.kind).toBe("alpha-cloud")
      if (plain.kind === "alpha-cloud") expect(oauthAuthority.evidenceDigest).not.toBe(plain.evidenceDigest)
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
        authority: { kind: "alpha-cloud", bindingId: "mcp:cloud" },
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
    expect(
      workflowPreapprovedToolNames(tools, [{ permission: "mcp:server:remote_name", pattern: "*", action: "ask" }]),
    ).toEqual([])
    expect(workflowPreapprovedToolNames(tools, [{ permission: "visible_alias", pattern: "*", action: "ask" }])).toEqual(
      ["visible_alias"],
    )
  })
})
