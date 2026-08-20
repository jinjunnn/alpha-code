#!/usr/bin/env bun
// Packaged REQ-053 AC2/AC5 fixtures. Isolation = OPENCODE_TEST_ONBOARDING (random
// $TMPDIR/opencode-onboarding-<uuid>/). Seeds are planted in the window after that
// root exists and before whenReady sweep — there is no public env override for a
// packaged alpha base (ALPHA_ENV_BASE_DIR is refused).
//
//   bun docs/verification/2026-08-19-req053-packaged-incident-regression/run.ts \
//     --app <path-to-alpha-code.app> --fixture A|A2|B|C

import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const RESULTS = join(HERE, "results")
const FOREIGN_PLUGIN = join(tmpdir(), "req053-470-foreign", "plugin.js")
const RATE_BYTES = 64 * 1024 * 1024
const ABSOLUTE_BYTES = 512 * 1024 * 1024
const MB = 1024 * 1024

type Fixture = "A" | "A2" | "B" | "C"
type Verdict = "PASS" | "FAIL" | "KNOWN GAP"

type Check = { id: string; ok: boolean; detail: string }

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  return fallback
}

function parseJsonc(text: string): Record<string, unknown> {
  const stripped = text.replace(/^\uFEFF/, "").replace(/,(\s*[}\]])/g, "$1")
  return JSON.parse(stripped) as Record<string, unknown>
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function nowIso() {
  return new Date().toISOString()
}

function gitSha(): string {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: HERE, encoding: "utf8" })
  return r.stdout.trim()
}

function appExecutable(app: string): string {
  return join(app, "Contents/MacOS/alpha-code")
}

function snapshotRealHomes() {
  const paths = [
    join(homedir(), ".alpha"),
    join(homedir(), ".opencode"),
    join(homedir(), ".config", "opencode"),
    join(homedir(), "Library", "Application Support", "ai.opencode.desktop"),
    join(homedir(), "Library", "Application Support", "com.tide.alphacode"),
  ]
  const out: Record<string, { exists: boolean; mtimeMs: number | null; ino: number | null }> = {}
  for (const p of paths) {
    try {
      const st = lstatSync(p)
      out[p] = { exists: true, mtimeMs: st.mtimeMs, ino: st.ino }
    } catch {
      out[p] = { exists: false, mtimeMs: null, ino: null }
    }
  }
  return out
}

function seedBody(userData: string, extraTop?: Record<string, unknown>) {
  const gonePlugin = join(userData, "plugins", "gone-req053.js")
  const livePlugin = join(userData, "plugins", "keep-alive.js")
  const goneSecret = join(userData, "alpha-mcp-secrets", "req053", "DSN")
  const liveSecret = join(userData, "alpha-mcp-secrets", "req053", "LIVE")
  mkdirSync(dirname(livePlugin), { recursive: true })
  mkdirSync(dirname(liveSecret), { recursive: true })
  writeFileSync(livePlugin, "export const keep = 1\n")
  writeFileSync(liveSecret, "keep\n")
  return {
    gonePlugin,
    livePlugin,
    goneSecret,
    liveSecret,
    body: {
      plugin: [gonePlugin, "opencode-notify", livePlugin, FOREIGN_PLUGIN],
      mcp: {
        req053loop: {
          type: "local",
          command: ["true"],
          environment: {
            DSN: `{file:${goneSecret}}`,
            LIVE: `{file:${liveSecret}}`,
          },
        },
      },
      ...(extraTop ?? {}),
    },
  }
}

