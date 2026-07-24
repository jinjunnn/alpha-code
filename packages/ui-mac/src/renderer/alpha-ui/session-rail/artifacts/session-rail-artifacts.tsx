// REQ-125 C4 — right-rail artifacts host, typed data container.
//
// Read-only embed of the REQ-093/094 run-artifact channels for the session's project
// directory: run discovery = runArtifacts.projectUsage (manifest truth), cards =
// runArtifacts.list ∘ deriveCards, verify-before-open = runArtifacts.verify (REQ-093 AC#4).
// The rail shows the latest run — a quick look at what this session's work produced; run
// management, cloud download, and cross-run browsing stay in the artifact workbench page.
// I8: the panel is keyed on the session identity triple, so a session/workspace/server
// switch remounts it and every in-flight async result dies with the old mount. The
// timeline→artifacts linkage mount point consumes `rail.artifactTarget` (focusArtifact),
// selecting and DOM-focusing the matching card; Esc returns focus to the stored origin.
import { createEffect, createMemo, createResource, createSignal, Show } from "solid-js"
import type { ArtifactReadRef } from "../../../../preload/types"
import { deriveCards, sortRunUsages, type ArtifactCard } from "../../artifact-workbench/workbench-core"
import { detectOoxmlContainer, OOXML_LIMITS } from "../../artifact-workbench/renderers/ooxml"
import { routeArtifact, shouldDetectOoxml } from "../../artifact-workbench/renderers/registry"
import { presentOfficeStructure } from "../../artifact-workbench/renderers/office-structure"
import { cardPreviewable } from "../../artifact-workbench/workbench-core"
import type { PreviewContext } from "../../artifact-workbench/renderers/renderer-views"
import type { AlphaSessionLiveContext, SessionRailApi } from "../../session-workspace/session-workspace-shell"
import { artifactsIdentityKeyOf, artifactsPhaseOf, findArtifactCard } from "./artifacts-core"
import { SessionRailArtifactsView } from "./artifacts-panel-view"

export function SessionRailArtifacts(props: { live: AlphaSessionLiveContext; rail: SessionRailApi }) {
  // Key the whole panel on the session identity triple (I8): switching session/workspace/
  // server remounts with fresh resources, so no artifact data can leak across sessions.
  const identityKey = createMemo(() => artifactsIdentityKeyOf(props.live.current()?.identity))
  return (
    <Show when={identityKey()} keyed>
      {(_key) => <ArtifactsPanel live={props.live} rail={props.rail} />}
    </Show>
  )
}

