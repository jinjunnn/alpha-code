// #927:默认服务器身份切换吃掉首页草稿 —— 丢弃语义保持,但不再静默(owner 裁决)。
//
// 背景:默认服务器指向 WSL/远程时,那台是**异步就绪**的 —— 开机时不在、一两秒后才出现。
// 用户这一两秒里已经落在首页开始打字;WSL 一就绪,`renderer/index.tsx` 的
// `<Show when={effectiveDefaultServer()} keyed>` 因 key 翻转而整树重挂。**重挂本身是对的**
// (服务器身份真的换了,见 #565 控制组的实测),错的是没人管那份草稿:首页 composer 的文本是
// 组件本地信号,新对话页/会话页各有 remount stash,首页没有 —— 打了一半的字静默蒸发。
//
// owner 裁决(#927):三选一(跟过去 / 留在原身份 / 丢弃并提示)裁了**丢弃,但先提示**。
// 所以这里刻意**不还原**草稿,只在「切换那一拍确实丢了未发送内容」时给用户一句说明。
//
// 「切换那一拍」怎么判(反向判据:没有身份切换不得出现这句提示):
//   keyed 重挂时,旧树的 dispose(含 composer onCleanup → onDraftSnapshot)与本模块监听
//   key 变化的 createEffect 落在**同一个同步 flush** 里(Solid 1.9.10 keyed Show 次序
//   「旧 cleanup → 新建 → 新 mount」经独立探针确认,见 new-session-draft-stash.ts 抬头)。
//   flag 在快照落地时置起、并排一个 microtask 自清 —— microtask 严格晚于当前 flush,
//   所以:切换引发的卸载,effect 在同 flush 内读到 flag ⇒ 提示;导航等其它原因的卸载,
//   没有 key 翻转、flag 在下一个 microtask 无人读地自清 ⇒ 永不误报(把导航丢的草稿
//   算到后来某次切换头上,是错误归因)。
//
// 提示走全局 Toast store(模块级 signal):push 发生在旧树 dispose 期间,而 ToastViewport
// 挂在 keyed 树内会随之重建 —— store 在组件外,新 viewport 挂上来照样渲染这条,不会被
// 重挂自己冲掉。

import { createEffect } from "solid-js"
import { t } from "../i18n"
import { pushToast } from "./Toast"

// 一次性 flag:首页 composer 在「卸载那一刻还有未发送内容」。只活到当前同步 flush 结束。
let unsentDraftAtUnmount = false

/** 首页宿主接在 `AlphaComposer` 的 `onDraftSnapshot` 上(卸载时回报完整草稿)。
 *  判「有内容」与 new-session-draft-stash 的 isEmpty 同形(文本/mention/附件/在途读盘
 *  四路任一非空);文本单独 trim —— 纯空白不是用户会心疼的内容,不该为它弹提示。 */
export function noteHomeComposerUnmountDraft(draft: {
  text: string
  mentions: readonly unknown[]
  attachments: readonly unknown[]
  pendingReads: readonly unknown[]
}): void {
  const hasContent =
    draft.text.trim().length > 0 ||
    draft.mentions.length > 0 ||
    draft.attachments.length > 0 ||
    draft.pendingReads.length > 0
  if (!hasContent) return
  unsentDraftAtUnmount = true
  queueMicrotask(() => {
    unsentDraftAtUnmount = false
  })
}

/** 装在 `renderer/index.tsx` App() 的响应图里(keyed Show 之外,唯一跨重挂看得见 key
 *  翻转的位置;harness 复刻同一行,锚点钉在 surface-remount.test.ts)。首个值不算切换
 *  (boot 不是身份变更);key 恒真值(availableStartupServer 兜底 "sidecar"),但仍
 *  fail-closed:任一侧不成立就不弹。 */
export function installHomeDraftDiscardNotice(key: () => string | undefined): void {
  let previous: string | undefined
  createEffect(() => {
    const current = key()
    const before = previous
    previous = current
    if (!before || !current || before === current) return
    if (!unsentDraftAtUnmount) return
    unsentDraftAtUnmount = false
    // 文案要说清「为什么」:是切了服务器,不是 app 抽风。停留给长一点 —— 用户刚丢了正在打的字。
    pushToast({
      kind: "info",
      title: t("alpha.home.serverSwitched"),
      detail: t("alpha.home.serverSwitchedDraftDiscarded"),
      duration: 10_000,
    })
  })
}
