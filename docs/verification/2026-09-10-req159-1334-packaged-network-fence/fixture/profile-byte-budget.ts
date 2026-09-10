// alpha-code#1334 —— Q5:加上网络行之后 profile 离 65535 那道墙还有多远。
// 用**生产渲染器**(process-fence-profile.ts)与**真编译器**(process-fence-compile.ts),不手算。
//   bun docs/verification/2026-09-10-req159-1334-packaged-network-fence/fixture/profile-byte-budget.ts
import { renderProcessFenceProfile, resolveEngineRoots, trimUntilCompiles } from "../../../../packages/ui-mac/src/main/process-fence-profile"
import { trialCompileProfile } from "../../../../packages/ui-mac/src/main/process-fence-compile"
import { homedir } from "node:os"; import { join } from "node:path"
const home = homedir(); const appData = join(home, "Library", "Application Support")
const roots = resolveEngineRoots({}, home)
const common = { alphaGlobalRoot: join(appData, "alpha-code-state", "env", "prod"), userDataPath: join(appData, "ai.opencode.desktop"), stateHome: join(appData, "ai.opencode.desktop"), roots }
const mkWs = (n: number) => { const o = [join(home, "code-puppy")]; for (let i = 1; i < n; i++) o.push(join(home, "app", `ws-${String(i).padStart(4, "0")}-` + "x".repeat(40))); return o.slice(0, n) }
const ARMS: Record<string, string> = {
  none: "",
  "sec5-min": '(deny network*)\n(allow network-outbound (remote ip "localhost:47771"))\n',
  working: '(deny network*)\n(allow network-bind (local ip "localhost:*"))\n(allow network-inbound (local ip "localhost:*"))\n(allow network-outbound (remote ip "localhost:47771"))\n',
  "working+dns": '(deny network*)\n(allow network-bind (local ip "localhost:*"))\n(allow network-inbound (local ip "localhost:*"))\n(allow network-outbound (remote ip "localhost:47771"))\n(allow network-outbound (literal "/private/var/run/mDNSResponder"))\n',
}
for (const [tag, net] of Object.entries(ARMS)) {
  let lo = 1, hi = 3000
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); trialCompileProfile(renderProcessFenceProfile({ ...common, workspaces: mkWs(mid) }) + net).ok ? (lo = mid) : (hi = mid - 1) }
  const at = renderProcessFenceProfile({ ...common, workspaces: mkWs(lo) }) + net
  const over = trialCompileProfile(renderProcessFenceProfile({ ...common, workspaces: mkWs(lo + 1) }) + net)
  console.log(`WALL arm=${tag}: maxWorkspaces=${lo} srcBytesAtMax=${Buffer.byteLength(at)} firstFailure="${(over as any).reason ?? ""}"`)
}
console.log("\n--- trimUntilCompiles with a MALFORMED network stanza (what does the operator see?) ---")
const bad = '(deny network*)\n(allow network-outbound (remote host "models.dev"))\n'   // §1.1: no host predicate exists
try {
  const r = trimUntilCompiles({ ...common, workspaces: mkWs(5) }, (p) => trialCompileProfile(p + bad))
  console.log("unexpected success", r.attempts)
} catch (e) { console.log("THREW:", (e as Error).message) }
