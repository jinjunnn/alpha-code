import { expect, test } from "bun:test"
import { createSidecarGenerationState } from "./sidecar-generation"

test("sidecar generation snapshot moves from recovering to ready without credentials", () => {
  const state = createSidecarGenerationState()
  expect(state.get()).toEqual({ status: "recovering", generation: 0, reason: "boot" })

  state.update({ status: "recovering", generation: 4, reason: "token-only" })
  expect(state.get()).toEqual({ status: "recovering", generation: 4, reason: "token-only" })

  state.update({ status: "ready", generation: 4, reason: "token-only" })
  expect(state.get()).toEqual({ status: "ready", generation: 4, reason: "token-only" })
})
