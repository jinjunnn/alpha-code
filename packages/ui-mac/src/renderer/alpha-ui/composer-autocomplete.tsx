// composer-autocomplete — slash-command (/) and @-mention menus for the ALPHA home composer
// (REQ-038 目标①②). The home composer is a plain alpha <textarea>: the upstream in-session
// prompt-input is provider-bound and cannot mount on the home route (memory
// [[alpha-composer-provider-topology]]), so these menus are reimplemented against the SAME data
// sources the session page uses — behaviour parity, not a second behaviour:
//
//   slash items = useCommand().options (builtin; filter parity with upstream prompt-input.tsx
//                 slashCommands(): !disabled && !id.startsWith("suggested.") && slash)
//               + SDK v2 command.list({directory}) (custom: config commands + skill/MCP generated —
//                 the SAME source upstream reads as sync().data.command)
//   @ items     = SDK v2 agent.list (!hidden && mode !== "primary", parity with upstream agentList())
//               + SDK v2 find.files({directory, query}) (file tier — the workspace chip supplies the
//                 directory, so file references are in scope on home too)
//
// Selection semantics mirror upstream handleSlashSelect/handleAtSelect exactly:
//   custom command → refill the input with "/name " · builtin → clear + command.trigger(id, "slash")
//   agent/file     → insert "@…" text AND record a real prompt part (type agent/file) so the home
//                    submit sends the same parts the session composer would (text-only @ would be
//                    decoration — the engine only honours explicit parts).
//
// Rendered inside .a-comp (position:relative) reusing the existing .a-pop* styles, so the menu is
// visually the alpha popover family. Zero upstream edits (ADR-005/016).

