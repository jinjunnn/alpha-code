// Contract lock for the single-source-of-truth endpoint/path constants (alpha-config.ts). These feed
// ALPHA_BASE_URL (the bearer-carrying proxy target) and every alpha↔backend URL, so a regression here
// (a plain-http host, a stray trailing slash, the old api.tidelabs.click gateway, a path missing its
// leading slash) is exactly the class of bug that broke /v1 before. Guard the invariants, not the exact
// domains (those may legitimately move) — except the known-bad host, which must never come back.

import { describe, expect, test } from "bun:test"
import { ALPHA_ENDPOINTS, ALPHA_PATHS } from "./alpha-config"

describe("ALPHA_ENDPOINTS", () => {
  const required = ["web", "platform", "account", "cloud"] as const

  test("has every required backend host", () => {
    for (const k of required) expect(typeof (ALPHA_ENDPOINTS as any)[k]).toBe("string")
  })

  test.each(required)("%s is https, a valid URL, and has no trailing slash", (k) => {
    const url = (ALPHA_ENDPOINTS as any)[k] as string
    expect(url.startsWith("https://")).toBe(true)
    expect(url.endsWith("/")).toBe(false)
    expect(() => new URL(url)).not.toThrow()
  })

  test("platform gateway is NOT the old api.tidelabs.click host (which 404'd every /v1 route)", () => {
    expect(ALPHA_ENDPOINTS.platform).not.toContain("tidelabs")
    // it's the raw Worker that actually routes /v1
    expect(ALPHA_ENDPOINTS.platform).toContain("workers.dev")
  })
})

describe("ALPHA_PATHS", () => {
  test("every path is a rooted URL segment (leading slash, no trailing slash)", () => {
    for (const [key, p] of Object.entries(ALPHA_PATHS)) {
      expect(p.startsWith("/"), `${key} must start with /`).toBe(true)
      expect(p.endsWith("/"), `${key} must not end with /`).toBe(false)
    }
  })

  test("the load-bearing routes are stable", () => {
    expect(ALPHA_PATHS.modelProxy).toBe("/v1")
    expect(ALPHA_PATHS.token).toBe("/auth/token")
    expect(ALPHA_PATHS.mcpGateway).toBe("/mcp")
    expect(ALPHA_PATHS.models).toBe("/v1/models")
  })
})
