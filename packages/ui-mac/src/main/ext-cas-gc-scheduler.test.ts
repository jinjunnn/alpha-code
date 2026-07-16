// REQ-102 #318/#367 —— CAS GC 生产触发(#367 起单轮在 worker_threads 内执行):
//  · 调度语义(注入最小计时器 + spawn seam,手动执行 callback):首跑只 arm 延迟、执行后链式
//    rearm、spawn 失败仍 rearm(无同步回退)、stop 幂等 + 取消 + 旧 callback 不复活;
//  · spawnCasGcWorkerRound 事件合同矩阵:message 严格解码 / error / 非零 exit / 零 exit 无消息 /
//    畸形摘要 / 畸形 workerData(真入口 fail-closed);
//  · 真 worker 冒烟:TS 入口 + 小 store,一轮真实 sweep 经 worker 回传摘要;
//  · 构建接线守卫:electron.vite main 第三入口存在;
//  · productionCasGcConfig = composition root 的唯一权威取值点(#318,不变)。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { __resetAlphaEnvironmentForTests, environmentMutableRoot, initAlphaEnvironment } from "./alpha-environment"
import { CAS_GC_GRACE_MS_DEFAULT, type CasGcRoundInput, type CasGcRoundSummary } from "./ext-cas-gc"
import { decodeCasGcRoundInput } from "./ext-cas-gc-worker"
import { putCasBlobFromBuffer } from "./ext-cas"
import { resourcesRoot } from "./ext-fs-installer"
import {
  CAS_GC_INITIAL_DELAY_MS,
  CAS_GC_INTERVAL_MS,
  productionCasGcConfig,
  spawnCasGcWorkerRound,
  startCasGcScheduler,
  type CasGcSchedulerConfig,
  type CasGcSchedulerTimer,
  type CasGcSpawnRound,
} from "./ext-cas-gc-scheduler"

let base: string
let savedGlobalDir: string | undefined
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "cas-gc-sched-"))
  savedGlobalDir = process.env.ALPHA_GLOBAL_DIR // before-image(review #366:不污染同进程后续测试)
  __resetAlphaEnvironmentForTests()
  delete process.env.ALPHA_GLOBAL_DIR
})
afterEach(() => {
  __resetAlphaEnvironmentForTests()
  if (savedGlobalDir === undefined) delete process.env.ALPHA_GLOBAL_DIR
  else process.env.ALPHA_GLOBAL_DIR = savedGlobalDir
  fs.rmSync(base, { recursive: true, force: true })
})

