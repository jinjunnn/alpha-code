import { describe, expect, test } from "bun:test"
import {
  createSidecarRespawnQueue,
  mergeRespawnReason,
  shouldReloadRenderer,
  shouldRetryRespawn,
  type SidecarRespawnReason,
} from "./sidecar-lifecycle"

describe("sidecar respawn reasons", () => {
  test("only structural respawns reload the renderer", () => {
    expect(shouldReloadRenderer("token-only")).toBe(false)
    expect(shouldReloadRenderer("structural")).toBe(true)
  })

  test("only structural recovery may retry without a newer token generation", () => {
    expect(shouldRetryRespawn("token-only")).toBe(false)
    expect(shouldRetryRespawn("structural")).toBe(true)
  })

  test("queued reasons escalate to structural", () => {
    expect(mergeRespawnReason(null, "token-only")).toBe("token-only")
    expect(mergeRespawnReason("token-only", "structural")).toBe("structural")
    expect(mergeRespawnReason("structural", "token-only")).toBe("structural")
  })

  test("coalesced token-only + structural requests run one escalated follow-up", async () => {
    let release!: () => void
    const first = new Promise<void>((resolve) => {
      release = resolve
    })
    const runs: SidecarRespawnReason[] = []
    const request = createSidecarRespawnQueue(async (reason) => {
      runs.push(reason)
      if (runs.length === 1) await first
      return true
    })

    const active = request("token-only")
    request("token-only")
    request("structural")
    release()
    await active
    expect(runs).toEqual(["token-only", "structural"])
  })
})
