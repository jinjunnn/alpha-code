// alpha-code#402 格 3 —— 限额闸(AC3)。在**出货运行时**上跑真 fetch / 真 socket。
//
// 判据不是「错误码对不对」。错误码对而字节照收,是这一格最典型的假绿。
// 每一条都同时问 origin:**你到底往这条连接上发出去了多少字节、客户端有没有把流 cancel 掉**,
// 并在盘上确认既无 final 也无 `.part`。
//
// 用法:node bundle.mjs <originBase> <fixtureDir> <projectDir>
import * as fs from "node:fs"
import * as path from "node:path"
import { downloadArtifactToFile } from "../../../../packages/ui-mac/src/main/alpha-artifact-download"

const [originBase, fixtureDir, projectDir] = process.argv.slice(2)
const TOKEN = "PROBE-TOKEN-402-9f3c1d7a-DO-NOT-LEAK"

/** 独立锚点:平台契约 artifact-descriptor.schema.json 的 size.maximum。不 import 生产常量。 */
const CONTRACT_MAX = 104857600

const seg = (params: Record<string, string | number>) =>
  `/v1/cloud/artifacts/${Object.entries(params)
    .map(([k, v]) => `${k}_${v}`)
    .join("--")}/content`

import * as crypto from "node:crypto"
/** 独立字面量:两个夹具摘要由 /usr/bin/shasum 与 python hashlib 各算一遍、逐字相同(见 README §夹具)。 */
const SMALL_FULL_SHA = "3758d9e6a0f4fba5f4d4eb53f461ff2285f60ff36912d1c226646f68dcdd81fb"
const SMALL_FIRST_MIB_SHA = "62cee74bd18a6895a5c0260025ed08c8fc0ae6ea73efa70576d911fd08510a77"
const shaOf = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex")

