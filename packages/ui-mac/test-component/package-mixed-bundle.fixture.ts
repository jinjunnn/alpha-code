// REQ-128 `#697` canonical mixed Bundle —— 一处夹具,两个闸门共用(单元面与生产接线面)。
//
// **形状**取自 vendored producer 产物 `expected.bundle.compiled.json`(agent root + skill leaf +
// 带必需密钥的 mcp-remote leaf + command leaf)。它不是抄来的:`assertMatchesVendoredBundleShape` 会把本夹具的
// root / 组件 id / required / profile / dependencies 与那份**真产物**逐条对照,上游改了 canonical
// Bundle 的形状,这里就红,而不是悄悄漂成一个只有我们自己认得的图。
//
// **字节**当初必须重造,原因是一个真实缺口:vendored 的两个 markdown 资产
// (`asset.generic-bundle-{agent,skill}.md`)**没有 frontmatter**,而宿主对两者都强制要求
//   · agent:`agentMdToEntry` 需要 `---` 块 + `description` + 非空 body;
//   · skill:`skillGenerationProbe` 需要 frontmatter `name` 等于 item key。
// 也就是说那份产物在当时的宿主上装不进去。
//
// **那个缺口已经关了**(`aw#112`,随 `#811` re-vendor 到 aw@9fcd83d 进来):上游两份资产现在
// 都带 frontmatter,而下面 `AGENT_MD` / `SKILL_MD` 这两串**逐字节等于**新的 vendored 资产
// (118 / 103 字节,sha256 `f2a5576d…` / `4e62da1a…`,也正是 `expected.bundle.compiled.json`
// 里那两个 `behavior.asset.sha256`)。**但这份等同没有任何断言看着** —— 上游下次再动资产
// 内容,这里不会红,只会安静地变回一份手抄替身。留成这样是本票(`#811`)刻意划的边界:
// 它要加的是一道新闸,不在 re-vendor 的范围里。
//
// 夹具**仍然**自建信封,理由换成了两条与 frontmatter 无关的:第五格那个 optional leaf(下一段),
// 以及 `breakSkillFrontmatterName` 这个打 pre-switch probe 的开关 —— 两者上游产物里都没有。
//
// 第五格「已策展但宿主不支持的 optional child」语料里没有(上游只发布宿主支持的 profile),
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
export const LEAF_COMMAND_ID = "command:generic-bundle-command"
/** 已策展、但本 build 不支持的 optional leaf(第五格)。 */
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

export const COMMAND_MD = `Deterministic corpus command template body.

Review $ARGUMENTS and report the result.
`

/** 第五格 leaf 的资产:形状合法,但它永远不会被取 —— 断言之一就是「零 fetch」。 */
const UNSUPPORTED_MD = `---
name: generic-bundle-future
description: Curated but unsupported here
---

Never installed on this build.
`

/**
 * `#828`:skill leaf 的**兄弟文件**。
 *
 * 两条选择都是刻意的:
 *   · `reference/guide.md` 带一层子目录 —— 实测语料的相对路径深度上界正是 2;
 *   · `scripts/run.sh` 是**非 markdown**,而且源端是一个 shell 脚本 —— 语料里 25/345 个
 *     技能内文件带可执行位(19 个 755、6 个 700)。旧形状结构上表达不了这两者,
 *     所以拿它们当判据:装完之后它们必须逐字节在盘上,且**不带任何可执行位**。
 */
export const SKILL_REFERENCE_MD = `# Reference

Deterministic corpus reference material for the bundle skill.
`

export const SKILL_RUN_SH = `#!/usr/bin/env bash
set -euo pipefail
echo "deterministic corpus helper"
`

/** 技能载荷的相对路径清单(顺序 = 声明顺序;断言按 path 取,不靠下标)。 */
export const SKILL_FILE_PATHS = ["SKILL.md", "reference/guide.md", "scripts/run.sh"] as const

