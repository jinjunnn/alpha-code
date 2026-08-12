// AlphaNewSession — the alpha-owned draft page ("/new-session?draftId=…" route leaf)。
// REQ-086:经 ADR-027 typed `newSession` surface 挂载;第一阶段完整保留 upstream 的
// DraftServerLayout / DirectoryDataProvider / DraftProviders 包装(server retarget 不重挂
// composer、directory retarget 精确 remount 均由 wrapper 语义保证),本组件只拥有叶 UI。
// draft 生命周期经 seam 的窄契约走:draftId + promoteDraft(不 deep import 私有 context);
// 目录以 draftId 从 upstream Tabs authority 读取;composer 与 Home/Session 同源(REQ-055)。
//
// REQ-126 CODE-D:本页此前**只读**目录拼标题、零选择能力(基线 §1.4),现补回与首页同源的
// 工作区 chip。两处必守的事实:
// - 选中即 `tabs.updateDraft(draftId, { directory })` —— 立即对当前 draft 生效;
// - 该写入会让上游按 `server\0directory` keyed 的 draft 叶**整叶重挂**,所以 composer 的草稿
//   经 newSessionDraftStash(叶之外)往返,切目录不吞已输入内容(基线不变量 6)。

import { createMemo, createSignal, Show, untrack } from "solid-js"
import { useSearchParams } from "@solidjs/router"
import { useTabs } from "@opencode-ai/app"
import { type AlphaProjectsApi } from "../sidebar/use-projects"
import { AlphaComposer } from "./alpha-composer"
import { createDefaultWorkspaceDir } from "./default-workspace"
import { newSessionDraftStash } from "./new-session-draft-stash"
import { AlphaWorkspaceChip, visibleWorkspaces, workspaceLabel } from "./workspace-chip"
import { Banner } from "./Banner"
import { pushToast } from "./Toast"
import { t } from "../i18n"
import "./home.css"

