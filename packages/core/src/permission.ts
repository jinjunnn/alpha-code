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
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource)) ?? {
      action,
      resource: "*",
      effect: "ask",
    }
  )
}

export function merge(...rulesets: Permission.Ruleset[]): Permission.Ruleset {
  return rulesets.flat()
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
      return (yield* saved.list({ projectID: location.project.id })).map(
        (item): Permission.Rule => ({ action: item.action, resource: item.resource, effect: "allow" }),
      )
    })

    const resolveInput = Effect.fn("PermissionV2.resolveInput")(function* (input: AssertInput) {
      const session = yield* sessions.get(input.sessionID)
      if (!session) return yield* new SessionV2.NotFoundError({ sessionID: input.sessionID })
      const selection = yield* agents.select(input.agent ?? session.agent)
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
      return input.resources.some((resource) => evaluate(input.action, resource, rules).effect === "deny")
    }

    function relevant(input: Pick<AssertInput, "action">, rules: Permission.Ruleset) {
      return rules.filter((rule) => Wildcard.match(input.action, rule.action))
    }

    const evaluateInput = Effect.fnUntraced(function* (input: AssertInput, rules: Permission.Ruleset) {
      if (denied(input, rules)) return { effect: "deny" as const, rules }
      const all = [...rules, ...(yield* savedRules())]
      const effects = input.resources.map((resource) => evaluate(input.action, resource, all).effect)
      const effect: Permission.Effect = effects.includes("deny") ? "deny" : effects.includes("ask") ? "ask" : "allow"
      return { effect, rules: all }
    })

    const request = Effect.fnUntraced(function* (input: AssertInput, agentID: AgentV2.ID) {
      if (input.metadata !== undefined && !isJsonWireValue(input.metadata))
        return yield* Effect.die(new Error("Permission metadata must contain only plain JSON wire values"))
      const facts = yield* Schema.decodeUnknownEffect(RequestFacts)({
        sessionID: input.sessionID,
        subject: { kind: "agent", id: agentID },
        action: input.action,
        resources: input.resources,
        scope: { kind: "session", sessionID: input.sessionID },
        expiresAt: null,
        ...(input.save ? { save: input.save } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
        ...(input.source ? { source: input.source } : {}),
      }).pipe(Effect.orDie)
      const snapshot = structuredClone(facts)
      return deepFreeze({
        id: input.id ?? ID.create(),
        fingerprint: requestFingerprint(snapshot),
        ...snapshot,
      })
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
      return yield* lock.withPermit(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const active = pending.get(value.id)
            if (active) {
              if (active.request.fingerprint !== value.fingerprint)
                return yield* new ConflictError({ requestID: value.id })
              return { status: "pending" as const, item: active }
            }
            const admitted = yield* findRequest(value.id)
            if (admitted) {
              if (admitted.request_fingerprint !== value.fingerprint)
                return yield* new ConflictError({ requestID: value.id })
              const decided = yield* findReceipt(value.id)
              if (decided) return { status: "decided" as const, receipt: decided }
              if (admitted.outcome !== "ask") return { status: "evaluated" as const, effect: admitted.outcome }
              const item = {
                request: yield* requestSnapshot(admitted),
                deferred: yield* Deferred.make<void, DeclinedError | CorrectedError>(),
              }
              pending.set(value.id, item)
              yield* events
                .publish(Event.Asked, detached(item.request))
                .pipe(Effect.onError(() => Effect.sync(() => pending.delete(value.id))))
              return { status: "pending" as const, item }
            }

            const result = yield* evaluate()
            yield* database.db
              .insert(PermissionRequestTable)
              .values({
                request_id: value.id,
                session_id: value.sessionID,
                request_fingerprint: value.fingerprint,
                request: value,
                outcome: result.effect,
              })
              .run()
              .pipe(Effect.orDie)
            if (result.effect !== "ask")
              return { status: "evaluated" as const, effect: result.effect, rules: result.rules }
            const item = { request: value, deferred: yield* Deferred.make<void, DeclinedError | CorrectedError>() }
            pending.set(value.id, item)
            yield* events
              .publish(Event.Asked, detached(value))
              .pipe(Effect.onError(() => Effect.sync(() => pending.delete(value.id))))
            return { status: "pending" as const, item }
          }),
        ),
      )
    })

    const ask = Effect.fn("PermissionV2.ask")(function* (input: AssertInput) {
      const resolved = yield* resolveInput(input)
      const value = yield* request(input, resolved.agentID)
      const admitted = yield* admission(value, () => evaluateInput(value, resolved.rules))
      if (admitted.status === "pending") return { status: "pending" as const, request: detached(admitted.item.request) }
      if (admitted.status === "decided") return { status: "decided" as const, receipt: detached(admitted.receipt) }
      return { status: "evaluated" as const, id: value.id, effect: admitted.effect }
    })

    const assert = Effect.fn("PermissionV2.assert")((input: AssertInput) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const resolved = yield* resolveInput(input)
          const value = yield* request(input, resolved.agentID)
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

    const reply = Effect.fn("PermissionV2.reply")((input: ReplyInput) =>
      lock.withPermit(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const decided = yield* database.db
              .select()
              .from(PermissionDecisionTable)
              .where(
                or(
                  eq(PermissionDecisionTable.request_id, input.requestID),
                  eq(PermissionDecisionTable.decision_id, input.command.decisionID),
                ),
              )
              .all()
              .pipe(Effect.orDie)
            const previous = decided.find((row) => row.request_id === input.requestID)
            if (previous) {
              if (previous.session_id !== input.sessionID)
                return yield* new NotFoundError({ requestID: input.requestID })
              if (!sameDecision(previous, input.command))
                return yield* new ConflictError({ requestID: input.requestID, decisionID: input.command.decisionID })
              return detached(receipt(previous))
            }
            if (decided.length > 0)
              return yield* new ConflictError({ requestID: input.requestID, decisionID: input.command.decisionID })

            const existing = pending.get(input.requestID)
            if (!existing || existing.request.sessionID !== input.sessionID)
              return yield* new NotFoundError({ requestID: input.requestID })
            if (existing.request.fingerprint !== input.command.requestFingerprint)
              return yield* new ConflictError({ requestID: input.requestID, decisionID: input.command.decisionID })
            if (existing.request.fingerprint !== requestFingerprint(existing.request))
              return yield* new ConflictError({ requestID: input.requestID, decisionID: input.command.decisionID })
            if (
              isAlways(input.command) &&
              (input.command.grantScope.projectID !== location.project.id || !existing.request.save?.length)
            )
              return yield* new ConflictError({ requestID: input.requestID, decisionID: input.command.decisionID })
            const committedAt = Date.now()
            const always = isAlways(input.command) ? input.command : undefined
            const batch = always ? [existing, ...(yield* eligible(existing, yield* savedRules()))] : [existing]
            const primary = makeReceipt(
              existing.request,
              input.command,
              committedAt,
              batch.map((item) => item.request.id),
            )
            const secondary = always
              ? batch.slice(1).map((item) =>
                  makeReceipt(
                    item.request,
                    {
                      requestFingerprint: item.request.fingerprint,
                      decisionID: DecisionID.create(),
                      decision: "always",
                      grantScope: always.grantScope,
                      grantExpiresAt: null,
                    },
                    committedAt,
                    [item.request.id],
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
                        existing.request.save!.map((resource) => ({
                          id: PermissionSaved.ID.create(),
                          project_id: location.project.id,
                          action: existing.request.action,
                          resource,
                        })),
                      )
                      .onConflictDoNothing()
                      .run()
                  }

                  const insertedSecondary = secondary.length
                    ? yield* tx
                        .insert(PermissionDecisionTable)
                        .values(batch.slice(1).map((item, index) => decisionRow(item.request, secondary[index]!)))
                        .onConflictDoNothing()
                        .returning({ requestID: PermissionDecisionTable.request_id })
                        .all()
                    : []
                  const resolvedRequestIDs = [inserted.requestID, ...insertedSecondary.map((row) => row.requestID)]
                  yield* tx
                    .update(PermissionDecisionTable)
                    .set({ resolved_request_ids: resolvedRequestIDs })
                    .where(eq(PermissionDecisionTable.request_id, existing.request.id))
                    .run()
                  return [
                    { ...primary, resolvedRequestIDs },
                    ...secondary.filter((item) => resolvedRequestIDs.includes(item.requestID)),
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
                    eq(PermissionDecisionTable.request_id, input.requestID),
                    eq(PermissionDecisionTable.decision_id, input.command.decisionID),
                  ),
                )
                .get()
                .pipe(Effect.orDie)
              if (raced?.request_id === input.requestID && sameDecision(raced, input.command))
                return detached(receipt(raced))
              return yield* new ConflictError({ requestID: input.requestID, decisionID: input.command.decisionID })
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
                  yield* events.publish(Event.Replied, detached(item)).pipe(
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
      ),
    )

    const eligible = Effect.fnUntraced(function* (source: Pending, rememberedRules: Permission.Ruleset) {
      const granted = source.request.save!.map(
        (resource): Permission.Rule => ({ action: source.request.action, resource, effect: "allow" }),
      )
      const candidates = Array.from(pending.values()).filter((item) => item.request.id !== source.request.id)
      return (yield* Effect.forEach(candidates, (item) =>
        configured(item.request.sessionID, item.request.subject.id).pipe(
          Effect.map((rules) => {
            if (denied(item.request, rules)) return undefined
            const effective = [...rules, ...rememberedRules, ...granted]
            if (
              !item.request.resources.every(
                (resource) => evaluate(item.request.action, resource, effective).effect === "allow",
              )
            )
              return undefined
            return item
          }),
          Effect.catchTag("Session.NotFoundError", () => Effect.succeed(undefined)),
        ),
      )).filter((item): item is Pending => item !== undefined)
    })

    const list = Effect.fn("PermissionV2.list")(function* () {
      return Array.from(pending.values(), (item) => detached(item.request))
    })

    const get = Effect.fn("PermissionV2.get")(function* (id: ID) {
      const value = pending.get(id)?.request
      return value ? detached(value) : undefined
    })

    const forSession = Effect.fn("PermissionV2.forSession")(function* (sessionID: SessionV2.ID) {
      return Array.from(pending.values(), (item) => item.request)
        .filter((request) => request.sessionID === sessionID)
        .map(detached)
    })

    return Service.of({ ask, assert, reply, get, forSession, list })
  }),
)

