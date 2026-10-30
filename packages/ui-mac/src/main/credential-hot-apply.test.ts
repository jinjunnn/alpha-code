import { expect, test } from "bun:test"
import { join } from "node:path"

// REQ-236 `#1562` 子进程宿主:跑 src/main/credential-hot-apply.cases.ts(那里 mock electron,同进程会污染别的测试文件)。
// AC1(续期热应用:respawn 0 次、不置 unapplied)、AC4(structural 三臂:fork 失败 / 20 秒超时 / 迟到旧 fork,
// 以及 fork 失败后经崩溃自愈阶梯重试、健康后确认)、
// AC2 的原子替换,以及每条用例都过的哨兵臂(令牌不进日志与 renderer 推送)。
test(
  "token renewal hot-applies credentials without restarting the engine; structural renewals confirm only on their own fork",
  () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "test", join(import.meta.dir, "credential-hot-apply.cases.ts")],
      cwd: join(import.meta.dir, "../.."),
      env: process.env,
    })
    const output = `${result.stdout.toString()}${result.stderr.toString()}`
    if (result.exitCode !== 0) throw new Error(output)
    expect(output).toContain("8 pass")
    expect(output).toContain("0 fail")
  },
  60_000,
)
