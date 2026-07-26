import { afterEach, describe, expect, test, vi } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { AuthState } from "../preload/types"
import { reconcileAuthSnapshot, resetAuthRecoveryForTests, subscribeAuthState } from "./auth-recovery"

// #604:auth fail-closed 的有界自证。三条退出条件 + auth-recovery.ts 顶部声明的八条不变量
// (A 现值可重读且必广播 / B 绝不静默退场 / C 单 owner / D 至多一个在途读、欠账时只有呈现序
//  ⊑ 视图的读可先行采信 / E 送达逐个隔离 / F 分歧只呈现定序证据(⊑ 视图的快照例外)并纠正 /
//  G 判据粒度不低于 main / H 证据持续到达时 owner 有产出且不热循环)各自有闸门。
// #612:定序覆盖全部 auth 形态(登录态轴)的四条退出条件 + R1 Blocker 复现见文末 describe。
// 呈现序 ⊑ = 相对视图同身份(status/mode/email/plan)且仅把 platformStatus 收紧为 recovering;
// 按 unresolved **形态**枚举分流呈现是 R1 Blocker(recovering 自带 logged-in/platform 身份,
// AlphaOnboarding 凭 status、extension-hub cloudReady 凭 status+mode 放行,跨身份呈现即 fail-open)。

const drain = async () => {
  for (let index = 0; index < 20; index++) await Promise.resolve()
}

const recovering: AuthState = { status: "logged-in", mode: "platform", platformStatus: "recovering" }
const ready: AuthState = { status: "logged-in", mode: "platform", platformStatus: "ready" }

type FakeBridge = {
  /** getState 被调用的次数 —— 自读是否真的发生、发生了几次。 */
  calls: number
  /** subscribe 之后回放的首值(undefined = 回放缺席 / 丢在订阅间隙)。 */
  replay: AuthState | undefined
  /** 模拟 main 推送 auth-state,或一个迟到的回放 —— 对本模块两者不可区分,这正是判据要处理的。 */
  emit: (state: AuthState) => void
  /** 仍挂在桥上的订阅数 —— 桥订阅是否单例、卸载是否摘干净。 */
  subscriptions: number
}

let restoreWindow: (() => void) | undefined

/** read(callIndex) 从 1 开始计数,便于逐次编排两次读取读到不同现值。 */
function installBridge(read: (callIndex: number) => Promise<AuthState>) {
  // 用数组而非 Set:owner 每次都传同一个函数引用,Set 会把重复订阅去重,
  // 让「桥订阅单例」这条闸门变成空检查(桥的真实语义是 addListener,不去重)。
  const listeners: Array<(state: AuthState) => void> = []
  const bridge: FakeBridge = {
    calls: 0,
    replay: recovering,
    emit: (state) => {
      for (const listener of Array.from(listeners)) listener(state)
    },
    get subscriptions() {
      return listeners.length
    },
  }
  const api = {
    auth: {
      getState: () => read(++bridge.calls),
      subscribe: (callback: (state: AuthState) => void) => {
        listeners.push(callback)
        const first = bridge.replay
        if (first) queueMicrotask(() => listeners.includes(callback) && callback(first))
        return () => {
          const at = listeners.indexOf(callback)
          if (at >= 0) listeners.splice(at, 1)
        }
      },
    },
  }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: { api } })
  restoreWindow = () => {
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor)
    else delete (globalThis as { window?: unknown }).window
  }
  return bridge
}

afterEach(() => {
  resetAuthRecoveryForTests()
  vi.useRealTimers()
  restoreWindow?.()
  restoreWindow = undefined
})

