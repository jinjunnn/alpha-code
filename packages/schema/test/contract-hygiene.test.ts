import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Agent } from "../src/agent"
import { FileSystem } from "../src/filesystem"
import { Model } from "../src/model"
import { Permission } from "../src/permission"
import { Project } from "../src/project"
import { Pty } from "../src/pty"
import { Question } from "../src/question"
import { Session } from "../src/session"
import { SessionEvent } from "../src/session-event"
import { SessionTodo } from "../src/session-todo"
import { optional } from "../src/schema"

describe("contract hygiene", () => {
  test("optional properties preserve transformations and omit undefined while encoding", () => {
    const Value = Schema.Struct({ value: optional(Schema.FiniteFromString) })
    expect(Schema.decodeUnknownSync(Value)({ value: "1" })).toEqual({ value: 1 })
    expect(Schema.encodeSync(Value)({ value: 1 })).toEqual({ value: "1" })
    expect(Schema.encodeSync(Value)({ value: undefined })).toEqual({})
  })

  test("todo status and priority preserve arbitrary strings", () => {
    const decode = Schema.decodeUnknownSync(SessionTodo.Info)
    expect(decode({ content: "ship", status: "waiting", priority: "urgent" })).toEqual({
      content: "ship",
      status: "waiting",
      priority: "urgent",
    })
  })

  test("permission metadata accepts only JSON values", () => {
    const decode = Schema.decodeUnknownSync(Permission.Request.fields.metadata)
    expect(decode({ nested: ["value", 1, true, null] })).toEqual({ nested: ["value", 1, true, null] })
    expect(() => decode({ bigint: 1n })).toThrow()
    expect(() => decode({ missing: undefined })).toThrow()
    expect(() => decode({ callback: () => "value" })).toThrow()
  })

  test("permission decision commands discriminate persistent grant fields", () => {
    const decode = Schema.decodeUnknownSync(Permission.DecisionCommand)
    const fields = {
      requestFingerprint: Schema.decodeUnknownSync(Permission.Fingerprint)("a".repeat(64)),
      decisionID: Permission.DecisionID.create("pdec_test"),
    }

    expect(decode({ ...fields, decision: "once" })).toEqual({ ...fields, decision: "once" })
    expect(decode({ ...fields, decision: "reject", message: "no" })).toEqual({
      ...fields,
      decision: "reject",
      message: "no",
    })
    expect(
      decode({
        ...fields,
        decision: "always",
        grantScope: { kind: "project", projectID: Project.ID.global },
        grantExpiresAt: null,
      }),
    ).toEqual({
      ...fields,
      decision: "always",
      grantScope: { kind: "project", projectID: Project.ID.global },
      grantExpiresAt: null,
    })
    expect(() => decode({ ...fields, decision: "always" })).toThrow()
    expect(() =>
      decode({
        ...fields,
        decision: "always",
        grantScope: { kind: "project", projectID: Project.ID.global },
        grantExpiresAt: 1,
      }),
    ).toThrow()
    expect(() =>
      decode({
        ...fields,
        decision: "once",
        grantScope: { kind: "project", projectID: Project.ID.global },
      }),
    ).toThrow()
    expect(() => decode({ ...fields, decision: "reject", grantExpiresAt: null })).toThrow()
  })

  test("current ID constructors expose create", () => {
    expect(Question.ID.create()).toStartWith("que_")
    expect(Pty.ID.create()).toStartWith("pty_")
  })

  test("reusable public identifiers are stable and unique", () => {
    const identifiers = [
      Agent.Color,
      FileSystem.Submatch,
      Model.Ref,
      Model.Capabilities,
      Model.Cost,
      Model.Api,
      Project.Icon,
      Project.Commands,
      Project.Time,
      Project.Info,
      Pty.Info,
      Session.ListAnchor,
    ].map((schema) => schema.ast.annotations?.identifier)

    expect(identifiers.every((identifier) => typeof identifier === "string")).toBe(true)
    expect(new Set(identifiers).size).toBe(identifiers.length)
  })

  test("current source avoids Any and mutable contract wrappers", async () => {
    const files = [...new Bun.Glob("*.ts").scanSync(new URL("../src", import.meta.url).pathname)].filter(
      (file) => !file.endsWith("-v1.ts"),
    )
    const source = await Promise.all(
      files.map((file) => Bun.file(new URL(`../src/${file}`, import.meta.url)).text()),
    ).then((values) => values.join("\n"))

    expect(source).not.toContain("Schema.Any")
    expect(source).not.toContain("Schema.mutable")
  })
})
