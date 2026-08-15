import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  armCatalogLiveness,
  decideCatalogLiveness,
  initialCatalogLivenessState,
  probeCatalogMarker,
  resolveCatalogProbeDirectory,
  type CatalogLivenessSample,
  type CatalogLivenessState,
} from "./catalog-liveness"

// 阈值锚点全部用**独立字面量**(不 import 生产常量当期望值 —— 自指等价链一起改错就一起自洽)。
// 60s / 5s / 3 strikes / 30min 是票面判据的一部分:必须显著大于正常慢 bootstrap(实测 ~16s),
// 远小于被动恢复时延(实测 225s)。改动生产常量必须让这里转红,由 owner 重新裁阈值。
const T0 = 10_000_000
const DEADLINE = 60_000
const STRIKE_DECAY = 30 * 60 * 1000

const notReady: CatalogLivenessSample = { outcome: "engine-not-ready", status: 404 }
const probeTimeout: CatalogLivenessSample = { outcome: "probe-failed", reason: "probe-timeout", message: "t/o" }
const ready: CatalogLivenessSample = { outcome: "ready" }
// R1 Blocker 实测形态:探针目录不存在 ⇒ marker 端点确定性 500(UnknownError),永不 404/200。
const unclassified500: CatalogLivenessSample = { outcome: "engine-unclassified", status: 500 }
const unclassified401: CatalogLivenessSample = { outcome: "engine-unclassified", status: 401 }

function armed(now = T0): CatalogLivenessState {
  return armCatalogLiveness(initialCatalogLivenessState(), now)
}

/** 喂一段样本序列,返回最后一次 decision;中途若出现非 none 动作立即返回(测试自会断言)。 */
function feed(state: CatalogLivenessState, samples: Array<{ at: number; sample: CatalogLivenessSample }>) {
  let current = state
  let last = decideCatalogLiveness(samples[0]!.at, samples[0]!.sample, current)
  current = last.state
  for (const step of samples.slice(1)) {
    if (last.action !== "none") return last
    last = decideCatalogLiveness(step.at, step.sample, current)
    current = last.state
  }
  return last
}