describe("auth fail-closed 的有界自证", () => {
  test("退出条件 1 相位 A:视图与 owner 首读都是 recovering,ready 事件丢失后仍自证恢复", async () => {
    vi.useFakeTimers()
    let current = recovering
    const bridge = installBridge(async () => current)
    const seen: AuthState[] = []
    const unsubscribe = subscribeAuthState((state) => seen.push(state))
    await drain()
    expect(seen).toEqual([recovering])
    const afterMount = bridge.calls

    // main 刷新成功,但那一次 auth-state ready 没有到达,也不会补发。
    current = ready
    vi.advanceTimersByTime(1_000)
    await drain()

    expect(bridge.calls).toBe(afterMount + 1)
    expect(seen).toEqual([recovering, ready])
    // resolved 当场退场:timer 真被取消,而不是留一颗到期自我否决的空炮。
    expect(vi.getTimerCount()).toBe(0)
    unsubscribe()
  })

  test("退出条件 1 相位 B:owner 首读直接读到 ready(视图仍是 recovering)时必须广播", async () => {
    vi.useFakeTimers()
    // 消费链先读到 recovering(它自己那次读取),owner 的首读随后读到已恢复的现值。
    const bridge = installBridge(async () => ready)
    bridge.replay = undefined
    const seen: AuthState[] = []
    const unsubscribe = subscribeAuthState((state) => seen.push(state))
    // 消费侧那份陈旧快照先引导视图 —— 这正是 Blocker 的起点。
    expect(reconcileAuthSnapshot(recovering)).toEqual(recovering)
    await drain()
    // 引导值未经证实,owner 欠一次自读;它读到 ready。
    vi.advanceTimersByTime(0)
    await drain()

    // owner 读到 ready:必须广播出去,不能只更新自己的视图就退场。
    expect(seen).toEqual([recovering, ready])
    expect(vi.getTimerCount()).toBe(0)
    unsubscribe()
  })

  test("退出条件 2:ready 事件正常到达时恰好恢复一次,退避当场取消", async () => {
    vi.useFakeTimers()
    let current = recovering
    const bridge = installBridge(async () => current)
    const seen: AuthState[] = []
    const unsubscribe = subscribeAuthState((state) => seen.push(state))
    await drain()
    expect(seen).toEqual([recovering])
    expect(vi.getTimerCount()).toBe(1)

    // 首个退避窗口(1s)尚未到期,live ready 先到 —— 它只是提示,由 owner 自读定夺。
    vi.advanceTimersByTime(400)
    current = ready
    bridge.emit(ready)
    await drain()
    vi.advanceTimersByTime(0)
    await drain()

    expect(seen).toEqual([recovering, ready])
    expect(vi.getTimerCount()).toBe(0)
    const settled = bridge.calls
    vi.advanceTimersByTime(60_000)
    await drain()
    expect(bridge.calls).toBe(settled)
    expect(seen).toEqual([recovering, ready])
    unsubscribe()
  })

  test("退出条件 3:unsubscribe 后 timer 取消、桥订阅摘除、卸载后不再运行", async () => {
    vi.useFakeTimers()
    const bridge = installBridge(async () => recovering)
    const seen: AuthState[] = []
    const unsubscribe = subscribeAuthState((state) => seen.push(state))
    await drain()
    expect(bridge.subscriptions).toBe(1)
    expect(vi.getTimerCount()).toBe(1)
    const afterMount = bridge.calls

    unsubscribe()
    expect(bridge.subscriptions).toBe(0)
    expect(vi.getTimerCount()).toBe(0)

    vi.advanceTimersByTime(60_000)
    await drain()
    expect(bridge.calls).toBe(afterMount)
    expect(seen).toEqual([recovering])
  })

  test("不变量 B 反向闸门:getState 抛错不结束 owner,退避续跑直到恢复", async () => {
    vi.useFakeTimers()
    const bridge = installBridge(async (call) => {
      if (call <= 3) throw new Error("preload bridge unreachable")
      return ready
    })
    const seen: AuthState[] = []
    const unsubscribe = subscribeAuthState((state) => seen.push(state))
    await drain()
    expect(bridge.calls).toBe(1)

    for (let round = 0; round < 3; round++) {
      vi.advanceTimersByTime(8_000)
      await drain()
    }

    expect(bridge.calls).toBe(4)
    expect(seen).toEqual([recovering, ready])
    unsubscribe()
  })

  test("不变量 B / Major 1:全部订阅都在首读失败之前完成,之后无事件也必须自证恢复", async () => {
    vi.useFakeTimers()
    let current: AuthState | undefined
    const bridge = installBridge(async (call) => {
      if (call === 1) throw new Error("transient IPC failure")
      if (!current) throw new Error("transient IPC failure")
      return current
    })
    // 桥回放也一并瞬态缺席 —— 没有任何事件、没有任何新挂载能来救。
    bridge.replay = undefined
    const seen: AuthState[] = []
    const unsubscribes = Array.from({ length: 6 }, () => subscribeAuthState((state) => seen.push(state)))
    // single-flight:六个订阅者同拍挂载只发一次自读,其余只记欠账(不变量 D)。
    expect(bridge.calls).toBe(1)
    await drain()
    expect(seen).toEqual([])

    // IPC 恢复,main 早已 ready:没有新订阅、没有事件,只能靠 owner 自己排的下一次。
    current = ready
    vi.advanceTimersByTime(8_000)
    await drain()

    expect(seen).toEqual(Array.from({ length: 6 }, () => ready))
    unsubscribes.forEach((release) => release())
  })

  test("不变量 B:视图已 resolved 时分歧自读失败,同样必须留下下一次(否则 fail-open 静默定格)", async () => {
    vi.useFakeTimers()
    let current = ready
    let failNext = false
    const bridge = installBridge(async () => {
      if (failNext) {
        failNext = false
        throw new Error("transient IPC failure")
      }
      return current
    })
    bridge.replay = ready
    const seen: AuthState[] = []
    const unsubscribe = subscribeAuthState((state) => seen.push(state))
    await drain()
    vi.advanceTimersByTime(0)
    await drain()
    expect(seen).toEqual([ready])
    // 视图已证实为 ready 且无人欠账 -> owner 合法退场。
    expect(vi.getTimerCount()).toBe(0)

    // main 转入 recovering 并推送 -> 与视图分歧 -> 定夺用的那次自读失败。
    current = recovering
    failNext = true
    bridge.emit(recovering)
    await drain()
    vi.advanceTimersByTime(0)
    await drain()
    expect(seen).toEqual([ready])

    // 视图当时是 resolved,但读取失败依旧不是终局:必须自己排下一次,否则 fail-open 永久定格。
    vi.advanceTimersByTime(8_000)
    await drain()
    expect(seen).toEqual([ready, recovering])
    unsubscribe()
  })

  test("不变量 C:多个消费侧共享同一个 owner —— 一条桥订阅,一轮退避一次自读", async () => {
    vi.useFakeTimers()
    let current = recovering
    const bridge = installBridge(async () => current)
    const composer: AuthState[] = []
    const picker: AuthState[] = []
    const unsubscribeComposer = subscribeAuthState((state) => composer.push(state))
    const unsubscribePicker = subscribeAuthState((state) => picker.push(state))
    await drain()
    expect(bridge.subscriptions).toBe(1)
    const afterMount = bridge.calls

    current = ready
    vi.advanceTimersByTime(1_000)
    await drain()

    expect(bridge.calls).toBe(afterMount + 1)
    expect(composer).toEqual([recovering, ready])
    expect(picker).toEqual([recovering, ready])
    unsubscribeComposer()
    unsubscribePicker()
  })

  test("不变量 D:在途读期间到达的新证据 —— 该读被丢弃并补发,不得把更新的视图回退", async () => {
    vi.useFakeTimers()
    let release!: (state: AuthState) => void
    const pending = new Promise<AuthState>((resolve) => (release = resolve))
    // 挂载那次自读挂住;此后所有读取都读到真实的 ready。
    const bridge = installBridge(async (call) => (call === 1 ? pending : ready))
    bridge.replay = undefined
    const seen: AuthState[] = []
    const unsubscribe = subscribeAuthState((state) => seen.push(state))
    await drain()
    expect(bridge.calls).toBe(1)

    // 在途期间 main 推来 recovering:视图空着 -> 引导采信,并记下欠账。
    bridge.emit(recovering)
    await drain()
    expect(seen).toEqual([recovering])

    // 挂住的那次现在才带着 ready 回来 —— 它比 recovering 更旧,必须丢弃而不是定案。
    release(ready)
    await drain()
    expect(seen).toEqual([recovering])

    // 丢弃后必须补发一次读:那次读到 ready(main 此刻确实已恢复)才允许定案。
    vi.advanceTimersByTime(0)
    await drain()
    expect(bridge.calls).toBe(2)
    expect(seen).toEqual([recovering, ready])
    unsubscribe()
  })

  test("不变量 D:并行请求不得让先返回的旧读定案(R3 复现序列)", async () => {
    vi.useFakeTimers()
    let releaseFirst!: (state: AuthState) => void
    const first = new Promise<AuthState>((resolve) => (releaseFirst = resolve))
    // 第 1 次自读读到的是 token 过期**之前**的 ready(回复在途);此后读到真实的 recovering。
    const bridge = installBridge(async (call) => (call === 1 ? first : recovering))
    bridge.replay = undefined
    const seen: AuthState[] = []
    const a = subscribeAuthState((state) => seen.push(state))
    // 第二个订阅者在第一次自读在途期间挂载 —— 旧实现会并发发出第二次读。
    const b = subscribeAuthState((state) => seen.push(state))
    await drain()
    expect(bridge.calls).toBe(1)

    // 旧的 ready 先返回:它不得定案,更不得让 owner 退场。
    releaseFirst(ready)
    await drain()
    vi.advanceTimersByTime(0)
    await drain()

    expect(seen).toEqual([recovering, recovering])
    expect(bridge.calls).toBe(2)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    a()
    b()
  })

  test("不变量 D:与视图一致的 hint 同样作废在途读(该读可能取自一个已经过去的窗口)", async () => {
    vi.useFakeTimers()
    let hold = false
    let release: ((state: AuthState) => void) | null = null
    let current = recovering
    const bridge = installBridge(async () => {
      if (!hold) return current
      return new Promise<AuthState>((resolve) => (release = resolve))
    })
    bridge.replay = recovering
    const seen: AuthState[] = []
    const unsubscribe = subscribeAuthState((state) => seen.push(state))
    await drain()
    vi.advanceTimersByTime(0)
    await drain()
    expect(seen).toEqual([recovering])

    // 退避到期,发出一次自读并让它挂住 —— 它取到的是一个转瞬即逝的 ready 窗口。
    hold = true
    vi.advanceTimersByTime(8_000)
    await drain()
    expect(release).not.toBeNull()

    // 在途期间到达一条**与视图一致**的 recovering(main 随后一直是 recovering)。
    bridge.emit(recovering)
    await drain()

    // 挂住的那次带着过时的 ready 回来:它一致性地"看起来是恢复",但取自更早的窗口。
    hold = false
    release!(ready)
    await drain()
    vi.advanceTimersByTime(0)
    await drain()

    // 必须被作废并补读;补读读到 recovering,消费侧绝不能看到那个 ready。
    expect(seen).toEqual([recovering])
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    unsubscribe()
  })

  test("反向闸门:single-flight 的丢弃-补发不得吞掉真实恢复,也不得空转", async () => {
    vi.useFakeTimers()
    let current = recovering
    const bridge = installBridge(async () => current)
    bridge.replay = undefined
    const seen: AuthState[] = []
    const a = subscribeAuthState((state) => seen.push(state))
    const b = subscribeAuthState((state) => seen.push(state))
    await drain()
    vi.advanceTimersByTime(0)
    await drain()
    // 丢弃-补发必须收敛:两个订阅者都拿到现值。视图未建立时欠账只可能来自挂载请求而非证据
    // (任何证据都先经 ingestHint 建立视图),该读就是最新证据,recovering 允许引导,
    // 不必再读一次(不变量 H:owner 一定有产出),所以这里恰好一次自读。
    expect(seen).toEqual([recovering, recovering])
    expect(bridge.calls).toBe(1)

    current = ready
    vi.advanceTimersByTime(8_000)
    await drain()
    expect(seen).toEqual([recovering, recovering, ready, ready])
    a()
    b()
  })

  test("不变量 H:证据持续到达时 owner 仍必须有产出,且读取不得退化成热循环", async () => {
    vi.useFakeTimers()
    let calls = 0
    let emit: ((state: AuthState) => void) | undefined
    let flip = false
    // main 在**每一次**自读的往返窗口内都推一条翻转事件 => owedRead 恒为真。
    const read = () => {
      calls++
      queueMicrotask(() => {
        flip = !flip
        emit?.(flip ? ready : recovering)
      })
      return Promise.resolve(flip ? recovering : ready)
    }
    const api = {
      auth: {
        getState: read,
        subscribe: (callback: (state: AuthState) => void) => {
          emit = callback
          return () => {}
        },
      },
    }
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window")
    Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: { api } })
    restoreWindow = () => {
      if (descriptor) Object.defineProperty(globalThis, "window", descriptor)
      else delete (globalThis as { window?: unknown }).window
    }

    const seen: AuthState[] = []
    const unsubscribe = subscribeAuthState((state) => seen.push(state))
    await drain()
    for (let tick = 0; tick < 200; tick++) {
      vi.advanceTimersByTime(1)
      await drain()
    }

    // 产出:同身份、仅把 platformStatus 收紧为 recovering 的读(呈现序 ⊑ 视图)必须先行落地 ——
    // 消费侧真的收到 recovering,而不是被无限丢弃饿死(修前:201 次读取只广播 1 次;
    // 「⊑ 视图的读也一律拒绝」的变异在此转红:seen 只剩引导的 [ready])。
    expect(seen).toEqual([ready, recovering])
    // 速率:200ms 内的读取次数必须远低于「每毫秒一次」(修前 = 201)。
    expect(calls).toBeLessThanOrEqual(5)
    // owner 仍在跑,没有因为降频而退场。
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    unsubscribe()
  })

  // 表征回归(**不是闸门**):本模块内找不到能让它转红的变异 —— 放大的前提是「消费侧与 owner
  // 持久分歧」,那只能由 main 的行为造成,不能由本模块的任何单点改动造成(已试 accept 无条件
  // 广播 / reconcile 无条件置 diverged / reconcile 不早退,三者均不转红)。保留它是为了钉住
  // 实测代价:若将来有人改动使瞬时分歧开始逐圈放大,这条会失败。
  test("表征:一次瞬时分歧只换来一次纠正广播,不与消费侧的重跑构成放大循环", async () => {
    vi.useFakeTimers()
    // 消费侧收到广播就重跑业务链并把自己读到的快照交回 owner(composer/picker 的真实形态)。
    // 若「保守回退 -> 强制纠正广播 -> 消费侧重跑 -> 再次分歧」互相喂,就是无界放大:
    // 实测持久分歧下 50 次重跑 = 51 次广播 + 51 次自读,每圈在生产里是一整条模型链。
    // 但放大要成立,需要**持续的 main/auth churn**(main 在每一轮都给出与消费侧不同的答案);
    // 当前生产守卫下它不会由 renderer 自激产生 —— renderer 单独制造不出这种持续分歧。
    //(不声称 platformStatus 严格单调:Date.now() 跨越期限、unappliedRenewalGeneration 的
    // 置位/清除都会改变它,D-4 那条守护序列本身就依赖 recovering -> ready -> recovering 可达。)
    // 真实形态是**瞬时**分歧(两次读取跨过了续期那一刻)。这里把瞬时分歧的代价钉死。
    const bridge = installBridge(async () => ready)
    bridge.replay = ready
    let chainRuns = 0
    const seen: AuthState[] = []
    const unsubscribe = subscribeAuthState((state) => {
      seen.push(state)
      chainRuns++
      // 第一次重跑读到的是过期那一刻的快照(与 owner 分歧),之后与 owner 一致。
      reconcileAuthSnapshot(chainRuns === 1 ? recovering : ready)
    })
    await drain()
    for (let round = 0; round < 20; round++) {
      vi.advanceTimersByTime(10)
      await drain()
    }

    // 收敛:一次分歧 = 一次纠正广播,不是每圈一次。
    expect(seen).toHaveLength(2)
    expect(chainRuns).toBe(2)
    expect(bridge.calls).toBeLessThanOrEqual(3)
    unsubscribe()
  })

  test("IPC 预算:六个消费侧同拍挂载 = 一条桥订阅 + 有界次数的自读", async () => {
    vi.useFakeTimers()
    const bridge = installBridge(async () => ready)
    bridge.replay = ready
    const seen: AuthState[] = []
    const releases = Array.from({ length: 6 }, () => subscribeAuthState((state) => seen.push(state)))
    await drain()
    vi.advanceTimersByTime(0)
    await drain()

    expect(bridge.subscriptions).toBe(1)
    // base 是「每个消费侧各一次 preload 回放」= 6 次;single-flight 后自读次数与消费侧数量无关。
    // 实测:自读恰好 2 次(首发 + 因在途欠账补发一次),与消费侧数量无关。
    // base 是「每个消费侧各一次 preload 回放」= 6 次 IPC;现在总计 1 回放 + 2 自读 = 3 次。
    // **该结论只针对本例的「同拍挂载」**:错峰挂载时每次挂载各有自己的 requestRead(),
    // 不落在同一个 single-flight 窗口里,不应把「2 次」泛化过去。
    expect(bridge.calls).toBe(2)
    expect(seen).toHaveLength(6)
    releases.forEach((release) => release())
  })

  test("Major 2 序列一:live ready 之后迟到的陈旧 recovering 快照不得把消费侧带回 recovering", async () => {
    vi.useFakeTimers()
    let current = recovering
    const bridge = installBridge(async () => current)
    const seen: AuthState[] = []
    const unsubscribe = subscribeAuthState((state) => seen.push(state))
    await drain()

    current = ready
    bridge.emit(ready)
    await drain()
    vi.advanceTimersByTime(0)
    await drain()
    expect(seen).toEqual([recovering, ready])

    // 迟到的旧回放(桥无法区分回放与推送)—— 不得触发 recovering -> ready 的第二轮 churn。
    bridge.emit(recovering)
    await drain()
    vi.advanceTimersByTime(0)
    await drain()
    expect(seen).toEqual([recovering, ready])
    unsubscribe()
  })

  test("Major 2 序列二:live recovering 之后迟到的陈旧 ready 快照不得把 fail-closed 放行成 fail-open", async () => {
    vi.useFakeTimers()
    let current = ready
    const bridge = installBridge(async () => current)
    bridge.replay = ready
    const seen: AuthState[] = []
    const unsubscribe = subscribeAuthState((state) => seen.push(state))
    await drain()
    expect(seen).toEqual([ready])

    // main 转入 recovering 并推送。
    current = recovering
    bridge.emit(recovering)
    await drain()
    vi.advanceTimersByTime(0)
    await drain()
    expect(seen).toEqual([ready, recovering])

    // 迟到的陈旧 ready 回放:消费侧绝不能因此看到 ready(那是比原缺陷更危险的方向)。
    bridge.emit(ready)
    await drain()
    vi.advanceTimersByTime(0)
    await drain()
    expect(seen).toEqual([ready, recovering])
    // 且 owner 仍在跑,recovering 仍有下一次自证。
    expect(vi.getTimerCount()).toBe(1)
    unsubscribe()
  })

  test("不变量 E:单个订阅者抛错不截断其余订阅者,owner 仍完成退场", async () => {
    vi.useFakeTimers()
    let current = recovering
    installBridge(async () => current)
    const first: AuthState[] = []
    const second: AuthState[] = []
    const unsubscribeFirst = subscribeAuthState((state) => {
      first.push(state)
      throw new Error("consumer blew up")
    })
    const unsubscribeSecond = subscribeAuthState((state) => second.push(state))
    await drain()

    current = ready
    vi.advanceTimersByTime(1_000)
    await drain()

    expect(first).toEqual([recovering, ready])
    expect(second).toEqual([recovering, ready])
    // 抛错发生在广播途中,owner 的去留判定必须仍然执行到位。
    expect(vi.getTimerCount()).toBe(0)
    unsubscribeFirst()
    unsubscribeSecond()
  })

  test("不变量 F:消费侧已读到 recovering 时,分歧一律呈现保守值,定夺后再广播纠正", async () => {
    vi.useFakeTimers()
    let current = ready
    const bridge = installBridge(async () => current)
    bridge.replay = ready
    const seen: AuthState[] = []
    const unsubscribe = subscribeAuthState((state) => seen.push(state))
    await drain()
    vi.advanceTimersByTime(0)
    await drain()
    expect(seen).toEqual([ready])

    // 消费侧自己读到 recovering(main 已过期,owner 还没收到坏消息):
    // 绝不能拿 owner 的乐观视图放行 —— 「未验证的 token 不呈现为可用」是既有合同。
    current = recovering
    expect(reconcileAuthSnapshot(recovering)).toEqual(recovering)

    vi.advanceTimersByTime(0)
    await drain()
    expect(seen).toEqual([ready, recovering])
    unsubscribe()
  })

  test("不变量 F:保守回退之后即使 owner 视图未变也必须广播,否则消费侧停在保守值上", async () => {
    vi.useFakeTimers()
    const bridge = installBridge(async () => ready)
    bridge.replay = ready
    const seen: AuthState[] = []
    const unsubscribe = subscribeAuthState((state) => seen.push(state))
    await drain()
    vi.advanceTimersByTime(0)
    await drain()
    expect(seen).toEqual([ready])

    // 这次消费侧那份 recovering 才是陈旧的一方:仍先保守呈现。
    expect(reconcileAuthSnapshot(recovering)).toEqual(recovering)
    // owner 定夺仍是 ready —— 签名没变,但消费侧手上是 recovering,必须再播一次纠正。
    vi.advanceTimersByTime(0)
    await drain()
    expect(seen).toEqual([ready, ready])
    unsubscribe()
  })

  test("不变量 D:live 事件先到时,迟到的旧自读必须被作废(否则 fail-open 永久定格)", async () => {
    vi.useFakeTimers()
    let release!: (state: AuthState) => void
    const pending = new Promise<AuthState>((resolve) => (release = resolve))
    // 挂载时那次自读在 main 还没过期时发出,回复在途;此后所有读取都读到真实的 recovering。
    const bridge = installBridge(async (call) => (call === 1 ? pending : recovering))
    bridge.replay = undefined
    const seen: AuthState[] = []
    const unsubscribe = subscribeAuthState((state) => seen.push(state))
    await drain()
    expect(seen).toEqual([])

    // main 转 recovering,live 事件先到 —— 空视图采信它引导。
    bridge.emit(recovering)
    await drain()
    expect(seen).toEqual([recovering])

    // 旧的 ready 自读现在才回来:它比 live 事件更旧,必须被作废,不得广播、不得让 owner 退场。
    release(ready)
    await drain()
    vi.advanceTimersByTime(0)
    await drain()
    expect(seen).toEqual([recovering])

    vi.advanceTimersByTime(60_000)
    await drain()
    expect(seen).toEqual([recovering])
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    unsubscribe()
  })

  test("不变量 B:广播途中新提出的自读,不得被这次广播之后的 settle 取消", async () => {
    vi.useFakeTimers()
    const bridge = installBridge(async () => ready)
    bridge.replay = ready
    let reentered = false
    const unsubscribe = subscribeAuthState(() => {
      if (reentered) return
      reentered = true
      // 订阅者在收到 ready 的同一拍里读到了 recovering —— 重入 owner 提出新问题。
      reconcileAuthSnapshot(recovering)
    })
    await drain()
    const beforeSettle = bridge.calls
    vi.advanceTimersByTime(0)
    await drain()

    expect(reentered).toBeTrue()
    // 重入提出的那次自读必须真的发生;若被 settle 取消,recovering 就永远无人复核。
    expect(bridge.calls).toBeGreaterThan(beforeSettle)
    unsubscribe()
  })

  test("不变量 E:迟到订阅者的首值回放同样走隔离送达,抛错不逃逸出模块", async () => {
    vi.useFakeTimers()
    const uncaught: unknown[] = []
    const onUncaught = (error: unknown) => uncaught.push(error)
    process.on("uncaughtException", onUncaught)
    try {
      const bridge = installBridge(async () => ready)
      bridge.replay = ready
      const first = subscribeAuthState(() => {})
      await drain()
      vi.advanceTimersByTime(0)
      await drain()

      // 迟到订阅者:现值已知,走首值回放这条路径。
      let replayed = 0
      const second = subscribeAuthState(() => {
        replayed++
        throw new Error("late subscriber blew up")
      })
      await drain()
      expect(replayed).toBe(1)
      expect(uncaught).toEqual([])
      first()
      second()
    } finally {
      process.off("uncaughtException", onUncaught)
    }
  })

  test("不变量 G:同邮箱的 plan 变化必须广播(判据粒度不得低于 main 的 publish)", async () => {
    vi.useFakeTimers()
    const free: AuthState = { status: "logged-in", mode: "platform", platformStatus: "ready", account: { email: "a@b.c", plan: "free" } }
    const pro: AuthState = { status: "logged-in", mode: "platform", platformStatus: "ready", account: { email: "a@b.c", plan: "pro" } }
    let current = free
    const bridge = installBridge(async () => current)
    bridge.replay = free
    const seen: AuthState[] = []
    const unsubscribe = subscribeAuthState((state) => seen.push(state))
    await drain()
    vi.advanceTimersByTime(0)
    await drain()
    expect(seen).toEqual([free])

    current = pro
    bridge.emit(pro)
    await drain()
    vi.advanceTimersByTime(0)
    await drain()

    expect(seen).toEqual([free, pro])
    unsubscribe()
  })

  test("订阅者归零再回来:按保留的 recovering 视图直接续跑", async () => {
    vi.useFakeTimers()
    let current = recovering
    const bridge = installBridge(async () => current)
    bridge.replay = undefined
    const first = subscribeAuthState(() => {})
    await drain()
    expect(bridge.calls).toBe(1)
    first()

    vi.advanceTimersByTime(60_000)
    await drain()
    expect(bridge.calls).toBe(1)

    current = ready
    const seen: AuthState[] = []
    const second = subscribeAuthState((state) => seen.push(state))
    await drain()

    expect(seen).toEqual([recovering, ready])
    second()
  })
})

