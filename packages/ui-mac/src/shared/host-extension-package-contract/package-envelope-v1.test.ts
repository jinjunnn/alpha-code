import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { describe, expect, test } from "bun:test"
import {
  decodePackageEnvelopeHeaderV1,
  decodePackageProfilePayloadV1,
  derivePayloadCapabilitiesV1,
  PACKAGE_COMPONENT_SKIP_REASONS_V1,
  type PackageProfilePayloadV1,
} from "./decoder"
import { HOST_EXTENSION_PACKAGE_CORPUS } from "./generate-artifact"
import { HOST_EXTENSION_PACKAGE_LIMITS_V1 } from "./registry"
import { runSyntheticPackageDecoderV1 } from "./synthetic-decoder"

type CorpusCase = {
  name: string
  expect: "accepted" | "blocked"
  skipped: string[]
  envelope: Record<string, unknown>
  components: Array<{ id: string; payload: Record<string, unknown> | null }>
}

type Calls = { fetch: number; decoder: number; secret: number; planner: number }

const encoder = new TextEncoder()
const corpus = (await Bun.file(resolve(import.meta.dir, HOST_EXTENSION_PACKAGE_CORPUS)).json()) as {
  schema: string
  cases: CorpusCase[]
}

const jsonBytes = (value: unknown) => encoder.encode(`${JSON.stringify(value, null, 2)}\n`)

const caseNamed = (name: string) => structuredClone(corpus.cases.find((item) => item.name === name)!)

const runCase = async (
  item: CorpusCase,
  calls: Calls,
  payloadBytesFor?: (componentId: string) => Uint8Array,
) =>
  runSyntheticPackageDecoderV1(jsonBytes(item.envelope), {
    fetchPayload: async (_envelope, component) => {
      calls.fetch++
      if (payloadBytesFor) return payloadBytesFor(component.id)
      const found = item.components.find((entry) => entry.id === component.id)
      return found?.payload ? jsonBytes(found.payload) : new Uint8Array()
    },
    decodePayload: (profileId, bytes, capabilities) => {
      calls.decoder++
      return decodePackageProfilePayloadV1(profileId, bytes, capabilities)
    },
    resolveSecrets: async () => {
      calls.secret++
    },
    plan: async () => {
      calls.planner++
      return "planned"
    },
  })

const noCalls = (): Calls => ({ fetch: 0, decoder: 0, secret: 0, planner: 0 })

// ── §4.1 图文法的负向集 ────────────────────────────────────────────────────
// 每条都是「除了这一处以外完全合法」的最小畸形。判据只有一条:决不能被接受。
// 直接改**已生成的 canonical 语料**,而不是自己再手搭一个信封 —— 手搭的替身会跟着
// 合同一起漂,漂了也不会红。
type GraphCase = { name: string; source: string; error: string; mutate: (envelope: Record<string, unknown>) => void }

const componentsOf = (envelope: Record<string, unknown>) =>
  envelope.components as Array<Record<string, unknown>>

const rootOf = (envelope: Record<string, unknown>) =>
  componentsOf(envelope).find((component) => component.id === envelope.root)!

/** `#827`:把单组件语料 `skill-v1` 加宽成 `leafCount + 1` 个组件的合法包。从**已生成的 canonical
 *  语料**加宽而不手搭替身(手搭的会跟着合同一起漂,漂了也不会红)。三条边界用例共用。 */
const widenSkillCase = (leafCount: number) => {
  const item = caseNamed("skill-v1")
  const root = rootOf(item.envelope)
  const leaves = Array.from({ length: leafCount }, (_, index) => ({
    ...structuredClone(root),
    id: `skill:leaf-${String(index).padStart(2, "0")}`,
    required: false,
    dependencies: [],
  }))
  root.dependencies = leaves.map((leaf) => leaf.id)
  item.envelope.components = [root, ...leaves]
  item.components = [
    item.components[0]!,
    ...leaves.map((leaf) => ({ id: leaf.id, payload: item.components[0]!.payload })),
  ]
  return item
}

/** `#827`:把 registry 组件上界临时挪到 `value`,`finally` 无条件恢复。改的就是生产读的那一份
 *  对象 —— 注入假 limits 只能证明「假的被读了」,证明不了真的那份有人读。 */
const withMaxComponents = (value: number, body: () => void): void => {
  const limits = HOST_EXTENSION_PACKAGE_LIMITS_V1 as { maxComponents: number }
  const previous = limits.maxComponents
  limits.maxComponents = value
  try {
    body()
  } finally {
    limits.maxComponents = previous
  }
}

const graphCases: GraphCase[] = [
  {
    // `#807` 回归闸。capability 文法一度为了容纳 `engine:config` 被放宽成通用字符类
    // `[a-z0-9.:-]`,连带把 `a::b` / `a:` / `engine:` 一起判成合法。危险的不是「多认了几个
    // 字符串」,而是它们挂在 **optional** 叶子上时:membership 让叶子被 skipped,而整包仍在
    // `decodeEnvelopeObject` 末尾判 accepted —— 畸形值一路进来又哪里都不出现。
    // **判据必须是「整包被拒」**,不是「叶子被跳过」:后者对畸形值恒真,杀不掉这个缺陷。
    name: "a malformed colon capability on an optional leaf blocks the whole package",
    source: "bundle-optional-unsupported-capability",
    error: "capabilities[0]: invalid format",
    mutate: (envelope) => {
      const leaf = componentsOf(envelope).find((component) => component.id !== envelope.root)!
      leaf.capabilities = ["a::b"]
      envelope.capabilities = ["a::b"]
    },
  },
  {
    name: "duplicate component id",
    source: "bundle-optional-unsupported-capability",
    error: "duplicate component id",
    mutate: (envelope) => {
      const components = componentsOf(envelope)
      components[1]!.id = components[0]!.id
    },
  },
  {
    name: "root is not one of the components",
    source: "skill-v1",
    error: "is not one of envelope.components[].id",
    mutate: (envelope) => {
      envelope.root = "skill:not-in-this-package"
    },
  },
  {
    name: "root component is not required",
    source: "skill-v1",
    error: "must be required",
    mutate: (envelope) => {
      rootOf(envelope).required = false
    },
  },
  {
    name: "root dependencies repeat an id",
    source: "bundle-optional-unsupported-capability",
    error: "duplicate id",
    mutate: (envelope) => {
      const root = rootOf(envelope)
      root.dependencies = [...(root.dependencies as string[]), (root.dependencies as string[])[0]!]
    },
  },
  {
    name: "root omits a non-root component (orphan)",
    source: "bundle-optional-unsupported-capability",
    error: "is not depended on by the root (orphan)",
    mutate: (envelope) => {
      rootOf(envelope).dependencies = []
    },
  },
  {
    name: "root depends on an id outside this package",
    source: "bundle-optional-unsupported-capability",
    error: "is not a component of this package",
    mutate: (envelope) => {
      const root = rootOf(envelope)
      root.dependencies = [...(root.dependencies as string[]), "skill:somewhere-else"]
    },
  },
  {
    name: "a non-root component declares dependencies (nesting)",
    source: "bundle-optional-unsupported-profile",
    error: "only the root component may declare dependencies",
    mutate: (envelope) => {
      const components = componentsOf(envelope)
      const leaves = components.filter((component) => component.id !== envelope.root)
      leaves[0]!.dependencies = [leaves[1]!.id]
    },
  },
  {
    name: "root depends on itself",
    source: "bundle-optional-unsupported-capability",
    error: "must not depend on itself",
    mutate: (envelope) => {
      const root = rootOf(envelope)
      root.dependencies = [...(root.dependencies as string[]), envelope.root as string]
    },
  },
  {
    name: "two components depend on each other (cycle)",
    source: "bundle-optional-unsupported-capability",
    error: "only the root component may declare dependencies",
    mutate: (envelope) => {
      const components = componentsOf(envelope)
      const leaf = components.find((component) => component.id !== envelope.root)!
      leaf.dependencies = [envelope.root as string]
    },
  },
  {
    name: "component count exceeds maxComponents",
    source: "skill-v1",
    error: `requires 1..${HOST_EXTENSION_PACKAGE_LIMITS_V1.maxComponents} components`,
    mutate: (envelope) => {
      const root = rootOf(envelope)
      const extra = Array.from({ length: HOST_EXTENSION_PACKAGE_LIMITS_V1.maxComponents }, (_, index) => ({
        ...structuredClone(root),
        id: `skill:overflow-${String(index).padStart(2, "0")}`,
        required: false,
        dependencies: [],
      }))
      root.dependencies = extra.map((component) => component.id)
      envelope.components = [root, ...extra]
    },
  },
  {
    name: "envelope capabilities are not the union over every component",
    source: "bundle-optional-unsupported-profile",
    error: "sorted union of every component's capabilities",
    mutate: (envelope) => {
      // 把被跳过子件的 capability 从并集里摘掉。§4.3 面 1:签名并集与宿主支持与否无关。
      envelope.capabilities = (envelope.capabilities as string[]).filter(
        (token) => token !== "alpha.future.v1",
      )
    },
  },
  {
    name: "root dependency list exceeds maxComponents - 1",
    source: "skill-v1",
    error: `exceeds ${HOST_EXTENSION_PACKAGE_LIMITS_V1.maxComponents - 1} items`,
    mutate: (envelope) => {
      rootOf(envelope).dependencies = Array.from(
        { length: HOST_EXTENSION_PACKAGE_LIMITS_V1.maxComponents },
        (_, index) => `skill:dep-${String(index).padStart(2, "0")}`,
      )
    },
  },
]

