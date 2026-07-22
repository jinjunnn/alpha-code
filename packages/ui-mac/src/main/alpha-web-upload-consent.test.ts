import { describe, expect, test } from "bun:test"
import { requestUploadConsent } from "./alpha-web-upload-consent"

describe("alpha-web upload_consent issuance seam", () => {
  test("main requests a mocked alpha-web issuer response with the exact manifest binding", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: typeof input === "string" ? input : input.url, init })
      return new Response(JSON.stringify({ upload_consent: "header.claims.signature" }), { status: 200 })
    }
    const manifestJson = '{"schema_version":1,"manifest_id":"manifest-1"}'
    const result = await requestUploadConsent(
      { accessToken: "access-secret", manifestJson, manifestSha256: "a".repeat(64) },
      { fetcher, web: "https://web.example" },
    )

    expect(result).toBe("header.claims.signature")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("https://web.example/auth/upload-consent")
    expect(calls[0]?.init?.headers).toEqual({
      authorization: "Bearer access-secret",
      "content-type": "application/json",
    })
    const body = calls[0]?.init?.body
    expect(JSON.parse(typeof body === "string" ? body : "null")).toEqual({
      schema_version: 1,
      manifest: manifestJson,
      manifest_sha256: "a".repeat(64),
    })
  })

  test("issuer failure is classified without returning its body", async () => {
    await expect(
      requestUploadConsent(
        { accessToken: "access-secret", manifestJson: "{}", manifestSha256: "a".repeat(64) },
        { fetcher: async () => new Response("absolute /secret/path access-secret", { status: 503 }), web: "https://web.example" },
      ),
    ).rejects.toMatchObject({ code: "upload-consent-issuance-failed" })
  })
})
