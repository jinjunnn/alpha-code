// SessionComposerMount — REQ-125 C558:seam 会话页 composer 的挂载包装。
//
// child-session 门翻转会**卸载** composer(保持子会话零可发送路径)。草稿暂存的身份键必须在
// **挂载时定格**:同 workspace 切会话不重挂,「先 identity=B 再卸 A 的 composer」的时序下,若在
// cleanup 时重读 identity() 会把 A 的草稿写进 B 键。故本包装在 setup(挂载)一次性算出 mountedKey,
// initialText / onDraftCapture 全程用定格键;directory/sessionID 仍随当前身份(composer 跟随会话)。

import type { AlphaProjectsApi } from "../../sidebar/use-projects"
import { AlphaComposer, type ComposerSessionDockApi } from "../alpha-composer"
import type { createComposerDraftStash } from "./session-dock-core"
import { type AlphaSessionIdentity, identityKey } from "./session-workspace-core"

export function SessionComposerMount(props: {
  identity: () => AlphaSessionIdentity | undefined
  projects: AlphaProjectsApi
  dock: ComposerSessionDockApi
  drafts: ReturnType<typeof createComposerDraftStash>
}) {
  // 挂载即定格身份键(闭包定格,I8):卸载时用它捕获草稿,不在 cleanup 重读 identity()。
  const mountedKey = identityKey(props.identity())
  return (
    <AlphaComposer
      mode="session"
      projects={props.projects}
      directory={() => props.identity()?.directory}
      sessionID={() => props.identity()?.sessionID}
      sessionDock={props.dock}
      initialText={props.drafts.restore(mountedKey)}
      onDraftCapture={(draft) => props.drafts.capture(mountedKey, draft)}
    />
  )
}
