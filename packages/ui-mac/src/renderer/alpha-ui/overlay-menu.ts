// overlay-menu — REQ-230 AC1(#1476):输入框一带「菜单」的一套键盘与开关规则。
//
// 模型 / 运行权限 / 思考强度三枚芯片的浮层(alpha-composer 的 ChipPopover)与「+ / @」装配列表
// (composer-autocomplete)今天是两套:前者无上下键、点别处才关;后者按下鼠标就关、有上下键,
// 且两者可以同时开着。这里只放两边共用的那一份规则,不放外观(外观是 home.css 的 `.a-pop`)。
//
// ① 「同时只开一个」:一个全局的占位登记 —— 谁开,谁先把上一个关掉。
// ② 上下键:菜单内焦点环形移动(Home / End 到两端)。纯函数部分可脱离 DOM 单测。

/* ── ① 同时只开一个 ─────────────────────────────────────────────────────────── */

type OverlayHolder = { id: symbol; close: () => void }
let holder: OverlayHolder | null = null

/** 声明「我开了」。若另一个菜单正开着,先把它关掉。同一个 id 重复声明是空操作。 */
export function claimOverlay(id: symbol, close: () => void): void {
  if (holder && holder.id !== id) {
    const previous = holder
    holder = null
    previous.close()
  }
  holder = { id, close }
}

/** 声明「我关了」。只释放自己的占位 —— 别人已经接手时不动。 */
export function releaseOverlay(id: symbol): void {
  if (holder?.id === id) holder = null
}

/** 测试用:清空登记。 */
export function resetOverlayRegistry(): void {
  holder = null
}

/* ── ② 上下键 ───────────────────────────────────────────────────────────────── */

/**
 * 菜单内的方向键移动。`index` = 当前项(-1 = 焦点不在任何项上,例如在搜索框里)。
 * 返回目标项下标;`undefined` = 这个键不归菜单管(调用方原样放行,不 preventDefault)。
 *
 * 带修饰键与 IME 组字中的按键一律放行(与 roving-focus 同一条纪律:Cmd/Ctrl/Alt + 方向键归系统,
 * 读屏光标走 Ctrl+Option+方向键)。
 */
export function menuMoveIndex(
  event: Pick<KeyboardEvent, "key" | "isComposing" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey">,
  length: number,
  index: number,
): number | undefined {
  if (length === 0) return
  if (event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
  if (event.key === "ArrowDown") return index < 0 ? 0 : (index + 1) % length
  if (event.key === "ArrowUp") return index < 0 ? length - 1 : (index + length - 1) % length
  if (event.key === "Home") return 0
  if (event.key === "End") return length - 1
  return
}

/** 菜单可移动的项:可点的菜单项与预设行,禁用的跳过。 */
export const MENU_ITEM_SELECTOR = [
  ".a-pop-item:not(:disabled)",
  ".a-mpa-preset:not(:disabled)",
  "[role='menuitem']:not([aria-disabled='true']):not(:disabled)",
  "[role='menuitemradio']:not([aria-disabled='true']):not(:disabled)",
  "[role='option']:not([aria-disabled='true'])",
].join(", ")

/**
 * 在 `root` 内按方向键移动焦点。二级页(`[data-menu-scope]`)打开时只在它里面移动。
 * 返回 true = 这个键被消费了(已 preventDefault)。
 */
export function moveMenuFocus(root: HTMLElement, event: KeyboardEvent): boolean {
  if (event.defaultPrevented) return false
  const target = event.target instanceof HTMLElement ? event.target : null
  // 文本框里 Home / End / 左右键归光标;只有上下键从输入框移进列表。
  const inText = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
  if (inText && event.key !== "ArrowDown" && event.key !== "ArrowUp") return false
  const scopes = root.querySelectorAll<HTMLElement>("[data-menu-scope]")
  const scope = scopes.length > 0 ? scopes[scopes.length - 1]! : root
  const items = Array.from(scope.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR))
  const index = target ? items.indexOf(target) : -1
  const next = menuMoveIndex(event, items.length, index)
  if (next === undefined) return false
  event.preventDefault()
  items[next]!.focus()
  return true
}