type NegativeCase = {
  name: string
  source: string
  mode: "header" | "payload" | "package"
  error: string
  mutateEnvelope?: (envelope: Record<string, unknown>) => void
  mutatePayload?: (payload: Record<string, unknown>) => void
  payloadBytes?: (payload: Record<string, unknown>) => Uint8Array
}

const negativeCases: NegativeCase[] = [
  {
    name: "agent blocked: missing asset object",
    source: "agent-v1",
    mode: "package",
    error: "payload.behavior.asset: required object",
    mutatePayload: (payload) => {
      delete behaviorOf(payload).asset
    },
  },
  {
    name: "agent malicious: targetDir path traversal",
    source: "agent-v1",
    mode: "package",
    error: "payload.behavior.targetDir: expected one of [alpha-agents, global]",
    mutatePayload: (payload) => {
      behaviorOf(payload).targetDir = "../../.claude/agents"
    },
  },
  {
    // `#828`:两条结构界的挂点从 `behavior.asset` 移到 `behavior.files[0]`。挂在 agent 上会让
    // 它们与「skill 载荷形状」脱钩 —— 而 skill 才是这一票动过的那一半。
    name: "payload depth limit",
    source: "skill-v1",
    mode: "payload",
    error: "payload.behavior.files[0].extra.a.b.c.d: depth 9 exceeds 8",
    mutatePayload: (payload) => {
      ;(skillFilesOf(payload)[0] as Record<string, unknown>).extra = {
        a: { b: { c: { d: { e: true } } } },
      }
    },
  },
  {
    name: "payload node limit",
    source: "skill-v1",
    mode: "payload",
    error: "node limit 512 exceeded",
    mutatePayload: (payload) => {
      ;(skillFilesOf(payload)[0] as Record<string, unknown>).extra = Array.from(
        { length: 520 },
        (_, index) => index,
      )
    },
  },
  {
    name: "payload control character",
    source: "skill-v1",
    mode: "payload",
    error: "control characters not allowed",
    mutatePayload: (payload) => {
      behaviorOf(payload).targetDir = "alpha-skills\u0000"
    },
  },
  {
    name: "payload prototype-pollution key",
    source: "skill-v1",
    mode: "payload",
    error: 'prototype-pollution key "__proto__" refused',
    payloadBytes: (payload) =>
      encoder.encode(JSON.stringify(payload).replace("{", '{"__proto__":{"polluted":true},')),
  },
  {
    name: "payload byte limit",
    source: "skill-v1",
    mode: "payload",
    error: "bytes exceeds",
    payloadBytes: () => new Uint8Array(HOST_EXTENSION_PACKAGE_LIMITS_V1.maxPayloadBytes + 1),
  },
  {
    name: "payload maxStringBytes",
    source: "skill-v1",
    mode: "payload",
    error: "string exceeds 4096 UTF-8 bytes",
    mutatePayload: (payload) => {
      behaviorOf(payload).targetDir = "é".repeat(2049)
    },
  },
  {
    name: "payload property-name control character",
    source: "skill-v1",
    mode: "payload",
    error: "control characters in property names not allowed",
    mutatePayload: (payload) => {
      behaviorOf(payload)["bad\u0000key"] = true
    },
  },
  {
    name: "capability count limit",
    source: "skill-v1",
    mode: "header",
    error: "exceeds 16 items",
    mutateEnvelope: (envelope) => {
      const capabilities = Array.from(
        { length: 17 },
        (_, index) => `alpha.capability-${String(index).padStart(2, "0")}.v1`,
      )
      rootOf(envelope).capabilities = capabilities
      envelope.capabilities = capabilities
    },
  },
  {
    name: "capabilities sorted and unique",
    source: "mcp-local-v1",
    mode: "header",
    error: "must be unique and byte-order sorted",
    mutateEnvelope: (envelope) => {
      const capabilities = [
        "alpha.secret-prerequisite.v1",
        "alpha.secret-prerequisite.v1",
      ]
      rootOf(envelope).capabilities = capabilities
      envelope.capabilities = capabilities
    },
  },
  {
    name: "payloadRef URL is HTTPS-only",
    source: "skill-v1",
    mode: "header",
    error: "required canonical HTTPS URL without credentials",
    mutateEnvelope: (envelope) => {
      payloadRefOf(envelope).url = "http://example.invalid/package.json"
    },
  },
  {
    name: "payloadRef URL has no credentials",
    source: "skill-v1",
    mode: "header",
    error: "required canonical HTTPS URL without credentials",
    mutateEnvelope: (envelope) => {
      payloadRefOf(envelope).url = "https://user:pass@example.invalid/package.json"
    },
  },
  {
    name: "payloadRef URL has canonical hostname",
    source: "skill-v1",
    mode: "header",
    error: "required canonical HTTPS URL without credentials",
    mutateEnvelope: (envelope) => {
      payloadRefOf(envelope).url = "https://EXAMPLE.invalid/package.json"
    },
  },
  {
    name: "payloadRef bare origin has canonical slash",
    source: "skill-v1",
    mode: "header",
    error: "required canonical HTTPS URL without credentials",
    mutateEnvelope: (envelope) => {
      payloadRefOf(envelope).url = "https://example.invalid"
    },
  },
  {
    name: "payload remote URL is HTTPS-only",
    source: "mcp-remote-v1",
    mode: "package",
    error: "required canonical HTTPS URL without credentials",
    mutatePayload: (payload) => {
      behaviorOf(payload).url = "http://mcp.example.invalid/service"
    },
  },
  {
    name: "payload remote URL has no credentials",
    source: "mcp-remote-v1",
    mode: "package",
    error: "required canonical HTTPS URL without credentials",
    mutatePayload: (payload) => {
      behaviorOf(payload).url = "https://user:pass@mcp.example.invalid/service"
    },
  },
  {
    name: "payload remote URL is canonical",
    source: "mcp-remote-v1",
    mode: "package",
    error: "required canonical HTTPS URL without credentials",
    mutatePayload: (payload) => {
      behaviorOf(payload).url = "https://MCP.example.invalid/service"
    },
  },
  {
    name: "compiler-derived capabilities are rechecked before prerequisites and planner",
    source: "mcp-local-v1",
    mode: "package",
    error: "compiler-derived capabilities",
    mutateEnvelope: (envelope) => {
      rootOf(envelope).capabilities = []
      envelope.capabilities = []
    },
  },
  {
    name: "payloadRef mediaType is profile-bound",
    source: "skill-v1",
    mode: "header",
    error: 'expected "application/vnd.alpha.host-extension-package.skill.v1+json"',
    mutateEnvelope: (envelope) => {
      payloadRefOf(envelope).mediaType =
        "application/vnd.alpha.host-extension-package.mcp-local.v1+json"
    },
  },
  {
    name: "payload schema matches profile",
    source: "skill-v1",
    mode: "package",
    error: 'payload.schema: expected "alpha.host-extension-package.payload.skill.v1"',
    mutatePayload: (payload) => {
      payload.schema = "alpha.host-extension-package.payload.agent.v1"
    },
  },
  {
    name: "packageId regex",
    source: "skill-v1",
    mode: "header",
    error: "envelope.prelude.packageId: invalid format",
    mutateEnvelope: (envelope) => {
      ;(envelope.prelude as Record<string, unknown>).packageId = "Skill:demo"
    },
  },
  {
    name: "version regex",
    source: "skill-v1",
    mode: "header",
    error: "envelope.prelude.version: invalid format",
    mutateEnvelope: (envelope) => {
      ;(envelope.prelude as Record<string, unknown>).version = "-1"
    },
  },
  {
    name: "root id regex",
    source: "skill-v1",
    mode: "header",
    error: "envelope.root: invalid format",
    mutateEnvelope: (envelope) => {
      envelope.root = "Skill:demo"
    },
  },
  {
    name: "environment-name regex",
    source: "mcp-local-v1",
    mode: "package",
    error: 'payload.behavior.environment: invalid key "bad-name"',
    mutatePayload: (payload) => {
      behaviorOf(payload).environment = { "bad-name": "value" }
    },
  },
  {
    name: "sha256 lowercase-hex regex",
    source: "skill-v1",
    mode: "header",
    error: "payloadRef.sha256: invalid format",
    mutateEnvelope: (envelope) => {
      payloadRefOf(envelope).sha256 = "G".repeat(64)
    },
  },
  {
    name: "payloadRef bytes lower bound",
    source: "skill-v1",
    mode: "header",
    error: "required integer in 1..1048576",
    mutateEnvelope: (envelope) => {
      payloadRefOf(envelope).bytes = 0
    },
  },
  {
    name: "payloadRef bytes upper bound",
    source: "skill-v1",
    mode: "header",
    error: "required integer in 1..1048576",
    mutateEnvelope: (envelope) => {
      payloadRefOf(envelope).bytes = HOST_EXTENSION_PACKAGE_LIMITS_V1.maxPayloadBytes + 1
    },
  },
  {
    name: "payload UTF-8 fatal decode",
    source: "skill-v1",
    mode: "payload",
    error: "not valid UTF-8",
    payloadBytes: () => new Uint8Array([0xc3, 0x28]),
  },
  {
    name: "profileVersion must be an integer",
    source: "skill-v1",
    mode: "header",
    error: "required positive 32-bit integer",
    mutateEnvelope: (envelope) => {
      rootOf(envelope).profileVersion = 1.5
    },
  },
  {
    name: "profileVersion lower bound",
    source: "skill-v1",
    mode: "header",
    error: "required positive 32-bit integer",
    mutateEnvelope: (envelope) => {
      rootOf(envelope).profileVersion = 0
    },
  },
  {
    name: "profileVersion upper bound",
    source: "skill-v1",
    mode: "header",
    error: "required positive 32-bit integer",
    mutateEnvelope: (envelope) => {
      rootOf(envelope).profileVersion = 2147483648
    },
  },
  // ── rev3 修订 B:auth 是判别联合,不是字符串枚举 ─────────────────────────
  {
    name: "remote auth rejects an unknown bare string",
    source: "mcp-remote-v1",
    mode: "package",
    error: 'payload.behavior.auth: required "none" or an authorization object',
    mutatePayload: (payload) => {
      behaviorOf(payload).auth = "oauth"
    },
  },
  {
    name: "remote auth rejects an unknown kind",
    source: "mcp-remote-v1",
    mode: "package",
    error: "payload.behavior.auth.kind: expected one of [alpha-connection, mcp-oauth]",
    mutatePayload: (payload) => {
      behaviorOf(payload).auth = { kind: "saml", prerequisiteId: "example", required: true }
    },
  },
  {
    name: "remote auth object requires prerequisiteId",
    source: "mcp-remote-oauth-v1",
    mode: "package",
    error: "payload.behavior.auth.prerequisiteId: required non-empty string",
    mutatePayload: (payload) => {
      delete (behaviorOf(payload).auth as Record<string, unknown>).prerequisiteId
    },
  },
  {
    name: "remote auth object requires required",
    source: "mcp-remote-oauth-v1",
    mode: "package",
    error: "payload.behavior.auth.required: required boolean",
    mutatePayload: (payload) => {
      delete (behaviorOf(payload).auth as Record<string, unknown>).required
    },
  },
  {
    name: "remote auth object rejects an unknown key",
    source: "mcp-remote-oauth-v1",
    mode: "package",
    error: 'payload.behavior.auth: unknown key "scopes"',
    mutatePayload: (payload) => {
      ;(behaviorOf(payload).auth as Record<string, unknown>).scopes = ["mcp.read"]
    },
  },
  {
    name: "alpha-connection requires connectionHandlerId",
    source: "mcp-remote-connection-v1",
    mode: "package",
    error: "payload.behavior.auth.connectionHandlerId: required non-empty string",
    mutatePayload: (payload) => {
      delete (behaviorOf(payload).auth as Record<string, unknown>).connectionHandlerId
    },
  },
  {
    name: "connectionHandlerId grammar rejects uppercase",
    source: "mcp-remote-connection-v1",
    mode: "package",
    error: "payload.behavior.auth.connectionHandlerId: invalid format",
    mutatePayload: (payload) => {
      ;(behaviorOf(payload).auth as Record<string, unknown>).connectionHandlerId = "Alpha_Example"
    },
  },
  {
    name: "connectionHandlerId grammar rejects a leading digit",
    source: "mcp-remote-connection-v1",
    mode: "package",
    error: "payload.behavior.auth.connectionHandlerId: invalid format",
    mutatePayload: (payload) => {
      ;(behaviorOf(payload).auth as Record<string, unknown>).connectionHandlerId = "1alpha"
    },
  },
  {
    name: "connectionHandlerId grammar rejects an over-long id",
    source: "mcp-remote-connection-v1",
    mode: "package",
    error: "payload.behavior.auth.connectionHandlerId: exceeds 64 characters",
    mutatePayload: (payload) => {
      ;(behaviorOf(payload).auth as Record<string, unknown>).connectionHandlerId = `a${"b".repeat(64)}`
    },
  },
  {
    name: "mcp-oauth refuses a publisher Authorization header template",
    source: "mcp-remote-oauth-v1",
    mode: "package",
    error: "the engine owns token injection",
    mutatePayload: (payload) => {
      behaviorOf(payload).requiredSecrets = ["TENANT_ID"]
      behaviorOf(payload).headersTemplate = { Authorization: "Bearer {TENANT_ID}" }
    },
  },
  {
    name: "mcp-oauth refuses a lowercase authorization header template",
    source: "mcp-remote-oauth-v1",
    mode: "package",
    // HTTP 头名大小写不敏感 —— 只拒 "Authorization" 的实现会在这里绿,那正是绕过口。
    error: "the engine owns token injection",
    mutatePayload: (payload) => {
      behaviorOf(payload).requiredSecrets = ["TENANT_ID"]
      behaviorOf(payload).headersTemplate = { authorization: "Bearer {TENANT_ID}" }
    },
  },
  {
    name: "auth prerequisiteId may not collide with a requiredSecrets entry after folding",
    source: "mcp-remote-oauth-v1",
    mode: "package",
    error: "after case/separator folding",
    mutatePayload: (payload) => {
      ;(behaviorOf(payload).auth as Record<string, unknown>).prerequisiteId = "tenant-id"
    },
  },
  // 不变量 4 —— 每个 `{VAR}` 都必须在 requiredSecrets 里声明。三个 auth 档位各来一条:规则对
  // 三者一视同仁,只覆盖其中一个就等于让另外两个档位无声地失去这条闸。这条规则以前活在 main 的
  // 前置投影里(`#737` 那一类),现在归 decoder 独占,所以判据也必须在 decoder 这一侧。
  {
    name: "auth none refuses an undeclared headersTemplate placeholder",
    source: "mcp-remote-v1",
    mode: "package",
    error: 'references undeclared secret placeholder "TENANT_ID"',
    mutatePayload: (payload) => {
      behaviorOf(payload).headersTemplate = { "X-Tenant": "{TENANT_ID}" }
    },
  },
  {
    // 两处刻意:①头名是 Z-Region 而不是 Authorization,否则这条会被 oauth 的 Authorization 闸
    // 顺手挡掉,看起来绿其实测的是另一条规则;②违规的头排在**最后**(插入序与字节序都是),
    // 否则「只看第一个头」的实现照样全绿 —— 这一条正是自查绕过时抓到的空闸。
    name: "mcp-oauth refuses an undeclared placeholder in a non-first header",
    source: "mcp-remote-oauth-v1",
    mode: "package",
    error: 'references undeclared secret placeholder "REGION_ID"',
    mutatePayload: (payload) => {
      behaviorOf(payload).headersTemplate = { "A-Tenant": "{TENANT_ID}", "Z-Region": "{REGION_ID}" }
    },
  },
  {
    // 同一个头里的**第二个**占位符 —— 「每个头只看第一个 match」的实现会在这里露出来。
    name: "a second placeholder inside one header is checked too",
    source: "mcp-remote-oauth-v1",
    mode: "package",
    error: 'references undeclared secret placeholder "REGION_ID"',
    mutatePayload: (payload) => {
      behaviorOf(payload).headersTemplate = { "X-Tenant": "{TENANT_ID}/{REGION_ID}" }
    },
  },
  {
    name: "alpha-connection refuses an undeclared headersTemplate placeholder",
    source: "mcp-remote-connection-v1",
    mode: "package",
    error: 'references undeclared secret placeholder "TENANT_ID"',
    mutatePayload: (payload) => {
      behaviorOf(payload).headersTemplate = { "X-Tenant": "{TENANT_ID}" }
    },
  },
  {
    // 声明不出来的名字就永远是「未声明」:requiredSecrets 只收 ENV_NAME_RE,所以这条规则
    // 顺带把畸形占位符也关掉了,不需要第二条平行规则。
    name: "a malformed placeholder name can never be declared and is refused",
    source: "mcp-remote-oauth-v1",
    mode: "package",
    error: 'references undeclared secret placeholder "lowercase"',
    mutatePayload: (payload) => {
      behaviorOf(payload).headersTemplate = { "A-Tenant": "{TENANT_ID}", "Z-Region": "{lowercase}" }
    },
  },
  {
    name: "targetDir enum",
    source: "skill-v1",
    mode: "package",
    error: "payload.behavior.targetDir: expected one of [alpha-skills, global]",
    mutatePayload: (payload) => {
      behaviorOf(payload).targetDir = "skills"
    },
  },
  {
    name: "requiredSecrets sorted and unique",
    source: "mcp-local-v1",
    mode: "package",
    error: "payload.behavior.requiredSecrets: must be unique and byte-order sorted",
    mutatePayload: (payload) => {
      behaviorOf(payload).requiredSecrets = ["B_KEY", "A_KEY"]
    },
  },
]

