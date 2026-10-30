// REQ-126 CODE-F(#659)—— alpha 自有会话搜索,并由**壳**注册 `command.palette`。
//
// 为什么存在:侧栏「搜索」调 `command.show()` → `run("command.palette")`,而上游 `run` 是
// `optionMap.get(id)?.onSelect?.()` —— 未注册即**静默返回**。`command.palette` 全仓只在上游
// `pages/home.tsx` / `new-session.tsx` / `session.tsx` 三个叶注册,而这三个叶已被 alpha 自有
// surface 全部顶替(REQ-085/086/125),于是全应用无人注册,按钮点了什么都不发生。
//
// 上游那个面板组件复用不了:`DialogHomeCommandPaletteV2` 只在
// `packages/app/src/components/dialog-command-palette-v2.tsx` 内部导出,`@opencode-ai/app` 的
// `exports` 无该子路径、`src/index.ts` 也不导出 —— 没有合法导入路径,改上游又触 north-star。
// 所以 alpha 自建最小面板。
//
// 两条硬边界:
//  1. **注册挂在壳上**,不挂叶:本组件由 `renderer/index.tsx` 直接挂在 `AppInterface` 下,与
//     路由无关地常驻,顶替哪个叶都不会再把注册一起带走(§3 不变量 3)。
//  2. **跳转必须带结果来源的 server 身份**:用 server 限定的 canonical 路由
//     `hrefFor.session(serverKey, id)`(`/server/:serverKey/session/:id`),**不用** legacy
//     `sessionHref(dir, id)` —— 后者在无既有 tab 映射时回退到当前 active server
//     (`packages/app/src/app.tsx:800-818`),当前 server 是 WSL/remote 时会把本地 sidecar 的
//     搜索结果导向错误的服务器。
//
// 承诺面仅「按标题搜会话并跳转」:不做文件搜索、不做命令执行、不做跨服务器检索(上游三处
// palette 语义本就各不相同,alpha 不继承)。

import { createEffect, createMemo, createSignal, For, on, Show, type Accessor } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { useCommand } from "./providers"
import { Dialog } from "./Dialog"
import { Input } from "./Input"
import { t } from "../i18n"
import { hrefFor } from "../../shared/route-manifest"
import type { AlphaProject, AlphaProjectsApi, AlphaProjectsStore } from "../sidebar/use-projects"
import { sessionDisplayTitle } from "./session-title"
import { runMomentOf } from "./session-rail/artifacts/artifacts-core"
import "./session-search.css"

/** 上游命令面板的命令 id;`command.show()` 与 mod+k 都派发到它。 */
export const PALETTE_COMMAND_ID = "command.palette"

export interface SessionSearchResult {
  sessionID: string
  title: string
  project: string
  /** 最近更新时间(ms),行尾显示「今天 / 昨天 / 月日」,用来分清同名对话。 */
  updated: number
  /** server 限定的 canonical 会话路由。结果来自哪个 server,href 就钉在哪个 server 上。 */
  href: string
}

/**
 * 已加载的会话按**显示标题**过滤(与侧栏同一份规则,`New session - …` 显示并匹配为「新对话」)。
 * 数据源就是侧栏那一份 `AlphaProjectsApi.store.projects[].sessions`(同一个 store,不另起请求)。
 *
 * `serverKey` 缺席(sidecar 尚未就绪)时返回空:没有 server 身份就造不出正确的 href,宁可
 * 无结果也不给一条会导向错误服务器的链接。
 */
export function sessionSearchResults(
  projects: readonly AlphaProject[],
  query: string,
  serverKey: string | undefined,
): SessionSearchResult[] {
  const needle = query.trim().toLowerCase()
  if (!needle || !serverKey) return []
  const matched: Array<{ result: SessionSearchResult; updated: number }> = []
  for (const project of projects) {
    for (const session of project.sessions) {
      const title = sessionDisplayTitle(session.title)
      if (!title.toLowerCase().includes(needle)) continue
      matched.push({
        updated: session.updated,
        result: {
          sessionID: session.id,
          title,
          project: project.name,
          updated: session.updated,
          href: hrefFor.session(serverKey, session.id),
        },
      })
    }
  }
  // 不截断:标题匹配上的每一条已加载会话都必须能被看到、被点到 —— 截断会把用户明明搜得到的
  // 会话藏起来,那比列表长更糟。排序只是把最近用的放前面。
  return matched.sort((a, b) => b.updated - a.updated).map((entry) => entry.result)
}

/** 服务未就绪,或项目列表 / 某个项目的对话还没读到:此时「没有匹配」不是事实(#1589 AC5)。 */
export function sessionListPending(
  store: Pick<AlphaProjectsStore, "projects" | "ready">,
  serverKey: string | undefined,
): boolean {
  return !serverKey || !store.ready || store.projects.some((project) => !project.loaded)
}

