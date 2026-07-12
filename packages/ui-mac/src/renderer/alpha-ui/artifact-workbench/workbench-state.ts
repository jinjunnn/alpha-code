// Artifact Workbench 的会话级开合/badge/选中状态 — REQ-094(#186)。
// 开合镜像 ext-hub-state.ts / automation-state.ts:模块级单例信号,不落盘(启动恒关闭)。
// badge:cloud run 回流落盘(CloudRunWatcher)→ +1;打开 Workbench 即清零 —— 发现不抢焦点
// (REQ-094 AC#2:用户正在看别的内容时不被强制切换,只有 badge + toast)。
// 选中(run/artifact)按项目目录持久化到 localStorage(REQ-094 AC#3:重启后从 REQ-093 manifest
// 恢复同一 run/artifact —— 存的只是 id,真相仍来自 manifest,恢复时校验存在性)。

import { createSignal } from "solid-js"

const [open, setOpen] = createSignal(false)
const [badge, setBadge] = createSignal(0)

export function workbenchOpen(): boolean {
  return open()
}

export function setWorkbenchOpen(value: boolean): void {
  if (value) setBadge(0)
  setOpen(value)
}

export function toggleWorkbench(): void {
  setWorkbenchOpen(!open())
}

export function workbenchBadge(): number {
  return badge()
}

/** CloudRunWatcher 在 run 回流落盘成功后调用:Workbench 未打开时 badge +1(打开着 = 已在看)。 */
export function notifyWorkbenchRunSaved(): void {
  if (!open()) setBadge((n) => n + 1)
}

// ---------------------------------------------------------------------------
// 选中持久化(per 项目目录;storage 可注入以便单测)
// ---------------------------------------------------------------------------

export type WorkbenchSelection = { runId: string; artifactKey: string | null }

const SELECTION_KEY = "alpha-workbench-selection-v1"

type StorageLike = Pick<Storage, "getItem" | "setItem">

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

function readMap(storage: StorageLike): Record<string, WorkbenchSelection> {
  try {
    const raw = storage.getItem(SELECTION_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const out: Record<string, WorkbenchSelection> = {}
    for (const [dir, sel] of Object.entries(parsed as Record<string, unknown>)) {
      const s = sel as { runId?: unknown; artifactKey?: unknown } | null
      if (s && typeof s === "object" && typeof s.runId === "string" && s.runId)
        out[dir] = { runId: s.runId, artifactKey: typeof s.artifactKey === "string" ? s.artifactKey : null }
    }
    return out
  } catch {
    return {}
  }
}

export function rememberSelection(dir: string, sel: WorkbenchSelection | null, storage: StorageLike | null = defaultStorage()): void {
  if (!storage || !dir) return
  try {
    const map = readMap(storage)
    if (sel) map[dir] = sel
    else delete map[dir]
    storage.setItem(SELECTION_KEY, JSON.stringify(map))
  } catch {
    /* quota/serialization —— 选中恢复是便利,不因它抛错 */
  }
}

export function recallSelection(dir: string, storage: StorageLike | null = defaultStorage()): WorkbenchSelection | null {
  if (!storage || !dir) return null
  return readMap(storage)[dir] ?? null
}
