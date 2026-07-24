// REQ-125 C5 — 滚动锚定的纯逻辑面(视图只做 DOM 读写,判定全部在这里,bun 可测)。
//
// 三个合同:
//   · 跟随流式:仅当用户本就贴底(距底 ≤ slack)时,内容增长后才自动贴底;
//   · 向上翻历史:滚动接近顶部且还有更早分页且不在加载中 → 触发 loadOlder;
//   · prepend 补偿(锚元素法):记录首个可见行元素与其视口偏移,prepend 完成同帧内以
//     锚的偏移差复位 —— 底部流式增高不进入补偿计算;加载期间用户主动滚动则放弃补偿;
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
 * 历史 prepend 的并发/补偿协调器(纯状态机):
 *   · begin/finish 按 epoch 分片 —— 一个会话的 in-flight 不阻塞另一个会话(I8 minor);
 *   · noteScroll 记录加载期间的用户滚动 —— finish 时裁决是否补偿;
 *   · finish 校验完成时 epoch 未变 —— 切会话后的滞后完成一律 skip。
 */
export function createPrependCoordinator() {
  const inflight = new Map<string, { userScrolled: boolean }>()
  return {
    busy(epoch: string) {
      return inflight.has(epoch)
    },
    idle() {
      return inflight.size === 0
    },
    begin(epoch: string) {
      inflight.set(epoch, { userScrolled: false })
    },
    noteScroll(epoch: string) {
      const state = inflight.get(epoch)
      if (state) state.userScrolled = true
    },
    finish(epoch: string, currentEpoch: string): "compensate" | "skip" {
      const state = inflight.get(epoch)
      inflight.delete(epoch)
      if (!state) return "skip"
      if (epoch !== currentEpoch) return "skip"
      return state.userScrolled ? "skip" : "compensate"
    },
  }
}

export type PrependCoordinator = ReturnType<typeof createPrependCoordinator>
