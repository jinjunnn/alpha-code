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
    // 判据是「子进程绿」+「子进程真的跑了那么多条」。钉**总数**会在别人合法新增一条用例时误红,
    // 而 `toContain("0 fail")` 反过来能被 "10 fail" 匹配上 —— 取回真实数字再比。
    // #679:本文件已作为受托方登记进 scripts/gate-files.tsv,而 `pass > 0` 对受托方太松:
    // 把 cases 文件删到只剩一条,本闸照样绿,委派方就成了假闸门。改成**下界**(当前 45,留 ~11%
    // 余量吸收正常增删) —— 抓成片消失,不抓少一条。
    const fail = output.match(/(\d+) fail\b/)?.[1]
    const pass = Number(output.match(/(\d+) pass\b/)?.[1] ?? 0)
    expect({ fail, ranAtLeast40: pass >= 40 }, `子进程只跑了 ${pass} 条`).toEqual({ fail: "0", ranAtLeast40: true })
  },
  60_000,
)
