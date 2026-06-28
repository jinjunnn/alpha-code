// timeline-inject — adds a colored TYPE icon to each tool card (opencode renders none), per the
// timeline.html mockup (.tc-ico, color-by-type: read=青 bash=黑 edit=绿 write=蓝 task=琥珀 web=天蓝
// skill=橙 search/mcp=紫). Type is detected from opencode's own structural hooks (write-tool /
// edit-tool / apply-patch-tool / task-tool-card / bash-output / exa-tool-output) + the skill
// agent-title class — NO i18n/title coupling. Unknown tools fall back to a neutral glyph. A debounced
// MutationObserver re-decorates after the timeline streams in; idempotent via a marker attr.

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
const FOLDER = '<path d="M3 7l2-3h5l2 3h7v11H3z"/>'
const FILE = '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>'
const EXTERNAL = '<path d="M15 3h6v6M10 14L21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>'

// ① Directory listing → file grid. opencode renders a dir read/list as raw `<Markdown>` inside
// [data-component=tool-output]: a flat newline list + a "(N entries)" footer (read.ts <entries>).
// Guarded HARD so glob/grep outputs (which share tool-output but have NO footer) are never touched;
// non-destructive (hide originals + append) so we don't tear out Solid-owned nodes. Idempotent.
function decorateDirOutput(out: HTMLElement) {
  if (out.hasAttribute("data-alpha-dirgrid")) return
  let entries: string[] = []
  let total = 0
  try {
    const raw = out.textContent || ""
    const foot = raw.match(/\((?:Showing\s+\d+\s+of\s+)?(\d+)\s+entries/)
    if (!foot) return // not a directory listing → leave as-is
    total = parseInt(foot[1], 10)
    // Prefer the <entries> element (clean, newline-separated). If markdown stripped it, bail safely.
    const src = out.querySelector("entries")?.textContent || ""
    if (!src) return
    entries = src
      .split("\n")
      .map((s) => s.trim())
      .filter((l) => l && !l.startsWith("(")) // drop the "(N entries)" footer line
    if (!entries.length) return
  } catch {
    return
  }
  out.setAttribute("data-alpha-dirgrid", "")
  const grid = document.createElement("div")
  grid.className = "a-dirgrid"
  for (const name of entries) {
    const isDir = name.endsWith("/")
    const it = document.createElement("span")
    it.className = "it " + (isDir ? "dir" : "file")
    it.innerHTML = svg(isDir ? FOLDER : FILE, 1.7)
    it.appendChild(document.createTextNode(name))
    grid.appendChild(it)
  }
  const count = document.createElement("div")
  count.className = "a-dircount"
  count.textContent = `共 ${total} 项`
  for (const c of Array.from(out.children)) (c as HTMLElement).style.display = "none"
  out.appendChild(grid)
  out.appendChild(count)
}

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

// ⑦ Slash-command → compact chip (FUTURE commands only — per the user's call). opencode discards the
// command name when it expands /init server-side (UserMessage carries no `command` field; the rendered
// DOM has no marker), so a command can't be recovered after the fact. Instead we CAPTURE it at SEND time
// — the composer text is still "/init" right before opencode expands it — then fold the very next user
// message that appears into a chip. Reliable for live commands, zero upstream edits (ADR-016 kept).
type SlashType = "command" | "skill" | "mcp"
type SlashCmd = { name: string; args: string; type: SlashType }
let pendingCmd: (SlashCmd & { t: number }) | null = null
const cmdMsgs = new Map<string, SlashCmd>() // messageID → slash invocation (sticks across re-renders)
const seenMsgs = new Set<string>() // user messages already present (so we never fold history on load)
const slashTypeMap = new Map<string, SlashType>() // trigger → type, learned live from the / popover

// Persist folds by messageID so a /command STAYS a chip across reloads / app restarts / reopening the
// session (it was reverting to full text because the map was memory-only). Keyed on the server msg id.
const CMD_LS = "alpha-cmd:"
try {
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k?.startsWith(CMD_LS)) cmdMsgs.set(k.slice(CMD_LS.length), JSON.parse(localStorage.getItem(k)!) as SlashCmd)
  }
} catch {}
function rememberCmd(id: string, cmd: SlashCmd) {
  cmdMsgs.set(id, cmd)
  try {
    localStorage.setItem(CMD_LS + id, JSON.stringify(cmd))
  } catch {}
}

// glyph per slash type (color comes from CSS: command=accent, skill=orange, mcp=purple).
const CHIP_GLYPH: Record<SlashType, string> = {
  command: '<path d="M10 4L6 20"/>',
  skill: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>',
  mcp: '<path d="M4 7l8-4 8 4-8 4z"/><path d="M4 7v10l8 4 8-4V7"/><path d="M12 11v10"/>',
}