describe("catalog-liveness decision", () => {
  test("未武装时任何样本都不产生动作", () => {
    const decision = decideCatalogLiveness(T0, notReady, initialCatalogLivenessState())
    expect(decision.action).toBe("none")
    expect(decision.state.armed).toBe(false)
  })

  test("不误触发:窗口内持续 404 + 探针自身超时混合,一律只记账不裁决", () => {
    // 负向夹具刻意不用退化形状:两类失败交替、贴着 55s(> 实测正常慢 bootstrap 16s 的 3 倍)。
    const steps = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((s, i) => ({
      at: T0 + s * 1000,
      sample: i % 3 === 2 ? probeTimeout : notReady,
    }))
    const decision = feed(armed(), steps)
    expect(decision.action).toBe("none")
    expect(decision.state.armed).toBe(true)
    // 记账分栏:引擎答了没就绪 vs 我们的探测失败,折叠成一个数的实现在这里现形。
    expect(decision.engineNotReady).toBe(8)
    expect(decision.probeFailures).toBe(3)
    expect(decision.probes).toBe(11)
  })

  test("正常慢 bootstrap:大量失败之后、窗口内任一次 ready → confirmed 且永久解除,绝不 respawn", () => {
    const failures = [5, 12, 20, 28, 36, 44, 52].map((s) => ({ at: T0 + s * 1000, sample: notReady }))
    const beforeReady = feed(armed(), failures)
    expect(beforeReady.action).toBe("none")
    const confirmed = decideCatalogLiveness(T0 + 55_000, ready, beforeReady.state)
    expect(confirmed.action).toBe("confirmed")
    expect(confirmed.elapsedMs).toBe(55_000)
    expect(confirmed.state.armed).toBe(false)
    expect(confirmed.state.strikes).toBe(0)
    // 解除后迟到的失败样本不再产生任何动作。
    const late = decideCatalogLiveness(T0 + DEADLINE + 10_000, notReady, confirmed.state)
    expect(late.action).toBe("none")
  })

  test("deadline 前最后一刻的 ready 仍算 confirmed(判据是窗口内有没有成功,不是失败计数)", () => {
    const decision = decideCatalogLiveness(T0 + DEADLINE - 1, ready, armed())
    expect(decision.action).toBe("confirmed")
  })

  test("窗口到期且从未 ready → kill-and-respawn(首次裁决),状态解除、strike=1", () => {
    const failures = [5_000, 20_000, 40_000, DEADLINE].map((ms) => ({ at: T0 + ms, sample: notReady }))
    const decision = feed(armed(), failures)
    expect(decision.action).toBe("kill-and-respawn")
    expect(decision.elapsedMs).toBe(DEADLINE)
    expect(decision.state.armed).toBe(false)
    expect(decision.state.strikes).toBe(1)
    expect(decision.probes).toBe(4)
  })

  test("引擎从没答过(全是我们的探测失败)同样在窗口到期时裁决 —— 引擎卡死也是退化", () => {
    const failures = [10_000, 30_000, DEADLINE].map((ms) => ({ at: T0 + ms, sample: probeTimeout }))
    const decision = feed(armed(), failures)
    expect(decision.action).toBe("kill-and-respawn")
    expect(decision.probeFailures).toBe(3)
    expect(decision.engineNotReady).toBe(0)
  })

  test("全新安装形态(R1 Blocker):窗口内引擎在答、答的全是协议外 status → 到期弃权,不 kill 不记 strike", () => {
    // 负向夹具刻意不用退化形状:500/401 混着我们自己的探测超时,贴满整窗 —— 引擎全程健康,
    // 只是观测面(~/Alpha 不存在 ⇒ 确定性 500)不可用。旧实现在这里 kill-and-respawn,
    // 60s 杀一次健康引擎、三振后弹 Recovery incident。
    const steps = [5, 12, 20, 28, 36, 44, 52, 60].map((s, i) => ({
      at: T0 + s * 1000,
      sample: i % 4 === 3 ? probeTimeout : i % 2 === 0 ? unclassified500 : unclassified401,
    }))
    const decision = feed(armed(), steps)
    expect(decision.action).toBe("indeterminate")
    expect(decision.state.armed).toBe(false)
    expect(decision.state.strikes).toBe(0)
    expect(decision.state.lastVerdictAt).toBeNull()
    // 记账分栏:协议外应答与我们的探测失败各归各栏,权威未收敛为 0 —— 这就是弃权的依据。
    expect(decision.engineUnclassified).toBe(6)
    expect(decision.probeFailures).toBe(2)
    expect(decision.engineNotReady).toBe(0)
    // 弃权不是裁决:同代不再产生任何动作(表已停由接线负责),后续武装从零 strike 起步。
    const rearmed = decideCatalogLiveness(T0 + DEADLINE + 10_000, unclassified500, decision.state)
    expect(rearmed.action).toBe("none")
  })

  test("窗口内哪怕一次权威 404,其余全是协议外应答 → 到期照样 kill(授权凭引擎自己的未收敛)", () => {
    const steps = [
      { at: T0 + 5_000, sample: unclassified500 },
      { at: T0 + 15_000, sample: notReady },
      { at: T0 + 30_000, sample: unclassified500 },
      { at: T0 + 45_000, sample: unclassified401 },
      { at: T0 + DEADLINE, sample: unclassified500 },
    ]
    const decision = feed(armed(), steps)
    expect(decision.action).toBe("kill-and-respawn")
    expect(decision.state.strikes).toBe(1)
    expect(decision.engineNotReady).toBe(1)
    expect(decision.engineUnclassified).toBe(4)
  })

  test("30 分钟内第三次裁决 → stop-and-report(不再自动 kill),strike 跨代累计", () => {
    let state = initialCatalogLivenessState()
    const actions: string[] = []
    for (let round = 0; round < 3; round++) {
      const armAt = T0 + round * (DEADLINE + 2_000)
      state = armCatalogLiveness(state, armAt)
      const verdict = decideCatalogLiveness(armAt + DEADLINE, notReady, state)
      actions.push(verdict.action)
      state = verdict.state
    }
    expect(actions).toEqual(["kill-and-respawn", "kill-and-respawn", "stop-and-report"])
    expect(state.strikes).toBe(3)
  })

  test("裁决相隔超过 30 分钟 → strike 衰减,回到 kill-and-respawn 快路径", () => {
    let state = initialCatalogLivenessState()
    state = armCatalogLiveness(state, T0)
    const first = decideCatalogLiveness(T0 + DEADLINE, notReady, state)
    expect(first.action).toBe("kill-and-respawn")
    const armAt = T0 + DEADLINE + STRIKE_DECAY
    state = armCatalogLiveness(first.state, armAt)
    const second = decideCatalogLiveness(armAt + DEADLINE, notReady, state)
    expect(second.action).toBe("kill-and-respawn")
    expect(second.state.strikes).toBe(1)
  })
})

