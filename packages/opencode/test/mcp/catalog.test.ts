import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { McpCatalog } from "@/mcp/catalog"
import { Effect } from "effect"

const options = { toolCallId: "call_mcp", abortSignal: new AbortController().signal } as any

function clientReturning(result: unknown) {
  return {
    callTool: async () => result,
  } as unknown as Client
}

function mcpTool(name = "screenshot") {
  return {
    name,
    description: "Take a screenshot",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  } as any
}

describe("McpCatalog.convertTool", () => {
  test("preserves content when structuredContent is also present", async () => {
    const content = [{ type: "image" as const, mimeType: "image/png", data: "AAAA" }]
    const structuredContent = { image: { mimeType: "image/png", data: "AAAA" } }
    const converted = McpCatalog.convertTool(mcpTool(), clientReturning({ content, structuredContent }))

    const output = await converted.execute?.({}, options)

    expect(output).toMatchObject({ content, structuredContent })
  })

  test("falls back to structuredContent only when content is absent", async () => {
    const structuredContent = { results: [{ title: "one" }] }
    const converted = McpCatalog.convertTool(mcpTool(), clientReturning({ content: [], structuredContent }))

    const output = await converted.execute?.({}, options)

    expect(output).toMatchObject({
      structuredContent,
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    })
  })

  test("surfaces a discernible cloud web search failure", async () => {
    const converted = McpCatalog.convertTool(
      mcpTool("cloud_web_search"),
      clientReturning({
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: { code: "scope_forbidden", message: "tenant lacks models scope" } }),
          },
        ],
      }),
    )

    await expect(converted.execute?.({}, options)).rejects.toThrow(
      'cloud_web_search failed: scope forbidden. Cause: {"error":{"code":"scope_forbidden","message":"tenant lacks models scope"}}',
    )
  })

  test("keeps an unexpected cloud web search decline loud", async () => {
    const converted = McpCatalog.convertTool(
      mcpTool("cloud_web_search"),
      clientReturning({ isError: true, content: [{ type: "text", text: '{"error":{"code":"declined"}}' }] }),
    )

    await expect(converted.execute?.({}, options)).rejects.toThrow(
      'cloud_web_search failed: unexpected cloud failure. Cause: {"error":{"code":"declined"}}',
    )
  })

  test("keeps cloud web search failure categories distinct", async () => {
    const outcomes = [
      [{ error: { message: "unauthorized" } }, "unauthorized"],
      [{ error: { code: "scope_forbidden", message: "forbidden" } }, "scope forbidden"],
      [{ error: { message: "query is required" } }, "bad request"],
      [{ error: { message: "upstream unavailable" } }, "upstream failure"],
      [{ error: { code: "declined" } }, "unexpected cloud failure"],
    ] as const

    const failures = await Promise.all(
      outcomes.map(async ([body]) => {
        const converted = McpCatalog.convertTool(
          mcpTool("cloud_web_search"),
          clientReturning({ isError: true, content: [{ type: "text", text: JSON.stringify(body) }] }),
        )
        return converted.execute?.({}, options).catch((error: unknown) => String(error))
      }),
    )

    for (const [index, [, category]] of outcomes.entries()) expect(failures[index]).toContain(category)
    expect(new Set(failures).size).toBe(outcomes.length)
  })
})

test("preserves output schema validation across paginated tool discovery", async () => {
  const server = new Server({ name: "pagination", version: "1.0.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, ({ params }) =>
    Promise.resolve(
      params?.cursor === "page-2"
        ? {
            tools: [
              {
                name: "second",
                inputSchema: { type: "object" },
                outputSchema: {
                  type: "object",
                  properties: { value: { type: "number" } },
                  required: ["value"],
                },
              },
            ],
          }
        : {
            tools: [
              {
                name: "first",
                inputSchema: { type: "object" },
                outputSchema: {
                  type: "object",
                  properties: { value: { type: "string" } },
                  required: ["value"],
                },
              },
            ],
            nextCursor: "page-2",
          },
    ),
  )
  server.setRequestHandler(CallToolRequestSchema, ({ params }) =>
    Promise.resolve({
      content: [],
      structuredContent: { value: params.name === "first" ? 42 : 1 },
    }),
  )

  const client = new Client({ name: "pagination-test", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

  try {
    const tools = await Effect.runPromise(McpCatalog.defs(client))
    expect(tools?.map((tool) => tool.name)).toEqual(["first", "second"])
    await expect(client.callTool({ name: "first", arguments: {} })).rejects.toThrow(
      "Structured content does not match the tool's output schema",
    )
  } finally {
    await Promise.all([client.close(), server.close()])
  }
})
