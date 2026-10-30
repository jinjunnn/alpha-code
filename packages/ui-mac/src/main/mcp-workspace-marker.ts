// REQ-134 #1011: catalog MCPs stay global while their filesystem boundary follows the active
// opencode instance. Older installs persisted the Hub-selected directory in alpha.jsonc; this boot
// reconcile restores only exact catalog command templates to the literal {workspace} marker before
// the first sidecar fork. Receipt identity plus byte-exact argv matching keeps custom MCPs and
// catalog version drift outside this migration. The four first-party Office entries are not this
// module's: since #1564 their whole command (workspace marker included) is main's template, and
// alpha-office-instance.ts migrates the older uv form.

import { readFileSync } from "node:fs"
import { isAbsolute, win32 } from "node:path"
import { applyEdits, modify, parse } from "jsonc-parser"
import type { ParseError } from "jsonc-parser"
import { WORKSPACE_MARKER } from "../shared/office-advisories"
import { alphaGlobalRoot, readLedger } from "./alpha-installs"
import { mcpPluginTargetPath, writeConfigTextAtomic } from "./ext-config"

const BUNDLED_WORKSPACE_MCPS = [
  {
    catalogId: "mcp:filesystem",
    name: "filesystem",
    command: ["npx", "-y", "@modelcontextprotocol/server-filesystem@2026.1.14", WORKSPACE_MARKER],
  },
  {
    catalogId: "mcp:git",
    name: "git",
    command: ["uvx", "mcp-server-git@2026.6.16", "--repository", WORKSPACE_MARKER],
  },
] as const

type ReconcileOptions = {
  configPath?: string
  ledgerRoot?: string
  logError?: (message: string) => void
}

export type WorkspaceMarkerReconcileOutcome = {
  migrated: string[]
  warnings: string[]
}

/** Return the marker-restored command only when catalog identity and the complete pinned template
 * match. The workspace slot must contain one concrete absolute path; embedded marker substrings are
 * deliberately not interpreted. A null result means leave the command byte-for-byte untouched. */
export function restoreWorkspaceMarker(catalogId: string, name: string, command: unknown): string[] | null {
  if (!Array.isArray(command) || !command.every((argument) => typeof argument === "string")) return null

  const bundled = BUNDLED_WORKSPACE_MCPS.find(
    (candidate) => candidate.catalogId === catalogId && candidate.name === name,
  )
  if (!bundled) return null

  const template = [...bundled.command]
  const workspaceIndex = template.indexOf(WORKSPACE_MARKER)
  if (workspaceIndex < 0 || command.length !== template.length) return null
  if (template.some((argument, index) => index !== workspaceIndex && command[index] !== argument)) return null

  const workspace = command[workspaceIndex]
  if (
    typeof workspace !== "string" ||
    workspace.includes(WORKSPACE_MARKER) ||
    (!isAbsolute(workspace) && !win32.isAbsolute(workspace))
  )
    return null
  return command.map((argument, index) => (index === workspaceIndex ? WORKSPACE_MARKER : argument))
}

/** Restore legacy install-time workspace paths in the active global alpha config. This is a
 * narrowing migration: unreadable/ambiguous state is left untouched and reported, and a second run
 * performs no write. */
export function reconcileMcpWorkspaceMarkers(options: ReconcileOptions = {}): WorkspaceMarkerReconcileOutcome {
  const warnings: string[] = []
  const logError = options.logError ?? ((message: string) => console.error(message))
  const warn = (message: string) => {
    warnings.push(message)
    logError(message)
  }
  const target = options.configPath ?? mcpPluginTargetPath()
  let text: string
  try {
    text = readFileSync(target, "utf8")
  } catch (error) {
    if (errorCode(error) !== "ENOENT")
      warn(`[req134-1011] workspace-marker reconcile skipped; config unreadable: ${target} (${errorMessage(error)})`)
    return { migrated: [], warnings }
  }

  const errors: ParseError[] = []
  const parsed: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0) {
    warn(`[req134-1011] workspace-marker reconcile skipped; config unparseable: ${target} (${errors.length} error(s))`)
    return { migrated: [], warnings }
  }
  if (!isRecord(parsed)) {
    warn(`[req134-1011] workspace-marker reconcile skipped; config root is not an object: ${target}`)
    return { migrated: [], warnings }
  }
  if (parsed.mcp === undefined) return { migrated: [], warnings }
  if (!isRecord(parsed.mcp)) {
    warn(`[req134-1011] workspace-marker reconcile skipped; config mcp key is not an object: ${target}`)
    return { migrated: [], warnings }
  }

  const ledger = readLedger(options.ledgerRoot ?? alphaGlobalRoot())
  if (ledger.warning) warn(`[req134-1011] workspace-marker ownership read warning: ${ledger.warning}`)
  const owned = new Map(
    ledger.receipts
      .filter(
        (receipt) =>
          receipt.type === "mcp" &&
          receipt.scope === "global" &&
          receipt.origin === "catalog" &&
          receipt.configKey === `mcp.${receipt.name}`,
      )
      .map((receipt) => [receipt.name, receipt.id]),
  )
  const restored = Object.entries(parsed.mcp).flatMap(([name, value]) => {
    if (!isRecord(value) || value.type !== "local") return []
    const catalogId = owned.get(name)
    if (!catalogId) return []
    const command = restoreWorkspaceMarker(catalogId, name, value.command)
    return command ? [{ name, command }] : []
  })
  if (restored.length === 0) return { migrated: [], warnings }

  const result = restored.reduce(
    (current, entry) =>
      applyEdits(
        current,
        modify(current, ["mcp", entry.name, "command"], entry.command, {
          formattingOptions: { tabSize: 2, insertSpaces: true },
        }),
      ),
    text,
  )
  const written = writeConfigTextAtomic(target, text, result)
  if (!written.ok) {
    warn(`[req134-1011] workspace-marker reconcile write failed: ${target} (${written.reason})`)
    return { migrated: [], warnings }
  }
  return { migrated: restored.map((entry) => entry.name), warnings }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined
  return typeof error.code === "string" ? error.code : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