describe("AlphaPackageEnvelopeV1 synthetic decoder corpus", () => {
  test("every accepted corpus package decodes, plans, and resolves secrets exactly once per component", async () => {
    expect(corpus.schema).toBe("alpha.host-extension-package.decoder-corpus.v1")
    const cases = corpus.cases.filter((item) => item.expect === "accepted")
    expect(cases.map((item) => item.name)).toEqual([
      "skill-v1",
      "skill-multifile-v1",
      "agent-v1",
      "command-v1",
      "bundle-skill-with-command",
      "mcp-local-v1",
      "mcp-remote-v1",
      "mcp-remote-oauth-v1",
      "mcp-remote-connection-v1",
      "bundle-optional-unsupported-profile",
      "bundle-optional-unsupported-capability",
      "bundle-optional-media-type-mismatch",
    ])
    for (const item of cases) {
      const calls = noCalls()
      const result = await runCase(item, calls)
      expect(result.ok, item.name).toBe(true)
      if (!result.ok) continue
      const installed = item.envelope.components as Array<{ id: string; capabilities: string[] }>
      const expectedComponents = installed.filter((component) => !item.skipped.includes(component.id))
      expect(result.components.map((entry) => entry.componentId).sort(), item.name).toEqual(
        expectedComponents.map((component) => component.id).sort(),
      )
      expect(calls.fetch, item.name).toBe(expectedComponents.length)
      expect(calls.decoder, item.name).toBe(expectedComponents.length)
      expect(calls.planner, item.name).toBe(expectedComponents.length)
      // CONTRACT.md 把 secret 前置作为固定顺序公开承诺,而它只应在组件真的派生出
      // alpha.secret-prerequisite.v1 时触发。少了这条断言,整个 secret 阶段可以被删掉而全绿。
      expect(calls.secret, item.name).toBe(
        expectedComponents.filter((component) =>
          component.capabilities.includes("alpha.secret-prerequisite.v1"),
        ).length,
      )
      expect(result.components[0]!.role, item.name).toBe("root")
    }
  })

  test("every blocked corpus package stops before every downstream call", async () => {
    const cases = corpus.cases.filter((item) => item.expect === "blocked")
    expect(cases.map((item) => item.name)).toEqual([
      "unknown-profile-required",
      "unknown-capability-required",
      "missing-profile-required",
      "non-required-root",
      "bundle-required-unsupported-child",
    ])
    for (const item of cases) {
      const calls = noCalls()
      const result = await runCase(item, calls)
      expect(result.ok, item.name).toBe(false)
      expect(result.status, item.name).toBe("blocked")
      expect(calls, item.name).toEqual(noCalls())
    }

    const missingCapability = caseNamed("skill-v1")
    delete componentsOf(missingCapability.envelope)[0]!.capabilities
    delete missingCapability.envelope.capabilities
    const calls = noCalls()
    expect((await runCase(missingCapability, calls)).ok).toBe(false)
    expect(calls).toEqual(noCalls())
  })

  // §4.3 的三条语义闸,一个 canonical Bundle 一次说清:
  // ①签名并集仍含被跳过子件的 capability;②该子件零 fetch / 零 decode / 零 secret / 零 plan;
  // ③给出的 skip 原因是 decoder 自己的那个 token,不是第二套措辞。
  test("a curated but unsupported optional child is skipped without reaching any effect", async () => {
    const item = caseNamed("bundle-optional-unsupported-profile")
    const skippedId = item.skipped[0]!
    expect(item.envelope.capabilities).toContain("alpha.future.v1")
    const skippedComponent = componentsOf(item.envelope).find(
      (component) => component.id === skippedId,
    )!
    expect(skippedComponent.capabilities).toEqual(["alpha.future.v1"])

    const fetched: string[] = []
    const calls = noCalls()
    const result = await runSyntheticPackageDecoderV1(jsonBytes(item.envelope), {
      fetchPayload: async (_envelope, component) => {
        fetched.push(component.id)
        calls.fetch++
        const found = item.components.find((entry) => entry.id === component.id)
        return found?.payload ? jsonBytes(found.payload) : new Uint8Array()
      },
      decodePayload: (profileId, bytes, capabilities) => {
        calls.decoder++
        return decodePackageProfilePayloadV1(profileId, bytes, capabilities)
      },
      resolveSecrets: async () => {
        calls.secret++
      },
      plan: async (_payload, component) => {
        calls.planner++
        return component.id
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(fetched).not.toContain(skippedId)
    expect(result.components.map((entry) => entry.componentId)).not.toContain(skippedId)
    expect(result.components.map((entry) => entry.plan)).not.toContain(skippedId)
    expect(result.skipped).toEqual([
      { componentId: skippedId, reasonCode: "component-profile-unsupported" },
    ])
    // 并集是发布方的签名事实,与宿主支持与否无关:被跳过的子件仍然留在里面。
    expect(result.envelope.capabilities).toContain("alpha.future.v1")
    expect(result.envelope.components.map((component) => component.id)).toContain(skippedId)
  })

  test.each([
    ["bundle-optional-unsupported-profile", "component-profile-unsupported"],
    ["bundle-optional-unsupported-capability", "component-capability-unsupported"],
    ["bundle-optional-media-type-mismatch", "component-media-type-mismatch"],
  ])("%s reports the %s skip reason", async (name, reasonCode) => {
    const item = caseNamed(name)
    const result = await runCase(item, noCalls())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.skipped).toEqual([{ componentId: item.skipped[0]!, reasonCode: reasonCode as never }])
  })

  test("the published skip-reason vocabulary is exactly the set the decoder can produce", async () => {
    const produced = new Set<string>()
    for (const item of corpus.cases) {
      const result = await runCase(structuredClone(item), noCalls())
      if (result.ok) result.skipped.forEach((entry) => produced.add(entry.reasonCode))
    }
    expect([...produced].sort()).toEqual([...PACKAGE_COMPONENT_SKIP_REASONS_V1].sort())
  })

  test("a required unsupported child blocks the whole package instead of being skipped", async () => {
    const item = caseNamed("bundle-required-unsupported-child")
    const calls = noCalls()
    const result = await runCase(item, calls)
    expect(result).toMatchObject({ ok: false, status: "blocked", stage: "support" })
    expect(calls).toEqual(noCalls())
    // 同一个信封,只把子件改成 optional,就应当被接受并跳过它 —— 证明分界确实是 `required`。
    const optional = caseNamed("bundle-required-unsupported-child")
    const leaf = componentsOf(optional.envelope).find(
      (component) => component.id !== optional.envelope.root,
    )!
    leaf.required = false
    const rootPayload = caseNamed("skill-v1").components[0]!.payload!
    optional.components = optional.components.map((entry) =>
      entry.id === optional.envelope.root ? { ...entry, payload: rootPayload } : entry,
    )
    bindPayload(optional, optional.envelope.root as string, jsonBytes(rootPayload))
    expect((await runCase(optional, noCalls())).ok).toBe(true)
  })

  test("a maximum-width package still decodes; one component more does not", async () => {
    const atLimit = widenSkillCase(HOST_EXTENSION_PACKAGE_LIMITS_V1.maxComponents - 1)
    const atLimitResult = decodePackageEnvelopeHeaderV1(jsonBytes(atLimit.envelope))
    expect(errorsOf(atLimitResult)).toBe("")
    expect(atLimitResult.ok).toBe(true)
    expect(
      errorsOf(
        decodePackageEnvelopeHeaderV1(
          jsonBytes(widenSkillCase(HOST_EXTENSION_PACKAGE_LIMITS_V1.maxComponents).envelope),
        ),
      ),
    ).toContain(`requires 1..${HOST_EXTENSION_PACKAGE_LIMITS_V1.maxComponents} components`)
  })

  /** `#827` AC:证明 +1 撞的是 `maxComponents` 而非别的界先咬(`#828` 在 `maxComponentAssetFiles` 上
   *  踩过:上界闸从没被执行到时 `.toContain` 照样全绿)。判据两条 —— **恰好一条错误**(节点/字节界在
   *  长度检查之前、依赖条数界在其后,任一参与则错误串不止一条)+ **同一份字节在界+1 时转为接受**
   *  (还有第二道界在咬就不会转绿)。实测数字见 registry.ts 的 `maxComponents`。 */
  test("the +1 rejection comes from maxComponents itself, not from another bound biting first", () => {
    const limit = HOST_EXTENSION_PACKAGE_LIMITS_V1.maxComponents
    const overflowBytes = jsonBytes(widenSkillCase(limit).envelope)

    const rejected = decodePackageEnvelopeHeaderV1(overflowBytes)
    expect(rejected.ok).toBe(false)
    expect(errorsOf(rejected)).toBe(`envelope.components: requires 1..${limit} components`)

    withMaxComponents(limit + 1, () => {
      const admitted = decodePackageEnvelopeHeaderV1(overflowBytes)
      expect(errorsOf(admitted)).toBe("")
      expect(admitted.ok).toBe(true)
    })
  })

  /** `#827` AC:边界跟着 registry 走,不是写死 32。「期望值从 registry 读」**不够** —— registry 钉的值
   *  恰好等于生产里的字面量时,把生产写成字面量仍然全绿;只有把 registry 挪到一个**不相等**的哨兵值
   *  再看边界跟不跟着动,才分得开「读了 registry」与「写死了一个恰好相等的数」。 */
  test("the component bound follows the registry instead of a literal baked into the decoder", () => {
    const SENTINEL = 5
    expect(SENTINEL).not.toBe(HOST_EXTENSION_PACKAGE_LIMITS_V1.maxComponents)

    withMaxComponents(SENTINEL, () => {
      const atSentinel = decodePackageEnvelopeHeaderV1(jsonBytes(widenSkillCase(SENTINEL - 1).envelope))
      expect(errorsOf(atSentinel)).toBe("")
      expect(atSentinel.ok).toBe(true)

      const overSentinel = decodePackageEnvelopeHeaderV1(jsonBytes(widenSkillCase(SENTINEL).envelope))
      expect(overSentinel.ok).toBe(false)
      expect(errorsOf(overSentinel)).toBe(`envelope.components: requires 1..${SENTINEL} components`)
    })

    // 哨兵撤回后真界回来 —— 否则「跟着走」只被证明了一半(挪下去了,没挪回来)。
    const restored = decodePackageEnvelopeHeaderV1(
      jsonBytes(widenSkillCase(HOST_EXTENSION_PACKAGE_LIMITS_V1.maxComponents - 1).envelope),
    )
    expect(restored.ok).toBe(true)
  })

  test.each(graphCases)("graph refuses: $name", (graphCase) => {
    const item = caseNamed(graphCase.source)
    expect(decodePackageEnvelopeHeaderV1(jsonBytes(item.envelope)).ok, `${graphCase.source} must start legal`).toBe(
      true,
    )
    graphCase.mutate(item.envelope)
    const result = decodePackageEnvelopeHeaderV1(jsonBytes(item.envelope))
    expect(result.ok, graphCase.name).toBe(false)
    expect(errorsOf(result)).toContain(graphCase.error)
  })

  test("support failure returns the strictly decoded presentation", () => {
    const item = caseNamed("skill-v1")
    item.envelope.presentation = {
      displayName: "Next Profile Tooling",
      description: "A bounded presentation retained after the support gate rejects the profile.",
    }
    rootOf(item.envelope).profileVersion = 2

    expect(decodePackageEnvelopeHeaderV1(jsonBytes(item.envelope))).toMatchObject({
      ok: false,
      status: "blocked",
      stage: "support",
      presentation: item.envelope.presentation,
    })
  })

  test("header failure does not return presentation", () => {
    const item = caseNamed("skill-v1")
    item.envelope.presentation = {
      displayName: "Valid Presentation",
      description: "This remains valid while a different header field fails strict decoding.",
    }
    ;(item.envelope.prelude as Record<string, unknown>).version = "-1"
    const result = decodePackageEnvelopeHeaderV1(jsonBytes(item.envelope))

    expect(result).toMatchObject({ ok: false, status: "blocked", stage: "header" })
    expect("presentation" in result).toBe(false)
  })

  test("known payload with an unknown behavior key is strictly rejected before prerequisites/planner", async () => {
    const item = caseNamed("mcp-remote-v1")
    ;(item.components[0]!.payload!.behavior as Record<string, unknown>).executeScript = true
    bindPayload(item, item.components[0]!.id)
    const calls = noCalls()
    const result = await runCase(item, calls)
    expect(result).toMatchObject({ ok: false, status: "blocked", stage: "payload" })
    expect(result.ok ? [] : result.errors.join("\n")).toContain(
      'payload.behavior: unknown key "executeScript"',
    )
    expect(calls).toEqual({ fetch: 1, decoder: 1, secret: 0, planner: 0 })
  })

  test("header rejects depth, count, bytes, control characters, and prototype-pollution keys", () => {
    const valid = caseNamed("skill-v1").envelope

    const deep = structuredClone(valid)
    deep.extra = { a: { b: { c: { d: { e: { f: true } } } } } }
    expect(errorsOf(decodePackageEnvelopeHeaderV1(jsonBytes(deep)))).toContain("depth")

    const crowded = structuredClone(valid)
    crowded.extra = Array.from(
      { length: HOST_EXTENSION_PACKAGE_LIMITS_V1.maxHeaderNodes + 1 },
      (_, index) => index,
    )
    expect(errorsOf(decodePackageEnvelopeHeaderV1(jsonBytes(crowded)))).toContain("node limit")

    expect(
      errorsOf(
        decodePackageEnvelopeHeaderV1(
          new Uint8Array(HOST_EXTENSION_PACKAGE_LIMITS_V1.maxEnvelopeBytes + 1),
        ),
      ),
    ).toContain("bytes exceeds")

    const control = structuredClone(valid)
    ;(control.presentation as Record<string, unknown>).description = "bad\u0000value"
    expect(errorsOf(decodePackageEnvelopeHeaderV1(jsonBytes(control)))).toContain(
      "control characters",
    )

    const text = JSON.stringify(valid).replace("{", '{"__proto__":{"polluted":true},')
    expect(errorsOf(decodePackageEnvelopeHeaderV1(encoder.encode(text)))).toContain(
      "prototype-pollution",
    )
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  // 每个 profile 与每个 auth 档位都必须有负向语料。#700 之前 `agent` 的负向覆盖是 **0 条**,
  // 而没有任何东西会因此变红 —— 一个 profile 悄悄失去全部负向覆盖是可能的。
  test("every profile and every remote auth mode carries at least one negative case", () => {
    const bySource = new Map<string, number>()
    for (const negative of [...negativeCases, ...graphCases])
      bySource.set(negative.source, (bySource.get(negative.source) ?? 0) + 1)
    const uncovered = (
      [
        "skill-v1",
        "agent-v1",
        "mcp-local-v1",
        "mcp-remote-v1",
        "mcp-remote-oauth-v1",
        "mcp-remote-connection-v1",
        "bundle-optional-unsupported-profile",
        "bundle-optional-unsupported-capability",
      ] as const
    ).filter((source) => (bySource.get(source) ?? 0) === 0)
    expect(uncovered, "a profile or auth mode lost all negative coverage").toEqual([])
  })

  test.each(negativeCases)("$name", async (negative) => {
    const item = caseNamed(negative.source)
    const componentId = item.envelope.root as string
    negative.mutateEnvelope?.(item.envelope)
    const entry = item.components.find((candidate) => candidate.id === componentId)!
    if (negative.mutatePayload) negative.mutatePayload(entry.payload!)
    const payloadBytes = negative.payloadBytes?.(entry.payload!) ?? jsonBytes(entry.payload)
    const calls = noCalls()
    if (negative.mode === "payload") {
      const source = caseNamed(negative.source)
      const header = decodePackageEnvelopeHeaderV1(jsonBytes(source.envelope))
      if (!header.ok) throw new Error(`invalid source ${negative.source}: ${header.errors.join("\n")}`)
      const root = header.components.find((candidate) => candidate.role === "root")!
      if (root.status !== "supported") throw new Error(`invalid source ${negative.source}`)
      const result = decodePackageProfilePayloadV1(
        root.component.profileId,
        payloadBytes,
        root.component.capabilities,
      )
      expect(result.ok ? "" : result.errors.join("\n")).toContain(negative.error)
      expect(calls).toEqual(noCalls())
      return
    }
    if (negative.mode === "package") bindPayload(item, componentId, payloadBytes)
    const result = await runCase(item, calls, () => payloadBytes)
    expect(result.ok ? "" : result.errors.join("\n")).toContain(negative.error)
    if (negative.mode === "header") {
      expect(calls).toEqual(noCalls())
      return
    }
    expect(calls).toEqual({ fetch: 1, decoder: 1, secret: 0, planner: 0 })
  })

  // ── `#828` skill 载荷形状:每一条都问过「一个错误实现能不能满足它?」 ──────────────────
  describe("skill payload file list", () => {
    /** 直接跑**生产解码器**;返回它的错误串(或空串)。不自建等价链。 */
    const decodeSkill = (files: unknown): string => {
      const payload = { schema: "alpha.host-extension-package.payload.skill.v1", behavior: { targetDir: "alpha-skills", files } }
      const result = decodePackageProfilePayloadV1("skill", jsonBytes(payload), [])
      return result.ok ? "" : result.errors.join("\n")
    }
    const fileAt = (path: string, bytes = 12) => ({
      path,
      sha256: "1".repeat(64),
      bytes,
      url: `https://example.invalid/assets/${encodeURI(path)}`,
    })
    /** N 条合法条目,第一条恒为 SKILL.md(锚点),其余路径两两不同。 */
    const nFiles = (n: number) => [
      fileAt("SKILL.md"),
      ...Array.from({ length: n - 1 }, (_, index) => fileAt(`reference/f${String(index).padStart(3, "0")}.md`)),
    ]

    test("多文件技能装得上,单文件技能仍然装得上", () => {
      expect(decodeSkill([fileAt("SKILL.md")])).toBe("")
      expect(decodeSkill([fileAt("SKILL.md"), fileAt("reference/guide.md"), fileAt("scripts/run.py")])).toBe("")
      // 实测语料上界 18 —— 这个形状必须过,否则这一票没解决它要解决的问题。
      expect(decodeSkill(nFiles(18))).toBe("")
    })

    test("0 字节条目必须被接受 —— 语料里 skill-creator 带一个空的 scripts/__init__.py", () => {
      // 这条闸的方向与其它几条相反:它挡的不是坏输入,是**我们自己把真实配置拒掉**。
      // `>= 1` 是从单资产 `decodePayloadRef` 抄过来时最容易顺手带上的一个字符,而它会让
      // 官方语料里的 skill-creator 整包 blocked(Python 包必需的空 `__init__.py`)。
      expect(decodeSkill([fileAt("SKILL.md"), { ...fileAt("scripts/__init__.py"), bytes: 0 }])).toBe("")
      // 空的**入口文件**同样合法:形状层不替 frontmatter 校验做判断,那是 probe 的事
      //(空 SKILL.md 会在 pre-switch probe 上以「非法 frontmatter」被拒,而不是被静默装上)。
      expect(decodeSkill([{ ...fileAt("SKILL.md"), bytes: 0 }])).toBe("")
      // 下界只放开到 0:负数与非整数仍拒。
      expect(decodeSkill([{ ...fileAt("SKILL.md"), bytes: -1 }])).toContain("bytes: required integer in 0..")
      expect(decodeSkill([{ ...fileAt("SKILL.md"), bytes: 1.5 }])).toContain("bytes: required integer in 0..")
      // agent 那一侧**没有**跟着放开:它仍是单份 markdown,空 = 畸形。
      const agentPayload = {
        schema: "alpha.host-extension-package.payload.agent.v1",
        behavior: {
          targetDir: "alpha-agents",
          asset: { sha256: "1".repeat(64), bytes: 0, mediaType: "text/markdown", url: "https://example.invalid/a.md" },
        },
      }
      expect(decodePackageProfilePayloadV1("agent", jsonBytes(agentPayload), []).ok).toBe(false)
    })

    test("条数界:64 过 / 65 拒,且 64 时先咬的不是节点界", () => {
      // 这条用例存在的全部理由:若 maxPayloadNodes 在 64 之前就咬,那条条数界**从来没有被
      // 执行过** —— 上界闸变成一句从不生效的散文(REQ-128 Phase 3 已实证过这个形态)。
      expect(decodeSkill(nFiles(64))).toBe("")
      const over = decodeSkill(nFiles(65))
      expect(over).toContain("65 files exceeds the host limit of 64")
      // 65 被拒的**原因**必须是条数,不是顺带撞上的节点/字节界。
      expect(over).not.toContain("node limit")
      expect(over).not.toContain("component budget")
    })

    test("恰好一条 SKILL.md:零条拒、两条拒", () => {
      expect(decodeSkill([fileAt("reference/guide.md")])).toContain('exactly one file must be "SKILL.md" (found 0)')
      // 两条同名会先撞重复路径闸,所以用大小写不同的第二条?不行 —— 那是**路径文法**,
      // 归 promotePayloadToCas。这里构造的是「零条」这一支,以及下面的重复路径。
      expect(decodeSkill([fileAt("skill.md"), fileAt("SKILL.MD")])).toContain('exactly one file must be "SKILL.md" (found 0)')
    })

    test("重复路径被拒 —— 否则盘上是哪份字节取决于写入顺序", () => {
      expect(decodeSkill([fileAt("SKILL.md"), fileAt("reference/guide.md"), fileAt("reference/guide.md")])).toContain(
        'duplicate path "reference/guide.md"',
      )
    })

    test("总预算:sum(bytes) 超 maxMarkdownAssetBytes 即拒(单文件语义不变)", () => {
      const budget = HOST_EXTENSION_PACKAGE_LIMITS_V1.maxMarkdownAssetBytes
      // 单文件恰好用满预算 —— `#828` 之前能过,之后也必须能过。
      expect(decodeSkill([fileAt("SKILL.md", budget)])).toBe("")
      // 两条各占一半 + 1 字节 ⇒ 逐条都合法,合起来越界。只断言逐条上界的实现满足不了这条。
      const half = Math.floor(budget / 2)
      expect(decodeSkill([fileAt("SKILL.md", half + 1), fileAt("reference/guide.md", half + 1)])).toContain(
        `exceed the component budget ${budget}`,
      )
    })

    test("条目形状:未知键、缺键、非 https 一律拒", () => {
      expect(decodeSkill([{ ...fileAt("SKILL.md"), mediaType: "text/markdown" }])).toContain('unknown key "mediaType"')
      const { sha256: _dropped, ...missing } = fileAt("SKILL.md")
      expect(decodeSkill([missing])).toContain("sha256")
      expect(decodeSkill([{ ...fileAt("SKILL.md"), url: "http://example.invalid/SKILL.md" }])).toContain("url")
      expect(decodeSkill([])).toContain("required at least 1 file")
      expect(decodeSkill({ "0": fileAt("SKILL.md") })).toContain("required array")
    })

    test("agent 的单资产形状一字未变(本票不碰它)", () => {
      const agent = caseNamed("agent-v1")
      const entry = agent.components.find((candidate) => candidate.id === agent.envelope.root)!
      const behavior = behaviorOf(entry.payload!)
      expect(Object.keys(behavior).sort()).toEqual(["asset", "targetDir"])
      expect((behavior.asset as Record<string, unknown>).mediaType).toBe("text/markdown")
      expect(decodePackageProfilePayloadV1("agent", jsonBytes(entry.payload), []).ok).toBe(true)
      // agent 载荷里出现 skill 的 files ⇒ 拒(两条路真的分家了,不是共用一个宽解码器)。
      const drifted = { ...(entry.payload as Record<string, unknown>), behavior: { targetDir: "alpha-agents", files: [fileAt("SKILL.md")] } }
      expect(decodePackageProfilePayloadV1("agent", jsonBytes(drifted), []).ok).toBe(false)
      // 反向同理:skill 载荷里出现 agent 的 asset ⇒ 拒。
      const skillWithAsset = {
        schema: "alpha.host-extension-package.payload.skill.v1",
        behavior: { targetDir: "alpha-skills", asset: { sha256: "1".repeat(64), bytes: 12, mediaType: "text/markdown", url: "https://example.invalid/a.md" } },
      }
      expect(decodePackageProfilePayloadV1("skill", jsonBytes(skillWithAsset), []).ok).toBe(false)
    })

    test("`#840` command 载荷:五键窄面、template 是 asset ref、variant 具名拒(R3-1)", () => {
      const command = caseNamed("command-v1")
      const entry = command.components.find((candidate) => candidate.id === command.envelope.root)!
      const behavior = behaviorOf(entry.payload!)
      expect(Object.keys(behavior).sort()).toEqual(["agent", "description", "model", "subtask", "template"])
      expect((behavior.template as Record<string, unknown>).mediaType).toBe("text/markdown")
      expect(decodePackageProfilePayloadV1("command", jsonBytes(entry.payload), []).ok).toBe(true)

      const payload = entry.payload as Record<string, unknown>
      const withVariant = { ...payload, behavior: { ...(payload.behavior as Record<string, unknown>), variant: "compact" } }
      const variantResult = decodePackageProfilePayloadV1("command", jsonBytes(withVariant), [])
      expect(variantResult.ok).toBe(false)
      if (!variantResult.ok) expect(variantResult.errors.join("\n")).toContain('unknown key "variant"')

      const { template: _dropped, ...withoutTemplate } = payload.behavior as Record<string, unknown>
      expect(decodePackageProfilePayloadV1("command", jsonBytes({ ...payload, behavior: withoutTemplate }), []).ok).toBe(false)

      const badSubtask = { ...payload, behavior: { ...(payload.behavior as Record<string, unknown>), subtask: "yes" } }
      const subtaskResult = decodePackageProfilePayloadV1("command", jsonBytes(badSubtask), [])
      expect(subtaskResult.ok).toBe(false)
      if (!subtaskResult.ok) expect(subtaskResult.errors.join("\n")).toContain("subtask")

      // inline template(字符串而非 asset ref)⇒ 拒:27/100 真实命令超过 4096B string 界,
      // inline 形状既装不下真实语料、也不该以第二种拼法混进来。
      const inlineTemplate = { ...payload, behavior: { ...(payload.behavior as Record<string, unknown>), template: "inline $ARGUMENTS" } }
      expect(decodePackageProfilePayloadV1("command", jsonBytes(inlineTemplate), []).ok).toBe(false)
    })
  })

  test("unknown envelope version, inline payload, and bad package union fail closed", () => {
    const unknownEnvelope = caseNamed("skill-v1").envelope
    unknownEnvelope.schema = "alpha.host-extension-package.v2"
    expect(errorsOf(decodePackageEnvelopeHeaderV1(jsonBytes(unknownEnvelope)))).toContain(
      "unsupported version",
    )

    const unknownProfileVersion = caseNamed("skill-v1").envelope
    rootOf(unknownProfileVersion).profileVersion = 2
    expect(decodePackageEnvelopeHeaderV1(jsonBytes(unknownProfileVersion))).toMatchObject({
      ok: false,
      stage: "support",
      status: "blocked",
    })

    const inline = caseNamed("skill-v1").envelope
    rootOf(inline).payloadRef = { inline: { behavior: {} } }
    expect(errorsOf(decodePackageEnvelopeHeaderV1(jsonBytes(inline)))).toContain('unknown key "inline"')

    const union = caseNamed("skill-v1").envelope
    union.capabilities = ["alpha.future.v1"]
    expect(errorsOf(decodePackageEnvelopeHeaderV1(jsonBytes(union)))).toContain("sorted union")
  })

  test("oauth and connection payloads derive exactly one capability each", () => {
    const oauth = caseNamed("mcp-remote-oauth-v1").components[0]!.payload as unknown as PackageProfilePayloadV1
    const connection = caseNamed("mcp-remote-connection-v1").components[0]!
      .payload as unknown as PackageProfilePayloadV1
    const none = caseNamed("mcp-remote-v1").components[0]!.payload as unknown as PackageProfilePayloadV1
    // rev3 不变量 5:auth 不豁免 requiredSecrets。语料里的 OAuth 组件刻意同时带着一条
    // secret,所以它必须派生**两个** token —— 写成二选一的实现会在这里红。
    expect(derivePayloadCapabilitiesV1(oauth)).toEqual([
      "alpha.mcp-oauth.v1",
      "alpha.secret-prerequisite.v1",
    ])
    expect(derivePayloadCapabilitiesV1(connection)).toEqual(["alpha.connection.v1"])
    expect(derivePayloadCapabilitiesV1(none)).toEqual([])

    // 去掉那条 secret 之后只剩授权 token,证明上面那条并集不是把 secret 恒加进去的假象。
    const oauthOnly = structuredClone(oauth) as { behavior: Record<string, unknown> }
    oauthOnly.behavior.requiredSecrets = []
    oauthOnly.behavior.headersTemplate = {}
    expect(derivePayloadCapabilitiesV1(oauthOnly as unknown as PackageProfilePayloadV1)).toEqual([
      "alpha.mcp-oauth.v1",
    ])

    // Connection 侧同理:加一条 secret 就该并出两个。
    const connectionBoth = structuredClone(connection) as { behavior: Record<string, unknown> }
    connectionBoth.behavior.requiredSecrets = ["A_KEY"]
    expect(
      derivePayloadCapabilitiesV1(connectionBoth as unknown as PackageProfilePayloadV1),
    ).toEqual(["alpha.connection.v1", "alpha.secret-prerequisite.v1"])
  })

})

function bindPayload(item: CorpusCase, componentId: string, bytes?: Uint8Array): void {
  const entry = item.components.find((candidate) => candidate.id === componentId)!
  const payloadBytes = bytes ?? jsonBytes(entry.payload)
  const payloadRef = componentsOf(item.envelope).find((component) => component.id === componentId)!
    .payloadRef as Record<string, unknown>
  payloadRef.bytes = payloadBytes.byteLength
  payloadRef.sha256 = createHash("sha256").update(payloadBytes).digest("hex")
}

function payloadRefOf(envelope: Record<string, unknown>): Record<string, unknown> {
  return rootOf(envelope).payloadRef as Record<string, unknown>
}

function behaviorOf(payload: Record<string, unknown>): Record<string, unknown> {
  return payload.behavior as Record<string, unknown>
}

/** `#828`:skill 载荷的文件清单(agent 仍是单个 `behavior.asset`,两者刻意不共用取法)。 */
function skillFilesOf(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  return behaviorOf(payload).files as Array<Record<string, unknown>>
}

function errorsOf(result: ReturnType<typeof decodePackageEnvelopeHeaderV1>): string {
  return result.ok ? "" : result.errors.join("\n")
}
