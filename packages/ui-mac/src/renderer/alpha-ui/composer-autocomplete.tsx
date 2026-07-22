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
import { composerAgent, composerPerm, INTERNAL_AGENTS, setComposerAgent } from "./composer-state"
import {
  applyMention,
  buildAssembleRows,
  buildSlashList,
  commandOrigin,
  detectTrigger,
  displayDescription,
  filterBuiltinDenied,
  slashSection,
  sourceTag,
  triggerSignature,
  type AssembleRow,
  type CommandOrigin,
  type MentionPart,
  type SlashSection,
  type SourceTag,
  type TriggerView,
} from "./composer-autocomplete-core"
import { t } from "../i18n"

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
/** REQ-073:@/+ 统一装配弹窗 —— at 模式的条目即 core 的 AssembleRow(动作/模式/agent/文件)。 */
type Item = SlashItem | AssembleRow

/** REQ-072 B 案:`/agents` 单条管理入口(agent 不平铺进 `/`,指派走 `@`,GLOSSARY「输入语法分工」)。 */
const AGENTS_ENTRY_ID = "alpha.slash.agents"
let autocompleteSeq = 0

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
  /** Which trigger modes to serve (default both). */
  modes?: Array<"slash" | "at">
  /** 宿主表面:终端行只在 session 出现(home 无 terminal.new 注册,REQ-078 T1 不摆死行)。 */
  surface?: "home" | "session"
  /** 「添加附件」行的真通道(宿主打开自己的文件选择器,REQ-078 T2);缺省时该行仍显示但为
   *  no-op —— 唯一消费方 AlphaComposer 恒传。 */
  onAttach?: () => void
}) {
  const listboxId = `a-composer-autocomplete-${++autocompleteSeq}`
  const [active, setActive] = createSignal(0)
  // Esc dismisses the menu for the CURRENT token only; typing anything re-opens (upstream parity).
  const [dismissed, setDismissed] = createSignal<string | null>(null)
  const [fileResults, setFileResults] = createSignal<string[]>([])
  // REQ-073:+ 按钮打开同一装配弹窗(button 模式,无 token;有 @token 时 token 视图优先)。
  const [buttonOpen, setButtonOpen] = createSignal(false)

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
    if (v) {
      if (opts.modes && !opts.modes.includes(v.mode)) return null
      if (dismissed() === triggerSignature(v, t)) return null
      return v
    }
    // button 模式:合成零宽 at 视图(tokenStart = caret → 引用类选中即在光标处插入,拍板②)
    if (buttonOpen() && (!opts.modes || opts.modes.includes("at"))) return { mode: "at", query: "", tokenStart: caret, caret }
    return null
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
  const refreshBuiltinDenied = async () => {
    const ext = window.api?.ext
    if (!ext) return
    const [gov, installs, factory] = await Promise.all([
      ext.builtinRead().catch(() => null),
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
      void refreshBuiltinDenied()
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
      const { data, error } = await c.find.files({ directory: dir, query: q, limit: 20 }).catch(() => ({ data: undefined, error: true }) as const)
      // error → clear rather than leaving a previous query's results selectable (codex audit)
      setFileResults(!error && Array.isArray(data) ? data : [])
    }, 120)
  })
  onCleanup(() => fileTimer && clearTimeout(fileTimer))
  // REQ-078 T3:零查询钉「git 变更文件」—— @/+ 弹窗打开瞬间拉一次 vcs.status(refreshBuiltinDenied
  // 同节奏);失败/无目录/非 git → 空(退回纯提示行,不崩不留陈旧路径)。
  // 注意端点选型:`/file/status` 在上游引擎是恒返 [] 的存根(handlers/file.ts:127-129,SDK 有形
  // 引擎无实,dev 实测),真实现是 `/vcs/status`(handlers/instance.ts:47-49 → Vcs.Service)。
  const [changedFiles, setChangedFiles] = createSignal<string[]>([])
  const refreshChanged = async () => {
    const dir = opts.directory()
    const c = opts.sdk()
    if (!dir || !c) {
      setChangedFiles([])
      return
    }
    const { data, error } = await c.vcs.status({ directory: dir }).catch(() => ({ data: undefined, error: true }) as const)
    const base = dir.replace(/\/$/, "")
    const rel = (p: string) => (p.startsWith(base + "/") ? p.slice(base.length + 1) : p)
    setChangedFiles(!error && Array.isArray(data) ? data.map((f) => rel(f.file)).slice(0, 10) : [])
  }
  let wasAt = false
  createEffect(() => {
    const isAt = view()?.mode === "at"
    if (isAt && !wasAt) void refreshChanged()
    wasAt = isAt
  })

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
      ...filterBuiltinDenied(customCmds() ?? [], deniedSkills()).map((c) =>
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
      entries.push(toSlashItem({ id: AGENTS_ENTRY_ID, trigger: "agents", title: t("alpha.autocomplete.agentManagement"), custom: false, origin: "builtin" }))
    return buildSlashList(entries, v.query)
  })
  // REQ-073:装配弹窗数据(添加/AGENT/文件/扩展 四节)。agent 列表不再预滤 primary ——
  // 子 agent 进 AGENT 节,第三方主档(非 build/plan)进「添加」节动态模式项(拍板⑤)。
  const assembleData = createMemo(() => {
    const v = view()
    if (!v || v.mode !== "at") return null
    const list = (agents() ?? []).filter((a) => !a.hidden && !INTERNAL_AGENTS.has(a.id))
    return buildAssembleRows({
      query: v.query,
      planOn: composerAgent() === "plan",
      readonly: composerPerm() === "readonly",
      activeMode: composerAgent(),
      subAgents: list.filter((a) => a.mode !== "primary").map((a) => ({ name: a.id, description: a.description })),
      primaries: list.filter((a) => a.mode === "primary" && a.id !== "build" && a.id !== "plan").map((a) => a.id),
      files: fileResults(),
      changedFiles: changedFiles(),
      terminal: opts.surface === "session",
    })
  })
  const items = createMemo<Item[]>(() => {
    const v = view()
    if (!v) return []
    if (v.mode === "slash") return slashData()?.flat ?? []
    return assembleData()?.flat ?? []
  })
  // REQ-072 根因①修复:active 只在列表**内容**变化时归零。原实现对 items() 引用变化归零,而
  // onKeyDown 每键 bump → memo 重算出新引用 → ↑↓ 刚设的选中被微任务重置回 0(键盘导航貌似失效)。
  const itemIdentity = (it: Item) =>
    it.kind === "slash"
      ? `s:${it.id}`
      : it.kind === "action"
        ? `x:${it.id}`
        : it.kind === "mode"
          ? `m:${it.id}`
          : it.kind === "agent"
            ? `a:${it.name}`
            : `f:${it.path}`
  const itemKey = (it: Item) =>
    it.kind === "action"
      ? `${itemIdentity(it)}:${it.label}`
      : it.kind === "mode"
        ? `${itemIdentity(it)}:${it.on}`
        : itemIdentity(it)
  const optionId = (item: Item) => `${listboxId}-option-${encodeURIComponent(itemIdentity(item))}`
  const itemsSig = createMemo(() => items().map(itemKey).join(" "))
  createEffect(on(itemsSig, () => setActive(0)))

  // 空态可见(根因③,两菜单同语义):有查询 + 零命中 → 菜单保留显示「无匹配」,不再闪没。
  const open = createMemo(() => {
    const v = view()
    if (!v) return false
    if (items().length > 0) return true
    return v.query.length > 0
  })
  const activeDescendant = createMemo(() => {
    const item = items()[active()]
    return open() && item ? optionId(item) : undefined
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

  // 动作类选中后:token 模式清掉 @token 文本;button 模式关弹窗(拍板②)。
  const finishAction = (v: TriggerView) => {
    setButtonOpen(false)
    if (v.caret > v.tokenStart) {
      const t = opts.text()
      opts.setText(t.slice(0, v.tokenStart) + t.slice(v.caret))
      focusEnd(v.tokenStart)
    }
  }
  const runCommand = (id: string) => {
    try {
      opts.command.trigger(id)
    } catch {
      /* command may be unregistered in some states */
    }
  }

  const select = (it: Item) => {
    const v = view()
    if (!v) return
    // ── REQ-073 装配弹窗:动作 / 模式 ────────────────────────────────────────
    if (it.kind === "action") {
      if (it.disabled) return
      // REQ-078 T1/T2:附件走宿主真通道(此前 runCommand("file.attach") 在 home 静默 no-op、在
      // session 落进被隐藏的上游 prompt store —— 两处 placebo,已根除)。
      if (it.id === "plan") setComposerAgent(composerAgent() === "plan" ? null : "plan")
      else if (it.id === "attach") opts.onAttach?.()
      else if (it.id === "terminal") runCommand("terminal.new")
      else if (it.id === "ext-market") setExtHubOpen(true)
      finishAction(v)
      return
    }
    if (it.kind === "mode") {
      setComposerAgent(it.on ? null : it.id)
      finishAction(v)
      return
    }
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
    if (e.key === "Enter" || (e.key === "Tab" && !e.shiftKey)) {
      // Shift+Tab 让位给计划模式切换(REQ-073,composer 层处理)
      if (opts.isComposing ? opts.isComposing(e) : e.isComposing || e.keyCode === 229) return false
      e.preventDefault()
      const it = items()[active()]
      if (it) select(it)
      return true
    }
    if (e.key === "Escape") {
      e.preventDefault()
      if (buttonOpen()) {
        setButtonOpen(false)
        return true
      }
      const v = view()
      if (v) setDismissed(triggerSignature(v, opts.text()))
      return true
    }
    return false
  }

  const onInput = () => {
    setDismissed(null)
    setButtonOpen(false) // button 模式下开始打字 = 回到正常输入(要过滤请用 @token)
    bump()
  }

  // button 模式点击弹窗外关闭(popover-hit 同精神:composer 树内的点击不算外部)
  const onDocDown = (e: MouseEvent) => {
    if (!buttonOpen()) return
    const t = e.target as Element | null
    if (t && t.closest(".a-comp")) return
    setButtonOpen(false)
  }
  document.addEventListener("mousedown", onDocDown)
  onCleanup(() => document.removeEventListener("mousedown", onDocDown))

  /** REQ-073:+ 按钮打开/收起统一装配弹窗(与 @ 同一组件;焦点回输入框保键盘导航)。 */
  const toggleAssemble = () => {
    setDismissed(null)
    const next = !buttonOpen()
    setButtonOpen(next)
    if (next) opts.textarea()?.focus()
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
  // 装配弹窗动作/模式行 icon(回形针 / 终端 / 清单 / 拼图 / 档位)
  const ACTION_ICON: Record<string, string> = {
    attach: "M13 7.5 8.2 12.3a3 3 0 0 1-4.2-4.2L9 3a2 2 0 0 1 2.9 2.9L7 10.8a1 1 0 0 1-1.5-1.5L10 4.8",
    terminal: "M2.5 3.5h11v9h-11z M4.5 6l2 2-2 2 M8 10.5h3",
    plan: "M5.5 4h8 M5.5 8h8 M5.5 12h8 M2.3 3.4l.8.8 1.3-1.4 M2.3 7.4l.8.8 1.3-1.4 M2.5 12h.01",
    "ext-market": "M6 2.5H3.5a1 1 0 0 0-1 1V6 M10 2.5h2.5a1 1 0 0 1 1 1V6 M6 13.5H3.5a1 1 0 0 1-1-1V10 M10 13.5h2.5a1 1 0 0 0 1-1V10",
    mode: "M2.5 5h7 M11.5 5H13.5 M9.5 3.5v3 M2.5 11h2 M6.5 11h7 M4.5 9.5v3",
  }
  const Ic = (p: { d: string }) => (
    <svg class="a-auto-ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
      <path d={p.d} />
    </svg>
  )

  const slashDescription = (item: SlashItem) => {
    const descriptions = {
      init: "alpha.autocomplete.descInit",
      review: "alpha.autocomplete.descReview",
      agents: "alpha.autocomplete.descAgents",
      "skill-creator": "alpha.autocomplete.descSkillCreator",
      "agent-creator": "alpha.autocomplete.descAgentCreator",
      "customize-alpha": "alpha.autocomplete.descCustomizeAlpha",
      "integrate-project": "alpha.autocomplete.descIntegrateProject",
      "alpha-workspace": "alpha.autocomplete.descAlphaWorkspace",
    } as const
    const key = descriptions[item.trigger as keyof typeof descriptions]
    if (key) return t(key)
    return displayDescription(item)
  }
  const actionLabel = (item: Extract<AssembleRow, { kind: "action" }>) => {
    if (item.id === "attach") return t("alpha.autocomplete.attach")
    if (item.id === "terminal") return t("alpha.autocomplete.openTerminal")
    if (item.id === "ext-market") return t("alpha.autocomplete.extensionMarket")
    return composerAgent() === "plan" ? t("alpha.autocomplete.disablePlan") : t("alpha.autocomplete.planMode")
  }
  const actionDescription = (item: Extract<AssembleRow, { kind: "action" }>) => {
    if (item.disabled) return t("alpha.autocomplete.readonlyPlan")
    if (item.id === "attach") return t("alpha.autocomplete.attachDesc")
    if (item.id === "terminal") return t("alpha.autocomplete.openTerminalDesc")
    if (item.id === "ext-market") return t("alpha.autocomplete.extensionMarketDesc")
    return composerAgent() === "plan" ? t("alpha.autocomplete.disablePlanDesc") : t("alpha.autocomplete.planModeDesc")
  }
  const agentDescription = (item: Extract<AssembleRow, { kind: "agent" }>) => {
    if (item.name === "general") return t("alpha.autocomplete.agentGeneral")
    if (item.name === "explore") return t("alpha.autocomplete.agentExplore")
    return item.desc
  }
  const groupHint = (hint: string | undefined) => {
    if (!hint) return ""
    if (hint.startsWith("git ")) return t("alpha.autocomplete.changedFilesHint")
    return t("alpha.autocomplete.searchFilesHint")
  }

  let scrollEl: HTMLDivElement | undefined
  // 键盘选中跟随滚动(全量列表配套;nearest 不跳动)
  createEffect(() => {
    const i = active()
    queueMicrotask(() => scrollEl?.querySelector(`[data-idx="${i}"]`)?.scrollIntoView({ block: "nearest" }))
  })

  const RowBody = (p: { it: Item }): JSX.Element => {
    const it = p.it
    if (it.kind === "slash")
      return (
        <>
          <Ic d={SECTION_ICON[it.section]} />
          <span class="a-auto-trig">/{it.trigger}</span>
          <span class="a-auto-desc" title={slashDescription(it)}>
            {slashDescription(it)}
          </span>
          <span class="a-auto-tag" data-personal={it.tag === "个人" ? "" : undefined}>
            {sourceLabel(it.tag)}
          </span>
        </>
      )
    if (it.kind === "action")
      return (
        <>
          <Ic d={ACTION_ICON[it.id]} />
          <span class="a-auto-nm">{actionLabel(it)}</span>
          <span class="a-auto-desc" title={actionDescription(it)}>
            {actionDescription(it)}
          </span>
          <Show when={it.kbd}>
            <span class="a-auto-tag">{it.kbd}</span>
          </Show>
        </>
      )
    if (it.kind === "mode")
      return (
        <>
          <Ic d={ACTION_ICON.mode} />
          <span class="a-auto-nm">{t("alpha.autocomplete.mode", { name: it.id })}</span>
          <span class="a-auto-desc" title={t("alpha.autocomplete.modeDesc")}>
            {t("alpha.autocomplete.modeDesc")}
          </span>
          <Show when={it.on}>
            <span class="a-auto-tag" data-personal="">
              {t("alpha.autocomplete.enabled")}
            </span>
          </Show>
        </>
      )
    if (it.kind === "agent")
      return (
        <>
          <Ic d={AT_ICON.agent} />
          <span class="a-auto-trig">@{it.name}</span>
          <span class="a-auto-desc" title={agentDescription(it)}>
            {agentDescription(it)}
          </span>
          <span class="a-auto-tag" data-personal={it.tag === "个人" ? "" : undefined}>
            {sourceLabel(it.tag)}
          </span>
        </>
      )
    return (
      <>
        <Ic d={AT_ICON.file} />
        <span class="a-auto-file">{it.path}</span>
        <span class="a-auto-desc">{t("alpha.autocomplete.file")}</span>
      </>
    )
  }

  // Chromium 在列表重渲染时会于光标原地**合成** mousemove(hover 校准)——每次按键都重建行
  // 节点,若物理鼠标恰好悬在弹窗上,合成事件会把键盘选中拽回悬停行(键盘导航被劫持,CDP 实测)。
  // 只认坐标真变化的 mousemove(标准 combobox 手法)。
  let lastMouseX = Number.NaN
  let lastMouseY = Number.NaN
  const isRealMouseMove = (e: MouseEvent) => {
    const calibrated = !Number.isNaN(lastMouseX)
    const moved = e.clientX !== lastMouseX || e.clientY !== lastMouseY
    lastMouseX = e.clientX
    lastMouseY = e.clientY
    return calibrated && moved // 首个事件只校准坐标(它可能就是合成事件),不算移动
  }

  const Row = (p: { it: Item; idx: number }): JSX.Element => {
    const disabled = () => p.it.kind === "action" && !!p.it.disabled
    return (
      <button
        id={optionId(p.it)}
        class="a-pop-item a-auto-row"
        classList={{ "is-active": p.idx === active() && !disabled() }}
        role="option"
        aria-selected={p.idx === active()}
        aria-disabled={disabled() || undefined}
        data-disabled={disabled() ? "" : undefined}
        data-idx={p.idx}
        onMouseDown={(e) => e.preventDefault()}
        onMouseMove={(e) => isRealMouseMove(e) && !disabled() && p.idx >= 0 && setActive(p.idx)}
        onClick={() => select(p.it)}
      >
        <RowBody it={p.it} />
      </button>
    )
  }

  const Menu = (): JSX.Element => (
    <Show when={open()}>
      <div id={listboxId} class="a-pop a-comp-auto" role="listbox">
        <div class="a-comp-auto-scroll" ref={scrollEl}>
          <Show
            when={items().length > 0 || (view()?.mode === "at" && !view()?.query)}
            fallback={
              <div class="a-comp-empty" role="status">
                <b>{t("alpha.autocomplete.noMatches")}</b>{t("alpha.autocomplete.noMatchesHint")}
              </div>
            }
          >
            <Show
              when={view()?.mode === "slash"}
              fallback={
                /* REQ-073 装配弹窗:添加 / AGENT / 文件 / 扩展(禁用行可见不可选;文件节无查询给提示) */
                <For each={assembleData()?.groups ?? []}>
                  {(g) => (
                    <>
                      <div class="a-comp-sec" role="presentation">{groupLabel(g.label)}</div>
                      <Show when={g.hint}>
                        <div class="a-comp-hint">{groupHint(g.hint)}</div>
                      </Show>
                      <For each={g.rows}>{(it) => <Row it={it} idx={(assembleData()?.flat ?? []).indexOf(it)} />}</For>
                    </>
                  )}
                </For>
              }
            >
              <Show
                when={(slashData()?.groups.length ?? 0) > 0}
                fallback={<For each={items()}>{(it, i) => <Row it={it} idx={i()} />}</For>}
              >
                {/* 无查询:分节渲染(节内序即 flat 序,idx 用 flat.indexOf 保持键盘索引一致) */}
                <For each={slashData()!.groups}>
                  {(g) => (
                    <>
                      <div class="a-comp-sec" role="presentation">{groupLabel(g.label)}</div>
                      <For each={g.items}>{(it) => <Row it={it} idx={(slashData()?.flat ?? []).indexOf(it)} />}</For>
                    </>
                  )}
                </For>
              </Show>
            </Show>
          </Show>
        </div>
        <div class="a-comp-foot">
          <span>{t("alpha.autocomplete.selectHint")}</span>
          <span>{t("alpha.autocomplete.confirmHint")}</span>
          <span>{t("alpha.autocomplete.closeHint")}</span>
          <span class="a-comp-foot-grow" />
          <span class="a-comp-foot-hint">{view()?.mode === "slash" ? t("alpha.autocomplete.mentionHint") : t("alpha.autocomplete.commandHint")}</span>
          <Show when={items().length > 0}>
            <span>{t("alpha.autocomplete.itemCount", { count: items().length })}</span>
          </Show>
        </div>
      </div>
    </Show>
  )

  return { open, assembleOpen: buttonOpen, activeDescendant, listboxId, onKeyDown, onInput, Menu, toggleAssemble }
}

function sourceLabel(tag: SourceTag) {
  if (tag === "内置") return t("alpha.autocomplete.sourceBuiltin")
  if (tag === "个人") return t("alpha.autocomplete.sourcePersonal")
  if (tag === "项目") return t("alpha.autocomplete.sourceProject")
  return tag
}

function groupLabel(label: string) {
  if (label === "内置命令") return t("alpha.autocomplete.groupBuiltin")
  if (label === "技能") return t("alpha.autocomplete.groupSkills")
  if (label === "项目") return t("alpha.autocomplete.groupProject")
  if (label === "添加") return t("alpha.autocomplete.groupAdd")
  if (label === "文件") return t("alpha.autocomplete.groupFiles")
  if (label === "扩展") return t("alpha.autocomplete.groupExtensions")
  return label
}
