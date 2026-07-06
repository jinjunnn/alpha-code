// data-clear-boot —— C16 数据清除的 electron 接线层(逻辑核在 data-clear.ts,本层只做 IO 组装 +
// 对话框流)。挂「数据」菜单(B14 同屏,menu.ts);文案中文硬编码(main 无 i18n,ADR-022 先例)。
//
// 分级流:
//   凭证级(dev/打包均可用):确认 → 清 BYOK 内存库 + 撤密钥 env + 删凭证文件 → logout()(重置态 +
//   respawn,fork 时 syncSecretFiles 对缺失 env 做删除 → 不会复活残件)→ 完成提示。
//   全部级(仅打包态,B14 同款理由:dev 分支后缀库 + 共享 ~/.alpha,删错目标风险 > 收益):
//   先备份提示(B14 验收④)→ 红色终确认(列将删项 + 体积 + 共享面 checkbox)→ 停引擎 → 清除 →
//   退出(数据已清,无可重启的状态)。

import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { app, dialog } from "electron"

import { getLogger } from "./logging"
import { alphaGlobalRoot } from "./alpha-installs"
import { opencodeHomeDir } from "./alpha-bridge"
import { clearByokKeys } from "./alpha-byok-keys"
import { secretEnvVars } from "./alpha-secret-files"
import { logout } from "./alpha-auth"
import * as DataClear from "./data-clear"

const fsDeps: DataClear.FsDeps = {
  exists: existsSync,
  lstat: (p) => {
    try {
      const s = lstatSync(p)
      return { isSymlink: s.isSymbolicLink(), isDir: s.isDirectory(), size: s.size }
    } catch {
      return null
    }
  },
  readdir: readdirSync,
  readlink: (p) => {
    try {
      return readlinkSync(p)
    } catch {
      return null
    }
  },
  realpath: (p) => {
    try {
      return realpathSync(p)
    } catch {
      return null
    }
  },
  remove: (p) => rmSync(p, { recursive: true, force: true }),
}

function resolveRoots(userDataPath: string): DataClear.ClearRoots {
  return {
    userData: userDataPath,
    alphaGlobal: alphaGlobalRoot(),
    opencodeHome: opencodeHomeDir(),
    engineData: DataClear.engineDataDir(process.env, homedir()),
  }
}

function logResults(level: DataClear.ClearLevel, results: DataClear.ClearResultItem[]) {
  const log = getLogger()
  for (const r of results) {
    const line = `[c16-data-clear] level=${level} item=${r.id} outcome=${r.outcome}${r.error ? ` error=${r.error}` : ""}`
    if (r.outcome === "failed") {
      log?.error(line)
      console.error(line)
    } else {
      log?.log(line)
      console.log(line)
    }
  }
}

export type DataClearAction = { clearData(): void }

