// REQ-159 (`#1321`) —— 在 bun 子进程里跑**生产的** applyProcessFence(process-fence-apply.ts),
// 把结果打成 JSON;测试进程据此判 AC4(fail-closed 且响亮)与探针自证。必须在子进程里跑:
// applyProcessFence 会把调用它的进程关进围栏,测试进程自己不能被关。
//
//   argv: <addonPath> <profileFile> [insideDir] [outsideDir]
import { readFileSync } from "node:fs"
import { applyProcessFence } from "../../src/main/process-fence-apply"

const [addonPath, profileFile, insideDir, outsideDir] = process.argv.slice(2)
try {
  const result = applyProcessFence(
    { addonPath: addonPath!, profile: readFileSync(profileFile!, "utf8") },
    { ...(insideDir ? { insideDir } : {}), ...(outsideDir ? { outsideDir } : {}) },
  )
  console.log(JSON.stringify({ ok: true, result }))
} catch (error) {
  console.log(JSON.stringify({ ok: false, name: error instanceof Error ? error.name : "?", message: error instanceof Error ? error.message : String(error) }))
  process.exit(2)
}