/** microtask/timer 冲刷:tick 的 promise 链(spawn → log → finally arm)结算完再断言。 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const okSummary = (over: Partial<CasGcRoundSummary> = {}): CasGcRoundSummary => ({
  ok: true,
  dryRun: false,
  marked: 3,
  blobsTotal: 5,
  sweepableCount: 0,
  sweptCount: 0,
  keptByGrace: 1,
  warningCount: 0,
  ...over,
})

function fakeTimer() {
  const scheduled: Array<{ cb: () => void; delayMs: number; cancelled: boolean }> = []
  const timer: CasGcSchedulerTimer = {
    schedule: (cb, delayMs) => {
      const entry = { cb, delayMs, cancelled: false }
      scheduled.push(entry)
      return entry
    },
    cancel: (h) => {
      ;(h as { cancelled: boolean }).cancelled = true
    },
  }
  return { timer, scheduled }
}

const config: CasGcSchedulerConfig = {
  casBaseRoot: "/tmp/cas-base",
  envRoots: ["/tmp/cas-base", "/tmp/cas-base/env/prod"],
  seedLockPaths: ["/tmp/seed.lock.json"],
  graceMs: CAS_GC_GRACE_MS_DEFAULT,
  dryRun: false,
  initialDelayMs: 111,
  intervalMs: 222,
}

describe("startCasGcScheduler(#318/#367)", () => {
  test("首跑只 arm 初始延迟;执行后按线格 spawn 一轮并链式 rearm 周期", async () => {
    const { timer, scheduled } = fakeTimer()
    const rounds: CasGcRoundInput[] = []
    const spawnRound: CasGcSpawnRound = (input) => {
      rounds.push(input)
      return Promise.resolve(okSummary())
    }
    startCasGcScheduler(config, { timer, spawnRound, log: () => {} })
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]!.delayMs).toBe(111)
    expect(rounds).toHaveLength(0) // 未执行前不跑

    scheduled[0]!.cb()
    await flush()
    expect(rounds).toHaveLength(1)
    expect(rounds[0]).toEqual({
      casBaseRoot: "/tmp/cas-base",
      envRoots: config.envRoots,
      seedLockPaths: config.seedLockPaths,
      graceMs: CAS_GC_GRACE_MS_DEFAULT,
      dryRun: false,
    })
    expect(scheduled).toHaveLength(2) // 链式 rearm
    expect(scheduled[1]!.delayMs).toBe(222)
  })

  test("spawn reject / 同步抛错均不中断调度(finally rearm),异常按 gc-exception 记录,无同步回退", async () => {
    for (const spawnRound of [
      (() => Promise.reject(new Error("worker boom"))) as CasGcSpawnRound,
      (() => {
        throw new Error("spawn boom")
      }) as CasGcSpawnRound,
    ]) {
      const { timer, scheduled } = fakeTimer()
      const events: string[] = []
      startCasGcScheduler(config, { timer, spawnRound, log: (event) => events.push(event) })
      scheduled[0]!.cb()
      await flush()
      expect(events).toEqual(["gc-exception"])
      expect(scheduled).toHaveLength(2)
    }
  })

  test("stop 幂等取消当前 timer;stop 后旧 callback 被意外调用不执行、不 rearm", async () => {
    const { timer, scheduled } = fakeTimer()
    const rounds: unknown[] = []
    const spawnRound: CasGcSpawnRound = () => {
      rounds.push(1)
      return Promise.resolve(okSummary())
    }
    const s = startCasGcScheduler(config, { timer, spawnRound, log: () => {} })
    s.stop()
    s.stop() // 幂等
    expect(scheduled[0]!.cancelled).toBe(true)
    scheduled[0]!.cb() // 已取消的 callback 被意外调用
    await flush()
    expect(rounds).toHaveLength(0)
    expect(scheduled).toHaveLength(1) // 未 rearm
  })

  test("在途 worker 期间 stop → 该轮完成后 finally 不 rearm(不 terminate,自然结算)", async () => {
    const { timer, scheduled } = fakeTimer()
    let s: { stop(): void } | null = null
    const spawnRound: CasGcSpawnRound = () => {
      s!.stop() // 在途中触发 stop(等价于 quit 流程先行)
      return Promise.resolve(okSummary())
    }
    s = startCasGcScheduler(config, { timer, spawnRound, log: () => {} })
    scheduled[0]!.cb()
    await flush()
    expect(scheduled).toHaveLength(1) // stop 已置位,finally 的 arm 被拒
  })

  test("注入 logger 连续抛错不逃出调度链(仍 rearm)", async () => {
    const { timer, scheduled } = fakeTimer()
    const spawnRound: CasGcSpawnRound = () => Promise.resolve(okSummary())
    const log = () => {
      throw new Error("logger boom")
    }
    startCasGcScheduler(config, { timer, spawnRound, log })
    expect(() => scheduled[0]!.cb()).not.toThrow()
    await flush()
    expect(scheduled).toHaveLength(2) // 仍链式 rearm
  })

  test("摘要日志 outcome 分类:success / busy-skip / fail-closed;计数摘要不含路径", async () => {
    const cases: Array<{ summary: CasGcRoundSummary; expected: string }> = [
      { summary: okSummary(), expected: "gc-success" },
      { summary: okSummary({ ok: false, reason: "transaction in flight at /x — GC skipped (mutual exclusion)" }), expected: "gc-busy-skip" },
      { summary: okSummary({ ok: false, reason: "CAS lock busy: held" }), expected: "gc-busy-skip" },
      { summary: okSummary({ ok: false, reason: "corrupt pins ledger — refusing to GC (fail closed)" }), expected: "gc-fail-closed" },
    ]
    for (const c of cases) {
      const { timer, scheduled } = fakeTimer()
      const events: Array<{ event: string; detail: Record<string, unknown> }> = []
      startCasGcScheduler(config, { timer, spawnRound: () => Promise.resolve(c.summary), log: (event, detail) => events.push({ event, detail }) })
      scheduled[0]!.cb()
      await flush()
      expect(events[0]!.event).toBe(c.expected)
      // 结构化计数摘要,不落完整 swept 路径列表。
      expect(Object.keys(events[0]!.detail)).toContain("keptByGrace")
      expect(JSON.stringify(events[0]!.detail).includes("/cas/v1/sha256/")).toBe(false)
    }
  })
})

// ── #367:worker 事件合同(spawnCasGcWorkerRound 对 stub 入口的判定矩阵)──────────────────────

describe("spawnCasGcWorkerRound 事件合同(#367 裁决 Q3)", () => {
  const stub = (name: string, code: string): string => {
    const p = path.join(base, `${name}.mjs`)
    fs.writeFileSync(p, code)
    return p
  }

  test("零 exit 无消息 = 失败(不静默当成功)", async () => {
    const entry = stub("silent", "// exits without posting anything\n")
    await expect(spawnCasGcWorkerRound(minimalInput(), entry)).rejects.toThrow("exited without reporting a summary")
  })

  test("worker 抛错 → error 事件 → 失败", async () => {
    const entry = stub("thrower", 'throw new Error("stub boom")\n')
    await expect(spawnCasGcWorkerRound(minimalInput(), entry)).rejects.toThrow("stub boom")
  })

  test("畸形摘要 → 严格解码拒(fail-closed)", async () => {
    const entry = stub(
      "malformed",
      'import { parentPort } from "node:worker_threads"\nparentPort.postMessage({ nope: true })\n',
    )
    await expect(spawnCasGcWorkerRound(minimalInput(), entry)).rejects.toThrow("malformed summary")
  })

  test("真入口 + 畸形 workerData → 入口 fail-closed 抛错(相对路径拒)", async () => {
    const entry = new URL("./ext-cas-gc-worker.ts", import.meta.url)
    const bad: CasGcRoundInput = { ...minimalInput(), casBaseRoot: "not/absolute" }
    await expect(spawnCasGcWorkerRound(bad, entry)).rejects.toThrow("invalid workerData")
  })

  function minimalInput(): CasGcRoundInput {
    const root = path.join(base, "gc-input")
    fs.mkdirSync(root, { recursive: true })
    return { casBaseRoot: root, envRoots: [root], seedLockPaths: [], graceMs: CAS_GC_GRACE_MS_DEFAULT, dryRun: true }
  }
})

describe("decodeCasGcRoundInput(worker 入参 fail-closed)", () => {
  test("非对象 / 相对路径 / 形状错一律拒;合法输入原样通过", () => {
    expect(decodeCasGcRoundInput(null).ok).toBe(false)
    expect(decodeCasGcRoundInput({ casBaseRoot: "rel", envRoots: [], seedLockPaths: [], graceMs: 1, dryRun: true }).ok).toBe(false)
    expect(decodeCasGcRoundInput({ casBaseRoot: "/a", envRoots: ["rel"], seedLockPaths: [], graceMs: 1, dryRun: true }).ok).toBe(false)
    expect(decodeCasGcRoundInput({ casBaseRoot: "/a", envRoots: ["/b"], seedLockPaths: [1], graceMs: 1, dryRun: true }).ok).toBe(false)
    expect(decodeCasGcRoundInput({ casBaseRoot: "/a", envRoots: ["/b"], seedLockPaths: [], graceMs: -1, dryRun: true }).ok).toBe(false)
    expect(decodeCasGcRoundInput({ casBaseRoot: "/a", envRoots: ["/b"], seedLockPaths: [], graceMs: 1, dryRun: "yes" }).ok).toBe(false)
    const good = { casBaseRoot: "/a", envRoots: ["/b"], seedLockPaths: ["/s.json"], graceMs: 5, dryRun: false }
    const decoded = decodeCasGcRoundInput(good)
    expect(decoded.ok).toBe(true)
    if (decoded.ok) expect(decoded.input).toEqual(good)
  })
})

// ── 集成冒烟:fake timer → 真 worker(TS 入口)→ 真 collectCasGarbage(#367)───────────────────

describe("集成冒烟:调度器 → worker_threads → 真实 sweep(#367)", () => {
  test("一轮真实 sweep 经 worker 回传摘要:cold blob 被扫,outcome=gc-success,配置透传", async () => {
    const casBase = path.join(base, "cas-int")
    const envRoot = path.join(base, "env-int")
    fs.mkdirSync(envRoot, { recursive: true })
    const content = "integration cold victim"
    const digest = crypto.createHash("sha256").update(content).digest("hex")
    const put = putCasBlobFromBuffer(casBase, Buffer.from(content), digest)
    if (!put.ok) throw new Error(put.reason)
    fs.utimesSync(put.path, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"))

    const { timer, scheduled } = fakeTimer()
    const events: Array<{ event: string; detail: Record<string, unknown> }> = []
    const workerEntry = new URL("./ext-cas-gc-worker.ts", import.meta.url)
    startCasGcScheduler(
      {
        casBaseRoot: casBase,
        envRoots: [envRoot],
        seedLockPaths: [], // 冒烟不带 seed(空集合法;缺失 fail-closed 由 gc.test 的 seed 矩阵覆盖)
        graceMs: CAS_GC_GRACE_MS_DEFAULT,
        dryRun: false,
        initialDelayMs: 1,
        intervalMs: 2,
      },
      { timer, spawnRound: (input) => spawnCasGcWorkerRound(input, workerEntry), log: (event, detail) => events.push({ event, detail }) },
    )
    scheduled[0]!.cb()
    // 真 worker 有启动耗时:轮询等待结算(上限 10s,足够 CI 冷启动)。
    for (let i = 0; i < 200 && events.length === 0; i++) await new Promise((r) => setTimeout(r, 50))
    expect(events[0]!.event).toBe("gc-success")
    expect(events[0]!.detail.swept).toBe(1)
    expect(fs.existsSync(put.path)).toBe(false) // cold blob 真被扫
    expect(scheduled).toHaveLength(2) // 链式 rearm
  })
})

// ── 构建接线守卫:worker 第三入口必须在 electron.vite main 构建里(#367 裁决 Q2)──────────────

describe("worker 构建入口 wiring(#367)", () => {
  test("electron.vite.config.ts 声明 ext-cas-gc-worker 第三入口(缺失 = 打包后 spawn 必失败)", () => {
    const cfg = fs.readFileSync(path.join(import.meta.dir, "..", "..", "electron.vite.config.ts"), "utf8")
    expect(cfg).toContain('"ext-cas-gc-worker": "src/main/ext-cas-gc-worker.ts"')
  })
})

describe("productionCasGcConfig(#318 composition root 权威取值点)", () => {
  test("未初始化环境即抛(fail-fast);初始化后 = 冻结共享根 + 三环境根固定顺序 + 无条件 seed lock + 显式非零 grace", () => {
    expect(() => productionCasGcConfig()).toThrow()
    initAlphaEnvironment({ isPackaged: true, channel: "prod", homeDir: base })
    const cfg = productionCasGcConfig()
    const expectedBase = path.join(base, ".alpha")
    expect(cfg.casBaseRoot).toBe(expectedBase) // 冻结共享 CAS 基根(≠ prod mutable root)
    expect(cfg.envRoots).toEqual([
      environmentMutableRoot("dev", expectedBase),
      environmentMutableRoot("prod", expectedBase),
      environmentMutableRoot("beta", expectedBase),
    ])
    // 无条件传入(不做存在性检查 —— 缺包 = collector 整轮 fail-closed,不静默退化)。
    expect(cfg.seedLockPaths).toEqual([path.join(resourcesRoot(), "extension-seed", "seed.lock.json")])
    expect(cfg.graceMs).toBe(CAS_GC_GRACE_MS_DEFAULT)
    expect(cfg.graceMs).toBeGreaterThan(0)
    expect(cfg.dryRun).toBe(false)
    expect(cfg.initialDelayMs).toBe(CAS_GC_INITIAL_DELAY_MS)
    expect(cfg.intervalMs).toBe(CAS_GC_INTERVAL_MS)
    expect(CAS_GC_INITIAL_DELAY_MS).toBe(5 * 60 * 1000)
    expect(CAS_GC_INTERVAL_MS).toBe(24 * 60 * 60 * 1000)
  })
})
