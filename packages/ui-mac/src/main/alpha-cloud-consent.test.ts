import { describe, expect, test } from "bun:test"
import { parsePrefs } from "./alpha-cloud-consent"

describe("project prefs are not an upload consent authority", () => {
  test.each([[null], [undefined], [""], ["not json"], ["[]"], ["123"], ["null"]])(
    "%p parses to an empty object",
    (input) => expect(parsePrefs(input as string | null)).toEqual({}),
  )

  test("a legacy cloudConsent record remains inert unknown preference data", () => {
    expect(parsePrefs('{"cloudConsent":{"version":1,"acceptedAt":"x"},"other":true}')).toEqual({
      cloudConsent: { version: 1, acceptedAt: "x" },
      other: true,
    })
  })
})
