// v0.1.1/v0.1.2 的 saneCatalog() 与今天逐字相同，故本测试是忠实代理；v0.1.0 尚无此文件。
import { generateKeyPairSync, sign } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterAll, describe, expect, test } from "bun:test"
import { readCachedCatalog } from "../../main/remote-catalog"

const roots: string[] = []
const keys = generateKeyPairSync("ed25519")
const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64")

afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))

describe("Catalog 浅壳解析：新增同级键与空 entries", () => {
  test("non-empty entries remain valid when a sibling packages array is added", async () => {
    const catalog = {
      version: "2026-07-30.1",
      entries: [{ id: "skill:legacy-safe" }],
      packages: [{ schema: "alpha.host-extension-package.v1" }],
    }
    const root = await signedCache(catalog)
    const cached = readCachedCatalog(root, { pubKeyB64: publicKey })
    expect(cached?.version).toBe(catalog.version)
    expect(cached?.catalog).toEqual(catalog)
  })

  test("读端会拒绝空 entries，即使 packages 非空", async () => {
    const root = await signedCache({
      version: "2026-07-30.1",
      entries: [],
      packages: [{ schema: "alpha.host-extension-package.v1" }],
    })
    expect(readCachedCatalog(root, { pubKeyB64: publicKey })).toBeNull()
  })
})

async function signedCache(catalog: unknown): Promise<string> {
  const root = mkdtempSync(resolve(tmpdir(), "alpha-catalog-shell-"))
  roots.push(root)
  const body = JSON.stringify(catalog)
  await Bun.write(
    resolve(root, "remote-catalog.json"),
    JSON.stringify({
      version: "untrusted-cache-metadata",
      fetchedAt: "2026-07-30T00:00:00.000Z",
      body,
      sig: sign(null, Buffer.from(body), keys.privateKey).toString("base64"),
    }),
  )
  return root
}
