// REQ-043:cycle 判停的等待原语。原实现(REQ-028/REQ-029)trigger 后固定 sleep 90ms 再读 DOM ——
// 上游触发器文本经 MutationObserver 异步更新,滞后 >90ms 时读到旧值:cur===start 被误判「转满一圈」
// → 假报「切换失败」(S20 重打包批实测到一次滞后)。改为「轮询等真实变化,变化才判档;单步超时无变化
// = 控件无响应(或单档模型 cycle 不改文本),诚实失败」。独立文件(不引 Solid、read/step 注入)使竞态时序可单测。

export type CycleToOptions = {
  /** 读上游触发器当前文本(未渲染 → undefined)。 */
  read: () => string | undefined
  /** 触发一次 cycle(command.trigger;抛错 → 整体 false)。 */
  step: () => void
  /** 目标命中判定(调用方自带规范化,如 REQ-041 normalizeVariant)。 */
  match: (label: string | undefined) => boolean
  /** cycle 步数上限(≥ 可能的档位数即可)。 */
  maxSteps: number
  /** 单步等 DOM 变化的上限(默认 600ms);超时 = 控件无响应 → false。 */
  stepTimeoutMs?: number
  /** 轮询间隔(默认 45ms)。 */
  pollMs?: number
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** 等 read() 返回一个 ≠ prev 的已渲染值;超时返回 undefined。变化即返 → 比固定延时更快也更稳。 */
async function waitForChange(
  read: () => string | undefined,
  prev: string,
  timeoutMs: number,
  pollMs: number,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const cur = read()
    if (cur !== undefined && cur !== prev) return cur
    if (Date.now() >= deadline) return undefined
    await sleep(pollMs)
  }
}

/** 逐步 step() 直到 match 命中;转满一圈(回到起点)/单步超时无变化/step 抛错/控件未渲染 → false(诚实失败)。 */
export async function cycleTo(opts: CycleToOptions): Promise<boolean> {
  const { read, step, match, maxSteps, stepTimeoutMs = 600, pollMs = 45 } = opts
  const start = read()
  if (!start) return false // 控件未渲染(模型不支持 variants / customAgents 关闭等)
  if (match(start)) return true
  let prev = start
  for (let i = 0; i < maxSteps; i++) {
    try {
      step()
    } catch {
      return false
    }
    const cur = await waitForChange(read, prev, stepTimeoutMs, pollMs)
    if (cur === undefined) return false // 超时无变化:控件无响应,或单档模型 cycle 不改文本
    if (match(cur)) return true
    if (cur === start) return false // 转满一圈仍未命中 → 该目标档不存在
    prev = cur
  }
  return false
}
