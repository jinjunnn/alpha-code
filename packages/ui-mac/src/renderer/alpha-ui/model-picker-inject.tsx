// ModelPickerInject — decorates opencode's model picker rows with alpha TIER badges (旗舰/高级/标准)
// + cost multiplier, per the approved model-redesign mockup (§ three-tier selector). opencode's
// dialog-select-model can't be edited (ADR-016: reuse the heavy engine, restyle), so we observe the
// popover and append badge nodes to each row. Stable hook (verified live via CDP): each model row is
// a `[data-slot="list-item"][data-key="<provider>:<modelId>"]` button. A debounced MutationObserver
// re-decorates after the list re-renders (search filter recreates rows). Idempotent via a marker attr.

import { onCleanup, onMount } from "solid-js"

type Tier = { cls: "flag" | "pro" | "std"; label: string; mult: string }

// Tier follows the model id. Flagship = the frontier models (×8); premium = strong mid-tier (×3);
// everything else = standard (×1). Matches the mockup's Opus/GPT-5.5=旗舰, Sonnet/Gemini=高级,
// DeepSeek=标准. Heuristic by substring so new gateway models slot in without a hardcoded table.
function tierOf(modelId: string): Tier {
  const id = modelId.toLowerCase()
  if (/opus|gpt-5\.5|gpt-5-pro|grok-4/.test(id)) return { cls: "flag", label: "旗舰", mult: "×8" }
  if (/sonnet|gemini|gpt-5|grok|reasoner|thinking|-r1|glm-4\.6/.test(id)) return { cls: "pro", label: "高级", mult: "×3" }
  return { cls: "std", label: "标准", mult: "×1" }
}

function decorate(row: HTMLElement) {
  if (row.hasAttribute("data-alpha-tier")) return
  const key = row.getAttribute("data-key") || ""
  // data-key = "<provider>:<modelId>"; modelId may itself contain ":" so keep everything after the 1st.
  const modelId = key.includes(":") ? key.slice(key.indexOf(":") + 1) : key
  if (!modelId) return
  row.setAttribute("data-alpha-tier", "")
  const t = tierOf(modelId)
  // The row's first child div is the flex line holding the model name (+ any Free/Latest tags).
  const inner = (row.querySelector(":scope > div") as HTMLElement | null) ?? row
  const badge = document.createElement("span")
  badge.className = `a-mp-tier ${t.cls}`
  badge.textContent = t.label
  const mult = document.createElement("span")
  mult.className = "a-mp-mult"
  mult.textContent = t.mult
  inner.append(badge, mult)
}

export function ModelPickerInject() {
  let mo: MutationObserver | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const scan = () => {
    for (const row of document.querySelectorAll<HTMLElement>("[data-slot='list-item'][data-key]")) decorate(row)
  }
  // setTimeout (not rAF — rAF is throttled when headless/backgrounded, which would skip decoration).
  const schedule = () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      scan()
    }, 0)
  }
  onMount(() => {
    scan()
    for (const d of [80, 250, 600]) setTimeout(scan, d)
    mo = new MutationObserver(schedule)
    mo.observe(document.body, { childList: true, subtree: true })
  })
  onCleanup(() => {
    mo?.disconnect()
    if (timer) clearTimeout(timer)
  })
  return null
}
