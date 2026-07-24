// timeline-inject — adds a colored TYPE icon to each tool card (opencode renders none), per the
// timeline.html mockup (.tc-ico, color-by-type: read=青 bash=黑 edit=绿 write=蓝 task=琥珀 web=天蓝
// skill=橙 search/mcp=紫). Type is detected from opencode's own structural hooks (write-tool /
// edit-tool / apply-patch-tool / task-tool-card / bash-output / exa-tool-output) + the skill
// agent-title class — NO i18n/title coupling. Unknown tools fall back to a neutral glyph. A debounced
// MutationObserver re-decorates after the timeline streams in; idempotent via a marker attr.
//
// The same observer also drives three timeline-overhaul injects: TL-05 slash-chip type label
// (运行命令 · name + the user's OWN args), TL-17 bash
// exit-code badge, TL-34 turn divider — each building only DOM elements; styling is CSS-side.
// FLAG (TL-17): opencode keeps the bash exit code in metadata.exit and never renders it, and does not
// error on a non-zero exit, so the code is unrecoverable from the DOM — a completed bash is badged
// 退出 0 (matches the design); a silently non-zero command (grep no-match, `test`) is mislabeled.

import { onCleanup, onMount } from "solid-js"

const COLORS: Record<string, string> = {
  read: "#0891b2",
  bash: "#18181b",
  edit: "#16a34a",
  write: "#2563eb",
  task: "#d97706",
  web: "#0ea5e9",
  skill: "#f6821f",
  search: "#7c3aed",
  generic: "#7c3aed",
}

// inner SVG markup per type (1.8 stroke, white on the colored chip).
const GLYPH: Record<string, string> = {
  read: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="2.5"/>',
  bash: '<path d="M4 17l6-6-6-6"/><path d="M12 19h8"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  write: '<path d="M14.5 4h-9A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V9.5z"/><path d="M14 4v5h6"/>',
  task: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  web: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z"/>',
  skill: '<path d="M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  generic: '<circle cx="12" cy="12" r="2.6"/><path d="M12 4v3M12 17v3M4 12h3M17 12h3"/>',
}

function detect(trigger: HTMLElement): keyof typeof COLORS {
  const wrap = trigger.closest("[data-component='tool-part-wrapper']") ?? trigger
  const has = (c: string) => !!wrap.querySelector(`[data-component='${c}']`)
  if (trigger.querySelector("[data-component='task-tool-card']")) return "task"
  if (has("write-tool") || has("write-trigger")) return "write"
  if (has("edit-tool") || has("edit-trigger") || has("apply-patch-tool")) return "edit"
  if (has("bash-output")) return "bash"
  if (has("exa-tool-output")) return "web"
  if (trigger.querySelector(".agent-title")) return "skill"
  // Title fallback for tools opencode renders with NO structural type hook when collapsed (bash/read/
  // search/web). i18n-coupled but cosmetic + neutral-fallbacked; covers zh + en (the only shipped
  // locales that matter here). Re-verify on upstream i18n changes (ADR-015 merge checklist).
  const title = (trigger.querySelector("[data-slot='basic-tool-tool-title']")?.textContent || "").toLowerCase()
  if (/shell|bash|终端/.test(title)) return "bash"
  if (/read|读取/.test(title)) return "read"
  if (/search|grep|glob|搜索/.test(title)) return "search"
  if (/fetch|web|获取/.test(title)) return "web"
  if (/write|写入/.test(title)) return "write"
  if (/edit|编辑/.test(title)) return "edit"
  return "generic"
}

function decorate(trigger: HTMLElement) {
  if (trigger.hasAttribute("data-alpha-tc-ico")) return
  // Error cards already carry their own ban-sign indicator (tool-error-card-icon); skip so we don't
  // prepend a redundant second (type-guessed) icon next to it.
  if (trigger.closest("[data-kind='tool-error-card']")) return
  trigger.setAttribute("data-alpha-tc-ico", "")
  const type = detect(trigger)
  const ico = document.createElement("span")
  ico.className = "a-tc-ico"
  ico.style.background = COLORS[type]
  ico.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${GLYPH[type]}</svg>`
  const content = (trigger.querySelector("[data-slot='basic-tool-tool-trigger-content']") as HTMLElement | null) ?? trigger
  content.insertBefore(ico, content.firstChild)
}

// context-tool-group (read/grep/glob/list folded together) gets a single cyan "context" icon.
function decorateGroup(trigger: HTMLElement) {
  if (trigger.hasAttribute("data-alpha-tc-ico")) return
  trigger.setAttribute("data-alpha-tc-ico", "")
  const ico = document.createElement("span")
  ico.className = "a-tc-ico"
  ico.style.background = COLORS.read
  ico.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${GLYPH.read}</svg>`
  trigger.insertBefore(ico, trigger.firstChild)
}

