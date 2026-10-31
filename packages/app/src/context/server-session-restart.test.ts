// alpha #1588 — `sync(id, { restart: true })`: a pending message load has no deadline, so a hung
// request would otherwise be joined forever. Restart must issue a new request, and the abandoned one
// must not write into the store if it ever lands.
import { describe, expect, test } from "bun:test"
import type { Message, OpencodeClient, Part, Session } from "@opencode-ai/sdk/v2/client"
import { createServerSession } from "./server-session"

type MessageResponse = {
  data: { info: Message; parts: Part[] }[]
  response: { headers: Headers }
}

const info: Session = {
  id: "child",
  slug: "child",
  projectID: "project",
  directory: "/repo",
  title: "child",
  version: "1",
  time: { created: 1, updated: 1 },
}

const user = (id: string): Message => ({
  id,
  sessionID: "child",
  role: "user",
  time: { created: 1 },
  agent: "build",
  model: { providerID: "provider", modelID: "model" },
})

const response = (messages: Message[]): MessageResponse => ({
  data: messages.map((message) => ({ info: message, parts: [] })),
  response: { headers: new Headers() },
})

function client(...responses: Promise<MessageResponse>[]) {
  const requests: unknown[] = []
  const value = {
    session: {
      get: async () => ({ data: info }),
      messages: (input: unknown) => {
        requests.push(input)
        return responses[requests.length - 1]
      },
    },
  } as unknown as OpencodeClient
  return Object.assign(value, { requests })
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("server session restart (alpha #1588)", () => {
  test("restart sends a new message request instead of joining the pending one that never settles", async () => {
    const api = client(new Promise<MessageResponse>(() => {}), Promise.resolve(response([user("message-1")])))
    const store = createServerSession(api)

    void store.sync("child")
    await settle()
    expect(api.requests).toHaveLength(1)

    // Without restart the second call joins the hung request: no new request goes out.
    void store.sync("child")
    await settle()
    expect(api.requests).toHaveLength(1)

    await store.sync("child", { restart: true })
    expect(api.requests).toHaveLength(2)
    expect(store.data.message.child?.map((message) => message.id)).toEqual(["message-1"])
    expect(store.history.loading("child")).toBe(false)
  })

  test("the abandoned request does not overwrite the store when it lands after the restart", async () => {
    const late = Promise.withResolvers<MessageResponse>()
    const api = client(late.promise, Promise.resolve(response([user("message-new")])))
    const store = createServerSession(api)

    void store.sync("child")
    await settle()
    await store.sync("child", { restart: true })
    expect(store.data.message.child?.map((message) => message.id)).toEqual(["message-new"])

    late.resolve(response([user("message-stale")]))
    await settle()
    await settle()
    expect(store.data.message.child?.map((message) => message.id)).toEqual(["message-new"])
  })
})
