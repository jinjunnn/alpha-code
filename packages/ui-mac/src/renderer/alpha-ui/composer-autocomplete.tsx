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

import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show, type Accessor, type JSX } from "solid-js"
import type { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { useCommand } from "./providers"
import { setExtHubOpen, setHubSection } from "../extensions/ext-hub-state"
import {
  applyMention,
  buildSlashList,
  commandOrigin,
  detectTrigger,
  displayDescription,
  filterGovernanceDenied,
  slashSection,
  sourceTag,
  triggerSignature,
  type CommandOrigin,
  type MentionPart,
  type SlashSection,
  type SourceTag,
  type TriggerView,
} from "./composer-autocomplete-core"

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
  origin: CommandOrigin // REQ-066 T2 数据源(内置/技能/项目/MCP/导入)
  section: SlashSection // REQ-072:分节 = 类型维度
  tag: SourceTag // REQ-072:行尾来源 = 归属四档(内置/个人/项目/MCP)
}
type AtItem =
  | { kind: "agent"; name: string; description?: string }
  | { kind: "file"; path: string }
type Item = SlashItem | AtItem

/** REQ-072 B 案:`/agents` 单条管理入口(agent 不平铺进 `/`,指派走 `@`,GLOSSARY「输入语法分工」)。 */
const AGENTS_ENTRY_ID = "alpha.slash.agents"

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
  /** Which trigger modes to serve (default both). The SESSION surface uses ["slash"] only — its @
   *  menu stays upstream (tied to the frozen prompt-input's internal parts state, REQ-038b). */
  modes?: Array<"slash" | "at">
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
    if (opts.modes && !opts.modes.includes(v.mode)) return null
    if (dismissed() === triggerSignature(v, t)) return null
    return v
  })

  // ── data sources ────────────────────────────────────────────────────────────
  // custom commands per directory (config + skill/MCP generated). list() does not throw — check {error}.
  const [customCmds, { refetch: refetchCmds }] = createResource(
    () => (opts.sdk() ? (opts.directory() ?? "") : undefined),
    async (dir) => {
      const c = opts.sdk()
      if (!c) return []
      const { data, error } = await c.command.list(dir ? { directory: dir } : undefined)
      return error || !Array.isArray(data) ? [] : data
    },
  )
  // REQ-066:治理禁用集(T1)+ 导入技能集(T2 来源标注)。每次斜杠菜单打开时刷新(AgentChip
  // 同款节奏)—— 治理面板解禁 / 新装技能后免重启恢复(dispose 使引擎侧已重扫,这里拉新即可)。
  // 读取失败 → 保留上次集合(初始为空 = 不过滤):诚实退化回 REQ-037 占位缓解态,菜单不崩。
  const [deniedSkills, setDeniedSkills] = createSignal<ReadonlySet<string>>(new Set())
  const [importedSkills, setImportedSkills] = createSignal<ReadonlySet<string>>(new Set())
  // REQ-072:出厂技能名单 —— 「技能」节里区分 内置(出厂)vs 个人(自装/导入)的归属真源。
  const [factorySkills, setFactorySkills] = createSignal<ReadonlySet<string>>(new Set())
  const refreshGovernance = async () => {
    const ext = window.api?.ext
    if (!ext) return
    const [gov, installs, factory] = await Promise.all([
      ext.govRead().catch(() => null),
      ext.listInstalls(opts.directory()).catch(() => null),
      ext.factorySkillIds().catch(() => null),
    ])
    if (factory) setFactorySkills(new Set(factory))
    // REQ-067:有效禁用集 = 用户自禁(deny)∪ 出厂默认禁(factoryDenied,main 已减去用户解禁)
    if (gov?.gov?.skills?.deny) setDeniedSkills(new Set([...gov.gov.skills.deny, ...(gov.factoryDenied ?? [])]))
    if (installs)
      setImportedSkills(
        new Set(
          [...(installs.global ?? []), ...(installs.project ?? [])]
            .filter((r) => r.type === "skill" && r.origin.startsWith("imported")) // imported / imported-claude / imported-agents(REQ-063)
            .map((r) => r.name),
        ),
      )
  }
  let wasSlash = false
  createEffect(() => {
    const isSlash = view()?.mode === "slash"
    if (isSlash && !wasSlash) {
      void refreshGovernance()
      void refetchCmds() // 解禁后的占位残描述 / 新装技能 → 打开菜单即拉新(resource 刷新期间保留旧值,无闪烁)
    }
    wasSlash = isSlash
  })
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

  // ── item lists ──────────────────────────────────────────────────────────
  // REQ-072 根因②③修复:全量不截断(原 slice(0,12) 使排后技能永不可见);过滤/排序/分组走
  // core 的 buildSlashList(名称+简介都搜、前缀优先、无查询分节字母序)。
  const toSlashItem = (base: Omit<SlashItem, "kind" | "section" | "tag">): SlashItem => ({
    kind: "slash",
    ...base,
    section: slashSection(base.origin),
    tag: sourceTag(base.origin, base.trigger, factorySkills()),
  })
  const slashData = createMemo(() => {
    const v = view()
    if (!v || v.mode !== "slash") return null
    const entries: SlashItem[] = [
      ...filterGovernanceDenied(customCmds() ?? [], deniedSkills()).map((c) =>
        toSlashItem({
          id: `custom.${c.name}`,
          trigger: c.name,
          title: c.name,
          description: c.description,
          custom: true,
          origin: commandOrigin(c, importedSkills()),
        }),
      ),
      ...opts.command.options
        .filter((o: CommandOption) => !o.disabled && !o.id.startsWith("suggested.") && o.slash)
        .map((o: CommandOption) =>
          toSlashItem({
            id: o.id,
            trigger: o.slash!,
            title: o.title,
            description: o.description,
            custom: false,
            origin: "builtin", // alpha 应用命令面板项 = 内置(与引擎内置同标)
          }),
        ),
    ]
    // REQ-072 B 案:单条 /agents 管理入口(引擎同名命令存在时让位,不造重名)
    if (!entries.some((e) => e.trigger === "agents"))
      entries.push(toSlashItem({ id: AGENTS_ENTRY_ID, trigger: "agents", title: "Agent 管理", custom: false, origin: "builtin" }))
    return buildSlashList(entries, v.query)
  })
  const items = createMemo<Item[]>(() => {
    const v = view()
    if (!v) return []
    if (v.mode === "slash") return slashData()?.flat ?? []
    const q = v.query
    const ag: AtItem[] = (agents() ?? [])
      .filter((a) => !a.hidden && a.mode !== "primary")
      .filter((a) => !q || a.id.toLowerCase().includes(q))
      .map((a) => ({ kind: "agent" as const, name: a.id, description: a.description }))
    const fs: AtItem[] = fileResults().map((p) => ({ kind: "file" as const, path: p }))
    return [...ag, ...fs]
  })
  // REQ-072 根因①修复:active 只在列表**内容**变化时归零。原实现对 items() 引用变化归零,而
  // onKeyDown 每键 bump → memo 重算出新引用 → ↑↓ 刚设的选中被微任务重置回 0(键盘导航貌似失效)。
  const itemKey = (it: Item) => (it.kind === "slash" ? `s:${it.id}` : it.kind === "agent" ? `a:${it.name}` : `f:${it.path}`)
  const itemsSig = createMemo(() => items().map(itemKey).join(" "))
  createEffect(on(itemsSig, () => setActive(0)))

  // 空态可见(根因③):斜杠 + 有查询 + 零命中 → 菜单保留显示「无匹配」,不再闪没。
  const open = createMemo(() => {
    const v = view()
    if (!v) return false
    if (items().length > 0) return true
    return v.mode === "slash" && v.query.length > 0
  })

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
      // REQ-072 B 案:/agents = 管理入口,打开定制中心 Agent 页(不发消息、不展开模板)
      if (it.id === AGENTS_ENTRY_ID) {
        opts.setText("")
        focusEnd(0)
        setHubSection("agents")
        setExtHubOpen(true)
        return
      }
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

  // ── menu rendering ──────────────────────────────────────────────────────
  // 类型 icon(16px 线性,定稿 v1):❯ 命令 · ✦ 技能 · ▤ 项目 · ⌁ MCP · agent · 文件
  const SECTION_ICON: Record<SlashSection, string> = {
    builtin: "M3 4.5 6.5 8 3 11.5 M8.5 12H13",
    skill: "M8 1.8l1.6 4.1 4.1 1.6-4.1 1.6L8 13.2 6.4 9.1 2.3 7.5l4.1-1.6z",
    project: "M1.8 4.2c0-.6.4-1 1-1h3.4l1.4 1.6h5.6c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1z",
    mcp: "M6 2v3.2 M10 2v3.2 M4.5 5.2h7v2.6a3.5 3.5 0 0 1-7 0z M8 11.3V14",
  }
  const AT_ICON: Record<"agent" | "file", string> = {
    agent: "M8 8a2.6 2.6 0 1 0 0-5.2A2.6 2.6 0 0 0 8 8zm-5 5.4c.7-2.5 2.7-3.8 5-3.8s4.3 1.3 5 3.8",
    file: "M4 1.8h5.2L12 4.6v9.6H4zM9.2 1.8v2.8H12",
  }
  const Ic = (p: { d: string }) => (
    <svg class="a-auto-ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
      <path d={p.d} />
    </svg>
  )

  let scrollEl: HTMLDivElement | undefined
  // 键盘选中跟随滚动(全量列表配套;nearest 不跳动)
  createEffect(() => {
    const i = active()
    queueMicrotask(() => scrollEl?.querySelector(`[data-idx="${i}"]`)?.scrollIntoView({ block: "nearest" }))
  })

  const Row = (p: { it: Item; idx: number }): JSX.Element => (
    <button
      class="a-pop-item a-auto-row"
      classList={{ "is-active": p.idx === active() }}
      role="option"
      aria-selected={p.idx === active()}
      data-idx={p.idx}
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={() => setActive(p.idx)}
      onClick={() => select(p.it)}
    >
      <Show
        when={p.it.kind === "slash"}
        fallback={
          p.it.kind === "agent" ? (
            <>
              <Ic d={AT_ICON.agent} />
              <span class="a-auto-trig">@{(p.it as Extract<AtItem, { kind: "agent" }>).name}</span>
              <span class="a-auto-desc" title={(p.it as Extract<AtItem, { kind: "agent" }>).description || "Agent"}>
                {(p.it as Extract<AtItem, { kind: "agent" }>).description || "Agent"}
              </span>
            </>
          ) : (
            <>
              <Ic d={AT_ICON.file} />
              <span class="a-auto-file">{(p.it as Extract<AtItem, { kind: "file" }>).path}</span>
              <span class="a-auto-desc">文件</span>
            </>
          )
        }
      >
        <Ic d={SECTION_ICON[(p.it as SlashItem).section]} />
        <span class="a-auto-trig">/{(p.it as SlashItem).trigger}</span>
        <span class="a-auto-desc" title={displayDescription(p.it as SlashItem)}>
          {displayDescription(p.it as SlashItem)}
        </span>
        <span class="a-auto-tag" data-personal={(p.it as SlashItem).tag === "个人" ? "" : undefined}>
          {(p.it as SlashItem).tag}
        </span>
      </Show>
    </button>
  )

  const Menu = (): JSX.Element => (
    <Show when={open()}>
      <div class="a-pop a-comp-auto" role="listbox">
        <div class="a-comp-auto-scroll" ref={scrollEl}>
          <Show when={view()?.mode === "slash"} fallback={<div class="a-pop-label">引用</div>}>
            {null}
          </Show>
          <Show
            when={view()?.mode === "slash" && (slashData()?.groups.length ?? 0) > 0}
            fallback={
              <Show
                when={items().length > 0}
                fallback={
                  <div class="a-comp-empty">
                    <b>无匹配命令</b>试试更短的关键词,或按 esc 关闭
                  </div>
                }
              >
                <For each={items()}>{(it, i) => <Row it={it} idx={i()} />}</For>
              </Show>
            }
          >
            {/* 无查询:分节渲染(节内序即 flat 序,idx 用 flat.indexOf 保持键盘索引一致) */}
            <For each={slashData()!.groups}>
              {(g) => (
                <>
                  <div class="a-comp-sec">{g.label}</div>
                  <For each={g.items}>{(it) => <Row it={it} idx={(slashData()?.flat ?? []).indexOf(it)} />}</For>
                </>
              )}
            </For>
          </Show>
        </div>
        <div class="a-comp-foot">
          <span>↑↓ 选择</span>
          <span>↵ 确认</span>
          <span>esc 关闭</span>
          <span class="a-comp-foot-grow" />
          <span class="a-comp-foot-hint">{view()?.mode === "slash" ? "@ 引用 Agent / 文件" : "/ 执行命令 · 技能"}</span>
          <Show when={items().length > 0}>
            <span>{items().length} 项</span>
          </Show>
        </div>
      </div>
    </Show>
  )

  return { open, onKeyDown, onInput, Menu }
}
