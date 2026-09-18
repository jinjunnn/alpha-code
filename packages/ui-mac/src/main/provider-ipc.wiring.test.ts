import { expect, test } from "bun:test"
import { join } from "node:path"

// 子进程跑 test-component/provider-ipc.wiring.cases.ts(mock.module("electron") 会污染同进程的其它测试文件;与
// app-version-ipc.wiring 同形)。被测的是真实 IPC 链:providers-set-key / providers-remove /
// providers-key-status → provider-lifecycle → 真钥匙串库(只换其单函数 Electron 接缝)→ 真 ext-config 写器。
// REQ-226 `#1343` R1 finding 1 / R2 blocker:重填目录 id 的密钥必须让旧明文**那一叶**退场 —— 只删
// `provider.<id>.options.apiKey`,不删块、不碰用户手写的 npm / baseURL / models,没有那一叶的文件一字不写
//(整块删在 alpha.jsonc 没有 provider 键时被 jsonc-parser 抛 `Can not delete in empty document`,密钥永不入库)。
test("provider IPC wiring(providers-set-key 重填 ⇒ 只退场旧明文叶;锁忙拒绝零写入;remove 先库后配置)", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", join(import.meta.dir, "../../test-component/provider-ipc.wiring.cases.ts")],
    cwd: join(import.meta.dir, "../.."),
    env: process.env,
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(output)
  // 真实数字判据:fail 恰为 0 且 pass 恰为 6(cases 文件里恰好六条)。
  expect(output.match(/(\d+) fail\b/)?.[1], output).toBe("0")
  expect(output.match(/(\d+) pass\b/)?.[1], output).toBe("6")
})
