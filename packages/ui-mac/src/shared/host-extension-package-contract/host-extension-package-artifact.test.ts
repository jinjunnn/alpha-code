import { createHash } from "node:crypto"
import { cpSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterAll, describe, expect, test } from "bun:test"
import {
  canonicalPackagePreludeBytesV1,
  derivePayloadCapabilitiesV1,
  type PackageProfilePayloadV1,
} from "./decoder"
import {
  HOST_EXTENSION_PACKAGE_ARTIFACT_FILES,
  HOST_EXTENSION_PACKAGE_ARTIFACT_MANIFEST,
  HOST_EXTENSION_PACKAGE_ARTIFACT_PATH,
  HOST_EXTENSION_PACKAGE_CORPUS,
  canonicalArtifactJsonBytesV1,
  checkHostExtensionPackageArtifact,
} from "./generate-artifact"
import {
  CAPABILITY_REGISTRY_V1,
  PROFILE_REGISTRY_V1,
  assertHostExtensionPackageRegistryV1,
} from "./registry"

const driftRoot = mkdtempSync(resolve(tmpdir(), "alpha-host-contract-drift-"))

afterAll(() => rmSync(driftRoot, { recursive: true, force: true }))

describe("HostExtensionPackageV1 artifact", () => {
  test("publishes the fixed path, sorted Phase 1 registries, and exact per-file SHA-256", async () => {
    assertHostExtensionPackageRegistryV1()
    expect(PROFILE_REGISTRY_V1.map((profile) => profile.profileId)).toEqual([
      "agent",
      "mcp-local",
      "mcp-remote",
      "skill",
    ])
    expect(CAPABILITY_REGISTRY_V1.map((capability) => capability.token)).toEqual([
      "alpha.secret-prerequisite.v1",
    ])

    const manifest = (await Bun.file(
      resolve(import.meta.dir, HOST_EXTENSION_PACKAGE_ARTIFACT_MANIFEST),
    ).json()) as {
      schema: string
      artifactPath: string
      artifactSha256: string
      files: Array<{ path: string; bytes: number; sha256: string }>
    }
    expect(manifest.schema).toBe("alpha.host-extension-package.artifact.v1")
    expect(manifest.artifactPath).toBe(HOST_EXTENSION_PACKAGE_ARTIFACT_PATH)
    expect(manifest.artifactSha256).toBe(
      createHash("sha256")
        .update(
          canonicalArtifactJsonBytesV1({
            artifactPath: manifest.artifactPath,
            files: manifest.files,
          }),
        )
        .digest("hex"),
    )
    expect(manifest.files.map((file) => file.path)).toEqual([...HOST_EXTENSION_PACKAGE_ARTIFACT_FILES])
    for (const file of manifest.files) {
      const bytes = new Uint8Array(await Bun.file(resolve(import.meta.dir, file.path)).arrayBuffer())
      expect(file.bytes, file.path).toBe(bytes.byteLength)
      expect(file.sha256, file.path).toBe(createHash("sha256").update(bytes).digest("hex"))
    }
  })

  test("prelude canonical bytes have fixed member order and one trailing LF", () => {
    expect(
      new TextDecoder().decode(
        canonicalPackagePreludeBytesV1({ packageId: "skill:demo", version: "1.2.3" }),
      ),
    ).toBe('{"packageId":"skill:demo","version":"1.2.3"}\n')
  })

  test("generated artifact JSON uses canonical recursive UTF-8 key order and trailing LF", async () => {
    for (const path of [HOST_EXTENSION_PACKAGE_CORPUS, HOST_EXTENSION_PACKAGE_ARTIFACT_MANIFEST]) {
      const bytes = new Uint8Array(await Bun.file(resolve(import.meta.dir, path)).arrayBuffer())
      const parsed = JSON.parse(new TextDecoder().decode(bytes))
      expect(bytes, path).toEqual(canonicalArtifactJsonBytesV1(parsed))
    }
    expect(
      new TextDecoder().decode(canonicalArtifactJsonBytesV1({ z: 1, a: { y: 2, b: 3 } })),
    ).toBe('{\n  "a": {\n    "b": 3,\n    "y": 2\n  },\n  "z": 1\n}\n')
  })

  test("schemas are strict, payload-ref-only, and exclude Phase 2/4 profiles", async () => {
    const envelope = (await Bun.file(
      resolve(import.meta.dir, "alpha-package-envelope-v1.schema.json"),
    ).json()) as Record<string, unknown>
    const properties = envelope.properties as Record<string, Record<string, unknown>>
    const component = ((properties.components.items as Record<string, unknown>).properties ??
      {}) as Record<string, unknown>
    expect(envelope.additionalProperties).toBe(false)
    expect(component).toHaveProperty("payloadRef")
    expect(component).not.toHaveProperty("payload")
    expect(component).not.toHaveProperty("inline")

    for (const profile of PROFILE_REGISTRY_V1) {
      const schema = (await Bun.file(resolve(import.meta.dir, profile.schemaPath)).json()) as {
        additionalProperties?: unknown
        properties?: { behavior?: { additionalProperties?: unknown } }
      }
      expect(schema.additionalProperties, profile.schemaPath).toBe(false)
      expect(schema.properties?.behavior?.additionalProperties, profile.schemaPath).toBe(false)
    }
    expect(JSON.stringify(PROFILE_REGISTRY_V1)).not.toContain("opencode-plugin")
    expect(JSON.stringify(PROFILE_REGISTRY_V1)).not.toContain("bundle")
  })

  test("every schema-reachable behavior derives exactly the registered capability vocabulary", async () => {
    const corpus = (await Bun.file(resolve(import.meta.dir, HOST_EXTENSION_PACKAGE_CORPUS)).json()) as {
      cases: Array<{
        expect: string
        envelope: { components: Array<{ profileId: string }> }
        payload: Record<string, unknown> | null
      }>
    }
    const derived = await Promise.all(
      PROFILE_REGISTRY_V1.map(async (profile) => {
        const schema = (await Bun.file(resolve(import.meta.dir, profile.schemaPath)).json()) as {
          properties?: {
            behavior?: {
              properties?: Record<string, { enum?: unknown[] }>
            }
          }
        }
        const payload = corpus.cases.find(
          (item) =>
            item.expect === "accepted" &&
            item.envelope.components[0]?.profileId === profile.profileId,
        )?.payload
        if (!payload) throw new Error(`missing accepted corpus payload for ${profile.profileId}`)
        const behavior = payload.behavior as Record<string, unknown>
        const dimensions = Object.entries(schema.properties?.behavior?.properties ?? {}).flatMap(
          ([key, definition]) => {
            if (key === "requiredSecrets")
              return [{ key, values: [[], ["SCHEMA_ENUM_PROBE"]] as unknown[] }]
            if (Array.isArray(definition.enum)) return [{ key, values: definition.enum }]
            return []
          },
        )
        return dimensions
          .reduce<Record<string, unknown>[]>(
            (variants, dimension) =>
              variants.flatMap((variant) =>
                dimension.values.map((value) => ({ ...variant, [dimension.key]: value })),
              ),
            [behavior],
          )
          .flatMap((variant) =>
            derivePayloadCapabilitiesV1({
              ...payload,
              behavior: variant,
            } as unknown as PackageProfilePayloadV1),
          )
      }),
    )
    const vocabulary = CAPABILITY_REGISTRY_V1.map((capability) => capability.token)
    const reachable = [...new Set(derived.flat())].sort()
    expect(reachable.every((capability) => vocabulary.includes(capability))).toBe(true)
    expect(reachable).toEqual(vocabulary)
  })

  test("generator --check is clean and detects a copied artifact drift", async () => {
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "generate-artifact.ts"), "--check"], {
      cwd: import.meta.dir,
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stdout).text()).toContain(
      `checked ${HOST_EXTENSION_PACKAGE_ARTIFACT_FILES.length} HostExtensionPackageV1 files`,
    )

    cpSync(import.meta.dir, driftRoot, { recursive: true })
    await Bun.write(resolve(driftRoot, "CONTRACT.md"), "drift\n")
    await expect(checkHostExtensionPackageArtifact(driftRoot)).rejects.toThrow(
      "path/SHA drift detected",
    )
  })
})
