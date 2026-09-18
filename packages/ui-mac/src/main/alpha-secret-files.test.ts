// Unit tests for the A6 {file:} secret channel (alpha-secret-files.ts). This is security-path code:
// syncSecretFiles decides which secrets exist on disk for the sidecar's config refs, and — just as
// load-bearing — which get REVOKED (logout / key removal must delete the file, or a dead provider
// keeps resurrecting with a stale key).

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  customProviderSecretName,
  hasSecretFile,
  secretEnvVars,
  secretFilePath,
  secretFileRef,
  syncSecretFiles,
} from "./alpha-secret-files"

let tmp = ""

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-secret-files-"))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("secretEnvVars", () => {
  test("covers the platform bearer, the cloud MCP token, and every catalog BYOK keyEnv", () => {
    const vars = secretEnvVars()
    expect(vars).toContain("ALPHA_API_KEY")
    expect(vars).toContain("ALPHA_CLOUD_TOKEN")
    expect(vars).toContain("ALPHA_MCP_TOKEN") // #1195:登录铸 mcp_access → 云 MCP {file:} header
    expect(vars).toContain("DEEPSEEK_API_KEY") // catalog byok provider
  })
})

describe("syncSecretFiles", () => {
  test("writes one 0600 file per present var inside a 0700 dir", () => {
    const result = syncSecretFiles(tmp, { ALPHA_API_KEY: "jwt-abc", DEEPSEEK_API_KEY: "sk-123" })
    expect(result.written.sort()).toEqual(["ALPHA_API_KEY", "DEEPSEEK_API_KEY"])

    const file = secretFilePath(tmp, "ALPHA_API_KEY")
    expect(fs.readFileSync(file, "utf8")).toBe("jwt-abc")
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
    expect(hasSecretFile(tmp, "ALPHA_API_KEY")).toBe(true)
  })

  test("absent or empty vars produce no file", () => {
    syncSecretFiles(tmp, { DEEPSEEK_API_KEY: "" })
    expect(hasSecretFile(tmp, "DEEPSEEK_API_KEY")).toBe(false)
    expect(hasSecretFile(tmp, "ALPHA_API_KEY")).toBe(false)
  })

  test("REVOKES the file when the var disappears (logout / key removed)", () => {
    syncSecretFiles(tmp, { ALPHA_API_KEY: "jwt-abc" })
    expect(hasSecretFile(tmp, "ALPHA_API_KEY")).toBe(true)

    const result = syncSecretFiles(tmp, {})
    expect(result.removed).toContain("ALPHA_API_KEY")
    expect(hasSecretFile(tmp, "ALPHA_API_KEY")).toBe(false)
  })

  test("sweeps leftover files that no longer map to any known secret var", () => {
    syncSecretFiles(tmp, {}) // creates the dir
    const stale = secretFilePath(tmp, "RETIRED_PROVIDER_KEY")
    fs.writeFileSync(stale, "old")

    const result = syncSecretFiles(tmp, {})
    expect(result.removed).toContain("RETIRED_PROVIDER_KEY")
    expect(fs.existsSync(stale)).toBe(false)
  })

  test("re-running refreshes values in place (key rotation)", () => {
    syncSecretFiles(tmp, { ALPHA_API_KEY: "old" })
    syncSecretFiles(tmp, { ALPHA_API_KEY: "new" })
    expect(fs.readFileSync(secretFilePath(tmp, "ALPHA_API_KEY"), "utf8")).toBe("new")
    expect(fs.statSync(secretFilePath(tmp, "ALPHA_API_KEY")).mode & 0o777).toBe(0o600)
  })
})

// REQ-226 `#1343`: off-catalog custom provider keys enter this channel through `extra` (keychain store →
// file, no env hop). Same revocation semantics as env vars: absent on the next sync ⇒ swept.
describe("syncSecretFiles — extra (custom provider keys, keychain → file)", () => {
  const a = customProviderSecretName("my-endpoint")
  const b = customProviderSecretName("other-endpoint")

  test("customProviderSecretName: lowercase-prefixed, never a catalog var name", () => {
    expect(a).toBe("custom-provider--my-endpoint")
    expect(secretEnvVars()).not.toContain(a)
  })

  test("two extra names are each written 0600, reported in `written`, and survive the leftover sweep", () => {
    const result = syncSecretFiles(tmp, {}, { [a]: "value-a", [b]: "value-b" })
    expect(result.written.sort()).toEqual([a, b].sort())
    expect(result.removed).toEqual([])
    expect(fs.readFileSync(secretFilePath(tmp, a), "utf8")).toBe("value-a")
    expect(fs.readFileSync(secretFilePath(tmp, b), "utf8")).toBe("value-b")
    expect(fs.statSync(secretFilePath(tmp, a)).mode & 0o777).toBe(0o600)
    // A second sync with the same extra keeps both — they are in the wanted set, not "leftovers".
    const again = syncSecretFiles(tmp, {}, { [a]: "value-a", [b]: "value-b" })
    expect(again.removed).toEqual([])
    expect(hasSecretFile(tmp, a)).toBe(true)
    expect(hasSecretFile(tmp, b)).toBe(true)
  })

  test("a name absent from `extra` on the next sync is REVOKED (key / provider removed); the other stays", () => {
    syncSecretFiles(tmp, {}, { [a]: "value-a", [b]: "value-b" })
    const result = syncSecretFiles(tmp, {}, { [b]: "value-b" })
    expect(result.removed).toContain(a)
    expect(hasSecretFile(tmp, a)).toBe(false)
    expect(hasSecretFile(tmp, b)).toBe(true)
  })

  test("an empty extra value produces no file and removes a stale one", () => {
    syncSecretFiles(tmp, {}, { [a]: "value-a" })
    const result = syncSecretFiles(tmp, {}, { [a]: "" })
    expect(hasSecretFile(tmp, a)).toBe(false)
    expect(result.removed).toContain(a)
  })

  test("extra and env-derived files coexist; neither sweeps the other", () => {
    const result = syncSecretFiles(tmp, { ALPHA_API_KEY: "jwt-abc" }, { [a]: "value-a" })
    expect(result.written.sort()).toEqual(["ALPHA_API_KEY", a].sort())
    expect(hasSecretFile(tmp, "ALPHA_API_KEY")).toBe(true)
    expect(hasSecretFile(tmp, a)).toBe(true)
  })

  test("fail closed: an extra name that is not a plain file name throws (spawnLocalServer then refuses to fork)", () => {
    expect(() => syncSecretFiles(tmp, {}, { "../escape": "v" })).toThrow(/plain file name/)
    expect(() => syncSecretFiles(tmp, {}, { "": "v" })).toThrow(/plain file name/)
    expect(fs.existsSync(path.join(tmp, "escape"))).toBe(false)
  })
})

describe("secretFileRef", () => {
  test("emits the {file:<abs path>} token opencode's ConfigVariable.substitute resolves", () => {
    expect(secretFileRef(tmp, "ALPHA_API_KEY")).toBe(`{file:${path.join(tmp, "alpha-secrets", "ALPHA_API_KEY")}}`)
  })

  test("paths with spaces stay inside the token (upstream matcher stops only at '}')", () => {
    const spaced = fs.mkdtempSync(path.join(os.tmpdir(), "Application Support-"))
    try {
      const ref = secretFileRef(spaced, "ALPHA_API_KEY")
      expect(ref.startsWith("{file:")).toBe(true)
      expect(ref.endsWith("}")).toBe(true)
      expect(ref).toContain("Application Support-")
    } finally {
      fs.rmSync(spaced, { recursive: true, force: true })
    }
  })
})
