import { readFileSync } from "node:fs"
import { describe, expect, test } from "bun:test"
import {
  INITIAL_LOCATION_PREWARM_TIMEOUT_MS,
  initialLocationPrewarmRequest,
  initialModelPrewarmRequest,
  prewarmInitialLocation,
} from "./sidecar-location-prewarm"

describe("sidecar initial location prewarm", () => {
  test("bounds the ready gate by the #857 startup budget", () => {
    expect(INITIAL_LOCATION_PREWARM_TIMEOUT_MS).toBe(2_000)
  })

  test("targets the real governed-provider and model V2 handlers for the exact directory", () => {
    const requests = [
      initialLocationPrewarmRequest("/Users/example/Alpha", "synthetic-password")!,
      initialModelPrewarmRequest("/Users/example/Alpha", "synthetic-password")!,
    ]
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/provider/alpha-internal-catalog-ready",
      "/api/model",
    ])
    for (const request of requests) {
      expect(request.method).toBe("GET")
      expect(request.headers.get("authorization")).toBe(
        `Basic ${Buffer.from("opencode:synthetic-password").toString("base64")}`,
      )
      expect(new URL(request.url).searchParams.get("location[directory]")).toBe("/Users/example/Alpha")
    }
  })

  test("rejects a relative directory before the server app is called", async () => {
    let calls = 0
    const result = await prewarmInitialLocation(
      {
        request() {
          calls++
          return new Response(null, { status: 200 })
        },
      },
      "relative/Alpha",
      { password: "synthetic-password" },
    )
    expect(result).toEqual({ outcome: "invalid-directory", durationMs: expect.any(Number) })
    expect(calls).toBe(0)
  })

  test("starts the in-process request without waiting for socket listen", async () => {
    let resolve!: (response: Response) => void
    const pending = new Promise<Response>((done) => (resolve = done))
    const paths: string[] = []
    const warming = prewarmInitialLocation(
      {
        request(input) {
          paths.push(new URL(input instanceof Request ? input.url : input).pathname)
          return paths.length === 1 ? pending : new Response("[]", { status: 200 })
        },
      },
      "/Users/example/Alpha",
      { password: "synthetic-password" },
    )
    expect(paths).toEqual(["/api/provider/alpha-internal-catalog-ready"])
    resolve(new Response(null, { status: 200 }))
    expect(await warming).toEqual({ outcome: "ready", status: 200, durationMs: expect.any(Number) })
    expect(paths).toEqual(["/api/provider/alpha-internal-catalog-ready", "/api/model"])
  })

  // 分类与「这处锚守不住什么」登记在 ./source-text-anchors.ts(`#968` 第 ⑤ 层机械校验)。
  test("ANCHOR (not a gate): production starts prewarm before listen and withholds ready until it settles", () => {
    const source = readFileSync(import.meta.dir + "/sidecar.ts", "utf8")
    const start = source.indexOf("const prewarm = prewarmInitialLocation(")
    const listen = source.indexOf("listener = await Server.listen(")
    const settled = source.indexOf("const prewarmResult = await prewarm")
    // #881:prewarm 的结局整体随 ready 上车,所以锚跟着换成两参形态(值真的上车的判据在
    // sidecar-ready-message.test.ts,这里只锁 bun 跑不到的接线顺序)。
    const ready = source.indexOf("parentPort.postMessage(buildReadyMessage(injection, prewarmResult))")

    expect(start).toBeGreaterThanOrEqual(0)
    expect(listen).toBeGreaterThan(start)
    expect(settled).toBeGreaterThan(listen)
    expect(ready).toBeGreaterThan(settled)
  })

  test("reports a non-ready marker response without retrying or failing open", async () => {
    let calls = 0
    let consumed = false
    const result = await prewarmInitialLocation(
      {
        request() {
          calls++
          const response = new Response("marker-not-ready", { status: 404 })
          const read = response.arrayBuffer.bind(response)
          response.arrayBuffer = async () => {
            consumed = true
            return read()
          }
          return response
        },
      },
      "/Users/example/Alpha",
      { password: "synthetic-password" },
    )
    expect(result).toEqual({ outcome: "unavailable", status: 404, durationMs: expect.any(Number) })
    expect(calls).toBe(1)
    expect(consumed).toBe(true)
  })

  test("reports a non-ready model response only after the governed marker succeeds", async () => {
    let calls = 0
    const result = await prewarmInitialLocation(
      {
        request() {
          calls++
          return new Response(null, { status: calls === 1 ? 200 : 503 })
        },
      },
      "/Users/example/Alpha",
      { password: "synthetic-password" },
    )
    expect(result).toEqual({ outcome: "unavailable", status: 503, durationMs: expect.any(Number) })
    expect(calls).toBe(2)
  })

  // #881 的反向闸:这条喂的是**抛异常**的 app(不是超时)。新增的 timed-out 分支若把两件事
  // 合并回去,这条当场红 —— 它证明新分支没有吞掉旧分类。
  test("contains request failure as a diagnostic result", async () => {
    const result = await prewarmInitialLocation(
      {
        request() {
          throw new Error("injected prewarm failure")
        },
      },
      "/Users/example/Alpha",
      { password: "synthetic-password" },
    )
    expect(result).toEqual({
      outcome: "failed",
      error: "injected prewarm failure",
      durationMs: expect.any(Number),
    })
  })

  test("#881 硬顶到期与『请求自己炸了』是两个可观察结局,且每格都带实测耗时", async () => {
    // `#1300`:耗时用**注入的时钟**量,判据是精确值,不再是墙钟上下界(原上界 1_000ms 在满载下会
    // 假红;原下界只证得了「不是写死 0」)。夹具在请求里推进时钟 ⇒ 写死 0 / 写死大常量 / 量错区间都红。
    let clock = 0
    const now = () => clock
    // ① 是**我们自己的硬顶**把它掐了。旧实现把这一格折进 `{outcome:"failed", error:"…timed out"}`
    //    的自由文本 ⇒ 打包证据里「ready 是等满硬顶照发的」不可判,而那是归因要问的第一个问题。
    const timedOut = await prewarmInitialLocation(
      {
        request(input) {
          const signal = (input as Request).signal
          return new Promise<Response>((_, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                clock += 20
                reject(signal.reason)
              },
              { once: true },
            )
          })
        },
      },
      "/Users/example/Alpha",
      { password: "synthetic-password", timeoutMs: 20, now },
    )
    expect(timedOut.outcome).toBe("timed-out")
    // 折回 failed 的实现在这里红两次:outcome 变了,而且它会带上自由文本 error。
    expect("error" in timedOut).toBe(false)
    // 耗时是从注入时钟量出来的:硬顶那一刻时钟推进了 20 ⇒ 恰好 20。
    expect(timedOut.durationMs).toBe(20)

    // ② 成功路径同样带耗时 —— 只在失败时带,打包全绿那一次反而无从归因(T7 样本 1 正是那格:
    //    prewarm 早早收场、ready 照发,目录再过 13.8s 才收敛)。
    clock = 0
    const readyAt = await prewarmInitialLocation(
      {
        async request() {
          clock += 40
          return new Response(null, { status: 200 })
        },
      },
      "/Users/example/Alpha",
      { password: "synthetic-password", now },
    )
    expect(readyAt.outcome).toBe("ready")
    // marker + model 两次请求各推进 40 ⇒ 恰好 80;恒量 durationMs=0 或写死常量的实现在这里红。
    expect(readyAt.durationMs).toBe(80)
  })
})
