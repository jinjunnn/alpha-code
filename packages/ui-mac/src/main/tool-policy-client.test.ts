// REQ-131 / #1130 —— main 侧 tool policy 客户端:每个引擎状态码都映射到一个**闭集**结果码,
// 且 inventory 在 main 侧再 decode 一次(形状漂移 ⇒ invalid-shape,不把解释不了的对象交给 renderer)。
import { describe, expect, test } from "bun:test"
import { createToolPolicyClient, TOOL_POLICY_ROUTES } from "./tool-policy-client"

const server = { url: "http://127.0.0.1:39117", username: "opencode", password: "route-password" }
const directory = "/Users/kai/app/kama bot"

type Seen = { url: URL; method: string; headers: Record<string, string>; body: string | undefined }

function fetchFor(handler: (seen: Seen) => Response | Promise<Response>, seen: Seen[] = []) {
  const impl = async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url)
    const record: Seen = {
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})),
      body: typeof init?.body === "string" ? init.body : undefined,
    }
    seen.push(record)
    return handler(record)
  }
  return { fetch: impl as unknown as typeof fetch, seen }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const inventoryBody = {
  version: 1,
  partition: { account: "anonymous", workspace: "prj_1" },
  user: { status: "absent" },
  managed: { status: "ok" },
  classRecords: [],
  services: [
    {
      source: "builtin",
      origin: "",
      class: "builtin",
      authority: { kind: "not-asserted" },
      tools: [
        {
          canonical: "builtin::write",
          identity: { source: "builtin", origin: "", name: "write" },
          technicalId: "write",
          authority: { kind: "not-asserted" },
          effective: { state: "enabled", action: "allow", reason: { kind: "default", class: "builtin" } },
          newlyDiscovered: false,
        },
      ],
    },
  ],
  invalid: { count: 0, entries: [] },
}

describe("tool policy client (main)", () => {
  test("inventory: sends Basic auth + encoded directory to the inventory route and decodes the wire shape", async () => {
    const { fetch, seen } = fetchFor(() => json(200, { data: inventoryBody }))
    const client = createToolPolicyClient({ awaitServer: async () => server, fetch })
    const result = await client.inventory({ directory })
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) throw new Error("expected ok")
    expect(result.inventory.services[0]!.tools[0]!.canonical).toBe("builtin::write")
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url.pathname).toBe(TOOL_POLICY_ROUTES.inventory)
    expect(seen[0]!.method).toBe("GET")
    expect(seen[0]!.headers.Authorization).toBe(`Basic ${Buffer.from("opencode:route-password").toString("base64")}`)
    expect(seen[0]!.headers["x-opencode-directory"]).toBe(encodeURIComponent(directory))
  })

  test("inventory: a 200 whose body drifts from the wire contract is invalid-shape, not a partial list", async () => {
    const drifted = { ...inventoryBody, services: [{ ...inventoryBody.services[0], tools: [{ canonical: 1 }] }] }
    const { fetch } = fetchFor(() => json(200, { data: drifted }))
    const client = createToolPolicyClient({ awaitServer: async () => server, fetch })
    expect(await client.inventory({ directory })).toEqual({ ok: false, code: "invalid-shape" })
  })

  test("inventory: 503 is not-wired, other non-200 is request-failed, engine not ready is engine-unavailable", async () => {
    const notWired = createToolPolicyClient({
      awaitServer: async () => server,
      fetch: fetchFor(() => json(503, { _tag: "ServiceUnavailableError" })).fetch,
    })
    expect(await notWired.inventory({ directory })).toEqual({ ok: false, code: "not-wired" })

    const failed = createToolPolicyClient({
      awaitServer: async () => server,
      fetch: fetchFor(() => new Response("nope", { status: 401 })).fetch,
    })
    expect(await failed.inventory({ directory })).toEqual({ ok: false, code: "request-failed" })

    const down = createToolPolicyClient({
      awaitServer: () => Promise.reject(new Error("no engine")),
      fetch: fetchFor(() => json(200, { data: inventoryBody })).fetch,
    })
    expect(await down.inventory({ directory })).toEqual({ ok: false, code: "engine-unavailable" })
  })

  test("setRecord: PUTs the record verbatim; 204 ok, 409 quarantined, 400 invalid-record, 500 write-failed", async () => {
    const record = { selector: { level: "class", class: "plugin" }, state: "ask" } as const
    const statuses: number[] = []
    const { fetch, seen } = fetchFor(() => new Response(null, { status: statuses.shift() ?? 204 }))
    const client = createToolPolicyClient({ awaitServer: async () => server, fetch })

    statuses.push(204)
    expect(await client.setRecord({ directory, record })).toEqual({ ok: true })
    expect(seen[0]!.method).toBe("PUT")
    expect(seen[0]!.url.pathname).toBe(TOOL_POLICY_ROUTES.record)
    expect(JSON.parse(seen[0]!.body!)).toEqual(record)
    expect(seen[0]!.headers["content-type"]).toBe("application/json")

    statuses.push(409)
    expect(await client.setRecord({ directory, record })).toEqual({ ok: false, code: "quarantined" })
    statuses.push(400)
    expect(await client.setRecord({ directory, record })).toEqual({ ok: false, code: "invalid-record" })
    statuses.push(500)
    expect(await client.setRecord({ directory, record })).toEqual({ ok: false, code: "write-failed" })
  })

  test("removeRecord: POSTs { selector } to the remove route", async () => {
    const selector = { level: "tool", canonical: "builtin::write" } as const
    const { fetch, seen } = fetchFor(() => new Response(null, { status: 204 }))
    const client = createToolPolicyClient({ awaitServer: async () => server, fetch })
    expect(await client.removeRecord({ directory, selector })).toEqual({ ok: true })
    expect(seen[0]!.method).toBe("POST")
    expect(seen[0]!.url.pathname).toBe(TOOL_POLICY_ROUTES.recordRemove)
    expect(JSON.parse(seen[0]!.body!)).toEqual({ selector })
  })

  test("reset: returns the backup path the engine reports; 503 not-wired", async () => {
    const { fetch, seen } = fetchFor(() => json(200, { data: { backup: "/x/policy.json.quarantined-1" } }))
    const client = createToolPolicyClient({ awaitServer: async () => server, fetch })
    expect(await client.reset({ directory })).toEqual({ ok: true, backup: "/x/policy.json.quarantined-1" })
    expect(seen[0]!.method).toBe("POST")
    expect(seen[0]!.url.pathname).toBe(TOOL_POLICY_ROUTES.reset)

    const notWired = createToolPolicyClient({
      awaitServer: async () => server,
      fetch: fetchFor(() => json(503, {})).fetch,
    })
    expect(await notWired.reset({ directory })).toEqual({ ok: false, code: "not-wired" })
  })

  test("every method refuses an empty directory before touching the engine (partition needs an instance)", async () => {
    const { fetch, seen } = fetchFor(() => json(200, { data: inventoryBody }))
    const client = createToolPolicyClient({ awaitServer: async () => server, fetch })
    expect(await client.inventory({ directory: "" })).toEqual({ ok: false, code: "request-failed" })
    expect(await client.reset({ directory: "   " })).toEqual({ ok: false, code: "request-failed" })
    expect(seen).toHaveLength(0)
  })
})