// #564 R2 Major:探针目录 = 用户首屏实际目录,不是全场最快收敛的 ~/Alpha。
// 全部夹具形状取自两台真机 store 实读(2026-08-11):store 值是 JSON **字符串**(renderer
// AsyncStorage 写入形态);dev 店 recent 指 draft、draft tab 带裸 directory;非 dev 店的
// session 目录在 tabs.info[key].directory,key = `${server}\n/server/<b64>/session/<id>`。
// 期望目录全用独立字面量 —— 不从生产常量或夹具自身推导(自指等价链)。
describe("catalog-liveness 探针目录解析(#564 R2)", () => {
  // 负向夹具不用退化形状:多 tab、混类型、recent 指向中间那个 —— 「取第一个 draft」或
  // 「永远回默认目录」的错误实现都过不去。
  const tabs = JSON.stringify([
    { type: "draft", draftID: "d-alpha", server: "sidecar", directory: "/Users/u/Alpha" },
    { type: "session", server: "sidecar", sessionId: "ses_x" },
    { type: "draft", draftID: "d-repo", server: "sidecar", directory: "/Users/u/app/alpha-code" },
    { type: "draft", draftID: "d-wsl", server: "wsl:Ubuntu", directory: "/home/u/repo" },
  ])
  const sessionKey = "sidecar\n/server/c2lkZWNhcg/session/ses_0be83b52cffeLQrUz2wzXJ5D6x"
  const info = JSON.stringify({
    [sessionKey]: { title: "New session", directory: "/Users/u/Documents/workspace" },
    "ssh:host\n/server/eA/session/ses_y": { title: "remote", directory: "/Users/u/app/alpha-code" },
  })

  test("recent 指 draft → 该 draft 的 directory(不是列表里第一个,也不是默认工作区)", () => {
    const recent = JSON.stringify({ key: "draft:d-repo" })
    expect(resolveCatalogProbeDirectory({ tabs, recent, info })).toBe("/Users/u/app/alpha-code")
  })

  test("recent 指本地 session → tabs.info[key].directory", () => {
    const recent = JSON.stringify({ key: sessionKey })
    expect(resolveCatalogProbeDirectory({ tabs, recent, info })).toBe("/Users/u/Documents/workspace")
  })

  test("非本地引擎的 tab 不供靶:wsl draft 与 ssh session 都解析为 undefined(本地看门狗判不了别的引擎)", () => {
    expect(resolveCatalogProbeDirectory({ tabs, recent: JSON.stringify({ key: "draft:d-wsl" }), info })).toBeUndefined()
    expect(
      resolveCatalogProbeDirectory({ tabs, recent: JSON.stringify({ key: "ssh:host\n/server/eA/session/ses_y" }), info }),
    ).toBeUndefined()
  })

  test("recent 缺席 / 空对象 / 指向不存在的 draft / info 缺该 key → undefined(回退默认目录)", () => {
    expect(resolveCatalogProbeDirectory({ tabs, recent: undefined, info })).toBeUndefined()
    expect(resolveCatalogProbeDirectory({ tabs, recent: JSON.stringify({}), info })).toBeUndefined()
    expect(resolveCatalogProbeDirectory({ tabs, recent: JSON.stringify({ key: "draft:gone" }), info })).toBeUndefined()
    expect(
      resolveCatalogProbeDirectory({ tabs, recent: JSON.stringify({ key: "sidecar\n/server/c2lkZWNhcg/session/ses_unknown" }), info }),
    ).toBeUndefined()
  })

  test("坏账 fail-open:JSON 烂 / tabs 非数组 / 目录非绝对路径 / info 条目缺 directory → undefined,绝不抛", () => {
    expect(resolveCatalogProbeDirectory({ tabs, recent: "{not json", info })).toBeUndefined()
    expect(
      resolveCatalogProbeDirectory({ tabs: JSON.stringify({ nope: 1 }), recent: JSON.stringify({ key: "draft:d-repo" }), info }),
    ).toBeUndefined()
    const relative = JSON.stringify([{ type: "draft", draftID: "d-rel", server: "sidecar", directory: "relative/dir" }])
    expect(resolveCatalogProbeDirectory({ tabs: relative, recent: JSON.stringify({ key: "draft:d-rel" }), info })).toBeUndefined()
    const noDir = JSON.stringify({ [sessionKey]: { title: "no directory" } })
    expect(resolveCatalogProbeDirectory({ tabs, recent: JSON.stringify({ key: sessionKey }), info: noDir })).toBeUndefined()
  })

  test("裸对象形态(legacy 写入)与 JSON 字符串同容忍度 —— 与 tabs-preclean 的 decodeStoreValue 同款", () => {
    const bareTabs = [{ type: "draft", draftID: "d-obj", server: "sidecar", directory: "/Users/u/proj" }]
    const bareRecent = { key: "draft:d-obj" }
    expect(resolveCatalogProbeDirectory({ tabs: bareTabs, recent: bareRecent, info: {} })).toBe("/Users/u/proj")
  })
})

