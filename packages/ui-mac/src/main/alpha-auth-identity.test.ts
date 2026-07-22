import { describe, expect, test } from "bun:test"
import { parseAccessTokenIdentity } from "./alpha-auth-identity"
import { createMainUploadService } from "./alpha-upload"

const jwt = (value: unknown) =>
  `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(value)).toString("base64url")}.signature`

const claims = (sub: unknown) => ({
  schema_version: 1,
  iss: "alpha-web",
  aud: "alpha-platform-api",
  sub,
  token_use: "platform_access",
  purpose: "cloud.dispatch",
  scope: ["cloud.dispatch"],
  iat: 1,
  exp: 2,
  jti: "access-1",
})

describe("main upload access identity", () => {
  test("issuance is refused when access token sub is missing malformed or unparseable", async () => {
    let issuances = 0
    for (const token of [jwt(claims(undefined)), jwt(claims(" tenant-a ")), "not-a-jwt"]) {
      const service = createMainUploadService({
        identity: () => parseAccessTokenIdentity(token, "cloud.dispatch"),
        issue: async () => { issuances++; return "must-not-issue" },
        dispatch: async () => ({ error: "must-not-dispatch" }),
        log: () => {},
      })
      expect(
        await service.prepare(
          1,
          { kind: "code-review" },
          { projectDirectory: "/missing", files: ["/missing/file"] },
        ),
      ).toEqual({ status: "failed", error: "upload-selection-invalid" })
    }
    expect(issuances).toBe(0)
  })

  test("a valid cloud.dispatch subject becomes the manifest tenant", () => {
    const token = jwt(claims("tenant-a"))
    expect(parseAccessTokenIdentity(token, "cloud.dispatch")).toEqual({ accessToken: token, tenantId: "tenant-a" })
  })
})
