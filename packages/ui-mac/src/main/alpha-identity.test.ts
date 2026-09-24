import { describe, expect, test } from "bun:test"
import { buildAlphaCapabilities, buildAlphaIdentity } from "./alpha-identity"

// `#1414`(CODE-2):入参从「env 派生的三个布尔」换成「两条腿各自的**工具表在场性**」——
// 本函数不再自己判「能不能搜网」(那是勘破 §6 点名的第四处各算各的),只把在场性折成提示事实。
// 判据与真闸同源的保证落在调用点 `alpha-config-injection.ts` + 四格闸门
// `websearch-prompt-tool-parity.test.ts`;本文件只钉这个折叠本身。
describe("sidecar identity capability facts", () => {
  test.each([
    [
      "logged-in/platform-pays(今天:本地腿被真闸 deny,云腿在场)",
      { localWebSearch: false, cloudWebSearch: true, cloudDispatch: true },
      { websearch: true, cloudDispatch: true },
    ],
    [
      "两条腿同时在场(`#1411` 之后的目标态)",
      { localWebSearch: true, cloudWebSearch: true, cloudDispatch: true },
      { websearch: true, cloudDispatch: true },
    ],
    [
      "logged-out/BYOK",
      { localWebSearch: true, cloudWebSearch: false, cloudDispatch: false },
      { websearch: true, cloudDispatch: false },
    ],
    [
      "kill-switch:两条腿都不在场,而云 MCP 仍由 ext 托管 ⇒ 只剩 cloud.* 那一行",
      { localWebSearch: false, cloudWebSearch: false, cloudDispatch: true },
      { websearch: false, cloudDispatch: true },
    ],
  ])("%s snapshot", (_, input, expected) => {
    const caps = buildAlphaCapabilities(input)

    expect(caps).toEqual(expected)
    expect(buildAlphaIdentity(caps).includes("- Web search is enabled")).toBe(expected.websearch)
  })
})
