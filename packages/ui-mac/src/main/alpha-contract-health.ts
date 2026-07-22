import type { ContractFailure } from "@alpha-code/contracts-consumer"
import { isContractIncompatibleError } from "@alpha-code/contracts-consumer"
import { ipcMain, type BrowserWindow } from "electron"
import { getLogger } from "./logging"

let failure: ContractFailure | null = null
let getWindow: () => BrowserWindow | null = () => null

export function registerContractHealthIpcHandlers(window: () => BrowserWindow | null) {
  getWindow = window
  ipcMain.handle("alpha-contract-health", () => failure)
}

export function reportContractFailure(error: unknown): boolean {
  if (!isContractIncompatibleError(error)) return false
  failure = error.failure
  getLogger().error("alpha-contracts: incompatible platform contract", failure)
  const window = getWindow()
  if (window && !window.isDestroyed()) window.webContents.send("alpha-contract-failure", failure)
  return true
}

export function getContractFailure(): ContractFailure | null {
  return failure
}
