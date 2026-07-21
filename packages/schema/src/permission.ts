export * as Permission from "./permission"

import { Schema } from "effect"
import { AgentID } from "./agent-id"
import { NonNegativeInt, optional } from "./schema"
import { define, inventory } from "./event"
import { ascending } from "./identifier"
import { ProjectID } from "./project-id"
import { SessionID } from "./session-id"
import { statics } from "./schema"

export const ID = Schema.String.check(Schema.isStartsWith("per")).pipe(
  Schema.brand("PermissionV2.ID"),
  statics((schema) => ({ create: (id?: string) => schema.make(id ?? "per_" + ascending()) })),
)
export type ID = typeof ID.Type

export const DecisionID = Schema.String.check(Schema.isStartsWith("pdec")).pipe(
  Schema.brand("PermissionV2.DecisionID"),
  statics((schema) => ({ create: (id?: string) => schema.make(id ?? "pdec_" + ascending()) })),
)
export type DecisionID = typeof DecisionID.Type

export const Fingerprint = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).pipe(
  Schema.brand("PermissionV2.Fingerprint"),
)
export type Fingerprint = typeof Fingerprint.Type

export const Source = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("tool"),
    messageID: Schema.String,
    callID: Schema.String,
  }),
]).annotate({ identifier: "PermissionV2.Source" })
export type Source = typeof Source.Type

export const SessionScope = Schema.Struct({
  kind: Schema.Literal("session"),
  sessionID: SessionID,
}).annotate({ identifier: "PermissionV2.SessionScope" })
export type SessionScope = typeof SessionScope.Type

export const ProjectScope = Schema.Struct({
  kind: Schema.Literal("project"),
  projectID: ProjectID,
}).annotate({ identifier: "PermissionV2.ProjectScope" })
export type ProjectScope = typeof ProjectScope.Type

export const Scope = Schema.Union([SessionScope, ProjectScope]).annotate({ identifier: "PermissionV2.Scope" })
export type Scope = typeof Scope.Type

export const ExpiresAt = Schema.NullOr(NonNegativeInt).annotate({ identifier: "PermissionV2.ExpiresAt" })
export type ExpiresAt = typeof ExpiresAt.Type

const RequestFields = {
  sessionID: SessionID,
  fingerprint: Fingerprint,
  subject: Schema.Struct({ kind: Schema.Literal("agent"), id: AgentID }),
  action: Schema.String,
  resources: Schema.Array(Schema.String),
  scope: Scope,
  expiresAt: ExpiresAt,
  save: Schema.Array(Schema.String).pipe(optional),
  metadata: Schema.Record(Schema.String, Schema.Json).pipe(optional),
  source: Source.pipe(optional),
}

export const Request = Schema.Struct({
  id: ID,
  ...RequestFields,
}).annotate({ identifier: "PermissionV2.Request" })
export interface Request extends Schema.Schema.Type<typeof Request> {}

export const Decision = Schema.Literals(["once", "always", "reject"]).annotate({
  identifier: "PermissionV2.Decision",
})
export type Decision = typeof Decision.Type

const DecisionCommandFields = {
  requestFingerprint: Fingerprint,
  decisionID: DecisionID,
  message: Schema.String.pipe(optional),
}

export const DecisionCommand = Schema.Union([
  Schema.Struct({
    ...DecisionCommandFields,
    decision: Schema.Literals(["once", "reject"]),
    grantScope: Schema.Never.pipe(optional),
    grantExpiresAt: Schema.Never.pipe(optional),
  }),
  Schema.Struct({
    ...DecisionCommandFields,
    decision: Schema.Literal("always"),
    grantScope: ProjectScope,
    grantExpiresAt: Schema.Null,
  }),
]).annotate({ identifier: "PermissionV2.DecisionCommand" })
export type DecisionCommand = typeof DecisionCommand.Type

export const DecisionReceipt = Schema.Struct({
  requestID: ID,
  sessionID: SessionID,
  requestFingerprint: Fingerprint,
  decisionID: DecisionID,
  decision: Decision,
  message: Schema.String.pipe(optional),
  grantScope: ProjectScope.pipe(optional),
  grantExpiresAt: ExpiresAt.pipe(optional),
  committedAt: NonNegativeInt,
  resolvedRequestIDs: Schema.Array(ID),
}).annotate({ identifier: "PermissionV2.DecisionReceipt" })
export interface DecisionReceipt extends Schema.Schema.Type<typeof DecisionReceipt> {}

const Asked = define({ type: "permission.v2.asked", schema: Request.fields })
const Replied = define({
  type: "permission.v2.replied",
  schema: DecisionReceipt.fields,
})
export const Event = { Asked, Replied, Definitions: inventory(Asked, Replied) }

export const Effect = Schema.Literals(["allow", "deny", "ask"]).annotate({ identifier: "PermissionV2.Effect" })
export type Effect = typeof Effect.Type

export interface Rule extends Schema.Schema.Type<typeof Rule> {}
export const Rule = Schema.Struct({
  action: Schema.String,
  resource: Schema.String,
  effect: Effect,
}).annotate({ identifier: "PermissionV2.Rule" })

export const Ruleset = Schema.Array(Rule).annotate({ identifier: "PermissionV2.Ruleset" })
export type Ruleset = typeof Ruleset.Type
