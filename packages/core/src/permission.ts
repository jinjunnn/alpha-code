export * as PermissionV2 from "./permission"

import { Permission } from "@opencode-ai/schema/permission"
import { eq, or } from "drizzle-orm"
import { Context, Deferred, Effect, Layer, Schema, Semaphore } from "effect"
import { AgentV2 } from "./agent"
import { Database } from "./database/database"
import { makeLocationNode } from "./effect/app-node"
import { EventV2 } from "./event"
import { Location } from "./location"
import { PermissionSaved } from "./permission/saved"
import { PermissionDecisionTable, PermissionRequestTable, PermissionTable } from "./permission/sql"
import { SessionV2 } from "./session"
import { SessionStore } from "./session/store"
import { Hash } from "./util/hash"
import { Wildcard } from "./util/wildcard"

export { Effect, Rule, Ruleset } from "@opencode-ai/schema/permission"
const missingAgentPermissions: Permission.Ruleset = [{ action: "*", resource: "*", effect: "deny" }]
const stringCharCodeAt = String.prototype.charCodeAt
const hex = "0123456789abcdef"
const metadataMaxEntries = 256
const metadataMaxDepth = 16
const validationOptions = { onExcessProperty: "error" } as const

export const ID = Permission.ID
export type ID = typeof ID.Type

export const DecisionID = Permission.DecisionID
export type DecisionID = typeof DecisionID.Type

export const Fingerprint = Permission.Fingerprint
export type Fingerprint = typeof Fingerprint.Type

export const Source = Permission.Source
export type Source = typeof Source.Type

const RequestFields = {
  sessionID: Permission.Request.fields.sessionID,
  action: Permission.Request.fields.action,
  resources: Permission.Request.fields.resources,
  save: Permission.Request.fields.save,
  metadata: Permission.Request.fields.metadata,
  source: Permission.Request.fields.source,
}

const RequestFacts = Schema.Struct({
  sessionID: Permission.Request.fields.sessionID,
  subject: Permission.Request.fields.subject,
  action: Permission.Request.fields.action,
  resources: Permission.Request.fields.resources,
  scope: Permission.Request.fields.scope,
  expiresAt: Permission.Request.fields.expiresAt,
  save: Permission.Request.fields.save,
  metadata: Permission.Request.fields.metadata,
  source: Permission.Request.fields.source,
})
type RequestFacts = typeof RequestFacts.Type

export const Request = Permission.Request
export type Request = typeof Request.Type

export const Decision = Permission.Decision
export type Decision = typeof Decision.Type

export const DecisionCommand = Permission.DecisionCommand
export type DecisionCommand = typeof DecisionCommand.Type

export const DecisionReceipt = Permission.DecisionReceipt
export type DecisionReceipt = typeof DecisionReceipt.Type

export const AssertInput = Schema.Struct({
  id: ID.pipe(Schema.optional),
  ...RequestFields,
  agent: AgentV2.ID.pipe(Schema.optional),
}).annotate({ identifier: "PermissionV2.AssertInput" })
export type AssertInput = typeof AssertInput.Type

export const ReplyInput = Schema.Struct({
  requestID: ID,
  sessionID: SessionV2.ID,
  command: DecisionCommand,
}).annotate({ identifier: "PermissionV2.ReplyInput" })
export type ReplyInput = typeof ReplyInput.Type

export const AskResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("evaluated"), id: ID, effect: Schema.Literals(["allow", "deny"]) }),
  Schema.Struct({ status: Schema.Literal("pending"), request: Request }),
  Schema.Struct({ status: Schema.Literal("decided"), receipt: DecisionReceipt }),
]).annotate({ identifier: "PermissionV2.AskResult" })
export type AskResult = typeof AskResult.Type

export const Event = Permission.Event

export class DeclinedError extends Schema.TaggedErrorClass<DeclinedError>()("PermissionV2.DeclinedError", {}) {}

export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("PermissionV2.CorrectedError", {
  feedback: Schema.String,
}) {}

