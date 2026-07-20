import { describe, expect } from "bun:test"
import { Cause, Context, Deferred, Effect, Fiber, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { PermissionDecisionTable, PermissionRequestTable, PermissionTable } from "@opencode-ai/core/permission/sql"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { eq } from "drizzle-orm"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionStore.node,
      PermissionSaved.node,
      AgentV2.node,
      PermissionV2.node,
    ]),
    [[Location.node, current]],
  ),
)

function setup(rules: PermissionV2.Ruleset = []) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionV2.ID.make("ses_test"),
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
        agent: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* setRules(rules)
  })
}

function setRules(rules: PermissionV2.Ruleset) {
  return Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    yield* agents.transform((editor) =>
      editor.update(AgentV2.ID.make("test"), (agent) => {
        agent.permissions = [...rules]
      }),
    )
  })
}

function assertion(input: Partial<PermissionV2.AssertInput> = {}) {
  return {
    id: PermissionV2.ID.create("per_test"),
    sessionID: SessionV2.ID.make("ses_test"),
    action: "read",
    resources: ["src/index.ts"],
    ...input,
  } satisfies PermissionV2.AssertInput
}

function decision(
  request: PermissionV2.Request,
  value: "once" | "reject" | "always",
  decisionID = PermissionV2.DecisionID.create(`pdec_${request.id}`),
): PermissionV2.ReplyInput {
  return {
    requestID: request.id,
    sessionID: request.sessionID,
    command:
      value === "always"
        ? {
            requestFingerprint: request.fingerprint,
            decisionID,
            decision: value,
            grantScope: { kind: "project", projectID: Project.ID.global },
            grantExpiresAt: null,
          }
        : { requestFingerprint: request.fingerprint, decisionID, decision: value },
  }
}

function waitForRequest(input = assertion()) {
  return Effect.gen(function* () {
    const service = yield* PermissionV2.Service
    const events = yield* EventV2.Service
    const asked = yield* Deferred.make<PermissionV2.Request>()
    const unsubscribe = yield* events.listen((event) =>
      event.type === PermissionV2.Event.Asked.type
        ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
        : Effect.void,
    )
    const fiber = yield* service.assert(input).pipe(Effect.forkScoped)
    const request = yield* Deferred.await(asked)
    yield* unsubscribe
    yield* Effect.yieldNow
    return { service, fiber, request }
  })
}

function restartPermission() {
  return Effect.gen(function* () {
    const restartedLayer = AppNodeBuilder.build(PermissionV2.node, [
      [Database.node, Layer.succeed(Database.Service, yield* Database.Service)],
      [EventV2.node, Layer.succeed(EventV2.Service, yield* EventV2.Service)],
      [
        Location.node,
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/project") }))),
      ],
      [AgentV2.node, Layer.succeed(AgentV2.Service, yield* AgentV2.Service)],
      [SessionStore.node, Layer.succeed(SessionStore.Service, yield* SessionStore.Service)],
      [PermissionSaved.node, Layer.succeed(PermissionSaved.Service, yield* PermissionSaved.Service)],
    ])
    return Context.get(yield* Layer.build(restartedLayer), PermissionV2.Service)
  })
}

