import { describe, expect, test } from "bun:test"
import { parseRoute } from "../../../shared/route-manifest"
import { sameSessionIdentity, sessionLiveSnapshotOf } from "./session-workspace-core"

describe("REQ-125 C1a typed live session context", () => {
  test("v2 target route plus typed sync record resolves the real server/directory/session triple", () => {
    expect(
      sessionLiveSnapshotOf({
        route: parseRoute("/server/c2lkZWNhcg/session/ses_0123456789abcdef"),
        providerServerKey: "sidecar",
        session: {
          id: "ses_0123456789abcdef",
          directory: "/Users/tide/app/alpha-work",
          title: "整理架构说明",
        },
        status: { type: "idle" },
      }),
    ).toEqual({
      identity: {
        serverKey: "sidecar",
        directory: "/Users/tide/app/alpha-work",
        sessionID: "ses_0123456789abcdef",
      },
      project: "alpha-work",
      title: "整理架构说明",
      activity: "idle",
    })
  })

  test("legacy route remains readable while the canonical route is v2", () => {
    expect(
      sessionLiveSnapshotOf({
        route: parseRoute("/L3RtcC9wcm9q/session/ses_1"),
        providerServerKey: "sidecar",
        status: { type: "busy" },
      }),
    ).toMatchObject({
      identity: { serverKey: "sidecar", directory: "/tmp/proj", sessionID: "ses_1" },
      project: "proj",
      title: "ses_1",
      activity: "running",
    })
  })

  test("status projection has exactly idle and running UI states", () => {
    const route = parseRoute("/server/c2lkZWNhcg/session/ses_1")
    const session = { id: "ses_1", directory: "/tmp/proj", title: "Session" }
    expect(sessionLiveSnapshotOf({ route, providerServerKey: "sidecar", session })?.activity).toBe("idle")
    expect(
      sessionLiveSnapshotOf({ route, providerServerKey: "sidecar", session, status: { type: "retry" } })?.activity,
    ).toBe("running")
    expect(
      sessionLiveSnapshotOf({ route, providerServerKey: "sidecar", session, status: { type: "busy" } })?.activity,
    ).toBe("running")
  })
})

describe("REQ-125 C1a I8 session switch isolation", () => {
  const active = {
    serverKey: "sidecar",
    directory: "/tmp/next",
    sessionID: "ses_next",
  }

  test("all three identity fields must match before an async result is accepted", () => {
    expect(sameSessionIdentity(active, { ...active })).toBe(true)
    expect(sameSessionIdentity(active, { ...active, serverKey: "remote" })).toBe(false)
    expect(sameSessionIdentity(active, { ...active, directory: "/tmp/previous" })).toBe(false)
    expect(sameSessionIdentity(active, { ...active, sessionID: "ses_previous" })).toBe(false)
    expect(sameSessionIdentity(active, undefined)).toBe(false)
  })

  test("late records from the previous route/provider cannot populate the next session", () => {
    const nextRoute = parseRoute("/server/c2lkZWNhcg/session/ses_next")
    expect(
      sessionLiveSnapshotOf({
        route: nextRoute,
        providerServerKey: "sidecar",
        session: { id: "ses_previous", directory: "/tmp/previous", title: "Previous" },
      }),
    ).toBeUndefined()
    expect(
      sessionLiveSnapshotOf({
        route: nextRoute,
        providerServerKey: "remote",
        session: { id: "ses_next", directory: "/tmp/next", title: "Next" },
      }),
    ).toBeUndefined()
    expect(sessionLiveSnapshotOf({ route: nextRoute, providerServerKey: "sidecar" })).toBeUndefined()
  })
})
