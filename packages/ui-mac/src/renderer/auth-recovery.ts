import type { AuthState } from "../preload/types"
import { nextEngineRetryDelay } from "./alpha-ui/model-picker-logic"

// #604:auth 面的 fail-closed 有界自证(与 #594 的 sidecar generation 面同一缺陷类)。
//
// 失效序列:renderer 读到过期 token 的 `platformStatus:"recovering"` -> 平台选择/发送 fail-closed
// -> main 刷新成功后**只发送一次** `auth-state ready` -> 该 IPC 若丢在订阅间隙/生命周期竞态里,
// 消费侧再无下一次 `auth.getState()` => 平台能力永久 recovering。main 不会补发:
// main/alpha-auth.ts 的 publish() 对身份签名未变的广播直接抑制,丢掉的那一次不会重来。
//
// 本模块是 auth 能力的**唯一恢复 owner**,也是 renderer 侧 auth 现值的**唯一序列化点**:
// 模块级单例、一条 timer、一条桥订阅。入口枚举闸门见 auth-recovery.test.ts。
//
// == 核心判据:证据没有全序,所以 owner 自读收敛为 single-flight ==
// 四类证据彼此**没有任何顺序保证**:preload 首值回放、main 推送事件、消费侧自己那次
// `getState()`、**以及 owner 自己那次在途的 `getState()`**。最后一类最容易被忽略:自读的
// 回复也是异步快照,它描述的是「发出与回来之间某个瞬间」的 main,完全可能比之后到达的
// 证据更旧。AuthState 里没有任何可定序的字段(`expiresAt` 的单调性归 main 管,且跨
// 登录/登出/换账号并不成立,preload/types.ts 也没给单调契约)。
//
// 曾经的做法是给证据编号、让新证据作废在途读 —— 但那**默认了「先返回 = 更新」**:两次并行
// 自读各自捕获同一个号,先返回的那次定案并作废另一次,较晚取到的真实 recovering 反而被丢掉
// 且不留重试 => fail-open。编号治不了并行,**并行本身才是要消掉的东西**:
//
//   owner 同一时刻只允许一次自读在途(single-flight)。在途期间的任何新请求/新证据只记
//   `owedRead`;该次读回来时若 owedRead 已置位,它就**可能更旧** —— 丢弃并立刻补发一次。
//   于是「更新的读」永远是**最后发出**的那次,不需要任何编号。
//
// 外部快照(前三类)一律只当**提示**,不当真值:
//   - 视图空着       -> 先采信它引导(消费侧立刻有值可用),同时欠一次自读去证实;
//   - 与视图一致     -> 若有在途自读(已被本条证据作废),补一次自读;否则无事;
//   - 与视图不一致   -> **不采信**,owner 立刻自读定夺。
// 只有 owner 的自读会被接纳为视图。这条判据对所有入口一视同仁,所以迟到的陈旧快照既不会
// 把已 ready 的能力打回 recovering,也不会把 recovering 放行成 ready(后者更危险)。
//
// == fail-closed 判据依赖的不变量与各自的强制手段(基线 rev2c ③″1)==
// 每条都写明「什么变异会让它转红」;答不出变异的不写进本表。
//
// A 「recovering / 未知视图可由 getState() 重读,且结果必须广播给消费侧」
//   强制:退出条件 1 两相位模块例 + 两条真 AlphaComposerRuntime 生产 composition 例。
//   变异:删 broadcast(state) / settle() 里不再 scheduleRetry -> 红。
// B 「owner 绝不静默退场:读取失败、被作废、事件不来,都必须留下下一次动作」
//   强制:无预算,只有 1s/2s/4s/8s 封顶退避;scheduleRetry() **不看视图**;owedRead 记账
//   「还欠一次自读」。反向闸门(getState 抛错)+ 全部订阅先于首读失败 + resolved 视图下
//   分歧自读失败,三例。
//   变异:catch 里删 scheduleRetry / 给 scheduleRetry 加视图门 -> 红。
// C 「至多一个 owner:一条 timer、一条桥订阅」
//   强制:模块级单例 + timer 幂等守卫;多消费侧共享例 + 入口枚举 ratchet。
//   变异:桥订阅不再单例 -> 红。
// D 「owner 自读 single-flight:在途期间的新请求只记账,回来若已欠账就丢弃并补发」
//   —— 保证「最后发出的那次读」才是定案的那次,不依赖任何「先返回 = 更新」的假定。
//   强制:reading 闸住并发;owedRead 记在途期间的欠账;回来先看 owedRead 再决定采信。
//   「引导 / 新订阅者不误伤在途读」同样由**补发**保证,不靠编号。
//   变异:去掉 single-flight 闸(并发自读)/ 回来不看 owedRead / 引导后不补自读 -> 各自转红。
// E 「送达对单个订阅者抛错免疫」——广播与迟到订阅者的首值回放**同一条送达路径**。
//   强制:deliver() 逐个 try/catch;广播抛错例 + 迟到订阅者回放抛错例。
//   变异:deliver 去掉 try/catch / 回放绕过 deliver -> 各自转红。
// F 「owner 定夺前,分歧一律呈现更保守的那份」(fail-closed 语义不得被乐观视图放行)
//   强制:reconcileAuthSnapshot 分歧时返回 unresolved 的那一份,并记 divergedFromView,
//   使下一次定夺**即使签名未变也广播**(否则消费侧永久停在保守值上)。
//   变异:分歧时返回 lastState / 不记 divergedFromView -> 各自转红。
// G 「广播的判据必须至少与 main 的 publish 判据一样细」
//   强制:签名含 status/mode/platformStatus/email/**plan**(与 main publish 的身份签名对齐)。
//   变异:签名去掉 plan -> 红(同邮箱 free->pro 被判一致而不广播)。
//
// 刻意**不**依赖:`status === "logged-in"`(登出态若带 recovering,漏探才是危险方向);
// preload 一定会回放(owner 每次挂载自己读一次);main 会再发一次 ready(它不会);
// expiresAt 单调(见上)。

