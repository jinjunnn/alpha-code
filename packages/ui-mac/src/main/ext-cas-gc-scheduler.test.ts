// REQ-102 #318 —— CAS GC 生产触发:
//  · 调度语义(注入最小计时器,手动执行 callback):首跑只 arm 延迟、执行后链式 rearm、run 抛错
//    仍 rearm、stop 幂等 + 取消 + 旧 callback 不复活;
//  · productionCasGcConfig = composition root 的唯一权威取值点(冻结共享 CAS 根、三环境根固定
//    顺序、无条件 seed lock 路径、显式非零 grace、dryRun=false、5min/24h);
//  · 结构化摘要日志的 outcome 分类(success / busy-skip / fail-closed / exception)。

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { __resetAlphaEnvironmentForTests, environmentMutableRoot, initAlphaEnvironment } from "./alpha-environment"
import { CAS_GC_GRACE_MS_DEFAULT, type CasGcReport } from "./ext-cas-gc"
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
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "cas-gc-sched-"))
  __resetAlphaEnvironmentForTests()
  delete process.env.ALPHA_GLOBAL_DIR
})
afterEach(() => {
  __resetAlphaEnvironmentForTests()
  delete process.env.ALPHA_GLOBAL_DIR
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
