import { describe, expect, test } from "bun:test"
import { ServerConnection } from "@/context/server"
import { legacySessionHref, legacySessionServer, requireServerKey, rootSession, sessionHref } from "./session-route"

describe("session routes", () => {
  test("uses the unique persisted server for a legacy session route", () => {
    expect(
      legacySessionServer(
        [{ type: "session", server: ServerConnection.Key.make("server-b"), sessionId: "session-1" }],
        "session-1",
        ServerConnection.Key.make("server-a"),
      ),
    ).toBe(ServerConnection.Key.make("server-b"))
  })

  test("prefers the active server when a legacy session ID is ambiguous", () => {
    expect(
      legacySessionServer(
        [
          { type: "session", server: ServerConnection.Key.make("server-a"), sessionId: "session-1" },
          { type: "session", server: ServerConnection.Key.make("server-b"), sessionId: "session-1" },
        ],
        "session-1",
        ServerConnection.Key.make("server-b"),
      ),
    ).toBe(ServerConnection.Key.make("server-b"))
  })

  // #933:咽喉对推不出唯一身份的 legacy 形状默认拒绝 —— 旧版在这两种形状下回落 active,
  // 正是「落到没有该会话的机器、污染同 id 无关会话」的来源。两个用例的 active 各不相同,
  // 写死任何单值的实现无法同时满足。
  test("rejects a legacy session ID no persisted tab knows (no active-server guess)", () => {
    expect(
      legacySessionServer(
        [{ type: "session", server: ServerConnection.Key.make("wsl:fedora"), sessionId: "session-other" }],
        "session-unknown",
        ServerConnection.Key.make("wsl:fedora"),
      ),
    ).toBeUndefined()
  })

  test("rejects an ambiguous legacy session ID when the active server holds no copy", () => {
    expect(
      legacySessionServer(
        [
          { type: "session", server: ServerConnection.Key.make("server-a"), sessionId: "session-1" },
          { type: "session", server: ServerConnection.Key.make("server-b"), sessionId: "session-1" },
        ],
        "session-1",
        ServerConnection.Key.make("server-c"),
      ),
    ).toBeUndefined()
  })

  test("builds and decodes a server-keyed session route", () => {
    const server = ServerConnection.Key.make("https://example.com:4096")
    const href = sessionHref(server, "session-1")

    expect(href).toBe("/server/aHR0cHM6Ly9leGFtcGxlLmNvbTo0MDk2/session/session-1")
    expect(requireServerKey(href.split("/")[2])).toBe(server)
  })

  test("rejects malformed server keys", () => {
    expect(() => requireServerKey("not-base64")).toThrow("Invalid server route")
  })

  test("builds the legacy directory-keyed route", () => {
    expect(legacySessionHref("/Users/example/project", "session-1")).toBe(
      "/L1VzZXJzL2V4YW1wbGUvcHJvamVjdA/session/session-1",
    )
  })

  test("resolves the root session", async () => {
    const sessions: Record<string, { id: string; parentID?: string }> = {
      child: { id: "child", parentID: "parent" },
      parent: { id: "parent", parentID: "root" },
      root: { id: "root" },
    }

    expect(
      await rootSession(sessions.child, async (id) => {
        const session = sessions[id]
        if (!session) throw new Error(`Missing session: ${id}`)
        return session
      }),
    ).toBe(sessions.root)
  })

  test("rejects a parent cycle", async () => {
    const sessions: Record<string, { id: string; parentID?: string }> = {
      child: { id: "child", parentID: "parent" },
      parent: { id: "parent", parentID: "child" },
    }

    expect(rootSession(sessions.child, async (id) => sessions[id]!)).rejects.toThrow("Session parent cycle: child")
  })
})
