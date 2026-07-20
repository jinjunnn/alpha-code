// platform/index.ts —— ADR-026 platform seam:运行时平台差异的唯一分叉点。
//
// 纪律(ADR-026 §3):新代码不得在业务文件里散落 `process.platform` 分支,差异一律经本模块;
// 存量已守卫分支(windows.ts titlebar / apps.ts 探测 / migrate.ts 目录等)渐进收编,不强制一次性重构。
// 全部函数为纯函数(platform 可注入,默认 process.platform),electron-free,单测两平台皆可在 mac 上跑。
//
// 路径纪律(ADR-026 §2):全局状态走平台 appData；`~/Alpha` / 项目 `.alpha` 全平台同构(os.homedir()),
// 不在本模块做任何 %APPDATA% 特例 —— 这里只收敛「行为」差异,不收敛「落点」差异(落点无差异)。

import * as os from "node:os"
import * as path from "node:path"
import { POSIX_PROBE_DIRS, POSIX_PROBE_HOME_DIRS, POSIX_SQLITE } from "./darwin"
import { WIN_EDITOR_CLI, WIN_EXEC_EXTENSIONS } from "./win32"

export type ToolProbe = { cmd: string; probePath: string }

/**
 * 运行时工具探测(ext-ipc checkRuntime,MCP 安装预检):
 * - posix:`which` + PATH 补包管理器目录(GUI 启动 PATH 不全,原 mac 行为逐字保留);
 * - win32:`where` + 原样 PATH(Windows GUI 进程从 explorer 继承完整用户 PATH,分隔符 `;`)。
 */
export function toolProbe(opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string } = {}): ToolProbe {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  if (platform === "win32") return { cmd: "where", probePath: env.PATH ?? "" }
  const home = opts.home ?? os.homedir()
  return {
    cmd: "which",
    probePath: [env.PATH ?? "", ...POSIX_PROBE_DIRS, ...POSIX_PROBE_HOME_DIRS.map((d) => path.posix.join(home, d))].join(
      ":",
    ),
  }
}

/**
 * MCP 命令 head 归一(ext-config 白名单比对前置):
 * win32 用反斜杠感知的 basename 并剥 .exe/.cmd/.bat(`npx.cmd` → `npx`);posix 行为一字不变。
 */
export function commandHeadBase(head: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return path.win32.basename(head).replace(WIN_EXEC_EXTENSIONS, "")
  return path.basename(head)
}

/**
 * DB 安全带 sqlite CLI(固定绝对路径防 PATH 劫持):
 * win32 无系统自带可信固定路径(SIP 域仅 macOS)→ null = 安全带诚实不可用
 * (fail-open + loud,REQ-076 T3 拍板捆绑 sqlite3.exe 或 node 内建后补齐)。
 */
export function sqliteBinary(platform: NodeJS.Platform = process.platform): string | null {
  return platform === "win32" ? null : POSIX_SQLITE
}

/** 「在编辑器打开」display 名 → win32 CLI 名;无对应 → null(调用方回退 shell.openPath) */
export function editorCliName(appDisplayName: string): string | null {
  return WIN_EDITOR_CLI[appDisplayName] ?? null
}

/**
 * 打包态 CSP 注入资格(C24 / windows.ts):darwin(原状)+ win32(ADR-026 §5 加固面对齐)。
 * ⚠️ WSL 远端若走非回环地址会被 connect-src 回环白名单拦(真机批验证;坏则退守 darwin-only
 * 或补白名单);逃生阀 ALPHA_CSP_DISABLE=1 不变。linux 不发布,维持不注入。
 */
export function cspPlatformEligible(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" || platform === "win32"
}

/**
 * POSIX 权限位(0600/0700)是否真实生效:NTFS 上 chmod 近乎 no-op → 密钥文件 owner-only
 * 保证缺位(icacls ACL 待 REQ-076 T3 拍板)。调用方须在 win32 首次写密钥时 loud 一次,
 * 不静默装样子(C28 反 placebo)。
 */
export function posixModesEffective(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32"
}

/** electron 应用菜单的目标平台映射(menu.ts;上游 desktop-menu 的平台词汇) */
export function menuPlatform(platform: NodeJS.Platform = process.platform): "macos" | "windows" | null {
  if (platform === "darwin") return "macos"
  if (platform === "win32") return "windows"
  return null
}

/** safeStorage 密钥托管后端(用户可见文案分支用,如数据清除说明):darwin=钥匙串,win32=DPAPI */
export function safeStorageBackend(platform: NodeJS.Platform = process.platform): "keychain" | "dpapi" | "other" {
  if (platform === "darwin") return "keychain"
  if (platform === "win32") return "dpapi"
  return "other"
}
