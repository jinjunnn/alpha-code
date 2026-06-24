// alpha account IPC (main process). Mirrors ext-ipc.ts: thin handlers reading the account summary /
// transactions from the in-region account-server using the main-held JWT (alpha-account.ts). The
// renderer receives only the resolved data, never the token.

import { ipcMain, type IpcMainInvokeEvent } from "electron"
import { fetchAccountSummary, fetchTransactions } from "./alpha-account"

export function registerAccountIpcHandlers() {
  ipcMain.handle("account-summary", () => fetchAccountSummary())
  ipcMain.handle("account-transactions", (_event: IpcMainInvokeEvent, limit?: number) => fetchTransactions(limit))
}
