// REQ-159 (`#1321`) —— 装围栏前先试编译一次(基线 I1 补注 / 票面硬要求三)。
//
// 为什么要试编译:seatbelt 编译有一道硬墙 `data object length … exceeds maximum (65535)`,越过即编译
// 失败、零执行;它的单位是编译后数据对象的字节,**没有精确刻画**(U2 §6)。撞墙的后果按 fail-closed
// 就是引擎起不来 —— 与「前提为假的闸门比没有闸门更贵」同族。所以 main 在 fork 之前用**真编译器**
// 编一遍,失败就让 trimUntilCompiles 少放几个工作区再试(process-fence-profile.ts)。
//
// 编译器就是 `/usr/bin/sandbox-exec` —— 它读 `-f <file>`、编译、把自己关进去、再 exec 后面的命令。
// 跑 `/usr/bin/true` 作为命令:profile 是 `(allow default)`,exec 不受限;exit 0 = 编译通过且能应用,
// 非零 = stderr 里是 libsandbox 的原文(例如 `sandbox-exec: data object length 70173 exceeds maximum (65535)`
// 或 `profile compilation failed`)。这与 sidecar 里 `sandbox_init` 用的是同一个 libsandbox。
//
// 手段先自证(process-fence-compile.test.ts):一份已知会撞墙的 profile 必须判 ok:false 且 reason 含
// `exceeds maximum`;一份语法坏的必须判 ok:false;§8.2 形状的必须判 ok:true。
// 非 darwin 上没有 sandbox-exec,本模块不该被调用(planner 在非 darwin 上不产计划)。

import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TrialCompile } from "./process-fence-profile"

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec"

export type TrialCompileDeps = {
  /** 默认真跑 sandbox-exec;测试可注入。 */
  spawn?: typeof spawnSync
  tmpdir?: () => string
}

/** 用真 sandbox-exec 试编译。写临时文件 → `sandbox-exec -f <file> /usr/bin/true` → 读退出码与 stderr。 */
export const trialCompileProfile: TrialCompile & ((profile: string, deps?: TrialCompileDeps) => ReturnType<TrialCompile>) = (
  profile: string,
  deps: TrialCompileDeps = {},
) => {
  if (process.platform !== "darwin") return { ok: false, reason: "sandbox-exec is darwin-only" }
  const spawn = deps.spawn ?? spawnSync
  const dir = mkdtempSync(join((deps.tmpdir ?? tmpdir)(), "alpha-fence-compile-"))
  const file = join(dir, "profile.sb")
  try {
    writeFileSync(file, profile)
    const res = spawn(SANDBOX_EXEC, ["-f", file, "/usr/bin/true"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 })
    if (res.error) return { ok: false, reason: `sandbox-exec could not run: ${res.error.message}` }
    if (res.status === 0) return { ok: true }
    const stderr = (res.stderr ?? "").toString().trim()
    return { ok: false, reason: stderr || `sandbox-exec exited ${res.status} with no stderr` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
