import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { relative } from "node:path"
import { rovingKey, rovingTabIndex, type RovingKeyTable } from "./roving-focus"

const alphaUi = import.meta.dir

beforeAll(() => GlobalRegistrator.register())
beforeEach(() => document.body.replaceChildren())
afterAll(() => GlobalRegistrator.unregister())

function press(key: string, init: KeyboardEventInit = {}) {
  return new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })
}

function drive(table: RovingKeyTable, key: string, items: readonly string[], active: string | undefined, init?: KeyboardEventInit) {
  const event = press(key, init)
  let landed: string | undefined
  rovingKey(event, table, items, active, (item) => (landed = item))
  return { landed, prevented: event.defaultPrevented }
}

const IGNORED = { landed: undefined, prevented: false }

describe("roving focus key table", () => {
  const items = ["a", "b", "c"]

  test("horizontal tabs move on ←→ and jump with Home/End — and leave ↑↓ to the page", () => {
    expect(drive("horizontal-tabs", "ArrowRight", items, "a")).toEqual({ landed: "b", prevented: true })
    expect(drive("horizontal-tabs", "ArrowLeft", items, "a")).toEqual({ landed: "c", prevented: true })
    expect(drive("horizontal-tabs", "ArrowRight", items, "c")).toEqual({ landed: "a", prevented: true })
    expect(drive("horizontal-tabs", "Home", items, "c")).toEqual({ landed: "a", prevented: true })
    expect(drive("horizontal-tabs", "End", items, "a")).toEqual({ landed: "c", prevented: true })
    // W3C Tabs Pattern:上下键只属于 aria-orientation="vertical" 的 tablist。本仓四条页签条
    // 都是横排 flex,吞掉 ↑↓ 就是把页面滚动抢走 —— 必须原样放行。
    expect(drive("horizontal-tabs", "ArrowDown", items, "a")).toEqual(IGNORED)
    expect(drive("horizontal-tabs", "ArrowUp", items, "a")).toEqual(IGNORED)
  })

  test("radio moves on both axes — and never lets Home/End rewrite the answer", () => {
    expect(drive("radio", "ArrowRight", items, "a")).toEqual({ landed: "b", prevented: true })
    expect(drive("radio", "ArrowDown", items, "a")).toEqual({ landed: "b", prevented: true })
    expect(drive("radio", "ArrowLeft", items, "a")).toEqual({ landed: "c", prevented: true })
    expect(drive("radio", "ArrowUp", items, "a")).toEqual({ landed: "c", prevented: true })
    // W3C Radio Group Pattern 没有 Home/End。「移动即选中」下,一个未定义的键改掉用户已选的项
    // 是数据损失 —— 放行,不是改选到两端。
    expect(drive("radio", "Home", items, "b")).toEqual(IGNORED)
    expect(drive("radio", "End", items, "b")).toEqual(IGNORED)
  })

  test("a modified arrow belongs to the system, not to the group", () => {
    // macOS 的 VoiceOver 光标就是 Ctrl+Option(=ctrlKey+altKey)+ 方向键;Cmd+← 是导航;
    // 吞掉任何一种都等于把读屏 / 系统快捷键用户锁在这个控件里。
    for (const table of ["horizontal-tabs", "radio"] as const) {
      for (const modifier of ["ctrlKey", "altKey", "metaKey", "shiftKey"] as const) {
        expect(drive(table, "ArrowRight", items, "a", { [modifier]: true })).toEqual(IGNORED)
        expect(drive(table, "ArrowLeft", items, "a", { [modifier]: true })).toEqual(IGNORED)
      }
      expect(drive(table, "ArrowRight", items, "a", { ctrlKey: true, altKey: true })).toEqual(IGNORED)
    }
    expect(drive("horizontal-tabs", "Home", items, "c", { metaKey: true })).toEqual(IGNORED)
  })

  test("keys pressed while the IME is composing select candidates, not group items", () => {
    for (const table of ["horizontal-tabs", "radio"] as const) {
      expect(drive(table, "ArrowRight", items, "a", { isComposing: true })).toEqual(IGNORED)
      expect(drive(table, "ArrowLeft", items, "a", { isComposing: true })).toEqual(IGNORED)
    }
  })

  test("non-navigation keys pass through untouched — the group never swallows Tab/Escape/typing", () => {
    for (const table of ["horizontal-tabs", "radio"] as const) {
      for (const key of ["Tab", "Escape", "Enter", " ", "x", "PageDown"]) {
        expect(drive(table, key, items, "a")).toEqual(IGNORED)
      }
    }
  })

  test("an empty group and an active item outside the group both fail closed to a sane landing", () => {
    expect(drive("horizontal-tabs", "ArrowRight", [], "a")).toEqual(IGNORED)
    expect(drive("horizontal-tabs", "End", [], undefined)).toEqual(IGNORED)
    // Active not in the list (a disabled tab was filtered out) or absent: count from the first item.
    expect(drive("horizontal-tabs", "ArrowRight", items, "gone")).toEqual({ landed: "b", prevented: true })
    expect(drive("radio", "ArrowDown", items, undefined)).toEqual({ landed: "b", prevented: true })
  })

  test("a single-item group stays on that item instead of losing focus", () => {
    expect(drive("horizontal-tabs", "ArrowRight", ["only"], "only")).toEqual({ landed: "only", prevented: true })
    expect(drive("horizontal-tabs", "End", ["only"], "only")).toEqual({ landed: "only", prevented: true })
    expect(drive("radio", "ArrowDown", ["only"], "only")).toEqual({ landed: "only", prevented: true })
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
        rovingKey(event, "radio", labels, active, (next) => {
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

    button("no").dispatchEvent(press("ArrowRight"))
    expect(document.activeElement).toBe(button("maybe"))
    expect(button("maybe").tabIndex).toBe(0)
    expect(button("yes").tabIndex).toBe(-1)

    // Home 不在 radio 键表里:选择不动,事件交还给外层。
    const home = press("Home")
    button("maybe").dispatchEvent(home)
    expect(home.defaultPrevented).toBe(false)
    expect(button("maybe").getAttribute("aria-checked")).toBe("true")
  })
})

// ── C21 AC2 类边界闸门 ──────────────────────────────────────────────────────────────
// 声明复合 role 就欠下键盘契约。APG 认的实现只有两条 ——
// ① roving tabIndex(焦点真的在项上移动)= 本仓的 roving-focus;
// ② aria-activedescendant(焦点留在输入框,活动项由 id 指认)= combobox 拥有的 listbox。
// 闸门按**声明逐条计数**,不按文件认领:同一文件里已经接好一个 tablist,不足以让第二个
// 裸控件蒙混过关 —— 那正是「文件级」判据放过的那类回归。
const COMPOSITE_ROLES = ["tablist", "tree", "radiogroup", "listbox"]

// 注释里可以指名 role(降级记录、勘破笔记),约束的是代码。
// 先删行注释再删块注释:行注释里出现的 `/*`(如路径 `runs/*`)会与后文的 `*/` 错误配对,
// 把中间整段真代码一起吃掉 —— 那会让闸门对整个文件失明。
const code = (source: string) =>
  source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")

/** 每条 `role=` 声明各自计一次:两个 radiogroup = 两条,要两套接线。 */
function declaredCompositeRoles(source: string) {
  const declarations = [...code(source).matchAll(/role=(?:"[^"]*"|\{[^}]*\})/g)].map((match) => match[0])
  return declarations.flatMap((declaration) => COMPOSITE_ROLES.filter((role) => declaration.includes(`"${role}"`)))
}

/**
 * 一套接线 =
 * ① 一个 `rovingKey(` 调用 + 一个 `rovingTabIndex(` 调用 —— 缺一头就要么没方向键、要么留下
 *    一串 Tab 落点,所以取两者的较小值;
 * ② 一个真的 `aria-activedescendant` 属性。
 *
 * 只认这两样。曾经还有第三条「活动项访问器 + `role="option"` + `id={`」的全仓通兑规则,已删:
 * 三个字面量分别出现不等于它们互相关联,`const activeDescendant = () => undefined` 配上
 * `<div role="option" id={Date.now()} />` 就能凑齐 —— 恒 undefined 的访问器、每帧都变的 id、
 * 零键盘契约,却被判成已接线。跨文件的 combobox 改由下面的具名限额例外承接。
 */
function keyboardContractBindings(source: string) {
  const stripped = code(source)
  const count = (pattern: RegExp) => (stripped.match(pattern) ?? []).length
  const rovingKeys = count(/\brovingKey\(/g)
  const rovingTabIndexes = count(/\brovingTabIndex\(/g)
  const activeDescendants = count(/aria-activedescendant=/g)
  return { rovingKeys, rovingTabIndexes, activeDescendants, total: Math.min(rovingKeys, rovingTabIndexes) + activeDescendants }
}

/**
 * 跨文件 combobox 的**限额例外**:按文件逐个开,每条写明额度与兑现证据。全仓只有一条 ——
 * `composer-autocomplete.tsx` 的 listbox 走 APG 的另一条合法实现(combobox 的
 * `aria-activedescendant`):属性挂在输入框那一侧(alpha-composer.tsx),listbox 在这一侧,
 * 所以本文件的源码里永远不会出现那个属性,静态文本无从自证。
 *
 * 例外的正确性不由源码文本背书,由真实挂载测试背书:composer-a11y.test.ts 的
 * 「combobox expanded state and active descendant track ArrowDown and ArrowUp」按下 ↑↓ 后读回
 * `aria-activedescendant`,断言它指向的元素确实在这个 listbox 内、`role="option"`、
 * `aria-selected="true"`,并在 Escape 后消失 —— 可执行判据,不是字面量计数。
 *
 * 额度写死为 1:这个文件里再多一个复合控件,闸门照样红。
 */
const CROSS_FILE_COMBOBOX_EXCEPTIONS: Readonly<Record<string, number>> = {
  "composer-autocomplete.tsx": 1,
}

export function compositeRoleOffender(label: string, source: string) {
  const roles = declaredCompositeRoles(source)
  if (roles.length === 0) return undefined
  const bindings = keyboardContractBindings(source)
  const exception = CROSS_FILE_COMBOBOX_EXCEPTIONS[label] ?? 0
  const total = bindings.total + exception
  if (total >= roles.length) return undefined
  return (
    `${label}: 声明了 ${roles.length} 处复合 role(${roles.join(", ")}),只接上 ${total} 套键盘契约` +
    `(rovingKey ×${bindings.rovingKeys} / rovingTabIndex ×${bindings.rovingTabIndexes} / aria-activedescendant ×${bindings.activeDescendants}` +
    (exception ? ` / 跨文件 combobox 例外 ×${exception}` : "") +
    `)`
  )
}

describe("alpha-ui composite-role ratchet", () => {
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
    // 逐条计数:同一文件的第二个复合控件必须自己出现在清单里。
    expect(declaredCompositeRoles(`<div role="tablist">…<div role="radiogroup">`)).toEqual(["tablist", "radiogroup"])
  })

  test("a second bare widget in an already-wired file is red", () => {
    const wired = `import { rovingKey, rovingTabIndex } from "./roving-focus"
      <div role="tablist"><button tabIndex={rovingTabIndex(on)} onKeyDown={(e) => rovingKey(e, "horizontal-tabs", items, active, pick)} /></div>`
    expect(compositeRoleOffender("wired.tsx", wired)).toBeUndefined()
    // 同一文件再加一个完全没有键盘处理的 radiogroup:文件级判据会绿,逐声明计数必须红。
    const second = `${wired}\n<div role="radiogroup"><button role="radio" /></div>`
    expect(compositeRoleOffender("second.tsx", second)).toContain("声明了 2 处复合 role")
    expect(compositeRoleOffender("second.tsx", second)).toContain("只接上 1 套")
  })

  test("half a roving wiring is not a wiring", () => {
    const onlyTabIndex = `import { rovingKey, rovingTabIndex } from "./roving-focus"
      <div role="tablist"><button tabIndex={rovingTabIndex(on)} /></div>`
    expect(compositeRoleOffender("half.tsx", onlyTabIndex)).toContain("rovingTabIndex ×1")
    const onlyKey = `<div role="tablist" onKeyDown={(e) => rovingKey(e, "horizontal-tabs", items, active, pick)} />`
    expect(compositeRoleOffender("half.tsx", onlyKey)).toContain("只接上 0 套")
  })

  test("an unrelated activeDescendant identifier cannot launder a bare listbox", () => {
    // 有访问器、选项却没有 id:aria-activedescendant 将来指不到任何东西 —— 不算兑现。
    const decoy = `const activeDescendant = () => rows()[0]?.id\n<div role="listbox"><div role="option" /></div>`
    expect(compositeRoleOffender("decoy.tsx", decoy)).toContain("只接上 0 套")
    // 上一版第三 arm 的反例:三个字面量凑齐,访问器恒 undefined、id 每帧都变、零键盘契约。
    const forgery = `const activeDescendant = () => undefined\n<div role="listbox"><div role="option" id={Date.now()} /></div>`
    expect(compositeRoleOffender("forgery.tsx", forgery)).toContain("只接上 0 套")
    // 连白名单文件的真实形态,换个文件名照样红 —— 兑现证据不在源码文本里。
    const combobox = `const activeDescendant = createMemo(() => optionId(items()[active()]))
      <div id={listboxId} role="listbox"><button id={optionId(item)} role="option" /></div>`
    expect(compositeRoleOffender("copycat.tsx", combobox)).toContain("只接上 0 套")
    // 同一文件既挂属性又开 listbox:直接认。
    const attribute = `<textarea aria-activedescendant={auto.activeDescendant()} />\n<div role="listbox" />`
    expect(compositeRoleOffender("attribute.tsx", attribute)).toBeUndefined()
  })

  test("the cross-file combobox exception is one named file, capped at one widget", () => {
    const listbox = `<div id={listboxId} role="listbox"><button id={optionId(item)} role="option" /></div>`
    // 例外按文件名开,且只开给它一处:真实性由 composer-a11y.test.ts 的真实挂载测试背书。
    expect(compositeRoleOffender("composer-autocomplete.tsx", listbox)).toBeUndefined()
    // 同名文件换个目录、或任何别的文件,都拿不到这个额度(例外不是恒真)。
    expect(compositeRoleOffender("session-workspace/composer-autocomplete.tsx", listbox)).toContain("只接上 0 套")
    // 额度 1:白名单文件里的第二个复合控件必须自己接线。
    expect(compositeRoleOffender("composer-autocomplete.tsx", `${listbox}\n<div role="radiogroup" />`)).toContain("只接上 1 套")
    // 白名单也挡不住上面那条伪造形态:例外只给一个额度,第二个控件照样红。
    const forged = `const activeDescendant = () => undefined
      <div role="listbox"><div role="option" id={Date.now()} /></div>
      <div role="listbox" />`
    expect(compositeRoleOffender("composer-autocomplete.tsx", forged)).toContain("只接上 1 套")
  })

  test("a file with no composite role is not dragged into the gate at all", () => {
    expect(compositeRoleOffender("plain.tsx", `<div role="list"><div role="listitem" /></div>`)).toBeUndefined()
  })

  test("every alpha-ui composite-role declaration wires one of the two keyboard contracts", async () => {
    const paths = await Array.fromAsync(new Bun.Glob("**/*.tsx").scan({ cwd: alphaUi, absolute: true }))
    const offenders: string[] = []
    for (const path of paths.sort()) {
      const offender = compositeRoleOffender(relative(alphaUi, path), await Bun.file(path).text())
      if (offender) offenders.push(offender)
    }
    expect(offenders).toEqual([])
  })
})
