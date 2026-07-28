// alpha-code#652 —— 「同一个会话里的第二条消息」端到端回归闸的 spawn 壳。
//
// 真判据全在 test-component/session-second-send.cases.ts:生产 AlphaComposer(home + session
// 两个 mode)与生产 AlphaSessionTimeline 挂在同一棵 Solid 树上,共用一个同时挂着 v1/v2 两条
// 发送端点的假 sidecar;连发三条,断言**渲染出来的回复**。子进程运行是因为该 suite 要 mock
// solid/@opencode-ai/app/@solidjs/router 等模块,mock 不能泄漏进主进程。
import { expect, test } from "bun:test"
import path from "node:path"

test(
  "#652 会话内连发三条:第 2、3 条真发出去并渲染出回复",
  () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "test",
        path.resolve(import.meta.dir, "../../../../test-component/session-second-send.cases.ts"),
      ],
      cwd: path.resolve(import.meta.dir, "../../../.."),
      env: process.env,
    })
    const output = `${result.stdout.toString()}${result.stderr.toString()}`
    if (result.exitCode !== 0) throw new Error(output)
    // 钉总数会在合法新增用例时误红;`toContain("0 fail")` 又会被 "10 fail" 匹配上 ——
    // 取回真实数字再比,并要求至少真的跑过一条(`bun test` 对零用例退出 0)。
    const fail = output.match(/(\d+) fail\b/)?.[1]
    const pass = Number(output.match(/(\d+) pass\b/)?.[1] ?? 0)
    expect({ fail, ran: pass >= 3 }).toEqual({ fail: "0", ran: true })
  },
  60_000,
)
