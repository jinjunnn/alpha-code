// Artifact Workbench 的会话级开合/选中状态 — REQ-094(#186)。
// 开合镜像 ext-hub-state.ts / automation-state.ts:模块级单例信号,不落盘(启动恒关闭)。
// 选中(run/artifact)按项目目录持久化到 localStorage(REQ-094 AC#3:重启后从 REQ-093 manifest
// 恢复同一 run/artifact —— 存的只是 id,真相仍来自 manifest,恢复时校验存在性)。
//
// REQ-126 AC3(#654):badge 通道已删除。侧栏「产物」入口与全页挂载下线后,再没有能让 badge
// 归零的入口 —— CloudRunWatcher 继续喂它就是一个永不归零的计数,故连同 toggle 一起退休。

import { createSignal } from "solid-js"

const [open, setOpen] = createSignal(false)

export function workbenchOpen(): boolean {
  return open()
}

export function setWorkbenchOpen(value: boolean): void {
  setOpen(value)
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
