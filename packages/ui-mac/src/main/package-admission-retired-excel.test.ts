import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { AlphaPackageEnvelopeV1 } from "../shared/host-extension-package-contract/decoder"
import { createPackageAdmissionCoordinator } from "./package-admission"

const snapshotDigest = "7".repeat(64)
let tmp = ""
let root = ""
let userDataPath = ""
const previousRoot = process.env.ALPHA_GLOBAL_DIR

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "package-admission-retired-excel-"))
  root = join(tmp, "root")
  userDataPath = join(tmp, "user-data")
  mkdirSync(root, { recursive: true })
  process.env.ALPHA_GLOBAL_DIR = root
})

afterEach(() => {
  if (previousRoot === undefined) delete process.env.ALPHA_GLOBAL_DIR
  else process.env.ALPHA_GLOBAL_DIR = previousRoot
  rmSync(tmp, { recursive: true, force: true })
})

type McpPackageInput = {
  packageId: string
  componentId: string
  profileId?: "mcp-local" | "mcp-remote"
  command?: string[]
}

function mcpPackage(input: McpPackageInput) {
  const profileId = input.profileId ?? "mcp-local"
  const payload =
    profileId === "mcp-local"
      ? {
          schema: "alpha.host-extension-package.payload.mcp-local.v1",
          behavior: { command: input.command ?? ["uvx", "unrelated-mcp"], environment: {}, requiredSecrets: [] },
        }
      : {
          schema: "alpha.host-extension-package.payload.mcp-remote.v1",
          behavior: { url: "https://mcp.example.com/", headersTemplate: {}, requiredSecrets: [], auth: "none" },
        }
  const bytes = new TextEncoder().encode(`${JSON.stringify(payload, null, 2)}\n`)
  const envelope = {
    schema: "alpha.host-extension-package.v1",
    prelude: { packageId: input.packageId, version: "1.0.0" },
    presentation: { displayName: "MCP", description: "Synthetic MCP admission case" },
    root: input.componentId,
    components: [
      {
        id: input.componentId,
        required: true,
        dependencies: [],
        profileId,
        profileVersion: 1,
        capabilities: [],
        payloadRef: {
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.byteLength,
          mediaType: `application/vnd.alpha.host-extension-package.${profileId}.v1+json`,
          url: "https://alphacodeone.com/catalog/assets/local-mcp/1.0.0/alpha-package/payload.json",
        },
      },
    ],
    capabilities: [],
  } as unknown as AlphaPackageEnvelopeV1
  return { bytes, envelope }
}

async function admitMcp(input: McpPackageInput) {
  const fixture = mcpPackage(input)
  let transactionCalls = 0
  const admit = createPackageAdmissionCoordinator({
    loadVerifiedCatalog: async () => ({
      source: "remote",
      catalog: { version: "1", entries: [{}], packages: [fixture.envelope] },
      snapshotDigest,
    }),
    root: () => root,
    userDataPath,
    casBaseRoot: () => userDataPath,
    environment: () => "dev",
    installability: { fetchPayload: async () => fixture.bytes },
    transaction: async () => {
      transactionCalls++
      throw new Error("retired package must not reach the transaction")
    },
  })
  const result = await admit({
    catalogId: input.packageId,
    scope: { scope: "global" },
    attemptId: `attempt-${input.packageId.replaceAll(":", "-")}-${input.componentId.replaceAll(":", "-")}`,
  })
  return { result, transactionCalls }
}

describe("package admission retired community Excel guard (REQ-135)", () => {
  test.each([
    {
      label: "legacy catalog identity",
      packageId: "mcp:excel",
      componentId: "mcp:renamed-sheets",
      command: ["uvx", "unrelated-mcp"],
    },
    {
      label: "legacy component identity",
      packageId: "package:legacy-excel-component",
      componentId: "mcp:excel",
      command: ["uvx", "unrelated-mcp"],
    },
    {
      label: "legacy server name",
      packageId: "package:legacy-excel-name",
      componentId: "mcp:excel-mcp-server",
      command: ["uvx", "unrelated-mcp"],
    },
    {
      label: "legacy catalog identity on a remote MCP profile",
      packageId: "mcp:excel",
      componentId: "mcp:renamed-remote-sheets",
      profileId: "mcp-remote" as const,
    },
    {
      label: "legacy server name on a remote MCP profile",
      packageId: "package:legacy-remote-excel-name",
      componentId: "mcp:excel-mcp-server",
      profileId: "mcp-remote" as const,
    },
    {
      label: "renamed component invoking the retired distribution",
      packageId: "package:renamed-community-excel",
      componentId: "mcp:renamed-sheets",
      command: ["uvx", "excel-mcp-server@0.1.8", "stdio"],
    },
  ])("refuses $label before authorization or durable writes", async ({ label: _label, ...input }) => {
    const admitted = await admitMcp(input)
    expect(admitted.result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("excel-mcp-server is retired"),
    })
    expect(admitted.result).not.toMatchObject({ stage: "authorize" })
    expect(admitted.transactionCalls).toBe(0)
    expect(readdirSync(root)).toEqual([])
  })

  test.each([
    {
      label: "first-party Alpha Excel",
      packageId: "mcp:alpha-excel",
      componentId: "mcp:alpha-excel",
      command: ["uv", "run", "/Applications/Alpha/office-mcp/server.py", "excel", "/tmp/workspace"],
    },
    {
      label: "an unrelated similarly named package",
      packageId: "package:excel-helper",
      componentId: "mcp:excel-helper",
      command: ["uvx", "excel-mcp-serverless"],
    },
  ])("does not reject $label", async ({ label: _label, ...input }) => {
    const admitted = await admitMcp(input)
    expect(admitted.result).toMatchObject({ ok: false, stage: "authorize" })
    expect(admitted.transactionCalls).toBe(0)
  })
})
