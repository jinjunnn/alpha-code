import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { probeProjectMcpActivation } from "./ext-mcp-activation"

let tmp: string
let project: string
const previousConfigContent = process.env.OPENCODE_CONFIG_CONTENT
const durableLeaf = { type: "local", command: ["npx", "-y", "demo-mcp@1.0.0"] }

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "project-mcp-activation-"))
  project = join(tmp, "D")
  mkdirSync(join(project, ".alpha"), { recursive: true })
  project = realpathSync(project)
  writeFileSync(
    join(project, ".alpha", "alpha.jsonc"),
    JSON.stringify({ mcp: { demo: durableLeaf } }, null, 2),
  )
  delete process.env.OPENCODE_CONFIG_CONTENT
})

afterEach(() => {
  if (previousConfigContent === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
  else process.env.OPENCODE_CONFIG_CONTENT = previousConfigContent
  rmSync(tmp, { recursive: true, force: true })
})

const ready = async () => ({
  url: "http://127.0.0.1:39117",
  username: "opencode",
  password: "route-password",
})

function fetchFor(
  handler: (url: URL) => Response,
  requests: URL[],
): typeof fetch {
  return (async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(request, init).url)
    requests.push(url)
    return handler(url)
  }) as typeof fetch
}

const emptyGlobalNames = () => ({ ok: true as const, names: [] as string[] })

describe("project MCP activation provenance probe (REQ-136 C5)", () => {
  test("returns active only after global absence + exact D leaf + D-scoped connected status", async () => {
    const requests: URL[] = []
    const verdict = await probeProjectMcpActivation("demo", project, ready, {
      configuredGlobalNames: emptyGlobalNames,
      fetch: fetchFor((url) => {
        if (url.pathname === "/global/config") return Response.json({})
        if (url.pathname === "/config") return Response.json({ mcp: { demo: durableLeaf } })
        if (url.pathname === "/mcp") return Response.json({ demo: { status: "connected" } })
        return new Response("not found", { status: 404 })
      }, requests),
    })

    expect(verdict).toBe("active")
    expect(requests.map((url) => url.pathname)).toEqual(["/global/config", "/config", "/mcp"])
    expect(requests.at(1)?.searchParams.get("directory")).toBe(project)
    expect(requests.at(2)?.searchParams.get("directory")).toBe(project)
    expect(JSON.stringify(verdict)).not.toContain("demo-mcp")
  })

  test("accepts JSONC trailing commas in both the durable project file and injected global config", async () => {
    writeFileSync(
      join(project, ".alpha", "alpha.jsonc"),
      `{
        "mcp": {
          "demo": {
            "type": "local",
            "command": ["npx", "-y", "demo-mcp@1.0.0",],
          },
        },
      }`,
    )
    process.env.OPENCODE_CONFIG_CONTENT = '{"mcp":{},}'

    const verdict = await probeProjectMcpActivation("demo", project, ready, {
      configuredGlobalNames: emptyGlobalNames,
      fetch: fetchFor((url) => {
        if (url.pathname === "/global/config") return Response.json({})
        if (url.pathname === "/config") return Response.json({ mcp: { demo: durableLeaf } })
        return Response.json({ demo: { status: "connected" } })
      }, []),
    })

    expect(verdict).toBe("active")
  })

  test("strict global same-name hit is shadowed and cannot borrow a misleading name-only status", async () => {
    let awaitCalls = 0
    const verdict = await probeProjectMcpActivation(
      "demo",
      project,
      async () => {
        awaitCalls++
        return ready()
      },
      { configuredGlobalNames: () => ({ ok: true, names: ["demo"] }) },
    )
    expect(verdict).toBe("shadowed")
    expect(awaitCalls).toBe(0)
  })

  test("engine global hit shadows even an identical leaf and skips effective/status reads", async () => {
    const requests: URL[] = []
    const verdict = await probeProjectMcpActivation("demo", project, ready, {
      configuredGlobalNames: emptyGlobalNames,
      fetch: fetchFor((url) => {
        if (url.pathname === "/global/config") return Response.json({ mcp: { demo: durableLeaf } })
        return Response.json({ demo: { status: "connected" } })
      }, requests),
    })
    expect(verdict).toBe("shadowed")
    expect(requests.map((url) => url.pathname)).toEqual(["/global/config"])
  })

  test("effective D leaf mismatch is shadowed and never consults the name-only status map", async () => {
    const requests: URL[] = []
    const verdict = await probeProjectMcpActivation("demo", project, ready, {
      configuredGlobalNames: emptyGlobalNames,
      fetch: fetchFor((url) => {
        if (url.pathname === "/global/config") return Response.json({})
        if (url.pathname === "/config")
          return Response.json({ mcp: { demo: { type: "local", command: ["npx", "other-owner"] } } })
        return Response.json({ demo: { status: "connected" } })
      }, requests),
    })
    expect(verdict).toBe("shadowed")
    expect(requests.map((url) => url.pathname)).toEqual(["/global/config", "/config"])
  })

  test("unreadable global/effective facts are unverifiable and never become connected", async () => {
    const requests: URL[] = []
    const verdict = await probeProjectMcpActivation("demo", project, ready, {
      configuredGlobalNames: emptyGlobalNames,
      fetch: fetchFor((url) =>
        url.pathname === "/global/config"
          ? Response.json({ error: "unreadable" }, { status: 500 })
          : Response.json({ demo: { status: "connected" } }), requests),
    })
    expect(verdict).toBe("unverifiable")
    expect(requests.map((url) => url.pathname)).toEqual(["/global/config"])

    writeFileSync(join(project, ".alpha", "alpha.jsonc"), '{"mcp":{"demo":')
    const malformed = await probeProjectMcpActivation("demo", project, ready, {
      configuredGlobalNames: emptyGlobalNames,
      fetch: (async () => {
        throw new Error("durable parse failure must stop before HTTP")
      }) as typeof fetch,
    })
    expect(malformed).toBe("unverifiable")
  })

  test("a symlinked durable project config is unverifiable before any engine request", async () => {
    const target = join(project, ".alpha", "alpha.jsonc")
    const outside = join(tmp, "outside-alpha.jsonc")
    writeFileSync(outside, JSON.stringify({ mcp: { demo: durableLeaf } }))
    unlinkSync(target)
    symlinkSync(outside, target)
    let awaitCalls = 0

    const verdict = await probeProjectMcpActivation(
      "demo",
      project,
      async () => {
        awaitCalls++
        return ready()
      },
      { configuredGlobalNames: emptyGlobalNames },
    )
    expect(verdict).toBe("unverifiable")
    expect(awaitCalls).toBe(0)
  })

  test("matching leaf cannot borrow an unscoped connected status", async () => {
    const requests: URL[] = []
    const verdict = await probeProjectMcpActivation("demo", project, ready, {
      configuredGlobalNames: emptyGlobalNames,
      fetch: fetchFor((url) => {
        if (url.pathname === "/global/config") return Response.json({})
        if (url.pathname === "/config") return Response.json({ mcp: { demo: durableLeaf } })
        if (url.pathname === "/mcp" && url.searchParams.get("directory") === null)
          return Response.json({ demo: { status: "connected" } })
        return Response.json({ demo: { status: "failed" } })
      }, requests),
    })
    expect(verdict).toBe("unverifiable")
    expect(requests.at(-1)?.pathname).toBe("/mcp")
    expect(requests.at(-1)?.searchParams.get("directory")).toBe(project)
  })
})