export class BlockedError extends Schema.TaggedErrorClass<BlockedError>()("PermissionV2.BlockedError", {
  rules: Permission.Ruleset,
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("PermissionV2.NotFoundError", {
  requestID: ID,
}) {}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("PermissionV2.ConflictError", {
  requestID: ID,
  decisionID: DecisionID.pipe(Schema.optional),
}) {}

export type Error = BlockedError | CorrectedError | ConflictError

export function evaluate(action: string, resource: string, ...rulesets: Permission.Ruleset[]): Permission.Rule {
  for (let rulesetIndex = rulesets.length - 1; rulesetIndex >= 0; rulesetIndex--) {
    const ruleset = rulesets[rulesetIndex]!
    for (let ruleIndex = ruleset.length - 1; ruleIndex >= 0; ruleIndex--) {
      const rule = ruleset[ruleIndex]!
      if (Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource)) return rule
    }
  }
  return { action, resource: "*", effect: "ask" }
}

export function merge(...rulesets: Permission.Ruleset[]): Permission.Ruleset {
  const result: Permission.Rule[] = []
  for (let rulesetIndex = 0; rulesetIndex < rulesets.length; rulesetIndex++) {
    const ruleset = rulesets[rulesetIndex]!
    for (let ruleIndex = 0; ruleIndex < ruleset.length; ruleIndex++) result[result.length] = ruleset[ruleIndex]!
  }
  return result
}

export interface Interface {
  readonly ask: (input: AssertInput) => Effect.Effect<AskResult, SessionV2.NotFoundError | ConflictError>
  readonly assert: (input: AssertInput) => Effect.Effect<void, Error | SessionV2.NotFoundError>
  readonly reply: (input: ReplyInput) => Effect.Effect<DecisionReceipt, NotFoundError | ConflictError>
  readonly get: (id: ID) => Effect.Effect<Request | undefined>
  readonly forSession: (sessionID: SessionV2.ID) => Effect.Effect<ReadonlyArray<Request>>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Permission") {}

interface Pending {
  readonly request: Request
  readonly deferred: Deferred.Deferred<void, DeclinedError | CorrectedError>
}

type DecisionRow = typeof PermissionDecisionTable.$inferSelect
type RequestRow = typeof PermissionRequestTable.$inferSelect
type AlwaysCommand = Extract<DecisionCommand, { readonly decision: "always" }>

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    const location = yield* Location.Service
    const saved = yield* PermissionSaved.Service
    const sessions = yield* SessionStore.Service
    const lock = Semaphore.makeUnsafe(1)
    const pending = new Map<ID, Pending>()

    yield* Effect.addFinalizer(() =>
      Effect.forEach(pending.values(), (item) => Deferred.fail(item.deferred, new DeclinedError()), {
        discard: true,
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pending.clear()
          }),
        ),
      ),
    )

    const savedRules = Effect.fnUntraced(function* () {
      return mapArray(
        yield* saved.list({ projectID: location.project.id }),
        (item): Permission.Rule => ({ action: item.action, resource: item.resource, effect: "allow" }),
      )
    })

    const assertInputSnapshot = Effect.fnUntraced(function* (input: AssertInput) {
      const snapshot = yield* Effect.sync(() => deepFreeze(wireSnapshot(input)))
      // Effect decoders may allocate prototype-bearing containers; only their accept/reject result is authoritative.
      yield* Schema.decodeUnknownEffect(AssertInput, validationOptions)(snapshot).pipe(Effect.orDie)
      return snapshot
    })

    const replyInputSnapshot = Effect.fnUntraced(function* (input: ReplyInput) {
      const snapshot = yield* Effect.sync(() => deepFreeze(wireSnapshot(input)))
      yield* Schema.decodeUnknownEffect(ReplyInput, validationOptions)(snapshot).pipe(Effect.orDie)
      return snapshot
    })

    const resolveInput = Effect.fn("PermissionV2.resolveInput")(function* (input: AssertInput) {
      const sessionID = requiredOwn(input, "sessionID")
      const session = yield* sessions.get(sessionID)
      if (!session) return yield* new SessionV2.NotFoundError({ sessionID })
      const selection = yield* agents.select(own(input, "agent") ?? session.agent)
      return {
        agentID: selection.id,
        rules: selection.info?.permissions ?? missingAgentPermissions,
      }
    })

    const configured = Effect.fn("PermissionV2.configured")(function* (sessionID: SessionV2.ID, agentID: AgentV2.ID) {
      if (!(yield* sessions.get(sessionID))) return yield* new SessionV2.NotFoundError({ sessionID })
      return (yield* agents.get(agentID))?.permissions ?? missingAgentPermissions
    })

    function denied(input: Pick<AssertInput, "action" | "resources">, rules: Permission.Ruleset) {
      const action = requiredOwn(input, "action")
      const resources = requiredOwn(input, "resources")
      for (let index = 0; index < resources.length; index++) {
        if (evaluate(action, resources[index]!, rules).effect === "deny") return true
      }
      return false
    }

    function relevant(input: Pick<AssertInput, "action">, rules: Permission.Ruleset) {
      const result: Permission.Rule[] = []
      const action = requiredOwn(input, "action")
      for (let index = 0; index < rules.length; index++) {
        const rule = rules[index]!
        if (Wildcard.match(action, rule.action)) result[result.length] = rule
      }
      return result
    }

    const evaluateInput = Effect.fnUntraced(function* (input: AssertInput, rules: Permission.Ruleset) {
      if (denied(input, rules)) return { effect: "deny" as const, rules }
      const all = merge(rules, yield* savedRules())
      const action = requiredOwn(input, "action")
      const resources = requiredOwn(input, "resources")
      let effect: Permission.Effect = "allow"
      for (let index = 0; index < resources.length; index++) {
        const result = evaluate(action, resources[index]!, all).effect
        if (result === "deny") return { effect: "deny" as const, rules: all }
        if (result === "ask") effect = "ask"
      }
      return { effect, rules: all }
    })

    const request = Effect.fnUntraced(function* (input: AssertInput, agentID: AgentV2.ID) {
      const sessionID = requiredOwn(input, "sessionID")
      const snapshot = deepFreeze(
        wireSnapshot({
          sessionID,
          subject: { kind: "agent", id: agentID },
          action: requiredOwn(input, "action"),
          resources: requiredOwn(input, "resources"),
          scope: { kind: "session", sessionID },
          expiresAt: null,
          ...(Object.hasOwn(input, "save") ? { save: requiredOwn(input, "save") } : {}),
          ...(Object.hasOwn(input, "metadata") ? { metadata: requiredOwn(input, "metadata") } : {}),
          ...(Object.hasOwn(input, "source") ? { source: requiredOwn(input, "source") } : {}),
        } satisfies RequestFacts),
      )
      yield* Schema.decodeUnknownEffect(RequestFacts, validationOptions)(snapshot).pipe(Effect.orDie)
      return deepFreeze(
        Object.assign(
          Object.create(null),
          {
            id: own(input, "id") ?? ID.create(),
            fingerprint: requestFingerprint(snapshot),
          },
          snapshot,
        ) as Request,
      )
    })

    const findRequest = Effect.fnUntraced(function* (requestID: ID) {
      return yield* database.db
        .select()
        .from(PermissionRequestTable)
        .where(eq(PermissionRequestTable.request_id, requestID))
        .get()
        .pipe(Effect.orDie)
    })

    const findReceipt = Effect.fnUntraced(function* (requestID: ID) {
      const row = yield* database.db
        .select()
        .from(PermissionDecisionTable)
        .where(eq(PermissionDecisionTable.request_id, requestID))
        .get()
        .pipe(Effect.orDie)
      return row ? receipt(row) : undefined
    })

    const admission = Effect.fnUntraced(function* (
      value: Request,
      evaluate: () => Effect.Effect<{ readonly effect: Permission.Effect; readonly rules: Permission.Ruleset }>,
    ) {
      const requestID = requiredOwn(value, "id")
      const fingerprint = requiredOwn(value, "fingerprint")
      const sessionID = requiredOwn(value, "sessionID")
      return yield* lock.withPermit(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const active = pending.get(requestID)
            if (active) {
              if (requiredOwn(active.request, "fingerprint") !== fingerprint)
                return yield* new ConflictError({ requestID })
              return { status: "pending" as const, item: active }
            }
            const admitted = yield* findRequest(requestID)
            if (admitted) {
              if (admitted.request_fingerprint !== fingerprint) return yield* new ConflictError({ requestID })
              const decided = yield* findReceipt(requestID)
              if (decided) {
                if (requiredOwn(decided, "requestFingerprint") !== fingerprint)
                  return yield* new ConflictError({ requestID })
                return { status: "decided" as const, receipt: decided }
              }
              if (admitted.outcome !== "ask") return { status: "evaluated" as const, effect: admitted.outcome }
              const item = {
                request: yield* requestSnapshot(admitted),
                deferred: yield* Deferred.make<void, DeclinedError | CorrectedError>(),
              }
              pending.set(requestID, item)
              yield* events
                .publish(Event.Asked, eventPayload(item.request))
                .pipe(Effect.onError(() => Effect.sync(() => pending.delete(requestID))))
              return { status: "pending" as const, item }
            }

            const historical = yield* findReceipt(requestID)
            if (historical) {
              if (requiredOwn(historical, "sessionID") !== sessionID) return yield* new ConflictError({ requestID })
              if (requiredOwn(historical, "requestFingerprint") !== fingerprint)
                return yield* new ConflictError({ requestID })
              yield* database.db
                .insert(PermissionRequestTable)
                .values({
                  request_id: requestID,
                  session_id: sessionID,
                  request_fingerprint: fingerprint,
                  request: value,
                  outcome: "ask",
                })
                .run()
                .pipe(Effect.orDie)
              return { status: "decided" as const, receipt: historical }
            }

            const result = yield* evaluate()
            yield* database.db
              .insert(PermissionRequestTable)
              .values({
                request_id: requestID,
                session_id: sessionID,
                request_fingerprint: fingerprint,
                request: value,
                outcome: result.effect,
              })
              .run()
              .pipe(Effect.orDie)
            if (result.effect !== "ask")
              return { status: "evaluated" as const, effect: result.effect, rules: result.rules }
            const item = { request: value, deferred: yield* Deferred.make<void, DeclinedError | CorrectedError>() }
            pending.set(requestID, item)
            yield* events
              .publish(Event.Asked, eventPayload(value))
              .pipe(Effect.onError(() => Effect.sync(() => pending.delete(requestID))))
            return { status: "pending" as const, item }
          }),
        ),
      )
    })

    const ask = Effect.fn("PermissionV2.ask")(function* (input: AssertInput) {
      const snapshot = yield* assertInputSnapshot(input)
      const resolved = yield* resolveInput(snapshot)
      const value = yield* request(snapshot, resolved.agentID)
      const admitted = yield* admission(value, () => evaluateInput(value, resolved.rules))
      if (admitted.status === "pending") return { status: "pending" as const, request: detached(admitted.item.request) }
      if (admitted.status === "decided") return { status: "decided" as const, receipt: detached(admitted.receipt) }
      return { status: "evaluated" as const, id: requiredOwn(value, "id"), effect: admitted.effect }
    })

    const assert = Effect.fn("PermissionV2.assert")((input: AssertInput) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const snapshot = yield* assertInputSnapshot(input)
          const resolved = yield* resolveInput(snapshot)
          const value = yield* request(snapshot, resolved.agentID)
          const admitted = yield* admission(value, () => evaluateInput(value, resolved.rules))
          if (admitted.status === "decided") return yield* apply(admitted.receipt)
          if (admitted.status === "evaluated") {
            if (admitted.effect === "allow") return
            return yield* new BlockedError({ rules: relevant(value, admitted.rules ?? resolved.rules) })
          }
          return yield* restore(Deferred.await(admitted.item.deferred)).pipe(
            Effect.catchTag("PermissionV2.DeclinedError", (error) => Effect.die(error)),
          )
        }),
      ),
    )

    const reply = Effect.fn("PermissionV2.reply")(function* (input: ReplyInput) {
      const snapshot = yield* replyInputSnapshot(input)
      const requestID = requiredOwn(snapshot, "requestID")
      const sessionID = requiredOwn(snapshot, "sessionID")
      const command = requiredOwn(snapshot, "command")
      return yield* lock.withPermit(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const decided = yield* database.db
              .select()
              .from(PermissionDecisionTable)
              .where(
                or(
                  eq(PermissionDecisionTable.request_id, requestID),
                  eq(PermissionDecisionTable.decision_id, requiredOwn(command, "decisionID")),
                ),
              )
              .all()
              .pipe(Effect.orDie)
            const previous = findArray(decided, (row) => row.request_id === requestID)
            if (previous) {
              if (previous.session_id !== sessionID) return yield* new NotFoundError({ requestID })
              if (!sameDecision(previous, command))
                return yield* new ConflictError({ requestID, decisionID: requiredOwn(command, "decisionID") })
              return detached(receipt(previous))
            }
            if (decided.length > 0)
              return yield* new ConflictError({ requestID, decisionID: requiredOwn(command, "decisionID") })

            const existing = pending.get(requestID)
            if (!existing || requiredOwn(existing.request, "sessionID") !== sessionID)
              return yield* new NotFoundError({ requestID })
            if (requiredOwn(existing.request, "fingerprint") !== requiredOwn(command, "requestFingerprint"))
              return yield* new ConflictError({ requestID, decisionID: requiredOwn(command, "decisionID") })
            if (requiredOwn(existing.request, "fingerprint") !== requestFingerprint(existing.request))
              return yield* new ConflictError({ requestID, decisionID: requiredOwn(command, "decisionID") })
            const save = own(existing.request, "save")
            if (
              isAlways(command) &&
              (requiredOwn(requiredOwn(command, "grantScope"), "projectID") !== location.project.id || !save?.length)
            )
              return yield* new ConflictError({ requestID, decisionID: requiredOwn(command, "decisionID") })
            const committedAt = Date.now()
            const always = isAlways(command) ? command : undefined
            const batch = always ? [existing, ...(yield* eligible(existing, yield* savedRules()))] : [existing]
            const primary = makeReceipt(
              existing.request,
              command,
              committedAt,
              mapArray(batch, (item) => requiredOwn(item.request, "id")),
            )
            const secondary = always
              ? mapArray(sliceArray(batch, 1), (item) =>
                  makeReceipt(
                    item.request,
                    {
                      requestFingerprint: requiredOwn(item.request, "fingerprint"),
                      decisionID: DecisionID.create(),
                      decision: "always",
                      grantScope: requiredOwn(always, "grantScope"),
                      grantExpiresAt: null,
                    },
                    committedAt,
                    [requiredOwn(item.request, "id")],
                  ),
                )
              : []
            const committed: ReadonlyArray<DecisionReceipt> = yield* database.db
              .transaction((tx) =>
                Effect.gen(function* () {
                  const inserted = yield* tx
                    .insert(PermissionDecisionTable)
                    .values(decisionRow(existing.request, primary))
                    .onConflictDoNothing()
                    .returning({ requestID: PermissionDecisionTable.request_id })
                    .get()
                  if (!inserted) return [] as DecisionReceipt[]

                  if (always) {
                    yield* tx
                      .insert(PermissionTable)
                      .values(
                        mapArray(save!, (resource) => ({
                          id: PermissionSaved.ID.create(),
                          project_id: location.project.id,
                          action: requiredOwn(existing.request, "action"),
                          resource,
                        })),
                      )
                      .onConflictDoNothing()
                      .run()
                  }

                  const insertedSecondary = secondary.length
                    ? yield* tx
                        .insert(PermissionDecisionTable)
                        .values(
                          mapArray(sliceArray(batch, 1), (item, index) => decisionRow(item.request, secondary[index]!)),
                        )
                        .onConflictDoNothing()
                        .returning({ requestID: PermissionDecisionTable.request_id })
                        .all()
                    : []
                  const resolvedRequestIDs = [
                    inserted.requestID,
                    ...mapArray(insertedSecondary, (row) => row.requestID),
                  ]
                  yield* tx
                    .update(PermissionDecisionTable)
                    .set({ resolved_request_ids: resolvedRequestIDs })
                    .where(eq(PermissionDecisionTable.request_id, requiredOwn(existing.request, "id")))
                    .run()
                  return [
                    { ...primary, resolvedRequestIDs },
                    ...filterArray(secondary, (item) => includesArray(resolvedRequestIDs, item.requestID)),
                  ]
                }),
              )
              .pipe(Effect.orDie)

            if (!committed.length) {
              const raced = yield* database.db
                .select()
                .from(PermissionDecisionTable)
                .where(
                  or(
                    eq(PermissionDecisionTable.request_id, requestID),
                    eq(PermissionDecisionTable.decision_id, requiredOwn(command, "decisionID")),
                  ),
                )
                .get()
                .pipe(Effect.orDie)
              if (raced?.request_id === requestID && sameDecision(raced, command)) return detached(receipt(raced))
              return yield* new ConflictError({ requestID, decisionID: requiredOwn(command, "decisionID") })
            }

            yield* Effect.forEach(
              committed,
              (item) =>
                Effect.gen(function* () {
                  const active = pending.get(item.requestID)
                  if (active) {
                    if (item.decision === "reject") {
                      yield* Deferred.fail(
                        active.deferred,
                        item.message ? new CorrectedError({ feedback: item.message }) : new DeclinedError(),
                      )
                    } else {
                      yield* Deferred.succeed(active.deferred, undefined)
                    }
                    pending.delete(item.requestID)
                  }
                  yield* events.publish(Event.Replied, eventPayload(item)).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logError("Permission decision event listener failed", {
                        requestID: item.requestID,
                        decisionID: item.decisionID,
                        cause,
                      }),
                    ),
                  )
                }),
              { discard: true },
            )
            return detached(committed[0]!)
          }),
        ),
      )
    })

    const eligible = Effect.fnUntraced(function* (source: Pending, rememberedRules: Permission.Ruleset) {
      const sourceAction = requiredOwn(source.request, "action")
      const granted = mapArray(
        requiredOwn(source.request, "save")!,
        (resource): Permission.Rule => ({ action: sourceAction, resource, effect: "allow" }),
      )
      const sourceID = requiredOwn(source.request, "id")
      const candidates = filterArray(
        Array.from(pending.values()),
        (item) => requiredOwn(item.request, "id") !== sourceID,
      )
      return filterArray(
        yield* Effect.forEach(candidates, (item) =>
          configured(
            requiredOwn(item.request, "sessionID"),
            requiredOwn(requiredOwn(item.request, "subject"), "id"),
          ).pipe(
            Effect.map((rules) => {
              if (denied(item.request, rules)) return undefined
              const effective = merge(rules, rememberedRules, granted)
              const action = requiredOwn(item.request, "action")
              const resources = requiredOwn(item.request, "resources")
              for (let index = 0; index < resources.length; index++) {
                if (evaluate(action, resources[index]!, effective).effect !== "allow") return undefined
              }
              return item
            }),
            Effect.catchTag("Session.NotFoundError", () => Effect.succeed(undefined)),
          ),
        ),
        (item): item is Pending => item !== undefined,
      )
    })

    const list = Effect.fn("PermissionV2.list")(function* () {
      return Array.from(pending.values(), (item) => detached(item.request))
    })

    const get = Effect.fn("PermissionV2.get")(function* (id: ID) {
      const value = pending.get(id)?.request
      return value ? detached(value) : undefined
    })

    const forSession = Effect.fn("PermissionV2.forSession")(function* (sessionID: SessionV2.ID) {
      return mapArray(
        filterArray(
          Array.from(pending.values(), (item) => item.request),
          (request) => requiredOwn(request, "sessionID") === sessionID,
        ),
        detached,
      )
    })

    return Service.of({ ask, assert, reply, get, forSession, list })
  }),
)

