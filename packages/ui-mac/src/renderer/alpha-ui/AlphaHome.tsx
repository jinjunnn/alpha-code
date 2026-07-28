// AlphaHome — the alpha-owned home screen ("/" route): greeting + THE shared AlphaComposer
// (REQ-055:与会话页同一个组件、同一份 CSS —— composer 本体全部在 alpha-composer.tsx,这里只剩
// 页面骨架:问候语、错误横幅、工作区 chip)。
// REQ-085:经 ADR-027 typed `home` surface 作为正式 route 叶页面挂载 —— 不再判断 pathname、
// 不再 Portal 覆盖 upstream Home(alpha 模式下 upstream Home 叶不挂载,单一 page root);
// data + send go through the SDK (useAlphaProjects)。

import { createEffect, createMemo, createSignal, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { type AlphaProjectsApi } from "../sidebar/use-projects"
import { sessionHref } from "../sidebar/route"
import { AlphaComposer } from "./alpha-composer"
import { createDefaultWorkspaceDir } from "./default-workspace"
import { AlphaWorkspaceChip, visibleWorkspaces } from "./workspace-chip"
import { pushToast } from "./Toast"
import { Banner } from "./Banner"
import { useConfigHealth } from "./use-config-health"
import { t } from "../i18n"
import { markStartupTimeline } from "../startup-timeline"
import "./home.css"

function greeting(): string {
  const h = new Date().getHours()
  if (h < 5) return t("alpha.home.greetingLate")
  if (h < 11) return t("alpha.home.greetingMorning")
  if (h < 13) return t("alpha.home.greetingNoon")
  if (h < 18) return t("alpha.home.greetingAfternoon")
  return t("alpha.home.greetingEvening")
}

export function AlphaHome(props: { projects: AlphaProjectsApi }) {
  const navigate = useNavigate()
  const { store } = props.projects
  const configHealth = useConfigHealth()

  const visibleProjects = createMemo(() => visibleWorkspaces(store.projects))

  const [chosenWs, setChosenWs] = createSignal<string | undefined>(undefined)
  const [wsOpen, setWsOpen] = createSignal(false)

  // REQ-071/ADR-025:无项目/未选时默认落 ~/Alpha(路径查询不建目录;lazy 供给在真正开会话时
  // 由 use-projects 经 workspaceEnsureDefault 触发)。既有用户有项目照旧(仍第一个项目优先)。
  // ⚠️ ADR-025 的 2026-07-28 修订已把「新对话未显式选择 ⇒ ~/Alpha」定为规则,首页这条优先级与
  // 之同向冲突但**本次未改**(改它会连带动启动期解析时序与 provisional_to_real 探针,属
  // REQ-109/110 面)。已在该修订的「落点与残留」里登记,别当成已收口。
  const defaultWs = createDefaultWorkspaceDir()
  const activeWs = createMemo(() => chosenWs() ?? visibleProjects()[0]?.worktree ?? defaultWs())
  const activeWsSource = createMemo<"chosen" | "project" | "default" | "none">(() =>
    chosenWs() ? "chosen" : visibleProjects()[0]?.worktree ? "project" : defaultWs() ? "default" : "none",
  )
  let previousWorkspace: { value: string | undefined; source: ReturnType<typeof activeWsSource> } | undefined
  createEffect(() => {
    const current = { value: activeWs(), source: activeWsSource() }
    if (
      previousWorkspace?.source === "default" &&
      current.source === "project" &&
      previousWorkspace.value &&
      current.value &&
      previousWorkspace.value !== current.value
    )
      markStartupTimeline("renderer.home.workspace.provisional_to_real", {
        candidate: "A",
        from: previousWorkspace.value,
        to: current.value,
        trigger: "projects-ready",
      })
    previousWorkspace = current
  })

  return (
    <div class="a-ui a-home a-home--page" data-alpha-home>
      <div class="a-home-stage">
        <div class="a-home-ghost" aria-hidden="true">
          {t("alpha.brand.wordmark")}
        </div>

        <div class="a-home-center">
          <Show when={store.error}>
            <Banner
              kind="error"
              title={t("alpha.home.projectsFailed")}
              detail={t("alpha.home.engineUnavailable")}
              action={{ label: t("alpha.common.retry"), onClick: () => void props.projects.reload() }}
            />
          </Show>
          <Show when={configHealth().broken}>
            <Banner
              kind="warning"
              title={t("alpha.home.configBroken")}
              detail={configHealth().reason}
              action={{ label: t("alpha.home.openConfig"), onClick: () => void window.api.openPath(configHealth().path ?? "") }}
            />
          </Show>
          <h1 class="a-home-greet">
            {greeting()},<span class="a-home-greet-dim"> {t("alpha.home.prompt")}</span>
          </h1>

          {/* ── THE shared composer(与会话页同一组件,REQ-055)────────────── */}
          <AlphaComposer
            mode="home"
            projects={props.projects}
            directory={activeWs}
            onNeedWorkspace={() => {
              // 零工作区不留死点(REQ-054①):任何需要工作区的控件都引导到选择器
              setWsOpen(true)
              pushToast({ kind: "info", title: t("alpha.home.workspaceRequired") })
            }}
            onSubmitted={(id) => {
              const ws = activeWs()
              if (ws) navigate(sessionHref(ws, id))
            }}
          />

          {/* workspace chip —— 与新对话页同源的受控组件(REQ-126 CODE-D) */}
          <AlphaWorkspaceChip
            projects={visibleProjects()}
            defaultWorkspace={defaultWs()}
            value={activeWs()}
            open={wsOpen()}
            onOpenChange={setWsOpen}
            onSelect={setChosenWs}
          />
        </div>
      </div>
    </div>
  )
}
