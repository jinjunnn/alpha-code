import { describe, expect } from "bun:test"
import { Cause, Context, Deferred, Effect, Fiber, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { PermissionDecisionTable, PermissionTable } from "@opencode-ai/core/permission/sql"
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

describe("PermissionV2", () => {
  it.effect("returns the evaluated effect and only queues prompts", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion())).toEqual({
        status: "evaluated",
        id: PermissionV2.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion())).toEqual({
        status: "evaluated",
        id: PermissionV2.ID.create("per_test"),
        effect: "deny",
      })
      expect(yield* service.list()).toEqual([])
      yield* setRules([])
      expect(yield* service.ask(assertion())).toMatchObject({
        status: "pending",
        request: { id: PermissionV2.ID.create("per_test") },
      })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).toBeDefined()
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

      expect(yield* service.ask(assertion())).toMatchObject({ effect: "allow" })
      expect(yield* service.ask(assertion({ agent: AgentV2.ID.make("reviewer") }))).toMatchObject({ effect: "deny" })
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.permissions = []
        }),
      )
      expect(yield* service.ask(assertion({ agent: AgentV2.ID.make("reviewer") }))).toMatchObject({
        status: "pending",
      })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).toMatchObject({
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
      yield* service.assert(assertion())
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      const blocked = yield* service.assert(assertion()).pipe(Effect.flip)
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

      expect(yield* service.ask(assertion({ resources: ["tool_123"] }))).toMatchObject({ effect: "allow" })
      expect(
        yield* service.ask(assertion({ action: "external_directory", resources: ["/tmp/tool-output/*"] })),
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
      const bash = assertion({ action: "bash", resources: ["pwd"] })
      expect(yield* service.ask(bash)).toEqual({
        status: "evaluated",
        id: PermissionV2.ID.create("per_test"),
        effect: "allow",
      })

      yield* setRules([])
      expect(yield* service.ask(bash)).toMatchObject({ status: "pending", request: { id: bash.id } })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("uses saved bash approvals while preserving configured deny precedence", () =>
    Effect.gen(function* () {
      yield* setup()
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: "bash", resources: ["pwd"] })

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        status: "evaluated",
        id: PermissionV2.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])

      yield* setRules([{ action: "bash", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        status: "evaluated",
        id: PermissionV2.ID.create("per_test"),
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
      const scopeConflict = yield* service
        .reply({
          ...decision(request, "once", decisionID),
          command: {
            ...decision(request, "once", decisionID).command,
            grantScope: { kind: "project", projectID: Project.ID.global },
          },
        })
        .pipe(Effect.flip)
      expect(scopeConflict).toEqual(new PermissionV2.ConflictError({ requestID: request.id, decisionID }))
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
      const restarted = Context.get(yield* Layer.build(restartedLayer), PermissionV2.Service)

      expect(yield* restarted.ask(assertion())).toEqual({ status: "decided", receipt: committed })
      yield* restarted.assert(assertion())
      expect(yield* restarted.list()).toEqual([])
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
