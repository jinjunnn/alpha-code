import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { relative } from "node:path"
import { rovingKey, rovingTabIndex } from "./roving-focus"

const alphaUi = import.meta.dir

beforeAll(() => GlobalRegistrator.register())
beforeEach(() => document.body.replaceChildren())
afterAll(() => GlobalRegistrator.unregister())

function press(key: string) {
  return new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
}

function drive(key: string, items: readonly string[], active: string | undefined) {
  const event = press(key)
  let landed: string | undefined
  rovingKey(event, items, active, (item) => (landed = item))
  return { landed, prevented: event.defaultPrevented }
}

describe("roving focus key table", () => {
  const items = ["a", "b", "c"]

  test("both axes move to the neighbour and wrap; Home/End jump to the ends", () => {
    expect(drive("ArrowRight", items, "a")).toEqual({ landed: "b", prevented: true })
    expect(drive("ArrowDown", items, "a")).toEqual({ landed: "b", prevented: true })
    expect(drive("ArrowLeft", items, "a")).toEqual({ landed: "c", prevented: true })
    expect(drive("ArrowUp", items, "a")).toEqual({ landed: "c", prevented: true })
    expect(drive("ArrowRight", items, "c")).toEqual({ landed: "a", prevented: true })
    expect(drive("Home", items, "c")).toEqual({ landed: "a", prevented: true })
    expect(drive("End", items, "a")).toEqual({ landed: "c", prevented: true })
  })

  test("non-navigation keys pass through untouched — the group never swallows Tab/Escape/typing", () => {
    for (const key of ["Tab", "Escape", "Enter", " ", "x", "PageDown"]) {
      expect(drive(key, items, "a")).toEqual({ landed: undefined, prevented: false })
    }
  })

  test("an empty group and an active item outside the group both fail closed to a sane landing", () => {
    expect(drive("ArrowRight", [], "a")).toEqual({ landed: undefined, prevented: false })
    expect(drive("End", [], undefined)).toEqual({ landed: undefined, prevented: false })
    // Active not in the list (a disabled tab was filtered out) or absent: count from the first item.
    expect(drive("ArrowRight", items, "gone")).toEqual({ landed: "b", prevented: true })
    expect(drive("ArrowRight", items, undefined)).toEqual({ landed: "b", prevented: true })
  })

  test("a single-item group stays on that item instead of losing focus", () => {
    expect(drive("ArrowRight", ["only"], "only")).toEqual({ landed: "only", prevented: true })
    expect(drive("End", ["only"], "only")).toEqual({ landed: "only", prevented: true })
  })

  test("roving tab index leaves exactly one landing point in the tab sequence", () => {
    expect(["a", "b", "c"].map((item) => rovingTabIndex(item === "b"))).toEqual([-1, 0, -1])
  })
})

describe("roving focus over a real composite widget", () => {
  // Wiring shape every call site uses: arrow selects the neighbour AND moves DOM focus there,
  // and the group keeps exactly one element in the Tab sequence.
  function radiogroup(labels: readonly string[]) {
    const group = document.createElement("div")
    group.setAttribute("role", "radiogroup")
    let active = labels[0]!
    const render = () =>
      labels.forEach((label, index) => {
        const button = group.children[index] as HTMLButtonElement
        button.setAttribute("aria-checked", String(label === active))
        button.tabIndex = rovingTabIndex(label === active)
      })
    labels.forEach((label) => {
      const button = document.createElement("button")
      button.setAttribute("role", "radio")
      button.id = `radio-${label}`
      button.textContent = label
      button.addEventListener("keydown", (event) =>
        rovingKey(event, labels, active, (next) => {
          active = next
          render()
          document.getElementById(`radio-${next}`)?.focus()
        }),
      )
      group.append(button)
    })
    render()
    document.body.append(group)
    return group
  }

  test("arrow keys select and carry DOM focus; only the checked radio stays tabbable", () => {
    const group = radiogroup(["yes", "no", "maybe"])
    const button = (label: string) => group.querySelector<HTMLButtonElement>(`#radio-${label}`)!

    button("yes").focus()
    expect(group.querySelectorAll("[tabindex='0']")).toHaveLength(1)

    button("yes").dispatchEvent(press("ArrowDown"))
    expect(document.activeElement).toBe(button("no"))
    expect(button("no").getAttribute("aria-checked")).toBe("true")
    expect(button("yes").getAttribute("aria-checked")).toBe("false")
    expect(group.querySelectorAll("[tabindex='0']")).toHaveLength(1)

    button("no").dispatchEvent(press("End"))
    expect(document.activeElement).toBe(button("maybe"))
    expect(button("maybe").tabIndex).toBe(0)
    expect(button("yes").tabIndex).toBe(-1)
  })
})