export function AlphaNewSession(props: {
  projects: AlphaProjectsApi
  /** #891:与首页同一条线 —— 本页发第一条也走 `props.projects.startChat`,会话因此落在**那份
   *  store 连着的 server** 上,composer 拿这个 key 给新会话登记开局档位/只读档。
   *  刻意**不用** `tabs.draft(draftId).server`:登记的钥匙必须与会话页 adopt 时算出的逐字节
   *  相同,身份来源只有这一个。(#925 起 `alpha-sidebar` 的 `startDraft` 已把 draft 的 server
   *  段也钉到 projects store 的 key 上 —— 两者在生产里同值,upstream `promoteDraft` 按
   *  `draft.server` 建的 session tab 与导航因此落在真正持有会话的那台;但那是**导航**那条线的
   *  正确性,composer 的登记身份仍以本 prop 为准,不回头读 draft。) */
  serverKey: () => string | undefined
  draftId: string
  promoteDraft: (session: { directory: string; sessionId: string }) => void
}) {
  const tabs = useTabs()
  const [searchParams, setSearchParams] = useSearchParams<{ prompt?: string }>()
  const { store } = props.projects

  const projects = createMemo(() => visibleWorkspaces(store.projects))
  const directory = createMemo(() => tabs.draft(props.draftId).directory)
  // 未显式选择时落默认对话目录 `~/Alpha`(ADR-025 §3,owner 2026-07-28 改判)。这里是**呈现**
  // 口径:chip 与标题都按它显示;draft 真正带哪个目录由建 draft 的入口决定(CODE-C)。
  const defaultWs = createDefaultWorkspaceDir()
  const activeWs = createMemo(() => directory() || defaultWs())
  const wsLabel = createMemo(() => (activeWs() ? workspaceLabel(projects(), activeWs()) : ""))
  const [wsOpen, setWsOpen] = createSignal(false)
  const [attachmentReadPending, setAttachmentReadPending] = createSignal(false)

  // deep link `?prompt=` 只预填一次:挂载时取值即从 URL 清除,reload 不重复消费(REQ-086 AC#4)。
  const initialPrompt = untrack(() => {
    const text = searchParams.prompt
    if (text) setSearchParams({ ...searchParams, prompt: undefined }, { replace: true })
    return text
  })
  // 上游关闭 draft 不通知暂存(tabs.tsx 的 removeTab 只清 tabs/persisted draft,只读不改),
  // 所以每次读写都按「tabs 里还活着的 draft」剪一次 —— 关掉的 draft 不会永久占着内容。
  const liveDraftIds = () => tabs.store.flatMap((tab) => (tab.type === "draft" ? [tab.draftID] : []))

  // 切目录 = 整叶重挂,composer 的文本/mention/附件是组件本地信号 —— 取回叶外暂存(按 draftID
  // keyed,跨目录稳定;取回即消费)。首次挂载无暂存时才用 deep link 的预填。
  const stashed = untrack(() => {
    newSessionDraftStash.prune(liveDraftIds())
    return newSessionDraftStash.restore(props.draftId)
  })

  // 切目录会重挂整叶。附件还在 FileReader 里的那段窗口,内容还不在 composer 的信号里 —— 这时
  // **拦下切换并明说**,读完再放行。宁可让用户等一下,也不能让附件无声消失(基线不变量 6)。
  // (#663 起在途读盘会随暂存移交,切过去其实也能取回;这条拦截仍是 #657 的行为契约:让用户
  // 知道刚粘的东西还没就位,而不是切完盯着一个暂时空着的附件区。)
  const selectWorkspace = (dir: string) => {
    if (attachmentReadPending()) {
      pushToast({ kind: "info", title: t("alpha.newSession.attachmentReadPending") })
      return
    }
    tabs.updateDraft(props.draftId, { directory: dir })
  }

  return (
    <div class="a-ui a-home a-home--page" data-alpha-new-session>
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
          <h1 class="a-home-greet">
            {t("alpha.newSession.title")}<span class="a-home-greet-dim">{wsLabel() ? ` — ${wsLabel()}` : ""}</span>
          </h1>

          {/* THE shared composer(与首页/会话页同一组件,REQ-055);draft 提交 = 创建会话后
              经 seam promoteDraft 晋升(tab 交换、持久草稿清理、导航均由 upstream wrapper 承担)。 */}
          <Show when={directory()} keyed fallback={<Banner kind="warning" title={t("alpha.newSession.directoryPending")} detail={t("alpha.newSession.directoryLoading")} />}>
            {(dir) => (
              <AlphaComposer
                mode="home"
                projects={props.projects}
                directory={directory}
                serverKey={props.serverKey}
                initialText={stashed?.text ?? initialPrompt}
                initialMentions={stashed?.mentions}
                initialAttachments={stashed?.attachments}
                // #663:离开 draft 时还没读完的附件,其在途工单也随暂存往返 —— 新实例接手,读完
                // 并进它自己的列表。只还 attachments 就等于把「正在读的那些」留在已卸载的实例里。
                initialPendingReads={stashed?.pendingReads}
                onDraftSnapshot={(draft) => {
                  newSessionDraftStash.capture(props.draftId, draft)
                  newSessionDraftStash.prune(liveDraftIds())
                }}
                onAttachmentReadPending={setAttachmentReadPending}
                onSubmitted={(id) => {
                  // 已经发出去了,没有回访可言:晋升前清掉这条 draft 的暂存。
                  newSessionDraftStash.forget(props.draftId)
                  props.promoteDraft({ directory: dir, sessionId: id })
                }}
              />
            )}
          </Show>

          {/* workspace chip —— 与首页同源的受控组件(REQ-126 CODE-D)。选中即写 draft 目录。 */}
          <AlphaWorkspaceChip
            projects={projects()}
            defaultWorkspace={defaultWs()}
            value={activeWs()}
            open={wsOpen()}
            onOpenChange={setWsOpen}
            onSelect={selectWorkspace}
          />
        </div>
      </div>
    </div>
  )
}