function mapArray<A, B>(values: ReadonlyArray<A>, transform: (value: A, index: number) => B) {
  const result: B[] = []
  for (let index = 0; index < values.length; index++) result[index] = transform(values[index]!, index)
  return result
}

function filterArray<A, B extends A>(values: ReadonlyArray<A>, predicate: (value: A, index: number) => value is B): B[]
function filterArray<A>(values: ReadonlyArray<A>, predicate: (value: A, index: number) => boolean): A[]
function filterArray<A>(values: ReadonlyArray<A>, predicate: (value: A, index: number) => boolean) {
  const result: A[] = []
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!
    if (predicate(value, index)) result[result.length] = value
  }
  return result
}

function findArray<A>(values: ReadonlyArray<A>, predicate: (value: A) => boolean) {
  for (let index = 0; index < values.length; index++) {
    if (predicate(values[index]!)) return values[index]
  }
}

function sliceArray<A>(values: ReadonlyArray<A>, start: number) {
  const result: A[] = []
  for (let index = start; index < values.length; index++) result[result.length] = values[index]!
  return result
}

function includesArray<A>(values: ReadonlyArray<A>, expected: A) {
  for (let index = 0; index < values.length; index++) {
    if (values[index] === expected) return true
  }
  return false
}

function requestFingerprint(value: RequestFacts) {
  const facts = Object.assign(Object.create(null), {
    sessionID: requiredOwn(value, "sessionID"),
    subject: requiredOwn(value, "subject"),
    action: requiredOwn(value, "action"),
    resources: requiredOwn(value, "resources"),
    scope: requiredOwn(value, "scope"),
    expiresAt: requiredOwn(value, "expiresAt"),
    ...(Object.hasOwn(value, "save") ? { save: requiredOwn(value, "save") } : {}),
    ...(Object.hasOwn(value, "metadata") ? { metadata: requiredOwn(value, "metadata") } : {}),
    ...(Object.hasOwn(value, "source") ? { source: requiredOwn(value, "source") } : {}),
  })
  return Fingerprint.make(Hash.sha256(canonicalJson(facts)))
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  for (let index = 0; index < keys.length; index++) {
    if (!Object.hasOwn(keys, index)) throw new Error("Expected own freeze keys")
    const descriptor = descriptorAt(descriptors, keys[index]!)
    if (descriptor && Object.hasOwn(descriptor, "value")) deepFreeze(descriptor.value)
  }
  return Object.freeze(value)
}

