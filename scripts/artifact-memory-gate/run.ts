// #1114 —— REQ-092 AC2 内存闸(alpha-work#1 AC2-a / AC2-b,owner 2026-08-25 裁决口径)。
//
// 判什么(两条都判,固定反例天天陪跑):
//   AC2-a 活内存:  采样时每 2ms 强制 full GC,peak(RSS) − baseline(RSS) ≤ 32 MiB(实测 +18.63);
//   AC2-b 驻留高水位:不强制 GC,同一量 ≤ 110 MiB(实测 +84.58;110 取在 84.58 与已知的坏
//                   140.34 之间 —— 放宽过 140,「整包 arrayBuffer 后落盘」的伪流式实现会全绿,
//                   而它的摘要与落盘字节**完全正确**,别的判据一条都抓不住它);
//   canary 反例:   buffer 臂(整包 arrayBuffer)每一轮都必须**超过** 110 —— 这是「先证明尺子
//                   量得出已知的坏,再用它判未知的好」:反例量不红 ⇒ 本次测量作废,不是 PASS。
//
// 量法(四条口径缺一 ⇒ 打印「本次测量作废」退出 3,**不给数字当结论**):
//   ① 出货运行时 = Electron(ELECTRON_RUN_AS_NODE=1;子进程必须报出 process.versions.electron)。
//      bun 上同一份生产代码实测 +249~393 MiB,差 3~4 倍 —— 用 bun 判 AC2 判的是 bun。
//   ② 一臂一进程(RSS 是进程级高水位,同进程连跑会朝好看的方向偏);父进程核对全部 pid 互异。
//   ③ origin = 独立进程的裸 socket HTTP/1.1(scripts/artifact-memory-gate/origin-raw.ts,逐字
//      拷贝自 #402 已标定的那份),测量前先标定:声明 Content-Length 正确、全量字节可达、
//      内容摘要与夹具钉住值一致(独立客户端 + /usr/bin/shasum,不经被测代码)。
//   ④ 每臂 3 轮,报每轮值与离散度(max − min)。
//
// 不在 alpha-check / CI 权威门内(单轮 ~20s、依赖本机 electron 二进制),与
// scripts/req087-live-characterization.sh 同级:按需 / 改动传输路径后 / 发布前人工执行。
//   bash scripts/artifact-memory-gate.sh
// 退出码:0 = PASS;1 = FAIL(生产路径超限,或臂本身失败);3 = 本次测量作废(口径不满足)。
//
// 证据链:量法与数字全部来自 #402 取证
// (docs/verification/2026-08-25-req092-402-artifact-transfer/README.md §1 §格2),
// 阈值来自 owner 在 #1114 的裁决评论 —— 都是**独立字面量**,不 import 生产常量。
import { spawn, spawnSync } from "node:child_process"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const REPO = path.resolve(import.meta.dir, "../..")
const ELECTRON = path.join(REPO, "packages/ui-mac/node_modules/.bin/electron")

// ---- 阈值(独立字面量;出处见抬头)----
const AC2A_LIMIT_BYTES = 32 * 1024 * 1024
const AC2B_LIMIT_BYTES = 110 * 1024 * 1024
const ROUNDS = 3
/** 采样器完好性下限:挡的是「采样器根本没跑 ⇒ peak≈baseline 假绿」。首轮实测各臂样本数:
 *  stream-gc 368–499、stream 55–56、buffer 20–23(buffer 臂的 arrayBuffer 物化会把 2ms 定时器
 *  拉伸到 ~5ms 有效间隔,109ms 里只落 20 个 —— 下限取 10,既抓得住死掉的采样器,又不在
 *  更快的机器上把 canary 臂假作废)。 */
const MIN_SAMPLES = 10

// ---- 夹具(确定性 LCG;钉住摘要为**独立常量**,由 /usr/bin/shasum 复核)----
// 生成器或参数被改动 ⇒ 摘要不再匹配 ⇒ 作废(而不是拿另一份内容静默测下去)。
const FIXTURE_SIZE = 100 * 1024 * 1024
const WARMUP_SIZE = 1024
const FIXTURE_SHA256 = "898e0fde7d4034b40ed8a362eddb10f48f76f16ca18ef071aa72a89cfb78bb47"
const WARMUP_SHA256 = "008431a97da708be8f4cd3230cb5d04d734ff124c3a73edaf3711c46ab10f11c"

