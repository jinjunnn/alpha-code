import { expect, test } from "bun:test"
import { join } from "node:path"

// 子进程跑 alpha-auth.cases.ts(mock.module 会污染同进程的其它测试文件)。其中「换血等待
// 有界」一条要真的等满 ROTATION_WAIT_MS(10s),故父测试给 60s 预算,而不是默认 5s。
test(
  "purpose-keyed platform access token bundle auth flow",
  () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "test", join(import.meta.dir, "alpha-auth.cases.ts")],
      cwd: join(import.meta.dir, "../.."),
      env: process.env,
    })
    const output = `${result.stdout.toString()}${result.stderr.toString()}`
    if (result.exitCode !== 0) throw new Error(output)
    expect(output).toContain("46 pass")
  },
  60_000,
)