function detached<T>(value: T): T {
  return structuredClone(value)
}

function eventPayload<T>(value: T): T {
  return deepFreeze(wireSnapshot(value))
}

function wireSnapshot<T>(value: T): T {
  const path = new Set<object>()
  let metadataEntries = 0
  return visit(value, 0) as T

  function visit(item: unknown, depth: number, metadataDepth?: number): unknown {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item
    if (typeof item === "number") {
      if (!Number.isFinite(item) || Object.is(item, -0)) throw new Error("Expected a finite JSON number other than -0")
      return item
    }
    if (!item || typeof item !== "object" || path.has(item)) throw new Error("Expected an acyclic JSON wire value")
    if (depth > metadataMaxDepth + 2) throw new Error("Expected a bounded JSON wire value")
    if (metadataDepth !== undefined && metadataDepth > metadataMaxDepth)
      throw new Error(`Expected metadata with at most ${metadataMaxDepth} nested containers`)

    const array = Array.isArray(item)
    const prototype = Object.getPrototypeOf(item)
    if (
      (!array && prototype !== Object.prototype && prototype !== null) ||
      (array && prototype !== Array.prototype && prototype !== null)
    )
      throw new Error("Expected a plain JSON wire value")

    const descriptors = Object.getOwnPropertyDescriptors(item)
    const keys = Reflect.ownKeys(descriptors)
    path.add(item)

    if (array) {
      const length = descriptorAt(descriptors, "length")?.value
      if (!Number.isSafeInteger(length) || length < 0) throw new Error("Expected a dense JSON array")
      const result: unknown[] = []
      Object.setPrototypeOf(result, null)
      result.length = length
      if (metadataDepth !== undefined) {
        metadataEntries += length
        if (metadataEntries > metadataMaxEntries)
          throw new Error(`Expected metadata with at most ${metadataMaxEntries} entries`)
      }
      for (let index = 0; index < keys.length; index++) {
        if (!Object.hasOwn(keys, index)) throw new Error("Expected own array indices")
        const key = keys[index]!
        if (key === "length") continue
        if (typeof key !== "string" || !isArrayIndex(key, length)) throw new Error("Expected a dense JSON array")
      }
      for (let index = 0; index < length; index++) {
        const descriptor = descriptorAt(descriptors, String(index))
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
          throw new Error("Expected a dense JSON array")
        result[index] = visit(descriptor.value, depth + 1, metadataDepth === undefined ? undefined : metadataDepth + 1)
      }
      path.delete(item)
      return result
    }

    const result = Object.create(null) as Record<PropertyKey, unknown>
    if (metadataDepth !== undefined) {
      metadataEntries += keys.length
      if (metadataEntries > metadataMaxEntries)
        throw new Error(`Expected metadata with at most ${metadataMaxEntries} entries`)
    }
    for (let index = 0; index < keys.length; index++) {
      if (!Object.hasOwn(keys, index)) throw new Error("Expected own object keys")
      const key = keys[index]!
      if (typeof key !== "string") throw new Error("Expected string-keyed JSON objects")
      const descriptor = descriptorAt(descriptors, key)
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
        throw new Error("Expected enumerable JSON data properties")
      result[key] = visit(
        descriptor.value,
        depth + 1,
        metadataDepth === undefined ? (depth === 0 && key === "metadata" ? 1 : undefined) : metadataDepth + 1,
      )
    }
    path.delete(item)
    return result
  }
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string") return quoteJson(value)
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error("Expected a finite JSON number other than -0")
    return String(value)
  }
  if (!value || typeof value !== "object") throw new Error("Expected a JSON wire value")

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== null) throw new Error("Expected a prototype-free JSON array")
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value
    if (!Number.isSafeInteger(length) || length < 0) throw new Error("Expected a dense JSON array")
    let entries = 0
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue
      if (!isArrayIndex(key, length)) throw new Error("Expected a dense JSON array")
      entries++
    }
    if (entries !== length) throw new Error("Expected a dense JSON array")
    let result = "["
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error("Expected a dense JSON array")
      if (index > 0) result += ","
      result += canonicalJson(descriptor.value)
    }
    return result + "]"
  }
  if (Object.getPrototypeOf(value) !== null) throw new Error("Expected a prototype-free JSON object")

  const keys = Object.create(null) as Record<number, string>
  let length = 0
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
      throw new Error("Expected enumerable JSON data properties")
    keys[length] = key
    length++
  }
  sortKeys(keys, length)

  let result = "{"
  for (let index = 0; index < length; index++) {
    const key = keys[index]!
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
      throw new Error("Expected enumerable JSON data properties")
    if (index > 0) result += ","
    result += quoteJson(key) + ":" + canonicalJson(descriptor.value)
  }
  return result + "}"
}

