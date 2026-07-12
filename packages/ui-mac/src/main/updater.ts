import * as fs from "node:fs"
import * as path from "node:path"
import { app, dialog } from "electron"
import pkg from "electron-updater"
import { UPDATER_ENABLED } from "./constants"
import { getAlphaEnvironment, parseAppUpdateYml, verifyUpdaterFeed, type PackagedFeed } from "./alpha-environment"
import { createUpdaterController, type UpdaterReadyRecord } from "./updater-controller"
import { getLogger } from "./logging"
import { getStore } from "./store"

const { autoUpdater } = pkg
const key = "ready"

// REQ-098 T4:构建发布 channel 的落盘真相 = electron-builder 写进包内的 app-update.yml。缺文件
// (本地 dir 构建无 publish 元数据)→ null,只核运行时映射(electron-updater 检查时自会失败)。
function readPackagedFeed(): PackagedFeed | null {
  if (!app.isPackaged) return null
  try {
    const file = path.join(process.resourcesPath, "app-update.yml")
    if (!fs.existsSync(file)) return null
    return parseAppUpdateYml(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

export function setupAutoUpdater(stop: () => Promise<void>) {
  const logger = getLogger()
  const envInfo = getAlphaEnvironment()
  autoUpdater.logger = logger
  // REQ-098 T4:feed channel 由唯一环境映射派生(prod→latest=stable feed;beta→beta=preview feed,
  // 维持 ADR-012 休眠语义 —— 机制对齐、不启用发布,#232 拍板 B;dev 不启用 updater,UPDATER_ENABLED)。
  autoUpdater.channel = envInfo.updaterFeedChannel ?? "latest"
  // beta 的 preview feed 以 GitHub pre-release 承载 —— 仅 beta 环境放行 prerelease。
  autoUpdater.allowPrerelease = envInfo.environment === "beta"
  // B9:关降级(上游 desktop 模式遗留 true——它要跨 dev/beta/prod 渠道切换;alpha 单 prod 渠道
  // 无此需求)。开着 = 降级攻击面:feed 被替换/重放旧版可把用户打回含已修漏洞的版本。要装旧版的
  // 逃生口 = 手动下载 GitHub Release 的 dmg(有签名+公证),不走自动更新。
  autoUpdater.allowDowngrade = false
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  // REQ-098 T4(AC#2 loud-fail):构建发布 channel / 运行时检查 channel / 环境映射三侧一致性校验。
  // 错误映射(如 beta 构建配了 latest feed、feed 指向非自有仓)→ 启动即显式报错并禁用 updater ——
  // 绝不带错 feed 去 update-check(拉错 feed = 降级/换发行线攻击面)。
  let enabled = UPDATER_ENABLED
  if (enabled) {
    const verdict = verifyUpdaterFeed({
      environment: envInfo.environment,
      runtimeChannel: autoUpdater.channel,
      packaged: readPackagedFeed(),
    })
    if (!verdict.ok) {
      enabled = false
      logger.error("REQ-098: updater feed mapping INVALID — updater disabled (loud-fail)", { reason: verdict.reason })
      dialog.showErrorBox(
        "更新通道配置错误",
        `此构建的更新通道映射不一致,自动更新已禁用:\n${verdict.reason}\n请从官方渠道重新下载安装包。`,
      )
    }
  }

  logger.log("auto updater configured", {
    environment: envInfo.environment,
    channel: autoUpdater.channel,
    enabled,
    allowPrerelease: autoUpdater.allowPrerelease,
    allowDowngrade: autoUpdater.allowDowngrade,
    currentVersion: app.getVersion(),
  })

  const store = getStore("opencode.updater")
  return createUpdaterController({
    enabled,
    currentVersion: app.getVersion(),
    backend: autoUpdater,
    persistence: {
      get() {
        const value = store.get(key)
        if (!value || typeof value !== "object" || !("version" in value) || typeof value.version !== "string") return
        return { version: value.version } satisfies UpdaterReadyRecord
      },
      set: (value) => store.set(key, value),
      clear: () => store.delete(key),
    },
    stop,
    log: (message, data) => logger.log(message, data),
  })
}

export async function showUpdaterDialog(controller: ReturnType<typeof setupAutoUpdater>, alertOnFail: boolean) {
  const state = await controller.check()
  if (state.status === "error") {
    if (!alertOnFail) return
    await dialog.showMessageBox({ type: "error", message: "Update check failed.", title: "Update Error" })
    return
  }
  if (state.status === "up-to-date") {
    if (!alertOnFail) return
    await dialog.showMessageBox({ type: "info", message: "You're up to date.", title: "No Updates" })
    return
  }
  if (state.status !== "ready") return

  const response = await dialog.showMessageBox({
    type: "info",
    message: `Update ${state.version} downloaded. Restart now?`,
    title: "Update Ready",
    buttons: ["Restart", "Later"],
    defaultId: 0,
    cancelId: 1,
  })
  if (response.response === 0) await controller.install()
}
