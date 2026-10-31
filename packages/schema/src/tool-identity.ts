// north-star:alpha-owned — alpha 自有文件,住在上游包目录里。ADR-041 ToolIdentity/ToolAliasLedger 本体。
// 这一行是 north-star 守卫的结构性谓词因子②(ADR-043);缺了它,对本文件的每一次修改都会被
// 当成上游改动而红。命名成 alpha-* 的文件不需要它。
import { Schema, Types } from "effect"

export const ToolIdentitySource = Schema.Literals(["builtin", "builtin-v2", "plugin", "mcp", "host"])
export type ToolIdentitySource = Schema.Schema.Type<typeof ToolIdentitySource>

export const ToolIdentity = Schema.Struct({
  source: ToolIdentitySource,
  origin: Schema.String,
  name: Schema.String.check(Schema.isPattern(/[\s\S]+/)),
}).annotate({ identifier: "ToolIdentity" })
export type ToolIdentity = Types.DeepMutable<Schema.Schema.Type<typeof ToolIdentity>>

export const ToolAuthority = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("not-asserted") }),
  Schema.Struct({
    kind: Schema.Literal("codepuppy-cloud"),
    bindingId: Schema.String.check(Schema.isPattern(/[\s\S]+/)),
    evidenceDigest: Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/)),
  }),
  // #1578(owner「路一」,REQ-236 §2.6-7):随应用交付、经随包清单核验成立的工具(文档工具 MCP、第一方扩展插件的自有工具)。
  // 回退只撤铸造与显示,这一字面量保留 —— 已持久化的快照照常可读。
  Schema.Struct({
    kind: Schema.Literal("codepuppy-bundled"),
    bindingId: Schema.String.check(Schema.isPattern(/[\s\S]+/)),
    evidenceDigest: Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/)),
  }),
]).annotate({ discriminator: "kind", identifier: "ToolAuthority" })
export type ToolAuthority = Types.DeepMutable<Schema.Schema.Type<typeof ToolAuthority>>

export const ToolBillingFact = Schema.Struct({
  class: Schema.String.check(Schema.isPattern(/[\s\S]+/)),
  evidenceId: Schema.String.check(Schema.isPattern(/[\s\S]+/)),
}).annotate({ identifier: "ToolBillingFact" })
export type ToolBillingFact = Types.DeepMutable<Schema.Schema.Type<typeof ToolBillingFact>>

// #1576:工具在哪里执行,注册时由宿主写(内置 / host / 插件 = local;MCP 由生效条目的去秘密传输事实派生,
// 远端取 URL 主机名)。可选:历史行与事实缺席时不写,显示层说「位置未知」;不回填。
export const ToolLocation = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("local") }),
  Schema.Struct({ kind: Schema.Literal("remote"), host: Schema.String.check(Schema.isPattern(/[\s\S]+/)) }),
]).annotate({ discriminator: "kind", identifier: "ToolLocation" })
export type ToolLocation = Types.DeepMutable<Schema.Schema.Type<typeof ToolLocation>>

export const ToolDisplaySnapshotV1 = Schema.Struct({
  identity: ToolIdentity,
  technicalId: Schema.String.check(Schema.isPattern(/[\s\S]+/)),
  authority: ToolAuthority,
  billing: Schema.optional(ToolBillingFact),
  location: Schema.optional(ToolLocation),
}).annotate({ identifier: "ToolDisplaySnapshotV1" })
export type ToolDisplaySnapshotV1 = Types.DeepMutable<Schema.Schema.Type<typeof ToolDisplaySnapshotV1>>

const decodeToolDisplaySnapshot = Schema.decodeUnknownSync(ToolDisplaySnapshotV1)

export function parseToolDisplaySnapshot(value: unknown): ToolDisplaySnapshotV1 {
  return decodeToolDisplaySnapshot(value)
}

