// #668 双通道审批闸门的运行时入口。
//
// 挂的是**生产接线点本体** `createPermissionSurfaceMount(PermissionWatcher)` —— 也就是
// app.tsx 在真实应用里调的那一个工厂,配上生产 PermissionWatcher / PermissionDialog。
// 宿主上下文(useParams / useSDK / useSync)由 vite alias 换成 permission-dual-channel-stub,
// 其余一行不改。

import { render } from "solid-js/web"
import { createPermissionSurfaceMount } from "../../../../app/src/context/permission-surface"
import { PermissionWatcher } from "./permission-watcher"

export { render }
export * from "./permission-dual-channel-stub"
export { observeThroughStore } from "./permission-store-observation"

const Mount = createPermissionSurfaceMount(PermissionWatcher)

export function DualChannelHarness() {
  return (
    <div data-harness-dual-channel>
      <Mount />
    </div>
  )
}
