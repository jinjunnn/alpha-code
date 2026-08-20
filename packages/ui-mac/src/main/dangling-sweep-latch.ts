// REQ-053 `#982` — spawn throat latch: each `spawnLocalServer` fork requires a
// dangling-config sweep credit for this generation. Lives in an importable module
// so bun tests can drive it; `index.ts` cannot be linked under bun (`#968`).

let spawnCredit = false

/** Call after a boot/respawn dangling sweep completed with an empty enforcement gap. */
export function creditDanglingSweepForSpawn(): void {
  spawnCredit = true
}

/**
 * Consume one sweep credit. Throws fail-closed if none — refuse the sidecar fork
 * before secrets sync / utilityProcess.fork.
 */
export function consumeDanglingSweepCredit(): void {
  if (!spawnCredit) {
    throw new Error(
      "req053-dangling-sweep: spawnLocalServer refused — dangling sweep has not run for this generation",
    )
  }
  spawnCredit = false
}

export function resetDanglingSweepLatchForTests(): void {
  spawnCredit = false
}

export function peekDanglingSweepCreditForTests(): boolean {
  return spawnCredit
}
