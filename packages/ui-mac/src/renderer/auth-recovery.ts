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
//   **至多一个在途读;有欠账时,只有呈现序 ⊑ 视图的读允许先行采信,其余必须由后读确认。**
//   owner 同一时刻只允许一次自读在途(single-flight)。在途期间的任何新请求/新证据只记
//   `owedRead`;该次读回来时若 owedRead 已置位,它就**可能更旧**,不得据以呈现任何新东西。
//   「保守」不是形态枚举(#612 R1 Blocker:recovering 形态照样携带 logged-in/platform 身份,
//   真实消费侧只凭 status / status+mode 放行,跨身份呈现它就是 fail-open),而是**呈现序**:
//   只有相对当前视图不呈现任何新身份、仅把 platformStatus 收紧为 recovering 的读
//   (next ⊑ view,见 yieldsNoNewGrants)允许先行采信 —— 无论消费侧按哪个轴放行,看到的
//   都不比视图已呈现的更多,且 recovering 保证 owner 续跑纠正(不变量 H)。视图未建立时,
//   欠账只可能来自挂载请求而非证据(结构保证:任何证据到达都先经 ingestHint 建立视图),
//   该读就是 renderer 手上最新的证据,recovering 允许引导。其余一律由**后发出**的读定夺;
//   连续被作废的读转入退避(staleReads),证据风暴下不热循环(不变量 H)。不需要编号。
//
// 外部快照(前三类)一律只当**提示**,不当真值:
//   - 视图空着       -> 先采信它引导(消费侧立刻有值可用),同时欠一次自读去证实;
//   - 与视图一致     -> 若有在途自读(已被本条证据作废),补一次自读;否则无事;
//   - 与视图不一致   -> **不采信**,owner 立刻自读定夺。
// 只有 owner 的自读会被接纳为视图。这条判据对所有入口一视同仁,所以迟到的陈旧快照既不会
// 把已 ready 的能力打回 recovering,也不会把 recovering 放行成 ready(后者更危险);
// 登录态轴同理:迟到的 logged-in/logged-out 翻不动更新的视图,**跨身份的 recovering
// (如视图 logged-out、快照 logged-in/recovering)同样翻不动**(#612 R1)。
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
// D 「至多一个在途读;有欠账时,只有呈现序 ⊑ 视图的读允许先行采信,其余必须由后读确认」
//   —— 定案权落在最后发出的那次读,不依赖任何「先返回 = 更新」的假定。
//   强制:reading 闸住并发;owedRead 记在途期间的欠账;回来先看 owedRead 再按呈现序决定采信。
//   「引导 / 新订阅者不误伤在途读」同样由**补发**保证,不靠编号。
//   变异:去掉 single-flight 闸(并发自读)/ 回来不看 owedRead(实跑,R1 修复轮)/
//   引导后不补自读 -> 各自转红。
// E 「送达对单个订阅者抛错免疫」——广播与迟到订阅者的首值回放**同一条送达路径**。
//   强制:deliver() 逐个 try/catch;广播抛错例 + 迟到订阅者回放抛错例。
//   变异:deliver 去掉 try/catch / 回放绕过 deliver -> 各自转红。
// F 「分歧时只呈现有定序保证的证据:owner 视图;唯一例外是呈现序 ⊑ 视图的快照」(#612)
//   强制:reconcileAuthSnapshot 分歧时返回视图;仅当快照相对视图**同身份且只把 platformStatus
//   收紧为 recovering**(yieldsNoNewGrants)才返回快照 —— 它不呈现任何新身份、只收紧权限,
//   且 owner 必然续跑纠正。按 unresolved **形态**枚举放行是 R1 Blocker:跨身份的 recovering
//   (视图 logged-out、快照 logged-in/recovering)对凭 status/mode 放行的真实消费侧
//   (AlphaOnboarding / extension-hub cloudReady)就是 fail-open。返回值不是视图时记
//   divergedFromView,使下一次定夺**即使签名未变也广播**(否则消费侧永久停在保守值上)。
//   变异(均实跑,R1 修复轮):回到 unresolved 形态枚举 / 同身份收紧快照也返回视图 /
//   不记 divergedFromView -> 各自转红。
// G 「广播的判据必须至少与 main 的 publish 判据一样细」
//   强制:签名含 status/mode/platformStatus/email/**plan**(与 main publish 的身份签名对齐)。
//   变异:签名去掉 plan -> 红(同邮箱 free->pro 被判一致而不广播)。
//
// H 「owner 必须有产出:证据持续到达时不得既不采信也不停手,也不得热循环」
//   强制:自读回来若已欠账,呈现序 ⊑ 视图的读先采信(owner 一定有产出),其余重读;
//   probeNow 在自读在途时是 no-op;连续两次被作废的读转入退避(staleReads)——
//   三者合起来既不饿死也不热循环(包括登录态轴风暴:那类读一律不可先采,只能靠退避封顶)。
//   变异(均实跑,R1 修复轮):⊑ 视图的读也拒绝(H 用例收不到 recovering)/
//   去掉 staleReads 退避升级(登录态轴风暴用例读取次数爆炸)/ probeNow 在途仍另排 ->
//   各自转红。
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
/** 连续被作废(欠账 + 呈现序不允许先采)的自读次数 —— 第二次起转入退避,证据风暴下不热循环。 */
let staleReads = 0
let probeTimer: ReturnType<typeof setTimeout> | undefined
let probeAttempt = 0

/** 判据粒度对齐 main/alpha-auth.ts publish() 的身份签名(含 plan),否则它播了本侧却吞掉。 */
const signatureOf = (state: AuthState) =>
  [state.status, state.mode, state.platformStatus ?? "ready", state.account?.email ?? "", state.account?.plan ?? ""].join(
    "\u0000",
  )

