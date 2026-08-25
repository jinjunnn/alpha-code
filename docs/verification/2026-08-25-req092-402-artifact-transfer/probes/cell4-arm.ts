// alpha-code#402 格 4 —— 断流 / 取消 / 摘要不符 / 磁盘写满 / 重试(AC4)。
//
// 这一格最容易假绿的地方是「没残留」:目录里没看见 `.part`,可能是因为**根本没开始写**。
// 所以每一条都要先证明这次真的写到过盘(或者真的收过字节),再判残留。
// 残留检测器本身也先用**已知的坏**标定(C4.0)。
//
// ENOSPC 用真的小卷(hdiutil ram:// + HFS+),不是 mock 出来的 errno。
//
// 用法:node bundle.mjs <originBase> <fixtureDir> <projectDir> [tinyVolumePath]
import * as fs from "node:fs"
import * as path from "node:path"
import { downloadArtifactToFile } from "../../../../packages/ui-mac/src/main/alpha-artifact-download"

const [originBase, fixtureDir, projectDir, tinyVolume] = process.argv.slice(2)
const TOKEN = "PROBE-TOKEN-402-9f3c1d7a-DO-NOT-LEAK"

const seg = (params: Record<string, string | number>) =>
  `/v1/cloud/artifacts/${Object.entries(params)
    .map(([k, v]) => `${k}_${v}`)
    .join("--")}/content`

let n = 0
function descriptor(params: Record<string, string | number>, over: Record<string, unknown> = {}) {
  const runId = `job_c4${(n++).toString(36).padStart(3, "0")}`
  return {
    schemaVersion: 1,
    id: `art_${runId}_0_ab12cd34`,
    source: "cloud",
    name: "x.bin",
    trust: "sandboxed",
    role: "primary",
    contentRef: { kind: "http-stream", url: seg(params), auth: "bearer" },
    verification: { status: "unverified" },
    provenance: { producer: "pipeline", jobId: runId },
    ...over,
  }
}

const rename = (i: { partPath: string; targetPath: string }) => {
  fs.renameSync(i.partPath, i.targetPath)
  return { ok: true as const }
}

async function stats(probe: string) {
  const r = await fetch(`${originBase}/__stats?probe=${encodeURIComponent(probe)}`)
  return (await r.json()) as {
    requests: number
    /** origin 真正推出 socket 的 body 字节数(裸 socket origin;不是「打算发多少」)。 */
    written: number
    clientAbortedEarly: number
    writtenAtAbort: number[]
    declaredContentLength: (string | null)[]
    statuses: number[]
    ranges: (string | null)[]
  }
}

/** 残留 = 目录里除 expected 之外的一切。`.part` 单独点名,便于在结果里一眼看见。 */
function residue(dir: string, expected: string[] = []) {
  const all = fs.readdirSync(dir)
  return { all, unexpected: all.filter((f) => !expected.includes(f)), parts: all.filter((f) => f.endsWith(".part")) }
}

async function download(dir: string, artifact: unknown, deps: Record<string, unknown> = {}, req: Record<string, unknown> = {}) {
  return downloadArtifactToFile(
    { artifact, targetPath: path.join(dir, "out.bin"), ...req },
    { token: TOKEN, base: originBase, finalize: rename, ...deps },
  )
}

const SMALL_SHA_WRONG = "0".repeat(64)

type Case = { id: string; what: string; run: (dir: string) => Promise<unknown> }

