import type { UpdaterState } from "@opencode-ai/app/updater"

export type { UpdaterState } from "@opencode-ai/app/updater"

export type UpdaterReadyRecord = { version: string }

export type UpdaterBackend = {
  checkForUpdates(): Promise<{ isUpdateAvailable?: boolean; updateInfo?: { version?: string } } | null | undefined>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(): void
  // [ac#1559] 版本新旧只由更新器自身判断(electron-updater 的 currentVersion),本模块不做版本算术。
  isNewer(version: string): boolean
}

type UpdaterPersistence = {
  get(): UpdaterReadyRecord | undefined | Promise<UpdaterReadyRecord | undefined>
  set(value: UpdaterReadyRecord): void | Promise<void>
  clear(): void | Promise<void>
}

export function createUpdaterController(input: {
  enabled: boolean
  currentVersion: string
  backend: UpdaterBackend
  persistence: UpdaterPersistence
  stop: () => Promise<void>
  log?: (message: string, data?: object) => void
}) {
  let state: UpdaterState = input.enabled ? { status: "idle" } : { status: "disabled" }
  let pending: Promise<UpdaterState> | undefined
  // [ac#1207] backend.downloadUpdate() 在**本进程生命周期内**是否完整跑过。macOS 上
  // electron-updater 的 quitAndInstall 依赖 downloadUpdate 建立的 Squirrel 本地代理
  // (MacUpdater.updateDownloaded 起 http server 再喂 nativeUpdater;实读
  // electron-updater@6.8.9/out/MacUpdater.js)。从持久化恢复的 ready(见 start())没有
  // 这个代理,直接 quitAndInstall = 只退出不安装 —— 所以 install() 对恢复态先经
  // runCheck() 重建(缓存 zip ⇒ 差分/免下载,秒级);离线则落 error,响亮失败。
  let sessionDownloaded = false
  const listeners = new Set<(state: UpdaterState) => void>()

  const transition = (next: UpdaterState) => {
    input.log?.("updater state changed", { from: state.status, to: next.status })
    state = next
    listeners.forEach((listener) => listener(state))
    return state
  }

  // check() 去掉 ready 早退后的真实检查流。install() 的恢复态重验也走这里 —— 同一份机器,
  // 不为恢复态另造一条下载路径。
  const runCheck = () => {
    if (pending) return pending

    pending = (async () => {
      transition({ status: "checking" })
      const result = await input.backend.checkForUpdates()
      const version = result?.updateInfo?.version
      if (!result?.isUpdateAvailable || !version || version === input.currentVersion) {
        await input.persistence.clear()
        return transition({ status: "up-to-date" })
      }

      transition({ status: "downloading", version })
      await input.backend.downloadUpdate()
      sessionDownloaded = true
      await input.persistence.set({ version })
      return transition({ status: "ready", version })
    })()
      .catch((error) =>
        transition({ status: "error", message: error instanceof Error ? error.message : String(error) }),
      )
      .finally(() => {
        pending = undefined
      })
    return pending
  }

  const check = () => {
    if (!input.enabled) return Promise.resolve(state)
    // [ac#1559] 只有本进程实际下载完成的 ready 才早退;从记录恢复的 ready 不阻断后台检查。
    if (state.status === "ready" && sessionDownloaded) return Promise.resolve(state)
    return runCheck()
  }

  return {
    getState: () => state,
    subscribe(listener: (state: UpdaterState) => void) {
      listeners.add(listener)
      listener(state)
      return () => listeners.delete(listener)
    },
    async start() {
      const ready = await input.persistence.get()
      if (ready) {
        // [ac#1559] 只有比当前版本新的记录才投影成 ready(REQ-147 AC2 跨重启恢复);旧于或等于当前的
        // 记录(已装完 / 陈旧)清掉,照常检查。恢复出来的 ready 不让 check() 早退,后台检查照常重判。
        const newer = input.backend.isNewer(ready.version)
        const restore = newer && input.enabled
        input.log?.("updater restore decision", {
          version: ready.version,
          currentVersion: input.currentVersion,
          decision: restore ? "restore-ready" : newer ? "keep-disabled" : "clear-not-newer",
        })
        if (!newer) await input.persistence.clear()
        if (restore) return transition({ status: "ready", version: ready.version })
      }
      return check()
    },
    check,
    async install() {
      let current = state
      if (current.status !== "ready") throw new Error("Update is not ready to install")
      if (!sessionDownloaded) {
        // 从持久化恢复的 ready:Squirrel 代理未建立(见 sessionDownloaded 抬头),先重走真实
        // 检查/下载流(缓存 zip ⇒ 秒级)。到不了 ready(离线 error / 记录过期 up-to-date)就
        // 停在那个状态 —— 它已经推给了所有订阅者,呈现层负责让人看见,这里不装成功。
        current = await runCheck()
        if (current.status !== "ready") return
      }
      const version = current.version
      if (!input.backend.isNewer(version)) {
        // [ac#1559] 安装前再判一次:目标不新于当前就不装。
        await input.persistence.clear()
        transition({ status: "up-to-date" })
        return
      }
      transition({ status: "installing", version })
      await input
        .stop()
        .then(() => {
          input.backend.quitAndInstall()
          transition({ status: "ready", version })
        })
        .catch((error) => {
          transition({ status: "ready", version })
          throw error
        })
    },
  }
}

export type UpdaterController = ReturnType<typeof createUpdaterController>