let n = 0
function descriptor(params: Record<string, string | number>, over: Record<string, unknown> = {}) {
  const runId = `job_c3${(n++).toString(36).padStart(3, "0")}`
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

/** 目录里除 expected 之外的一切都是残留(尤其 `.part`)。 */
function residue(dir: string, expected: string[] = []) {
  return fs.readdirSync(dir).filter((f) => !expected.includes(f))
}

type Case = {
  id: string
  what: string
  probe: string
  run: (dir: string) => Promise<unknown>
}

const rename = (i: { partPath: string; targetPath: string }) => {
  fs.renameSync(i.partPath, i.targetPath)
  return { ok: true as const }
}

async function download(dir: string, artifact: unknown, maxBytes?: number, extra: Record<string, unknown> = {}) {
  return downloadArtifactToFile(
    { artifact, targetPath: path.join(dir, "out.bin"), ...extra },
    { token: TOKEN, base: originBase, finalize: rename, ...(maxBytes !== undefined ? { maxBytes } : {}) },
  )
}

const cases: Case[] = [
  {
    id: "C3.1",
    what: "descriptor.size 越过契约上限 → 零网络拒绝(连请求都不发)",
    probe: "c3_1",
    run: async (dir) => {
      const t0 = Date.now()
      const outcome = await download(dir, descriptor({ file: "big100.bin", probe: "c3_1" }, { size: CONTRACT_MAX + 1 }))
      return { outcome, elapsedMs: Date.now() - t0, origin: await stats("c3_1"), residue: residue(dir) }
    },
  },
  {
    id: "C3.2",
    what: "descriptor.size 恰好等于上限 → 不被这道闸拦(边界的另一侧)",
    probe: "c3_2",
    run: async (dir) => {
      const outcome = await download(
        dir,
        descriptor({ file: "big100.bin", probe: "c3_2" }, { size: CONTRACT_MAX }),
      )
      return {
        outcome,
        origin: await stats("c3_2"),
        residue: residue(dir, ["out.bin"]),
        finalSize: fs.existsSync(path.join(dir, "out.bin")) ? fs.statSync(path.join(dir, "out.bin")).size : null,
      }
    },
  },
  {
    id: "C3.3",
    what: "Content-Length 越限(声明 200 MiB)→ 读 body 前拒绝:origin 只被逼出 socket 缓冲那点字节并被 cancel",
    probe: "c3_3",
    run: async (dir) => {
      const t0 = Date.now()
      const outcome = await download(
        dir,
        descriptor({ file: "big100.bin", probe: "c3_3", mode: "declare", declare: 209715200, total: 209715200 }),
      )
      return { outcome, elapsedMs: Date.now() - t0, origin: await stats("c3_3"), residue: residue(dir) }
    },
  },
  {
    id: "C3.3-control",
    what: "同一条路由,换成「读完整个 body」的朴素客户端 → origin 发满 200 MiB(证明尺子量得出没有闸的样子)",
    probe: "c3_3c",
    run: async () => {
      const t0 = Date.now()
      const res = await fetch(
        `${originBase}${seg({ file: "big100.bin", probe: "c3_3c", mode: "declare", declare: 209715200, total: 209715200 })}`,
        { headers: { authorization: `Bearer ${TOKEN}` } },
      )
      let got = 0
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) got += chunk.byteLength
      return { bytesRead: got, elapsedMs: Date.now() - t0, origin: await stats("c3_3c") }
    },
  },
  {
    id: "C3.4",
    what: "Content-Length = 上限 + 1 → 拒(边界:恰好越一个字节)",
    probe: "c3_4",
    run: async (dir) => {
      const outcome = await download(
        dir,
        descriptor({ file: "big100.bin", probe: "c3_4", mode: "declare", declare: CONTRACT_MAX + 1, total: CONTRACT_MAX + 1 }),
      )
      return { outcome, origin: await stats("c3_4"), residue: residue(dir) }
    },
  },
  {
    id: "C3.5",
    what: "Content-Length = 恰好上限 → 放行并完整落盘(边界另一侧;只测 max+1 会让「写死 max」的实现全绿)",
    probe: "c3_5",
    run: async (dir) => {
      const outcome = await download(dir, descriptor({ file: "big100.bin", probe: "c3_5" }))
      const out = path.join(dir, "out.bin")
      return {
        outcome,
        origin: await stats("c3_5"),
        residue: residue(dir, ["out.bin"]),
        finalSize: fs.existsSync(out) ? fs.statSync(out).size : null,
      }
    },
  },
  {
    id: "C3.6",
    what: "无 Content-Length(chunked)且实际 120 MiB → 首次越界即 abort;origin 发出的字节必须止于上限附近",
    probe: "c3_6",
    run: async (dir) => {
      const t0 = Date.now()
      const outcome = await download(
        dir,
        descriptor({ file: "big100.bin", probe: "c3_6", mode: "chunked", total: 125829120 }),
      )
      return { outcome, elapsedMs: Date.now() - t0, origin: await stats("c3_6"), residue: residue(dir) }
    },
  },
  {
    id: "C3.6-control",
    what: "同一条 chunked 路由的朴素客户端 → 收满 120 MiB",
    probe: "c3_6c",
    run: async () => {
      const res = await fetch(
        `${originBase}${seg({ file: "big100.bin", probe: "c3_6c", mode: "chunked", total: 125829120 })}`,
        { headers: { authorization: `Bearer ${TOKEN}` } },
      )
      let got = 0
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) got += chunk.byteLength
      return { bytesRead: got, origin: await stats("c3_6c") }
    },
  },
  {
    id: "C3.7",
    what: "少报 Content-Length(声明 1 MiB,实发 120 MiB)→ 累计越界 abort,不认那句谎话",
    probe: "c3_7",
    run: async (dir) => {
      const outcome = await download(
        dir,
        descriptor({ file: "big100.bin", probe: "c3_7", mode: "declare", declare: 1048576, total: 125829120 }),
      )
      return { outcome, origin: await stats("c3_7"), residue: residue(dir) }
    },
  },
  {
    id: "C3.8",
    what: "少报但都在限内(声明 1 MiB,实发 3 MiB)→ size-mismatch,且不留 final/.part",
    probe: "c3_8",
    run: async (dir) => {
      const outcome = await download(
        dir,
        descriptor({ file: "small.bin", probe: "c3_8", mode: "declare", declare: 1048576 }),
      )
      return { outcome, origin: await stats("c3_8"), residue: residue(dir) }
    },
  },
  {
    id: "C3.9",
    what: "多报 Content-Length(声明 3 MiB,实发 1 MiB)→ size-mismatch,不留成功外观的 final",
    probe: "c3_9",
    run: async (dir) => {
      const outcome = await download(
        dir,
        descriptor({ file: "small.bin", probe: "c3_9", mode: "declare", declare: 3145728, actual: 1048576 }),
      )
      return { outcome, origin: await stats("c3_9"), residue: residue(dir) }
    },
  },
  {
    id: "C3.10",
    what: "小上限(1 MiB)+ chunked 8 MiB:越界必须发生在**第一个越界字节**,不是读完再判",
    probe: "c3_10",
    run: async (dir) => {
      const outcome = await download(
        dir,
        descriptor({ file: "big100.bin", probe: "c3_10", mode: "chunked", total: 8388608, chunk: 65536 }),
        1048576,
      )
      return { outcome, origin: await stats("c3_10"), residue: residue(dir), maxBytes: 1048576, chunk: 65536 }
    },
  },
  {
    id: "C3.12",
    what: "少报 Content-Length **且 descriptor 带 size**(全长 3 MiB)→ 尺寸不变量必须抓住这次截断",
    run: async (dir) => {
      const outcome = await download(
        dir,
        descriptor({ file: "small.bin", probe: "c3_12", mode: "declare", declare: 1048576 }, { size: 3145728 }),
      )
      const out = path.join(dir, "out.bin")
      return {
        outcome,
        origin: await stats("c3_12"),
        residue: residue(dir, ["out.bin"]),
        finalSize: fs.existsSync(out) ? fs.statSync(out).size : null,
      }
    },
  },
  {
    id: "C3.13",
    what: "少报 Content-Length **且 descriptor 带正确 sha256**(全长内容的摘要)→ 摘要不变量必须抓住这次截断",
    run: async (dir) => {
      const outcome = await download(
        dir,
        descriptor(
          { file: "small.bin", probe: "c3_13", mode: "declare", declare: 1048576 },
          { sha256: SMALL_FULL_SHA },
        ),
      )
      const out = path.join(dir, "out.bin")
      return {
        outcome,
        origin: await stats("c3_13"),
        residue: residue(dir, ["out.bin"]),
        finalSize: fs.existsSync(out) ? fs.statSync(out).size : null,
      }
    },
  },
  {
    id: "C3.14",
    what: "少报 Content-Length **且 descriptor 无 size 无 sha256**(合同允许的 unverified 形态)→ 记录实际发生了什么",
    run: async (dir) => {
      const outcome = await download(
        dir,
        descriptor({ file: "small.bin", probe: "c3_14", mode: "declare", declare: 1048576 }),
      )
      const out = path.join(dir, "out.bin")
      const finalSha = fs.existsSync(out) ? shaOf(out) : null
      return {
        outcome,
        origin: await stats("c3_14"),
        residue: residue(dir, ["out.bin"]),
        finalSize: fs.existsSync(out) ? fs.statSync(out).size : null,
        finalSha,
        fullFixtureSha: SMALL_FULL_SHA,
        firstMiBOfFixtureSha: SMALL_FIRST_MIB_SHA,
      }
    },
  },
  {
    id: "C3.11",
    what: "平台自己回 413 → 归类 over-limit 且响应体被丢弃",
    probe: "c3_11",
    run: async (dir) => {
      const outcome = await download(dir, descriptor({ file: "small.bin", probe: "c3_11", status: 413 }))
      return { outcome, origin: await stats("c3_11"), residue: residue(dir) }
    },
  },
]

async function main() {
  const out: Record<string, unknown>[] = []
  for (const c of cases) {
    const dir = fs.mkdtempSync(path.join(projectDir, "c3-"))
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
      contractMax: CONTRACT_MAX,
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
