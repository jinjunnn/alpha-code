// AlphaWorkspaceChip — 首页与新对话页**共用**的工作区选择器(REQ-126 CODE-D / 基线 S4)。
//
// 由 AlphaHome 原地抽出:同一份 DOM、同一份 CSS(`.a-home-ws` / `.a-ws-chip` / `.a-pop*`)、
// 同一组条目语义(默认工作区常驻项 → 项目列表 → 打开项目…)。**没有新视觉**:视觉基线仍是已批
// 首页稿,这里只是把它变成两页同源的受控组件 —— 新对话页此前完全没有选择能力(基线 §1.4)。
//
// 受控:开合与选中都由宿主持有。首页需要在「零工作区时点需要目录的控件」时**程序化**弹开
// (`onNeedWorkspace`),所以 open 不能藏在组件内部。

import { For, onCleanup, Show } from "solid-js"
import { projectLabel } from "../sidebar/route"
import type { AlphaProject } from "../sidebar/use-projects"
import { pushToast } from "./Toast"
import { t } from "../i18n"

/** 数据层已剔除垃圾 worktree,这里只再挡一次 "/"(与首页此前的过滤同义)。 */
export function visibleWorkspaces(projects: readonly AlphaProject[]): AlphaProject[] {
  return projects.filter((p) => p.worktree !== "/")
}

/** chip 与新对话页标题共用的目录标签:已注册项目取项目名,未注册目录取路径末段。 */
export function workspaceLabel(projects: readonly AlphaProject[], dir: string | undefined): string {
  const project = projects.find((p) => p.worktree === dir)
  return project?.name ?? (dir ? projectLabel(dir) : t("alpha.home.chooseWorkspace"))
}

export function AlphaWorkspaceChip(props: {
  /** 已过滤的项目列表(visibleWorkspaces)。 */
  projects: readonly AlphaProject[]
  /** 默认对话目录 `~/Alpha`;未注册为项目时作为常驻首项(ADR-025)。 */
  defaultWorkspace: string | undefined
  /** 当前生效目录。 */
  value: string | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (directory: string) => void
}) {
  const onDoc = (e: MouseEvent) => {
    const target = e.target as Element | null
    if (target && target.closest(".a-pop-wrap")) return
    props.onOpenChange(false)
  }
  document.addEventListener("click", onDoc)
  onCleanup(() => document.removeEventListener("click", onDoc))
  const stop = (e: Event) => e.stopPropagation()
  const choose = (directory: string) => {
    props.onOpenChange(false)
    props.onSelect(directory)
  }

  return (
    <div class="a-home-ws">
      <div class="a-pop-wrap">
        <button
          class="a-ws-chip"
          onClick={(e) => {
            stop(e)
            props.onOpenChange(!props.open)
          }}
        >
          <FolderIcon /> {workspaceLabel(props.projects, props.value)}
          <Chevron />
        </button>
        <Show when={props.open}>
          <div class="a-pop a-pop-up" onClick={stop} style={{ "min-width": "240px" }}>
            <div class="a-pop-label">{t("alpha.home.workspace")}</div>
            {/* REQ-071:默认工作目录 ~/Alpha 常驻可选(未注册为项目时也在) */}
            <Show when={props.defaultWorkspace && !props.projects.some((p) => p.worktree === props.defaultWorkspace)}>
              <button
                class="a-pop-item"
                classList={{ "is-on": props.value === props.defaultWorkspace }}
                onClick={() => choose(props.defaultWorkspace!)}
              >
                <span class="a-pico" style={{ background: "var(--a-accent)" }}>
                  A
                </span>
                {t("alpha.brand.short")}
                <span class="a-pop-desc">{t("alpha.home.defaultWorkspace")}</span>
              </button>
            </Show>
            <For each={props.projects}>
              {(p) => (
                <button
                  class="a-pop-item"
                  classList={{ "is-on": props.value === p.worktree }}
                  onClick={() => choose(p.worktree)}
                >
                  <span class="a-pico" style={{ background: p.color || "var(--a-accent)" }}>
                    {p.name.slice(0, 1).toUpperCase()}
                  </span>
                  {p.name}
                </button>
              )}
            </For>
            <div class="a-pop-sep" />
            <button
              class="a-pop-item"
              onClick={() => {
                props.onOpenChange(false)
                // REQ-068:不再借上游 project.open —— 它只把目录加进上游 layout 的项目列表,
                // 而本工作区列表读引擎 project.list(两套不通),观感=选完没反应。改为 alpha
                // 自己选目录并**立即切换工作区**;项目在首条消息 startChat(directory) 时由
                // 引擎正式注册(chip 标签对未注册目录有 projectLabel 兜底)。取消 = 静默。
                void (async () => {
                  try {
                    const dir = await window.api.openDirectoryPicker({ title: t("alpha.home.openProject") })
                    const picked = Array.isArray(dir) ? dir[0] : dir
                    if (typeof picked === "string" && picked) props.onSelect(picked)
                  } catch {
                    pushToast({ kind: "error", title: t("alpha.home.openProjectFailed") })
                  }
                })()
              }}
            >
              <Plus /> {t("alpha.home.openProjectEllipsis")}
            </button>
          </div>
        </Show>
      </div>
    </div>
  )
}

/* ── inline icons ─────────────────────────────────────────────────────────── */
const ico = "0 0 24 24"
const Plus = () => (
  <svg class="a-ic" viewBox={ico}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)
const Chevron = () => (
  <svg class="a-ic a-chev" viewBox={ico}>
    <path d="M6 9l6 6 6-6" />
  </svg>
)
const FolderIcon = () => (
  <svg class="a-ic a-ic-sm" viewBox={ico}>
    <path d="M3 7l2-3h5l2 3h7a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z" />
  </svg>
)