// #612:定序覆盖全部 auth 形态。#604 的判据只在 platformStatus 轴上定序;登录态轴上
// 「迟到旧快照覆盖更新的真相」是同一形态的缺陷 —— logged-out 与 logged-in/ready 都是
// resolved 终态,谁都没有可证的新旧,分歧时只有 owner 视图(single-flight 序列化)可呈现。
describe("#612 快照定序覆盖登录态轴", () => {
  const loggedOut: AuthState = { status: "logged-out", mode: "platform" }

  test("退出条件 1:视图 logged-out 时,迟到的 logged-in/ready 快照不得被呈现或广播", async () => {
    vi.useFakeTimers()
    const bridge = installBridge(async () => loggedOut)
    bridge.replay = undefined
    const seen: AuthState[] = []
    const unsubscribe = subscribeAuthState((state) => seen.push(state))
    await drain()
    expect(seen).toEqual([loggedOut])
    // logged-out 是 resolved 终态:owner 合法退场,不为它自探(票面明写,不扩大 unresolved)。
    expect(vi.getTimerCount()).toBe(0)

    // 消费侧交来登出前读到的旧快照:必须拿回 owner 视图,不得拿回 logged-in/ready。
    expect(reconcileAuthSnapshot(ready)).toEqual(loggedOut)
    // 分歧欠下的定夺自读读到现值仍是 logged-out:任何订阅者都不得看到 logged-in/ready。
    vi.advanceTimersByTime(0)
    await drain()
    expect(bridge.calls).toBe(2)
    expect(seen).toEqual([loggedOut])
    expect(vi.getTimerCount()).toBe(0)
    unsubscribe()
  })

  test("退出条件 2:视图 logged-in 时,迟到的 logged-out 快照同样不得覆盖", async () => {
    vi.useFakeTimers()
    const bridge = installBridge(async () => ready)
    bridge.replay = undefined
    const seen: AuthState[] = []
    const unsubscribe = subscribeAuthState((state) => seen.push(state))
    await drain()
    expect(seen).toEqual([ready])

    // 登录完成前发出的那次读现在才回来:不得把更新的登录视图翻成登出。
    expect(reconcileAuthSnapshot(loggedOut)).toEqual(ready)
    vi.advanceTimersByTime(0)
    await drain()
    expect(bridge.calls).toBe(2)
    expect(seen).toEqual([ready])
    unsubscribe()
  })

  test("退出条件 3:并行多订阅者 + 在途自读带回旧 ready,任何人都不得看到 logged-in/ready", async () => {
    vi.useFakeTimers()
    let held: ((state: AuthState) => void) | undefined
    const bridge = installBridge(async (call) => {
      // 第 2 次自读挂住:它发出于登出之前,回来时已是旧证据(③″2-8:自己发的读同样要定序)。
      if (call === 2) return new Promise<AuthState>((resolve) => (held = resolve))
      return loggedOut
    })
    bridge.replay = undefined
    const first: AuthState[] = []
    const unsubscribeFirst = subscribeAuthState((state) => first.push(state))
    await drain()
    expect(first).toEqual([loggedOut])

    // 第二个订阅者挂载:回放走 owner 视图,同时发出的自读挂在途。
    const second: AuthState[] = []
    const unsubscribeSecond = subscribeAuthState((state) => second.push(state))
    await drain()
    expect(second).toEqual([loggedOut])
    expect(held).toBeDefined()

    // 在途期间,两个消费侧并行交来各自的迟到 ready 快照 —— 都只能拿回 logged-out。
    expect(reconcileAuthSnapshot(ready)).toEqual(loggedOut)
    expect(reconcileAuthSnapshot(ready)).toEqual(loggedOut)

    // 挂住的自读带着更旧的 ready 回来:已有欠账,resolved 值不得定案,由后读定夺。
    held!(ready)
    await drain()
    vi.advanceTimersByTime(0)
    await drain()
    expect(bridge.calls).toBe(3)
    expect(first).toEqual([loggedOut])
    expect(second).toEqual([loggedOut])
    unsubscribeFirst()
    unsubscribeSecond()
  })

  test("退出条件 3 反向:在途自读带回旧 logged-out,同样不得翻转任何订阅者的登录视图", async () => {
    vi.useFakeTimers()
    let held: ((state: AuthState) => void) | undefined
    const bridge = installBridge(async (call) => {
      if (call === 2) return new Promise<AuthState>((resolve) => (held = resolve))
      return ready
    })
    bridge.replay = undefined
    const first: AuthState[] = []
    const unsubscribeFirst = subscribeAuthState((state) => first.push(state))
    await drain()
    expect(first).toEqual([ready])

    const second: AuthState[] = []
    const unsubscribeSecond = subscribeAuthState((state) => second.push(state))
    await drain()
    expect(second).toEqual([ready])
    expect(held).toBeDefined()

    expect(reconcileAuthSnapshot(loggedOut)).toEqual(ready)
    expect(reconcileAuthSnapshot(loggedOut)).toEqual(ready)

    held!(loggedOut)
    await drain()
    vi.advanceTimersByTime(0)
    await drain()
    expect(bridge.calls).toBe(3)
    expect(first).toEqual([ready])
    expect(second).toEqual([ready])
    unsubscribeFirst()
    unsubscribeSecond()
  })

  // rev2c ③″4-4 反向闸门:定序判据只延迟呈现,不得把「该拦的/该到的」吞掉 —— 快照不迟到
  //(main 真的变了)时,真相必须在有界时间内经 owner 定夺落地。
  test("反向闸门:真实登出不被定序判据吞掉,有界时间内广播落地", async () => {
    vi.useFakeTimers()
    let current: AuthState = ready
    const bridge = installBridge(async () => current)
    bridge.replay = undefined
    const seen: AuthState[] = []
    const unsubscribe = subscribeAuthState((state) => seen.push(state))
    await drain()
    expect(seen).toEqual([ready])

    // main 真的登出;消费侧那次读先看到。呈现上先保住视图,但真相由定夺自读广播。
    current = loggedOut
    expect(reconcileAuthSnapshot(loggedOut)).toEqual(ready)
    vi.advanceTimersByTime(0)
    await drain()
    expect(seen).toEqual([ready, loggedOut])
    unsubscribe()
  })

  test("反向闸门:真实登录同样有界落地(保守呈现不得变成永久扣留)", async () => {
    vi.useFakeTimers()
    let current: AuthState = loggedOut
    const bridge = installBridge(async () => current)
    bridge.replay = undefined
    const seen: AuthState[] = []
    const unsubscribe = subscribeAuthState((state) => seen.push(state))
    await drain()
    expect(seen).toEqual([loggedOut])

    current = ready
    expect(reconcileAuthSnapshot(ready)).toEqual(loggedOut)
    vi.advanceTimersByTime(0)
    await drain()
    expect(seen).toEqual([loggedOut, ready])
    unsubscribe()
  })

  // R1 Blocker(reconcile 侧):recovering 只在 platformStatus 轴上「保守」,它的身份轴是
  // logged-in/platform —— AlphaOnboarding 凭 status、extension-hub cloudReady 凭 status+mode
  // 放行,跨身份呈现它就是 fail-open,不是「不放行任何能力」。呈现序例外只认同身份收紧。
  test("R1 Blocker:视图 logged-out 时,跨身份的 logged-in/recovering 快照不得被呈现", async () => {
    vi.useFakeTimers()
    const bridge = installBridge(async () => loggedOut)
    bridge.replay = undefined
    const seen: AuthState[] = []
    const unsubscribe = subscribeAuthState((state) => seen.push(state))
    await drain()
    expect(seen).toEqual([loggedOut])

    // 消费侧交来登出前读到的旧 recovering:必须拿回 owner 视图 —— 它携带 logged-in 身份。
    expect(reconcileAuthSnapshot(recovering)).toEqual(loggedOut)
    vi.advanceTimersByTime(0)
    await drain()
    // 定夺自读确认 logged-out;全程没有任何订阅者、任何返回值出现过 logged-in 形态。
    expect(seen).toEqual([loggedOut])
    expect(bridge.calls).toBe(2)
    unsubscribe()
  })

  test("R1 Blocker 复现:在途自读被更新的 logged-out 证据作废后带回 logged-in/recovering,不得广播给任何订阅者", async () => {
    vi.useFakeTimers()
    let held: ((state: AuthState) => void) | undefined
    const bridge = installBridge(async (call) => {
      if (call === 2) return new Promise<AuthState>((resolve) => (held = resolve))
      return loggedOut
    })
    bridge.replay = undefined
    // 1) 首个订阅者建立 logged-out 视图。
    const first: AuthState[] = []
    const unsubscribeFirst = subscribeAuthState((state) => first.push(state))
    await drain()
    expect(first).toEqual([loggedOut])

    // 2) 第二个订阅者触发一条在途读(挂住)。
    const second: AuthState[] = []
    const unsubscribeSecond = subscribeAuthState((state) => second.push(state))
    await drain()
    expect(second).toEqual([loggedOut])
    expect(held).toBeDefined()

    // 3) 期间更新的 logged-out 证据令该读失效(与视图签名一致,但 reading 在途 -> 记欠账)。
    bridge.emit(loggedOut)
    await drain()

    // 4) 旧读随后带回 {logged-in, platform, recovering} —— R1 实跑:修前两个订阅者都依次
    //    收到 logged-out -> logged-in/recovering,消费侧凭 status/mode 当场放行 = fail-open。
    held!(recovering)
    await drain()
    vi.advanceTimersByTime(0)
    await drain()

    expect(first).toEqual([loggedOut])
    expect(second).toEqual([loggedOut])
    // 被作废的读不定案,由补发的第 3 次读定夺(仍是 logged-out,签名一致故无新广播)。
    expect(bridge.calls).toBe(3)
    unsubscribeFirst()
    unsubscribeSecond()
  })

  test("不变量 H:登录态轴风暴下读取有界、订阅者看不到翻转,风暴停后真相有界落地", async () => {
    vi.useFakeTimers()
    let calls = 0
    let emit: ((state: AuthState) => void) | undefined
    let flip = false
    let storm = true
    // main 在每一次自读的往返窗口内都推一条**登录态轴**翻转事件 => owedRead 恒为真,
    // 且读回的值相对视图跨身份(呈现序不允许先采)。修法若回到「无限 0ms 补发」,读取次数爆炸。
    const read = () => {
      calls++
      if (!storm) return Promise.resolve(loggedOut)
      queueMicrotask(() => {
        flip = !flip
        emit?.(flip ? ready : loggedOut)
      })
      return Promise.resolve(flip ? loggedOut : ready)
    }
    const api = {
      auth: {
        getState: read,
        subscribe: (callback: (state: AuthState) => void) => {
          emit = callback
          return () => {}
        },
      },
    }
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window")
    Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: { api } })
    restoreWindow = () => {
      if (descriptor) Object.defineProperty(globalThis, "window", descriptor)
      else delete (globalThis as { window?: unknown }).window
    }

    const seen: AuthState[] = []
    const unsubscribe = subscribeAuthState((state) => seen.push(state))
    await drain()
    for (let tick = 0; tick < 200; tick++) {
      vi.advanceTimersByTime(1)
      await drain()
    }

    // 跨身份的可能旧读一律不得呈现:订阅者最多看到引导那一次,绝不看到翻转序列。
    expect(seen.length).toBeLessThanOrEqual(1)
    // 连续被作废的读转入退避:200ms 内不得退化成每毫秒一读。
    expect(calls).toBeLessThanOrEqual(5)
    // owner 仍在跑,没有静默退场。
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    // 风暴停止,main 稳定 logged-out:真相必须经退避在有界时间内落地(③″4-4 反向闸门:
    // 收紧呈现判据不得把「该到的」吞掉)。
    storm = false
    vi.advanceTimersByTime(8_000)
    await drain()
    expect(seen[seen.length - 1]).toEqual(loggedOut)
    unsubscribe()
  })
})

