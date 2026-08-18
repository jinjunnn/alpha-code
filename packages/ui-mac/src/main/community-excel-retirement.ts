// REQ-135 #1012: retire the legacy community Excel MCP before the first sidecar fork.
// The first-party Hub connector is `mcp:alpha-excel`; `excel-mcp-server` is removed, not renamed.

import { alphaGlobalRoot } from "./alpha-installs"
import { tryAcquireBundleLock } from "./ext-bundle-lock"
import { removeMcpLeafCopiesUnlocked } from "./ext-config"
import { retireCommunityExcelRecordV2 } from "./ext-receipt-v2"
import { probeTransactionJournals } from "./ext-transaction"

const COMMUNITY_EXCEL_NAME = "excel-mcp-server"

export type CommunityExcelRetirementResult =
  | { ok: true; configRemoved: boolean; receiptRemoved: boolean }
  | { ok: false; reason: string }

/** Wait for startup transaction recovery, then hold the global extension lock and recheck that no
 * non-terminal journal remains before changing config or ledger state. */
export async function retireCommunityExcelAfterRecovery(
  recoveryReady: Promise<void>,
): Promise<CommunityExcelRetirementResult> {
  try {
    await recoveryReady
  } catch (error) {
    return {
      ok: false,
      reason: `extension transaction recovery failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const root = alphaGlobalRoot()
  const acquired = tryAcquireBundleLock(root, { txId: "req135-community-excel-retirement" })
  if (!acquired.ok)
    return { ok: false, reason: `extension transaction lock unavailable: ${acquired.reason}` }
  try {
    const journals = probeTransactionJournals(root)
    if (journals.unreadableDir)
      return { ok: false, reason: "extension transaction journal directory is unreadable" }
    const pending = journals.entries.find((journal) => !journal.terminal)
    if (pending)
      return {
        ok: false,
        reason: `non-terminal extension transaction remains after recovery (${pending.txId}:${pending.state})`,
      }
    return retireCommunityExcelInHeldLock()
  } finally {
    acquired.lock.release()
  }
}

/**
 * Remove the exact community Excel config leaf from the live engine target and every retained
 * legacy copy the engine still merges, then its global receipt. Config goes first so a failed
 * ledger write can never leave a live-but-unreceipted connector. Missing files/leaves are
 * successful no-ops and are never created by this teardown.
 */
function retireCommunityExcelInHeldLock(): CommunityExcelRetirementResult {
  const config = removeCommunityExcelConfig()
  if (!config.ok) return config

  const receipt = retireCommunityExcelRecordV2(alphaGlobalRoot())
  if (!receipt.ok) return { ok: false, reason: `global receipt teardown failed: ${receipt.reason}` }

  return { ok: true, configRemoved: config.removed, receiptRemoved: receipt.removed }
}

function removeCommunityExcelConfig():
  | { ok: true; removed: boolean }
  | { ok: false; reason: string } {
  return removeMcpLeafCopiesUnlocked(COMMUNITY_EXCEL_NAME)
}
