// REQ-128 `#697` canonical mixed Bundle —— 一处夹具,两个闸门共用(单元面与生产接线面)。
//
// **形状**取自 vendored producer 产物 `expected.bundle.compiled.json`(agent root + skill leaf +
// 带必需密钥的 mcp-remote leaf)。它不是抄来的:`assertMatchesVendoredBundleShape` 会把本夹具的
// root / 组件 id / required / profile / dependencies 与那份**真产物**逐条对照,上游改了 canonical
// Bundle 的形状,这里就红,而不是悄悄漂成一个只有我们自己认得的图。
//
// **字节**必须重造,原因是一个真实缺口:vendored 的两个 markdown 资产
// (`asset.generic-bundle-{agent,skill}.md`)**没有 frontmatter**,而宿主对两者都强制要求
//   · agent:`agentMdToEntry` 需要 `---` 块 + `description` + 非空 body;
//   · skill:`skillGenerationProbe` 需要 frontmatter `name` 等于 item key。
// 也就是说那份产物在今天的宿主上装不进去。修的是发布端语料(`alpha-web`,随 `aw#108` 发第一个
// 真实 package 时闭合),不是本票。这里如实重造资产字节并重算签名,并在上面那条形状断言里
// 保留与真产物的绑定。
//
// 第四格「已策展但宿主不支持的 optional child」语料里没有(上游只发布宿主支持的 profile),
// 所以由本夹具**显式构造**:一个 optional leaf 带本 build 不认识的 capability。它排在
// `components[]` 的**最后**,签名并集含它(§4.3 第一层),而有效安装图不含它。

import { createHash } from "node:crypto"
import { resolve } from "node:path"
import type {
  AlphaPackageEnvelopeV1,
  PackageProfilePayloadV1,
} from "../src/shared/host-extension-package-contract/decoder"

export const MIXED_BUNDLE_PACKAGE_ID = "package:generic-bundle"
export const MIXED_BUNDLE_VERSION = "1.0.0"
export const ROOT_AGENT_ID = "agent:generic-bundle-agent"
export const LEAF_SKILL_ID = "skill:generic-bundle-skill"
export const LEAF_MCP_ID = "mcp:generic-bundle-remote"
/** 已策展、但本 build 不支持的 optional leaf(第四格)。 */
export const LEAF_UNSUPPORTED_ID = "agent:generic-bundle-future"
export const MCP_SECRET_PREREQUISITE_ID = `${LEAF_MCP_ID}#C_TOKEN`
export const UNSUPPORTED_CAPABILITY = "alpha.future.v1"
/** decoder 对「capability 本 build 不认识」给出的 token —— 三个面都必须逐字用它。 */
export const EXPECTED_SKIP_REASON = "component-capability-unsupported"

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const canonicalBytes = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`)
const utf8 = (text: string) => new TextEncoder().encode(text)

export const AGENT_MD = `---
name: generic-bundle-agent
description: Generic bundle agent
mode: primary
---

Deterministic corpus prompt body.
`

export const SKILL_MD = `---
name: generic-bundle-skill
description: Generic bundle skill
---

Deterministic corpus skill body.
`

/** 第四格 leaf 的资产:形状合法,但它永远不会被取 —— 断言之一就是「零 fetch」。 */
const UNSUPPORTED_MD = `---
name: generic-bundle-future
description: Curated but unsupported here
---

Never installed on this build.
`

const payloadFor = (schema: string, targetDir: string, asset: Uint8Array, url: string) => ({
  schema,
  behavior: {
    targetDir,
    asset: { sha256: sha(asset), bytes: asset.byteLength, mediaType: "text/markdown", url },
  },
})

const MCP_PAYLOAD = {
  schema: "alpha.host-extension-package.payload.mcp-remote.v1",
  behavior: {
    auth: "none",
    headersTemplate: { "X-Bundle-Token": "{C_TOKEN}" },
    requiredSecrets: ["C_TOKEN"],
    url: "https://bundle.example.com/mcp",
  },
}

const componentOf = (
  id: string,
  profileId: string,
  required: boolean,
  capabilities: string[],
  bytes: Uint8Array,
  mediaProfile: string,
  dependencies: string[] = [],
) => ({
  id,
  required,
  dependencies,
  profileId,
  profileVersion: 1,
  capabilities,
  payloadRef: {
    sha256: sha(bytes),
    bytes: bytes.byteLength,
    mediaType: `application/vnd.alpha.host-extension-package.${mediaProfile}.v1+json`,
    url: `https://alphacodeone.com/catalog/assets/${id.replace(":", ".")}/1.0.0/alpha-package/payload.json`,
  },
})

export type MixedBundleFixture = {
  envelope: AlphaPackageEnvelopeV1
  /** payload digest → 字节(evaluatePackageForHost 的 fetchPayload 用)。 */
  payloadByDigest: Map<string, Uint8Array>
  /** markdown 资产 digest → 字节(admission 的 fetchAsset 用)。 */
  assetByDigest: Map<string, Uint8Array>
  agentAsset: Uint8Array
  skillAsset: Uint8Array
}

