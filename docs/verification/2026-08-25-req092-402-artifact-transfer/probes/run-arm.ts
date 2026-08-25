// alpha-code#402 —— 通用编排:起 origin,把某个 *-arm.ts 打成 node bundle,
// 在 node 与 Electron 的 Node 上各跑一遍,结果落 results/。
//
// 用法:bun run-arm.ts <armFile> <outName> [extraArgs...]
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { originReset, startOrigin } from "./harness"

const [armFile, outName, ...extra] = process.argv.slice(2)
const FIXTURES = process.env.ALPHA_402_FIXTURES!
const OUT = process.env.ALPHA_402_OUT!
const REPO = path.resolve(import.meta.dir, "../../../..")
const ELECTRON = path.join(REPO, "packages/ui-mac/node_modules/.bin/electron")

const bundle = `/tmp/alpha402-${path.basename(armFile, ".ts")}.mjs`
const build = spawnSync(
  "bun",
  ["build", "--target=node", "--format=esm", path.join(import.meta.dir, armFile), "--outfile", bundle],
  { encoding: "utf8" },
)
if (build.status !== 0) throw new Error(`bundle failed:\n${build.stdout}\n${build.stderr}`)

const origin = await startOrigin(path.join(import.meta.dir, "origin-raw.ts"), FIXTURES)

function runOn(runtime: "node" | "electron") {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), `alpha-402-${runtime}-`))
  const args = [bundle, origin.base, FIXTURES, project, ...extra]
  const cmd = runtime === "node" ? "node" : ELECTRON
  // ELECTRON_RUN_AS_NODE 不接受 --js-flags(实测 `bad option`)。
  const argv = runtime === "node" ? ["--expose-gc", ...args] : [...args]
  const r = spawnSync(cmd, argv, {
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 900_000,
  })
  const line = r.stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop()
  fs.rmSync(project, { recursive: true, force: true })
  if (r.status !== 0 || !line) {
    return { runtime, failed: true, exit: r.status, stdout: r.stdout.slice(-4000), stderr: r.stderr.slice(-4000) }
  }
  return { runtime, failed: false, ...(JSON.parse(line) as Record<string, unknown>), stderr: r.stderr.slice(-2000) }
}

// 两个运行时共用一个 origin ⇒ 计数会串味(第一版实测:electron 那一轮的 requests 恒等于 2,
// 因为 node 那轮的计数还在)。跑第二个运行时之前必须清账。
const first = runOn("node")
await originReset(origin)
const second = runOn("electron")
const rows = [first, second]
origin.stop()
fs.writeFileSync(path.join(OUT, outName), `${JSON.stringify(rows, null, 2)}\n`)
for (const row of rows) {
  const cases = (row as { cases?: { id: string; what: string; error: string | null }[] }).cases ?? []
  console.log(`\n=== ${row.runtime} ${(row as { runtime?: string }).failed ? "(FAILED TO RUN)" : ""}`)
  for (const c of cases) console.log(`${c.id}\t${c.error ? `ERROR ${c.error}` : "ran"}\t${c.what}`)
  if ((row as { failed?: boolean }).failed) console.log((row as { stderr?: string }).stderr)
}
console.log(`\nwrote ${path.join(OUT, outName)}`)
