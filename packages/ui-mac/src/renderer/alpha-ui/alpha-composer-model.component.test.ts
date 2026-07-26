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
    // 判据只有「子进程绿」:钉总数会在别人合法新增一条用例时误红,而 `toContain("0 fail")`
    // 反过来能被 "10 fail" 匹配上 —— 取回真实数字再比,并要求至少跑过一条。
    const fail = output.match(/(\d+) fail\b/)?.[1]
    const pass = Number(output.match(/(\d+) pass\b/)?.[1] ?? 0)
    expect({ fail, ran: pass > 0 }).toEqual({ fail: "0", ran: true })
  },
  60_000,
)
