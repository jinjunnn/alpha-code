import { expect, mock, test } from "bun:test"

mock.module("./ext-ipc", () => ({
  extIpc: {
    remoteCatalog: async () => ({ source: "none", error: "offline test" }),
  },
}))

const { catalog, catalogSource, refreshCatalog } = await import("./catalog-source")

test("ADR-040:remote unavailable keeps the real bundled catalog without opencode-notify", async () => {
  await refreshCatalog()
  expect(catalogSource()).toBe("builtin")
  expect(catalog().entries.length).toBeGreaterThan(0)
  expect(catalog().entries.some((entry) => entry.id === "plugin:opencode-notify")).toBe(false)
  expect(JSON.stringify(catalog())).not.toContain("opencode-notify")
})
