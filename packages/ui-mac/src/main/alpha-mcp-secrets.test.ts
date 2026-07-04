// Unit tests for MCP connector secret file-ification (REQ-018 T5). Real temp userData dir; asserts
// secrets land 0600 in their own namespace, config carries only {file:} refs (no plaintext), and
// uninstall revokes the dir.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileifyMcpSecrets, isFileRef, mcpSecretRef, removeMcpServerSecrets, writeMcpSecret } from "./alpha-mcp-secrets"

let userData = ""
beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-mcpsec-"))
})
afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true })
})

const secretFile = (server: string, v: string) => path.join(userData, "alpha-mcp-secrets", server, v)

describe("writeMcpSecret", () => {
  test("writes 0600 and returns a {file:} ref to the abs path", () => {
    const r = writeMcpSecret(userData, "github", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghp_realtoken")
    expect(r.ok).toBe(true)
    expect(r.ok && r.ref).toBe(`{file:${secretFile("github", "GITHUB_PERSONAL_ACCESS_TOKEN")}}`)
    expect(fs.readFileSync(secretFile("github", "GITHUB_PERSONAL_ACCESS_TOKEN"), "utf8")).toBe("ghp_realtoken")
    expect(fs.statSync(secretFile("github", "GITHUB_PERSONAL_ACCESS_TOKEN")).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(secretFile("github", "x"))).mode & 0o777).toBe(0o700)
  })

  test("rejects unsafe server / var / empty value", () => {
    expect(writeMcpSecret(userData, "../evil", "V", "x").ok).toBe(false)
    expect(writeMcpSecret(userData, "srv", "1BAD", "x").ok).toBe(false)
    expect(writeMcpSecret(userData, "srv", "OK", "").ok).toBe(false)
  })

  test("overwrite keeps 0600", () => {
    writeMcpSecret(userData, "yuque", "YUQUE_TOKEN", "old")
    writeMcpSecret(userData, "yuque", "YUQUE_TOKEN", "new")
    expect(fs.readFileSync(secretFile("yuque", "YUQUE_TOKEN"), "utf8")).toBe("new")
    expect(fs.statSync(secretFile("yuque", "YUQUE_TOKEN")).mode & 0o777).toBe(0o600)
  })
})

describe("isFileRef / mcpSecretRef", () => {
  test("recognizes file refs", () => {
    expect(isFileRef("{file:/a/b}")).toBe(true)
    expect(isFileRef("ghp_plain")).toBe(false)
    expect(mcpSecretRef(userData, "s", "V")).toBe(`{file:${secretFile("s", "V")}}`)
  })
})

describe("fileifyMcpSecrets — no plaintext survives in config", () => {
  test("moves environment secrets to files, replaces with refs, leaves non-secret env alone", () => {
    const config: Record<string, unknown> = {
      type: "local",
      command: ["npx", "-y", "@modelcontextprotocol/server-github"],
      environment: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret", npm_config_registry: "https://registry.npmmirror.com" },
    }
    const r = fileifyMcpSecrets(userData, "github", config, ["GITHUB_PERSONAL_ACCESS_TOKEN"])
    expect(r.fileified).toEqual(["GITHUB_PERSONAL_ACCESS_TOKEN"])
    const env = config.environment as Record<string, string>
    expect(isFileRef(env.GITHUB_PERSONAL_ACCESS_TOKEN)).toBe(true)
    expect(env.npm_config_registry).toBe("https://registry.npmmirror.com") // untouched
    // the plaintext is on disk in the secret file, NOT in the serialized config
    expect(JSON.stringify(config)).not.toContain("ghp_secret")
    expect(fs.readFileSync(secretFile("github", "GITHUB_PERSONAL_ACCESS_TOKEN"), "utf8")).toBe("ghp_secret")
  })

  test("multiple secrets (feishu APP_ID/APP_SECRET)", () => {
    const config: Record<string, unknown> = {
      type: "local",
      command: ["npx"],
      environment: { APP_ID: "cli_x", APP_SECRET: "sec_y" },
    }
    fileifyMcpSecrets(userData, "feishu-lark", config, ["APP_ID", "APP_SECRET"])
    const env = config.environment as Record<string, string>
    expect(isFileRef(env.APP_ID)).toBe(true)
    expect(isFileRef(env.APP_SECRET)).toBe(true)
    expect(JSON.stringify(config)).not.toContain("cli_x")
    expect(JSON.stringify(config)).not.toContain("sec_y")
  })

  test("already-fileref value is skipped (idempotent re-persist)", () => {
    const ref = mcpSecretRef(userData, "s", "TOK")
    const config: Record<string, unknown> = { type: "local", command: ["x"], environment: { TOK: ref } }
    const r = fileifyMcpSecrets(userData, "s", config, ["TOK"])
    expect(r.skipped).toContain("TOK")
    expect((config.environment as Record<string, string>).TOK).toBe(ref)
  })

  test("missing/empty env value is skipped, not crashed", () => {
    const config: Record<string, unknown> = { type: "local", command: ["x"] }
    const r = fileifyMcpSecrets(userData, "s", config, ["ABSENT"])
    expect(r.skipped).toContain("ABSENT")
  })
})

describe("removeMcpServerSecrets", () => {
  test("removes the connector's whole secret dir", () => {
    writeMcpSecret(userData, "github", "GITHUB_PERSONAL_ACCESS_TOKEN", "t")
    expect(fs.existsSync(secretFile("github", "GITHUB_PERSONAL_ACCESS_TOKEN"))).toBe(true)
    removeMcpServerSecrets(userData, "github")
    expect(fs.existsSync(path.join(userData, "alpha-mcp-secrets", "github"))).toBe(false)
  })
})
