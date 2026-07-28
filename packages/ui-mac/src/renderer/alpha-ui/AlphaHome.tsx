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

  // REQ-071/ADR-025(2026-07-28 修订):未显式选择 ⇒ **默认对话目录 `~/Alpha` 权威**。原先是
  // 「第一个项目优先、默认目录兜底」,即新对话的落点由一个用户从未选过的历史值决定 —— owner
  // 拍板推翻,首页与新对话页同一口径(路径查询不建目录;lazy 供给在真正开会话时由 use-projects
  // 经 workspaceEnsureDefault 触发)。要别的目录就在 chip 里显式选。
  const defaultWs = createDefaultWorkspaceDir()
  // 默认目录**还在解析**时一个工作区都不给:此刻拿第一个项目顶上去,用户在默认目录返回之前
  // 回车就把会话真开在了他没选过的项目里(AC5 的实测破绽)。给 undefined ⇒ composer 走既有
  // 「需要工作区」路径(拦下 + 弹选择器 + 提示),不新增加载态设计。
  const activeWs = createMemo(() =>
    chosenWs() ?? (defaultWs.loading ? undefined : (defaultWs() ?? visibleProjects()[0]?.worktree)),
  )
  const activeWsSource = createMemo<"chosen" | "project" | "default" | "none">(() =>
    chosenWs()
      ? "chosen"
      : defaultWs.loading
        ? "none"
        : defaultWs()
          ? "default"
          : visibleProjects()[0]?.worktree
            ? "project"
            : "none",
  )
  // REQ-109/110 启动探针:首页先显示一个临时工作区、随后换成真正的那个 —— 这段可感知跳变仍然
  // 存在,只是方向随上面的改判翻了个个儿(过去是 default→project,现在是 project→default,取决
  // 于项目列表与默认目录哪个先到)。所以探针**保留但改成方向无关**:任何「已解析出的工作区又
  // 换了身份」都记一次,并把 from/to 的来源一并带上,让分析侧自己分辨是哪一种。
  // (钉死旧方向 = 留一个永不触发的死探针,那正是本 REQ 在清的「说谎的拓扑」。)
  let previousWorkspace: { value: string | undefined; source: ReturnType<typeof activeWsSource> } | undefined
  createEffect(() => {
    const current = { value: activeWs(), source: activeWsSource() }
    if (
      previousWorkspace &&
      previousWorkspace.source !== "chosen" &&
      current.source !== "chosen" &&
      previousWorkspace.value &&
      current.value &&
      previousWorkspace.value !== current.value
    )
      markStartupTimeline("renderer.home.workspace.provisional_to_real", {
        // 语义已变:旧口径的 candidate A = `default → 真实项目`(见 REQ-109 T1 证据文档),
        // 改判后是任意方向。换掉标识,免得按候选聚合的既有口径把两种方向混成一桶。
        candidate: "A-any-direction",
        from: previousWorkspace.value,
        to: current.value,
        fromSource: previousWorkspace.source,
        toSource: current.source,
        trigger: "workspace-resolved",
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
