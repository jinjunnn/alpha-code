// REQ-125 C5 — 滚动锚定的纯逻辑面(视图只做 DOM 读写,判定全部在这里,bun 可测)。
//
// 三个合同:
//   · 跟随流式:仅当用户本就贴底(距底 ≤ slack)时,内容增长后才自动贴底;
//   · 向上翻历史:滚动接近顶部且还有更早分页且不在加载中 → 触发 loadOlder;
//   · prepend 补偿(连续锚定):prepend 开始即锁定首个可见行元素+视口偏移,settling
//     期间凡内容高度变化就重算并再应用锚偏移差 —— 底部流式增高不进入补偿计算;
//     加载期间用户滚动 = 以滚动后的首个可见行重捕获锚,继续 settling(不放弃);
//     in-flight 按 epoch(serverKey+directory+sessionID)分片,切会话互不阻塞(I8)。

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

/**
 * prepend 复位量 = 锚元素相对视口偏移的变化量。只由锚位置导出:锚下方(底部流式)的
 * 任何增高都不影响锚偏移,因此天然不进入补偿计算。
 */
export function anchorDelta(prevAnchorTop: number, nextAnchorTop: number) {
  return nextAnchorTop - prevAnchorTop
}

/**
 * 历史 prepend 的 in-flight 协调器(纯状态机),按 epoch 分片(I8 minor):
 *   · busy(epoch) 只回答「这个会话」是否在加载 —— A 的滞后 in-flight 不阻塞 B 的
 *     触发与贴底跟随(视图一律以 busy(currentEpoch) 判定,不存在全局 idle 语义);
 *   · 补偿本身不在此裁决:Major-3 采用连续锚定(settling),用户滚动=重捕获锚,
 *     不存在「放弃补偿」分支。
 */
export function createPrependCoordinator() {
  const inflight = new Set<string>()
  return {
    busy(epoch: string) {
      return inflight.has(epoch)
    },
    begin(epoch: string) {
      inflight.add(epoch)
    },
    finish(epoch: string) {
      inflight.delete(epoch)
    },
  }
}

export type PrependCoordinator = ReturnType<typeof createPrependCoordinator>
