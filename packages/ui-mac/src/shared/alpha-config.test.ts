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

  test("platform/cloud are the REQ-070 custom domains — never the known-bad api.tidelabs.click, no workers.dev regression", () => {
    // History: api.tidelabs.click 404'd every /v1 route (pre-custom-domain wrong host) → the lock was
    // "no tidelabs, workers.dev only". Since B PR #20 the gateway/cloud DO have custom domains
    // (alpha-gateway/alpha-cloud.tidelabs.click, live-probed /health+/v1/models 200 on 2026-07-08) and
    // workers.dev is the DEPRECATED host (mainland DNS poisoning) kept online only for old clients.
    expect(ALPHA_ENDPOINTS.platform).toBe("https://alpha-gateway.tidelabs.click")
    expect(ALPHA_ENDPOINTS.cloud).toBe("https://alpha-cloud.tidelabs.click")
    for (const url of [ALPHA_ENDPOINTS.platform, ALPHA_ENDPOINTS.cloud]) {
      expect(url).not.toContain("api.tidelabs.click") // the known-bad host must never come back
      expect(url).not.toContain("workers.dev") // and neither should the deprecated default
    }
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
    expect(ALPHA_PATHS.uploadConsent).toBe("/auth/upload-consent")
    expect(ALPHA_PATHS.mcpGateway).toBe("/mcp")
    expect(ALPHA_PATHS.models).toBe("/v1/models")
  })
})