const agentPayloadFor = (targetDir: string, asset: Uint8Array, url: string) => ({
  schema: "alpha.host-extension-package.payload.agent.v1",
  behavior: {
    targetDir,
    asset: { sha256: sha(asset), bytes: asset.byteLength, mediaType: "text/markdown", url },
  },
})

/**
 * `urlPath` 与 `path` 分开是**必需**的,不是方便:`decodeHttpsUrl` 要求 URL 逐字 canonical
 * (`new URL(x).href === x`),所以一条带 `..` 的 URL 在解码期就被拒 —— 那样"逃逸路径"用例
 * 测到的是 URL 那一层,而不是路径那一层。真实的攻击形状本来也是这个:URL 完全合法,
 * 生产者在 `path` 上声明一个往外跳的落点。
 */
type SkillFixtureFile = { path: string; data: Uint8Array; urlPath?: string }

const skillPayloadFor = (files: SkillFixtureFile[], base: string) => ({
  schema: "alpha.host-extension-package.payload.skill.v1",
  behavior: {
    targetDir: "alpha-skills",
    files: files.map((file) => ({
      path: file.path,
      sha256: sha(file.data),
      bytes: file.data.byteLength,
      url: `${base}/${file.urlPath ?? file.path}`,
    })),
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

const commandPayloadFor = (template: Uint8Array) => ({
  behavior: {
    description: "Generic bundle command",
    subtask: false,
    template: {
      bytes: template.byteLength,
      mediaType: "text/markdown",
      sha256: sha(template),
      url: "https://alphacodeone.com/catalog/assets/command.generic-bundle-command/1.0.0/COMMAND.md",
    },
  },
  schema: "alpha.host-extension-package.payload.command.v1",
})

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
  commandAsset: Uint8Array
  /** `#828`:skill 载荷的**整份**清单(相对路径 → 期望字节)。逐文件比对的真源。 */
  skillFiles: SkillFixtureFile[]
}

export function mixedBundleFixture(options?: {
  /** 第五格:是否带上那个「已策展但宿主不支持」的 optional leaf(默认带)。 */
  withUnsupportedOptionalLeaf?: boolean
  /** 让 skill 资产的 frontmatter name 与组件名不符 —— 生产 pre-switch probe 会因此判不健康。 */
  breakSkillFrontmatterName?: boolean
  /**
   * `#828`:把 skill 载荷退回**单文件**(只有 SKILL.md)。
   *
   * 两个用途,方向相反:
   *   ① 正向 —— 单文件技能仍然装得上(不许为了多文件把单文件弄坏);
   *   ② 绕过配方 —— 拿它跑「逐文件在盘上」那条断言,**必须当场变红**。
   */
  singleFileSkill?: boolean
  /**
   * `#828`:给技能载荷加一条**逃逸路径**的兄弟文件(`../evil.md`)。
   *
   * 宿主的解码层按裁决**不判路径安全**(唯一所有者是 `promotePayloadToCas`)。这条选项存在
   * 是因为「唯一所有者今天拦得住」与「签名 package 这条路上有东西看着它」是两件事:
   * 没有它,谁哪天拆掉一层兜底,**这条路上不会有任何东西变红**。
   */
  escapingSkillPath?: boolean
}): MixedBundleFixture {
  const withUnsupported = options?.withUnsupportedOptionalLeaf ?? true
  const agentAsset = utf8(AGENT_MD)
  const skillAsset = utf8(
    options?.breakSkillFrontmatterName ? SKILL_MD.replace("name: generic-bundle-skill", "name: not-the-skill") : SKILL_MD,
  )
  const skillFiles: SkillFixtureFile[] = options?.singleFileSkill
    ? [{ path: "SKILL.md", data: skillAsset }]
    : options?.escapingSkillPath
      ? [
          { path: "SKILL.md", data: skillAsset },
          // 逃逸项放**第二个**:只看第一个元素的实现要能被抓住。
          // URL 一侧完全合法(canonical),越界的只有 `path`。
          { path: "../evil.md", data: utf8(SKILL_REFERENCE_MD), urlPath: "evil.md" },
        ]
      : [
          { path: "SKILL.md", data: skillAsset },
          { path: "reference/guide.md", data: utf8(SKILL_REFERENCE_MD) },
          { path: "scripts/run.sh", data: utf8(SKILL_RUN_SH) },
        ]
  const unsupportedAsset = utf8(UNSUPPORTED_MD)
  const commandAsset = utf8(COMMAND_MD)

  const agentPayload = agentPayloadFor(
    "alpha-agents",
    agentAsset,
    "https://alphacodeone.com/catalog/assets/agent.generic-bundle-agent/1.0.0/AGENT.md",
  )
  const skillPayload = skillPayloadFor(
    skillFiles,
    "https://alphacodeone.com/catalog/assets/skill.generic-bundle-skill/1.0.0",
  )
  const commandPayload = commandPayloadFor(commandAsset)
  const unsupportedPayload = agentPayloadFor(
    "alpha-agents",
    unsupportedAsset,
    "https://alphacodeone.com/catalog/assets/agent.generic-bundle-future/1.0.0/AGENT.md",
  )

  const agentBytes = canonicalBytes(agentPayload)
  const skillBytes = canonicalBytes(skillPayload)
  const mcpBytes = canonicalBytes(MCP_PAYLOAD)
  const commandBytes = canonicalBytes(commandPayload)
  const unsupportedBytes = canonicalBytes(unsupportedPayload)

  const dependencies = [
    LEAF_SKILL_ID,
    LEAF_MCP_ID,
    LEAF_COMMAND_ID,
    ...(withUnsupported ? [LEAF_UNSUPPORTED_ID] : []),
  ]
  const components = [
    componentOf(ROOT_AGENT_ID, "agent", true, [], agentBytes, "agent", dependencies),
    componentOf(LEAF_SKILL_ID, "skill", true, [], skillBytes, "skill"),
    componentOf(LEAF_MCP_ID, "mcp-remote", false, ["alpha.secret-prerequisite.v1"], mcpBytes, "mcp-remote"),
    componentOf(LEAF_COMMAND_ID, "command", false, [], commandBytes, "command"),
    // 违规/异常项放**最后**:只看第一个元素的实现要能被抓住。
    ...(withUnsupported
      ? [componentOf(LEAF_UNSUPPORTED_ID, "agent", false, [UNSUPPORTED_CAPABILITY], unsupportedBytes, "agent")]
      : []),
  ]

  const envelope = {
    schema: "alpha.host-extension-package.v1",
    prelude: { packageId: MIXED_BUNDLE_PACKAGE_ID, version: MIXED_BUNDLE_VERSION },
    presentation: {
      description: "Generic flat Bundle corpus input: one agent root and four leaves.",
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
      [sha(commandBytes), commandBytes],
      [sha(unsupportedBytes), unsupportedBytes],
    ]),
    assetByDigest: new Map([
      [sha(agentAsset), agentAsset],
      ...skillFiles.map((file) => [sha(file.data), file.data] as const),
      [sha(commandAsset), commandAsset],
      [sha(unsupportedAsset), unsupportedAsset],
    ]),
    agentAsset,
    skillAsset,
    commandAsset,
    skillFiles,
  }
}

export const mixedBundlePayload = (digest: string, fixture: MixedBundleFixture): PackageProfilePayloadV1 =>
  JSON.parse(new TextDecoder().decode(fixture.payloadByDigest.get(digest)!)) as PackageProfilePayloadV1

const VENDORED_BUNDLE = resolve(
  import.meta.dir,
  "../../alpha-contracts-consumer/vendor/alpha-web-extension-package/expected.bundle.compiled.json",
)

/**
 * 把本夹具与**真 producer 产物**的图形状对上。形状不同就是漂移。
 * 这里**只**比形状,不比资产字节 —— 两份共享资产今天恰好逐字节相同(见文件抬头),
 * 但那件事没有断言,别把这条形状断言读成「字节也验过了」。
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