const SOURCES = new Set<ToolIdentitySource>(["builtin", "builtin-v2", "plugin", "mcp", "host"])
const ESCAPE = new Map([
  ["%", "%25"],
  [":", "%3A"],
  ["*", "%2A"],
  ["?", "%3F"],
  ["\\", "%5C"],
  ["/", "%2F"],
])
const UNESCAPE = new Map(Array.from(ESCAPE, ([plain, encoded]) => [encoded, plain]))

export class InvalidToolIdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidToolIdentityError"
  }
}

function encodeSegment(value: string) {
  let encoded = ""
  for (const char of value) encoded += ESCAPE.get(char) ?? char
  return encoded
}

function decodeSegment(value: string) {
  let decoded = ""
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!
    if (char !== "%") {
      decoded += char
      continue
    }
    const escape = value.slice(index, index + 3)
    const plain = UNESCAPE.get(escape)
    if (plain === undefined) throw new InvalidToolIdentityError(`invalid canonical escape ${JSON.stringify(escape)}`)
    decoded += plain
    index += 2
  }
  return decoded
}

export function canonicalToolIdentity(identity: ToolIdentity) {
  if (!SOURCES.has(identity.source))
    throw new InvalidToolIdentityError(`invalid tool identity source: ${identity.source}`)
  if (identity.name.length === 0) throw new InvalidToolIdentityError("tool identity name must not be empty")
  return `${identity.source}:${encodeSegment(identity.origin)}:${encodeSegment(identity.name)}`
}

export function parseToolIdentity(value: string): ToolIdentity {
  const parts = value.split(":")
  if (parts.length !== 3)
    throw new InvalidToolIdentityError("canonical tool identity must contain exactly three segments")
  const [source, origin, name] = parts
  if (!SOURCES.has(source as ToolIdentitySource))
    throw new InvalidToolIdentityError(`invalid tool identity source: ${source}`)
  const identity = {
    source: source as ToolIdentitySource,
    origin: decodeSegment(origin!),
    name: decodeSegment(name!),
  }
  if (identity.name.length === 0) throw new InvalidToolIdentityError("tool identity name must not be empty")
  if (canonicalToolIdentity(identity) !== value)
    throw new InvalidToolIdentityError("canonical tool identity is not in normalized form")
  return identity
}

export class ToolAliasCollisionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ToolAliasCollisionError"
  }
}

export class ToolAliasLedger {
  readonly byAlias = new Map<string, ToolIdentity>()
  readonly byIdentity = new Map<string, string>()
  readonly byFoldedIdentity = new Map<string, string>()

  add(alias: string, identity: ToolIdentity) {
    if (alias.length === 0) throw new ToolAliasCollisionError("tool alias must not be empty")
    const key = canonicalToolIdentity(identity)
    const existingIdentity = this.byAlias.get(alias)
    if (existingIdentity && canonicalToolIdentity(existingIdentity) !== key)
      throw new ToolAliasCollisionError(
        `tool alias ${JSON.stringify(alias)} maps to both ${canonicalToolIdentity(existingIdentity)} and ${key}`,
      )
    const existingAlias = this.byIdentity.get(key)
    if (existingAlias && existingAlias !== alias)
      throw new ToolAliasCollisionError(
        `tool identity ${key} maps to both ${JSON.stringify(existingAlias)} and ${JSON.stringify(alias)}`,
      )
    const folded = key.toLowerCase()
    const casePeer = this.byFoldedIdentity.get(folded)
    if (casePeer && casePeer !== key)
      throw new ToolAliasCollisionError(`tool identities differ only by case: ${casePeer} and ${key}`)
    const stored = structuredClone(identity)
    this.byAlias.set(alias, stored)
    this.byIdentity.set(key, alias)
    this.byFoldedIdentity.set(folded, key)
    return stored
  }
}

export function notAssertedToolSnapshot(identity: ToolIdentity, technicalId: string): ToolDisplaySnapshotV1 {
  return parseToolDisplaySnapshot({ identity, technicalId, authority: { kind: "not-asserted" } })
}
