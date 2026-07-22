import { describe, expect, test } from "bun:test"
import { buildAlphaCapabilities, buildAlphaIdentity } from "./alpha-identity"

describe("sidecar identity capability facts", () => {
  test.each([
    [
      "logged-in/platform-pays",
      { websearchDisabled: false, keylessWebsearch: false, cloudDispatch: true },
      { websearch: true, cloudDispatch: true },
    ],
    [
      "logged-out/BYOK",
      { websearchDisabled: false, keylessWebsearch: true, cloudDispatch: false },
      { websearch: true, cloudDispatch: false },
    ],
    [
      "ALPHA_WEBSEARCH_DISABLE set",
      { websearchDisabled: true, keylessWebsearch: true, cloudDispatch: true },
      { websearch: false, cloudDispatch: true },
    ],
  ])("%s snapshot", (_, input, expected) => {
    const caps = buildAlphaCapabilities(input)

    expect(caps).toEqual(expected)
    expect(buildAlphaIdentity(caps).includes("- Web search is enabled")).toBe(expected.websearch)
  })
})
