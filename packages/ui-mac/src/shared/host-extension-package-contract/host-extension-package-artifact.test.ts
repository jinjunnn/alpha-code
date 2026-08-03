import { createHash } from "node:crypto"
import { cpSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterAll, describe, expect, test } from "bun:test"
import {
  PACKAGE_CAPABILITY_GRAMMAR_V1,
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
  HOST_EXTENSION_PACKAGE_LIMITS_V1,
  PROFILE_REGISTRY_V1,
  assertHostExtensionPackageRegistryV1,
} from "./registry"

type SchemaNode = {
  type?: string
  const?: unknown
  enum?: unknown[]
  oneOf?: SchemaNode[]
  required?: string[]
  properties?: Record<string, SchemaNode>
}

/**
 * One probe value per `oneOf` arm, built from the arm's own `const`/`required` declarations rather
 * than from a hand-written list. A hand-written list is the same defect the repository keeps
 * paying for: it silently stops covering an arm the moment someone adds one.
 */
function schemaArmProbe(arm: SchemaNode): unknown {
  if (arm.const !== undefined) return arm.const
  if (arm.enum?.length) return arm.enum[0]
  return Object.fromEntries(
    (arm.required ?? []).map((key) => [key, schemaSampleValue(arm.properties?.[key])]),
  )
}

function schemaSampleValue(node: SchemaNode | undefined): unknown {
  if (!node) return "schema-probe"
  if (node.const !== undefined) return node.const
  if (node.enum?.length) return node.enum[0]
  if (node.type === "boolean") return true
  if (node.type === "array") return []
  return "schema-probe"
}

const driftRoot = mkdtempSync(resolve(tmpdir(), "alpha-host-contract-drift-"))

afterAll(() => rmSync(driftRoot, { recursive: true, force: true }))

