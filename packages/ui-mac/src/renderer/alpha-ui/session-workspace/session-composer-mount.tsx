// SessionComposerMount — REQ-125 C558:seam 会话页 composer 的挂载包装。
//
// child-session 门翻转会**卸载** composer(保持子会话零可发送路径),per-identity 草稿暂存据此在
// 卸载捕获、门翻回注入。关键:**composer 实例按身份 keyed**——外层 `<Show keyed>` 以 identityKey
// 为 key。身份切换 = 旧实例卸载(cleanup 用它自身 keyed 定格的 mountedKey 捕获,归属天然正确)+
// 新实例挂载(restore 新身份草稿)。键与实例生命周期一致,消除「键定格 A、目录响应式切 B」的分裂
// (切 B 后继续编辑再卸载,草稿正确落 B 键)。身份 undefined 时不挂 composer(轻占位,身份到达即
// 挂;路由解析瞬时,不构成可感知延迟,亦避免空键丢弃)。

import { createMemo, Show } from "solid-js"
import type { AlphaProjectsApi } from "../../sidebar/use-projects"
import { AlphaComposer, type ComposerSessionDockApi } from "../alpha-composer"
import type { createComposerDraftStash } from "./session-dock-core"
import { type AlphaSessionIdentity, identityKey } from "./session-workspace-core"

export interface SessionComposerEditRequest {
  identityKey: string
  revision: number
  text: string
}

export function SessionComposerMount(props: {
  identity: () => AlphaSessionIdentity | undefined
  projects: AlphaProjectsApi
  dock: ComposerSessionDockApi
  drafts: ReturnType<typeof createComposerDraftStash>
  editRequest?: () => SessionComposerEditRequest | undefined
}) {
  const mount = createMemo(
    () => {
      const key = identityKey(props.identity())
      if (!key) return undefined
      const edit = props.editRequest?.()
      if (edit?.identityKey === key) return { key, revision: edit.revision, initialText: edit.text }
      return { key, revision: 0, initialText: props.drafts.restore(key) }
    },
    undefined,
    {
      // current() 会随会话 activity/title 刷新并重建 identity 对象；同一 I8 key + edit
      // revision 必须保留原 composer 实例，否则一次状态事件就会误卸载并覆盖正在输入的草稿。
      equals: (previous, next) => previous?.key === next?.key && previous?.revision === next?.revision,
    },
  )
  return (
    <Show when={mount()} keyed fallback={<div class="a-swk-composer-pending" aria-hidden="true" />}>
      {(mounted) => (
        <AlphaComposer
          mode="session"
          projects={props.projects}
          directory={() => props.identity()?.directory}
          sessionID={() => props.identity()?.sessionID}
          // #891:composer 的档位/只读档作用域按 canonical 身份键持有,身份的第三段在这里交给它
          // —— 本组件已经拿着权威 identity(上面 keyed 用的就是它的 identityKey)。
          serverKey={() => props.identity()?.serverKey}
          sessionDock={props.dock}
          initialText={mounted.initialText}
          onDraftCapture={(draft) => props.drafts.capture(mounted.key, draft)}
        />
      )}
    </Show>
  )
}