type AuthListener = (state: AuthState) => void

const listeners = new Set<AuthListener>()
let bridgeUnsubscribe: (() => void) | undefined
let lastState: AuthState | undefined
/** single-flight:是否已有一次 owner 自读在途(不变量 D)。 */
let reading = false
/** 在途读发出之后又欠下的一次读(新证据或新订阅者)。settle() 据此不得让 owner 退场。 */
let owedRead = false
/** 上次交给消费侧的答案不是 owner 视图(保守回退)——下次定夺必须广播,哪怕签名没变。 */
let divergedFromView = false
let probeTimer: ReturnType<typeof setTimeout> | undefined
let probeAttempt = 0

/** 判据粒度对齐 main/alpha-auth.ts publish() 的身份签名(含 plan),否则它播了本侧却吞掉。 */
const signatureOf = (state: AuthState) =>
  [state.status, state.mode, state.platformStatus ?? "ready", state.account?.email ?? "", state.account?.plan ?? ""].join(
    "\u0000",
  )

/** owner 必须继续跑的两种视图:还不知道现值,或现值是 recovering。 */
const unresolved = (state: AuthState | undefined) => state === undefined || state.platformStatus === "recovering"

function cancelProbe() {
  if (probeTimer !== undefined) clearTimeout(probeTimer)
  probeTimer = undefined
  probeAttempt = 0
}

/** 排下一次自读。**不看当前视图** —— 失败/被作废后的续跑靠它,不得静默退场(不变量 B)。 */
function scheduleRetry() {
  if (probeTimer !== undefined) return
  if (listeners.size === 0) return
  probeTimer = setTimeout(runProbe, nextEngineRetryDelay(probeAttempt++))
}

/** 有证据提出了尚未定夺的问题 —— 立刻自读;同一 tick 内的多个提示合并成一次。 */
function probeNow() {
  if (listeners.size === 0) return
  if (probeTimer !== undefined) clearTimeout(probeTimer)
  probeTimer = setTimeout(runProbe, 0)
}

/** owner 去留:视图未定或还欠一次自读,就不许退场(不变量 B)。 */
function settle() {
  if (unresolved(lastState) || owedRead) scheduleRetry()
  else cancelProbe()
}

/** 唯一送达路径:逐个隔离,任一订阅者抛错都不得波及其余订阅者或 owner(不变量 E)。 */
function deliver(listener: AuthListener, state: AuthState) {
  try {
    listener(state)
  } catch (error) {
    console.error("auth-recovery: 订阅者处理 auth 现值时抛错,其余送达继续", error)
  }
}

function broadcast(state: AuthState) {
  for (const listener of Array.from(listeners)) {
    if (listeners.has(listener)) deliver(listener, state)
  }
}

/**
 * 接纳一个现值。广播推迟一个微任务:reconcileAuthSnapshot 由消费侧在自己函数体里同步调用,
 * 同步回调会重入消费侧。settle() 排在广播之后,并由 owedRead 兜底 —— 广播途中新提出的自读
 * 不会被这次 settle 取消。
 */