function sortKeys(keys: Record<number, string>, length: number) {
  const scratch = Object.create(null) as Record<number, string>
  for (let width = 1; width < length; width *= 2) {
    for (let start = 0; start < length; start += width * 2) {
      const middle = Math.min(start + width, length)
      const end = Math.min(start + width * 2, length)
      let left = start
      let right = middle
      for (let target = start; target < end; target++) {
        const takeLeft = right >= end || (left < middle && keys[left]! <= keys[right]!)
        scratch[target] = takeLeft ? keys[left++]! : keys[right++]!
      }
    }
    for (let index = 0; index < length; index++) keys[index] = scratch[index]!
  }
}

function isArrayIndex(key: string, length: number) {
  const index = Number(key)
  return Number.isSafeInteger(index) && index >= 0 && String(index) === key && index < length
}

function quoteJson(value: string) {
  let result = '"'
  for (let index = 0; index < value.length; index++) {
    const code = Reflect.apply(stringCharCodeAt, value, [index])
    if (code === 0x22) result += '\\"'
    else if (code === 0x5c) result += "\\\\"
    else if (code === 0x08) result += "\\b"
    else if (code === 0x0c) result += "\\f"
    else if (code === 0x0a) result += "\\n"
    else if (code === 0x0d) result += "\\r"
    else if (code === 0x09) result += "\\t"
    else if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff))
      result += `\\u${hex[(code >> 12) & 0xf]}${hex[(code >> 8) & 0xf]}${hex[(code >> 4) & 0xf]}${hex[code & 0xf]}`
    else result += value[index]
  }
  return result + '"'
}

