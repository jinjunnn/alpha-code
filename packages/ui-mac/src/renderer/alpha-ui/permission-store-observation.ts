// REQ-090 #561 的测试支撑:复现「请求对象被 solid store 观察过」这一进程内状态。
//
// 这里用的是**真身而不是替身**(不手写一份 solid 文法的仿制品)。实测 solid-js@1.9.10:
// store 的 `wrap()` 在**被读到的那个原始对象自身**上做
// `defineProperty($PROXY, { enumerable: false, writable: false, configurable: false })`,于是
//   · 污染落在原始对象上 —— `unwrap()` 只把顶层换回 raw,不清理已被观察过的嵌套对象;
//   · 该符号键**不可删除也不可重定义**(`delete` 抛 TypeError),一旦发生即永久;
//   · 它被 `Reflect.ownKeys` 计入,却不被 `Object.keys` 计入 —— 这正是 #561 的判据域缺口。
//
// 两个审批 harness(PermissionDialog.test.ts 的 watcher 面、permission-dual-channel.test.ts
// 的生产接线面)共用这一份。

import { createStore } from "solid-js/store"

/**
 * 让一个真实 solid store 读一遍 `value.subject` / `value.scope`,并返回**同一个**原始对象。
 *
 * 等价于生产里任意一处消费者读了这两个字段(例如给审批挂起提示加一句「发起方 agent」)。
 * 返回值与入参是同一个引用:store 并没有复制它,只是在它身上盖了个进程内的章。
 */
export function observeThroughStore<T extends object>(value: T): T {
  const [state] = createStore<{ requests: T[] }>({ requests: [value] })
  const observed = state.requests[0] as Record<string, unknown>
  for (const key of ["subject", "scope"]) {
    const nested = observed[key]
    // 读取本身就是注入点(get trap → wrap → defineProperty);结果无用,过程有用。
    if (nested && typeof nested === "object") void Object.keys(nested)
  }
  return value
}
