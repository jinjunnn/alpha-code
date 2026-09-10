// REQ-159 (`#1322`) —— 在 bun 子进程里跑**生产的**工作区写探针(workspace-write-probe.ts 的 runWorkspaceWriteProbe),
// 两臂:`fenced` 先经生产的 applyProcessFence 把本进程关进围栏(= sidecar 的形态),`bare` 不关(= main 进程的形态)。
// 测试进程据此判 AC3:真探针在真围栏下集合内答 writable、集合外答 denied;而 bare 臂对集合外也答 writable ——
// 那就是「在 main 里 fs.writeFile 探测恒答可写」的假探针,判据必须把它拒掉。
//
//   argv: <mode bare|fenced> <addonPath> <profileFile> <insideDir> <outsideDir> <missingDir>
import { readFileSync } from "node:fs"
import { applyProcessFence } from "../../src/main/process-fence-apply"
import { runWorkspaceWriteProbe } from "../../src/main/workspace-write-probe"

const [mode, addonPath, profileFile, insideDir, outsideDir, missingDir] = process.argv.slice(2)
try {
  let apply: unknown
  if (mode === "fenced") {
    // 探针自证用的 insideDir 就是本测试的 ws(与 process-fence-apply.test.ts C/D 同法);围栏装不上直接抛。
    apply = applyProcessFence({ addonPath: addonPath!, profile: readFileSync(profileFile!, "utf8") }, { insideDir: insideDir! })
  } else if (mode !== "bare") {
    throw new Error(`unknown mode ${mode}`)
  }
  console.log(
    JSON.stringify({
      ok: true,
      pid: process.pid,
      mode,
      apply,
      inside: runWorkspaceWriteProbe(insideDir!),
      outside: runWorkspaceWriteProbe(outsideDir!),
      missing: runWorkspaceWriteProbe(missingDir!),
    }),
  )
} catch (error) {
  console.log(JSON.stringify({ ok: false, name: error instanceof Error ? error.name : "?", message: error instanceof Error ? error.message : String(error) }))
  process.exit(2)
}