const cases: Case[] = [
  {
    id: "C4.0",
    what: "标定:残留检测器对一个真放进去的 `.part` 必须报警(否则后面每条「无残留」都是假绿)",
    run: async (dir) => {
      fs.writeFileSync(path.join(dir, "out.bin.deadbeef-1-2-aabbccdd.part"), "x")
      const r = residue(dir)
      fs.rmSync(path.join(dir, "out.bin.deadbeef-1-2-aabbccdd.part"))
      return { detected: r, afterCleanup: residue(dir) }
    },
  },
  {
    id: "C4.1",
    what: "断流:origin 发 1 MiB 后重置连接 → typed network 错误,零残留,detail 不含 token",
    run: async (dir) => {
      const outcome = await download(
        dir,
        descriptor({ file: "big100.bin", probe: "c4_1", mode: "reset", after: 1048576, total: 8388608 }),
      )
      const o = await stats("c4_1")
      return {
        outcome,
        origin: o,
        residue: residue(dir),
        actuallyStreamedBytes: o.written,
        detailHasToken: JSON.stringify(outcome).includes(TOKEN),
      }
    },
  },
  {
    id: "C4.2",
    what: "流中途取消:真 AbortSignal → {error:cancelled, cancelled:true},零残留,上游被 cancel",
    run: async (dir) => {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 300)
      const outcome = await download(
        dir,
        descriptor({ file: "big100.bin", probe: "c4_2", mode: "chunked", total: 104857600, delayMs: 4 }),
        {},
        { signal: ctrl.signal },
      )
      clearTimeout(t)
      const o = await stats("c4_2")
      return { outcome, origin: o, residue: residue(dir), streamedBeforeCancel: o.written }
    },
  },
  {
    id: "C4.3",
    what: "发起前就取消:零网络,且仍带结构槽 cancelled:true(平台的任何字节都到不了这个槽)",
    run: async (dir) => {
      const ctrl = new AbortController()
      ctrl.abort()
      const outcome = await download(dir, descriptor({ file: "small.bin", probe: "c4_3" }), {}, { signal: ctrl.signal })
      return { outcome, origin: await stats("c4_3"), residue: residue(dir) }
    },
  },
  {
    id: "C4.4",
    what: "descriptor 摘要不符 → sha256-mismatch;字节收全了才判,所以必须确认盘上不留 final/.part",
    run: async (dir) => {
      const outcome = await download(
        dir,
        descriptor({ file: "small.bin", probe: "c4_4" }, { sha256: SMALL_SHA_WRONG, size: 3145728 }),
      )
      const o = await stats("c4_4")
      return { outcome, origin: o, receivedAllBytes: o.written, residue: residue(dir) }
    },
  },
  {
    id: "C4.5",
    what: "descriptor 摘要与 ETag 互相矛盾 → 读 body 前即拒(origin 几乎没发出字节)",
    run: async (dir) => {
      const outcome = await download(
        dir,
        descriptor(
          // origin-raw 用 `~` 代替 `"`(平台契约不允许 contentRef.url 带 query,参数只能走路径段)
          { file: "small.bin", probe: "c4_5", etag: `~sha256:${"1".repeat(64)}~` },
          { sha256: SMALL_SHA_WRONG },
        ),
      )
      return { outcome, origin: await stats("c4_5"), residue: residue(dir) }
    },
  },
  {
    id: "C4.6",
    what: "真 ENOSPC:目标落在一个只剩几百 KiB 的真实卷上,3 MiB 写到一半写满 → typed disk 错误,卷上零残留",
    run: async () => {
      if (!tinyVolume) return { skipped: "no tiny volume provided" }
      const dir = path.join(tinyVolume, "dl")
      fs.mkdirSync(dir, { recursive: true })
      const before = fs.readdirSync(dir)
      const outcome = await download(dir, descriptor({ file: "small.bin", probe: "c4_6" }))
      const o = await stats("c4_6")
      return {
        outcome,
        origin: o,
        residue: residue(dir),
        before,
        detailMentionsEnospc: JSON.stringify(outcome).includes("ENOSPC"),
        detailHasToken: JSON.stringify(outcome).includes(TOKEN),
      }
    },
  },
  {
    id: "C4.7",
    what: "失败后重试同一件:成功落盘,且目录里只有 final(旧 `.part` 不许幸存)",
    run: async (dir) => {
      const first = await download(
        dir,
        descriptor({ file: "big100.bin", probe: "c4_7a", mode: "reset", after: 1048576, total: 8388608 }),
      )
      const midResidue = residue(dir)
      const second = await download(dir, descriptor({ file: "small.bin", probe: "c4_7b" }))
      const out = path.join(dir, "out.bin")
      return {
        first,
        midResidue,
        second,
        residue: residue(dir, ["out.bin"]),
        finalSize: fs.existsSync(out) ? fs.statSync(out).size : null,
      }
    },
  },
  {
    id: "C4.8",
    what: "僵死连接(发 1 MiB 后永久静默)+ 5s idle 看门狗 → typed network 错误,promise 不悬挂",
    run: async (dir) => {
      const t0 = Date.now()
      const outcome = await download(
        dir,
        descriptor({ file: "big100.bin", probe: "c4_8", mode: "stall", after: 1048576, total: 104857600 }),
        { idleTimeoutMs: 5000 },
      )
      return { outcome, elapsedMs: Date.now() - t0, origin: await stats("c4_8"), residue: residue(dir) }
    },
  },
  {
    id: "C4.9",
    what: "finalizer 拒绝准入(配额侧说不)→ 分类错误 + `.part` 被删,不留半成品",
    run: async (dir) => {
      const outcome = await downloadArtifactToFile(
        { artifact: descriptor({ file: "small.bin", probe: "c4_9" }), targetPath: path.join(dir, "out.bin") },
        {
          token: TOKEN,
          base: originBase,
          finalize: () => ({ ok: false as const, error: "over-limit" as const, detail: "probe: quota says no" }),
        },
      )
      return { outcome, origin: await stats("c4_9"), residue: residue(dir) }
    },
  },
]

async function main() {
  const out: Record<string, unknown>[] = []
  for (const c of cases) {
    const dir = fs.mkdtempSync(path.join(projectDir, "c4-"))
    let value: unknown
    let error: string | null = null
    try {
      value = await c.run(dir)
    } catch (e) {
      error = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    }
    out.push({ id: c.id, what: c.what, value, error })
    fs.rmSync(dir, { recursive: true, force: true })
  }
  process.stdout.write(
    `${JSON.stringify({
      runtime: process.versions.electron
        ? `electron ${process.versions.electron} / node ${process.versions.node}`
        : `node ${process.versions.node}`,
      tinyVolume: tinyVolume ?? null,
      cases: out,
    })}\n`,
  )
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e)
    process.exit(1)
  },
)