// learn each slash item's type from the live "/" popover — items carry a 技能/MCP badge; else command.
function scanSlashMenu() {
  for (const it of document.querySelectorAll<HTMLElement>("[data-slash-id]")) {
    const trig = (it.querySelector("span")?.textContent || it.getAttribute("data-slash-id") || "")
      .replace(/^\//, "")
      .trim()
      .toLowerCase()
    if (!trig) continue
    let type: SlashType = "command"
    for (const s of it.querySelectorAll("span")) {
      const t = (s.textContent || "").trim()
      if (t === "技能" || /^skill$/i.test(t)) { type = "skill"; break }
      if (/^mcp$/i.test(t)) { type = "mcp"; break }
    }
    slashTypeMap.set(trig, type)
  }
}

// read the composer the instant before a send fires (capture phase, before it clears).
function captureSend() {
  const composer = document.querySelector("[data-component=session-composer],[data-component=session-new-composer]")
  const input = composer?.querySelector("[contenteditable], textarea, input") as HTMLInputElement | null
  const txt = ((input?.value ?? input?.textContent) || "").trim()
  const m = txt.match(/^\/([a-z0-9][\w-]*)\s*([\s\S]*)$/i)
  if (!m) return
  const name = m[1].toLowerCase()
  pendingCmd = { name, args: (m[2] || "").trim(), type: slashTypeMap.get(name) || "command", t: Date.now() }
}

// fold a slash invocation into a chip: [type icon] name + the user's typed prompt. Never the full text.
// The body is hidden via CSS keyed on the data-alpha-cmd marker (NOT inline display:none) so it stays
// hidden even when Solid re-renders the body element. The chip is re-inserted if a re-render drops it.
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
  chip.innerHTML = `<span class="ic">${svg(CHIP_GLYPH[cmd.type] || CHIP_GLYPH.command)}</span><span class="nm"></span>`
  chip.querySelector(".nm")!.textContent = cmd.name
  if (cmd.args) {
    const a = document.createElement("span")
    a.className = "args"
    a.textContent = cmd.args
    chip.appendChild(a)
  }
}

function scanCommands() {
  scanSlashMenu()
  for (const um of document.querySelectorAll<HTMLElement>("[data-component='user-message']")) {
    const id =
      um.closest("[data-message-id]")?.getAttribute("data-message-id") || um.getAttribute("data-timeline-part-id")
    if (!id) continue
    if (!seenMsgs.has(id)) {
      seenMsgs.add(id)
      // brand-new message right after a slash send → it's that invocation's expansion
      if (pendingCmd && Date.now() - pendingCmd.t < 8000) {
        const txt = (um.querySelector("[data-slot='user-message-body']")?.textContent || "").trim()
        if (!txt.startsWith("/" + pendingCmd.name)) {
          const { name, args, type } = pendingCmd
          rememberCmd(id, { name, args, type }) // expanded ⇒ a real slash invocation; persist it
        }
        pendingCmd = null
      }
    }
    const cmd = cmdMsgs.get(id)
    if (cmd) foldCommand(um, cmd)
  }
}

export function TimelineInject() {
  let mo: MutationObserver | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const scan = () => {
    for (const t of document.querySelectorAll<HTMLElement>("[data-component='tool-trigger']")) {
      decorate(t)
      decorateFileProduct(t)
    }
    for (const g of document.querySelectorAll<HTMLElement>("[data-component='context-tool-group-trigger']")) decorateGroup(g)
    for (const o of document.querySelectorAll<HTMLElement>("[data-component='tool-output']")) decorateDirOutput(o)
    scanCommands()
  }
  const schedule = () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      scan()
    }, 0)
  }
  // capture a slash command at SEND time (Enter without shift, or a click on the send button), before
  // opencode clears the composer and expands it. scanCommands() then folds the resulting message.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) captureSend()
  }
  const onClick = (e: MouseEvent) => {
    const t = e.target as HTMLElement
    const slash = t?.closest?.("[data-slash-id]") // picking a command from the slash popover
    if (slash) {
      const name = (slash.querySelector("span")?.textContent || slash.getAttribute("data-slash-id") || "")
        .replace(/^\//, "")
        .trim()
        .toLowerCase()
      if (name) pendingCmd = { name, args: "", type: slashTypeMap.get(name) || "command", t: Date.now() }
      return
    }
    if (t?.closest?.("[data-action=prompt-submit]")) captureSend()
  }
  onMount(() => {
    scan()
    for (const d of [120, 400, 900]) setTimeout(scan, d)
    mo = new MutationObserver(schedule)
    mo.observe(document.body, { childList: true, subtree: true })
    document.addEventListener("keydown", onKey, true)
    document.addEventListener("click", onClick, true)
  })
  onCleanup(() => {
    mo?.disconnect()
    if (timer) clearTimeout(timer)
    document.removeEventListener("keydown", onKey, true)
    document.removeEventListener("click", onClick, true)
  })
  return null
}