/** 行尾时间:今天 HH:MM / 昨天 HH:MM / 月日(分档沿用产物面板的 `runMomentOf`)。 */
export function sessionSearchTime(updated: number, now: Date): string {
  const moment = runMomentOf(new Date(updated).toISOString(), now)!
  if (moment.kind === "today") return t("alpha.session.artifactsRunToday", { time: moment.time })
  if (moment.kind === "yesterday") return t("alpha.session.artifactsRunYesterday", { time: moment.time })
  if (moment.kind === "date") return t("alpha.search.date", { month: String(moment.month), day: String(moment.day) })
  return t("alpha.search.dateYear", { year: String(moment.year), month: String(moment.month), day: String(moment.day) })
}

export function AlphaSessionSearch(props: {
  projects: Pick<AlphaProjectsApi, "store">
  /** 搜索结果来源 server 的 canonical key(本地 sidecar)。未就绪时 undefined。 */
  serverKey: Accessor<string | undefined>
}) {
  const command = useCommand()
  const navigate = useNavigate()
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal("")

  // 壳级注册:组件随壳挂载/卸载,与路由无关。上游 `register` 用 onCleanup 摘除,所以
  // 「常驻」这件事完全由挂载位置决定 —— 见 renderer/index.tsx。
  command.register("alpha.session-search", () => [
    {
      id: PALETTE_COMMAND_ID,
      title: t("alpha.search.title"),
      // 面板自身不该出现在面板列表里。
      hidden: true,
      onSelect: () => {
        setQuery("")
        setOpen(true)
      },
    },
  ])

  const results = createMemo(() => sessionSearchResults(props.projects.store.projects, query(), props.serverKey()))
  const pending = () => sessionListPending(props.projects.store, props.serverKey())
  // 有结果时第一条默认选中;结果集一变就回到第一条(#1589 AC3)。
  const [selected, setSelected] = createSignal(0)
  createEffect(on(results, () => setSelected(0)))
  let list: HTMLUListElement | undefined

  const go = (href: string) => {
    setOpen(false)
    navigate(href)
  }

  const openResult = (event: MouseEvent, href: string) => {
    event.preventDefault()
    go(href)
  }

  // 焦点始终留在输入框:↑↓ 只移动选中,回车打开选中;无结果时回车什么都不做。
  const onKeyDown = (event: KeyboardEvent) => {
    const count = results().length
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (count === 0) return
      event.preventDefault()
      const step = event.key === "ArrowDown" ? 1 : -1
      setSelected((selected() + step + count) % count)
      list?.children[selected()]?.scrollIntoView?.({ block: "nearest" })
      return
    }
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault()
      const result = results()[selected()]
      if (result) go(result.href)
    }
  }

  return (
    <Dialog
      open={open()}
      onClose={() => setOpen(false)}
      title={t("alpha.search.title")}
      closeLabel={t("alpha.common.close")}
      besideSidebar
    >
      <div class="a-search" data-alpha-session-search>
        <Input
          block
          type="search"
          autofocus
          value={query()}
          placeholder={t("alpha.search.placeholder")}
          aria-label={t("alpha.search.placeholder")}
          data-alpha-session-search-input
          onInput={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={onKeyDown}
          icon={<Icon name="magnifying-glass" />}
        />
        <Show
          when={results().length > 0}
          fallback={
            <p class="a-search-empty" data-alpha-session-search-empty>
              {!query().trim()
                ? t("alpha.search.hint")
                : pending()
                  ? t("alpha.search.loading")
                  : t("alpha.search.empty")}
            </p>
          }
        >
          <ul class="a-search-results" role="listbox" ref={list}>
            <For each={results()}>
              {(result, index) => (
                <li role="option" aria-selected={index() === selected()}>
                  <a
                    class="a-search-result"
                    classList={{ "a-search-result--selected": index() === selected() }}
                    href={result.href}
                    data-alpha-session-search-result={result.sessionID}
                    onClick={(event) => openResult(event, result.href)}
                  >
                    <span class="a-search-result-title">{result.title}</span>
                    <span class="a-search-result-project">{result.project}</span>
                    <span class="a-search-result-time">{sessionSearchTime(result.updated, new Date())}</span>
                  </a>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <div class="a-search-keys" aria-hidden="true">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd>
            {t("alpha.search.keySelect")}
          </span>
          <span>
            <kbd>↵</kbd>
            {t("alpha.search.keyOpen")}
          </span>
          <span>
            <kbd>esc</kbd>
            {t("alpha.search.keyClose")}
          </span>
        </div>
      </div>
    </Dialog>
  )
}
