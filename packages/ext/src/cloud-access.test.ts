import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cloudAccessState } from "./cloud-access"
import { CLOUD_MCP_DEF_ENV } from "./cloud-websearch-kill"
import { materializeCloudMcpConfig } from "../../ui-mac/src/main/cloud-sidecar-config"

const root = realpathSync(mkdtempSync(join(tmpdir(), "alpha-cloud-access-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))
// Real desktop definition producer; only the endpoint/path contents are synthetic.
const env = (reference?: string) => ({
  ALPHA_BASE_URL: "https://gateway.invalid/v1",
  [CLOUD_MCP_DEF_ENV]: JSON.stringify(materializeCloudMcpConfig("https://cloud.invalid/mcp", reference)),
})

describe("REQ-232 AC1 local cloud access", () => {
  test("missing/disabled/malformed definitions and missing platform login report logged-out with the login entry", () => {
    const inputs = [
      {},
      env(),
      { ...env(), [CLOUD_MCP_DEF_ENV]: "{" },
      { ...env(), [CLOUD_MCP_DEF_ENV]: "null" },
      { ...env("{file:/unused}"), ALPHA_BASE_URL: undefined },
    ]
    inputs.forEach((input) => {
      const state = cloudAccessState(input, () => {
        throw new Error("must not check a logged-out credential")
      })
      expect(state.state).toBe("logged-out")
      expect(state.loginHint).toBe(
        "在 CodePuppy 左侧栏账户区点「登录」,或打开定制中心的云端页点登录;登录完成后下一条消息起云端工具可用。",
      )
    })
  })

  test("a missing referenced credential cannot report ready", () => {
    const checked: string[] = []
    expect(
      cloudAccessState(env("{file:/synthetic/missing}"), (path) => {
        checked.push(path)
        return false
      }).state,
    ).toBe("credential-missing")
    expect(checked).toEqual(["/synthetic/missing"])
  })

  test("an existing reference reports ready without reading its content", () => {
    const credential = join(root, "unreadable-as-file")
    mkdirSync(credential)
    expect(() => readFileSync(credential, "utf8")).toThrow()
    expect(cloudAccessState(env(`{file:${credential}}`), existsSync).state).toBe("ready")
  })
})
