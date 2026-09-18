// `#1361` —— 壳层「此刻站在哪个会话、哪个目录」的唯一登记处。
//
// 为什么需要它:设置面(`<SettingsSurface/>`)是 `AppInterface` 的 children,渲染在 `ServerShell`
// (QueryProvider + SharedProviders)里,而 `ServerSyncProvider` 只挂在**路由子树**上
// (`packages/app/src/app.tsx` 的 `TargetServerRoute` / `SelectedServerProviders` / 草稿路由)。
// 所以设置面**结构上**拿不到 `useServerSync()` —— 会话页认的那份目录真相
// (`serverSync().session.data.info[id].directory`)它读不到,只能读侧栏项目清单;而那份清单被
// `sidebar/worktree-filter.ts` 按设计过滤(归档项目 / 以家目录为根 / 全局 `/` 桶),于是
// 「会话页里用得好好的会话,设置页『工具』节却只剩『先打开一个项目』」。
//
// 修法不是放宽过滤(那是侧栏自己的设计,且它挡的是家目录递归 watcher),也不是让设置面另建一份
// 真相:**会话页(唯一持有 ServerSync 的那一面)把它此刻解出的身份登记在这里**,设置面在侧栏清单
// 缺这一格时回落到它 —— 两个面读的因此是同一个值,不是两份可能分叉的真相。
//
// fail-closed 不变:没有登记、或登记的不是这个会话 ⇒ undefined ⇒ 设置页仍然拒绝,绝不落到默认项目。
// 一个 renderer 里只有一份(同 settings-state / sandbox-state 的壳层信号形态)。

import { createSignal } from "solid-js"
import type { AlphaSessionIdentity } from "./session-workspace/session-workspace-core"

const [active, setActive] = createSignal<AlphaSessionIdentity | undefined>(undefined)

/** 会话页的唯一写入点:解出身份时登记,离开会话页 / 解不出身份时传 undefined 注销。 */
export function publishActiveSessionIdentity(identity: AlphaSessionIdentity | undefined): void {
  setActive(identity)
}

/** 壳层读取点。signal 而非普通变量:设置面开着时切会话,消费者要跟着重算。 */
export function activeSessionIdentity(): AlphaSessionIdentity | undefined {
  return active()
}
