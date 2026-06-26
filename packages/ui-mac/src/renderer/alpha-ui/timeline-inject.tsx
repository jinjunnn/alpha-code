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

export function TimelineInject() {
  let mo: MutationObserver | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const scan = () => {
    for (const t of document.querySelectorAll<HTMLElement>("[data-component='tool-trigger']")) decorate(t)
    for (const g of document.querySelectorAll<HTMLElement>("[data-component='context-tool-group-trigger']")) decorateGroup(g)
  }
  const schedule = () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      scan()
    }, 0)
  }
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
