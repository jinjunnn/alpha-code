// REQ-128 Phase 4 `#809` —— **五个 profile 各一个组件**的签名包夹具。
//
// 为什么是五个而不是「只放一个 plugin」:本票的第一条退出条件是「profile → child kind 的 exact
// mapping」,而那条断言的**期望集从 `PROFILE_REGISTRY_V1` 派生**。只放一个 plugin 组件的话,
// 「五个 profile 各自路由到不同的具名 builder」这半边就只能靠单元断言表内容 —— 而一张表对了、
// 生产分派仍是 `else → mcp` 的实现完全满足它。放齐五个,一次真安装的计划里就同时出现四个
// builder 各自的**特征 item**,路由是被跑出来的,不是被断言出来的。
//
// **第三方字节是真的**:plugin 组件的资产就是仓内 vendored 的 `opencode-notify/plugin.js`
// (34,093 B)。夹具不重造它 —— D3 的 canary 断言(`server()` 返回键恰为 `event` +
// `permission.ask`、两个值都是 function)必须打在**会被真的装进去的那份字节**上,
// 拿一份自己写的小 stub 去断言等于给一个不存在的成员造反例。
//
// markdown 资产的字节则**必须重造**(与 `package-mixed-bundle.fixture` 同因):vendored 的两个
// 语料没有 frontmatter,而宿主对 agent/skill 都强制要求。

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { AlphaPackageEnvelopeV1 } from "../src/shared/host-extension-package-contract/decoder"

export const PLUGIN_KIT_PACKAGE_ID = "package:plugin-kit"
export const PLUGIN_KIT_VERSION = "1.0.0"
export const ROOT_AGENT_ID = "agent:plugin-kit-root"
export const LEAF_SKILL_ID = "skill:plugin-kit-skill"
export const LEAF_MCP_LOCAL_ID = "mcp:plugin-kit-local"
export const LEAF_MCP_REMOTE_ID = "mcp:plugin-kit-remote"
/** managed plugin 组件。name(冒号之后)= `opencode-notify` —— 落盘目录与事务 key 都用它。 */
export const LEAF_PLUGIN_ID = "plugin:opencode-notify"
export const PLUGIN_NAME = "opencode-notify"

/** 仓内 vendored 的第三方字节。**唯一**来源,夹具与 wrapper ABI 闸共用同一份。 */
export const CANDIDATE_PLUGIN_JS = resolve(import.meta.dir, "../resources/plugins/opencode-notify/plugin.js")

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const canonicalBytes = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`)
const utf8 = (text: string) => new TextEncoder().encode(text)

const AGENT_MD = `---
name: plugin-kit-root
description: Plugin kit root agent
mode: primary
---

Deterministic corpus prompt body.
`

const SKILL_MD = `---
name: plugin-kit-skill
description: Plugin kit skill
---

Deterministic corpus skill body.
`

const markdownPayload = (schema: string, targetDir: string, asset: Uint8Array, url: string) => ({
  schema,
  behavior: {
    targetDir,
    asset: { sha256: sha(asset), bytes: asset.byteLength, mediaType: "text/markdown", url },
  },
})

const MCP_LOCAL_PAYLOAD = {
  schema: "alpha.host-extension-package.payload.mcp-local.v1",
  // 命令头必须过宿主的 `validateServer` 白名单(`ext-config.ts` 的 SAFE_COMMAND_HEADS)——
  // 夹具不绕过它,否则这条腿走的就不是生产那条路。
  behavior: { command: ["npx", "-y", "plugin-kit-local-server"], environment: {}, requiredSecrets: [] },
}

const MCP_REMOTE_PAYLOAD = {
  schema: "alpha.host-extension-package.payload.mcp-remote.v1",
  behavior: { auth: "none", headersTemplate: {}, requiredSecrets: [], url: "https://plugin-kit.example.com/mcp" },
}

const componentOf = (
  id: string,
  profileId: string,
  required: boolean,
  capabilities: string[],
  payloadBytes: Uint8Array,
  dependencies: string[] = [],
) => ({
  id,
  required,
  dependencies,
  profileId,
  profileVersion: 1,
  capabilities,
  payloadRef: {
    sha256: sha(payloadBytes),
    bytes: payloadBytes.byteLength,
    mediaType: `application/vnd.alpha.host-extension-package.${profileId}.v1+json`,
    url: `https://alphacodeone.com/catalog/assets/${id.replace(":", ".")}/1.0.0/alpha-package/payload.json`,
  },
})

export type PluginKitFixture = {
  envelope: AlphaPackageEnvelopeV1
  /** payloadRef.sha256 → 字节(`evaluatePackageForHost` 的 payload 取用)。 */
  payloadByDigest: Map<string, Uint8Array>
  /** 资产 url → 字节(admission 的资产取用)。 */
  assetByUrl: Map<string, Uint8Array>
  /** 第三方 JS 字节,逐字节等于仓内 vendored 的那份。 */
  pluginAsset: Uint8Array
  /** `plugins/<name>@<hex16>/` 里的 `<hex16>` —— 由 payloadRef.sha256 派生(内容寻址)。 */
  pluginDirName: string
}

export const PLUGIN_ASSET_URL = "https://alphacodeone.com/catalog/assets/plugin.opencode-notify/0.3.1/plugin.js"

