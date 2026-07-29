// REQ-125 C4 — right-rail artifacts host, typed data container.
//
// Read-only run-artifact channels for the session's project directory: run discovery =
// runArtifacts.projectUsage (manifest truth), cards = runArtifacts.list ∘ deriveCards,
// verify-before-open = runArtifacts.verify (REQ-093 AC#4).
//
// #660 (owner-decided A1/B1/D/E): the panel additionally consumes the cloud read + single-item
// download channels — cloud.artifacts merges platform-only cards in (honest degradation when
// unreachable), cloud.downloadArtifact/cancelArtifactDownload/onArtifactProgress drive the
// proven downloadReducer, and cloud.onRunSaved (the A1 minimal push event) tells the panel a
// run has landed on disk so it can re-read the truth. Run-level management (delete/GC) stays
// deliberately absent (decision E) — no write-side IPC exists and none is opened here.
// I8: the panel is keyed on the session identity triple, so a session/workspace/server
// switch remounts it and every in-flight async result dies with the old mount. The
// timeline→artifacts linkage mount point consumes `rail.artifactTarget` (focusArtifact),
// selecting and DOM-focusing the matching card; Esc returns focus to the stored origin.
import { createEffect, createMemo, createResource, createSignal, onCleanup, Show, untrack } from "solid-js"
import type { ArtifactReadRef } from "../../../../preload/types"
import {
  deriveCards,
  downloadBusy,
  downloadReducer,
  sortRunUsages,
  type ArtifactCard,
  type DownloadEvent,
  type DownloadPhase,
} from "../../artifact-workbench/workbench-core"
import { detectOoxmlContainer, OOXML_LIMITS } from "../../artifact-workbench/renderers/ooxml"
import { routeArtifact, shouldDetectOoxml } from "../../artifact-workbench/renderers/registry"
import { presentOfficeStructure } from "../../artifact-workbench/renderers/office-structure"
import { cardPreviewable } from "../../artifact-workbench/workbench-core"
import type { PreviewContext } from "../../artifact-workbench/renderers/renderer-views"
import type { AlphaSessionLiveContext, SessionRailApi } from "../../session-workspace/session-workspace-shell"
import { artifactsIdentityKeyOf, artifactsPhaseOf, findArtifactCard, runRowModelOf } from "./artifacts-core"
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
  const retry = () => {
    // A full reload re-evaluates everything, including failed/stale verify gates.
    setVerifyGates({})
    setTick((n) => n + 1)
  }

  // Fetchers never throw (value semantics — an error becomes an honest phase, not a crash).
  const [usageRes, { refetch: refetchUsage }] = createResource(
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
  // #660 B1: genuinely chronological order (sortRunUsages sorts by manifest updatedAt).
  const sortedRuns = createMemo(() => {
    const usage = usageRes()
    return usage?.ok ? sortRunUsages(usage.usage.runs) : []
  })
  // #660: the shown run is the user's pick while it still exists; default = the latest.
  const [pickedRunId, setPickedRunId] = createSignal<string | null>(null)
  const runId = createMemo(() => {
    const runs = sortedRuns()
    const picked = pickedRunId()
    if (picked !== null && runs.some((run) => run.runId === picked)) return picked
    return runs[0]?.runId
  })
  const runRows = createMemo(() => {
    const now = new Date()
    return sortedRuns().map((usage, index) => runRowModelOf(usage, index, now))
  })
  const quota = createMemo(() => {
    const usage = usageRes()
    if (!usage?.ok) return undefined
    return { usedBytes: usage.usage.totalDiskBytes, maxBytes: usage.usage.limits.projectMaxBytes }
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
  // #660: platform-side listing for the shown run. Unreachable (offline / signed out) is an
  // honest degradation — local cards still render, plus the stock notice; never an empty lie.
  const [cloudRes] = createResource(
    () => (runId() ? { run: runId()!, tick: tick() } : null),
    async (key) => {
      try {
        const result = await window.api.cloud.artifacts(key.run)
        if (result && typeof result === "object" && !("error" in result))
          return { ok: true as const, artifacts: result.artifacts }
        return { ok: false as const }
      } catch {
        return { ok: false as const }
      }
    },
  )
  const cloudUnavailable = createMemo(() => {
    const cloud = cloudRes()
    return cloud !== undefined && !cloud.ok
  })
  const cards = createMemo<ArtifactCard[]>(() => {
    const list = listRes()
    if (!list || !list.ok) return []
    const cloud = cloudRes()
    return deriveCards({
      entries: list.entries,
      legacyFiles: list.legacyFiles,
      cloudArtifacts: cloud?.ok ? cloud.artifacts : undefined,
    })
  })

  const phase = createMemo(() =>
    artifactsPhaseOf({
      usage: usageRes(),
      runId: runId(),
      list: runId() ? listRes() : undefined,
      // Major-2: the run-level empty claim also needs the platform's answer — cloud pending
      // keeps the phase at loading, cloud failure renders "platform unavailable", never "empty".
      cloud: runId() ? cloudRes() : undefined,
      cardCount: cards().length,
    }),
  )

  // #660 A1: the "run landed" push event. Same directory only; the event carries no data —
  // the panel re-reads the truth. A foreign run shows the prompt (never steals focus, never
  // auto-switches — the current view is latched first so the refreshed sort cannot swap it);
  // the currently shown run re-reads silently (the user is already looking at it).
  const [newRunHint, setNewRunHint] = createSignal<string | null>(null)
  onCleanup(
    window.api.cloud.onRunSaved((event) => {
      if (event.directory !== identity.directory) return
      const current = untrack(runId)
      if (current === undefined) {
        // Nothing shown yet — the landed run simply becomes the panel's content.
        void refetchUsage()
        return
      }
      if (event.runId === current) {
        void refetchUsage()
        void refetchList()
        return
      }
      if (untrack(pickedRunId) === null) setPickedRunId(current)
      setNewRunHint(event.runId)
      void refetchUsage()
    }),
  )
  // The hint retires itself the moment the hinted run is the one on screen (view button,
  // run-sheet row, or a refresh that lands there — all the same fact).
  createEffect(() => {
    const hint = newRunHint()
    if (hint !== null && runId() === hint) setNewRunHint(null)
  })
  const viewNewRun = () => {
    const hint = newRunHint()
    if (hint !== null) setPickedRunId(hint)
    setNewRunHint(null)
  }

  // #660: single-item retrieval — the proven downloadReducer over the cloud download channel.
  // Keyed by the ORIGINAL artifact id (descriptor/meta id): progress frames arrive by that id,
  // and cancel must address main's in-flight ledger by it — never card.key (§② known trap:
  // legacy card keys are "legacy:<savedPath>").
  const [phases, setPhases] = createSignal<Record<string, DownloadPhase>>({})
  const phaseOf = (id: string): DownloadPhase => phases()[id] ?? { status: "idle" }
  const dispatch = (id: string, event: DownloadEvent) =>
    setPhases((prev) => ({ ...prev, [id]: downloadReducer(prev[id] ?? { status: "idle" }, event) }))
  const downloadIdOf = (card: ArtifactCard): string | undefined => {
    const payload = card.downloadPayload
    return payload && typeof payload.id === "string" ? payload.id : card.descriptor?.id
  }
  onCleanup(
    window.api.cloud.onArtifactProgress((p) => {
      dispatch(p.artifactId, { type: "progress", bytes: p.bytes, total: p.total, percent: p.percent })
    }),
  )
  const startDownload = (card: ArtifactCard) => {
    const run = runId()
    const id = downloadIdOf(card)
    // Major-3: `done` is not a re-entry point — the bytes already landed; until the manifest
    // reread replaces the card (which resets the phase below), firing again would download twice.
    if (!run || !id || !card.downloadPayload || downloadBusy(phaseOf(id)) || phaseOf(id).status === "done") return
    dispatch(id, { type: "start" })
    void window.api.cloud
      .downloadArtifact(identity.directory, run, card.downloadPayload)
      .then((result) => {
        if (result.ok) {
          dispatch(id, { type: "success" })
          // Not an optimistic update: the download wrote the manifest back; re-read it.
          void refetchList()
          void refetchUsage()
        } else if (result.error === "cancelled") {
          dispatch(id, { type: "cancelled" })
        } else {
          dispatch(id, { type: "failure", message: result.detail ? `${result.error}(${result.detail})` : result.error })
        }
      })
      .catch(() => {
        dispatch(id, { type: "failure", message: "ipc" })
      })
  }
  const cancelDownload = (card: ArtifactCard) => {
    const id = downloadIdOf(card)
    if (id) void window.api.cloud.cancelArtifactDownload(id)
  }
  // Major-3: once the reread lands the verified local card, the transient `done` phase has
  // served its purpose — clear it so the id is fresh if the artifact ever goes missing again.
  createEffect(() => {
    const list = cards()
    for (const [id, phase] of Object.entries(phases())) {
      if (phase.status !== "done") continue
      const stillDownloadable = list.some((card) => downloadIdOf(card) === id && card.downloadable)
      if (!stillDownloadable) dispatch(id, { type: "reset" })
    }
  })

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

  // Verify-before-open (REQ-093 AC#4) as a real barrier: a manifest-backed selection is
  // re-checked (full digest) BEFORE any preview/ooxml byte read may fire; the gate only
  // opens on an ok result, a failure renders honestly (no preview) and is retryable —
  // never stamped as done (integration audit Major-3).
  const [verifyGates, setVerifyGates] = createSignal<Record<string, VerifyGate>>({})
  const needsVerify = (card: ArtifactCard) =>
    card.descriptor !== undefined &&
    card.state !== "legacy" &&
    card.state !== "cloud-only" &&
    card.state !== "missing"
  const gateKey = (run: string, card: ArtifactCard) => `${run}:${card.key}`
  const gateOf = (card: ArtifactCard | null): VerifyGate | undefined => {
    const run = runId()
    if (!card || !run) return undefined
    if (!needsVerify(card)) return { status: "pass" }
    return verifyGates()[gateKey(run, card)]
  }
  const setGate = (key: string, gate: VerifyGate) => setVerifyGates((gates) => ({ ...gates, [key]: gate }))
  createEffect(() => {
    const card = selectedCard()
    const run = runId()
    if (!card || !run || !needsVerify(card)) return
    const key = gateKey(run, card)
    // checking/pass/fail all stick until an explicit retry — no re-verify loop, and a
    // failure is never silently upgraded.
    if (untrack(() => verifyGates()[key]) !== undefined) return
    setGate(key, { status: "checking" })
    window.api.runArtifacts
      .verify(identity.directory, run, card.descriptor!.id)
      .then((result) => {
        if (result && typeof result === "object" && "ok" in result && result.ok === true) {
          // ok:true only means the re-check ran and persisted. The gate opens solely on a
          // "verified" digest outcome; a real mismatch/missing/unverified result is a
          // first-class failure — same honest path as a verify exception (audit round 3).
          const state =
            "entry" in result &&
            result.entry &&
            typeof result.entry === "object" &&
            "local" in result.entry &&
            result.entry.local &&
            typeof result.entry.local === "object" &&
            "state" in result.entry.local
              ? result.entry.local.state
              : undefined
          void refetchList() // state chip reflects the persisted re-check outcome either way
          if (state === "verified") {
            setGate(key, { status: "pass" })
            return
          }
          setGate(key, { status: "fail", reason: typeof state === "string" ? state : "unverified" })
          return
        }
        const reason =
          result && typeof result === "object" && "reason" in result && typeof result.reason === "string"
            ? result.reason
            : "verify failed"
        setGate(key, { status: "fail", reason })
      })
      .catch((error) => {
        setGate(key, { status: "fail", reason: error instanceof Error ? error.message : "ipc" })
      })
  })
  const verifying = () => gateOf(selectedCard())?.status === "checking"
  const verifyFailure = () => {
    const gate = gateOf(selectedCard())
    return gate?.status === "fail" ? gate.reason : undefined
  }
  /** The open-barrier: byte reads and preview routing stay closed until the gate passes. */
  const verifyPassed = () => gateOf(selectedCard())?.status === "pass"

  // OOXML structure detection (REQ-093 #281): same bounded bytes channel as the workbench.
  // Gated behind the verify barrier — no byte leaves disk before the re-check passed.
  const ooxmlTarget = createMemo(() => {
    const card = selectedCard()
    const run = runId()
    if (!card || !run || !cardPreviewable(card) || card.state === "mismatch") return null
    if (!verifyPassed()) return null
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

  // Preview context — registry-decided routing, verbatim workbench assembly (REQ-095);
  // null until the verify barrier opened, so no renderer can read bytes early.
  const previewCtx = createMemo<PreviewContext | null>(() => {
    const card = selectedCard()
    const run = runId()
    if (!card || !run || !cardPreviewable(card)) return null
    if (!verifyPassed()) return null
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
      runs={runRows()}
      selectedRunId={runId()}
      onSelectRun={(run) => setPickedRunId(run)}
      onRefresh={retry}
      newRunHint={newRunHint() !== null}
      onViewNewRun={viewNewRun}
      quota={quota()}
      cloudUnavailable={cloudUnavailable()}
      cards={cards()}
      selectedKey={selectedKey()}
      onSelect={setSelectedKey}
      onRetry={retry}
      verifying={verifying()}
      verifyFailure={verifyFailure()}
      previewCtx={previewCtx()}
      focusSeq={focusSeq()}
      onEscape={onEscape}
      downloadPhases={phases()}
      onDownload={startDownload}
      onCancelDownload={cancelDownload}
    />
  )
}

/** REQ-093 AC#4 barrier state per `${runId}:${cardKey}`; only "pass" opens byte reads. */
type VerifyGate = { status: "checking" } | { status: "pass" } | { status: "fail"; reason: string }

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
