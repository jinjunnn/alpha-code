// `#1391` —— 自定义节点真源的**写端**。只有 main 进程会 import 本文件;它**不得**进 sidecar 的 import 闭包
// (custom-provider-truth-write.test.ts 对着 process-fence-write-sites.ts 的 sidecarSourceFiles 实测),理由在
// custom-provider-truth.ts 文件头:写入点一旦跟着读端进闭包,写盘登记簿只能给它填 `main-only` 这个文字标签。
//
// 写:先过读端**同一份**判据(坏记录不落盘,连目录都不建),再写临时文件 + 同目录 rename(原子:写到一半失败 ⇒ 盘上仍是
// 旧内容,不是半截文件;临时文件收走,错误原样抛,由调用方决定怎么出声)。字节确定:固定键序、紧凑、末尾换行。
// 与 process-fence-workspaces.ts 的 writeWorkspaceTruth 同形(同一个状态根下的兄弟真源)。
//
// 本票没有调用方:添加 / 删除自定义节点改写这里、准入与出网同源、旧 alpha.jsonc 记录的处置,都是 `#1393`。electron-free:fs 注入。

import { dirname } from "node:path"
import {
  CUSTOM_PROVIDER_TRUTH_VERSION,
  canonicalCustomProviderRecord,
  invalidCustomProviderList,
  type CustomProviderRecord,
} from "./custom-provider-truth"

export type CustomProviderTruthWriteFs = {
  mkdirSync: (path: string, options: { recursive: true }) => unknown
  writeFileSync: (path: string, data: string) => void
  renameSync: (from: string, to: string) => void
  rmSync: (path: string, options: { force: true }) => void
}

let tmpSeq = 0

/** 原子写(见文件头)。父目录 `custom-providers/` 不在 alpha-environment.ts 的拓扑预检里,不在就建。 */
export function writeCustomProviderTruth(path: string, providers: readonly CustomProviderRecord[], fs: CustomProviderTruthWriteFs): void {
  const bad = invalidCustomProviderList(providers)
  if (bad) throw new Error(`custom providers: refusing to write ${path} — ${bad}`)
  const text = JSON.stringify({ v: CUSTOM_PROVIDER_TRUTH_VERSION, providers: providers.map(canonicalCustomProviderRecord) }) + "\n"
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
