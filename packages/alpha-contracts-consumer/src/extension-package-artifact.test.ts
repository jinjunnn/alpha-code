// REQ-128 consumer gate:byte provenance and executable semantic negatives are separate.
// Re-vendoring a weakened producer can make every SHA self-consistent, so the schema/vector
// assertions below deliberately execute the pinned negative corpus instead of treating its
// aggregate hash as proof of compatibility semantics.

import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { describe, expect, test } from "bun:test"
import Ajv2020 from "ajv/dist/2020"

const root = resolve(import.meta.dir, "..")
const vendor = resolve(root, "vendor/alpha-web-extension-package")
const lockFile = resolve(root, "alpha-web-extension-package.lock.json")
const json = (path: string) => Bun.file(resolve(vendor, path)).json()
const bytes = async (path: string) => new Uint8Array(await Bun.file(resolve(vendor, path)).arrayBuffer())
const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.keys(value)
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
  )
}

describe("alpha-web extension package producer artifact pin", () => {
  test("pins the containing commit, artifact path, aggregate, and all 22 exact files", async () => {
    const lock = (await Bun.file(lockFile).json()) as {
      repo: string
      commit: string
      artifactPath: string
      artifactSha256: string
      files: Array<{ path: string; sha256: string }>
    }
    const manifest = (await json("extension-package-producer-artifact.v1.json")) as {
      files: Array<{ path: string; bytes: number; sha256: string }>
    }

    expect(lock).toMatchObject({
      repo: "jinjunnn/alpha-web",
      commit: "b71748103ce65f97e3e5c8ac03f08152a0a1456f",
      artifactPath: "contracts/extension-package/artifact",
      artifactSha256: "ae9f43cc2a7cf279ff06d2846ff45f39cbb0fdd2fd0c4c5d91718968692e4887",
    })
    expect(lock.files.length).toBe(22)
    expect(lock.files.map((file) => file.path).sort()).toEqual(
      [...manifest.files.map((file) => file.path), "extension-package-producer-artifact.v1.json"].sort(),
    )
    for (const file of lock.files) expect(sha256(await bytes(file.path)), file.path).toBe(file.sha256)
    for (const file of manifest.files) {
      const data = await bytes(file.path)
      expect(data.byteLength, file.path).toBe(file.bytes)
      expect(sha256(data), file.path).toBe(file.sha256)
    }
  })

  test("recomputes the producer aggregate and enforces the non-self-referential commit binding", async () => {
    const manifest = (await json("extension-package-producer-artifact.v1.json")) as {
      artifactPath: string
      artifactSha256: string
      files: unknown
      producerRepository: string
      producerCommit: unknown
    }
    const aggregate = sha256(
      new TextEncoder().encode(
        `${JSON.stringify(
          canonical({
            artifactPath: manifest.artifactPath,
            files: manifest.files,
            producerRepository: manifest.producerRepository,
          }),
          null,
          2,
        )}\n`,
      ),
    )
    expect(aggregate).toBe(manifest.artifactSha256)
    expect(manifest.producerRepository).toBe("jinjunnn/alpha-web")
    expect(manifest.producerCommit).toEqual({
      binding: "git-commit-containing-this-artifact",
      embedded: false,
    })
  })

  test("Phase 1 profile/capability closure excludes cloud, OAuth, and Alpha Connection", async () => {
    const registry = await json("host-extension-package.registry.v1.json")
    const profiles = await json("generic-profiles.v1.json")
    const rules = await json("generic-rules.v1.json")
    expect(registry.profiles.map((profile: { profileId: string }) => profile.profileId).sort()).toEqual([
      "agent",
      "mcp-local",
      "mcp-remote",
      "skill",
    ])
    expect(registry.capabilities.map((capability: { token: string }) => capability.token)).toEqual([
      "alpha.secret-prerequisite.v1",
    ])
    expect(profiles.mappings.map((mapping: { host: { profileId: string } }) => mapping.host.profileId)).toEqual([
      "agent",
      "mcp-local",
      "mcp-remote",
      "skill",
    ])
    expect(rules.excluded).toEqual(expect.arrayContaining(["bundle", "cloud", "provider-adapter"]))
    expect(JSON.stringify({ registry, profiles, rules })).not.toContain("alpha-connection")
  })

  test("declaration schema directly rejects cloud, OAuth, author capabilities, and secret values", async () => {
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(
      await json("alpha-package-declaration-v1.schema.json"),
    )
    for (const path of [
      "input.cloud-profile.invalid.json",
      "input.remote-oauth.invalid.json",
      "input.author-capabilities.invalid.json",
      "input.author-secret-value.invalid.json",
    ])
      expect(validate(await json(path)), path).toBe(false)
    expect(validate(await json("input.mcp-remote.valid.json"))).toBe(true)
  })

  test("credential/canonical URL negatives and remote auth semantics are asserted independently of SHA", async () => {
    const insecure = await json("input.remote-http.invalid.json")
    expect(new URL(insecure.root.component.behavior.url).protocol).not.toBe("https:")
    const credential = await json("input.remote-userinfo.invalid.json")
    const credentialUrl = new URL(credential.root.component.behavior.url)
    expect(credentialUrl.username === "" && credentialUrl.password === "").toBe(false)

    const compiled = await json("expected.mcp-remote.compiled.json")
    const payloadUrl = new URL(compiled.payload.behavior.url)
    expect(compiled.payload.behavior.auth).toBe("none")
    expect(payloadUrl.protocol).toBe("https:")
    expect(payloadUrl.username).toBe("")
    expect(payloadUrl.password).toBe("")
    expect(payloadUrl.href).toBe(compiled.payload.behavior.url)
    expect(compiled.envelope.components[0].required).toBe(true)
  })

  test("published vector error codes keep all semantic negative axes named", async () => {
    const vectors = await json("vectors.v1.json")
    expect(
      Object.fromEntries(
        vectors.invalid.map((vector: { input: string; errorCode: string }) => [vector.input, vector.errorCode]),
      ),
    ).toEqual({
      "input.remote-http.invalid.json": "E_URL_HTTPS",
      "input.remote-userinfo.invalid.json": "E_URL_CREDENTIALS",
      "input.remote-oauth.invalid.json": "E_AUTH_UNSUPPORTED",
      "input.cloud-profile.invalid.json": "E_PROFILE_UNSUPPORTED",
      "input.author-capabilities.invalid.json": "E_AUTHOR_DERIVED_FIELD",
      "input.author-secret-value.invalid.json": "E_AUTHOR_DERIVED_FIELD",
    })
  })
})