function descriptorAt(descriptors: object, key: PropertyKey) {
  return Object.getOwnPropertyDescriptor(descriptors, key)?.value as PropertyDescriptor | undefined
}

function own<T extends object, K extends keyof T>(value: T, key: K): T[K] | undefined {
  if (!Object.hasOwn(value, key)) return undefined
  return value[key]
}

function requiredOwn<T extends object, K extends keyof T>(value: T, key: K): T[K] {
  if (!Object.hasOwn(value, key)) throw new Error(`Missing own permission field: ${String(key)}`)
  return value[key]
}

function requestSnapshot(row: RequestRow) {
  return Effect.sync(() => deepFreeze(wireSnapshot(row.request))).pipe(
    // Keep the prototype-free DB snapshot; the decoder output is validation scratch only.
    Effect.tap(Schema.decodeUnknownEffect(Request, validationOptions)),
    Effect.filterOrFail(
      (value) =>
        requiredOwn(value, "id") === row.request_id &&
        requiredOwn(value, "sessionID") === row.session_id &&
        requiredOwn(value, "fingerprint") === row.request_fingerprint &&
        requiredOwn(value, "fingerprint") === requestFingerprint(value),
      () => new ConflictError({ requestID: row.request_id }),
    ),
    Effect.orDie,
  )
}