describe("catalog-liveness probe(真执行,fetch 注入)", () => {
  const opts = { url: "http://127.0.0.1:41234", password: "pw-564", directory: "/tmp/alpha-workspace" }

  test("请求形状:打真实 base 的 marker 端点、带 location[directory] 与 Basic auth", async () => {
    let seen: Request | undefined
    await probeCatalogMarker({
      ...opts,
      fetchImpl: async (input) => {
        seen = input as Request
        return new Response(null, { status: 200 })
      },
    })
    expect(seen).toBeDefined()
    const url = new URL(seen!.url)
    expect(url.origin).toBe("http://127.0.0.1:41234")
    // marker id 用独立字面量锚定(就绪的唯一证明,docs/architecture/2026-08-10 勘破),
    // 不 import 生产常量 —— 改错常量必须在这里红。
    expect(url.pathname).toBe("/api/provider/alpha-internal-catalog-ready")
    expect(url.searchParams.get("location[directory]")).toBe("/tmp/alpha-workspace")
    expect(seen!.headers.get("authorization")).toBe(`Basic ${Buffer.from("opencode:pw-564").toString("base64")}`)
  })

  test("引擎答 2xx → ready", async () => {
    const sample = await probeCatalogMarker({ ...opts, fetchImpl: async () => new Response("{}", { status: 200 }) })
    expect(sample).toEqual({ outcome: "ready" })
  })

  test("引擎真的答了 404(未收敛)→ engine-not-ready 且保留引擎的 status", async () => {
    const sample = await probeCatalogMarker({ ...opts, fetchImpl: async () => new Response("nope", { status: 404 }) })
    expect(sample).toEqual({ outcome: "engine-not-ready", status: 404 })
  })

  test("引擎答 500(实测:探针目录不存在的确定性拒绝)→ engine-unclassified,不冒充「未收敛」", async () => {
    // body 用实测形状(UnknownError),不用空 body 的退化夹具。
    const sample = await probeCatalogMarker({
      ...opts,
      fetchImpl: async () =>
        new Response(JSON.stringify({ name: "UnknownError", data: { message: "Unexpected server error." } }), {
          status: 500,
        }),
    })
    expect(sample).toEqual({ outcome: "engine-unclassified", status: 500 })
  })

  test("引擎答 401 → engine-unclassified(协议外应答一律不授权 kill,保留真实 status)", async () => {
    const sample = await probeCatalogMarker({
      ...opts,
      fetchImpl: async () => new Response("unauthorized", { status: 401 }),
    })
    expect(sample).toEqual({ outcome: "engine-unclassified", status: 401 })
  })

  test("我们自己的超时 → probe-failed/probe-timeout,不冒充引擎的回答", async () => {
    // fetch 挂死(连 signal 都不尊重),探针必须靠自己的硬上界返回,并把失败记在自己头上。
    const sample = await probeCatalogMarker({
      ...opts,
      timeoutMs: 20,
      fetchImpl: () => new Promise<Response>(() => {}),
    })
    expect(sample.outcome).toBe("probe-failed")
    if (sample.outcome === "probe-failed") expect(sample.reason).toBe("probe-timeout")
  })

  test("网络错(fetch reject)→ probe-failed/network", async () => {
    const sample = await probeCatalogMarker({
      ...opts,
      fetchImpl: async () => {
        throw new TypeError("fetch failed")
      },
    })
    expect(sample).toEqual({ outcome: "probe-failed", reason: "network", message: "fetch failed" })
  })

  test("非绝对路径目录拒绝出探(与 prewarm 同款防御)", async () => {
    const sample = await probeCatalogMarker({ ...opts, directory: "relative/dir" })
    expect(sample.outcome).toBe("probe-failed")
  })
})