function requestFingerprint(value: RequestFacts) {
  return Fingerprint.make(
    Hash.sha256(
      JSON.stringify(
        normalize({
          sessionID: value.sessionID,
          subject: value.subject,
          action: value.action,
          resources: value.resources,
          scope: value.scope,
          expiresAt: value.expiresAt,
          ...(value.save === undefined ? {} : { save: value.save }),
          ...(value.metadata === undefined ? {} : { metadata: value.metadata }),
          ...(value.source === undefined ? {} : { source: value.source }),
        }),
      ),
    ),
  )
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalize(item)]),
  )
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value
  Object.values(value).forEach(deepFreeze)
  return Object.freeze(value)
}

function detached<T>(value: T): T {
  return structuredClone(value)
}

function isJsonWireValue(value: unknown): value is Schema.Json {
  const path = new Set<unknown>()
  return visit(value)

  function visit(item: unknown): boolean {
    if (item === null || typeof item === "string" || typeof item === "boolean") return true
    if (typeof item === "number") return Number.isFinite(item)
    if (!item || typeof item !== "object" || path.has(item)) return false
    const prototype = Object.getPrototypeOf(item)
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) return false
    const descriptors = Object.getOwnPropertyDescriptors(item)
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) return false
    path.add(item)
    const valid = Array.isArray(item)
      ? Reflect.ownKeys(descriptors).every(
          (key) =>
            key === "length" || (typeof key === "string" && /^(0|[1-9]\d*)$/.test(key) && Number(key) < item.length),
        ) &&
        Array.from({ length: item.length }, (_, index) => descriptors[index]).every(
          (descriptor) =>
            descriptor !== undefined && descriptor.enumerable && "value" in descriptor && visit(descriptor.value),
        )
      : Object.values(descriptors).every(
          (descriptor) => descriptor.enumerable && "value" in descriptor && visit(descriptor.value),
        )
    path.delete(item)
    return valid
  }
}