function receipt(row: DecisionRow): DecisionReceipt {
  return {
    requestID: row.request_id,
    sessionID: row.session_id,
    requestFingerprint: row.request_fingerprint,
    decisionID: row.decision_id,
    decision: row.decision,
    ...(row.message === null ? {} : { message: row.message }),
    ...(row.grant_scope === null ? {} : { grantScope: row.grant_scope }),
    ...(row.grant_scope === null ? {} : { grantExpiresAt: row.grant_expires_at }),
    committedAt: row.committed_at,
    resolvedRequestIDs: row.resolved_request_ids,
  }
}

function sameDecision(row: DecisionRow, command: DecisionCommand) {
  if (
    row.request_fingerprint !== requiredOwn(command, "requestFingerprint") ||
    row.decision_id !== requiredOwn(command, "decisionID") ||
    row.decision !== requiredOwn(command, "decision") ||
    (row.message ?? undefined) !== own(command, "message")
  )
    return false
  if (requiredOwn(command, "decision") !== "always")
    return (
      !Object.hasOwn(command, "grantScope") &&
      !Object.hasOwn(command, "grantExpiresAt") &&
      row.grant_scope === null &&
      row.grant_expires_at === null
    )
  if (!isAlways(command)) return false
  const grantScope = requiredOwn(command, "grantScope")
  return (
    row.grant_scope?.kind === requiredOwn(grantScope, "kind") &&
    row.grant_scope.projectID === requiredOwn(grantScope, "projectID") &&
    row.grant_expires_at === requiredOwn(command, "grantExpiresAt")
  )
}

