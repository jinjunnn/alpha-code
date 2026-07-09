// platform/win32.ts —— Windows 侧平台常量(ADR-026 / REQ-076 T2)。

/**
 * 「在编辑器打开」display 名(ipc.ts ALLOWED_OPEN_APPS 的键)→ Windows CLI 名。
 * CLI 名经 apps.resolveAppPath(`where` + .cmd→.exe 解析)落成真实 .exe 后 execFile,
 * 不走 shell(拒注入面)。无 Windows 对应物(TextEdit/Xcode/Finder)→ 缺项,调用方回退
 * shell.openPath(系统默认程序,诚实降级)。
 */
export const WIN_EDITOR_CLI: Record<string, string> = {
  "Visual Studio Code": "code",
  Cursor: "cursor",
  Zed: "zed",
  "Sublime Text": "subl",
  "IntelliJ IDEA": "idea",
  WebStorm: "webstorm",
  PyCharm: "pycharm",
}

/** win32 命令 head 的可剥可执行后缀(白名单比对前归一:npx.cmd → npx) */
export const WIN_EXEC_EXTENSIONS = /\.(exe|cmd|bat)$/i
