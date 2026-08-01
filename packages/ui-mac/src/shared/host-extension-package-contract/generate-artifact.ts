#!/usr/bin/env bun

import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { PROFILE_REGISTRY_V1, type PackageProfileIdV1 } from "./registry"

export const HOST_EXTENSION_PACKAGE_ARTIFACT_PATH =
  "packages/ui-mac/src/shared/host-extension-package-contract"
export const HOST_EXTENSION_PACKAGE_ARTIFACT_MANIFEST = "host-extension-package-artifact.v1.json"
export const HOST_EXTENSION_PACKAGE_CORPUS = "testvectors/decoder-corpus.v1.json"

export const HOST_EXTENSION_PACKAGE_ARTIFACT_FILES = [
  "CONTRACT.md",
  "alpha-package-envelope-v1.schema.json",
  "decoder.ts",
  "generate-artifact.ts",
  "host-extension-package.registry.v1.json",
  "profiles/agent.v1.schema.json",
  "profiles/mcp-local.v1.schema.json",
  "profiles/mcp-remote.v1.schema.json",
  "profiles/skill.v1.schema.json",
  "registry.ts",
  "synthetic-decoder.ts",
  HOST_EXTENSION_PACKAGE_CORPUS,
] as const

type CorpusComponentCase = {
  /** Component id, so a consumer can bind a payload to a component without positional guessing. */
  id: string
  payload: Record<string, unknown> | null
}

type CorpusCase = {
  name: string
  expect: "accepted" | "blocked"
  /** Component ids the host is expected to skip. Empty for every single-component case. */
  skipped: string[]
  envelope: Record<string, unknown>
  components: CorpusComponentCase[]
}

type ArtifactManifestV1 = {
  schema: "alpha.host-extension-package.artifact.v1"
  artifactPath: typeof HOST_EXTENSION_PACKAGE_ARTIFACT_PATH
  artifactSha256: string
  files: Array<{ path: string; bytes: number; sha256: string }>
}

const root = dirname(fileURLToPath(import.meta.url))
const textEncoder = new TextEncoder()

type ComponentSpec = {
  id: string
  profileId: string
  required: boolean
  capabilities: string[]
  payload: Record<string, unknown> | null
  mediaType?: string
  profileVersion?: number
}

const skillPayload = (slug: string) => ({
  schema: "alpha.host-extension-package.payload.skill.v1",
  behavior: {
    targetDir: "alpha-skills",
    asset: {
      sha256: "1".repeat(64),
      bytes: 12,
      mediaType: "text/markdown",
      url: `https://example.invalid/assets/${slug}.md`,
    },
  },
})

const agentPayload = (slug: string) => ({
  schema: "alpha.host-extension-package.payload.agent.v1",
  behavior: {
    targetDir: "alpha-agents",
    asset: {
      sha256: "2".repeat(64),
      bytes: 12,
      mediaType: "text/markdown",
      url: `https://example.invalid/assets/${slug}.md`,
    },
  },
})

const mcpLocalPayload = () => ({
  schema: "alpha.host-extension-package.payload.mcp-local.v1",
  behavior: {
    command: ["bunx", "example-mcp"],
    environment: {},
    requiredSecrets: ["API_KEY"],
  },
})

const mcpRemotePayload = (
  auth: unknown = "none",
  requiredSecrets: string[] = [],
  headersTemplate: Record<string, string> = {},
) => ({
  schema: "alpha.host-extension-package.payload.mcp-remote.v1",
  behavior: {
    url: "https://mcp.example.invalid/service",
    headersTemplate,
    requiredSecrets,
    auth,
  },
})