describe("alpha-ui composite-role ratchet", () => {
  // C21 AC2 类边界:声明复合 role 就欠下键盘契约。APG 认的实现只有两条 ——
  // ① roving tabIndex(焦点真的在项上移动)= 本仓的 roving-focus;
  // ② aria-activedescendant(焦点留在输入框,活动项由 id 指认)= combobox 拥有的 listbox,
  //    composer-autocomplete 走这条,已由 composer-a11y.test.ts 断言。
  // 新面板既不接第一条也不走第二条时,这条闸门先红 —— 防的是「声明了 role 却什么都没兑现」。
  const COMPOSITE_ROLES = ["tablist", "tree", "radiogroup", "listbox"]
  const CONTRACTS: Array<[string, (source: string) => boolean]> = [
    ["roving-focus", (source) => /from "[./]*roving-focus"/.test(source)],
    ["aria-activedescendant", (source) => source.includes("activeDescendant")],
  ]

  // 注释里可以指名 role(降级记录、勘破笔记),约束的是代码。
  // 先删行注释再删块注释:行注释里出现的 `/*`(如路径 `runs/*`)会与后文的 `*/` 错误配对,
  // 把中间整段真代码一起吃掉 —— 那会让闸门对整个文件失明。
  const code = (source: string) =>
    source
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "")

  function declaredCompositeRoles(source: string) {
    const declarations = [...code(source).matchAll(/role=(?:"[^"]*"|\{[^}]*\})/g)].map((match) => match[0])
    return COMPOSITE_ROLES.filter((role) => declarations.some((declaration) => declaration.includes(`"${role}"`)))
  }

  test("the detector reads role= declarations only, in both literal and expression form", () => {
    expect(declaredCompositeRoles(`<div role="tablist">`)).toEqual(["tablist"])
    expect(declaredCompositeRoles(`<div role={multiple ? "group" : "radiogroup"}>`)).toEqual(["radiogroup"])
    // Not a role declaration, not a composite role, and not code: none may drag a file into the gate.
    expect(declaredCompositeRoles(`<button aria-haspopup="listbox">`)).toEqual([])
    expect(declaredCompositeRoles(`<div role="list"><button role="listitem" />`)).toEqual([])
    expect(declaredCompositeRoles(` * 曾声明 role="tree",已降级为 role="list"`)).toEqual([])
    expect(declaredCompositeRoles(`// role="tablist" 的历史记录`)).toEqual([])
    expect(declaredCompositeRoles(`{/* role="tree" 的历史记录 */}`)).toEqual([])
    // 行注释里的 `/*` 不得吃掉后面的真代码,否则整文件对闸门隐形。
    expect(declaredCompositeRoles(`// 遍历 runs/*\n<div role="tablist">\n{/* 尾注 */}`)).toEqual(["tablist"])
  })

  test("every file declaring tablist/tree/radiogroup/listbox wires one of the two keyboard contracts", async () => {
    const paths = await Array.fromAsync(new Bun.Glob("**/*.tsx").scan({ cwd: alphaUi, absolute: true }))
    const offenders: string[] = []
    for (const path of paths.sort()) {
      const source = code(await Bun.file(path).text())
      const roles = declaredCompositeRoles(source)
      if (roles.length === 0) continue
      const contract = CONTRACTS.find(([, wired]) => wired(source))
      if (contract === undefined) {
        offenders.push(`${relative(alphaUi, path)}: ${roles.join(", ")} —— 未接任何键盘契约`)
        continue
      }
      // 接了 roving-focus 就得两头都用:只 import 不用、或只给 tabIndex 不给键位,
      // 组内要么没有方向键、要么留下一串 Tab 落点 —— 两种都是这张票在修的那类缺陷。
      if (contract[0] !== "roving-focus") continue
      const missing = ["rovingKey(", "rovingTabIndex("].filter((symbol) => !source.includes(symbol))
      if (missing.length > 0) offenders.push(`${relative(alphaUi, path)}: 只用了半套 roving-focus(缺 ${missing.join(" ")})`)
    }

    expect(offenders).toEqual([])
  })
})
