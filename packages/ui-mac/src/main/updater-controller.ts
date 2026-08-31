import type { UpdaterState } from "@opencode-ai/app/updater"

export type { UpdaterState } from "@opencode-ai/app/updater"

export type UpdaterReadyRecord = { version: string }

export type UpdaterBackend = {
  checkForUpdates(): Promise<{ isUpdateAvailable?: boolean; updateInfo?: { version?: string } } | null | undefined>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(): void
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
    if (state.status === "ready") return Promise.resolve(state)
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
      if (ready?.version === input.currentVersion) {
        // 上一会话装的就是这个版本 → 记录已兑现,清掉再照常检查。
        await input.persistence.clear()
      } else if (ready && input.enabled) {
        // [ac#1207] REQ-147 AC2:跨重启恢复。上一会话已完整下载并登记 ready,重启后把这份
        // 持久化记录**投影成状态**,让 UI 一启动就看得见「已就绪」入口 —— 而不是重新走一遍
        // checking→downloading(在线才到得了 ready,离线会把一份好端端的就绪更新报成 error)。
        // 记录版本是否仍然该装,不在这里做版本算术(手写 semver 比较 = 又一个别人文法的替身):
        // install() 会经 runCheck() 让 feed 重新裁决 —— 记录过期(如已手动装了更新的版本)
        // 时 feed 判 up-to-date,记录被清、入口消失;feed 有更新版本时装的是更新的那个。
        // 恢复态先不 check():ready 是稳态,check() 对 ready 本就早退;真正的重验发生在
        // install()(sessionDownloaded=false 分支),那里失败会响亮落 error。
        return transition({ status: "ready", version: ready.version })
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
