// C21 AC2 —— 复合 role 的键盘契约,全 alpha-ui 唯一实现。
//
// 声明 role="tablist" / "radiogroup" 就等于向 AT 承诺两件事:① 该 role 规定的那几个方向键
// 在组内项之间移动并激活;② 整组在 Tab 序列里只占一个落点。每块面板各自手抄一份
// ArrowLeft/ArrowRight 分支,正是 C21 记下的那类缺陷的温床;面板只提供「项集合 + 当前项 +
// 如何激活」,键盘语义在这里定死一次。
//
// 键表按 role 分:APG 的 Tabs 与 Radio Group 不是同一张表,合成一张会同时违反两边 ——
// 横向 tablist 吃掉 ↑↓ 会顶掉页面滚动,radio 吃掉 Home/End 会改选用户没打算改的项。

/** 调用方声明自己是哪一类复合控件 —— 键表由 role 决定,不是由「哪些键看起来像导航」决定。 */
export type RovingKeyTable = "horizontal-tabs" | "radio"

type Table = { next: readonly string[]; previous: readonly string[]; ends: boolean }

const TABLES: Record<RovingKeyTable, Table> = {
  // W3C Tabs Pattern:横向 tablist 只监听 ←→(Home/End 可选,本仓采用)。↑↓ 属于纵向
  // tablist(aria-orientation="vertical");本仓四条页签条都是横排 flex,吃掉 ↑↓ 就是抢滚动。
  "horizontal-tabs": { next: ["ArrowRight"], previous: ["ArrowLeft"], ends: true },
  // W3C Radio Group Pattern:两轴都认(→↓ 下一项、←↑ 上一项),但这张表里没有 Home/End ——
  // 「移动即选中」下,一个未定义的键改掉用户的选择是数据损失,不是导航。
  radio: { next: ["ArrowRight", "ArrowDown"], previous: ["ArrowLeft", "ArrowUp"], ends: false },
}

/** 组内 Tab 落点:当前项 0、其余 -1 —— Tab 进出整组一次,组内靠方向键。 */
export function rovingTabIndex(isActive: boolean) {
  return isActive ? 0 : -1
}

/**
 * `table` 规定的方向键在 `items` 内环形移动。`activate` 同时承担「选中该项」与「把 DOM 焦点
 * 移到该项」——「移动即激活」是 tablist/radiogroup 的契约。
 *
 * 三类事件一律原样放行,不 preventDefault:① 非本表的键(Tab、Escape、字符键、以及横向
 * tablist 上的 ↑↓);② 带修饰键的组合 —— Cmd/Ctrl/Alt/Shift+方向键归系统与浏览器(macOS 的
 * VoiceOver 光标是 Ctrl+Option+方向键,吞掉它等于把读屏用户锁在组里);③ IME 组字中的按键
 * (`isComposing`)—— 组字期间的方向键是在选候选词,不是在切页签。
 *
 * `active` 不在 `items` 内(例如该项已被禁用而被过滤掉)时从首项起算。
 */
export function rovingKey<T>(
  event: KeyboardEvent,
  table: RovingKeyTable,
  items: readonly T[],
  active: T | undefined,
  activate: (item: T) => void,
) {
  if (items.length === 0) return
  if (event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
  const keys = TABLES[table]
  const index = Math.max(0, items.indexOf(active as T))
  const next = keys.next.includes(event.key)
    ? (index + 1) % items.length
    : keys.previous.includes(event.key)
      ? (index + items.length - 1) % items.length
      : keys.ends && event.key === "Home"
        ? 0
        : keys.ends && event.key === "End"
          ? items.length - 1
          : undefined
  if (next === undefined) return
  event.preventDefault()
  activate(items[next]!)
}
