// REQ-160 AC2(`#1353`)—— renderer 侧发送前的那一问。
//
// **只回一个布尔值,不下放词表**。理由在 `moderation-keywords.ts` 抬头:整份表送进渲染进程
// 等于把「怎么写才能过」这个 oracle 摆在 devtools 里,而路由本身正是为了这件事才要凭据。
// 布尔值同样能被绕过(本机的东西都能),但它不额外泄露运营配置了什么。
//
// 文件只有这一点:electron 的 import 单独关在这里,让 `moderation-keywords.ts` 保持可直测。

import { ipcMain } from "electron"
import { moderationBlocks } from "./moderation-keywords"

export function registerModerationIpcHandlers(): void {
  ipcMain.handle("alpha-moderation-check", (_event, text: unknown) => {
    if (typeof text !== "string" || !text) return false
    return moderationBlocks(text)
  })
}