describe("HostExtensionPackageV1 artifact", () => {
  test("publishes the fixed path, sorted registries, and exact per-file SHA-256", async () => {
    assertHostExtensionPackageRegistryV1()
    expect(PROFILE_REGISTRY_V1.map((profile) => profile.profileId)).toEqual([
      "agent",
      "mcp-local",
      "mcp-remote",
      "skill",
    ])
    expect(CAPABILITY_REGISTRY_V1.map((capability) => capability.token)).toEqual([
      "alpha.connection.v1",
      "alpha.mcp-oauth.v1",
      "alpha.secret-prerequisite.v1",
    ])
    // 界也是合同。#737 的 5 MiB 残留就是「界只活在某个源文件里的字面量」造成的,
    // 所以每一条界都必须在 registry 里,而不是散落在 decoder / main 的常量上。
    expect(Object.keys(HOST_EXTENSION_PACKAGE_LIMITS_V1).sort()).toEqual([
      "maxCapabilities",
      "maxComponents",
      "maxEnvelopeBytes",
      "maxHeaderDepth",
      "maxHeaderNodes",
      "maxMarkdownAssetBytes",
      "maxPayloadBytes",
      "maxPayloadDepth",
      "maxPayloadNodes",
      "maxStringBytes",
    ])
    expect(HOST_EXTENSION_PACKAGE_LIMITS_V1.maxComponents).toBe(16)
    expect(HOST_EXTENSION_PACKAGE_LIMITS_V1.maxMarkdownAssetBytes).toBe(5 * 1024 * 1024)
    // DoS 边界必须钉住值,不能只钉住「这个键存在」—— 键存在的断言拦不住悄悄放宽。
    // v2 把 maxHeaderNodes 从 128 提到 512:16 组件的信封本身就有几百个节点,128 会拒载合法
    // 多组件包。放宽 4× 的兜底是 maxEnvelopeBytes 仍为 64 KiB —— 所以它也一起钉住,
    // 否则「兜底还在」只是散文断言。
    expect(HOST_EXTENSION_PACKAGE_LIMITS_V1.maxHeaderNodes).toBe(512)
    expect(HOST_EXTENSION_PACKAGE_LIMITS_V1.maxEnvelopeBytes).toBe(64 * 1024)

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

  test("schemas are strict, payload-ref-only, and bind every registered profile exactly", async () => {
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
    // 完整绑定(id@version + mediaType + schemaPath)的 exact-set。它挡的是「悄悄加一个」——
    // 一个把新 profile 指向别人的 schema 或别人的 mediaType 的实现也在这里红。
    expect(
      PROFILE_REGISTRY_V1.map(
        (profile) =>
          `${profile.profileId}@${profile.profileVersion} ${profile.mediaType} ${profile.schemaPath}`,
      ),
    ).toEqual([
      "agent@1 application/vnd.alpha.host-extension-package.agent.v1+json profiles/agent.v1.schema.json",
      "mcp-local@1 application/vnd.alpha.host-extension-package.mcp-local.v1+json profiles/mcp-local.v1.schema.json",
      "mcp-remote@1 application/vnd.alpha.host-extension-package.mcp-remote.v1+json profiles/mcp-remote.v1.schema.json",
      "skill@1 application/vnd.alpha.host-extension-package.skill.v1+json profiles/skill.v1.schema.json",
    ])
    // ADR-040(`#830`):这条曾在 Phase 4 被**翻成正向**以容纳 `opencode-plugin`。owner 否决了
    // 那个 profile,所以它翻回反向 —— 上面那条 exact-set 只在有人**改了它自己**时红,而这一条
    // 说的是一件与列表内容无关的话:这个名字不许再回来。两条一起才把「悄悄加一个」堵死。
    expect(JSON.stringify(PROFILE_REGISTRY_V1)).not.toContain("opencode-plugin")
    // Bundle 不是 profile,而是多组件信封的形状。这一条**不动**。
    expect(JSON.stringify(PROFILE_REGISTRY_V1)).not.toContain("bundle")
  })

  /**
   * ADR-040(`#830`)必须保住的那条:**decoder 的 capability 文法与发布给 producer 的信封
   * schema 必须逐字一致**。两处分开维护,不一致 = 「过了发布端 schema 却被宿主拒掉」= 合同说谎。
   *
   * `#807` 当初两边同步加冒号时是**人拿程序比对了一次**,仓里没有留下任何东西看着它 ——
   * 本票回滚时两边同步收回,于是把那次一次性比对变成一道常驻闸。
   *
   * 两条一起断,因为单独任何一条都不够:
   *   · `.source` 相等抓的是「两份字面量漂了」,但一个把两边**一起**改错的人仍然自洽;
   *   · 所以再拿一组固定探针跑双方,**期望值是写死的字面量**,不从任何一边派生 ——
   *     它们是这条文法的独立锚点。冒号那三个是 `#807` 的原始反例,回滚后必须全部为假。
   */
  test("the capability grammar is byte-identical in the decoder and the published envelope schema", async () => {
    const envelope = (await Bun.file(
      resolve(import.meta.dir, "alpha-package-envelope-v1.schema.json"),
    ).json()) as { $defs?: { capabilities?: { items?: { pattern?: string } } } }
    const published = envelope.$defs?.capabilities?.items?.pattern
    expect(published).toBe(PACKAGE_CAPABILITY_GRAMMAR_V1.source)

    const publishedRe = new RegExp(published!)
    const probes: Array<[string, boolean]> = [
      ["alpha.connection.v1", true],
      ["alpha.mcp-oauth.v1", true],
      ["alpha.secret-prerequisite.v1", true],
      ["a", true],
      ["a-b.c", true],
      // ADR-040 撤回的两个 token 与 `#807` R1/F1 的三个畸形值:回滚后文法里没有冒号,五个全假。
      ["engine:config", false],
      ["engine:plugin", false],
      ["a::b", false],
      ["a:", false],
      ["a:b:c:d", false],
      ["A", false],
      ["1a", false],
      ["", false],
      ["a b", false],
      ["a\nb", false],
      [`a${"b".repeat(96)}`, false],
    ]
    for (const [token, allowed] of probes) {
      expect(PACKAGE_CAPABILITY_GRAMMAR_V1.test(token), `decoder: ${JSON.stringify(token)}`).toBe(allowed)
      expect(publishedRe.test(token), `schema: ${JSON.stringify(token)}`).toBe(allowed)
    }
  })

  test("every schema-reachable behavior derives exactly the registered capability vocabulary", async () => {
    const corpus = (await Bun.file(resolve(import.meta.dir, HOST_EXTENSION_PACKAGE_CORPUS)).json()) as {
      cases: Array<{
        expect: string
        envelope: { root: string; components: Array<{ id: string; profileId: string }> }
        components: Array<{ id: string; payload: Record<string, unknown> | null }>
      }>
    }
    const derived = await Promise.all(
      PROFILE_REGISTRY_V1.map(async (profile) => {
        const schema = (await Bun.file(resolve(import.meta.dir, profile.schemaPath)).json()) as {
          properties?: { behavior?: { properties?: Record<string, SchemaNode> } }
        }
        const payload = corpus.cases
          .filter((item) => item.expect === "accepted")
          .flatMap((item) =>
            item.envelope.components.flatMap((component) =>
              component.profileId === profile.profileId
                ? [item.components.find((entry) => entry.id === component.id)?.payload]
                : [],
            ),
          )
          .find((candidate): candidate is Record<string, unknown> => !!candidate)
        if (!payload) throw new Error(`missing accepted corpus payload for ${profile.profileId}`)
        const behavior = payload.behavior as Record<string, unknown>
        // 维度直接从 schema 读。auth 现在是 oneOf 判别联合(rev3 修订 B),所以枚举必须
        // 认识 oneOf —— 只认 `enum` 的版本会让「新增一个 auth 分支却忘了写派生」静默全绿。
        const dimensions = Object.entries(schema.properties?.behavior?.properties ?? {}).flatMap(
          ([key, definition]) => {
            if (key === "requiredSecrets")
              return [{ key, values: [[], ["SCHEMA_ENUM_PROBE"]] as unknown[] }]
            if (Array.isArray(definition.enum)) return [{ key, values: definition.enum }]
            if (Array.isArray(definition.oneOf))
              return [{ key, values: definition.oneOf.map(schemaArmProbe) }]
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