function writeLcgFixture(file: string, bytes: number, seed: number): void {
  const words = bytes / 4
  const block = new Uint32Array(64 * 1024) // 256 KiB / 块
  let state = seed >>> 0
  const fd = fs.openSync(file, "w")
  try {
    let written = 0
    while (written < words) {
      const n = Math.min(block.length, words - written)
      for (let i = 0; i < n; i++) {
        // 数值经典 LCG(Numerical Recipes 参数);非加密,只求确定性 + 不可压缩形态。
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0
        block[i] = state
      }
      fs.writeSync(fd, Buffer.from(block.buffer, 0, n * 4))
      written += n
    }
  } finally {
    fs.closeSync(fd)
  }
}

/** 第三方摘要(/usr/bin/shasum),不经被测代码、不经本进程的 node:crypto。 */
function shasumOf(file: string): string {
  const r = spawnSync("/usr/bin/shasum", ["-a", "256", file], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`shasum failed: ${r.stderr}`)
  return r.stdout.trim().split(/\s+/)[0]
}

// ---- 作废通道:口径不满足时唯一的出口 ----
// ⚠️ process.exit 不跑 finally ⇒ 在 origin 已启动之后**禁止**直接 invalidate(会把继承了
// stderr 的 origin 子进程留成孤儿,任何 `… | tail` 形式的调用都会因管道不 EOF 而永远挂起 ——
// 首轮实测踩到)。origin 存活期间一律走 invalidReturn,让 finally 先 stop 再退。
function invalidate(reasons: string[]): never {
  printInvalid(reasons)
  process.exit(3)
}
function invalidReturn(reasons: string[]): number {
  printInvalid(reasons)
  return 3
}
function printInvalid(reasons: string[]): void {
  console.error("\n════════════════════════════════════════")
  console.error("本次测量作废(不给数字)。未满足的口径:")
  for (const r of reasons) console.error(`  ✗ ${r}`)
  console.error("════════════════════════════════════════")
}

// ---- origin ----
type Origin = { base: string; stop: () => void }
async function startOrigin(fixtureDir: string): Promise<Origin> {
  const child = spawn(process.execPath, [path.join(import.meta.dir, "origin-raw.ts"), fixtureDir], {
    stdio: ["ignore", "pipe", "inherit"],
  })
  const port = await new Promise<number>((resolve, reject) => {
    let buf = ""
    const t = setTimeout(() => {
      child.kill("SIGKILL") // 启动失败也不许留孤儿(孤儿握着继承的 stderr,会让 `… | tail` 永远挂起)
      reject(new Error("origin did not start in 10s"))
    }, 10_000)
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString()
      const nl = buf.indexOf("\n")
      if (nl >= 0) {
        clearTimeout(t)
        resolve(JSON.parse(buf.slice(0, nl)).port as number)
      }
    })
    child.on("exit", (code) => reject(new Error(`origin exited early: ${code}`)))
  })
  return { base: `http://127.0.0.1:${port}`, stop: () => child.kill("SIGKILL") }
}

const seg = (base: string, params: Record<string, string>) =>
  `${base}/v1/cloud/artifacts/${Object.entries(params)
    .map(([k, v]) => `${k}_${v}`)
    .join("--")}/content`

/** 标定(口径③):独立朴素客户端逐字节读完,核对声明长度 / 实收 / 内容摘要。 */
async function calibrate(base: string): Promise<string[]> {
  const problems: string[] = []
  const readAll = async (url: string) => {
    const res = await fetch(url, { headers: { authorization: "Bearer calibration" } })
    const declared = res.headers.get("content-length")
    const hash = crypto.createHash("sha256")
    let read = 0
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    for (;;) {
      const r = await reader.read()
      if (r.done) break
      read += r.value.byteLength
      hash.update(r.value)
    }
    return { declared, read, sha: hash.digest("hex") }
  }
  const big = await readAll(seg(base, { file: "big100.bin", probe: "cal-big" }))
  if (big.declared !== String(FIXTURE_SIZE))
    problems.push(`标定:origin 对 100 MiB 声明 content-length=${big.declared},应为 ${FIXTURE_SIZE}`)
  if (big.read !== FIXTURE_SIZE) problems.push(`标定:朴素客户端实收 ${big.read} 字节,应为 ${FIXTURE_SIZE}`)
  if (big.sha !== FIXTURE_SHA256) problems.push(`标定:100 MiB 内容摘要 ${big.sha} ≠ 钉住值 ${FIXTURE_SHA256}`)
  const tiny = await readAll(seg(base, { file: "tiny.bin", probe: "cal-tiny" }))
  if (tiny.read !== WARMUP_SIZE || tiny.sha !== WARMUP_SHA256)
    problems.push(`标定:1 KiB 预热夹具实收 ${tiny.read} 字节 / 摘要 ${tiny.sha},与钉住值不符`)
  return problems
}

