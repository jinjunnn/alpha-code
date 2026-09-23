// `#1412` —— 出网批准的**生产询问通道**:一个原生对话框,住在 main(围栏之外)。
//
// 本文件刻意只有接线,零判据:编排(合并、上限、记忆、超时、落盘)全在 electron-free 的
// network-egress-grants.ts 里,所以那些才是能被测试驱动的部分。这里只做三件事 ——
// 找一个窗口、把目的地念给用户听、把按钮翻译成一个 EgressGrantDecision。
//
// 文案纪律(docs/design/2026-09-23-model-chosen-egress-baseline.md §5.1 K1/K2/K5):
//   · 只显示**目的地**。模型产生的任何字(URL 全文、命令、它的解释)一律不进这个框 ——
//     否则提示注入就能在系统对话框里替我们写字。
//   · 说实话:批准是给**整棵引擎进程树**的,而且是一条**双向**通道,不是「只读这一个网页」。
//   · 默认按钮与取消键都是「拒绝」;什么都不做 = 不放行。

import { BrowserWindow, dialog } from "electron"
import type { EgressGrantDecision, UserEgressGrant } from "./network-egress-grants"

export async function askUserForEgressGrant(destination: UserEgressGrant): Promise<EgressGrantDecision> {
  // 没有窗口就没有人能回答。挂在这里等超时只会让每一条 CONNECT 慢 45 秒,所以立刻拒。
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  if (!parent) return "deny"
  const where = `${destination.host}:${destination.port}`
  const { response, checkboxChecked } = await dialog.showMessageBox(parent, {
    type: "question",
    title: "允许联网?",
    message: `允许这个应用连接 ${where} 吗?`,
    detail:
      "AI 引擎正要连接这个地址 —— 可能是它在读一个网页,也可能是它运行的命令要下载东西。\n\n" +
      "允许之后,引擎和它启动的所有命令都能与这个地址双向通信(包括把内容发出去),直到你收回。\n" +
      "不认识这个地址就点「拒绝」;拒绝只会让这一步失败,不影响别的功能。",
    buttons: ["拒绝", "允许"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    checkboxLabel: "以后不再询问这个地址",
    checkboxChecked: false,
  })
  if (response !== 1) return "deny"
  return checkboxChecked ? "allow-persist" : "allow-session"
}
