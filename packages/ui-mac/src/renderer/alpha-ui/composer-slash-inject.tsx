// SessionSlashInject — the ALPHA slash menu inside opencode's in-session composer (REQ-038b,用户拍板
// 2026-07-05:「在新对话输入 / 和在已有对话输入 / 弹框不是一个弹框。我需要使用新对话的那个弹框」)。
//
// 首页(AlphaHome)的 slash 菜单与会话页上游 prompt-input 的 slash 弹层此前是两个实现;本组件把
// 首页那套(createComposerAutocomplete —— 同数据源、同样式、同选中语义)接管到会话 composer:
//   - 上游弹层整体隐藏(composer-reskin.css `:has(> [data-slash-id]) { display:none }`);
//   - 编辑器仍是上游 contenteditable(ADR-016 复用不重写):我们只 OBSERVE 其文本(input 事件,
//     capture)驱动 alpha 菜单,选中时经 execCommand 写回(触发上游自己的 input 监听,draft 状态
//     保持同步)—— builtin 命令照旧 command.trigger(id, "slash")、自定义命令回填 "/name ";
//   - 键盘接管:菜单开启时在 window CAPTURE 相位拦下 ↑↓/Enter/Tab(preventDefault +
//     stopImmediatePropagation,上游那套隐藏弹层收不到、不会双选);Esc 例外 —— 我们关自己的菜单
//     但**放行**给上游,让它把自己(隐藏)的弹层状态也关掉,否则后续 Enter 会静默选中隐藏项;
//   - @ 菜单不接管(上游 @ 与其内部 parts/draft 状态强耦合,modes: ["slash"])。
//
// 与 ComposerInject 同款 MutationObserver 挂载(composer 重挂即重接),零改上游(ADR-005/016)。

import { createEffect, createMemo, createSignal, onCleanup, onMount, Show, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { useLocation } from "@solidjs/router"
import { useCommand } from "./providers"
import { createComposerAutocomplete } from "./composer-autocomplete"
import { base64UrlDecode } from "../sidebar/route"
import type { AlphaProjectsApi } from "../sidebar/use-projects"

const COMPOSER_SEL = "[data-component=session-composer],[data-component=session-new-composer]"
const EDITOR_SEL = "[contenteditable=true]"

// The upstream editor pads its DOM with ZWSP/newlines around parts — normalize to what the user
// actually typed so detectTrigger's /^\/\S*$/ sees "/rev", not "/rev\n".
const editorText = (ed: HTMLElement): string =>
  (ed.textContent ?? "").replace(/[\u200B\uFEFF]/g, "").replace(/\n+$/, "")

export function SessionSlashInject(props: { projects: AlphaProjectsApi }) {
  const loc = useLocation()
  const command = useCommand()

  const [composerEl, setComposerEl] = createSignal<HTMLElement | null>(null)
  const [editor, setEditor] = createSignal<HTMLElement | null>(null)
  const [text, setText] = createSignal("")

  // Session routes are /<base64(dir)>/session[/<id>] — the directory feeds command.list so custom
  // commands match the project exactly like the home menu does.
  const directory = createMemo<string | undefined>(() => {
    const seg = loc.pathname.split("/")[1]
    if (!seg) return undefined
    try {
      const dir = base64UrlDecode(seg)
      return dir.startsWith("/") ? dir : undefined
    } catch {
      return undefined
    }
  })

  // Write-back adapter: replace the editor content via execCommand so the upstream composer's own
  // input listeners fire and its draft state stays in sync (we never touch its internals).
  const writeEditor = (v: string) => {
    const ed = editor()
    if (!ed) return
    ed.focus()
    document.execCommand("selectAll", false)
    if (v) document.execCommand("insertText", false, v)
    else document.execCommand("delete", false)
    setText(v)
  }

  const auto = createComposerAutocomplete({
    text,
    setText: writeEditor,
    textarea: () => undefined, // contenteditable host — caret falls back to end-of-text (slash-only is fine)
    directory,
    command,
    sdk: props.projects.sdk,
    onMention: () => {}, // unreachable with modes: ["slash"]
    modes: ["slash"],
  })

  // ── editor discovery (ComposerInject pattern: observer + debounce) ─────────
  const sync = () => {
    const composer = document.querySelector(COMPOSER_SEL) as HTMLElement | null
    const ed = composer?.querySelector(EDITOR_SEL) as HTMLElement | null
    if (!composer || !ed) {
      if (composerEl()) setComposerEl(null)
      if (editor()) setEditor(null)
      return
    }
    if (composerEl() !== composer) setComposerEl(composer)
    if (editor() !== ed) {
      setEditor(ed)
      setText(editorText(ed))
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

  // ── event wiring (capture phase so we run BEFORE the upstream editor's handlers) ──
  const onInput = (e: Event) => {
    const ed = editor()
    if (!ed || !(e.target instanceof Node) || !ed.contains(e.target)) return
    setText(editorText(ed))
    auto.onInput()
  }
  const onKeyDown = (e: KeyboardEvent) => {
    const ed = editor()
    if (!ed || !(e.target instanceof Node) || !ed.contains(e.target)) return
    if (!auto.open()) return
    const handled = auto.onKeyDown(e)
    // Esc: close ours AND let it propagate so the upstream (hidden) popover state closes too —
    // otherwise its Enter handler would silently select a hidden item on the next keystroke.
    if (handled && e.key !== "Escape") e.stopImmediatePropagation()
  }

  onMount(() => {
    sync()
    for (const d of [120, 400, 900, 1800]) setTimeout(sync, d)
    mo = new MutationObserver(schedule)
    mo.observe(document.body, { childList: true, subtree: true })
    document.addEventListener("input", onInput, true)
    window.addEventListener("keydown", onKeyDown, true)
  })
  onCleanup(() => {
    mo?.disconnect()
    if (timer) clearTimeout(timer)
    document.removeEventListener("input", onInput, true)
    window.removeEventListener("keydown", onKeyDown, true)
  })

  // ── fixed-position anchor (ChipPopover precedent): the composer box clips overflow, so the menu
  //    must live on <body> with a fixed rect derived from the composer — recomputed on open/resize.
  const [rectTick, setRectTick] = createSignal(0)
  const onResize = () => setRectTick((v) => v + 1)
  onMount(() => window.addEventListener("resize", onResize))
  onCleanup(() => window.removeEventListener("resize", onResize))
  const anchorStyle = createMemo<JSX.CSSProperties | undefined>(() => {
    rectTick()
    if (!auto.open()) return undefined
    const c = composerEl()
    if (!c) return undefined
    const r = c.getBoundingClientRect()
    // full composer rect — .a-comp-auto's own left/right 10px insets supply the padding (home parity)
    return {
      position: "fixed",
      left: `${Math.round(r.left)}px`,
      width: `${Math.round(r.width)}px`,
      bottom: `${Math.round(window.innerHeight - r.top)}px`,
      height: "0",
      "z-index": "60",
    }
  })

  return (
    <Show when={anchorStyle()}>
      {(style) => (
        <Portal>
          <div data-alpha-slash-anchor style={style()}>
            <auto.Menu />
          </div>
        </Portal>
      )}
    </Show>
  )
}
