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
    kind: Schema.Literal("alpha-cloud"),
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

export const ToolDisplaySnapshotV1 = Schema.Struct({
  identity: ToolIdentity,
  technicalId: Schema.String.check(Schema.isPattern(/[\s\S]+/)),
  authority: ToolAuthority,
  billing: Schema.optional(ToolBillingFact),
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