function requestSnapshot(row: RequestRow) {
  return Schema.decodeUnknownEffect(Request)(row.request).pipe(
    Effect.filterOrFail(
      (value) =>
        value.id === row.request_id &&
        value.sessionID === row.session_id &&
        value.fingerprint === row.request_fingerprint &&
        value.fingerprint === requestFingerprint(value),
      () => new ConflictError({ requestID: row.request_id }),
    ),
    Effect.map((value) => deepFreeze(detached(value))),
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
    row.request_fingerprint !== command.requestFingerprint ||
    row.decision_id !== command.decisionID ||
    row.decision !== command.decision ||
    (row.message ?? undefined) !== command.message
  )
    return false
  if (command.decision !== "always")
    return (
      command.grantScope === undefined &&
      command.grantExpiresAt === undefined &&
      row.grant_scope === null &&
      row.grant_expires_at === null
    )
  if (!isAlways(command)) return false
  return (
    row.grant_scope?.kind === command.grantScope.kind &&
    row.grant_scope.projectID === command.grantScope.projectID &&
    row.grant_expires_at === command.grantExpiresAt
  )
}

function makeReceipt(
  request: Request,
  command: DecisionCommand,
  committedAt: number,
  resolvedRequestIDs: ReadonlyArray<ID>,
): DecisionReceipt {
  return {
    requestID: request.id,
    sessionID: request.sessionID,
    requestFingerprint: request.fingerprint,
    decisionID: command.decisionID,
    decision: command.decision,
    ...(command.message === undefined ? {} : { message: command.message }),
    ...(isAlways(command) ? { grantScope: command.grantScope, grantExpiresAt: command.grantExpiresAt } : {}),
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
  if (value.decision !== "reject") return Effect.void
  return Effect.die(value.message ? new CorrectedError({ feedback: value.message }) : new DeclinedError())
}

function isAlways(command: DecisionCommand): command is AlwaysCommand {
  return command.decision === "always"
}

export const locationLayer = layer.pipe(Layer.provideMerge(AgentV2.locationLayer))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, Location.node, AgentV2.node, SessionStore.node, PermissionSaved.node],
})
