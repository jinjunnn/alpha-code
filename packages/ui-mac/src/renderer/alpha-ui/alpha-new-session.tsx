// AlphaNewSession — the alpha-owned draft page ("/new-session?draftId=…" route leaf)。
// REQ-086:经 ADR-027 typed `newSession` surface 挂载;第一阶段完整保留 upstream 的
// DraftServerLayout / DirectoryDataProvider / DraftProviders 包装(server retarget 不重挂
// composer、directory retarget 精确 remount 均由 wrapper 语义保证),本组件只拥有叶 UI。
// draft 生命周期经 seam 的窄契约走:draftId + promoteDraft(不 deep import 私有 context);
// 目录以 draftId 从 upstream Tabs authority 读取;composer 与 Home/Session 同源(REQ-055)。

import { createMemo, Show, untrack } from "solid-js"
import { useSearchParams } from "@solidjs/router"
import { useTabs } from "@opencode-ai/app"
import { type AlphaProjectsApi } from "../sidebar/use-projects"
import { projectLabel } from "../sidebar/route"
import { AlphaComposer } from "./alpha-composer"
import { Banner } from "./Banner"
import "./home.css"

export function AlphaNewSession(props: {
  projects: AlphaProjectsApi
  draftId: string
  promoteDraft: (session: { directory: string; sessionId: string }) => void
}) {
  const tabs = useTabs()
  const [searchParams, setSearchParams] = useSearchParams<{ prompt?: string }>()
  const { store } = props.projects

  const directory = createMemo(() => tabs.draft(props.draftId).directory)
  const wsLabel = createMemo(() => {
    const w = directory()
    const p = store.projects.find((x) => x.worktree === w)
    return p?.name ?? (w ? projectLabel(w) : "")
  })

  // deep link `?prompt=` 只预填一次:挂载时取值即从 URL 清除,reload 不重复消费(REQ-086 AC#4)。
  const initialPrompt = untrack(() => {
    const text = searchParams.prompt
    if (text) setSearchParams({ ...searchParams, prompt: undefined }, { replace: true })
    return text
  })

  return (
    <div class="a-ui a-home a-home--page" data-alpha-new-session>
      <div class="a-home-stage">
        <div class="a-home-ghost" aria-hidden="true">
          ALPHA CODE
        </div>

        <div class="a-home-center">
          <Show when={store.error}>
            <Banner
              kind="error"
              title="项目列表加载失败"
              detail="引擎连接异常或尚未就绪"
              action={{ label: "重试", onClick: () => void props.projects.reload() }}
            />
          </Show>
          <h1 class="a-home-greet">
            新会话<span class="a-home-greet-dim">{wsLabel() ? ` — ${wsLabel()}` : ""}</span>
          </h1>

          {/* THE shared composer(与首页/会话页同一组件,REQ-055);draft 提交 = 创建会话后
              经 seam promoteDraft 晋升(tab 交换、持久草稿清理、导航均由 upstream wrapper 承担)。 */}
          <Show when={directory()} keyed fallback={<Banner kind="warning" title="草稿目录未就绪" detail="等待草稿状态加载" />}>
            {(dir) => (
              <AlphaComposer
                mode="home"
                projects={props.projects}
                directory={directory}
                initialText={initialPrompt}
                onSubmitted={(id) => props.promoteDraft({ directory: dir, sessionId: id })}
              />
            )}
          </Show>
        </div>
      </div>
    </div>
  )
}