export function mixedBundleFixture(options?: {
  /** 第四格:是否带上那个「已策展但宿主不支持」的 optional leaf(默认带)。 */
  withUnsupportedOptionalLeaf?: boolean
  /** 让 skill 资产的 frontmatter name 与组件名不符 —— 生产 pre-switch probe 会因此判不健康。 */
  breakSkillFrontmatterName?: boolean
}): MixedBundleFixture {
  const withUnsupported = options?.withUnsupportedOptionalLeaf ?? true
  const agentAsset = utf8(AGENT_MD)
  const skillAsset = utf8(
    options?.breakSkillFrontmatterName ? SKILL_MD.replace("name: generic-bundle-skill", "name: not-the-skill") : SKILL_MD,
  )
  const unsupportedAsset = utf8(UNSUPPORTED_MD)

  const agentPayload = payloadFor(
    "alpha.host-extension-package.payload.agent.v1",
    "alpha-agents",
    agentAsset,
    "https://alphacodeone.com/catalog/assets/agent.generic-bundle-agent/1.0.0/AGENT.md",
  )
  const skillPayload = payloadFor(
    "alpha.host-extension-package.payload.skill.v1",
    "alpha-skills",
    skillAsset,
    "https://alphacodeone.com/catalog/assets/skill.generic-bundle-skill/1.0.0/SKILL.md",
  )
  const unsupportedPayload = payloadFor(
    "alpha.host-extension-package.payload.agent.v1",
    "alpha-agents",
    unsupportedAsset,
    "https://alphacodeone.com/catalog/assets/agent.generic-bundle-future/1.0.0/AGENT.md",
  )

  const agentBytes = canonicalBytes(agentPayload)
  const skillBytes = canonicalBytes(skillPayload)
  const mcpBytes = canonicalBytes(MCP_PAYLOAD)
  const unsupportedBytes = canonicalBytes(unsupportedPayload)

  const dependencies = [LEAF_SKILL_ID, LEAF_MCP_ID, ...(withUnsupported ? [LEAF_UNSUPPORTED_ID] : [])]
  const components = [
    componentOf(ROOT_AGENT_ID, "agent", true, [], agentBytes, "agent", dependencies),
    componentOf(LEAF_SKILL_ID, "skill", true, [], skillBytes, "skill"),
    componentOf(LEAF_MCP_ID, "mcp-remote", false, ["alpha.secret-prerequisite.v1"], mcpBytes, "mcp-remote"),
    // 违规/异常项放**最后**:只看第一个元素的实现要能被抓住。
    ...(withUnsupported
      ? [componentOf(LEAF_UNSUPPORTED_ID, "agent", false, [UNSUPPORTED_CAPABILITY], unsupportedBytes, "agent")]
      : []),
  ]

  const envelope = {
    schema: "alpha.host-extension-package.v1",
    prelude: { packageId: MIXED_BUNDLE_PACKAGE_ID, version: MIXED_BUNDLE_VERSION },
    presentation: {
      description: "Generic flat Bundle corpus input: one agent root and two leaves.",
      displayName: "Generic Bundle",
    },
    root: ROOT_AGENT_ID,
    components,
    // §4.3 第一层:签名并集含**全部**组件,包括不会被安装的那个。
    capabilities: [...new Set(components.flatMap((component) => component.capabilities))].sort(),
  } as unknown as AlphaPackageEnvelopeV1

  return {
    envelope,
    payloadByDigest: new Map([
      [sha(agentBytes), agentBytes],
      [sha(skillBytes), skillBytes],
      [sha(mcpBytes), mcpBytes],
      [sha(unsupportedBytes), unsupportedBytes],
    ]),
    assetByDigest: new Map([
      [sha(agentAsset), agentAsset],
      [sha(skillAsset), skillAsset],
      [sha(unsupportedAsset), unsupportedAsset],
    ]),
    agentAsset,
    skillAsset,
  }
}

export const mixedBundlePayload = (digest: string, fixture: MixedBundleFixture): PackageProfilePayloadV1 =>
  JSON.parse(new TextDecoder().decode(fixture.payloadByDigest.get(digest)!)) as PackageProfilePayloadV1

const VENDORED_BUNDLE = resolve(
  import.meta.dir,
  "../../alpha-contracts-consumer/vendor/alpha-web-extension-package/expected.bundle.compiled.json",
)

/**
 * 把本夹具与**真 producer 产物**的图形状对上。字节不同是刻意的(见文件抬头),形状不同就是漂移。
 */
export async function assertMatchesVendoredBundleShape(
  fixture: MixedBundleFixture,
  expectEqual: (actual: unknown, expected: unknown, label: string) => void,
) {
  const compiled = (await Bun.file(VENDORED_BUNDLE).json()) as { envelope: AlphaPackageEnvelopeV1 }
  const shapeOf = (envelope: AlphaPackageEnvelopeV1) => ({
    packageId: envelope.prelude.packageId,
    root: envelope.root,
    components: envelope.components
      .filter((component) => component.id !== LEAF_UNSUPPORTED_ID)
      .map((component) => ({
        id: component.id,
        required: component.required,
        profileId: component.profileId,
        profileVersion: component.profileVersion,
        capabilities: [...component.capabilities].sort(),
        dependencies: [...component.dependencies].filter((id) => id !== LEAF_UNSUPPORTED_ID).sort(),
      }))
      .sort((left, right) => (left.id < right.id ? -1 : 1)),
  })
  expectEqual(
    shapeOf(fixture.envelope),
    shapeOf(compiled.envelope),
    "canonical mixed Bundle 的图形状必须与 vendored producer 产物逐条相同",
  )
}
