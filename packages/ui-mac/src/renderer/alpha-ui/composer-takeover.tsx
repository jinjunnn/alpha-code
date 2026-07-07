// ComposerTakeover — REQ-055:会话页用 AlphaComposer 顶替上游 prompt-input。
//
// 机制(零改上游,ADR-005/016):
// - body 打 [data-alpha-composer-takeover] → alpha-composer.css 把上游 session composer 隐藏
//   (display:none;保留在 DOM,其内部状态/命令注册不受影响);
// - 在上游 composer 的父容器里放一个 host <div>,Portal AlphaComposer 进去(占据同一布局位);
// - MutationObserver 跟随上游重挂(切会话/新会话),与旧 composer-inject 同款、已验证的模式;
// - 上下文用量 ring:收养上游活的 progress-circle 按钮进 alpha 工具条的 [data-alpha-usage-host]
//   (纯只读复用,v2 换 SSE 自建 —— 见 requirements/REQ-055 非目标)。
//
// 路由解析:/:b64dir/session/:id(与 sidebar/route.sessionHref 对偶)。

import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { useLocation } from "@solidjs/router"
import { base64UrlDecode } from "../sidebar/route"
import type { AlphaProjectsApi } from "../sidebar/use-projects"
import { AlphaComposer } from "./alpha-composer"

const COMPOSER_SEL = "[data-component=session-composer]"

function parseSessionRoute(pathname: string): { directory: string; sessionID: string } | null {
  const m = pathname.match(/^\/([^/]+)\/session\/([^/]+)/)
  if (!m) return null
  try {
    return { directory: base64UrlDecode(m[1]), sessionID: m[2] }
  } catch {
    return null
  }
}

export function ComposerTakeover(props: { projects: AlphaProjectsApi }) {
  const loc = useLocation()
  const route = createMemo(() => parseSessionRoute(loc.pathname))
  const [host, setHost] = createSignal<HTMLElement | null>(null)

  const ensureHost = (composer: HTMLElement): HTMLElement => {
    let h = composer.parentElement!.querySelector<HTMLElement>("[data-alpha-composer-host]")
    if (!h) {
      h = document.createElement("div")
      h.setAttribute("data-alpha-composer-host", "")
      composer.parentElement!.insertBefore(h, composer)
    }
    return h
  }

  const sync = () => {
    if (!route()) {
      document.body.removeAttribute("data-alpha-composer-takeover")
      if (host()) setHost(null)
      return
    }
    document.body.setAttribute("data-alpha-composer-takeover", "")
    // 只认当前可见会话的 composer(keep-alive 的隐藏 timeline 也各有一个)
    const composers = [...document.querySelectorAll<HTMLElement>(COMPOSER_SEL)]
    const live = composers.find((c) => (c.parentElement as HTMLElement | null)?.offsetParent !== null) ?? composers[0]
    if (!live) {
      if (host()) setHost(null)
      return
    }
    const h = ensureHost(live)
    if (host() !== h) setHost(h)

    // 收养上下文 ring:上游 timeline 的 progress-circle 按钮(图标态、非 tab)→ alpha 工具条停靠位
    const dock = h.querySelector<HTMLElement>("[data-alpha-usage-host]")
    if (dock) {
      const ring = [...document.querySelectorAll<HTMLElement>('button:has([data-component="progress-circle"])')].find(
        (b) =>
          !b.closest("[data-alpha-usage-host]") &&
          !b.closest('[role="tab"], [role="tablist"]') &&
          (b.textContent ?? "").trim() === "" &&
          b.offsetParent !== null,
      )
      const cur = dock.firstElementChild as HTMLElement | null
      if (cur && (cur.textContent ?? "").trim() !== "") dock.replaceChildren()
      if (ring && dock.firstChild !== ring) dock.replaceChildren(ring)
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      sync()
    }, 0)
  }
  let mo: MutationObserver | undefined
  onMount(() => {
    sync()
    for (const d of [80, 250, 600, 1200]) setTimeout(sync, d)
    mo = new MutationObserver(schedule)
    mo.observe(document.body, { childList: true, subtree: true })
  })
  onCleanup(() => {
    mo?.disconnect()
    if (timer) clearTimeout(timer)
    document.body.removeAttribute("data-alpha-composer-takeover")
  })

  return (
    <Show when={route() && host()}>
      {(_) => (
        <Portal mount={host()!}>
          <AlphaComposer
            mode="session"
            projects={props.projects}
            directory={() => route()?.directory}
            sessionID={() => route()?.sessionID}
          />
        </Portal>
      )}
    </Show>
  )
}