describe("PermissionV2", () => {
  it.effect("returns the evaluated effect and only queues prompts", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion({ id: PermissionV2.ID.create("per_allow") }))).toEqual({
        status: "evaluated",
        id: PermissionV2.ID.create("per_allow"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion({ id: PermissionV2.ID.create("per_deny") }))).toEqual({
        status: "evaluated",
        id: PermissionV2.ID.create("per_deny"),
        effect: "deny",
      })
      expect(yield* service.list()).toEqual([])
      yield* setRules([])
      expect(yield* service.ask(assertion({ id: PermissionV2.ID.create("per_pending") }))).toMatchObject({
        status: "pending",
        request: { id: PermissionV2.ID.create("per_pending") },
      })
      expect(yield* service.get(PermissionV2.ID.create("per_pending"))).toBeDefined()
    }),
  )

  it.effect("persists evaluated outcomes and replays them across rules changes and restarts", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      const allow = assertion({ id: PermissionV2.ID.create("per_evaluated_allow") })
      expect(yield* service.ask(allow)).toMatchObject({ status: "evaluated", effect: "allow" })

      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      const restarted = yield* restartPermission()
      expect(yield* restarted.ask(allow)).toMatchObject({ status: "evaluated", effect: "allow" })
      const conflict = yield* restarted.ask({ ...allow, resources: ["src/other.ts"] }).pipe(Effect.flip)
      expect(conflict).toEqual(new PermissionV2.ConflictError({ requestID: allow.id }))

      const deny = assertion({ id: PermissionV2.ID.create("per_evaluated_deny") })
      expect(yield* restarted.ask(deny)).toMatchObject({ status: "evaluated", effect: "deny" })
      yield* setRules([{ action: "read", resource: "*", effect: "allow" }])
      expect(yield* (yield* restartPermission()).ask(deny)).toMatchObject({ status: "evaluated", effect: "deny" })

      const database = yield* Database.Service
      expect(
        (yield* database.db.select().from(PermissionRequestTable).all()).map((row) => ({
          requestID: row.request_id,
          outcome: row.outcome,
        })),
      ).toEqual([
        { requestID: allow.id, outcome: "allow" },
        { requestID: deny.id, outcome: "deny" },
      ])
    }),
  )

  it.effect("replays only an exact pre-admission receipt and records the admission fact", () =>
    Effect.gen(function* () {
      yield* setup()
      const original = yield* waitForRequest(assertion({ id: PermissionV2.ID.create("per_legacy_receipt") }))
      const receipt = yield* original.service.reply(
        decision(original.request, "reject", PermissionV2.DecisionID.create("pdec_legacy_receipt")),
      )
      yield* Fiber.await(original.fiber)
      const database = yield* Database.Service
      yield* database.db
        .delete(PermissionRequestTable)
        .where(eq(PermissionRequestTable.request_id, original.request.id))
        .run()
        .pipe(Effect.orDie)
      yield* setRules([{ action: "read", resource: "*", effect: "allow" }])

      const restarted = yield* restartPermission()
      const conflict = yield* restarted
        .ask(assertion({ id: original.request.id, action: "bash", resources: ["pwd"] }))
        .pipe(Effect.flip)
      expect(conflict).toEqual(new PermissionV2.ConflictError({ requestID: original.request.id }))
      expect(yield* database.db.select().from(PermissionRequestTable).all()).toEqual([])

      expect(yield* restarted.ask(assertion({ id: original.request.id }))).toEqual({
        status: "decided",
        receipt,
      })
      expect((yield* restarted.assert(assertion({ id: original.request.id })).pipe(Effect.exit))._tag).toBe("Failure")
      expect(yield* database.db.select().from(PermissionRequestTable).all()).toMatchObject([
        {
          request_id: original.request.id,
          request_fingerprint: original.request.fingerprint,
          outcome: "ask",
        },
      ])
      expect(yield* database.db.select().from(PermissionDecisionTable).all()).toHaveLength(1)
    }),
  )

  it.effect("conflicts on a pre-admission receipt without a usable fingerprint", () =>
    Effect.gen(function* () {
      yield* setup()
      const original = yield* waitForRequest(assertion({ id: PermissionV2.ID.create("per_unfingerprinted_receipt") }))
      yield* original.service.reply(
        decision(original.request, "once", PermissionV2.DecisionID.create("pdec_unfingerprinted_receipt")),
      )
      yield* Fiber.await(original.fiber)
      const database = yield* Database.Service
      yield* database.db
        .delete(PermissionRequestTable)
        .where(eq(PermissionRequestTable.request_id, original.request.id))
        .run()
        .pipe(Effect.orDie)
      yield* database.db
        .update(PermissionDecisionTable)
        .set({ request_fingerprint: "" as never })
        .where(eq(PermissionDecisionTable.request_id, original.request.id))
        .run()
        .pipe(Effect.orDie)

      const conflict = yield* (yield* restartPermission()).ask(assertion({ id: original.request.id })).pipe(Effect.flip)

      expect(conflict).toEqual(new PermissionV2.ConflictError({ requestID: original.request.id }))
      expect(yield* database.db.select().from(PermissionRequestTable).all()).toEqual([])
    }),
  )

  it.effect("snapshots and freezes caller-owned request facts before admission", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      const invalid = yield* service
        .ask(
          assertion({
            id: PermissionV2.ID.create("per_invalid_metadata"),
            metadata: { date: new Date("2026-07-20T00:00:00.000Z") } as never,
          }),
        )
        .pipe(Effect.exit)
      expect(invalid._tag).toBe("Failure")
      const marker = { accessed: false }
      const accessor = Object.defineProperty({}, "value", {
        enumerable: true,
        get() {
          marker.accessed = true
          return "unexpected"
        },
      })
      expect(
        (yield* service
          .ask(
            assertion({
              id: PermissionV2.ID.create("per_accessor_metadata"),
              metadata: { accessor } as never,
            }),
          )
          .pipe(Effect.exit))._tag,
      ).toBe("Failure")
      expect(marker.accessed).toBe(false)

      const resources = ["src/index.ts"]
      const save = ["src/*"]
      const metadata = { context: { origin: "tool" } }
      const source = { type: "tool" as const, messageID: "msg_original", callID: "call_original" }
      const result = yield* service.ask(
        assertion({ id: PermissionV2.ID.create("per_caller_snapshot"), resources, save, metadata, source }),
      )
      expect(result.status).toBe("pending")
      if (result.status !== "pending") return

      resources[0] = "outside/project"
      save[0] = "*"
      metadata.context.origin = "mutated"
      source.callID = "call_mutated"

      const snapshot = yield* service.get(result.request.id)
      expect(snapshot).toMatchObject({
        resources: ["src/index.ts"],
        save: ["src/*"],
        metadata: { context: { origin: "tool" } },
        source: { callID: "call_original" },
      })
      yield* service.reply(decision(snapshot!, "always"))

      const database = yield* Database.Service
      expect(yield* database.db.select().from(PermissionTable).all()).toMatchObject([
        { action: "read", resource: "src/*" },
      ])
    }),
  )

  it.effect("rejects -0 metadata before admission", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      const result = yield* service
        .ask(assertion({ id: PermissionV2.ID.create("per_negative_zero"), metadata: { value: -0 } }))
        .pipe(Effect.exit)

      expect(result._tag).toBe("Failure")
      expect(yield* (yield* Database.Service).db.select().from(PermissionRequestTable).all()).toEqual([])
    }),
  )

  it.effect("rejects non-canonical array properties without evaluating their values", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      const negative = ["src/index.ts"]
      const marker = { accessed: false }
      Object.defineProperty(negative, "-1", {
        enumerable: true,
        get() {
          marker.accessed = true
          return "outside/project"
        },
      })
      const notANumber = ["src/index.ts"]
      Object.defineProperty(notANumber, "NaN", { enumerable: true, value: "outside/project" })

      const negativeResult = yield* service
        .ask(assertion({ id: PermissionV2.ID.create("per_negative_index"), resources: negative }))
        .pipe(Effect.exit)
      const notANumberResult = yield* service
        .ask(assertion({ id: PermissionV2.ID.create("per_nan_index"), resources: notANumber }))
        .pipe(Effect.exit)

      expect(negativeResult._tag).toBe("Failure")
      expect(notANumberResult._tag).toBe("Failure")
      expect(marker.accessed).toBe(false)
      expect(yield* (yield* Database.Service).db.select().from(PermissionRequestTable).all()).toEqual([])
    }),
  )

  it.effect("ignores an inherited save grant when Object.prototype is polluted", () =>
    Effect.gen(function* () {
      yield* setup()
      const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, "save")
      const restore = () =>
        descriptor
          ? Object.defineProperty(Object.prototype, "save", descriptor)
          : Reflect.deleteProperty(Object.prototype, "save")
      yield* Effect.addFinalizer(() => Effect.sync(restore))
      Object.defineProperty(Object.prototype, "save", { configurable: true, value: ["*"], writable: true })

      const service = yield* PermissionV2.Service
      const result = yield* service.ask(assertion({ id: PermissionV2.ID.create("per_inherited_save") }))
      expect(result.status).toBe("pending")
      if (result.status !== "pending") return
      const reply = yield* service.reply(decision(result.request, "always")).pipe(Effect.exit)
      const database = yield* Database.Service
      const grants = yield* database.db.select().from(PermissionTable).all()
      restore()

      expect(reply._tag).toBe("Failure")
      expect(grants).toEqual([])
    }),
  )

  it.effect("does not invoke inherited toJSON methods while fingerprinting", () =>
    Effect.gen(function* () {
      yield* setup()
      const objectDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON")
      const arrayDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON")
      const restore = () => {
        if (objectDescriptor) Object.defineProperty(Object.prototype, "toJSON", objectDescriptor)
        else Reflect.deleteProperty(Object.prototype, "toJSON")
        if (arrayDescriptor) Object.defineProperty(Array.prototype, "toJSON", arrayDescriptor)
        else Reflect.deleteProperty(Array.prototype, "toJSON")
      }
      yield* Effect.addFinalizer(() => Effect.sync(restore))
      Object.defineProperty(Object.prototype, "toJSON", {
        configurable: true,
        value: () => ({ collision: true }),
        writable: true,
      })
      Object.defineProperty(Array.prototype, "toJSON", {
        configurable: true,
        value: () => ["collision"],
        writable: true,
      })

      const service = yield* PermissionV2.Service
      const first = yield* service.ask(
        assertion({ id: PermissionV2.ID.create("per_fingerprint_first"), resources: ["src/first.ts"] }),
      )
      const second = yield* service.ask(
        assertion({
          id: PermissionV2.ID.create("per_fingerprint_second"),
          action: "bash",
          resources: ["pwd"],
        }),
      )
      restore()

      expect(first.status).toBe("pending")
      expect(second.status).toBe("pending")
      if (first.status !== "pending" || second.status !== "pending") return
      expect(first.request.fingerprint).not.toBe(second.request.fingerprint)
    }),
  )

  it.effect("keeps action in the fingerprint under Array prototype pollution", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      const firstInput = assertion({ id: PermissionV2.ID.create("per_array_setter_first") })
      const secondInput = assertion({ id: PermissionV2.ID.create("per_array_setter_second"), action: "bash" })
      const retryInput = assertion({ id: firstInput.id, action: "bash" })
      const indexDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "2")
      const iteratorDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator)!
      const pushDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "push")!
      const arrayIterator = Array.prototype[Symbol.iterator]
      const arrayPush = Array.prototype.push
      const restore = () => {
        if (indexDescriptor) Object.defineProperty(Array.prototype, "2", indexDescriptor)
        else Reflect.deleteProperty(Array.prototype, "2")
        Object.defineProperty(Array.prototype, Symbol.iterator, iteratorDescriptor)
        Object.defineProperty(Array.prototype, "push", pushDescriptor)
      }
      yield* Effect.addFinalizer(() => Effect.sync(restore))
      Object.defineProperty(Array.prototype, "2", {
        configurable: true,
        set(value) {
          Object.defineProperty(this, "2", {
            configurable: true,
            enumerable: true,
            value: value === "action" ? "resources" : value,
            writable: true,
          })
        },
      })
      Object.defineProperty(Array.prototype, Symbol.iterator, {
        configurable: true,
        value: function (this: unknown[]) {
          if (this === firstInput.resources || this === secondInput.resources || this === retryInput.resources)
            throw new Error("request arrays must use own-index iteration")
          return Reflect.apply(arrayIterator, this, [])
        },
        writable: true,
      })
      Object.defineProperty(Array.prototype, "push", {
        configurable: true,
        value: function (this: unknown[], ...values: unknown[]) {
          if (this === firstInput.resources || this === secondInput.resources || this === retryInput.resources)
            throw new Error("request arrays must not use inherited push")
          return Reflect.apply(arrayPush, this, values)
        },
        writable: true,
      })

      const first = yield* service.ask(firstInput)
      const second = yield* service.ask(secondInput)
      const conflict = yield* service.ask(retryInput).pipe(Effect.flip)
      restore()

      expect(first.status).toBe("pending")
      expect(second.status).toBe("pending")
      if (first.status !== "pending" || second.status !== "pending") return
      expect(first.request.fingerprint).not.toBe(second.request.fingerprint)
      expect(conflict).toEqual(new PermissionV2.ConflictError({ requestID: firstInput.id }))
    }),
  )

  it.effect("does not trust a polluted Array.prototype every method", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      const source = yield* service.ask(
        assertion({
          id: PermissionV2.ID.create("per_array_pollution_source"),
          resources: ["src/a.ts"],
          save: ["src/*"],
        }),
      )
      const unrelated = yield* service.ask(
        assertion({
          id: PermissionV2.ID.create("per_array_pollution_unrelated"),
          action: "bash",
          resources: ["pwd"],
        }),
      )
      expect(source.status).toBe("pending")
      expect(unrelated.status).toBe("pending")
      if (source.status !== "pending" || unrelated.status !== "pending") return

      const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, "every")
      const restore = () => Object.defineProperty(Array.prototype, "every", descriptor!)
      yield* Effect.addFinalizer(() => Effect.sync(restore))
      Object.defineProperty(Array.prototype, "every", { configurable: true, value: () => true, writable: true })

      const receipt = yield* service.reply(decision(source.request, "always"))
      restore()

      expect(receipt.resolvedRequestIDs).toEqual([source.request.id])
      expect(yield* service.list()).toEqual([unrelated.request])
      yield* service.reply(decision(unrelated.request, "reject"))
    }),
  )

  it.effect("reads Proxy metadata only into the inert snapshot", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      const reads = { count: 0 }
      const metadata = {
        nested: new Proxy(
          { value: "safe" },
          {
            get(target, key, receiver) {
              if (key === "value") {
                reads.count++
                return new Date("2026-07-20T00:00:00.000Z")
              }
              return Reflect.get(target, key, receiver)
            },
          },
        ),
      }
      const input = assertion({
        id: PermissionV2.ID.create("per_proxy_snapshot"),
        metadata: metadata as never,
      })

      const result = yield* service.ask(input)
      expect(result.status).toBe("pending")
      if (result.status !== "pending") return
      const snapshot = (yield* service.get(input.id))!
      const retry = yield* service.ask(assertion({ id: input.id, metadata: { nested: { value: "safe" } } }))

      expect(reads.count).toBe(0)
      expect(snapshot.metadata).toEqual({ nested: { value: "safe" } })
      expect(retry).toEqual({ status: "pending", request: snapshot })
    }),
  )

  it.effect("sorts bounded metadata and rejects entry or depth overflow", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      const bounded = Object.create(null) as Record<string, string>
      for (let index = 255; index >= 0; index--) bounded[`key_${String(index).padStart(3, "0")}`] = String(index)
      const accepted = yield* service.ask(
        assertion({ id: PermissionV2.ID.create("per_metadata_bounded"), metadata: bounded }),
      )

      const tooMany = Object.create(null) as Record<string, string>
      for (let index = 256; index >= 0; index--) tooMany[`key_${String(index).padStart(3, "0")}`] = String(index)
      const entryOverflow = yield* service
        .ask(assertion({ id: PermissionV2.ID.create("per_metadata_entries"), metadata: tooMany }))
        .pipe(Effect.exit)

      const boundedDepth: Record<string, unknown> = Object.create(null)
      let boundedCursor = boundedDepth
      for (let depth = 1; depth < 16; depth++) {
        const next: Record<string, unknown> = Object.create(null)
        boundedCursor.next = next
        boundedCursor = next
      }
      boundedCursor.value = "accepted"
      const depthAccepted = yield* service.ask(
        assertion({
          id: PermissionV2.ID.create("per_metadata_depth_bounded"),
          metadata: boundedDepth as never,
        }),
      )

      const tooDeep: Record<string, unknown> = Object.create(null)
      let deepCursor = tooDeep
      for (let depth = 1; depth <= 16; depth++) {
        const next: Record<string, unknown> = Object.create(null)
        deepCursor.next = next
        deepCursor = next
      }
      deepCursor.value = "rejected"
      const depthOverflow = yield* service
        .ask(
          assertion({
            id: PermissionV2.ID.create("per_metadata_depth"),
            metadata: tooDeep as never,
          }),
        )
        .pipe(Effect.exit)

      expect(accepted.status).toBe("pending")
      expect(depthAccepted.status).toBe("pending")
      expect(entryOverflow._tag).toBe("Failure")
      expect(depthOverflow._tag).toBe("Failure")
    }),
  )

  it.effect("freezes asked events across sequential listeners", () =>
    Effect.gen(function* () {
      yield* setup()
      const events = yield* EventV2.Service
      const mutations: boolean[] = []
      const observed = yield* Deferred.make<PermissionV2.Request>()
      const first = yield* events.listen((event) =>
        event.type === PermissionV2.Event.Asked.type
          ? Effect.sync(() => {
              const request = event.data as PermissionV2.Request
              mutations.push(Reflect.set(request, "action", "bash"))
              mutations.push(Reflect.set(request.resources, 0, "pwd"))
              mutations.push(Reflect.set(event, "data", { ...request, action: "bash", resources: ["pwd"] }))
            })
          : Effect.void,
      )
      const second = yield* events.listen((event) =>
        event.type === PermissionV2.Event.Asked.type
          ? Deferred.succeed(observed, event.data as PermissionV2.Request).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => Effect.all([first, second], { discard: true }))

      const result = yield* (yield* PermissionV2.Service).ask(
        assertion({ id: PermissionV2.ID.create("per_frozen_event"), metadata: { origin: "tool" } }),
      )
      const request = yield* Deferred.await(observed)

      expect(result.status).toBe("pending")
      expect(mutations).toEqual([false, false, false])
      expect(request.action).toBe("read")
      expect(request.resources).toEqual(["src/index.ts"])
      expect(request.metadata).toEqual({ origin: "tool" })
      expect(Object.isFrozen(request)).toBe(true)
      expect(Object.isFrozen(request.resources)).toBe(true)
      expect(Object.isFrozen(request.metadata)).toBe(true)
    }),
  )

  it.effect("detaches asked events and ask, get, list, and session-list results", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      const events = yield* EventV2.Service
      const observed = yield* Deferred.make<PermissionV2.Request>()
      const replied = yield* Deferred.make<PermissionV2.DecisionReceipt>()
      const unsubscribe = yield* events.listen((event) =>
        event.type === PermissionV2.Event.Asked.type
          ? Deferred.succeed(observed, event.data as PermissionV2.Request).pipe(Effect.asVoid)
          : event.type === PermissionV2.Event.Replied.type
            ? Deferred.succeed(replied, event.data as PermissionV2.DecisionReceipt).pipe(Effect.asVoid)
            : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      const result = yield* service.ask(
        assertion({ id: PermissionV2.ID.create("per_detached"), save: ["src/*"], metadata: { origin: "tool" } }),
      )
      expect(result.status).toBe("pending")
      if (result.status !== "pending") return
      const eventRequest = yield* Deferred.await(observed)
      const got = (yield* service.get(result.request.id))!
      const listed = (yield* service.list())[0]!
      const sessionListed = (yield* service.forSession(result.request.sessionID))[0]!

      expect(Reflect.set(eventRequest.save as string[], 0, "*")).toBe(false)
      ;(result.request.save as string[])[0] = "event/*"
      ;(got.save as string[])[0] = "get/*"
      ;(listed.save as string[])[0] = "list/*"
      ;(sessionListed.save as string[])[0] = "session/*"

      const snapshot = (yield* service.get(result.request.id))!
      expect(snapshot.save).toEqual(["src/*"])
      const command = decision(snapshot, "always")
      const receipt = yield* service.reply(command)
      const eventReceipt = yield* Deferred.await(replied)
      expect(Reflect.set(eventReceipt.resolvedRequestIDs, 0, "per_mutated")).toBe(false)
      expect(yield* service.reply(command)).toEqual(receipt)

      const database = yield* Database.Service
      expect(yield* database.db.select().from(PermissionTable).all()).toMatchObject([
        { action: "read", resource: "src/*" },
      ])
    }),
  )

  it.effect("evaluates against an explicit provider-turn agent", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.permissions.push({ action: "read", resource: "*", effect: "deny" })
        }),
      )
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion({ id: PermissionV2.ID.create("per_default") }))).toMatchObject({
        effect: "allow",
      })
      expect(
        yield* service.ask(
          assertion({ id: PermissionV2.ID.create("per_reviewer_deny"), agent: AgentV2.ID.make("reviewer") }),
        ),
      ).toMatchObject({ effect: "deny" })
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.permissions = []
        }),
      )
      expect(
        yield* service.ask(
          assertion({ id: PermissionV2.ID.create("per_reviewer_pending"), agent: AgentV2.ID.make("reviewer") }),
        ),
      ).toMatchObject({ status: "pending" })
      expect(yield* service.get(PermissionV2.ID.create("per_reviewer_pending"))).toMatchObject({
        subject: { kind: "agent", id: AgentV2.ID.make("reviewer") },
        action: "read",
        resources: ["src/index.ts"],
        scope: { kind: "session", sessionID: SessionV2.ID.make("ses_test") },
        expiresAt: null,
      })
    }),
  )

  it.effect("allows and denies from explicit rules without asking", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      yield* service.assert(assertion({ id: PermissionV2.ID.create("per_allow") }))
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      const blocked = yield* service.assert(assertion({ id: PermissionV2.ID.create("per_deny") })).pipe(Effect.flip)
      expect(blocked).toBeInstanceOf(PermissionV2.BlockedError)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("allows managed output reads without granting external directory access", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
      ])
      const service = yield* PermissionV2.Service

      expect(
        yield* service.ask(assertion({ id: PermissionV2.ID.create("per_output"), resources: ["tool_123"] })),
      ).toMatchObject({ effect: "allow" })
      expect(
        yield* service.ask(
          assertion({
            id: PermissionV2.ID.create("per_external"),
            action: "external_directory",
            resources: ["/tmp/tool-output/*"],
          }),
        ),
      ).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("uses build permissions when the Session agent is omitted", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.permissions = [{ action: "todowrite", resource: "*", effect: "allow" }]
        }),
      )

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion({ action: "todowrite", resources: ["*"] }))).toEqual({
        status: "evaluated",
        id: PermissionV2.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("denies omitted-agent permissions when no primary default agent exists", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) => {
        editor.remove(AgentV2.ID.make("test"))
        editor.remove(AgentV2.ID.make("build"))
      })

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion())).toEqual({
        status: "evaluated",
        id: PermissionV2.ID.create("per_test"),
        effect: "deny",
      })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("evaluates bash with the normal configured-rule semantics", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      const bash = assertion({ id: PermissionV2.ID.create("per_bash_allow"), action: "bash", resources: ["pwd"] })
      expect(yield* service.ask(bash)).toEqual({
        status: "evaluated",
        id: PermissionV2.ID.create("per_bash_allow"),
        effect: "allow",
      })

      yield* setRules([])
      const pending = assertion({ id: PermissionV2.ID.create("per_bash_pending"), action: "bash", resources: ["pwd"] })
      expect(yield* service.ask(pending)).toMatchObject({ status: "pending", request: { id: pending.id } })
      expect(yield* service.get(pending.id)).toBeDefined()
    }),
  )

  it.effect("uses saved bash approvals while preserving configured deny precedence", () =>
    Effect.gen(function* () {
      yield* setup()
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: "bash", resources: ["pwd"] })

      const service = yield* PermissionV2.Service
      expect(
        yield* service.ask(assertion({ id: PermissionV2.ID.create("per_saved"), action: "bash", resources: ["pwd"] })),
      ).toEqual({
        status: "evaluated",
        id: PermissionV2.ID.create("per_saved"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])

      yield* setRules([{ action: "bash", resource: "*", effect: "deny" }])
      expect(
        yield* service.ask(
          assertion({ id: PermissionV2.ID.create("per_configured_deny"), action: "bash", resources: ["pwd"] }),
        ),
      ).toEqual({
        status: "evaluated",
        id: PermissionV2.ID.create("per_configured_deny"),
        effect: "deny",
      })
    }),
  )

  it.effect("resolves an asked permission once", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      expect(yield* service.list()).toEqual([request])
      expect(yield* service.forSession(request.sessionID)).toEqual([request])
      expect(yield* service.forSession(SessionV2.ID.make("ses_other"))).toEqual([])
      expect(yield* service.get(request.id)).toEqual(request)
      yield* service.reply(decision(request, "once"))
      yield* Fiber.join(fiber)
      expect(yield* service.list()).toEqual([])
      expect(yield* service.get(request.id)).toBeUndefined()
    }),
  )

  it.effect("returns the original receipt for an exact reply retry without repeating side effects", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest(assertion({ save: ["src/*"] }))
      const events = yield* EventV2.Service
      const replied: PermissionV2.DecisionReceipt[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === PermissionV2.Event.Replied.type) replied.push(event.data as PermissionV2.DecisionReceipt)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const input = decision(request, "always", PermissionV2.DecisionID.create("pdec_exact"))

      const first = yield* service.reply(input)
      const retry = yield* service.reply(input)
      yield* Fiber.join(fiber)

      expect(retry).toEqual(first)
      expect(replied).toEqual([first])
      const { db } = yield* Database.Service
      expect(yield* db.select().from(PermissionDecisionTable).all()).toHaveLength(1)
      expect(yield* db.select().from(PermissionTable).all()).toHaveLength(1)
    }),
  )

  it.effect("conflicts on request or decision retries that change immutable facts", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()

      expect(yield* service.ask(assertion())).toEqual({ status: "pending", request })
      const requestConflict = yield* service.ask(assertion({ resources: ["src/other.ts"] })).pipe(Effect.flip)
      expect(requestConflict).toEqual(new PermissionV2.ConflictError({ requestID: request.id }))

      const decisionID = PermissionV2.DecisionID.create("pdec_conflict")
      const receipt = yield* service.reply(decision(request, "once", decisionID))
      const decisionConflict = yield* service.reply(decision(request, "reject", decisionID)).pipe(Effect.flip)
      expect(decisionConflict).toEqual(new PermissionV2.ConflictError({ requestID: request.id, decisionID }))
      expect(yield* service.reply(decision(request, "once", decisionID))).toEqual(receipt)
      yield* Fiber.join(fiber)
    }),
  )

  it.effect("rejects only the target request", () =>
    Effect.gen(function* () {
      yield* setup()
      const first = yield* waitForRequest(assertion({ id: PermissionV2.ID.create("per_first") }))
      const second = yield* waitForRequest(assertion({ id: PermissionV2.ID.create("per_second") }))

      yield* first.service.reply(decision(first.request, "reject"))
      expect(yield* first.service.list()).toEqual([second.request])
      expect((yield* Fiber.await(first.fiber))._tag).toBe("Failure")

      yield* second.service.reply(decision(second.request, "once"))
      yield* Fiber.join(second.fiber)
      expect(yield* first.service.list()).toEqual([])
    }),
  )

  it.effect("limits always batching to newly allowed pending requests in the same location", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .insert(SessionTable)
        .values({
          id: SessionV2.ID.make("ses_other"),
          project_id: Project.ID.global,
          slug: "other",
          directory: "/project",
          title: "other",
          version: "test",
          agent: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const source = yield* waitForRequest(
        assertion({ id: PermissionV2.ID.create("per_source"), resources: ["src/a.ts"], save: ["src/*"] }),
      )
      const eligible = yield* waitForRequest(
        assertion({
          id: PermissionV2.ID.create("per_eligible"),
          sessionID: SessionV2.ID.make("ses_other"),
          resources: ["src/b.ts"],
        }),
      )
      const unrelated = yield* waitForRequest(
        assertion({
          id: PermissionV2.ID.create("per_unrelated"),
          sessionID: SessionV2.ID.make("ses_other"),
          action: "bash",
          resources: ["pwd"],
        }),
      )

      const receipt = yield* source.service.reply(decision(source.request, "always"))
      yield* Fiber.join(source.fiber)
      yield* Fiber.join(eligible.fiber)

      expect(receipt.resolvedRequestIDs).toEqual([source.request.id, eligible.request.id])
      expect(yield* source.service.list()).toEqual([unrelated.request])
      expect(
        yield* source.service.ask(
          assertion({
            id: eligible.request.id,
            sessionID: eligible.request.sessionID,
            resources: ["src/b.ts"],
          }),
        ),
      ).toMatchObject({ status: "decided", receipt: { requestID: eligible.request.id, decision: "always" } })
      expect(yield* db.select().from(PermissionDecisionTable).all()).toHaveLength(2)

      yield* unrelated.service.reply(decision(unrelated.request, "reject"))
      yield* Fiber.await(unrelated.fiber)
    }),
  )

  it.effect("recovers committed decisions after the permission service restarts", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      const committed = yield* service.reply(decision(request, "once", PermissionV2.DecisionID.create("pdec_restart")))
      yield* Fiber.join(fiber)

      const restarted = yield* restartPermission()

      expect(yield* restarted.ask(assertion())).toEqual({ status: "decided", receipt: committed })
      yield* restarted.assert(assertion())
      expect(yield* restarted.list()).toEqual([])
    }),
  )

  it.effect("rehydrates a pending request from its prototype-free admission snapshot", () =>
    Effect.gen(function* () {
      yield* setup()
      const input = assertion({ id: PermissionV2.ID.create("per_pending_restart"), metadata: { origin: "tool" } })
      const original = yield* (yield* PermissionV2.Service).ask(input)
      expect(original.status).toBe("pending")
      if (original.status !== "pending") return

      const restarted = yield* restartPermission()
      expect(yield* restarted.ask(input)).toEqual(original)
      yield* restarted.reply(decision(original.request, "once"))
    }),
  )

  it.effect("rolls back a receipt when an always grant cannot commit", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest(assertion({ save: ["src/*"] }))
      const { db } = yield* Database.Service
      yield* db.run(`
        CREATE TRIGGER permission_insert_failure
        BEFORE INSERT ON permission
        BEGIN
          SELECT RAISE(ABORT, 'permission insert failed');
        END
      `)
      const input = decision(request, "always", PermissionV2.DecisionID.create("pdec_atomic"))

      expect((yield* service.reply(input).pipe(Effect.exit))._tag).toBe("Failure")
      expect(yield* db.select().from(PermissionDecisionTable).all()).toEqual([])
      expect(yield* db.select().from(PermissionTable).all()).toEqual([])
      expect(yield* service.get(request.id)).toEqual(request)

      yield* db.run("DROP TRIGGER permission_insert_failure")
      yield* service.reply(input)
      yield* Fiber.join(fiber)
      expect(yield* db.select().from(PermissionDecisionTable).all()).toHaveLength(1)
      expect(yield* db.select().from(PermissionTable).all()).toHaveLength(1)
    }),
  )

  it.effect("defects when an asked permission is declined", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      yield* service.reply(decision(request, "reject"))
      const exit = yield* Fiber.await(fiber)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure")
        expect(
          exit.cause.reasons.some(
            (reason) => Cause.isDieReason(reason) && reason.defect instanceof PermissionV2.DeclinedError,
          ),
        ).toBe(true)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("stores and removes saved resources for a project", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      const asked = yield* Deferred.make<PermissionV2.Request>()
      const events = yield* EventV2.Service
      const unsubscribe = yield* events.listen((event) =>
        event.type === PermissionV2.Event.Asked.type
          ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* service.assert(assertion({ save: ["src/*"] })).pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      yield* service.reply(decision(request, "always"))
      yield* Fiber.join(fiber)

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(PermissionTable).where(eq(PermissionTable.project_id, Project.ID.global)).all(),
      ).toMatchObject([{ action: "read", resource: "src/*" }])
      const saved = yield* PermissionSaved.Service
      const id = (yield* saved.list())[0]!.id
      expect(yield* saved.list()).toEqual([{ id, projectID: Project.ID.global, action: "read", resource: "src/*" }])
      yield* service.assert(assertion({ id: PermissionV2.ID.create("per_next"), resources: ["src/next.ts"] }))
      yield* saved.remove(id)
      expect(yield* saved.list()).toEqual([])
    }),
  )
})
