// ac#1187:账户浮层要显示当前版本号,而 renderer 拿不到 app.getVersion()。勘破过的两条既有
// 通道都不带版本:REQ-098 的 alpha-environment 快照(shape 被测试钉死,不动)、alpha-endpoints
// (只有 URL)。所以加这条最小只读 IPC。唯一真源仍是 packages/ui-mac/package.json 的 version
// (app.getVersion() 读它)—— 这里不落任何版本字面量,handler 在**每次调用时**读 app,
// 让 wiring 测试能用「换掉 getVersion 的返回值 ⇒ IPC 返回跟着变」钉住取值来源。
import { app, ipcMain } from "electron"

export function registerAppVersionIpcHandler() {
  ipcMain.handle("app-version", () => app.getVersion())
}
