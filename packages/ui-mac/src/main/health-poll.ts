// D1: fire the first health check IMMEDIATELY, then back off `intervalMs` only AFTER a failed
// check. The previous sidecar-ready loop slept first and probed second, so every startup paid an
// unconditional ~100ms even when the server was already up. This mirrors the immediate-first-check
// ordering of `wsl/startup.ts` `pollWslHealth`. `sleep` is injectable so the ordering is unit-testable
// without real timers (and without pulling electron into the test).
export async function pollUntilHealthy(
  check: () => Promise<boolean>,
  intervalMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  while (true) {
    if (await check()) return
    await sleep(intervalMs)
  }
}
