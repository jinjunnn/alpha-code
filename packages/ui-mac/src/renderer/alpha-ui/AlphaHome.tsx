// AlphaHome — the alpha-owned home screen ("/" route): greeting + THE shared AlphaComposer
// (REQ-055:与会话页同一个组件、同一份 CSS —— composer 本体全部在 alpha-composer.tsx,这里只剩
// 页面骨架:问候语、错误横幅、工作区 chip)。
// REQ-085:经 ADR-027 typed `home` surface 作为正式 route 叶页面挂载 —— 不再判断 pathname、
// 不再 Portal 覆盖 upstream Home(alpha 模式下 upstream Home 叶不挂载,单一 page root);
// data + send go through the SDK (useAlphaProjects)。

import { createEffect, createMemo, createSignal, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { type AlphaProjectsApi } from "../sidebar/use-projects"
import { hrefFor } from "../../shared/route-manifest"
import { AlphaComposer } from "./alpha-composer"
import { noteHomeComposerUnmountDraft } from "./home-draft-discard-notice"
import { launchDraftPending } from "./launch-draft-handoff"
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

export function AlphaHome(props: {
  projects: AlphaProjectsApi
  /** #891:`props.projects` 这份 store 连着的那个 server 的 key(`index.tsx` 的 `projectsServerKey`
   *  由 store 自己的 baseUrl 反查出来)。首页的会话是 `projects.startChat` 建的,**就落在这个
   *  server 上** —— 它是新会话 canonical 身份的第一段,composer 拿它登记开局档位/只读档。
   *  这里刻意**不读** `useServer().key`:那是「当前 active server」,WSL/remote 下与本地 sidecar
   *  不是同一个,拿它当身份就把登记写到了一把没人认领的钥匙下面(用户在首页开的只读档静默丢失)。
   *  `#894` 起**导航**消费同一个身份:提交那一刻的快照经 `onSubmitted` 交回来,直接拼
   *  `/server/:serverKey/session/:id`,不再走 legacy href 让壳事后反推。 */
  serverKey: () => string | undefined
}) {
  // #1099(REQ-109):启动窗口的第三个交接点 —— 路由树渲染到首页 surface 的这一拍。
  // 与侧栏那条同理打在组件体里(渲染期),不打在 onMount(user effect 全挤在渲染之后)。
  // `composerPending` 记的是这一拍首页有没有掏 composer:冷启动它恒为 true(#1056 的交接位
  // armed),于是「首页挂上了但输入框还没来」这件事第一次在时间线里有据可查。
  markStartupTimeline("renderer.home.surface.setup", { composerPending: launchDraftPending() })
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

          {/* ── THE shared composer(与会话页同一组件,REQ-055)──────────────
              #1056:冷启动那一拍例外 —— 侧栏的启动效应必然把路由换到 `/new-session`
              (REQ-126 §4 序 3),此刻的首页是过渡态。过去这里照挂一个 composer,于是
              一次 root.mount 下有**两个** home 模式实例:先挂的那个起一条模型链
              (auth/keyStatus/catalog + 目录就绪屏障探针 + 退避重试),再在导航那一拍被
              卸载、链被取消 —— #1053 的 13/13 样本里那条被误读成「10s 客户端超时」的
              `outcome:"error:request"` 就是它。判据是交接位而不是「路由是不是 /」:
              后者在导航发生之前恒为真,分辨不出「过渡态」与「用户自己回到首页」。 */}
          <Show when={!launchDraftPending()}>
            <AlphaComposer
              mode="home"
              projects={props.projects}
              directory={activeWs}
              serverKey={props.serverKey}
              // #927:首页 composer 的草稿是组件本地信号,没有任何暂存 —— 默认服务器身份切换
              // (keyed 重挂)会把它连树一起丢掉。owner 裁决是丢弃但先提示:卸载时把「还有没有
              // 未发送内容」交给 notice 模块,身份切换那一拍据此弹一句说明(导航等卸载不误报,
              // 判据见 home-draft-discard-notice.ts)。
              onDraftSnapshot={noteHomeComposerUnmountDraft}
              onNeedWorkspace={() => {
                // 零工作区不留死点(REQ-054①):任何需要工作区的控件都引导到选择器
                setWsOpen(true)
                pushToast({ kind: "info", title: t("alpha.home.workspaceRequired") })
              }}
              onSubmitted={(id, submitted) => {
                // #894:落点 = **提交那一刻**的 server 快照。会话是 `projects.startChat` 在那个
                // server 上建的,所以身份从来就在手上 —— 过去这里跳的是 legacy
                // `/{目录}/session/{id}`(不带 server 段),壳只能事后反推:「完成时的 active
                // server」或「同 id 的 tab」。多 server(WSL/remote)下 active 与 store 连的
                // sidecar 不是同一个 ⇒ 跳去的 server 上根本没有这个会话;那边若恰好有同 id 会话,
                // 打开并污染的是那个无关会话。
                //
                // 快照缺席 ⇒ **不跳**,不猜。走我们自己的代码到不了这个状态(`serverKey` 与
                // `startChat` 用的 client 同源于 `initializationData(sidecar)` 的那个 url:
                // client 不在时 `startChat` 返回 undefined,`onSubmitted` 根本不会被调),
                // 真到了这里也只说明身份不成立 —— 那时随便跳一个 server 就是在制造上面那个事故。
                if (!submitted.serverKey) return
                navigate(hrefFor.session(submitted.serverKey, id))
              }}
            />
          </Show>

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
