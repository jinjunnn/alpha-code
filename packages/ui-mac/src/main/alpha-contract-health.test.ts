import { expect, test } from "bun:test"
import { resolve } from "node:path"

// 分类与「这处锚守不住什么」登记在 ./source-text-anchors.ts(`#968` 第 ⑤ 层机械校验)。
test("ANCHOR (not a gate): contract purpose mismatch is exposed as a persistent role=alert banner", async () => {
  const banner = await Bun.file(resolve(import.meta.dir, "../renderer/alpha-ui/Banner.tsx")).text()
  const providers = await Bun.file(resolve(import.meta.dir, "../renderer/alpha-ui/providers.ts")).text()
  const renderer = await Bun.file(resolve(import.meta.dir, "../renderer/index.tsx")).text()
  expect(banner).toContain("ContractFailureBanner")
  expect(banner).toContain('kind="error"')
  expect(providers).toContain("window.api.contracts.subscribe")
  expect(renderer).toContain("<ContractFailureBanner />")
})
