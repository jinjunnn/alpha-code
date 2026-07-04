// D1: the sidecar health poll must probe immediately and only sleep after a failed check.

import { describe, expect, test } from "bun:test"
import { pollUntilHealthy } from "./health-poll"

describe("pollUntilHealthy", () => {
  test("fires the first check before any sleep (验收①)", async () => {
    const events: string[] = []
    const check = async () => {
      events.push("check")
      return true
    }
    const sleep = async (ms: number) => {
      events.push(`sleep:${ms}`)
    }
    await pollUntilHealthy(check, 100, sleep)
    // no upfront sleep — the first (successful) probe fires with zero delay
    expect(events).toEqual(["check"])
  })

  test("backs off by the interval after each failed check, then succeeds (验收③)", async () => {
    const events: string[] = []
    let attempts = 0
    const check = async () => {
      events.push("check")
      attempts += 1
      return attempts >= 3
    }
    const sleep = async (ms: number) => {
      events.push(`sleep:${ms}`)
    }
    await pollUntilHealthy(check, 100, sleep)
    // check → sleep → check → sleep → check(ok): never sleeps before a check, gap preserved
    expect(events).toEqual(["check", "sleep:100", "check", "sleep:100", "check"])
  })
})
