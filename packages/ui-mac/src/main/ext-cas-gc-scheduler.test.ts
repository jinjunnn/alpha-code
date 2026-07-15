// REQ-102 #318 —— CAS GC 生产触发:
//  · 调度语义(注入最小计时器,手动执行 callback):首跑只 arm 延迟、执行后链式 rearm、run 抛错
//    仍 rearm、stop 幂等 + 取消 + 旧 callback 不复活;
//  · productionCasGcConfig = composition root 的唯一权威取值点(冻结共享 CAS 根、三环境根固定
//    顺序、无条件 seed lock 路径、显式非零 grace、dryRun=false、5min/24h);
//  · 结构化摘要日志的 outcome 分类(success / busy-skip / fail-closed / exception)。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { __resetAlphaEnvironmentForTests, environmentMutableRoot, initAlphaEnvironment } from "./alpha-environment"
import { CAS_GC_GRACE_MS_DEFAULT, type CasGcReport } from "./ext-cas-gc"
import { putCasBlobFromBuffer } from "./ext-cas"
import { resourcesRoot } from "./ext-fs-installer"
import {
  CAS_GC_INITIAL_DELAY_MS,
  CAS_GC_INTERVAL_MS,
  productionCasGcConfig,
  startCasGcScheduler,
  type CasGcSchedulerConfig,
  type CasGcSchedulerTimer,
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

const okReport = (over: Partial<CasGcReport> = {}): CasGcReport => ({
  ok: true,
  dryRun: false,
  marked: 3,
  blobsTotal: 5,
  sweepable: [],
  swept: [],
  keptByGrace: 1,
  warnings: [],
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

describe("startCasGcScheduler(#318)", () => {
  test("首跑只 arm 初始延迟;执行后按参数调 run 并链式 rearm 周期", () => {
    const { timer, scheduled } = fakeTimer()
    const runs: Array<{ baseRoot: string; opts: Record<string, unknown> }> = []
    const run = ((baseRoot: string, opts: Record<string, unknown>) => {
      runs.push({ baseRoot, opts })
      return okReport()
    }) as never
    startCasGcScheduler(config, { timer, run, log: () => {} })
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]!.delayMs).toBe(111)
    expect(runs).toHaveLength(0) // 未执行前不跑

    scheduled[0]!.cb()
    expect(runs).toHaveLength(1)
    expect(runs[0]!.baseRoot).toBe("/tmp/cas-base")
    expect(runs[0]!.opts).toEqual({
      envRoots: config.envRoots,
      seedLockPaths: config.seedLockPaths,
      graceMs: CAS_GC_GRACE_MS_DEFAULT,
      dryRun: false,
    })
    expect(scheduled).toHaveLength(2) // 链式 rearm
    expect(scheduled[1]!.delayMs).toBe(222)
  })

  test("run 抛错不中断调度(finally rearm),异常按 gc-exception 记录", () => {
    const { timer, scheduled } = fakeTimer()
    const events: string[] = []
    const run = (() => {
      throw new Error("boom")
    }) as never
    startCasGcScheduler(config, { timer, run, log: (event) => events.push(event) })
    scheduled[0]!.cb()
    expect(events).toEqual(["gc-exception"])
    expect(scheduled).toHaveLength(2)
  })

  test("stop 幂等取消当前 timer;stop 后旧 callback 被意外调用不执行、不 rearm", () => {
    const { timer, scheduled } = fakeTimer()
    const runs: unknown[] = []
    const run = (() => {
      runs.push(1)
      return okReport()
    }) as never
    const s = startCasGcScheduler(config, { timer, run, log: () => {} })
    s.stop()
    s.stop() // 幂等
    expect(scheduled[0]!.cancelled).toBe(true)
    scheduled[0]!.cb() // 已取消的 callback 被意外调用
    expect(runs).toHaveLength(0)
    expect(scheduled).toHaveLength(1) // 未 rearm
  })

  test("tick 执行中 stop(run 内部触发)→ finally 不 rearm", () => {
    const { timer, scheduled } = fakeTimer()
    let s: { stop(): void } | null = null
    const run = (() => {
      s!.stop()
      return okReport()
    }) as never
    s = startCasGcScheduler(config, { timer, run, log: () => {} })
    scheduled[0]!.cb()
    expect(scheduled).toHaveLength(1) // stop 已置位,finally 的 arm 被拒
  })

  test("注入 logger 连续抛错不逃出 timer callback(调度链完整)", () => {
    const { timer, scheduled } = fakeTimer()
    const run = (() => okReport()) as never
    const log = () => {
      throw new Error("logger boom")
    }
    startCasGcScheduler(config, { timer, run, log })
    expect(() => scheduled[0]!.cb()).not.toThrow()
    expect(scheduled).toHaveLength(2) // 仍链式 rearm
  })

  test("摘要日志 outcome 分类:success / busy-skip / fail-closed", () => {
    const cases: Array<{ report: CasGcReport; expected: string }> = [
      { report: okReport(), expected: "gc-success" },
      { report: okReport({ ok: false, reason: "transaction in flight at /x — GC skipped (mutual exclusion)" }), expected: "gc-busy-skip" },
      { report: okReport({ ok: false, reason: "CAS lock busy: held" }), expected: "gc-busy-skip" },
      { report: okReport({ ok: false, reason: "corrupt pins ledger — refusing to GC (fail closed)" }), expected: "gc-fail-closed" },
    ]
    for (const c of cases) {
      const { timer, scheduled } = fakeTimer()
      const events: Array<{ event: string; detail: Record<string, unknown> }> = []
      startCasGcScheduler(config, { timer, run: (() => c.report) as never, log: (event, detail) => events.push({ event, detail }) })
      scheduled[0]!.cb()
      expect(events[0]!.event).toBe(c.expected)
      // 结构化计数摘要,不落完整 swept 路径列表。
      expect(Object.keys(events[0]!.detail)).toContain("keptByGrace")
      expect(JSON.stringify(events[0]!.detail).includes("/cas/v1/sha256/")).toBe(false)
    }
  })
})

describe("集成冒烟:fake timer → 真 collectCasGarbage(#318)", () => {
  test("一轮真实 sweep:cold blob 被扫,outcome=gc-success,配置透传", () => {
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
      { timer, log: (event, detail) => events.push({ event, detail }) }, // run 用真 collectCasGarbage
    )
    scheduled[0]!.cb()
    expect(events[0]!.event).toBe("gc-success")
    expect(events[0]!.detail.swept).toBe(1)
    expect(fs.existsSync(put.path)).toBe(false) // cold blob 真被扫
    expect(scheduled).toHaveLength(2) // 链式 rearm
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
