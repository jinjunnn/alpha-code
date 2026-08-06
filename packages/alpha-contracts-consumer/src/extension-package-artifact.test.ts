// REQ-128 consumer gate:byte provenance and executable semantic negatives are separate.
// Re-vendoring a weakened producer can make every SHA self-consistent, so the schema/vector
// assertions below deliberately execute the pinned negative corpus instead of treating its
// aggregate hash as proof of compatibility semantics.

import { createHash } from "node:crypto"
import { readdirSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, test } from "bun:test"
import Ajv2020 from "ajv/dist/2020"

const root = resolve(import.meta.dir, "..")
const vendor = resolve(root, "vendor/alpha-web-extension-package")
const lockFile = resolve(root, "alpha-web-extension-package.lock.json")
/** This repository's own host contract artifact — the thing alpha-web pins and republishes. */
const liveHostArtifact = resolve(
  root,
  "../ui-mac/src/shared/host-extension-package-contract/host-extension-package-artifact.v1.json",
)
const json = (path: string) => Bun.file(resolve(vendor, path)).json()
const bytes = async (path: string) => new Uint8Array(await Bun.file(resolve(vendor, path)).arrayBuffer())
const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.keys(value)
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
  )
}

describe("alpha-web extension package producer artifact pin", () => {
  test("pins the containing commit, artifact path, aggregate, and every exact file", async () => {
    const lock = (await Bun.file(lockFile).json()) as {
      repo: string
      commit: string
      artifactPath: string
      artifactSha256: string
      files: Array<{ path: string; sha256: string }>
    }
    const manifest = (await json("extension-package-producer-artifact.v1.json")) as {
      files: Array<{ path: string; bytes: number; sha256: string }>
    }

    expect(lock).toMatchObject({
      repo: "jinjunnn/alpha-web",
      commit: "3ebca3c95a5f5e37f6c9ea0598fff5676c60ea84",
      artifactPath: "contracts/extension-package/artifact",
      artifactSha256: "ec555a1dc7c4435ec8cea965e9c12e1e2c8d55273249a898b47ceed26693b33d",
    })
    // 固定条数,不留余量:上游悄悄少发一个语料文件时,只比对「lock ↔ manifest 两边一致」是
    // 抓不到的 —— 两边会一起变小并保持自洽。
    // lock 数 = 目录里的全部文件(40);manifest 数永远比它少一个(39)—— manifest 装不下
    // 自己的哈希(`producerCommit.embedded: false` 是同一个理由的另一半)。这个「差一」不写成
    // 第二个常数,而由下一条 `toEqual` 把 manifest 清单 ∪ {manifest 自己} 与 lock 清单对死。
    // `#853` / alpha-web#98:36 → 40,增补的是 command 资产、Claude 发布端规则与两份负例。
    expect(lock.files.length).toBe(40)
    expect(lock.files.map((file) => file.path).sort()).toEqual(
      [...manifest.files.map((file) => file.path), "extension-package-producer-artifact.v1.json"].sort(),
    )
    for (const file of lock.files) expect(sha256(await bytes(file.path)), file.path).toBe(file.sha256)
    for (const file of manifest.files) {
      const data = await bytes(file.path)
      expect(data.byteLength, file.path).toBe(file.bytes)
      expect(sha256(data), file.path).toBe(file.sha256)
    }

    // vendor 脚本只写它认得的文件,**从不删**。上一版语料里被上游撤掉的文件(`#830` 这一跳:
    // `input.plugin.valid.json` / `expected.plugin.compiled.json` / `asset.generic-plugin.js`
    // 三份随 `opencode-plugin` 一起走)会原地留下来,而 lock ↔ manifest
    // 的三方比对对「多出来一个没人拥有的文件」完全无感。一份没有上游、没有 lock 记录的夹具
    // 若被谁读进测试,它会随合同一起漂而永远不红 —— 那正是 `#737` 那一类。目录清单是判据。
    expect(readdirSync(vendor).sort()).toEqual(lock.files.map((file) => file.path).sort())
  })

  test("recomputes the producer aggregate and enforces the non-self-referential commit binding", async () => {
    const manifest = (await json("extension-package-producer-artifact.v1.json")) as {
      artifactPath: string
      artifactSha256: string
      files: unknown
      producerRepository: string
      producerCommit: unknown
    }
    const aggregate = sha256(
      new TextEncoder().encode(
        `${JSON.stringify(
          canonical({
            artifactPath: manifest.artifactPath,
            files: manifest.files,
            producerRepository: manifest.producerRepository,
          }),
          null,
          2,
        )}\n`,
      ),
    )
    expect(aggregate).toBe(manifest.artifactSha256)
    expect(manifest.producerRepository).toBe("jinjunnn/alpha-web")
    expect(manifest.producerCommit).toEqual({
      binding: "git-commit-containing-this-artifact",
      embedded: false,
    })
  })

  /**
   * 跨仓 pin 的**消费侧**判据(`#759`)。上游 `alpha-web#109` 在发布端立了同名漂移闸;发布端
   * 只能证明「我按某个宿主合同编译」,证明不了「桌面端消费的就是那一份」。这里补上另一半:
   * 语料里那份宿主合同副本必须与本仓**活的**宿主 artifact 逐字节相同,且反向 pin 声称的
   * artifactSha256 必须就是它。任一侧先动而没有 re-vendor,这条立刻红。
   */
  test("the vendored host contract copy is byte-identical to this repository's live host artifact", async () => {
    const live = new Uint8Array(await Bun.file(liveHostArtifact).arrayBuffer())
    const vendored = await bytes("host-extension-package-artifact.v1.json")
    expect(sha256(vendored)).toBe(sha256(live))

    const liveManifest = JSON.parse(new TextDecoder().decode(live)) as {
      artifactPath: string
      artifactSha256: string
    }
    const pin = (await json("host-contract-pin.v1.json")) as {
      repo: string
      commit: string
      artifactPath: string
      artifactSha256: string
      schema: string
    }
    expect(pin.schema).toBe("alpha.host-extension-package.pin.v1")
    expect(pin.repo).toBe("jinjunnn/alpha-code")
    expect(pin.artifactPath).toBe(liveManifest.artifactPath)
    expect(pin.artifactSha256).toBe(liveManifest.artifactSha256)
    expect(pin.commit).toMatch(/^[0-9a-f]{40}$/)

    // 编译规则里复述的那份 hostContract 必须与反向 pin 完全一致 —— 上游两处自述若能互相矛盾,
    // 说明其中一处是手抄的。
    const rules = (await json("generic-rules.v1.json")) as {
      hostContract: { repo: string; commit: string; artifactPath: string; artifactSha256: string }
    }
    expect(rules.hostContract).toEqual({
      repo: pin.repo,
      commit: pin.commit,
      artifactPath: pin.artifactPath,
      artifactSha256: pin.artifactSha256,
    })
  })

  // 标题保持原样:这个字符串是
  // `docs/verification/2026-07-31-req128-capability-matrix/matrix.tsv:7` 的 evidence key,
  // 由 `packages/ui-mac/src/main/req128-capability-matrix.test.ts` 反查。改名会去动一份
  // 已归档的 Phase 1 验证证据 —— 那不在本票边界内(`#811`/`#830` 同此处置)。
  test("v2 profile/capability closure covers OAuth and Alpha Connection and still excludes cloud", async () => {
    const registry = await json("host-extension-package.registry.v1.json")
    const profiles = await json("generic-profiles.v1.json")
    const rules = await json("generic-rules.v1.json")
    expect(registry.profiles.map((profile: { profileId: string }) => profile.profileId).sort()).toEqual([
      "agent",
      "command",
      "mcp-local",
      "mcp-remote",
      "skill",
    ])
    // 合同 v2 (`#749`) 把两个 capability 转正。Phase 4 (`#807`) 一度再登记 `engine:config` /
    // `engine:plugin`,ADR-040 否决后由 `#830` / alpha-web#138 撤回,回到三个。exact-set,
    // 不是 arrayContaining:多出来一个未经宿主登记的 token 同样要红。
    expect(registry.capabilities.map((capability: { token: string }) => capability.token)).toEqual([
      "alpha.connection.v1",
      "alpha.mcp-oauth.v1",
      "alpha.secret-prerequisite.v1",
    ])
    expect(profiles.mappings.map((mapping: { host: { profileId: string } }) => mapping.host.profileId)).toEqual([
      "agent",
      "command",
      "mcp-local",
      "mcp-remote",
      "skill",
    ])
    // 编译规则与宿主 registry 是上游发布的两份文件。让它们互相当判据,任一份被单独放宽即红。
    expect(rules.capabilities).toEqual(
      registry.capabilities.map((capability: { token: string }) => capability.token),
    )
    expect(rules.remoteAuthKinds.slice().sort()).toEqual(["alpha-connection", "mcp-oauth", "none"])
    // Bundle 已转正,但只有 **flat** 那一档:嵌套仍在排除表里,且组件上限与宿主 registry 同值。
    // `managed-plugin` 在 `#807` 短暂离开过排除表,ADR-040 否决 `opencode-plugin` 之后
    // (`#830` / alpha-web#138)**放回来了** —— 它与 `publish-wrapper`(发布端代打包)、
    // `legacy-projection`(投影回 legacy 目录)一样,是发布端结构上不产出的东西。
    // exact-set 而不是 arrayContaining:后者只挡「悄悄少一个」,挡不住「悄悄多一个」——
    // 而把某一档重新塞回/挪出排除表,正是让 profile 集合静默漂移的两个方向。
    expect(rules.excluded).toEqual([
      "cloud",
      "legacy-projection",
      "managed-plugin",
      "nested-bundle",
      "provider-adapter",
      "publish-wrapper",
    ])
    expect(rules.graph).toMatchObject({
      shape: "flat",
      nested: false,
      leafDependencies: [],
      rootDependencies: "exactly the set of every non-root component id",
    })
    expect(rules.graph.maxComponents).toBe(registry.limits.maxComponents)
  })

  test("declaration schema directly rejects cloud, unknown auth, author-derived fields, and secret values", async () => {
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(
      await json("alpha-package-declaration-v1.schema.json"),
    )
    // 这一档是**声明 schema 自己**就能拒的负向。语料里其余负向(URL、占位符冲突、id 重复)
    // 归编译器语义层,由下面两条用例按 `vectors.v1.json` 的错误码轴各自断言 —— 混在一起会让
    // 「schema 松了」和「编译器松了」互相掩护。
    for (const path of [
      "input.cloud-profile.invalid.json",
      "input.remote-auth-unknown.invalid.json",
      "input.author-capabilities.invalid.json",
      "input.author-dependencies.invalid.json",
      "input.author-secret-value.invalid.json",
      "input.bundle-overflow.invalid.json",
      "input.command-variant.invalid.json",
    ])
      expect(validate(await json(path)), path).toBe(false)

    // 四份正向语料**全部**要过 schema:只验一份的话,OAuth / Connection / Bundle
    // 任一档被 schema 悄悄关掉都不会红。(`#830` 撤掉了第五份 `input.plugin.valid.json`。)
    const vectors = (await json("vectors.v1.json")) as { valid: Array<{ input: string }> }
    expect(vectors.valid.map((vector) => vector.input)).toEqual([
      "input.mcp-remote.valid.json",
      "input.remote-oauth.valid.json",
      "input.remote-connection.valid.json",
      "input.bundle.valid.json",
    ])
    for (const vector of vectors.valid) expect(validate(await json(vector.input)), vector.input).toBe(true)
  })

  test("credential/canonical URL negatives and remote auth semantics are asserted independently of SHA", async () => {
    const insecure = await json("input.remote-http.invalid.json")
    expect(new URL(insecure.root.component.behavior.url).protocol).not.toBe("https:")
    const credential = await json("input.remote-userinfo.invalid.json")
    const credentialUrl = new URL(credential.root.component.behavior.url)
    expect(credentialUrl.username === "" && credentialUrl.password === "").toBe(false)

    const compiled = await json("expected.mcp-remote.compiled.json")
    const behavior = compiled.payloads["mcp:generic-remote"].behavior
    const payloadUrl = new URL(behavior.url)
    expect(behavior.auth).toBe("none")
    expect(payloadUrl.protocol).toBe("https:")
    expect(payloadUrl.username).toBe("")
    expect(payloadUrl.password).toBe("")
    expect(payloadUrl.href).toBe(behavior.url)
    expect(compiled.envelope.components[0].required).toBe(true)
    expect(compiled.envelope.root).toBe(compiled.envelope.components[0].id)

    // 两种新授权档位各自编译出**判别联合**,而不是回落成字符串;它们各自派生一个 capability,
    // 且 token 材料一律不在 package 字节里(`mcp-oauth` 连 Authorization 模板都不许自带)。
    const oauth = await json("expected.remote-oauth.compiled.json")
    const oauthComponent = oauth.envelope.components[0]
    const oauthBehavior = oauth.payloads[oauthComponent.id].behavior
    expect(oauthBehavior.auth.kind).toBe("mcp-oauth")
    expect(oauthComponent.capabilities).toContain("alpha.mcp-oauth.v1")
    expect(Object.keys(oauthBehavior.headersTemplate).map((key) => key.toLowerCase())).not.toContain(
      "authorization",
    )

    const connection = await json("expected.remote-connection.compiled.json")
    const connectionComponent = connection.envelope.components[0]
    const connectionBehavior = connection.payloads[connectionComponent.id].behavior
    expect(connectionBehavior.auth.kind).toBe("alpha-connection")
    expect(connectionBehavior.auth.connectionHandlerId).toMatch(/^[a-z][a-z0-9-]{0,63}$/)
    expect(connectionComponent.capabilities).toContain("alpha.connection.v1")

    // flat Bundle:root 在表内、root.dependencies 恰好是全部 non-root id、每个 leaf 的
    // dependencies 为空。这三条就是宿主 §4.1 的图文法,在**发布端产物**上直接成立。
    const bundle = await json("expected.bundle.compiled.json")
    const components = bundle.envelope.components as Array<{
      id: string
      dependencies: string[]
      required: boolean
      capabilities: string[]
    }>
    const rootComponent = components.find((component) => component.id === bundle.envelope.root)!
    expect(rootComponent.required).toBe(true)
    expect(rootComponent.dependencies.slice().sort()).toEqual(
      components.filter((component) => component.id !== bundle.envelope.root).map((c) => c.id).sort(),
    )
    for (const leaf of components.filter((component) => component.id !== bundle.envelope.root))
      expect(leaf.dependencies, leaf.id).toEqual([])
    expect(new Set(components.map((component) => component.id)).size).toBe(components.length)
    // 签名并集含全部组件的 capability(§4.3 第一层),而不是只含 root 的。
    expect(bundle.envelope.capabilities).toEqual(
      [...new Set(components.flatMap((component) => component.capabilities))].sort(),
    )
  })

  test("published vector error codes keep all semantic negative axes named", async () => {
    const vectors = await json("vectors.v1.json")
    expect(
      Object.fromEntries(
        vectors.invalid.map((vector: { input: string; errorCode: string }) => [vector.input, vector.errorCode]),
      ),
    ).toEqual({
      "input.remote-http.invalid.json": "E_URL_HTTPS",
      "input.remote-userinfo.invalid.json": "E_URL_CREDENTIALS",
      "input.remote-auth-unknown.invalid.json": "E_AUTH_UNSUPPORTED",
      "input.oauth-authorization-header.invalid.json": "E_AUTH_HEADER_CONFLICT",
      "input.oauth-prerequisite-collision.invalid.json": "E_PREREQUISITE_COLLISION",
      "input.cloud-profile.invalid.json": "E_PROFILE_UNSUPPORTED",
      "input.command-reserved-name.invalid.json": "E_COMMAND_NAME_RESERVED",
      "input.command-variant.invalid.json": "E_UNKNOWN_FIELD",
      "input.author-capabilities.invalid.json": "E_AUTHOR_DERIVED_FIELD",
      "input.author-dependencies.invalid.json": "E_AUTHOR_DERIVED_FIELD",
      "input.author-secret-value.invalid.json": "E_AUTHOR_DERIVED_FIELD",
      "input.bundle-duplicate-component.invalid.json": "E_COMPONENT_ID_DUPLICATE",
      "input.bundle-root-leaf-collision.invalid.json": "E_COMPONENT_ID_DUPLICATE",
      "input.bundle-overflow.invalid.json": "E_COMPONENT_COUNT",
    })
    // 每个负向语料都必须真的在 vendor 目录里(错误码表列了一个不存在的文件 = 空闸门)。
    for (const vector of vectors.invalid as Array<{ input: string }>)
      expect(await Bun.file(resolve(vendor, vector.input)).exists(), vector.input).toBe(true)
  })
})