function makeReceipt(
  request: Request,
  command: DecisionCommand,
  committedAt: number,
  resolvedRequestIDs: ReadonlyArray<ID>,
): DecisionReceipt {
  const message = own(command, "message")
  return {
    requestID: requiredOwn(request, "id"),
    sessionID: requiredOwn(request, "sessionID"),
    requestFingerprint: requiredOwn(request, "fingerprint"),
    decisionID: requiredOwn(command, "decisionID"),
    decision: requiredOwn(command, "decision"),
    ...(message === undefined ? {} : { message }),
    ...(isAlways(command)
      ? { grantScope: requiredOwn(command, "grantScope"), grantExpiresAt: requiredOwn(command, "grantExpiresAt") }
      : {}),
    committedAt,
    resolvedRequestIDs,
  }
}

function decisionRow(request: Request, value: DecisionReceipt): typeof PermissionDecisionTable.$inferInsert {
  return {
    decision_id: value.decisionID,
    request_id: value.requestID,
    session_id: value.sessionID,
    request_fingerprint: value.requestFingerprint,
    request,
    decision: value.decision,
    message: value.message,
    grant_scope: value.grantScope,
    grant_expires_at: value.grantExpiresAt,
    resolved_request_ids: [...value.resolvedRequestIDs],
    committed_at: value.committedAt,
  }
}

function apply(value: DecisionReceipt) {
  if (requiredOwn(value, "decision") !== "reject") return Effect.void
  const message = own(value, "message")
  return Effect.die(message ? new CorrectedError({ feedback: message }) : new DeclinedError())
}

function isAlways(command: DecisionCommand): command is AlwaysCommand {
  return requiredOwn(command, "decision") === "always"
}

export const locationLayer = layer.pipe(Layer.provideMerge(AgentV2.locationLayer))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, Location.node, AgentV2.node, SessionStore.node, PermissionSaved.node],
})
