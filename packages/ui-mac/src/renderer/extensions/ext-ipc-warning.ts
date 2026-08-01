// `#765`:扩展 IPC 的 warning 呈现咽喉(纯逻辑;绑定在 ext-ipc.ts,那里才碰 window/Toast)。
//
// 背景:`ActionResult` 的定义从一开始就写着「调用方**必须**呈现,不得静默吞掉」,而 REQ-128
// Phase 2 期间连着栽了三次 —— 六个调用点里只有一个照做。逐调用点写一行的形态**结构性**地错:
// 枚举对新成员默认放行(新加一条分支/一个入口,默认就是「忘了呈现」)。所以呈现不再是调用方
// 的责任,而是这一层的:凡是从扩展 IPC 面回来的东西带着具名 warning,这里统一呈现。
//
// 关键性质是**不按方法名枚举**:没有「哪些 IPC 会带 warning」的名单。判据只看回来的值 ——
// 任何方法(包括明天才加的那个)只要成功响应里有一条非空 `warning` 字符串,就会被呈现。
// 名单是枚举(新成员默认放行);看值是咽喉(新成员默认覆盖)。
//
// 复数 `warnings` 故意**不**在此列:`listInstalls` 的 `InstallLedgerView.warnings` 与
// `projectResidualsCheck` 的 `warnings` 是成批的诊断清单,有各自的呈现位置,不是「这次操作
// 成功了但有件事你得知道」的单条 loud 信号。把它们卷进来只会让 toast 变成噪音。

/** 一次 IPC 返回值里那条**具名**警告(非字符串 / 空白 / 复数 `warnings` 一律不算)。 */
export function actionWarningOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const warning = (value as { warning?: unknown }).warning
  if (typeof warning !== "string") return undefined
  return warning.trim().length > 0 ? warning : undefined
}

/** 呈现(如果有),再把值**原样**交回去 —— 这一层只观察,不改写调用方看到的结果。 */
export function presentActionWarning<T>(value: T, present: (warning: string) => void): T {
  const warning = actionWarningOf(value)
  if (warning !== undefined) present(warning)
  return value
}

const isThenable = (value: unknown): value is Promise<unknown> =>
  !!value && (typeof value === "object" || typeof value === "function") && typeof (value as { then?: unknown }).then === "function"

/**
 * 把整个 ext IPC 面包成「回什么都先过一遍 warning 呈现」的同形替身。
 *
 * `readExt` 每次调用时**重新读**底层对象,不在模块加载时抓一次:contextBridge 注入发生在
 * renderer 脚本之前没错,但组件测试是先加载模块、后铺 `window.api` 的,提前抓会拿到 undefined。
 *
 * 用 Proxy 而不是逐方法转发,也是同一条纪律:逐方法转发是一份名单,漏掉新方法不会红。
 */
export function warningPresentingExt<Api extends object>(
  readExt: () => Api,
  present: (warning: string) => void,
): Api {
  return new Proxy({} as Api, {
    get(_target, property) {
      const ext = readExt() as Record<PropertyKey, unknown>
      const member = ext[property]
      // 非函数成员原样透出(今天没有,但不该由本层决定它不能存在)。
      if (typeof member !== "function") return member
      return (...args: unknown[]) => {
        // `Reflect.apply` 而不是 `member.apply(...)`:后者要先**读** member 的 `apply` 属性,
        // 而 member 可能本身就是个 Proxy(contextBridge 的替身、组件测试里的 IPC 桩都是),
        // 那一读就被它的 get 陷阱接管,调到的根本不是这个函数。实测:overlay-close 的 IPC 桩
        // 把 `.apply` 解析成又一个 IPC 节点,于是订阅方法返回 Promise 而不是退订函数,
        // 整个覆盖层挂载在 Solid 的 cleanup 阶段炸掉。
        const returned = Reflect.apply(member as (...rest: unknown[]) => unknown, ext, args)
        // 同步返回的通道(如 onSessionGrantsEnded 回退订阅函数)同样走一遍,判据一致。
        return isThenable(returned)
          ? returned.then((settled) => presentActionWarning(settled, present))
          : presentActionWarning(returned, present)
      }
    },
  })
}
