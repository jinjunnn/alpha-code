// C21 AC2 —— 复合 role 的键盘契约,全 alpha-ui 唯一实现。
//
// 声明 role="tablist" / "radiogroup" / "tree" / "listbox" 就等于向 AT 承诺两件事:
// ① 方向键(含 Home/End)在组内项之间移动并激活;② 整组在 Tab 序列里只占一个落点。
// 每块面板各自手抄一份 ArrowLeft/ArrowRight 分支,正是 C21 记下的那类缺陷的温床;
// 面板只提供「项集合 + 当前项 + 如何激活」,键盘语义在这里定死一次。

const NEXT_KEYS = new Set(["ArrowRight", "ArrowDown"])
const PREVIOUS_KEYS = new Set(["ArrowLeft", "ArrowUp"])

/** 组内 Tab 落点:当前项 0、其余 -1 —— Tab 进出整组一次,组内靠方向键。 */
export function rovingTabIndex(isActive: boolean) {
  return isActive ? 0 : -1
}

/**
 * 方向键 / Home / End 在 `items` 内环形移动。`activate` 同时承担「选中该项」与「把 DOM 焦点
 * 移到该项」——「移动即激活」是 tablist/radiogroup 的契约。非导航键原样放行(不吞 Tab、
 * Escape、字符键);`active` 不在 `items` 内(例如该项已被禁用)时从首项起算。
 */
export function rovingKey<T>(
  event: KeyboardEvent,
  items: readonly T[],
  active: T | undefined,
  activate: (item: T) => void,
) {
  if (items.length === 0) return
  const index = Math.max(0, items.indexOf(active as T))
  const next = NEXT_KEYS.has(event.key)
    ? (index + 1) % items.length
    : PREVIOUS_KEYS.has(event.key)
      ? (index + items.length - 1) % items.length
      : event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : undefined
  if (next === undefined) return
  event.preventDefault()
  activate(items[next]!)
}
