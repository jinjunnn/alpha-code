export type SidecarRespawnReason = "token-only" | "structural"

export function shouldReloadRenderer(reason: SidecarRespawnReason): boolean {
  return reason === "structural"
}

export function shouldRetryRespawn(reason: SidecarRespawnReason): boolean {
  return reason === "structural"
}

export function mergeRespawnReason(
  current: SidecarRespawnReason | null,
  incoming: SidecarRespawnReason,
): SidecarRespawnReason {
  if (current === "structural" || incoming === "structural") return "structural"
  return "token-only"
}

export function createSidecarRespawnQueue(run: (reason: SidecarRespawnReason) => Promise<boolean>) {
  let active: Promise<boolean> | null = null
  let queued: SidecarRespawnReason | null = null

  const drain = async (reason: SidecarRespawnReason): Promise<boolean> => {
    const healthy = await run(reason)
    const next = queued
    queued = null
    if (!next) return healthy
    return drain(next)
  }

  return (reason: SidecarRespawnReason): Promise<boolean> => {
    if (active) {
      queued = mergeRespawnReason(queued, reason)
      return active
    }
    active = drain(reason).finally(() => {
      active = null
    })
    return active
  }
}
