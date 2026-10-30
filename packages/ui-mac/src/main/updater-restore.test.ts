// [ac#1207] REQ-147 AC2(main 半场)—— 持久化的 ready 记录在启动时投影成状态,且从恢复态
// 触发安装时先经真实检查流重建 Squirrel 代理(实读 electron-updater@6.8.9/out/MacUpdater.js:
// quitAndInstall 依赖本会话 downloadUpdate 建立的本地代理,直接调用 = 只退出不安装)。
// renderer 半场(ready 状态 → 可见入口可点击)在 test-component/updater-surface.cases.ts。
//
// 纯 createUpdaterController 单测:controller 模块对 electron 零运行时依赖(上游类型是
// type-only import),backend/persistence 都是本文件的显式桩 —— 桩替的是 electron-updater
// 传输层,不是被测语义(状态机与持久化协议本身)。

import { createRequire } from "node:module"
import { describe, expect, test } from "bun:test"
import { createUpdaterController, type UpdaterReadyRecord } from "./updater-controller"

// [ac#1559] 桩后端的 isNewer 用 electron-updater **自己依赖的那份** semver(经它的包解析,不是新依赖),
// 与 updater.ts 的 `autoUpdater.currentVersion.compare(version) < 0` 同一个表达式 —— AppUpdater.js:213
// 正是 `semver.parse(app.getVersion())` 造出 currentVersion。
const { SemVer } = createRequire(createRequire(import.meta.url).resolve("electron-updater"))("semver") as {
  SemVer: new (version: string) => { compare(other: string): number }
}

function makeBackend(feed: { available: boolean; version?: string; failCheck?: boolean }, currentVersion: string) {
  const calls: string[] = []
  const current = new SemVer(currentVersion)
  return {
    calls,
    backend: {
      async checkForUpdates() {
        calls.push("checkForUpdates")
        if (feed.failCheck) throw new Error("offline-sentinel")
        return { isUpdateAvailable: feed.available, updateInfo: { version: feed.version } }
      },
      async downloadUpdate() {
        calls.push("downloadUpdate")
        return undefined
      },
      quitAndInstall() {
        calls.push("quitAndInstall")
      },
      isNewer: (version: string) => current.compare(version) < 0,
    },
  }
}

function makePersistence(initial?: UpdaterReadyRecord) {
  let record: UpdaterReadyRecord | undefined = initial
  return {
    read: () => record,
    persistence: {
      get: () => record,
      set(value: UpdaterReadyRecord) {
        record = value
      },
      clear() {
        record = undefined
      },
    },
  }
}

function make(input: {
  record?: UpdaterReadyRecord
  feed: Parameters<typeof makeBackend>[0]
  enabled?: boolean
  currentVersion?: string
}) {
  const currentVersion = input.currentVersion ?? "1.0.0"
  const { backend, calls } = makeBackend(input.feed, currentVersion)
  const { persistence, read } = makePersistence(input.record)
  const seen: string[] = []
  const logs: { message: string; data?: object }[] = []
  const controller = createUpdaterController({
    enabled: input.enabled ?? true,
    currentVersion,
    backend,
    persistence,
    stop: async () => {},
    log: (message, data) => logs.push({ message, data }),
  })
  controller.subscribe((state) => seen.push(state.status))
  return { controller, calls, read, seen, logs, backend }
}

describe("updater 跨重启恢复(REQ-147 AC2)", () => {
  test("持久化 ready(版本≠当前)→ start() 直接投影为 ready,不重走网络检查", async () => {
    const { controller, calls, read } = make({ record: { version: "9.9.9" }, feed: { available: false } })
    const state = await controller.start()
    expect(state).toEqual({ status: "ready", version: "9.9.9" })
    expect(controller.getState()).toEqual({ status: "ready", version: "9.9.9" })
    expect(calls).toEqual([]) // 离线重启也看得见入口 —— 这正是「投影持久化记录」与「重新检查」的差别
    expect(read()).toEqual({ version: "9.9.9" }) // 记录未兑现,不清
  })

  test("持久化 ready 版本==当前(上一会话已装完)→ 清记录,照常检查", async () => {
    const { controller, calls, read } = make({
      record: { version: "1.0.0" },
      feed: { available: false },
    })
    const state = await controller.start()
    expect(state.status).toBe("up-to-date")
    expect(read()).toBeUndefined()
    expect(calls).toEqual(["checkForUpdates"])
  })

  test("updater 未启用时不投影(不给 dev 构建画一个装不了的入口)", async () => {
    const { controller, calls } = make({ record: { version: "9.9.9" }, feed: { available: false }, enabled: false })
    const state = await controller.start()
    expect(state.status).toBe("disabled")
    expect(calls).toEqual([])
  })

  test("恢复态 install():先重走检查/下载流重建 Squirrel 代理,再 quitAndInstall", async () => {
    const { controller, calls, seen } = make({
      record: { version: "9.9.9" },
      feed: { available: true, version: "9.9.9" },
    })
    await controller.start()
    await controller.install()
    expect(calls).toEqual(["checkForUpdates", "downloadUpdate", "quitAndInstall"])
    // 状态全程走真实通道:订阅回放初始 idle → 恢复投影 ready → 重验 checking/downloading/ready
    // → installing → ready(quitAndInstall 后回落,与既有语义一致)
    expect(seen).toEqual(["idle", "ready", "checking", "downloading", "ready", "installing", "ready"])
  })

  test("恢复态 install() 重验失败(离线)→ 停在 error,绝不 quitAndInstall", async () => {
    const { controller, calls } = make({ record: { version: "9.9.9" }, feed: { available: false, failCheck: true } })
    await controller.start()
    await controller.install()
    expect(calls).toEqual(["checkForUpdates"])
    expect(controller.getState()).toEqual({ status: "error", message: "offline-sentinel" })
  })

  test("恢复态 install() 记录已过期(feed 判无更新)→ up-to-date,清记录,不安装", async () => {
    const { controller, calls, read } = make({ record: { version: "1.5.0" }, feed: { available: false } })
    await controller.start()
    expect(controller.getState()).toEqual({ status: "ready", version: "1.5.0" })
    await controller.install()
    expect(calls).toEqual(["checkForUpdates"])
    expect(controller.getState().status).toBe("up-to-date")
    expect(read()).toBeUndefined()
  })

  test("本会话下载达成的 ready:install() 不重复检查,直接安装(护住原路径)", async () => {
    const { controller, calls } = make({ record: undefined, feed: { available: true, version: "2.0.0" } })
    await controller.start()
    expect(controller.getState()).toEqual({ status: "ready", version: "2.0.0" })
    await controller.install()
    expect(calls).toEqual(["checkForUpdates", "downloadUpdate", "quitAndInstall"])
  })

  test("本会话下载达成的 ready:定时器 check() 早退,不重复下载(既有语义不回归)", async () => {
    const { controller, calls } = make({ record: undefined, feed: { available: true, version: "2.0.0" } })
    await controller.start()
    const state = await controller.check()
    expect(state).toEqual({ status: "ready", version: "2.0.0" })
    expect(calls).toEqual(["checkForUpdates", "downloadUpdate"])
  })
})

