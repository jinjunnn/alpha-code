#!/usr/bin/env bun

import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { PROFILE_REGISTRY_V1, type PackageCapabilityV1, type PackageProfileIdV1 } from "./registry"

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
  "profiles/cloud.v1.schema.json",
  "profiles/mcp-local.v1.schema.json",
  "profiles/mcp-remote.v1.schema.json",
  "profiles/skill.v1.schema.json",
  "registry.ts",
  "synthetic-decoder.ts",
  HOST_EXTENSION_PACKAGE_CORPUS,
] as const

type CorpusCase = {
  name: string
  expect: "accepted" | "blocked" | "skipped"
  envelope: Record<string, unknown>
  payload: Record<string, unknown> | null
}

type ArtifactManifestV1 = {
  schema: "alpha.host-extension-package.artifact.v1"
  artifactPath: typeof HOST_EXTENSION_PACKAGE_ARTIFACT_PATH
  artifactSha256: string
  files: Array<{ path: string; bytes: number; sha256: string }>
}

const root = dirname(fileURLToPath(import.meta.url))
const textEncoder = new TextEncoder()

export function decoderCorpusBytesV1(): Uint8Array {
  const cases: CorpusCase[] = [
    createCase(
      "skill-v1",
      "skill",
      [],
      {
        schema: "alpha.host-extension-package.payload.skill.v1",
        behavior: {
          targetDir: "alpha-skills",
          asset: {
            sha256: "1".repeat(64),
            bytes: 12,
            mediaType: "text/markdown",
            url: "https://example.invalid/assets/skill.md",
          },
        },
      },
    ),
    createCase(
      "agent-v1",
      "agent",
      [],
      {
        schema: "alpha.host-extension-package.payload.agent.v1",
        behavior: {
          targetDir: "alpha-agents",
          asset: {
            sha256: "2".repeat(64),
            bytes: 12,
            mediaType: "text/markdown",
            url: "https://example.invalid/assets/agent.md",
          },
        },
      },
    ),
    createCase(
      "mcp-local-v1",
      "mcp-local",
      ["alpha.secret-prerequisite.v1"],
      {
        schema: "alpha.host-extension-package.payload.mcp-local.v1",
        behavior: {
          command: ["bunx", "example-mcp"],
          environment: {},
          requiredSecrets: ["API_KEY"],
        },
      },
    ),
    createCase(
      "mcp-remote-v1",
      "mcp-remote",
      ["alpha.mcp-oauth.v1"],
      {
        schema: "alpha.host-extension-package.payload.mcp-remote.v1",
        behavior: {
          url: "https://mcp.example.invalid/service",
          headersTemplate: {},
          requiredSecrets: [],
          auth: "oauth",
        },
      },
    ),
    createCase(
      "cloud-v1",
      "cloud",
      ["alpha.connection-prerequisite.v1"],
      {
        schema: "alpha.host-extension-package.payload.cloud.v1",
        behavior: {
          pipelineKind: "research",
          inputContract: [{ field: "query", description: "Research question", required: true }],
          budgetDefaults: { max_iter: 3, max_tokens: 2000, max_wall_clock_sec: 60 },
          budgetLimits: { max_iter: 10, max_tokens: 10000, max_wall_clock_sec: 300 },
          connection: "required",
        },
      },
    ),
  ]
  const unknownProfile = structuredClone(cases[0]!)
  unknownProfile.name = "unknown-profile-required"
  unknownProfile.expect = "blocked"
  ;(unknownProfile.envelope.components as Array<Record<string, unknown>>)[0]!.profileId = "future"
  unknownProfile.payload = null
  cases.push(unknownProfile)

  const optionalProfile = structuredClone(unknownProfile)
  optionalProfile.name = "unknown-profile-optional"
  optionalProfile.expect = "skipped"
  ;(optionalProfile.envelope.components as Array<Record<string, unknown>>)[0]!.required = false
  cases.push(optionalProfile)

  const unknownCapability = structuredClone(cases[0]!)
  unknownCapability.name = "unknown-capability-required"
  unknownCapability.expect = "blocked"
  ;(unknownCapability.envelope.components as Array<Record<string, unknown>>)[0]!.capabilities = [
    "alpha.future.v1",
  ]
  unknownCapability.envelope.capabilities = ["alpha.future.v1"]
  unknownCapability.payload = null
  cases.push(unknownCapability)

  const missingProfile = structuredClone(cases[0]!)
  missingProfile.name = "missing-profile-required"
  missingProfile.expect = "blocked"
  delete (missingProfile.envelope.components as Array<Record<string, unknown>>)[0]!.profileId
  missingProfile.payload = null
  cases.push(missingProfile)

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

function createCase(
  name: string,
  profileId: PackageProfileIdV1,
  capabilities: PackageCapabilityV1[],
  payload: Record<string, unknown>,
): CorpusCase {
  const payloadBytes = canonicalArtifactJsonBytesV1(payload)
  const profile = PROFILE_REGISTRY_V1.find((entry) => entry.profileId === profileId)!
  const id = `${profileId}:${name}`
  return {
    name,
    expect: "accepted",
    envelope: {
      schema: "alpha.host-extension-package.v1",
      prelude: { packageId: id, version: "1.0.0" },
      presentation: { displayName: name, description: `Synthetic ${profileId} decoder case` },
      components: [
        {
          id,
          required: true,
          dependencies: [],
          profileId,
          profileVersion: 1,
          capabilities,
          payloadRef: {
            sha256: sha256(payloadBytes),
            bytes: payloadBytes.byteLength,
            mediaType: profile.mediaType,
            url: `https://example.invalid/packages/${profileId}.json`,
          },
        },
      ],
      capabilities,
    },
    payload,
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
