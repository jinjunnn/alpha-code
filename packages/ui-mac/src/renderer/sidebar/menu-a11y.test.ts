import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { dismissMenu, dismissMenuOnEscape, focusFirstMenuItem } from "./menu-a11y"

beforeAll(() => GlobalRegistrator.register())
beforeEach(() => document.body.replaceChildren())
afterAll(() => GlobalRegistrator.unregister())

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
}

describe("sidebar menu accessibility behavior", () => {
  test("open focuses the first item and Escape closes with trigger focus restored", async () => {
    const trigger = document.createElement("button")
    const menu = document.createElement("div")
    const first = document.createElement("button")
    const second = document.createElement("button")
    menu.setAttribute("role", "menu")
    first.setAttribute("role", "menuitem")
    second.setAttribute("role", "menuitem")
    menu.append(first, second)
    document.body.append(trigger, menu)
    trigger.focus()

    focusFirstMenuItem(menu)
    await flush()
    expect(document.activeElement).toBe(first)

    menu.addEventListener("keydown", (event) => dismissMenuOnEscape(event, () => menu.remove(), trigger))
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    first.dispatchEvent(escape)
    await flush()

    expect(escape.defaultPrevented).toBe(true)
    expect(menu.isConnected).toBe(false)
    expect(document.activeElement).toBe(trigger)
  })

  test("project and session menus both use the focus and Escape behavior", async () => {
    const source = await Bun.file(new URL("./alpha-sidebar.tsx", import.meta.url)).text()
    expect(source.match(/ref=\{focusFirstMenuItem\}/g)).toHaveLength(2)
    expect(source.match(/onKeyDown=\{\(event\) => dismissMenuOnEscape/g)).toHaveLength(2)
    expect(source.match(/dismissMenu\(\(\) => setMenuFor\(null\), projectMenuTrigger\)/g)).toHaveLength(3)
    expect(source.match(/dismissMenu\(\(\) => setSessionMenu\(null\), sessionMenuTrigger\)/g)).toHaveLength(4)
  })

  test("activating a menu item closes the menu and restores trigger focus", async () => {
    const trigger = document.createElement("button")
    const menu = document.createElement("div")
    const item = document.createElement("button")
    menu.setAttribute("role", "menu")
    item.setAttribute("role", "menuitem")
    menu.append(item)
    document.body.append(trigger, menu)

    focusFirstMenuItem(menu)
    await flush()
    expect(document.activeElement).toBe(item)

    item.addEventListener("click", () => dismissMenu(() => menu.remove(), trigger))
    item.click()
    await flush()

    expect(menu.isConnected).toBe(false)
    expect(document.activeElement).toBe(trigger)
  })
})