const svg = (inner: string, w = 1.8) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`
const EXTERNAL = '<path d="M15 3h6v6M10 14L21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>'

// ① dirgrid REMOVED (#252): upstream now folds read/glob/grep/list outputs into a context-group and
// renders only the title row (no [data-component=tool-output] body), so the directory-grid decoration
// had nothing to attach to — dead path excised (S48 REQ-088 O3 forensics).

// ② "在面板打开" pill on file-product cards (edit/write/apply_patch) → opens opencode's review
// panel by clicking its own header toggle ([aria-controls=review-panel]). File-specific focus is
// not reachable from the DOM layer (needs Solid view().review.openPath) — opening the panel still
// moves the product off the left rail (audit #7/#9). Click is isolated from the accordion toggle.
function openReviewPanel() {
  const btn = document.querySelector<HTMLElement>('[aria-controls="review-panel"]')
  if (!btn || btn.getAttribute("aria-expanded") === "true") return
  btn.click()
}
function decorateFileProduct(trigger: HTMLElement) {
  if (trigger.hasAttribute("data-alpha-openp")) return
  const wrap = trigger.closest("[data-component='tool-part-wrapper']") ?? trigger
  if (!wrap.querySelector("[data-component='write-tool'],[data-component='edit-tool'],[data-component='apply-patch-tool']"))
    return
  trigger.setAttribute("data-alpha-openp", "")
  const pill = document.createElement("span")
  pill.className = "a-openp"
  pill.setAttribute("role", "button")
  pill.innerHTML = svg(EXTERNAL) + "在面板打开"
  pill.addEventListener("click", (e) => {
    e.stopPropagation()
    e.preventDefault()
    openReviewPanel()
  })
  const content =
    (trigger.querySelector("[data-slot='basic-tool-tool-trigger-content']") as HTMLElement | null) ?? trigger
  content.appendChild(pill)
}

// TL-32 (A) — 本回合改动 card: collapse the inline diff + add 「在面板打开」 → review panel. opencode
// auto-expands a single-file turn-diff INLINE (~744px), blowing up the left rail against the redesign
// goal (file products → 紧凑卡 + 面板). CSS (timeline/structure.css) hides the inline diff-view; here we
// add the panel-open pill on the header. File-specific focus isn't reachable (same limit as
// decorateFileProduct) — the pill opens opencode's review panel. Idempotent via a marker attr.
function decorateDiffSummary(group: HTMLElement) {
  if (group.hasAttribute("data-alpha-diffsum")) return
  group.setAttribute("data-alpha-diffsum", "")
  const header = group.querySelector("[data-slot='session-turn-diffs-header']") as HTMLElement | null
  if (!header) return
  const pill = document.createElement("span")
  pill.className = "a-openp"
  pill.setAttribute("role", "button")
  pill.innerHTML = svg(EXTERNAL) + "在面板打开"
  pill.addEventListener("click", (e) => {
    e.stopPropagation()
    e.preventDefault()
    openReviewPanel()
  })
  header.appendChild(pill)
}

// TL-17 — bash exit-code badge. opencode renders NO exit code anywhere in the DOM: shell.ts keeps it
// in metadata.exit (never printed) and the bash-pre text is only `$ cmd\n\n<output>`. The shell tool
// also does NOT error on a non-zero exit, so a silently-failing command (grep no-match, `test`)
// renders as a normal completed bash — DOM-indistinguishable from success. We therefore follow the
// design + tasks.md heuristic: a COMPLETED non-error bash ⇒ 退出 0 (data-ok=true). Completion is
// detected by the collapsible arrow, which opencode renders only once the tool is no longer pending
// (basic-tool.tsx:246). Tool-level failures (timeout/abort/spawn) become error cards with no
// bash-output — left to opencode's own red error UI, not fabricated here (see header FLAG). The
// .a-exit styling lives in timeline/tools.css (CSS-side); we only build the element + data-ok.
function decorateBashExit(trigger: HTMLElement) {
  if (trigger.hasAttribute("data-alpha-exit")) return
  const wrap = trigger.closest("[data-component='tool-part-wrapper']") ?? trigger
  if (!wrap.querySelector("[data-component='bash-output']")) return // not a bash tool
  if (!trigger.querySelector("[data-slot='collapsible-arrow']")) return // still running → badge later
  trigger.setAttribute("data-alpha-exit", "")
  const badge = document.createElement("span")
  badge.className = "a-exit"
  badge.setAttribute("data-ok", "true")
  badge.textContent = "退出 0"
  const content =
    (trigger.querySelector("[data-slot='basic-tool-tool-trigger-content']") as HTMLElement | null) ?? trigger
  content.appendChild(badge)
}

// ⑦ Slash-command → compact chip. LIVE CAPTURE REMOVED (#251): captureSend read the upstream composer
// at send time, but the user's real input lives in AlphaComposer (REQ-125 C7 起在 seam 会话页直挂,
// send-time capture 走 session-slash-origin typed 登记) — the DOM capture path could never see a
// command again (S48 REQ-088 O2: chip count 0→0).
// What remains is the RENDER half: folds persisted in localStorage (alpha-cmd:<messageID>) keep
// rendering as chips across reloads / app restarts / reopening the session.
type SlashType = "command" | "skill" | "mcp"
type SlashCmd = { name: string; args: string; type: SlashType }
const cmdMsgs = new Map<string, SlashCmd>() // messageID → slash invocation (sticks across re-renders)

// Persist folds by messageID so a /command STAYS a chip across reloads / app restarts / reopening the
// session (it was reverting to full text because the map was memory-only). Keyed on the server msg id.
const CMD_LS = "alpha-cmd:"
try {
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k?.startsWith(CMD_LS)) cmdMsgs.set(k.slice(CMD_LS.length), JSON.parse(localStorage.getItem(k)!) as SlashCmd)
  }
} catch {}

// glyph per slash type (color comes from CSS: command=accent, skill=orange, mcp=purple).
const CHIP_GLYPH: Record<SlashType, string> = {
  command: '<path d="M10 4L6 20"/>',
  skill: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>',
  mcp: '<path d="M4 7l8-4 8 4-8 4z"/><path d="M4 7v10l8 4 8-4V7"/><path d="M12 11v10"/>',
}

// TL-05 — localized type-label prefix shown before the name (timeline.html .cmd-chip .lab). The
// per-kind COLOR comes from CSS (.a-cmd-chip[data-kind=...]); this only supplies the text.
const SLASH_LABEL: Record<SlashType, string> = {
  command: "运行命令 · ",
  skill: "运行技能 · ",
  mcp: "MCP · ",
}

// fold a slash invocation into a chip: [type icon] 运行命令 · name + the user's OWN typed prompt (args).
// NEVER the command's expanded .md template — the chip shows what the user wrote (e.g. "review pr 12"),
// not the doc body. The chip is re-inserted if a Solid re-render drops it; idempotent via the key.
function foldCommand(um: HTMLElement, cmd: SlashCmd) {
  const key = `${cmd.type}:${cmd.name}:${cmd.args}`
  let chip = um.querySelector(":scope > .a-cmd-chip") as HTMLElement | null
  if (chip && um.getAttribute("data-alpha-cmd") === key) return // already folded correctly
  um.setAttribute("data-alpha-cmd", key)
  if (!chip) {
    chip = document.createElement("div")
    chip.className = "a-cmd-chip"
    um.insertBefore(chip, um.firstChild)
  }
  chip.setAttribute("data-kind", cmd.type)
  // [type icon] 「运行命令 · 」 name [args] — TL-05 adds the .lab type-label span before .nm.
  chip.innerHTML =
    `<span class="ic">${svg(CHIP_GLYPH[cmd.type] || CHIP_GLYPH.command)}</span>` +
    `<span class="lab"></span><span class="nm"></span>`
  chip.querySelector(".lab")!.textContent = SLASH_LABEL[cmd.type] || SLASH_LABEL.command
  chip.querySelector(".nm")!.textContent = cmd.name
  if (cmd.args) {
    const a = document.createElement("span")
    a.className = "args"
    a.textContent = cmd.args
    chip.appendChild(a)
  }
  // Strip any stale expand-body / 「查看展开提示词」 left behind by an older build or localStorage entry —
  // the chip never shows the command's .md template, only the command name + the user's own prompt above.
  um.querySelector(":scope > .a-cmd-body")?.remove()
}

function scanCommands() {
  for (const um of document.querySelectorAll<HTMLElement>("[data-component='user-message']")) {
    const id =
      um.closest("[data-message-id]")?.getAttribute("data-message-id") || um.getAttribute("data-timeline-part-id")
    if (!id) continue
    const cmd = cmdMsgs.get(id)
    if (cmd) foldCommand(um, cmd)
  }
}

// TL-34 — turn divider. opencode renders no separator between rounds. A "新一轮" marks a NEW USER
// ROUND, not every assistant step. CRITICAL (2026-06-28 视觉复审):[data-component=session-turn] is
// per-STEP (one session had 22 turns / only 3 user messages), so a divider before every turn produced
// ~20 spurious 「新一轮」 inside a single answer. Correct rule: insert ONLY before a turn that contains a
// user message ([data-component=user-message] = the start of a new round), and skip the FIRST round.
// Self-correcting: removes any stale divider sitting before a non-round (assistant-only) turn. HH:MM
// from the round's own user-message timestamp. CSS → timeline/structure.css.
function turnStamp(turn: HTMLElement): string {
  const t = (turn.querySelector("[data-slot='user-message-meta-tail']")?.textContent || "").trim()
  return /\d{1,2}[:.]\d{2}/.test(t) ? t : "" // accept only a clock-like string; ignore anything else
}
function decorateTurns() {
  const turns = document.querySelectorAll<HTMLElement>("[data-component='session-turn']")
  let seenRound = false
  turns.forEach((turn) => {
    const startsRound = !!turn.querySelector("[data-component='user-message']")
    const prev = turn.previousElementSibling
    const hasDiv = !!(prev && (prev as HTMLElement).classList.contains("a-turn-div"))
    const wantDiv = startsRound && seenRound // divider only before a non-first user round
    if (startsRound) seenRound = true
    if (wantDiv && !hasDiv) {
      const div = document.createElement("div")
      div.className = "a-turn-div"
      const stamp = turnStamp(turn)
      div.textContent = stamp ? `${stamp} · 新一轮` : "新一轮"
      turn.parentElement?.insertBefore(div, turn)
    } else if (!wantDiv && hasDiv) {
      prev!.remove() // stale divider before an assistant-only step → drop it
    }
  })
}

export function TimelineInject() {
  let mo: MutationObserver | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const scan = () => {
    for (const t of document.querySelectorAll<HTMLElement>("[data-component='tool-trigger']")) {
      decorate(t)
      decorateFileProduct(t)
      decorateBashExit(t)
    }
    for (const g of document.querySelectorAll<HTMLElement>("[data-component='context-tool-group-trigger']")) decorateGroup(g)
    for (const d of document.querySelectorAll<HTMLElement>("[data-component='session-turn-diffs-group']")) decorateDiffSummary(d)
    decorateTurns()
    scanCommands()
  }
  const schedule = () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      scan()
    }, 0)
  }
  // #251: the send-time capture listeners (keydown Enter / prompt-submit click → captureSend) are
  // gone — they read the upstream composer while the user's real input lives in AlphaComposer, so
  // they could never capture again. scanCommands() still folds messages recorded in localStorage.
  onMount(() => {
    scan()
    for (const d of [120, 400, 900]) setTimeout(scan, d)
    mo = new MutationObserver(schedule)
    mo.observe(document.body, { childList: true, subtree: true })
  })
  onCleanup(() => {
    mo?.disconnect()
    if (timer) clearTimeout(timer)
  })
  return null
}
