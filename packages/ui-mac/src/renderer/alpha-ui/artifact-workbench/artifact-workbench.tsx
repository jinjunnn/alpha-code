// Artifact Workbench — REQ-094(#186)Alpha-owned 产物工作台(shell + run 发现 + 卡片 + 预览)。
// 形制镜像 automation-panel.tsx(Portal 全页覆盖、--a-* token、Esc 关闭、不落盘的开合状态)。
// 数据面:
//   · run 发现 = runArtifacts.projectUsage(遍历 `.alpha/runs/*`,REQ-093 manifest 真相)—— 不闻
//     不问引擎/时间线,重启后照常恢复(AC#3);
//   · 每 run:runArtifacts.list(manifest+reconcile+legacy 只读发现)⊗ cloud.artifacts(平台侧,
//     可离线降级)→ deriveCards(诚实状态:verified/unverified/mismatch/missing/legacy/cloud-only);
//   · 预览:选中即 verify(REQ-093 AC#4 打开前复核)→ registry 确定路由(REQ-095)→ 渲染组件,
//     单 renderer 崩溃由局部 ErrorBoundary 兜住(Preview 之外一切照常,REQ-094 AC#7);
//   · 下载:cloud.downloadArtifact + onArtifactProgress + cancel(纯 reducer 状态机,进度 aria-live)。
// 边界:零上游冻结页面 import(本目录只依赖 alpha-ui/preload/shared —— REQ-094 AC#8)。

import { createEffect, createMemo, createResource, createSignal, ErrorBoundary, For, onCleanup, Show } from "solid-js"
import { Dynamic, Portal } from "solid-js/web"
import { createStore } from "solid-js/store"
import { useLocation } from "@solidjs/router"
import { t } from "../../i18n"
import { pushToast } from "../Toast"
import { parseRoute } from "../../../shared/route-manifest"
import type { ArtifactReadRef, CloudArtifactMeta } from "../../../preload/types"
import type { AlphaProjectsApi } from "../../sidebar/use-projects"
import { projectLabel } from "../../sidebar/route"
import { rovingKey, rovingTabIndex } from "../roving-focus"
import {
  cardPreviewable,
  deriveCards,
  downloadBusy,
  downloadReducer,
  formatBytes,
  shortSha,
  sortRunUsages,
  type ArtifactCard,
  type DownloadPhase,
} from "./workbench-core"
import { recallSelection, rememberSelection, setWorkbenchOpen, workbenchOpen } from "./workbench-state"
import { detectOoxmlContainer, OOXML_LIMITS } from "./renderers/ooxml"
import { routeArtifact, shouldDetectOoxml } from "./renderers/registry"
import {
  presentOfficeStructure,
  type OfficeStructurePresentation,
} from "./renderers/office-structure"
import { RENDERER_COMPONENTS, SourceView, type PreviewContext } from "./renderers/renderer-views"
import "./artifact-workbench.css"

type PreviewMode = "preview" | "source" | "metadata"

// Exported for the REQ-125 C4 right-rail artifacts host (session-rail/artifacts), which embeds
// the approved workbench language verbatim instead of redefining it.
export const STATE_LABEL_KEYS = {
  verified: "alpha.wb.state.verified",
  unverified: "alpha.wb.state.unverified",
  mismatch: "alpha.wb.state.mismatch",
  missing: "alpha.wb.state.missing",
  legacy: "alpha.wb.state.legacy",
  "cloud-only": "alpha.wb.state.cloudOnly",
} as const

export const TAB_LABEL_KEYS = {
  preview: "alpha.wb.tab.preview",
  source: "alpha.wb.tab.source",
  metadata: "alpha.wb.tab.metadata",
} as const

function shortRunId(runId: string): string {
  return runId.length > 22 ? `${runId.slice(0, 12)}…${runId.slice(-6)}` : runId
}