describe("更新提示只出现比当前版本新的已下载更新(ac#1559)", () => {
  test("AC1:记录 0.1.17 + 当前 0.1.22 ⇒ 不进 ready、清记录、调用 check", async () => {
    const { controller, calls, read, seen } = make({
      record: { version: "0.1.17" },
      currentVersion: "0.1.22",
      feed: { available: false },
    })
    const state = await controller.start()
    expect(state.status).toBe("up-to-date")
    expect(seen).not.toContain("ready")
    expect(read()).toBeUndefined()
    expect(calls).toEqual(["checkForUpdates"])
  })

  test("AC1:记录比当前新(0.1.23 vs 0.1.22)⇒ 恢复 ready,保留记录", async () => {
    const { controller, calls, read } = make({
      record: { version: "0.1.23" },
      currentVersion: "0.1.22",
      feed: { available: false },
    })
    const state = await controller.start()
    expect(state).toEqual({ status: "ready", version: "0.1.23" })
    expect(calls).toEqual([])
    expect(read()).toEqual({ version: "0.1.23" })
  })

  test("AC2:恢复出来的 ready 不阻断后台定时 check(),照常重判", async () => {
    const { controller, calls, read } = make({
      record: { version: "0.1.23" },
      currentVersion: "0.1.22",
      feed: { available: false },
    })
    await controller.start()
    const state = await controller.check()
    expect(calls).toEqual(["checkForUpdates"])
    expect(state.status).toBe("up-to-date")
    expect(read()).toBeUndefined()
  })

  test("AC3:install() 目标不新于当前 ⇒ 清记录、转 up-to-date,不调用 quitAndInstall", async () => {
    // 本会话下载达成 ready 后,当前版本已不低于目标(isNewer 判否)—— install 前的再判必须拦住。
    const { controller, calls, read, backend } = make({
      record: undefined,
      currentVersion: "0.1.22",
      feed: { available: true, version: "0.1.23" },
    })
    await controller.start()
    expect(controller.getState()).toEqual({ status: "ready", version: "0.1.23" })
    backend.isNewer = () => false
    await controller.install()
    expect(calls).not.toContain("quitAndInstall")
    expect(controller.getState().status).toBe("up-to-date")
    expect(read()).toBeUndefined()
  })

  test("AC4:桩后端 isNewer = 更新器 SemVer 判断(数值序,不是字符串序)", () => {
    const { backend } = make({ currentVersion: "0.1.22", feed: { available: false } })
    expect(backend.isNewer("0.1.17")).toBe(false)
    expect(backend.isNewer("0.1.22")).toBe(false)
    expect(backend.isNewer("0.1.23")).toBe(true)
    expect(backend.isNewer("0.1.100")).toBe(true) // 字符串比较会判成更旧
    expect(backend.isNewer("0.2.0")).toBe(true)
  })

  test("AC4:每次恢复决策写一条日志(记录版本、当前版本、结论)", async () => {
    const cleared = make({ record: { version: "0.1.17" }, currentVersion: "0.1.22", feed: { available: false } })
    await cleared.controller.start()
    const restored = make({ record: { version: "0.1.23" }, currentVersion: "0.1.22", feed: { available: false } })
    await restored.controller.start()
    const decisions = (logs: { message: string; data?: object }[]) =>
      logs.filter((entry) => entry.message === "updater restore decision")
    expect(decisions(cleared.logs)).toEqual([
      {
        message: "updater restore decision",
        data: { version: "0.1.17", currentVersion: "0.1.22", decision: "clear-not-newer" },
      },
    ])
    expect(decisions(restored.logs)).toEqual([
      {
        message: "updater restore decision",
        data: { version: "0.1.23", currentVersion: "0.1.22", decision: "restore-ready" },
      },
    ])
  })
})