import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show, type Accessor, type JSX } from "solid-js"
import type { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { useCommand } from "./providers"
import { applyMention, detectTrigger, triggerSignature, type MentionPart, type TriggerView } from "./composer-autocomplete-core"

type Client = ReturnType<typeof createOpencodeClient>
type CommandApi = ReturnType<typeof useCommand>
type CommandOption = CommandApi["options"][number]

export type { MentionPart } from "./composer-autocomplete-core"

type SlashItem = {
  kind: "slash"
  id: string
  trigger: string
  title: string
  description?: string
  custom: boolean
  badge?: string // custom source: skill / mcp
}
type AtItem =
  | { kind: "agent"; name: string; description?: string }
  | { kind: "file"; path: string }
type Item = SlashItem | AtItem

export function createComposerAutocomplete(opts: {
  text: Accessor<string>
  setText: (v: string) => void
  textarea: () => HTMLTextAreaElement | undefined
  directory: Accessor<string | undefined>
  command: CommandApi
  sdk: () => Client | undefined
  onMention: (m: MentionPart) => void
  /** Full IME guard from the host (event flags + its composition signal). The menu's Enter/Tab must
   *  not consume a composition-committing Enter (codex audit: event flags alone miss the case where
   *  only the host's compositionstart signal knows we're composing). */
  isComposing?: (e: KeyboardEvent) => boolean
}) {
  const [active, setActive] = createSignal(0)
  // Esc dismisses the menu for the CURRENT token only; typing anything re-opens (upstream parity).
  const [dismissed, setDismissed] = createSignal<string | null>(null)
  const [fileResults, setFileResults] = createSignal<string[]>([])

  // ── trigger detection (derived from text + caret; caret read lazily is fine because every
  //    caret-moving interaction also fires onInput/onKeyDown which re-runs the memo via text/version)
  const [version, setVersion] = createSignal(0)
  const bump = () => setVersion((v) => v + 1)

  const view = createMemo<TriggerView | null>(() => {
    version()
    const t = opts.text()
    const ta = opts.textarea()
    const caret = ta ? ta.selectionStart ?? t.length : t.length
    const v = detectTrigger(t, caret)
    if (!v) return null
    if (dismissed() === triggerSignature(v, t)) return null
    return v
  })

  // ── data sources ────────────────────────────────────────────────────────────
  // custom commands per directory (config + skill/MCP generated). list() does not throw — check {error}.
  const [customCmds] = createResource(
    () => (opts.sdk() ? (opts.directory() ?? "") : undefined),
    async (dir) => {
      const c = opts.sdk()
      if (!c) return []
      const { data, error } = await c.command.list(dir ? { directory: dir } : undefined)
      return error || !Array.isArray(data) ? [] : data
    },
  )
  const [agents] = createResource(
    () => (opts.sdk() ? (opts.directory() ?? "") : undefined),
    async (dir) => {
      const c = opts.sdk()
      if (!c) return []
      // v2 agent list ("/api/agent") — envelope is {location, data}; agents are keyed by `id`
      const { data, error } = await c.v2.agent.list(dir ? { location: { directory: dir } } : undefined)
      return error || !Array.isArray(data?.data) ? [] : data.data
    },
  )
  // file search — debounced on the @ query (parity: upstream searches on every keystroke via its
  // filtered-list plumbing; 120ms keeps the engine happy from a plain textarea)
  let fileTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    const v = view()
    if (!v || v.mode !== "at" || !v.query) {
      setFileResults([])
      return
    }
    const dir = opts.directory()
    const c = opts.sdk()
    if (!dir || !c) {
      setFileResults([]) // no directory/client → never show stale paths from a previous workspace
      return
    }
    const q = v.query
    if (fileTimer) clearTimeout(fileTimer)
    fileTimer = setTimeout(async () => {
      const { data, error } = await c.find.files({ directory: dir, query: q, limit: 8 }).catch(() => ({ data: undefined, error: true }) as const)
      // error → clear rather than leaving a previous query's results selectable (codex audit)
      setFileResults(!error && Array.isArray(data) ? data : [])
    }, 120)
  })
  onCleanup(() => fileTimer && clearTimeout(fileTimer))

  // ── item lists (order parity: custom before builtin / agents before files) ──
  const items = createMemo<Item[]>(() => {
    const v = view()
    if (!v) return []
    if (v.mode === "slash") {
      const q = v.query
      const custom: SlashItem[] = (customCmds() ?? [])
        .filter((c) => !q || c.name.toLowerCase().includes(q))
        .map((c) => ({
          kind: "slash",
          id: `custom.${c.name}`,
          trigger: c.name,
          title: c.name,
          description: c.description,
          custom: true,
          badge: c.source === "skill" || c.source === "mcp" ? c.source : undefined,
        }))
      const builtin: SlashItem[] = opts.command.options
        .filter((o: CommandOption) => !o.disabled && !o.id.startsWith("suggested.") && o.slash)
        .filter((o: CommandOption) => !q || o.slash!.toLowerCase().includes(q) || o.title.toLowerCase().includes(q))
        .map((o: CommandOption) => ({
          kind: "slash" as const,
          id: o.id,
          trigger: o.slash!,
          title: o.title,
          description: o.description,
          custom: false,
        }))
      return [...custom, ...builtin].slice(0, 12)
    }
    const q = v.query
    const ag: AtItem[] = (agents() ?? [])
      .filter((a) => !a.hidden && a.mode !== "primary")
      .filter((a) => !q || a.id.toLowerCase().includes(q))
      .map((a) => ({ kind: "agent" as const, name: a.id, description: a.description }))
    const fs: AtItem[] = fileResults().map((p) => ({ kind: "file" as const, path: p }))
    return [...ag, ...fs].slice(0, 12)
  })
  createEffect(() => {
    items()
    setActive(0)
  })

  const open = createMemo(() => view() !== null && items().length > 0)

  // ── selection ───────────────────────────────────────────────────────────────
  const focusEnd = (pos?: number) => {
    queueMicrotask(() => {
      const ta = opts.textarea()
      if (!ta) return
      ta.focus()
      const p = pos ?? ta.value.length
      ta.setSelectionRange(p, p)
      bump()
    })
  }

  const select = (it: Item) => {
    const v = view()
    if (!v) return
    if (it.kind === "slash") {
      if (it.custom) {
        // upstream handleSlashSelect: custom command refills the editor with "/name "
        const next = `/${it.trigger} `
        opts.setText(next)
        focusEnd(next.length)
      } else {
        // builtin: clear + trigger with slash provenance (upstream parity)
        opts.setText("")
        focusEnd(0)
        try {
          opts.command.trigger(it.id, "slash")
        } catch {
          /* command may be unregistered in some states */
        }
      }
      return
    }
    // @ mention: replace the @token [tokenStart, caret) with "@name " and record the real part
    const t = opts.text()
    const content = it.kind === "agent" ? `@${it.name}` : `@${it.path}`
    const applied = applyMention(t, v, content)
    opts.setText(applied.text)
    opts.onMention(
      it.kind === "agent"
        ? { type: "agent", name: it.name, content }
        : { type: "file", path: it.path, content },
    )
    focusEnd(applied.caret)
  }

  // Returns true when the key was consumed by the menu (caller must NOT also submit on Enter).
  const onKeyDown = (e: KeyboardEvent): boolean => {
    // caret may move via arrows/home/end even without input — re-derive on the next microtask
    queueMicrotask(bump)
    if (!open()) return false
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      const n = items().length
      setActive((a) => (a + (e.key === "ArrowDown" ? 1 : n - 1)) % n)
      return true
    }
    if (e.key === "Enter" || e.key === "Tab") {
      if (opts.isComposing ? opts.isComposing(e) : e.isComposing || e.keyCode === 229) return false
      e.preventDefault()
      const it = items()[active()]
      if (it) select(it)
      return true
    }
    if (e.key === "Escape") {
      e.preventDefault()
      const v = view()
      if (v) setDismissed(triggerSignature(v, opts.text()))
      return true
    }
    return false
  }

  const onInput = () => {
    setDismissed(null)
    bump()
  }

  const Menu = (): JSX.Element => (
    <Show when={open()}>
      <div class="a-pop a-comp-auto" role="listbox">
        <div class="a-pop-label">{view()?.mode === "slash" ? "命令" : "引用"}</div>
        <For each={items()}>
          {(it, i) => (
            <button
              class="a-pop-item"
              classList={{ "is-active": i() === active() }}
              role="option"
              aria-selected={i() === active()}
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => setActive(i())}
              onClick={() => select(it)}
            >
              <Show
                when={it.kind === "slash"}
                fallback={
                  it.kind === "agent" ? (
                    <>
                      <span class="a-auto-trig">@{(it as Extract<AtItem, { kind: "agent" }>).name}</span>
                      <span class="a-pop-desc">
                        {(it as Extract<AtItem, { kind: "agent" }>).description || "Agent"}
                      </span>
                    </>
                  ) : (
                    <>
                      <span class="a-auto-file">{(it as Extract<AtItem, { kind: "file" }>).path}</span>
                      <span class="a-pop-desc">文件</span>
                    </>
                  )
                }
              >
                <span class="a-auto-trig">/{(it as SlashItem).trigger}</span>
                <Show when={(it as SlashItem).badge}>
                  <span class="a-auto-badge">{(it as SlashItem).badge}</span>
                </Show>
                <span class="a-pop-desc">{(it as SlashItem).description || (it as SlashItem).title}</span>
              </Show>
            </button>
          )}
        </For>
      </div>
    </Show>
  )

  return { open, onKeyDown, onInput, Menu }
}