/** 身份轴 = 签名去掉 platformStatus:status / mode / email / plan。呈现序只在同身份内比较。 */
const identityOf = (state: AuthState) =>
  [state.status, state.mode, state.account?.email ?? "", state.account?.plan ?? ""].join("\u0000")

/**
 * 呈现序 ⊑(#612 R1):candidate 相对 view **不呈现任何新身份、不放宽任何权限轴** ——
 * 身份轴全等,且 platformStatus 是收紧方向的 recovering。消费侧的放行判据各不相同
 * (AlphaOnboarding 凭 status、extension-hub cloudReady 凭 status+mode、composer 凭
 * platformStatus),只有这种候选无论按哪个轴看都 ≤ 视图已呈现的内容,才允许在时间序
 * 不可证时先行呈现;其余一律呈现视图。这是相对视图的**定序判据**,不是快照形态枚举 ——
 * 按形态枚举正是 R1 Blocker:recovering 形态自带 logged-in/platform 身份,跨身份呈现即 fail-open。
 */
const yieldsNoNewGrants = (candidate: AuthState, view: AuthState) =>
  candidate.platformStatus === "recovering" && identityOf(candidate) === identityOf(view)

/**
 * owner 必须继续跑的两种视图:还不知道现值,或现值是 recovering。**只管 owner 的去留
 * (settle),不管呈现**:呈现哪个值由呈现序(yieldsNoNewGrants)相对视图裁决 —— 曾用本
 * 形态枚举分流呈现,是 R1 Blocker。**不要**把 logged-out 加进来:它是终态不是恢复中态,
 * 对它自探没有意义 —— 它的定序保护与其他形态一样走呈现序(#612)。
 */
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
  // 已有自读在途:它回来时会按 owedRead 处理这笔欠账。再排一次 0ms 只会把 timer 反复前移,
  // 在「证据持续到达」下形成每毫秒一次的热循环(实测 200ms 内 201 次读取)。
  if (reading) return
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
    // 在途期间又有新证据/新请求 -> 这次读到的可能更旧,不得据以呈现任何新东西。但「一律丢弃
    // 并重读」会在证据持续到达时把 owner 饿死:实测持续翻转下 201 次读取只广播 1 次 —— 这正是
    // 本票要消灭的「owner 不给答案」缺陷换了个触发条件(不变量 H)。可先行采信的**不是某种
    // 形态**(R1 Blocker:按 unresolved 枚举放行了携带 logged-in/platform 身份的跨身份
    // recovering,凭 status/mode 放行的消费侧当场 fail-open),而是**呈现序 ⊑ 视图**的读:
    //   - 视图已建立:仅当该读相对视图同身份、只把 platformStatus 收紧为 recovering
    //     (yieldsNoNewGrants)才先采信 —— 无论消费侧按哪个轴放行都拿不到新东西,
    //     且 recovering 保证 owner 续跑纠正;
    //   - 视图未建立:欠账只可能来自挂载请求而非证据(任何证据都先经 ingestHint 建立视图),
    //     该读就是 renderer 手上最新的证据,recovering 允许引导(不变量 H:必须有产出);
    //   - 其余一律由后发出的读定夺:首次立刻重读(probeNow 在途是 no-op,不热循环),
    //     连续第二次被作废转入退避 —— 登录态轴风暴下读取次数必须有界(不变量 H)。
    const presentable =
      lastState === undefined ? next.platformStatus === "recovering" : yieldsNoNewGrants(next, lastState)
    if (presentable) {
      staleReads = 0
      accept(next)
      return
    }
    staleReads += 1
    if (staleReads >= 2) scheduleRetry()
    else probeNow()
    return
  }
  staleReads = 0
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
 * 两份证据无序,任何比当前证据更旧的快照都不得被呈现(#612 / 基线 rev2c ③″2-8),而快照
 * 没有可证的新旧 —— 所以分歧时只呈现有定序保证的 owner 视图:迟到的 logged-in/ready 不得把
 * logged-out 放行回已登录,迟到的 logged-out 也不得翻掉更新的登录视图。唯一例外按**呈现序**
 * 而非形态:快照相对视图**同身份、仅把 platformStatus 收紧为 recovering**(snapshot ⊑ view,
 * yieldsNoNewGrants)时呈现快照 —— 「过期、未验证的 token 绝不呈现为可用」这条既有合同不因为
 * owner 恰好还没收到坏消息而破例,而这种快照对凭 status / status+mode / platformStatus 放行的
 * 任何消费侧都不多放行任何东西。跨身份的 recovering(如视图 logged-out、快照
 * logged-in/recovering)不在例外内:真实消费侧只凭 status/mode 放行,呈现它就是把登录态轴
 * fail-open(R1 Blocker)。真伪不在这里裁决:ingestHint 已为分歧欠下一次自读,
 * 由后发出的读定夺并广播纠正。
 */
export function reconcileAuthSnapshot(snapshot: AuthState): AuthState {
  ingestHint(snapshot)
  const view = lastState
  if (view === undefined) return snapshot
  if (signatureOf(view) === signatureOf(snapshot)) return view
  // #612(R1):分歧时按呈现序裁决,不按 unresolved 形态枚举 —— 快照可能更旧,只有 ⊑ 视图
  // (不呈现任何新身份、只收紧 platformStatus)的快照允许代替视图呈现,其余一律呈现视图。
  const conservative = yieldsNoNewGrants(snapshot, view) ? snapshot : view
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
  staleReads = 0
  cancelProbe()
}