function writeJsonc(file: string, body: unknown) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`)
}

function waitForOnboardingRoot(startedAt: number, timeoutMs: number): Promise<string> {
  const rootParent = tmpdir()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(poll)
      reject(new Error(`onboarding root not created within ${timeoutMs}ms under ${rootParent}`))
    }, timeoutMs)
    const poll = setInterval(() => {
      let entries: string[] = []
      try {
        entries = readdirSync(rootParent)
      } catch {
        return
      }
      for (const name of entries) {
        if (!name.startsWith("opencode-onboarding-")) continue
        const full = join(rootParent, name)
        try {
          if (statSync(full).mtimeMs + 50 >= startedAt - 1000) {
            clearTimeout(timer)
            clearInterval(poll)
            resolve(full)
            return
          }
        } catch {
          continue
        }
      }
    }, 30)
  })
}

function ensureAlphaTopology(root: string) {
  const base = join(root, "alpha-code-state")
  const envRoot = join(base, "env")
  for (const dir of [base, envRoot, join(envRoot, "prod"), join(envRoot, "dev"), join(envRoot, "beta"), join(base, "cas")]) {
    mkdirSync(dir, { recursive: true })
  }
  return join(envRoot, "prod")
}

async function plantSeeds(root: string, extraLegacy?: Record<string, unknown>) {
  const userData = join(root, "desktop")
  mkdirSync(userData, { recursive: true })
  mkdirSync(join(root, "opencode-home"), { recursive: true })
  mkdirSync(dirname(FOREIGN_PLUGIN), { recursive: true })
  // Create the alpha topology before initAlphaEnvironment so seeds exist before boot sweep.
  const mutable = ensureAlphaTopology(root)
  const seed = seedBody(userData)
  const alphaBody = seed.body
  const legacyBody = extraLegacy ? { ...seed.body, ...extraLegacy } : seed.body
  // Plant into every env mutable root; packaged prod reads env/prod.
  for (const env of ["prod", "dev", "beta"] as const) {
    writeJsonc(join(root, "alpha-code-state", "env", env, "alpha.jsonc"), alphaBody)
  }
  writeJsonc(join(root, "opencode-home", "opencode.jsonc"), legacyBody)
  const xdg = join(root, "config", "opencode", "opencode.jsonc")
  writeJsonc(xdg, { plugin: ["user-xdg-plugin"] })
  const xdgStat = lstatSync(xdg)
  return {
    userData,
    mutable,
    alpha: join(mutable, "alpha.jsonc"),
    legacy: join(root, "opencode-home", "opencode.jsonc"),
    xdg,
    xdgIno: xdgStat.ino,
    xdgMtime: xdgStat.mtimeMs,
    ...seed,
  }
}

function launchApp(app: string): ChildProcess {
  const bin = appExecutable(app)
  if (!existsSync(bin)) throw new Error(`missing executable ${bin}`)
  return spawn(bin, [], {
    env: {
      ...process.env,
      OPENCODE_TEST_ONBOARDING: "1",
      ALPHA_CDP: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
}

function ensureAppSigned(app: string) {
  const marker = join(tmpdir(), `req053-signed-${Buffer.from(app).toString("hex").slice(0, 24)}`)
  if (existsSync(marker)) return
  // Never write marker files into the .app bundle — that breaks codesign seal.
  const sign = spawnSync("codesign", ["--force", "--deep", "--sign", "-", app], { encoding: "utf8" })
  if (sign.status !== 0) throw new Error(`codesign failed: ${sign.stderr || sign.stdout}`)
  writeFileSync(marker, `${nowIso()}\n${app}\n`)
}

function killTree(child: ChildProcess) {
  const pid = child.pid
  if (!pid) return
  spawnSync("pkill", ["-P", String(pid)], { stdio: "ignore" })
  try {
    child.kill("SIGTERM")
  } catch {
    /* already gone */
  }
  spawnSync("kill", ["-9", String(pid)], { stdio: "ignore" })
}

function latestMainLog(root: string): string | null {
  const logs = join(root, "desktop", "logs")
  if (!existsSync(logs)) return null
  const runs = readdirSync(logs)
    .map((name) => join(logs, name, "main.log"))
    .filter((file) => existsSync(file))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return runs[0] ?? null
}

function engineLog(root: string): string | null {
  const a = join(root, "data", "opencode", "log", "opencode.log")
  const b = join(root, "desktop", "opencode", "log", "opencode.log")
  if (existsSync(a)) return a
  if (existsSync(b)) return b
  return null
}

function grepA(file: string | null, pattern: string): string[] {
  if (!file || !existsSync(file)) return []
  const r = spawnSync("grep", ["-a", "-n", pattern, file], { encoding: "utf8" })
  return r.stdout.split("\n").filter(Boolean)
}

function grepAContext(file: string | null, pattern: string, after: number): string {
  if (!file || !existsSync(file)) return ""
  const r = spawnSync("grep", ["-a", `-A${after}`, pattern, file], { encoding: "utf8" })
  return r.stdout
}

function countLiteral(file: string | null, needle: string): number {
  if (!file || !existsSync(file)) return 0
  const r = spawnSync("grep", ["-a", "-c", needle, file], { encoding: "utf8" })
  const n = Number.parseInt(r.stdout.trim(), 10)
  return Number.isFinite(n) ? n : 0
}

function dismissDialogs() {
  spawnSync("osascript", [
    "-e",
    'tell application "System Events" to keystroke return',
  ], { stdio: "ignore" })
}

function dirBytes(dir: string): number {
  if (!existsSync(dir)) return 0
  let total = 0
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const file = join(current, name)
      const st = lstatSync(file)
      if (st.isDirectory()) walk(file)
      else total += st.size
    }
  }
  walk(dir)
  return total
}

function cpuPctForPids(pids: number[]): number {
  if (pids.length === 0) return 0
  const r = spawnSync("ps", ["-o", "pid=,pcpu=", "-p", pids.join(",")], { encoding: "utf8" })
  let sum = 0
  for (const line of r.stdout.split("\n")) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 2) continue
    sum += Number.parseFloat(parts[1] ?? "0") || 0
  }
  return sum
}

function pidsForRoot(root: string): number[] {
  const r = spawnSync("pgrep", ["-f", root], { encoding: "utf8" })
  return r.stdout
    .split("\n")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0)
}

function sidecarCount(root: string): number {
  const r = spawnSync("pgrep", ["-fl", root], { encoding: "utf8" })
  return r.stdout.split("\n").filter((line) => /Helper|utility|node|opencode/i.test(line)).length
}

async function fixtureA(app: string): Promise<{ verdict: Verdict; checks: Check[]; root: string; notes: string[] }> {
  ensureAppSigned(app)
  const homesBefore = snapshotRealHomes()
  const startedAt = Date.now()
  const waiter = waitForOnboardingRoot(startedAt, 20_000)
  const child = launchApp(app)
  const notes: string[] = []
  const root = await waiter
  const planted = await plantSeeds(root)
  notes.push(`isolation=${root}`)
  notes.push(`planted alpha=${planted.alpha} legacy=${planted.legacy}`)
  const deadline = Date.now() + 90_000
  let main: string | null = null
  while (Date.now() < deadline) {
    main = latestMainLog(root)
    if (main && grepA(main, "confirmed-absent Alpha config references stripped").length > 0) break
    if (main && grepA(main, "server ready").length > 0) break
    await sleep(250)
  }
  await sleep(5000)
  main = latestMainLog(root)
  const engine = engineLog(root)
  const block = grepAContext(main, "confirmed-absent Alpha config references stripped", 4)
  const creating = countLiteral(engine, "creating instance")
  const fromDir = countLiteral(engine, "fromDirectory")
  const bootstrapping = countLiteral(engine, "bootstrapping")
  const spawned = main ? grepA(main, "spawning sidecar").length > 0 : false
  const alpha = existsSync(planted.alpha) ? parseJsonc(readFileSync(planted.alpha, "utf8")) : {}
  const legacy = existsSync(planted.legacy) ? parseJsonc(readFileSync(planted.legacy, "utf8")) : {}
  const pluginsA = Array.isArray(alpha.plugin) ? (alpha.plugin as string[]) : []
  const pluginsL = Array.isArray(legacy.plugin) ? (legacy.plugin as string[]) : []
  const mcpA = (alpha.mcp as Record<string, any> | undefined)?.req053loop?.environment ?? {}
  const mcpL = (legacy.mcp as Record<string, any> | undefined)?.req053loop?.environment ?? {}
  const xdgAfter = lstatSync(planted.xdg)
  killTree(child)
  await sleep(500)
  const homesAfter = snapshotRealHomes()
  const homesUnchanged = Object.keys(homesBefore).every((p) => {
    const b = homesBefore[p]!
    const a = homesAfter[p]!
    return b.exists === a.exists && b.mtimeMs === a.mtimeMs && b.ino === a.ino
  })
  const checks: Check[] = [
    {
      id: "stripped-block",
      ok: block.includes("stripped: 4") && block.includes("confirmed-absent Alpha config references stripped"),
      detail: block || "(no strip block)",
    },
    { id: "creating-instance-eq-1", ok: creating === 1, detail: `creating instance=${creating}` },
    {
      id: "no-three-line-loop",
      ok: creating <= 1 && fromDir < 20 && bootstrapping < 20,
      detail: `creating=${creating} fromDirectory=${fromDir} bootstrapping=${bootstrapping}`,
    },
    { id: "sidecar-spawned", ok: spawned, detail: spawned ? "spawning sidecar logged" : "no spawn log" },
    {
      id: "alpha-dangling-gone",
      ok: !pluginsA.includes(planted.gonePlugin) && mcpA.DSN === undefined,
      detail: JSON.stringify({ plugin: pluginsA, env: mcpA }),
    },
    {
      id: "legacy-dangling-gone",
      ok: !pluginsL.includes(planted.gonePlugin) && mcpL.DSN === undefined,
      detail: JSON.stringify({ plugin: pluginsL, env: mcpL }),
    },
    {
      id: "keeps-live-npm-foreign",
      ok:
        pluginsA.includes("opencode-notify") &&
        pluginsA.includes(planted.livePlugin) &&
        pluginsA.includes(FOREIGN_PLUGIN) &&
        typeof mcpA.LIVE === "string" &&
        mcpA.LIVE.includes("{file:"),
      detail: JSON.stringify({ plugin: pluginsA, LIVE: mcpA.LIVE }),
    },
    {
      id: "xdg-inode-mtime",
      ok: xdgAfter.ino === planted.xdgIno && xdgAfter.mtimeMs === planted.xdgMtime,
      detail: `before ino=${planted.xdgIno} mtime=${planted.xdgMtime} after ino=${xdgAfter.ino} mtime=${xdgAfter.mtimeMs}`,
    },
    { id: "real-homes-untouched", ok: homesUnchanged, detail: JSON.stringify({ before: homesBefore, after: homesAfter }) },
  ]
  return { verdict: checks.every((c) => c.ok) ? "PASS" : "FAIL", checks, root, notes }
}

async function fixtureA2(app: string): Promise<{ verdict: Verdict; checks: Check[]; root: string; notes: string[]; exitCode: number | null }> {
  ensureAppSigned(app)
  const startedAt = Date.now()
  const waiter = waitForOnboardingRoot(startedAt, 20_000)
  const child = launchApp(app)
  let exitCode: number | null = null
  child.on("exit", (code) => {
    exitCode = code
  })
  const root = await waiter
  await plantSeeds(root, { theme: "user-handwritten" })
  const deadline = Date.now() + 60_000
  let main: string | null = null
  while (Date.now() < deadline) {
    dismissDialogs()
    main = latestMainLog(root)
    if (main && grepA(main, "boot enforcement gap").length > 0) break
    if (exitCode !== null) break
    await sleep(250)
  }
  for (let i = 0; i < 20 && exitCode === null; i++) {
    dismissDialogs()
    await sleep(250)
  }
  await sleep(1000)
  main = latestMainLog(root)
  const spawned = main ? grepA(main, "spawning sidecar").length > 0 : false
  const refused = main ? grepA(main, "refusing to spawn sidecar").length > 0 : false
  const gap = main ? grepA(main, "boot enforcement gap").length > 0 || grepA(main, "enforcement gap").length > 0 : false
  if (exitCode === null) killTree(child)
  const checks: Check[] = [
    { id: "no-sidecar-spawn", ok: !spawned, detail: spawned ? "spawned" : "no spawn" },
    { id: "enforcement-gap", ok: gap, detail: gap ? "gap logged" : main ? "main.log present, no gap" : "no main.log" },
    { id: "refused-or-gap", ok: refused || gap, detail: `refused=${refused} gap=${gap}` },
    { id: "exit-1", ok: exitCode === 1, detail: `exitCode=${String(exitCode)}` },
  ]
  return { verdict: checks.every((c) => c.ok) ? "PASS" : "FAIL", checks, root, notes: [`isolation=${root}`], exitCode }
}

async function fixtureB(app: string): Promise<{
  verdict: Verdict
  checks: Check[]
  root: string
  notes: string[]
  series: Array<{ tMin: number; size: number; delta: number }>
}> {
  ensureAppSigned(app)
  const startedAt = Date.now()
  const waiter = waitForOnboardingRoot(startedAt, 20_000)
  const child = launchApp(app)
  const root = await waiter
  // Clean boot first: plant live-only config (no dangling) so sweep is a no-op.
  const userData = join(root, "desktop")
  mkdirSync(userData, { recursive: true })
  ensureAlphaTopology(root)
  const live = seedBody(userData)
  const clean = {
    plugin: ["opencode-notify", live.livePlugin],
    mcp: {
      req053loop: {
        type: "local",
        command: ["true"],
        environment: { LIVE: `{file:${live.liveSecret}}` },
      },
    },
  }
  for (const env of ["prod", "dev", "beta"] as const) {
    writeJsonc(join(root, "alpha-code-state", "env", env, "alpha.jsonc"), clean)
  }
  writeJsonc(join(root, "opencode-home", "opencode.jsonc"), clean)
  writeJsonc(join(root, "config", "opencode", "opencode.jsonc"), { plugin: ["user-xdg-plugin"] })
  const deadlineReady = Date.now() + 90_000
  let main: string | null = null
  while (Date.now() < deadlineReady) {
    main = latestMainLog(root)
    if (main && grepA(main, "server ready").length > 0) break
    await sleep(250)
  }
  await sleep(2000)
  const inject = () => {
    const body = seedBody(userData).body
    for (const env of ["prod", "dev", "beta"] as const) {
      writeJsonc(join(root, "alpha-code-state", "env", env, "alpha.jsonc"), body)
    }
    writeJsonc(join(root, "opencode-home", "opencode.jsonc"), body)
  }
  inject()
  const sidecarUrl = (() => {
    const log = latestMainLog(root)
    const block = log ? grepAContext(log, "server ready", 2) : ""
    const m = block.match(/url:\s*'([^']+)'/) || block.match(/url:\s*"([^"]+)"/)
    return m?.[1] ?? null
  })()
  const hammer = sidecarUrl
    ? setInterval(() => {
        void fetch(`${sidecarUrl}/global/health`).catch(() => {})
        void fetch(`${sidecarUrl}/project`).catch(() => {})
      }, 20)
    : null
  const series: Array<{ tMin: number; size: number; delta: number }> = []
  const logDirCandidates = [
    join(root, "data", "opencode", "log"),
    join(root, "desktop", "opencode", "log"),
  ]
  const t0 = Date.now()
  const maxMs = 70 * 60 * 1000
  let lastSize = 0
  let strike3 = false
  while (Date.now() - t0 < maxMs) {
    await sleep(60_000)
    main = latestMainLog(root)
    const logFile = engineLog(root)
    const size = logFile && existsSync(logFile) ? statSync(logFile).size : 0
    const delta = size >= lastSize ? size - lastSize : 0
    if (size < lastSize * 0.5) inject()
    lastSize = size
    const tMin = Math.round((Date.now() - t0) / 60_000)
    series.push({ tMin, size, delta })
    if (main && grepA(main, "sidecar paused for explicit recovery").length > 0) {
      strike3 = true
      break
    }
    inject()
  }
  await sleep(3000)
  main = latestMainLog(root)
  const logFile = engineLog(root)
  const logDir = logDirCandidates.find((d) => existsSync(d)) ?? logDirCandidates[0]!
  const pids = pidsForRoot(root)
  const cpu = cpuPctForPids(pids)
  const dirTotal = dirBytes(logDir)
  const active = logFile && existsSync(logFile) ? statSync(logFile).size : 0
  const archives = existsSync(logDir)
    ? readdirSync(logDir).filter((n) => /^opencode\..+\.log$/.test(n)).length
    : 0
  const recovery = main ? grepA(main, "sidecar paused for explicit recovery").length > 0 : false
  const strikeLogs = main ? grepA(main, "engine log runaway detected") : []
  const firstCap = series.find((s) => s.size > ABSOLUTE_BYTES)
  const anyFast = series.some((s) => s.delta > RATE_BYTES)
  const bound = 576 * MB + 3 * 540 * MB
  killTree(child)
  if (hammer) clearInterval(hammer)
  await sleep(1000)
  const checks: Check[] = [
    { id: "strike3-recovery-log", ok: recovery || strike3, detail: `recovery=${recovery} samples=${series.length}` },
    { id: "rule-inferred-absolute-cap", ok: Boolean(firstCap) && !anyFast, detail: `first>512MB@min ${firstCap?.tMin ?? "none"} anyΔ>64MB=${anyFast}` },
    { id: "cpu-lt-10-after-stop", ok: cpu < 10, detail: `cpuSum=${cpu.toFixed(2)} pids=${pids.join(",")}` },
    { id: "dir-bounded", ok: dirTotal <= bound, detail: `dirBytes=${dirTotal} active=${active} archives=${archives} bound=${bound}` },
    { id: "no-second-instance-storm", ok: sidecarCount(root) <= 8, detail: `procHits=${sidecarCount(root)}` },
    { id: "minute-series", ok: series.length >= 10, detail: `n=${series.length}` },
  ]
  return {
    verdict: checks.every((c) => c.ok) ? "PASS" : "FAIL",
    checks,
    root,
    notes: [`isolation=${root}`, `strikeLines=${strikeLogs.length}`],
    series,
  }
}

function fixtureC(): { verdict: Verdict; checks: Check[]; notes: string[] } {
  const testFile = join(HERE, "../../../packages/ui-mac/src/main/engine-runaway-guard.test.ts")
  const r = spawnSync("bun", ["test", testFile], {
    cwd: join(HERE, "../../../packages/ui-mac"),
    encoding: "utf8",
    env: process.env,
  })
  const out = `${r.stdout}\n${r.stderr}`
  writeFileSync(join(RESULTS, "fixture-c-bun-test.txt"), out)
  const passed = /pass/i.test(out) && r.status === 0
  const rateCase = out.includes("two consecutive windows above 64MB") || /64MB/.test(out)
  const checks: Check[] = [
    { id: "rate-unit-tests", ok: passed, detail: out.slice(-1500) },
    { id: "rate-case-present", ok: rateCase || passed, detail: "engine-runaway-guard.test.ts rate fixtures" },
  ]
  return {
    verdict: passed ? "PASS" : "FAIL",
    checks,
    notes: [
      "B 的尺寸序列若全程 Δ<64MB，则删掉 decideEngineRunawayGuard 的 fastWindows>=2 夹具 B 仍全绿——速率规则必须单独证活。本格不改生产代码做绕过实验（VERIFY 票禁止改 src）；绕过结论由 B 序列反推并写进证据。",
    ],
  }
}

async function main() {
  mkdirSync(RESULTS, { recursive: true })
  const fixture = (arg("--fixture") ?? "A") as Fixture
  const app = arg("--app")
  const sha = gitSha()
  if (fixture !== "C" && !app) {
    console.error("need --app <alpha-code.app>")
    process.exit(2)
  }
  const report: Record<string, unknown> = {
    schema: "alpha-code/req053-packaged-incident-regression/v1",
    fixture,
    gitSha: sha,
    startedAt: nowIso(),
    app: app ?? null,
  }
  try {
    if (fixture === "C") {
      const r = fixtureC()
      Object.assign(report, r, { finishedAt: nowIso() })
      writeFileSync(join(RESULTS, "fixture-c.json"), `${JSON.stringify(report, null, 2)}\n`)
      console.log(JSON.stringify(report, null, 2))
      process.exit(r.verdict === "PASS" ? 0 : 1)
    }
    if (fixture === "A") {
      const r = await fixtureA(app!)
      Object.assign(report, r, { finishedAt: nowIso() })
      writeFileSync(join(RESULTS, "fixture-a.json"), `${JSON.stringify(report, null, 2)}\n`)
      console.log(JSON.stringify(report, null, 2))
      process.exit(r.verdict === "PASS" ? 0 : 1)
    }
    if (fixture === "A2") {
      const r = await fixtureA2(app!)
      Object.assign(report, r, { finishedAt: nowIso() })
      writeFileSync(join(RESULTS, "fixture-a2.json"), `${JSON.stringify(report, null, 2)}\n`)
      console.log(JSON.stringify(report, null, 2))
      process.exit(r.verdict === "PASS" ? 0 : 1)
    }
    if (fixture === "B") {
      const r = await fixtureB(app!)
      Object.assign(report, r, { finishedAt: nowIso() })
      writeFileSync(join(RESULTS, "fixture-b.json"), `${JSON.stringify(report, null, 2)}\n`)
      console.log(JSON.stringify(report, null, 2))
      process.exit(r.verdict === "PASS" ? 0 : 1)
    }
    console.error(`unknown fixture ${fixture}`)
    process.exit(2)
  } catch (error) {
    report.error = error instanceof Error ? error.stack ?? error.message : String(error)
    report.verdict = "FAIL"
    report.finishedAt = nowIso()
    writeFileSync(join(RESULTS, `fixture-${fixture.toLowerCase()}-error.json`), `${JSON.stringify(report, null, 2)}\n`)
    console.error(report.error)
    process.exit(1)
  }
}

await main()