function ArtifactsPanel(props: { live: AlphaSessionLiveContext; rail: SessionRailApi }) {
  // Under the keyed <Show> above the identity is fixed for this component's lifetime.
  const identity = props.live.current()!.identity
  const [tick, setTick] = createSignal(0)
  const retry = () => setTick((n) => n + 1)

  // Fetchers never throw (value semantics — an error becomes an honest phase, not a crash).
  const [usageRes] = createResource(
    () => tick(),
    async () => {
      try {
        const result = await window.api.runArtifacts.projectUsage(identity.directory)
        return result.ok ? { ok: true as const, usage: result.usage } : { ok: false as const, reason: result.reason }
      } catch (error) {
        return { ok: false as const, reason: error instanceof Error ? error.message : "ipc" }
      }
    },
  )
  const runId = createMemo(() => {
    const usage = usageRes()
    if (!usage?.ok) return undefined
    return sortRunUsages(usage.usage.runs)[0]?.runId
  })

  const [listRes, { refetch: refetchList }] = createResource(
    () => (runId() ? { run: runId()!, tick: tick() } : null),
    async (key) => {
      try {
        const local = await window.api.runArtifacts.list(identity.directory, key.run)
        if (!local.ok) return { ok: false as const, reason: local.reason }
        return { ok: true as const, entries: local.entries, legacyFiles: local.legacyFiles }
      } catch (error) {
        return { ok: false as const, reason: error instanceof Error ? error.message : "ipc" }
      }
    },
  )
  const cards = createMemo<ArtifactCard[]>(() => {
    const list = listRes()
    if (!list || !list.ok) return []
    // No cloud merge in the rail: local manifest truth only ("看一眼"); cloud listing,
    // download, and cross-run management stay in the workbench page.
    return deriveCards({ entries: list.entries, legacyFiles: list.legacyFiles })
  })

  const phase = createMemo(() =>
    artifactsPhaseOf({ usage: usageRes(), runId: runId(), list: runId() ? listRes() : undefined, cardCount: cards().length }),
  )

  // Selection: auto-select the first card once cards arrive; keep a user selection while
  // it still exists in the refreshed list.
  const [selectedKey, setSelectedKey] = createSignal<string | null>(null)
  createEffect(() => {
    const list = cards()
    const current = selectedKey()
    if (current !== null && list.some((card) => card.key === current)) return
    setSelectedKey(list[0]?.key ?? null)
  })
  const selectedCard = createMemo(() => cards().find((card) => card.key === selectedKey()) ?? null)

  // Timeline linkage mount point: apply a focus request as soon as its card is present.
  const [focusSeq, setFocusSeq] = createSignal(0)
  let appliedFocus: ArtifactFocusApplied | undefined
  createEffect(() => {
    const target = props.rail.artifactTarget()
    if (!target) return
    const card = findArtifactCard(cards(), target.artifactId)
    if (!card) return
    if (appliedFocus?.request === target) return
    appliedFocus = { request: target }
    setSelectedKey(card.key)
    setFocusSeq((n) => n + 1)
  })
  const onEscape = () => {
    const origin = props.rail.artifactTarget()?.origin
    if (origin?.isConnected) origin.focus()
  }

  // Verify-before-open (REQ-093 AC#4): manifest-backed selection verifies once, then the
  // list is refetched so the state chip reflects the outcome.
  const [verifying, setVerifying] = createSignal(false)
  let verifiedFor: string | null = null
  createEffect(() => {
    const card = selectedCard()
    if (!card || !card.descriptor) return
    if (card.state === "legacy" || card.state === "cloud-only" || card.state === "missing") return
    const run = runId()
    if (!run) return
    const key = `${run}:${card.key}`
    if (verifiedFor === key) return
    verifiedFor = key
    setVerifying(true)
    void window.api.runArtifacts
      .verify(identity.directory, run, card.descriptor.id)
      .then(() => refetchList())
      .catch(() => {})
      .finally(() => setVerifying(false))
  })

  // OOXML structure detection (REQ-093 #281): same bounded bytes channel as the workbench.
  const ooxmlTarget = createMemo(() => {
    const card = selectedCard()
    const run = runId()
    if (!card || !run || !cardPreviewable(card) || card.state === "mismatch") return null
    if (!shouldDetectOoxml({ name: card.savedPath!, claimedMime: card.claimedMime, detectedMime: card.detectedMime }))
      return null
    const readRef: ArtifactReadRef =
      card.descriptor && card.state !== "legacy" ? { artifactId: card.descriptor.id } : { savedPath: card.savedPath! }
    return { key: `${run}:${card.key}`, run, readRef }
  })
  const [ooxmlRes] = createResource(ooxmlTarget, async (target) => {
    const read = await window.api.runArtifacts.read(identity.directory, target.run, target.readRef, {
      mode: "bytes",
      maxBytes: OOXML_LIMITS.maxCompressedBytes,
    })
    if (!read.ok)
      return {
        key: target.key,
        detection: { status: "rejected" as const, code: "ZIP_DECOMPRESSION_FAILED" as const, reason: read.reason },
      }
    if (read.kind !== "bytes")
      return {
        key: target.key,
        detection: {
          status: "rejected" as const,
          code: "ZIP_DECOMPRESSION_FAILED" as const,
          reason: "unexpected read kind",
        },
      }
    return { key: target.key, detection: await detectOoxmlContainer(read.bytes) }
  })

  // Preview context — registry-decided routing, verbatim workbench assembly (REQ-095).
  const previewCtx = createMemo<PreviewContext | null>(() => {
    const card = selectedCard()
    const run = runId()
    if (!card || !run || !cardPreviewable(card)) return null
    const readRef: ArtifactReadRef =
      card.descriptor && card.state !== "legacy" ? { artifactId: card.descriptor.id } : { savedPath: card.savedPath! }
    const target = ooxmlTarget()
    const detected = ooxmlRes()
    const ooxml = !verifying() && target && detected?.key === target.key ? detected.detection : undefined
    const claim = {
      name: card.savedPath ?? card.name,
      claimedMime: card.claimedMime,
      detectedMime: card.detectedMime,
    }
    return {
      directory: identity.directory,
      runId: run,
      readRef,
      name: card.name,
      decision: routeArtifact({ ...claim, ooxml }),
      card,
      officeStructure: presentOfficeStructure({ ...claim, detection: ooxml }),
    }
  })

  return (
    <SessionRailArtifactsView
      phase={phase()}
      errorReason={errorReasonOf(usageRes(), listRes())}
      cards={cards()}
      selectedKey={selectedKey()}
      onSelect={setSelectedKey}
      onRetry={retry}
      verifying={verifying()}
      previewCtx={previewCtx()}
      focusSeq={focusSeq()}
      onEscape={onEscape}
    />
  )
}

interface ArtifactFocusApplied {
  request: unknown
}

function errorReasonOf(
  usage: { ok: boolean; reason?: string } | undefined,
  list: { ok: boolean; reason?: string } | undefined,
): string | undefined {
  if (usage && !usage.ok) return usage.reason
  if (list && !list.ok) return list.reason
  return undefined
}