export function ArtifactWorkbench(props: { projects: AlphaProjectsApi }) {
  const location = useLocation()

  const host = document.createElement("div")
  host.setAttribute("data-alpha-workbench", "")
  document.getElementById("root")?.appendChild(host)
  onCleanup(() => host.remove())

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && workbenchOpen()) setWorkbenchOpen(false)
  }
  document.addEventListener("keydown", onKey)
  onCleanup(() => document.removeEventListener("keydown", onKey))

  // ── 项目上下文:默认跟随当前路由的项目,可用顶部切换;全局 "/" 桶不参与(无 .alpha 归属) ──
  const concreteProjects = createMemo(() => props.projects.store.projects.filter((p) => p.worktree !== "/"))
  const routeDir = createMemo<string | undefined>(() => {
    const r = parseRoute(location.pathname)
    const dir = r.kind === "session" || r.kind === "directory" ? r.directory : undefined
    if (!dir || dir === "/") return undefined
    return concreteProjects().find((p) => p.directories.includes(dir))?.worktree ?? dir
  })
  const [dirOverride, setDirOverride] = createSignal<string | null>(null)
  const directory = createMemo<string | undefined>(() => dirOverride() ?? routeDir() ?? concreteProjects()[0]?.worktree)

  // ── run 发现(REQ-093 projectUsage 遍历 .alpha/runs/*)──
  const [refreshTick, setRefreshTick] = createSignal(0)
  const bump = () => setRefreshTick((n) => n + 1)
  // 面板每次打开时刷新(usage/manifest 是快照)
  let wasOpen = false
  createEffect(() => {
    const o = workbenchOpen()
    if (o && !wasOpen) bump()
    wasOpen = o
  })

  // fetcher 永不 throw(resource 抛错时任何读取都会重抛 —— 用值语义把错误收进数据形状)
  const [runsRes] = createResource(
    () => (workbenchOpen() && directory() ? { dir: directory()!, tick: refreshTick() } : null),
    async (k) => {
      try {
        const r = await window.api.runArtifacts.projectUsage(k.dir)
        return r.ok ? ({ ok: true as const, usage: r.usage }) : ({ ok: false as const, reason: r.reason })
      } catch (error) {
        return { ok: false as const, reason: error instanceof Error ? error.message : "ipc" }
      }
    },
  )
  const usage = createMemo(() => {
    const v = runsRes()
    return v && v.ok ? v.usage : undefined
  })
  const runsError = createMemo(() => {
    const v = runsRes()
    return v && !v.ok ? v.reason : null
  })
  const runs = createMemo(() => (usage() ? sortRunUsages(usage()!.runs) : []))

  // ── 选中状态(per 项目持久化;重启后经 manifest 校验恢复 —— REQ-094 AC#3)──
  const [selectedRun, setSelectedRun] = createSignal<string | null>(null)
  const [selectedKey, setSelectedKey] = createSignal<string | null>(null)
  let restoredFor: string | null = null
  createEffect(() => {
    if (!workbenchOpen()) return
    const dir = directory()
    const u = usage()
    if (!dir || !u) return
    const sorted = sortRunUsages(u.runs)
    if (restoredFor === dir) {
      if (selectedRun() && !sorted.some((r) => r.runId === selectedRun())) {
        setSelectedRun(sorted[0]?.runId ?? null)
        setSelectedKey(null)
      }
      return
    }
    restoredFor = dir
    const recalled = recallSelection(dir)
    const runId = recalled && sorted.some((r) => r.runId === recalled.runId) ? recalled.runId : (sorted[0]?.runId ?? null)
    setSelectedRun(runId)
    setSelectedKey(recalled && recalled.runId === runId ? recalled.artifactKey : null)
  })
  createEffect(() => {
    const dir = directory()
    const run = selectedRun()
    if (!dir || !run) return
    rememberSelection(dir, { runId: run, artifactKey: selectedKey() })
  })

  const pickRun = (runId: string) => {
    if (selectedRun() !== runId) {
      setSelectedRun(runId)
      setSelectedKey(null)
    }
  }

  // ── 选中 run 的产物:manifest+legacy(本地真相)⊗ 平台列表(离线降级)──
  const [listRes, { refetch: refetchList }] = createResource(
    () => (workbenchOpen() && directory() && selectedRun() ? { dir: directory()!, run: selectedRun()!, tick: refreshTick() } : null),
    async (k) => {
      let cloud: CloudArtifactMeta[] | undefined
      let cloudUnavailable = false
      try {
        const c = await window.api.cloud.artifacts(k.run)
        if (c && typeof c === "object" && !("error" in c)) cloud = c.artifacts
        else cloudUnavailable = true
      } catch {
        cloudUnavailable = true
      }
      try {
        const local = await window.api.runArtifacts.list(k.dir, k.run)
        if (!local.ok) return { ok: false as const, reason: local.reason, cloud, cloudUnavailable }
        return {
          ok: true as const,
          entries: local.entries,
          legacyFiles: local.legacyFiles,
          warnings: local.warnings,
          cloud,
          cloudUnavailable,
        }
      } catch (error) {
        return { ok: false as const, reason: error instanceof Error ? error.message : "ipc", cloud, cloudUnavailable }
      }
    },
  )
  const cards = createMemo<ArtifactCard[]>(() => {
    const l = listRes()
    if (!l || !l.ok) return []
    return deriveCards({ entries: l.entries, legacyFiles: l.legacyFiles, cloudArtifacts: l.cloud })
  })
  const selectedCard = createMemo(() => cards().find((c) => c.key === selectedKey()) ?? null)

  // ── 打开前复核(REQ-093 AC#4):manifest 卡片选中即 verify,一次 per 选中 ──
  const [verifying, setVerifying] = createSignal(false)
  let verifiedFor: string | null = null
  createEffect(() => {
    const card = selectedCard()
    const dir = directory()
    const run = selectedRun()
    if (!card || !dir || !run || !card.descriptor) return
    if (card.state === "legacy" || card.state === "cloud-only" || card.state === "missing") return
    const key = `${dir}:${run}:${card.key}`
    if (verifiedFor === key) return
    verifiedFor = key
    setVerifying(true)
    void window.api.runArtifacts
      .verify(dir, run, card.descriptor.id)
      .then(() => refetchList())
      .catch(() => {})
      .finally(() => setVerifying(false))
  })

  // ── OOXML 结构检测(REQ-093 #281):复用既有有界 bytes IPC,不新增内容/渲染通道 ──
  // resource 的值携带 source key,避免切换 artifact 时把上一件的 subtype 短暂套到下一件。
  const ooxmlTarget = createMemo(() => {
    const card = selectedCard()
    const dir = directory()
    const run = selectedRun()
    if (!card || !dir || !run || !cardPreviewable(card) || card.state === "mismatch") return null
    if (!shouldDetectOoxml({ name: card.savedPath!, claimedMime: card.claimedMime, detectedMime: card.detectedMime })) return null
    const readRef: ArtifactReadRef =
      card.descriptor && card.state !== "legacy" ? { artifactId: card.descriptor.id } : { savedPath: card.savedPath! }
    return { key: `${dir}:${run}:${card.key}`, dir, run, readRef }
  })
  const [ooxmlRes] = createResource(ooxmlTarget, async (target) => {
    const read = await window.api.runArtifacts.read(target.dir, target.run, target.readRef, {
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

  // ── 下载状态机(纯 reducer;进度事件按 artifactId 全局到达)──
  const [phases, setPhases] = createStore<Record<string, DownloadPhase>>({})
  const phaseOf = (key: string): DownloadPhase => phases[key] ?? { status: "idle" }
  const dispatch = (key: string, ev: Parameters<typeof downloadReducer>[1]) => setPhases(key, downloadReducer(phaseOf(key), ev))
  onCleanup(
    window.api.cloud.onArtifactProgress((p) => {
      dispatch(p.artifactId, { type: "progress", bytes: p.bytes, total: p.total, percent: p.percent })
    }),
  )
  const startDownload = (card: ArtifactCard) => {
    const dir = directory()
    const run = selectedRun()
    if (!dir || !run || !card.downloadPayload || downloadBusy(phaseOf(card.key))) return
    dispatch(card.key, { type: "start" })
    void window.api.cloud
      .downloadArtifact(dir, run, card.downloadPayload)
      .then((r) => {
        if (r.ok) {
          dispatch(card.key, { type: "success" })
          pushToast({ kind: "success", title: t("alpha.wb.downloadDone"), detail: card.name })
          bump() // manifest/usage 都变了
        } else if (r.error === "cancelled") {
          dispatch(card.key, { type: "cancelled" })
        } else {
          const message = r.detail ? `${r.error}(${r.detail})` : r.error
          dispatch(card.key, { type: "failure", message })
          pushToast({ kind: "error", title: t("alpha.wb.downloadFailed"), detail: message })
        }
      })
      .catch(() => {
        dispatch(card.key, { type: "failure", message: "ipc" })
        pushToast({ kind: "error", title: t("alpha.wb.downloadFailed") })
      })
  }
  const cancelDownload = (card: ArtifactCard) => {
    void window.api.cloud.cancelArtifactDownload(card.key)
  }
  // aria-live 下载进度播报(polite,不打断 —— REQ-094 AC#6)
  const liveDownloadText = createMemo(() => {
    for (const card of cards()) {
      const p = phaseOf(card.key)
      if (p.status === "downloading")
        return t("alpha.wb.downloadingLive", {
          name: card.name,
          progress: p.percent !== undefined ? `${p.percent}%` : formatBytes(p.bytes),
        })
    }
    return ""
  })

  // ── 预览上下文(registry 确定路由,REQ-095)──
  const [mode, setMode] = createSignal<PreviewMode>("preview")
  createEffect(() => {
    selectedKey()
    setMode("preview") // 换选中即回到 Preview(模式是 per-选中的呈现状态)
  })
  const previewCtx = createMemo<PreviewContext | null>(() => {
    const card = selectedCard()
    const dir = directory()
    const run = selectedRun()
    if (!card || !dir || !run || !cardPreviewable(card)) return null
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
    const decision = routeArtifact({
      ...claim,
      ooxml,
    })
    return {
      directory: dir,
      runId: run,
      readRef,
      name: card.name,
      decision,
      card,
      officeStructure: presentOfficeStructure({ ...claim, detection: ooxml }),
    }
  })

  // tablist 键盘语义(REQ-094 AC#6)—— 键位表在 roving-focus,本处只给项集合与激活方式。
  const MODES: PreviewMode[] = ["preview", "source", "metadata"]
  const onTabKey = (event: KeyboardEvent) =>
    rovingKey(event, MODES, mode(), (next) => {
      setMode(next)
      document.getElementById(`a-wb-tab-${next}`)?.focus()
    })

  const selectedRunUsage = createMemo(() => runs().find((r) => r.runId === selectedRun()) ?? null)

  const stateLabel = (card: ArtifactCard) => t(STATE_LABEL_KEYS[card.state])
  const officeStatusLabel = (status: OfficeStructurePresentation) => {
    if (status.status === "checking") return t("alpha.wb.office.status.checking")
    if (status.status === "pass") return t("alpha.wb.office.status.pass")
    return t("alpha.wb.office.status.rejected")
  }

  return (
    <Show when={workbenchOpen()}>
      <Portal mount={host}>
        <div class="a-ui alpha-wb-page" role="region" aria-label={t("alpha.wb.title")}>
          <header class="alpha-wb-head">
            <div class="alpha-wb-head-t">
              <h1>{t("alpha.wb.title")}</h1>
              <Show when={concreteProjects().length > 0}>
                <label class="alpha-wb-project">
                  <span class="alpha-wb-project-k">{t("alpha.wb.project")}</span>
                  <select
                    class="alpha-wb-select"
                    value={directory() ?? ""}
                    onChange={(e) => {
                      restoredFor = null
                      setSelectedRun(null)
                      setSelectedKey(null)
                      setDirOverride(e.currentTarget.value)
                    }}
                  >
                    <For each={concreteProjects()}>
                      {(p) => <option value={p.worktree}>{projectLabel(p.worktree)}</option>}
                    </For>
                  </select>
                </label>
              </Show>
            </div>
            <button class="alpha-wb-close" aria-label={t("alpha.ext.close")} onClick={() => setWorkbenchOpen(false)}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
              </svg>
            </button>
          </header>

          <div class="alpha-wb-live" aria-live="polite">{liveDownloadText()}</div>

          <Show
            when={directory()}
            fallback={<div class="alpha-wb-empty"><b>{t("alpha.wb.noProject")}</b></div>}
          >
            <div class="alpha-wb-body">
              {/* ── 左栏:run 列表 ── */}
              <nav class="alpha-wb-runs" aria-label={t("alpha.wb.runs")}>
                <div class="alpha-wb-col-title">{t("alpha.wb.runs")}</div>
                <Show when={!runsError()} fallback={
                  <div class="alpha-wb-empty">
                    <p>{t("alpha.wb.runsFailed")}:{runsError()}</p>
                    <button type="button" class="a-wb-btn" onClick={bump}>{t("alpha.wb.retry")}</button>
                  </div>
                }>
                  <Show when={usage()} fallback={<div class="alpha-wb-empty">{t("alpha.wb.loading")}</div>}>
                    <Show when={runs().length > 0} fallback={<div class="alpha-wb-empty">{t("alpha.wb.noRuns")}</div>}>
                      <ul class="alpha-wb-runlist" role="list">
                        <For each={runs()}>
                          {(run) => (
                            <li>
                              <button
                                type="button"
                                class="alpha-wb-runrow"
                                data-active={selectedRun() === run.runId ? "" : undefined}
                                onClick={() => pickRun(run.runId)}
                              >
                                <span class="alpha-wb-runid" title={run.runId}>{shortRunId(run.runId)}</span>
                                <span class="alpha-wb-runmeta">
                                  {t("alpha.wb.runMeta", { count: run.artifactCount, bytes: formatBytes(run.diskBytes) })}
                                  <Show when={run.missingCount > 0}>
                                    <span class="a-wb-chip" data-kind="warn">{t("alpha.wb.runMissing", { count: run.missingCount })}</span>
                                  </Show>
                                  <Show when={run.readOnly}>
                                    <span class="a-wb-chip" data-kind="warn">{t("alpha.wb.runReadOnly")}</span>
                                  </Show>
                                </span>
                              </button>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </Show>
                </Show>
                {/* 用量(REQ-093 §5 基线数字,诚实供数) */}
                <Show when={usage()}>
                  <div class="alpha-wb-usage">
                    <div class="alpha-wb-col-title">{t("alpha.wb.usage")}</div>
                    <div class="alpha-wb-usage-row">
                      {t("alpha.wb.usageProject", {
                        bytes: formatBytes(usage()!.totalDiskBytes),
                        limit: formatBytes(usage()!.limits.projectMaxBytes),
                      })}
                    </div>
                    <Show when={selectedRunUsage()}>
                      <div class="alpha-wb-usage-row">
                        {t("alpha.wb.usageRun", {
                          bytes: formatBytes(selectedRunUsage()!.diskBytes),
                          limit: formatBytes(usage()!.limits.runMaxBytes),
                        })}
                      </div>
                    </Show>
                  </div>
                </Show>
              </nav>

              {/* ── 中栏:artifact 卡片 ── */}
              <section class="alpha-wb-cards" aria-label={t("alpha.wb.artifacts")}>
                <div class="alpha-wb-col-title">{t("alpha.wb.artifacts")}</div>
                <Show when={selectedRun()} fallback={<div class="alpha-wb-empty">{t("alpha.wb.noRuns")}</div>}>
                  <Show when={listRes()} fallback={<div class="alpha-wb-empty">{t("alpha.wb.loading")}</div>}>
                    {(l) => (
                      <>
                        <Show when={!l().ok}>
                          <div class="a-wb-notice" data-kind="error">
                            {t("alpha.wb.listFailed")}:{(l() as { reason?: string }).reason}
                          </div>
                        </Show>
                        <Show when={l().cloudUnavailable}>
                          <div class="a-wb-notice">{t("alpha.wb.cloudListFailed")}</div>
                        </Show>
                        <Show when={l().ok && (l() as { warnings: string[] }).warnings.length > 0}>
                          <For each={(l() as { warnings: string[] }).warnings}>
                            {(w) => <div class="a-wb-notice" data-kind="warn">{w}</div>}
                          </For>
                        </Show>
                        <Show when={cards().length > 0} fallback={<Show when={l().ok}><div class="alpha-wb-empty">{t("alpha.wb.noArtifacts")}</div></Show>}>
                          <ul class="alpha-wb-cardlist" role="list">
                            <For each={cards()}>
                              {(card) => {
                                const phase = () => phaseOf(card.key)
                                return (
                                  <li
                                    class="alpha-wb-card"
                                    data-active={selectedKey() === card.key ? "" : undefined}
                                    data-state={card.state}
                                  >
                                    <button type="button" class="alpha-wb-card-main" onClick={() => setSelectedKey(card.key)}>
                                      <span class="alpha-wb-card-name" title={card.name}>{card.name}</span>
                                      <span class="alpha-wb-card-meta">
                                        <span class="a-wb-chip" data-state={card.state}>{stateLabel(card)}</span>
                                        <Show when={selectedKey() === card.key && previewCtx()?.officeStructure}>
                                          {(status) => (
                                            <span
                                              class="a-wb-chip"
                                              data-kind={
                                                status().status === "pass"
                                                  ? "success"
                                                  : status().status === "rejected"
                                                    ? "error"
                                                    : undefined
                                              }
                                            >
                                              <Show when={status().status === "checking"}>
                                                <span class="a-wb-spinner" aria-hidden="true" />
                                              </Show>
                                              {officeStatusLabel(status())}
                                            </span>
                                          )}
                                        </Show>
                                        <span class="alpha-wb-card-size">{formatBytes(card.bytes)}</span>
                                        <Show when={card.warnings.length > 0}>
                                          <span class="a-wb-chip" data-kind="warn" title={card.warnings.join("\n")}>
                                            {t("alpha.wb.warnings")} {card.warnings.length}
                                          </span>
                                        </Show>
                                      </span>
                                    </button>
                                    <Show when={card.downloadable}>
                                      <span class="alpha-wb-card-actions">
                                        <Show
                                          when={downloadBusy(phase())}
                                          fallback={
                                            <button type="button" class="a-wb-btn" data-variant="primary" onClick={() => startDownload(card)}>
                                              {phase().status === "error" ? t("alpha.wb.retry") : t("alpha.wb.download")}
                                            </button>
                                          }
                                        >
                                          <span class="alpha-wb-progress">
                                            {(() => {
                                              const p = phase()
                                              return p.status === "downloading"
                                                ? p.percent !== undefined
                                                  ? `${p.percent}%`
                                                  : formatBytes(p.bytes)
                                                : t("alpha.wb.downloading")
                                            })()}
                                          </span>
                                          <button type="button" class="a-wb-btn" onClick={() => cancelDownload(card)}>
                                            {t("alpha.wb.cancel")}
                                          </button>
                                        </Show>
                                      </span>
                                    </Show>
                                    <Show when={phase().status === "error"}>
                                      <span class="a-wb-chip" data-kind="error" title={(phase() as { message?: string }).message}>
                                        {t("alpha.wb.downloadFailed")}
                                      </span>
                                    </Show>
                                  </li>
                                )
                              }}
                            </For>
                          </ul>
                        </Show>
                      </>
                    )}
                  </Show>
                </Show>
              </section>

              {/* ── 右栏:预览(Preview/Source/Metadata 三模式)── */}
              <section class="alpha-wb-preview" aria-label={t("alpha.wb.tab.preview")}>
                <Show
                  when={selectedCard()}
                  fallback={<div class="alpha-wb-empty">{t("alpha.wb.selectArtifact")}</div>}
                >
                  {(card) => (
                    <>
                      <div class="alpha-wb-preview-head">
                        <div role="tablist" aria-label={t("alpha.wb.title")} class="alpha-wb-tabs" onKeyDown={onTabKey}>
                          <For each={MODES}>
                            {(m) => (
                              <button
                                type="button"
                                role="tab"
                                id={`a-wb-tab-${m}`}
                                aria-selected={mode() === m}
                                aria-controls="a-wb-panel"
                                tabIndex={rovingTabIndex(mode() === m)}
                                data-on={mode() === m ? "" : undefined}
                                onClick={() => setMode(m)}
                              >
                                {t(TAB_LABEL_KEYS[m])}
                              </button>
                            )}
                          </For>
                        </div>
                        <Show when={verifying()}>
                          <span class="a-wb-chip">{t("alpha.wb.verifying")}</span>
                        </Show>
                        <Show when={previewCtx() && !previewCtx()!.officeStructure}>
                          <span class="a-wb-chip" title={previewCtx()!.decision.reason}>
                            {previewCtx()!.decision.rendererId}
                          </span>
                        </Show>
                        <Show when={previewCtx()?.officeStructure}>
                          {(status) => (
                            <span
                              class="a-wb-chip"
                              data-kind={
                                status().status === "pass"
                                  ? "success"
                                  : status().status === "rejected"
                                    ? "error"
                                    : undefined
                              }
                            >
                              <Show when={status().status === "checking"}>
                                <span class="a-wb-spinner" aria-hidden="true" />
                              </Show>
                              {officeStatusLabel(status())}
                            </span>
                          )}
                        </Show>
                      </div>
                      <Show when={!previewCtx()?.officeStructure && previewCtx()?.decision.warnings.length}>
                        <For each={previewCtx()!.decision.warnings}>
                          {(w) => <div class="a-wb-notice" data-kind="warn">{w}</div>}
                        </For>
                      </Show>
                      <Show when={card().state === "mismatch"}>
                        <div class="a-wb-notice" data-kind="error">{t("alpha.wb.mismatchBanner")}</div>
                      </Show>
                      <div id="a-wb-panel" role="tabpanel" aria-labelledby={`a-wb-tab-${mode()}`} class="alpha-wb-panel">
                        <Show
                          when={previewCtx()}
                          fallback={
                            <div class="alpha-wb-empty">
                              <p>{card().state === "cloud-only" ? t("alpha.wb.notDownloaded") : t("alpha.wb.fileMissing")}</p>
                              <Show when={card().downloadable && !downloadBusy(phaseOf(card().key))}>
                                <button type="button" class="a-wb-btn" data-variant="primary" onClick={() => startDownload(card())}>
                                  {t("alpha.wb.download")}
                                </button>
                              </Show>
                            </div>
                          }
                        >
                          {(ctx) => (
                            <Show when={mode() === "metadata"} fallback={
                              /* 单 renderer 崩溃只影响本面板(REQ-094 AC#7);Source 模式共用有界读取 */
                              <ErrorBoundary
                                fallback={(err, reset) => (
                                  <div class="a-wb-notice" data-kind="error" role="alert">
                                    {t("alpha.wb.previewCrashed")}:{String((err as Error)?.message ?? err)}
                                    <button type="button" class="a-wb-btn" onClick={reset}>{t("alpha.wb.retry")}</button>
                                  </div>
                                )}
                              >
                                <Show when={mode() === "preview"} fallback={<SourceView ctx={ctx()} />}>
                                  <Dynamic component={RENDERER_COMPONENTS[ctx().decision.rendererId]} ctx={ctx()} />
                                </Show>
                              </ErrorBoundary>
                            }>
                              <MetadataView ctx={ctx()} />
                            </Show>
                          )}
                        </Show>
                      </div>
                    </>
                  )}
                </Show>
              </section>
            </div>
          </Show>
        </div>
      </Portal>
    </Show>
  )
}

/** Metadata 模式:descriptor 事实 + 本地状态 + 路由决策(选中 renderer 与原因,REQ-095 AC#1)。 */
export function MetadataView(props: { ctx: PreviewContext }) {
  const d = () => props.ctx.card.descriptor
  const rows = createMemo<Array<[string, string]>>(() => {
    const out: Array<[string, string]> = [
      [t("alpha.wb.factName"), props.ctx.name],
      [t("alpha.wb.factSize"), formatBytes(props.ctx.card.bytes)],
      [t("alpha.wb.factState"), props.ctx.card.state],
      [t("alpha.wb.decision"), `${props.ctx.decision.rendererId} — ${props.ctx.decision.reason}`],
      ["MIME", `claimed ${props.ctx.card.claimedMime ?? "—"} / detected ${props.ctx.card.detectedMime ?? "—"}`],
      ["external open", props.ctx.decision.externalOpen],
    ]
    if (props.ctx.decision.ooxmlSubtype)
      out.push(["OOXML", `${props.ctx.decision.ooxmlSubtype} / ${props.ctx.decision.effectiveMime}`])
    const desc = d()
    if (desc) {
      out.push(
        ["id", desc.id],
        ["sha256", shortSha(desc.sha256)],
        [t("alpha.wb.factTrust"), `${desc.trust} · ${desc.role}`],
        ["provenance", `${desc.provenance.producer} · ${desc.provenance.jobId}${desc.provenance.kind ? ` · ${desc.provenance.kind}` : ""}`],
        ["verification", desc.verification.status],
      )
    }
    if (props.ctx.card.savedPath) out.push([t("alpha.wb.factPath"), props.ctx.card.savedPath])
    return out
  })
  return (
    <div class="alpha-wb-meta">
      <For each={rows()}>
        {([k, v]) => (
          <div class="a-wb-fact">
            <span class="a-wb-fact-k">{k}</span>
            <span class="a-wb-fact-v" title={v}>{v}</span>
          </div>
        )}
      </For>
      <Show when={props.ctx.card.warnings.length > 0}>
        <div class="alpha-wb-meta-warnings">
          <div class="a-wb-fact-k">{t("alpha.wb.warnings")}</div>
          <For each={props.ctx.card.warnings}>{(w) => <div class="a-wb-notice" data-kind="warn">{w}</div>}</For>
        </div>
      </Show>
    </div>
  )
}