// #564 接线锚(index.ts 是本仓唯一跑不进单测的文件,生产接线的最后一英里只能锁源码形状;
// 决策行为的真闸门在上面的纯函数用例里)。断言八件事:
// ① 恰好两处武装(boot 终态continuation + respawn 健康线之后),条件形状逐字锁定 ——
//    boot 只在干净 ready 终态武装(injection-failed 不武装),respawn 同判据;
// ② 决策被消费恰好一次(decideCatalogLiveness);
// ③ kill-and-respawn 裁决真的接到 current.kill()(交给既有 self-heal respawn 路径);
// ④ stop-and-report 裁决接到 recoveryService.register(显式恢复,不再自动 kill);
// ⑤ killSidecar 与 handleSidecarExit 都停表(旧代探针不得打在新代身上);
// ⑥ R1 Blocker:武装前判探针目录存在(不存在 = 观测面不可用,不武装、绝不代建),
//    且 indeterminate 弃权在 kill 分支**之前**被消费(弃权路径上不得出现 current.kill());
// ⑦ R2 Major:探针目录来自首屏解析(resolveCatalogProbeDirectory 唯一消费点),解析不出 /
//    不在盘上才回退默认工作区 —— 探针本体**不得**再打 alphaUserWorkspaceDir()(那正是
//    「只观测最廉价目录」的回归形状);
// ⑧ R2 Minor:探针 promise 链尾必须有 .catch(回调体任一抛出不得成为 main 的 unhandled
//    rejection),且 catch 内复位 probeInFlight(否则 probeCatalogMarker 意外 reject 会让
//    每个后续 tick 空转、看门狗静默失效)。
// 分类与「这处锚守不住什么」登记在 ./source-text-anchors.ts(`#968` 第 ⑤ 层机械校验)。
test("ANCHOR (not a gate): #564 看门狗武装/停表/裁决消费必须留在 index.ts 的接线形状里", () => {
  const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8")

  expect(source.split("armCatalogLivenessWatchdog(spawnGen)").length - 1).toBe(2)
  expect(source).toContain('if (terminal === "ready" && spawnGen === sidecarGen) armCatalogLivenessWatchdog(spawnGen)')
  expect(source).toContain("if (healthy && !injectionFailure && spawnGen === sidecarGen) armCatalogLivenessWatchdog(spawnGen)")
  expect(source.split("decideCatalogLiveness(").length - 1).toBe(1) // 唯一消费点(import 是裸标识符)

  const armStart = source.indexOf("const armCatalogLivenessWatchdog = (gen: number) => {")
  const armEnd = source.indexOf("CATALOG_LIVENESS_PROBE_INTERVAL_MS)", armStart)
  expect(armStart).toBeGreaterThan(-1)
  expect(armEnd).toBeGreaterThan(armStart)
  const armBody = source.slice(armStart, armEnd)
  expect(armBody).toContain('decision.action === "kill-and-respawn"')
  expect(armBody).toContain("current.kill()")
  expect(armBody).toContain("recoveryService.register")

  // ⑦ 探针目录:首屏解析唯一消费点;probe 打解析结果;唯一的 alphaUserWorkspaceDir() 出现在
  //    回退表达式里(probe 本体直呼它 = 回归到只观测最廉价目录,必须在这里红)。
  expect(source.split("resolveCatalogProbeDirectory(").length - 1).toBe(1)
  expect(armBody).toContain("probeCatalogMarker({ url, password, directory: probeDirectory })")
  expect(armBody).toContain("existsSync(userDirectory) ? userDirectory : alphaUserWorkspaceDir()")
  expect(armBody.split("alphaUserWorkspaceDir()").length - 1).toBe(1)

  // ⑥ 目录存在守卫:武装体内、armCatalogLiveness 之前(守卫失效 = 全新安装 60s 杀健康引擎)。
  const guardAt = armBody.indexOf("if (!existsSync(probeDirectory))")
  const armCallAt = armBody.indexOf("armCatalogLiveness(catalogLiveness")
  expect(guardAt).toBeGreaterThan(-1)
  expect(armCallAt).toBeGreaterThan(guardAt)
  expect(armBody).toContain("workspace-dir-missing")

  // ⑧ 链尾 .catch:在 .then 之后、且 catch 体内复位 probeInFlight。
  const thenAt = armBody.indexOf(".then((sample) => {")
  const catchAt = armBody.indexOf(".catch((error) => {", thenAt)
  expect(thenAt).toBeGreaterThan(-1)
  expect(catchAt).toBeGreaterThan(thenAt)
  expect(armBody.indexOf("catalogLivenessProbeInFlight = false", catchAt)).toBeGreaterThan(catchAt)
  // ⑥ indeterminate 弃权:在 kill 分支之前消费,且它与 current.kill() 之间隔着 return。
  const indeterminateAt = armBody.indexOf('decision.action === "indeterminate"')
  const killBranchAt = armBody.indexOf('decision.action === "kill-and-respawn"')
  expect(indeterminateAt).toBeGreaterThan(-1)
  expect(indeterminateAt).toBeLessThan(killBranchAt)
  expect(armBody).toContain("main.sidecar.catalog_liveness.indeterminate")

  const killFn = source.indexOf("async function killSidecar")
  const killFnEnd = source.indexOf("function endSessionGrants")
  expect(source.slice(killFn, killFnEnd)).toContain("stopCatalogLivenessWatchdog()")
  const exitFn = source.indexOf("function handleSidecarExit")
  const exitFnEnd = source.indexOf("function stopEngineRunawayMeter")
  expect(source.slice(exitFn, exitFnEnd)).toContain("stopCatalogLivenessWatchdog()")
})
