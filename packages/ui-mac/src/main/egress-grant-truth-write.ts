// `#1412` —— 用户批准的出网目的地真源的**写端**。只有 main 进程会 import 本文件;它**不得**进 sidecar 的
// import 闭包(判据:egress-grant-truth.test.ts 对着 process-fence-write-sites.ts 的 sidecarSourceFiles 实测),
// 理由在 egress-grant-truth.ts 文件头 —— 围栏内的代码能写它,就等于能给自己批准出网。
//
// 写:先过读端**同一份**判据(坏记录不落盘,连目录都不建),再写临时文件 + 同目录 rename(原子:写到一半
// 失败 ⇒ 盘上仍是旧内容,不是半截文件;临时文件收走,错误原样抛,由调用方决定怎么出声)。字节确定:
// 固定键序、紧凑、末尾换行。与 mcp-server-truth-write.ts / custom-provider-truth-write.ts 同形。electron-free:fs 注入。

import { dirname } from "node:path"
import { EGRESS_GRANT_TRUTH_VERSION, canonicalEgressGrantRecord, invalidEgressGrantList, type EgressGrantRecord } from "./egress-grant-truth"

export type EgressGrantTruthWriteFs = {
  mkdirSync: (path: string, options: { recursive: true }) => unknown
  writeFileSync: (path: string, data: string) => void
  renameSync: (from: string, to: string) => void
  rmSync: (path: string, options: { force: true }) => void
}

let tmpSeq = 0

/** 原子写(见文件头)。父目录 `egress-grants/` 不在 alpha-environment.ts 的拓扑预检里,不在就建。 */
export function writeEgressGrantTruth(path: string, grants: readonly EgressGrantRecord[], fs: EgressGrantTruthWriteFs): void {
  const bad = invalidEgressGrantList(grants)
  if (bad) throw new Error(`egress grants: refusing to write ${path} — ${bad}`)
  const text = JSON.stringify({ v: EGRESS_GRANT_TRUTH_VERSION, grants: grants.map(canonicalEgressGrantRecord) }) + "\n"
  fs.mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`
  try {
    fs.writeFileSync(tmp, text)
    fs.renameSync(tmp, path)
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      // 临时文件留着无害(读端只认 <env>.json);真正要报的是下面那个错
    }
    throw error
  }
}