function accept(state: AuthState) {
  const changed = lastState === undefined || signatureOf(lastState) !== signatureOf(state)
  lastState = state
  if (!changed && !divergedFromView) {
    settle()
    return
  }
  divergedFromView = false
  queueMicrotask(() => {
    broadcast(state)
    settle()
  })
}

/** 外部快照入口(桥回放 / main 推送 / 消费侧自读)—— 只当提示,判据见文件头。 */
function ingestHint(state: AuthState) {
  if (lastState === undefined) {
    // 引导:先给消费侧一个可用值,但它仍是未经证实的快照 -> 立刻补一次自读去证实。
    owedRead = true
    accept(state)
    probeNow()
    return
  }
  // 与视图一致的 hint 也是在途读之后到达的新证据:该读可能比它更旧,记账并补发。
  if (signatureOf(state) !== signatureOf(lastState) || reading) {
    owedRead = true
    probeNow()
  }
}

/** 自读入口:同一时刻只放行一次(不变量 D)。在途期间的请求只记账,由那次读回来后补发。 */
function requestRead() {
  if (listeners.size === 0) return
  if (reading) {
    owedRead = true
    return
  }
  void runRead()
}

async function runRead() {
  reading = true
  // 这一次读就是来回答「到此刻为止」的全部欠账;此后新记的账才需要下一次读。
  owedRead = false
  let next: AuthState
  try {
    next = await window.api.auth.getState()
  } catch {
    reading = false
    // 桥暂时不可达不是终局(不变量 B):欠账保留,退避续跑。反向闸门覆盖此分支。
    owedRead = true
    scheduleRetry()
    return
  }
  reading = false
  if (listeners.size === 0) {
    cancelProbe()
    return
  }
  if (owedRead) {
    // 在途期间又有新证据/新请求 -> 这次读到的可能更旧,丢弃并立刻补发(不变量 D)。
    probeNow()
    return
  }
  accept(next)
}

function runProbe() {
  probeTimer = undefined
  requestRead()
}

/**
 * renderer 侧订阅 auth 现值的**唯一**入口。语义与 `window.api.auth.subscribe` 相同(含首值送达),
 * 额外挂上共享的有界自探 owner。
 */
export function subscribeAuthState(listener: AuthListener): () => void {
  listeners.add(listener)
  // 桥订阅是模块级单例:live 事件与回放都只进 owner,消费侧看到的一律是 owner 序列化后的现值。
  if (!bridgeUnsubscribe) bridgeUnsubscribe = window.api.auth.subscribe(ingestHint)
  const known = lastState
  // 迟到订阅者的首值回放走与广播同一条送达路径(不变量 E),不得裸调 listener。
  if (known !== undefined) queueMicrotask(() => listeners.has(listener) && deliver(listener, known))
  // 每次挂载 owner 自己读一次现值:既不依赖桥回放,也补上挂载窗口里丢掉的事件。
  requestRead()
  settle()
  let released = false
  return () => {
    if (released) return
    released = true
    listeners.delete(listener)
    if (listeners.size > 0) return
    bridgeUnsubscribe?.()
    bridgeUnsubscribe = undefined
    cancelProbe()
  }
}

/**
 * 消费侧自己读到的一份 auth 快照:交给 owner 过同一条判据,并取回**可以据以推进业务**的现值。
 * 分歧时不返回 owner 的乐观视图 —— 两份证据无序,定夺之前一律呈现更保守的那份(不变量 F),
 * 「过期、未验证的 token 绝不呈现为可用」这条既有合同不因为 owner 恰好还没收到坏消息而破例。
 */
export function reconcileAuthSnapshot(snapshot: AuthState): AuthState {
  ingestHint(snapshot)
  const view = lastState
  if (view === undefined) return snapshot
  if (signatureOf(view) === signatureOf(snapshot)) return view
  const conservative = unresolved(snapshot) ? snapshot : unresolved(view) ? view : snapshot
  // 给出去的答案不是 owner 视图:下次定夺必须广播,否则消费侧永久停在这个保守值上。
  if (signatureOf(conservative) !== signatureOf(view)) divergedFromView = true
  return conservative
}

/** 测试用:清空模块级单例。 */
export function resetAuthRecoveryForTests() {
  listeners.clear()
  bridgeUnsubscribe?.()
  bridgeUnsubscribe = undefined
  lastState = undefined
  reading = false
  owedRead = false
  divergedFromView = false
  cancelProbe()
}