export function decoderCorpusBytesV1(): Uint8Array {
  const cases: CorpusCase[] = [
    single("skill-v1", "skill", [], skillPayload("skill")),
    single("agent-v1", "agent", [], agentPayload("agent")),
    single("mcp-local-v1", "mcp-local", ["alpha.secret-prerequisite.v1"], mcpLocalPayload()),
    single("mcp-remote-v1", "mcp-remote", [], mcpRemotePayload()),
    // OAuth 与 Connection 都携带一条额外 secret:auth 不豁免 requiredSecrets(rev3 不变量 5),
    // 两个 capability 必须同时出现在派生结果里。
    single(
      "mcp-remote-oauth-v1",
      "mcp-remote",
      ["alpha.mcp-oauth.v1", "alpha.secret-prerequisite.v1"],
      mcpRemotePayload(
        { kind: "mcp-oauth", prerequisiteId: "example-oauth", required: true },
        ["TENANT_ID"],
        { "X-Tenant": "{TENANT_ID}" },
      ),
    ),
    single(
      "mcp-remote-connection-v1",
      "mcp-remote",
      ["alpha.connection.v1"],
      mcpRemotePayload({
        kind: "alpha-connection",
        prerequisiteId: "example-connection",
        required: true,
        connectionHandlerId: "alpha-example",
        label: "Alpha Example Connection",
      }),
    ),
  ]

  // 单组件负向:profile / capability / 缺 profileId。
  cases.push(
    blocked("unknown-profile-required", [
      { id: "skill:unknown-profile", profileId: "future", required: true, capabilities: [], payload: null },
    ]),
    blocked("unknown-capability-required", [
      {
        id: "skill:unknown-capability",
        profileId: "skill",
        required: true,
        capabilities: ["alpha.future.v1"],
        payload: null,
      },
    ]),
  )
  const missingProfile = structuredClone(cases[0]!)
  missingProfile.name = "missing-profile-required"
  missingProfile.expect = "blocked"
  delete (missingProfile.envelope.components as Array<Record<string, unknown>>)[0]!.profileId
  missingProfile.components = missingProfile.components.map((entry) => ({ ...entry, payload: null }))
  cases.push(missingProfile)

  // §4.1 条件 1 的单组件特例:唯一组件就是 root,它必须 required。
  const nonRequiredRoot = blocked("non-required-root", [
    { id: "skill:non-required-root", profileId: "skill", required: false, capabilities: [], payload: null },
  ])
  cases.push(nonRequiredRoot)

  // Bundle:被跳过的可选子件不得让整包失败,且它的 capability 仍留在签名并集里。
  cases.push(
    bundle(
      "bundle-optional-unsupported-profile",
      "mcp-local:bundle-root",
      [
        {
          id: "mcp-local:bundle-root",
          profileId: "mcp-local",
          required: true,
          capabilities: ["alpha.secret-prerequisite.v1"],
          payload: mcpLocalPayload(),
        },
        {
          id: "skill:bundle-supported-leaf",
          profileId: "skill",
          required: false,
          capabilities: [],
          payload: skillPayload("bundle-supported-leaf"),
        },
        {
          id: "agent:bundle-unsupported-leaf",
          profileId: "future",
          required: false,
          capabilities: ["alpha.future.v1"],
          payload: null,
        },
      ],
      ["agent:bundle-unsupported-leaf"],
    ),
    bundle(
      "bundle-optional-unsupported-capability",
      "skill:bundle-capability-root",
      [
        {
          id: "skill:bundle-capability-root",
          profileId: "skill",
          required: true,
          capabilities: [],
          payload: skillPayload("bundle-capability-root"),
        },
        {
          id: "agent:bundle-capability-leaf",
          profileId: "agent",
          required: false,
          capabilities: ["alpha.future.v1"],
          payload: null,
        },
      ],
      ["agent:bundle-capability-leaf"],
    ),
    bundle(
      "bundle-optional-media-type-mismatch",
      "skill:bundle-media-root",
      [
        {
          id: "skill:bundle-media-root",
          profileId: "skill",
          required: true,
          capabilities: [],
          payload: skillPayload("bundle-media-root"),
        },
        {
          id: "agent:bundle-media-leaf",
          profileId: "agent",
          required: false,
          capabilities: [],
          mediaType: "application/vnd.alpha.host-extension-package.skill.v1+json",
          payload: null,
        },
      ],
      ["agent:bundle-media-leaf"],
    ),
  )

  // 必需子件不受支持 = 整包 blocked。跳过语义绝不适用于 required。
  const requiredChild = bundle(
    "bundle-required-unsupported-child",
    "skill:bundle-required-root",
    [
      {
        id: "skill:bundle-required-root",
        profileId: "skill",
        required: true,
        capabilities: [],
        payload: null,
      },
      {
        id: "agent:bundle-required-leaf",
        profileId: "future",
        required: true,
        capabilities: [],
        payload: null,
      },
    ],
    [],
  )
  requiredChild.expect = "blocked"
  cases.push(requiredChild)

  return canonicalArtifactJsonBytesV1({
    schema: "alpha.host-extension-package.decoder-corpus.v1",
    cases,
  })
}

export function canonicalArtifactJsonBytesV1(value: unknown): Uint8Array {
  return textEncoder.encode(`${JSON.stringify(sortCanonicalValue(value), null, 2)}\n`)
}

export async function buildHostExtensionPackageArtifactManifest(
  artifactRoot = root,
): Promise<ArtifactManifestV1> {
  const files = await Promise.all(
    HOST_EXTENSION_PACKAGE_ARTIFACT_FILES.map(async (path) => {
      const bytes = await readFile(resolve(artifactRoot, path))
      return { path, bytes: bytes.byteLength, sha256: sha256(bytes) }
    }),
  )
  const identity: Pick<ArtifactManifestV1, "artifactPath" | "files"> = {
    artifactPath: HOST_EXTENSION_PACKAGE_ARTIFACT_PATH,
    files,
  }
  return {
    schema: "alpha.host-extension-package.artifact.v1",
    ...identity,
    artifactSha256: sha256(canonicalArtifactJsonBytesV1(identity)),
  }
}