// ---- 测量臂 ----
type ArmRow = {
  pid: number
  electronVersion: string | null
  nodeVersion: string
  mode: string
  gcPressure: boolean
  gcAvailable: boolean
  baseline: number
  peak: number
  deltaBytes: number
  deltaMiB: number
  samples: number
  elapsedMs: number
  sha: string
  diskSize: number | null
  outcome: { ok?: boolean } & Record<string, unknown>
}

function runArm(bundle: string, base: string, mode: string): ArmRow | { failed: true; detail: string } {
  const r = spawnSync(
    ELECTRON,
    [bundle, mode, base, "big100.bin", FIXTURE_SHA256, String(FIXTURE_SIZE), "tiny.bin"],
    {
      encoding: "utf8",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 180_000,
    },
  )
  const line = r.stdout
    .trim()
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .pop()
  if (r.status !== 0 || !line) {
    return { failed: true, detail: `exit=${r.status}\nstdout:${r.stdout.slice(-2000)}\nstderr:${r.stderr.slice(-2000)}` }
  }
  return JSON.parse(line) as ArmRow
}

const fmtMiB = (bytes: number) => `${(bytes / 1048576).toFixed(2)} MiB`

async function main(): Promise<number> {
  // ── 前置(口径①):出货运行时可用 ────────────────────────────────────────────
  if (!fs.existsSync(ELECTRON)) {
    invalidate([`口径①:找不到 electron 二进制(${ELECTRON})——「出货运行时」缺席;先在 packages/ui-mac 完成安装`])
  }

  // ── 夹具:确定性生成 + 第三方摘要钉住 ───────────────────────────────────────
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-1114-gate-"))
  const fixtureDir = path.join(work, "fixtures")
  fs.mkdirSync(fixtureDir)
  console.error("[1/5] 生成夹具(确定性 LCG)…")
  writeLcgFixture(path.join(fixtureDir, "big100.bin"), FIXTURE_SIZE, 0x1114)
  writeLcgFixture(path.join(fixtureDir, "tiny.bin"), WARMUP_SIZE, 0x7ea)
  const bigSha = shasumOf(path.join(fixtureDir, "big100.bin"))
  const tinySha = shasumOf(path.join(fixtureDir, "tiny.bin"))
  if (bigSha !== FIXTURE_SHA256 || tinySha !== WARMUP_SHA256) {
    invalidate([
      `夹具摘要与钉住值不符(big100 ${bigSha} vs ${FIXTURE_SHA256};tiny ${tinySha} vs ${WARMUP_SHA256})——生成器被改动`,
    ])
  }

  // ── 打包测量臂(生产代码经 bun build --target=node,与 #402 取证同一形态)────
  console.error("[2/5] 打包测量臂…")
  const bundle = path.join(work, "arm.mjs")
  const build = spawnSync(
    "bun",
    ["build", "--target=node", "--format=esm", path.join(import.meta.dir, "arm.ts"), "--outfile", bundle],
    { encoding: "utf8" },
  )
  if (build.status !== 0) invalidate([`测量臂打包失败:\n${build.stdout}\n${build.stderr}`])

  // ── origin(口径③):独立进程裸 socket + 标定 ────────────────────────────────
  console.error("[3/5] 起 origin 并标定…")
  const origin = await startOrigin(fixtureDir)
  try {
    const calibrationProblems = await calibrate(origin.base)
    if (calibrationProblems.length) return invalidReturn(calibrationProblems)
    console.error("      标定通过(声明长度 / 实收 / 摘要三点一致)")

    // ── 测量:3 轮 ×(AC2-a 臂 + AC2-b 臂 + canary 反例臂),一臂一进程,串行 ────
    console.error(`[4/5] 测量(${ROUNDS} 轮 × 3 臂,一臂一进程,串行)…`)
    const rows: Record<"stream-gc" | "stream" | "buffer", ArmRow[]> = { "stream-gc": [], stream: [], buffer: [] }
    const productFailures: string[] = []
    for (let round = 1; round <= ROUNDS; round++) {
      for (const mode of ["stream-gc", "stream", "buffer"] as const) {
        const row = runArm(bundle, origin.base, mode)
        if ("failed" in row) {
          productFailures.push(`round ${round} ${mode}: 臂进程失败 —— ${row.detail}`)
          continue
        }
        rows[mode].push(row)
        console.error(
          `      r${round} ${mode.padEnd(9)} Δ=${fmtMiB(row.deltaBytes).padStart(11)}  samples=${row.samples}  ${row.elapsedMs}ms  pid=${row.pid}`,
        )
      }
    }

    // ── 口径核对(缺一即作废,不给数字)───────────────────────────────────────
    const validity: string[] = []
    const all = [...rows["stream-gc"], ...rows.stream, ...rows.buffer]
    for (const row of all) {
      if (!row.electronVersion)
        validity.push(`口径①:${row.mode} 臂运行时不是 Electron(versions.electron 缺席,实际 node ${row.nodeVersion})`)
      if (row.samples < MIN_SAMPLES)
        validity.push(`采样器完好性:${row.mode} 臂只采到 ${row.samples} 个样本(< ${MIN_SAMPLES})—— peak 不可信`)
    }
    const pids = all.map((r) => r.pid)
    if (new Set(pids).size !== pids.length) validity.push(`口径②:臂进程 pid 出现重复(${pids.join(",")})—— 不是一臂一进程`)
    for (const row of rows["stream-gc"]) {
      if (!row.gcAvailable) validity.push("口径(AC2-a):强制 GC 臂拿不到 gc 句柄 —— 活内存测量无效")
    }
    for (const [mode, expected] of [
      ["stream-gc", ROUNDS],
      ["stream", ROUNDS],
      ["buffer", ROUNDS],
    ] as const) {
      if (rows[mode].length !== expected && productFailures.length === 0)
        validity.push(`口径④:${mode} 臂只有 ${rows[mode].length}/${expected} 轮`)
    }
    // 臂结局完整性:测的必须是「一次真实成功的 100 MiB 传输」。断言到字节与第三方无关摘要,
    // 否则一条静默失败(下载 0 字节)的臂会以「峰值极低」的假绿通过内存限。
    for (const row of [...rows["stream-gc"], ...rows.stream]) {
      if (row.outcome?.ok !== true || row.diskSize !== FIXTURE_SIZE || row.sha !== FIXTURE_SHA256)
        productFailures.push(
          `${row.mode} 臂的传输不完整:outcome=${JSON.stringify(row.outcome)} diskSize=${row.diskSize} sha=${row.sha}`,
        )
    }
    for (const row of rows.buffer) {
      if (row.diskSize !== FIXTURE_SIZE || row.sha !== FIXTURE_SHA256)
        validity.push(`canary 臂传输不完整(diskSize=${row.diskSize} sha=${row.sha})—— 反例没有真的发生`)
    }
    // canary:已知的坏必须超过 AC2-b 上限,否则这把尺子对「伪流式」失明 ⇒ 作废。
    for (const row of rows.buffer) {
      if (row.deltaBytes <= AC2B_LIMIT_BYTES)
        validity.push(
          `canary:整包 arrayBuffer 反例 Δ=${fmtMiB(row.deltaBytes)} 未超过 AC2-b 上限 ${fmtMiB(AC2B_LIMIT_BYTES)} —— 尺子量不出已知的坏(#402 实测该形态 +140.34 MiB)`,
        )
    }
    if (validity.length) return invalidReturn(validity)
    if (productFailures.length) {
      console.error("\n✗ FAIL —— 测量臂里的生产路径失败:")
      for (const f of productFailures) console.error(`  ${f}`)
      return 1
    }

    // ── 判决(口径④:全轮 + 离散度)─────────────────────────────────────────────
    console.error("[5/5] 判决…\n")
    const spread = (list: ArmRow[]) => Math.max(...list.map((r) => r.deltaBytes)) - Math.min(...list.map((r) => r.deltaBytes))
    const report = (label: string, list: ArmRow[], limit: number, mustBeUnder: boolean) => {
      const deltas = list.map((r) => r.deltaBytes)
      const ok = mustBeUnder ? deltas.every((d) => d <= limit) : deltas.every((d) => d > limit)
      console.error(
        `${ok ? "✓" : "✗"} ${label}: [${deltas.map(fmtMiB).join(", ")}] ${mustBeUnder ? "≤" : ">"} ${fmtMiB(limit)}  离散度=${fmtMiB(spread(list))}`,
      )
      return ok
    }
    const a = report("AC2-a 活内存(强制 GC) ", rows["stream-gc"], AC2A_LIMIT_BYTES, true)
    const b = report("AC2-b 驻留高水位        ", rows.stream, AC2B_LIMIT_BYTES, true)
    report("canary 整包 arrayBuffer ", rows.buffer, AC2B_LIMIT_BYTES, false) // 已在 validity 里强制

    if (a && b) {
      console.error("\n✅ artifact-memory-gate PASS(AC2-a ≤ 32 MiB / AC2-b ≤ 110 MiB,3 轮全过,反例翻红能力已当轮自证)")
      return 0
    }
    console.error("\n✗ artifact-memory-gate FAIL —— 生产传输路径的内存形态超过 owner 裁定的上限")
    return 1
  } finally {
    origin.stop()
    fs.rmSync(work, { recursive: true, force: true })
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e)
    invalidate([`编排器自身异常:${e instanceof Error ? e.message : String(e)}`])
  },
)