describe("auth 订阅单点接线", () => {
  const rendererRoot = import.meta.dir
  const sources = readdirSync(rendererRoot, { recursive: true, encoding: "utf8" })
    .filter((entry) => /\.tsx?$/.test(entry) && !/\.(test|cases|typecheck)\.tsx?$/.test(entry))
    .map((entry) => ({ path: entry, text: readFileSync(join(rendererRoot, entry), "utf8") }))

  test("除 auth-recovery.ts 外无人直接接 window.api.auth.subscribe(每个入口都被自探覆盖)", () => {
    // 非空检查(基线 rev2c ③″3-5):扫描确实读到了文件,且模式确实匹配到了东西。
    expect(sources.length).toBeGreaterThan(50)
    const direct = sources.filter((file) => file.text.includes("api.auth.subscribe")).map((file) => file.path)
    expect(direct).toEqual(["auth-recovery.ts"])

    const wired = sources
      .filter((file) => file.path !== "auth-recovery.ts" && file.text.includes("subscribeAuthState("))
      .map((file) => file.path)
      .sort()
    expect(wired).toEqual([
      "alpha-ui/AlphaOnboarding.tsx",
      "alpha-ui/alpha-composer-model.tsx",
      "alpha-ui/alpha-composer.tsx",
      "automations/automation-panel.tsx",
      "extensions/extension-hub.tsx",
      "sidebar/alpha-sidebar.tsx",
    ])
  })

  test("消费侧自己那次 auth.getState() 一律过 reconcileAuthSnapshot", () => {
    // 消费侧写作 `window.api.auth\n  .getState()`,匹配前先抹掉空白,否则这条闸门是空检查。
    const flat = (text: string) => text.replace(/\s+/g, "")
    const readers = sources
      .filter((file) => file.path !== "auth-recovery.ts" && flat(file.text).includes("api.auth.getState()"))
      .map((file) => file.path)
      .sort()
    expect(readers).toEqual(["alpha-ui/alpha-composer-model.tsx", "alpha-ui/alpha-composer.tsx"])
    // 只断言「文件里出现过这个名字」会被 import 行满足(空检查);锁的是**读到的那个值**流过判据。
    const applied = readers.map((path) => {
      const text = flat(sources.find((file) => file.path === path)!.text)
      return [...text.matchAll(/reconcileAuthSnapshot\(([A-Za-z0-9_.]+)\)/g)].map((match) => match[1])
    })
    expect(applied).toEqual([["raw"], ["auth.data"]])
  })
})