export function pluginKitFixture(options?: {
  /** 把 JS 资产字节换成别的内容(integrity 负例用)。 */
  corruptPluginAsset?: boolean
  /** ADR-040(`#825`)对照组:同一个包**去掉** `opencode-plugin` 组件 —— 其余四个 profile 原样。
   *  它存在的唯一理由是把「拒绝只针对 plugin」与「整条 package 通道被我改坏了」分开。 */
  withoutPlugin?: boolean
  /** ADR-040(`#830`)第二形态:plugin 组件**不声明任何 capability**。
   *
   *  合同层回滚同时撤掉了两样东西 —— `opencode-plugin` profile 与 `engine:config` /
   *  `engine:plugin` 两个 token(连同文法里容纳冒号的那条支路)。默认形态两样都踩,于是
   *  「哪一样在拦」分不出来:把 profile 悄悄加回注册表,默认形态仍会被文法拦下而不红。
   *  这一档只踩 profile 那一样,让两半各自可被单独证伪。 */
  pluginWithoutCapabilities?: boolean
}): PluginKitFixture {
  const agentAsset = utf8(AGENT_MD)
  const skillAsset = utf8(SKILL_MD)
  const vendored = new Uint8Array(readFileSync(CANDIDATE_PLUGIN_JS))
  const pluginAsset = options?.corruptPluginAsset ? utf8("export default () => ({})\n") : vendored

  const agentPayload = markdownPayload(
    "alpha.host-extension-package.payload.agent.v1",
    "alpha-agents",
    agentAsset,
    "https://alphacodeone.com/catalog/assets/agent.plugin-kit-root/1.0.0/AGENT.md",
  )
  const skillPayload = markdownPayload(
    "alpha.host-extension-package.payload.skill.v1",
    "alpha-skills",
    skillAsset,
    "https://alphacodeone.com/catalog/assets/skill.plugin-kit-skill/1.0.0/SKILL.md",
  )
  // 宿主永远按**签名里的 sha256/bytes** 复验下载回来的字节 —— 所以 integrity 负例只要换字节、
  // 不动签名,就走的是生产那条真实的拒绝路径。
  const pluginPayload = {
    schema: "alpha.host-extension-package.payload.opencode-plugin.v1",
    behavior: {
      asset: {
        sha256: sha(vendored),
        bytes: vendored.byteLength,
        mediaType: "text/javascript",
        url: PLUGIN_ASSET_URL,
      },
    },
  }

  const agentBytes = canonicalBytes(agentPayload)
  const skillBytes = canonicalBytes(skillPayload)
  const mcpLocalBytes = canonicalBytes(MCP_LOCAL_PAYLOAD)
  const mcpRemoteBytes = canonicalBytes(MCP_REMOTE_PAYLOAD)
  const pluginBytes = canonicalBytes(pluginPayload)

  const components = [
    componentOf(
      ROOT_AGENT_ID,
      "agent",
      true,
      [],
      agentBytes,
      options?.withoutPlugin
        ? [LEAF_SKILL_ID, LEAF_MCP_LOCAL_ID, LEAF_MCP_REMOTE_ID]
        : [LEAF_SKILL_ID, LEAF_MCP_LOCAL_ID, LEAF_MCP_REMOTE_ID, LEAF_PLUGIN_ID],
    ),
    componentOf(LEAF_SKILL_ID, "skill", true, [], skillBytes),
    componentOf(LEAF_MCP_LOCAL_ID, "mcp-local", true, [], mcpLocalBytes),
    componentOf(LEAF_MCP_REMOTE_ID, "mcp-remote", true, [], mcpRemoteBytes),
    // Phase 4 的 managed plugin 组件,**逐字保留发布端当时会发出的形状**:两个 capability
    // 声明的是「引擎会执行它的 JS」与「宿主要替用户改引擎配置指向它」。ADR-040 之后宿主两样
    // 都不认了 —— 夹具不跟着改成一个宿主认得的形状,否则测的就不是那个陈旧生产者会发来的字节。
    ...(options?.withoutPlugin
      ? []
      : [
          componentOf(
            LEAF_PLUGIN_ID,
            "opencode-plugin",
            true,
            options?.pluginWithoutCapabilities ? [] : ["engine:config", "engine:plugin"],
            pluginBytes,
          ),
        ]),
  ]

  const envelope = {
    schema: "alpha.host-extension-package.v1",
    prelude: { packageId: PLUGIN_KIT_PACKAGE_ID, version: PLUGIN_KIT_VERSION },
    presentation: {
      description: "One component per registered host profile, including a managed OpenCode Plugin.",
      displayName: "Plugin Kit",
    },
    root: ROOT_AGENT_ID,
    components,
    capabilities: [...new Set(components.flatMap((component) => component.capabilities))].sort(),
  } as unknown as AlphaPackageEnvelopeV1

  return {
    envelope,
    payloadByDigest: new Map([
      [sha(agentBytes), agentBytes],
      [sha(skillBytes), skillBytes],
      [sha(mcpLocalBytes), mcpLocalBytes],
      [sha(mcpRemoteBytes), mcpRemoteBytes],
      [sha(pluginBytes), pluginBytes],
    ]),
    assetByUrl: new Map([
      [agentPayload.behavior.asset.url, agentAsset],
      [skillPayload.behavior.asset.url, skillAsset],
      [PLUGIN_ASSET_URL, pluginAsset],
    ]),
    pluginAsset,
    // 目录名取的是**签名里的** payload digest,与宿主账本 `payloadDigest` 同一个值。
    pluginDirName: `${PLUGIN_NAME}@${sha(pluginBytes).slice(0, 16)}`,
  }
}
