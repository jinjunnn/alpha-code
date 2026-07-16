// #367 观察资产:CAS GC 单轮耗时基准 —— 真实 collectCasGarbage + 合成代表性 store。
// 用途:L3 packaged smoke 的耗时观察输入与容量画像(不是 CI gate —— 跨机器无硬阈值;
// 裁决 Q6);2026-07-16 三档实测数据见 issue #367 评论。
// 运行:bun packages/ui-mac/scripts/bench-cas-gc.ts
// 布局按权威真源:generations = <env>/ext-store/<key>/generations/gen-NNNNNN-hhhhhhhh/,
// CAS blob = <base>/cas/v1/sha256/<shard>/<digest>。
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { collectCasGarbage } from "../src/main/ext-cas-gc"

type Profile = {
  keys: number
  gens: number
  filesPerGen: number
  fileKB: number
  bigFilesPerGen: number
  bigFileMB: number
  blobs: number
  blobKB: number
}

// 便宜的伪随机内容:需要唯一 digest 时开头 4 字节唯一化,其余按字节模式填充 —— 哈希成本与内容无关。
let uniq = 0
function mkData(bytes: number, unique: boolean): Buffer {
  const b = Buffer.allocUnsafe(bytes)
  b.fill(uniq % 251)
  if (unique) b.writeUInt32LE(uniq >>> 0, 0)
  uniq++
  return b
}

function writeBlob(blobsDir: string, data: Buffer): void {
  const digest = crypto.createHash("sha256").update(data).digest("hex")
  const dir = path.join(blobsDir, digest.slice(0, 2))
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, digest)
  fs.writeFileSync(p, data)
  const old = new Date(Date.now() - 24 * 3600e3) // 出宽限窗 → sweepable
  fs.utimesSync(p, old, old)
}

function buildStore(name: string, p: Profile): { base: string; envRoot: string; genMB: number; blobMB: number; genFiles: number } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `casgc-bench-${name}-`))
  const envRoot = path.join(base, "env-prod")
  const blobsDir = path.join(base, "cas", "v1", "sha256")
  let genBytes = 0
  let genFiles = 0
  for (let k = 0; k < p.keys; k++) {
    const genRoot = path.join(envRoot, "ext-store", `skill--bench-${k}`, "generations")
    for (let g = 0; g < p.gens; g++) {
      const dir = path.join(genRoot, `gen-${String(g).padStart(6, "0")}-${crypto.randomBytes(4).toString("hex")}`)
      fs.mkdirSync(dir, { recursive: true })
      for (let f = 0; f < p.filesPerGen; f++) {
        const data = mkData(p.fileKB * 1024, false)
        fs.writeFileSync(path.join(dir, `f${f}.md`), data)
        genBytes += data.length
        genFiles++
      }
      for (let b = 0; b < p.bigFilesPerGen; b++) {
        const data = mkData(p.bigFileMB * 1024 * 1024, false)
        fs.writeFileSync(path.join(dir, `bundle${b}.js`), data)
        genBytes += data.length
        genFiles++
      }
    }
  }
  let blobBytes = 0
  for (let i = 0; i < p.blobs; i++) {
    const data = mkData(p.blobKB * 1024, true)
    writeBlob(blobsDir, data)
    blobBytes += data.length
  }
  return { base, envRoot, genMB: genBytes / 1048576, blobMB: blobBytes / 1048576, genFiles }
}

function bench(name: string, p: Profile): void {
  const { base, envRoot, genMB, blobMB, genFiles } = buildStore(name, p)
  const silent = () => {}
  const opts = { envRoots: [envRoot], seedLockPaths: [] as string[], graceMs: 3600e3, log: silent }
  const t0 = performance.now()
  const dry = collectCasGarbage(base, { ...opts, dryRun: true })
  const dryMs = performance.now() - t0
  const t1 = performance.now()
  const real = collectCasGarbage(base, { ...opts, dryRun: false })
  const realMs = performance.now() - t1
  // 第三轮:sweep 后重跑(稳态 = 无可扫时的纯 mark 成本,即每日常态)。
  const t2 = performance.now()
  const steady = collectCasGarbage(base, { ...opts, dryRun: false })
  const steadyMs = performance.now() - t2
  console.log(
    JSON.stringify({
      profile: name,
      store: { genMB: +genMB.toFixed(1), genFiles, blobMB: +blobMB.toFixed(1), blobs: p.blobs },
      dryRunMs: +dryMs.toFixed(1),
      sweepRoundMs: +realMs.toFixed(1),
      steadyRoundMs: +steadyMs.toFixed(1),
      check: { dryOk: dry.ok, marked: dry.marked, sweepable: dry.sweepable.length, swept: real.swept.length, steadyOk: steady.ok, ...(dry.reason ? { reason: dry.reason } : {}) },
    }),
  )
  fs.rmSync(base, { recursive: true, force: true })
}

// typical:轻度用户 —— 15 个扩展 × 2 代,小文件为主;300 个未引用 blob。
bench("typical", { keys: 15, gens: 2, filesPerGen: 20, fileKB: 20, bigFilesPerGen: 0, bigFileMB: 0, blobs: 300, blobKB: 30 })
// heavy:重度 —— 40 个扩展 × 3 代,含插件级大文件(每代 2×2MB);2000 blob。
bench("heavy", { keys: 40, gens: 3, filesPerGen: 40, fileKB: 30, bigFilesPerGen: 2, bigFileMB: 2, blobs: 2000, blobKB: 40 })
// extreme:上界压力 —— 60 × 4 代,每代 3×4MB 大文件;5000 blob。
bench("extreme", { keys: 60, gens: 4, filesPerGen: 60, fileKB: 40, bigFilesPerGen: 3, bigFileMB: 4, blobs: 5000, blobKB: 50 })
