// REQ-131 / #1130 —— Settings「工具」节的 IPC 面(main 侧)。
// 与 settings-ipc.ts 同一形态:renderer 只拿闭集结果码(shared/tool-policy-wire.ts),引擎地址与
// Basic 凭据留在 main。输入形状不在这里二次校验 —— 记录 / selector 由引擎按 wire schema 拒(400 ⇒
// invalid-record),那是同一份判据;main 只挡「没有 directory」这一条,因为没有实例就没有分区。
import { ipcMain } from "electron"
import type { ToolPolicyRecord, ToolPolicySelector } from "../shared/tool-policy-wire"
import { createToolPolicyClient, type ToolPolicyServerInfo } from "./tool-policy-client"

export function registerToolPolicyIpcHandlers(deps: { awaitServer: () => Promise<ToolPolicyServerInfo> }) {
  const client = createToolPolicyClient(deps)
  ipcMain.handle("tool-policy-inventory", (_event, input: { directory: string }) => client.inventory(input))
  ipcMain.handle("tool-policy-set-record", (_event, input: { directory: string; record: ToolPolicyRecord }) =>
    client.setRecord(input),
  )
  ipcMain.handle(
    "tool-policy-remove-record",
    (_event, input: { directory: string; selector: ToolPolicySelector }) => client.removeRecord(input),
  )
  ipcMain.handle("tool-policy-reset", (_event, input: { directory: string }) => client.reset(input))
}
