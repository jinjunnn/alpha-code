import { expect, test } from "bun:test"
import path from "node:path"

// #595 起本套件含三条真时钟例(退避 1s/2s + 账户恢复窗口):假时钟替代不了 createRetryWakeup 的
// 真 setTimeout,故把子进程整体超时抬到 60s(与 locale render smoke 同量级),不改单例语义。
test(
  "生产 model picker 的 Solid 组件状态机",
  () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "test",
        path.resolve(import.meta.dir, "../../../test-component/alpha-composer-model.cases.ts"),
      ],
      cwd: path.resolve(import.meta.dir, "../../.."),
      env: process.env,
    })
    const output = `${result.stdout.toString()}${result.stderr.toString()}`
    if (result.exitCode !== 0) throw new Error(output)
    expect(output).toContain("41 pass")
    expect(output).toContain("0 fail")
  },
  60_000,
)
