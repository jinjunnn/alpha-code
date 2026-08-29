/**
 * REQ-108(#244 / #1173)—— renderer 侧的「强模态在场」信号。
 *
 * 为什么需要它:右栏文件查看器的 html/pdf 预览是 main 侧的 WebContentsView
 * (`main/rail-preview-host.ts`),它叠在窗口的**原生层级**上 —— 它不是 DOM 的一部分,
 * renderer 里任何 z-index / inert / aria-hidden 都管不到它。强模态弹出时若不主动把它藏起来,
 * 用户看到的是「预览层盖住了审批弹窗」。main 侧的执行面(`setRailPreviewVisible`)早就在,
 * 缺的只是 renderer 里一个「现在有强模态」的共同真相 —— 就是这个模块。
 *
 * 这不是窗口层管理框架:一个计数器 + 一组订阅者,生产者与消费者都在本仓内点名。
 *   · 生产者①:`dialog-core` 的模态栈 —— 每一个 `alpha-ui/Dialog`(权限审批 PermissionDialog、
 *     能力授权 ext-authz、上传同意、上游 dialog host、会话搜索、扩展导入)都经 registerDialog。
 *   · 生产者②:`settings` 全屏面 —— 自报 role=dialog + aria-modal=true 且 position:fixed inset:0。
 *   · 消费者:`session-rail/files/file-viewer-view` 的 OverlayRegion(转发 railPreview.setVisible)。
 * 非模态浮层(tooltip / 下拉 / toast)与 role=region 的全屏面(扩展中心、自动化面板)不在此列。
 */

let depth = 0
const listeners = new Set<(present: boolean) => void>()

/** 当前是否有强模态在场。 */
export function modalPresent() {
  return depth > 0
}

/**
 * 声明进入强模态。返回**幂等**的退出函数 —— 重复调用只生效一次,
 * 免得某个组件的 cleanup 跑两遍就把计数器压到负数、从此永远「无模态」。
 */
export function enterModal(): () => void {
  depth += 1
  if (depth === 1) notify()
  let released = false
  return () => {
    if (released) return
    released = true
    depth -= 1
    if (depth === 0) notify()
  }
}

/** 订阅在场状态的**变化**(0↔非 0 的沿);当前值自己读 `modalPresent()`。 */
export function subscribeModalPresence(listener: (present: boolean) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function notify() {
  const present = depth > 0
  for (const listener of [...listeners]) listener(present)
}