export async function checkHostExtensionPackageArtifact(artifactRoot = root): Promise<void> {
  const corpus = await readFile(resolve(artifactRoot, HOST_EXTENSION_PACKAGE_CORPUS))
  if (!bytesEqual(corpus, decoderCorpusBytesV1()))
    throw new Error(`${HOST_EXTENSION_PACKAGE_CORPUS} drifted; run generate-artifact.ts`)
  const manifest = await readFile(resolve(artifactRoot, HOST_EXTENSION_PACKAGE_ARTIFACT_MANIFEST))
  const expected = canonicalArtifactJsonBytesV1(
    await buildHostExtensionPackageArtifactManifest(artifactRoot),
  )
  if (!bytesEqual(manifest, expected))
    throw new Error(`${HOST_EXTENSION_PACKAGE_ARTIFACT_MANIFEST} path/SHA drift detected`)
}

async function writeHostExtensionPackageArtifact(artifactRoot = root): Promise<void> {
  await mkdir(resolve(artifactRoot, dirname(HOST_EXTENSION_PACKAGE_CORPUS)), { recursive: true })
  await writeFile(resolve(artifactRoot, HOST_EXTENSION_PACKAGE_CORPUS), decoderCorpusBytesV1())
  await writeFile(
    resolve(artifactRoot, HOST_EXTENSION_PACKAGE_ARTIFACT_MANIFEST),
    canonicalArtifactJsonBytesV1(await buildHostExtensionPackageArtifactManifest(artifactRoot)),
  )
}

function single(
  name: string,
  profileId: PackageProfileIdV1,
  capabilities: string[],
  payload: Record<string, unknown>,
): CorpusCase {
  const id = `${profileId}:${name}`
  return bundle(name, id, [{ id, profileId, required: true, capabilities, payload }], [])
}

function blocked(name: string, specs: ComponentSpec[]): CorpusCase {
  const item = bundle(name, specs[0]!.id, specs, [])
  item.expect = "blocked"
  return item
}

function bundle(
  name: string,
  rootId: string,
  specs: ComponentSpec[],
  skipped: string[],
): CorpusCase {
  const components = specs.map((spec) => {
    const registered = PROFILE_REGISTRY_V1.find((entry) => entry.profileId === spec.profileId)
    const payloadBytes = canonicalArtifactJsonBytesV1(spec.payload ?? {})
    return {
      id: spec.id,
      required: spec.required,
      dependencies:
        spec.id === rootId ? specs.filter((entry) => entry.id !== rootId).map((entry) => entry.id) : [],
      profileId: spec.profileId,
      profileVersion: spec.profileVersion ?? 1,
      capabilities: spec.capabilities,
      payloadRef: {
        sha256: sha256(payloadBytes),
        bytes: payloadBytes.byteLength,
        mediaType:
          spec.mediaType ??
          registered?.mediaType ??
          `application/vnd.alpha.host-extension-package.${spec.profileId}.v1+json`,
        url: `https://example.invalid/packages/${spec.id.replace(":", "/")}.json`,
      },
    }
  })
  return {
    name,
    expect: "accepted",
    skipped,
    envelope: {
      schema: "alpha.host-extension-package.v1",
      prelude: { packageId: `package:${name}`, version: "1.0.0" },
      presentation: { displayName: name, description: `Synthetic ${name} decoder case` },
      root: rootId,
      components,
      capabilities: [...new Set(specs.flatMap((spec) => spec.capabilities))].sort(),
    },
    components: specs.map((spec) => ({ id: spec.id, payload: spec.payload })),
  }
}

function sortCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonicalValue)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.keys(value)
      .sort(utf8Compare)
      .map((key) => [
        key,
        sortCanonicalValue((value as Record<string, unknown>)[key]),
      ]),
  )
}

function utf8Compare(left: string, right: string): number {
  const leftBytes = textEncoder.encode(left)
  const rightBytes = textEncoder.encode(right)
  const length = Math.min(leftBytes.byteLength, rightBytes.byteLength)
  for (let index = 0; index < length; index++) {
    if (leftBytes[index] === rightBytes[index]) continue
    return leftBytes[index]! < rightBytes[index]! ? -1 : 1
  }
  if (leftBytes.byteLength === rightBytes.byteLength) return 0
  return leftBytes.byteLength < rightBytes.byteLength ? -1 : 1
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  return left.every((byte, index) => byte === right[index])
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const unknown = process.argv.slice(2).filter((arg) => arg !== "--check")
  if (unknown.length) throw new Error(`unknown arguments: ${unknown.join(" ")}`)
  if (process.argv.includes("--check")) {
    await checkHostExtensionPackageArtifact()
    console.log(`checked ${HOST_EXTENSION_PACKAGE_ARTIFACT_FILES.length} HostExtensionPackageV1 files`)
  } else {
    await writeHostExtensionPackageArtifact()
    console.log(`generated ${HOST_EXTENSION_PACKAGE_ARTIFACT_MANIFEST}`)
  }
}