export function createDataClearAction(opts: {
  userDataPath: string
  stopSidecars: () => Promise<void>
}): DataClearAction {
  const clearCredentials = async () => {
    const roots = resolveRoots(opts.userDataPath)
    const plan = DataClear.planClear(fsDeps, "credentials", roots)
    const present = plan.items.filter((i) => i.present)
    const listing = present.map((i) => `· ${i.desc}\n   ${i.path}`).join("\n")
    const { response } = await dialog.showMessageBox({
      type: "warning",
      title: "清除凭证",
      message: "将删除以下登录凭证与密钥,并退出登录。",
      detail:
        (present.length ? `${listing}\n\n` : "当前未发现凭证文件。\n\n") +
        "会话数据不受影响。连接器(MCP)已采集的密钥将一并删除,再次使用需在定制中心重新填写;" +
        "引擎凭证 auth.json 与独立安装的 opencode CLI 共享,删除后 CLI 侧也需重新登录。",
      buttons: ["清除并登出", "取消"],
      defaultId: 1,
      cancelId: 1,
    })
    if (response !== 0) return

    // 顺序有讲究:①清 BYOK(内存库+权威清 env,自带 respawn 排队)②撤密钥 env(防 respawn 的
    // syncSecretFiles 从残留 env 复活文件)③删文件 ④logout(重置态 + respawn 收尾)
    clearByokKeys()
    for (const name of secretEnvVars()) delete process.env[name]
    const results = DataClear.executeClear(fsDeps, plan, roots, { includeShared: true })
    logResults("credentials", results)
    await logout()
    const failed = results.filter((r) => r.outcome === "failed")
    await dialog.showMessageBox({
      type: failed.length ? "error" : "info",
      title: failed.length ? "清除完成(有失败项)" : "已清除凭证",
      message: failed.length
        ? `${failed.length} 项删除失败,详情见 main.log([c16-data-clear])。`
        : "凭证已删除,已退出登录。",
      buttons: ["好"],
    })
  }

  const clearAllData = async () => {
    if (!app.isPackaged) {
      await dialog.showMessageBox({
        type: "info",
        title: "仅打包版可用",
        message: "「全部数据」清除仅在打包安装版可用。",
        detail: "开发构建使用分支后缀数据库,且与本机真实安装共享 ~/.alpha —— 删错目标风险大于收益(与备份菜单同一纪律)。",
        buttons: ["好"],
      })
      return
    }
    const roots = resolveRoots(opts.userDataPath)
    const plan = DataClear.planClear(fsDeps, "data", roots)

    // B14 验收④:清除前提示先导出(备份目录本身也会被删,导出须存到外部位置)
    const backup = await dialog.showMessageBox({
      type: "warning",
      title: "建议先导出会话数据库",
      message: "全部数据(含会话数据库与其备份)将被永久删除。",
      detail: "如需保留会话,请先取消,经「数据 ▸ 导出会话数据库…」导出到下载等外部位置再回来清除。",
      buttons: ["我已导出/无需保留,继续", "取消"],
      defaultId: 1,
      cancelId: 1,
    })
    if (backup.response !== 0) return

    const sharedItems = plan.items.filter((i) => i.shared)
    const sharedBytes = sharedItems.reduce((n, i) => n + i.bytes, 0)
    const localBytes = plan.totalBytes - sharedBytes
    const confirm = await dialog.showMessageBox({
      type: "warning",
      title: "永久删除全部数据?",
      message: `将删除约 ${DataClear.formatBytes(plan.totalBytes)} 数据,应用随后退出。此操作不可撤销。`,
      detail:
        `· 应用数据(设置/日志/密钥/凭证):${DataClear.formatBytes(localBytes)}\n` +
        `· 全局安装物 ~/.alpha 及其在 ~/.opencode 的桥接链接(${plan.bridgeLinks.length} 条)\n` +
        `· 引擎数据(会话数据库/项目元数据/引擎凭证):${DataClear.formatBytes(sharedBytes)} —— 见下方勾选\n\n` +
        "不会触碰:你的项目文件、各项目内 .alpha/ 目录、~/.opencode 内你自建的内容、" +
        "~/.opencode/opencode.jsonc(如经定制中心装过连接器/插件,建议先在定制中心卸载,或事后手动清理其条目)。\n" +
        "钥匙串中的 safeStorage 密钥项由 macOS 管理,可在「钥匙串访问」搜索 alpha-code 手动删除(加密文件删除后该项已无泄密面)。",
      checkboxLabel: "同时删除引擎数据(与独立安装的 opencode CLI 共享 —— 若你单独使用 opencode,请勿勾选)",
      checkboxChecked: true,
      buttons: ["永久删除并退出", "取消"],
      defaultId: 1,
      cancelId: 1,
    })
    if (confirm.response !== 0) return

    getLogger()?.warn("[c16-data-clear] full data clear confirmed — stopping sidecars")
    await opts.stopSidecars()
    const results = DataClear.executeClear(fsDeps, plan, roots, { includeShared: confirm.checkboxChecked })
    logResults("data", results)
    const failed = results.filter((r) => r.outcome === "failed")
    if (failed.length) {
      await dialog.showMessageBox({
        type: "error",
        title: "清除完成(有失败项)",
        message: `${failed.length} 项删除失败(详情已输出到控制台),应用即将退出。`,
        buttons: ["退出"],
      })
    }
    app.exit(0)
  }

  return {
    clearData: () => {
      void (async () => {
        const { response } = await dialog.showMessageBox({
          type: "question",
          title: "清除数据",
          message: "选择清除级别",
          detail:
            "仅凭证:删除登录 token 与全部密钥并登出,会话数据保留。\n" +
            "全部数据:删除本应用产生的全部数据(为卸载做准备),应用随后退出。",
          buttons: ["仅凭证(登出并删除密钥)", "全部数据(为卸载做准备)…", "取消"],
          defaultId: 2,
          cancelId: 2,
        })
        if (response === 0) await clearCredentials()
        if (response === 1) await clearAllData()
      })().catch((error) => {
        getLogger()?.error(`[c16-data-clear] flow failed: ${error}`)
      })
    },
  }
}
