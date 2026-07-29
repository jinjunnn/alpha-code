/**
 * REQ-125 C4 — test-only harness. Feeds the real artifacts view with signal-driven props,
 * and mounts the real container inside the real shell (with a fake preload channel supplied
 * by the cases file) so the component cases exercise genuine behavior: card embedding,
 * verify-before-open, the timeline focus mount point, and identity-keyed remounts (I8).
 */

import { createSignal } from "solid-js"
import type { ArtifactCard, DownloadPhase } from "../../artifact-workbench/workbench-core"
import type { PreviewContext } from "../../artifact-workbench/renderers/renderer-views"
import {
  sameSessionIdentity,
  type AlphaSessionLiveSnapshot,
} from "../../session-workspace/session-workspace-core"
import {
  SessionWorkspaceShell,
  type AlphaSessionLiveContext,
  type SessionRailApi,
} from "../../session-workspace/session-workspace-shell"
import type { ArtifactsPhase, RunRowModel } from "./artifacts-core"
import { SessionRailArtifactsView } from "./artifacts-panel-view"
import { SessionRailArtifacts } from "./session-rail-artifacts"

export function fakeCard(input: Partial<ArtifactCard> & { key: string; name: string }): ArtifactCard {
  return { state: "verified", bytes: 1024, warnings: [], downloadable: false, ...input }
}

/** #660: run row with honest defaults; pass `moment: null` to exercise the id fallback. */
export function fakeRunRow(input: Partial<RunRowModel> & { runId: string }): RunRowModel {
  return {
    moment: { kind: "today", time: "15:02" },
    ordinal: undefined,
    artifactCount: 1,
    diskBytes: 1024,
    missingCount: 0,
    readOnly: false,
    ...input,
  }
}

export function createArtifactsViewHarness() {
  const [phase, setPhase] = createSignal<ArtifactsPhase>("cards")
  const [cards, setCards] = createSignal<readonly ArtifactCard[]>([])
  const [selectedKey, setSelectedKey] = createSignal<string | null>(null)
  const [previewCtx, setPreviewCtx] = createSignal<PreviewContext | null>(null)
  const [focusSeq, setFocusSeq] = createSignal(0)
  const [errorReason, setErrorReason] = createSignal<string | undefined>()
  const [runs, setRuns] = createSignal<readonly RunRowModel[]>([])
  const [selectedRunId, setSelectedRunId] = createSignal<string | undefined>()
  const [newRunHint, setNewRunHint] = createSignal(false)
  const [quota, setQuota] = createSignal<{ usedBytes: number; maxBytes: number } | undefined>()
  const [cloudUnavailable, setCloudUnavailable] = createSignal(false)
  const [downloadPhases, setDownloadPhases] = createSignal<Record<string, DownloadPhase>>({})
  const calls = {
    select: [] as string[],
    retry: 0,
    escape: 0,
    selectRun: [] as string[],
    refresh: 0,
    viewNewRun: 0,
    download: [] as string[],
    cancelDownload: [] as string[],
  }

  const View = () => (
    <SessionRailArtifactsView
      phase={phase()}
      errorReason={errorReason()}
      runs={runs()}
      selectedRunId={selectedRunId()}
      onSelectRun={(runId) => {
        calls.selectRun.push(runId)
        setSelectedRunId(runId)
      }}
      onRefresh={() => {
        calls.refresh += 1
      }}
      newRunHint={newRunHint()}
      onViewNewRun={() => {
        calls.viewNewRun += 1
      }}
      quota={quota()}
      cloudUnavailable={cloudUnavailable()}
      cards={cards()}
      selectedKey={selectedKey()}
      onSelect={(key) => {
        calls.select.push(key)
        setSelectedKey(key)
      }}
      onRetry={() => {
        calls.retry += 1
      }}
      verifying={false}
      previewCtx={previewCtx()}
      focusSeq={focusSeq()}
      onEscape={() => {
        calls.escape += 1
      }}
      downloadPhases={downloadPhases()}
      onDownload={(card) => {
        calls.download.push(card.key)
      }}
      onCancelDownload={(card) => {
        calls.cancelDownload.push(card.key)
      }}
    />
  )

  return {
    View,
    calls,
    setPhase,
    setCards,
    setSelectedKey,
    setPreviewCtx,
    setFocusSeq,
    setErrorReason,
    setRuns,
    setSelectedRunId,
    setNewRunHint,
    setQuota,
    setCloudUnavailable,
    setDownloadPhases,
  }
}

function snapshotFor(sessionID: string): AlphaSessionLiveSnapshot {
  return {
    identity: { serverKey: "sidecar", directory: "/tmp/workspace", sessionID },
    project: "workspace",
    title: "整理架构说明",
    activity: "idle",
  }
}

/** Real shell + real artifacts container; the cases file supplies the fake preload channel. */
export function createArtifactsShellHarness() {
  const [current, setCurrent] = createSignal<AlphaSessionLiveSnapshot | undefined>(snapshotFor("ses_a"))
  const live: AlphaSessionLiveContext = {
    current,
    accepts: (candidate) => sameSessionIdentity(candidate, current()?.identity),
  }
  let railApi: SessionRailApi | undefined
  const Shell = () => (
    <SessionWorkspaceShell
      live={live}
      panels={{
        review: (rail) => {
          railApi = rail
          return (
            <button type="button" data-fake-origin>
              origin
            </button>
          )
        },
        artifacts: (rail) => <SessionRailArtifacts live={live} rail={rail} />,
      }}
    />
  )
  return {
    Shell,
    rail: () => railApi!,
    switchSession: (sessionID: string) => setCurrent(snapshotFor(sessionID)),
  }
}
