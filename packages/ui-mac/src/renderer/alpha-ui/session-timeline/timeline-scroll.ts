// REQ-125 C5 — 滚动锚定的纯逻辑面(视图只做 DOM 读写,判定全部在这里,bun 可测)。
//
// 三个合同:
//   · 跟随流式:仅当用户本就贴底(距底 ≤ slack)时,内容增长后才自动贴底;
//   · 向上翻历史:滚动接近顶部且还有更早分页且不在加载中 → 触发 loadOlder;
//   · prepend 补偿:历史插入后,以高度差恢复视口,用户看到的内容不跳动。

export const FOLLOW_SLACK_PX = 48
export const LOAD_OLDER_THRESHOLD_PX = 240

export function distanceFromBottom(scrollTop: number, clientHeight: number, scrollHeight: number) {
  return Math.max(0, scrollHeight - clientHeight - scrollTop)
}

export function isAtBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  slack = FOLLOW_SLACK_PX,
) {
  return distanceFromBottom(scrollTop, clientHeight, scrollHeight) <= slack
}

export function shouldLoadOlder(input: {
  scrollTop: number
  more: boolean
  loading: boolean
  threshold?: number
}) {
  if (!input.more || input.loading) return false
  return input.scrollTop <= (input.threshold ?? LOAD_OLDER_THRESHOLD_PX)
}

/** 历史 prepend 后的目标 scrollTop:原位置 + 新增高度(高度只增不减时恒 ≥ 原值)。 */
export function restoreAfterPrepend(prevScrollTop: number, prevScrollHeight: number, nextScrollHeight: number) {
  return prevScrollTop + Math.max(0, nextScrollHeight - prevScrollHeight)
}
