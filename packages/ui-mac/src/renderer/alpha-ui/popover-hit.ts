// popover-hit — REQ-061:composer 弹层 click-outside 判定(纯逻辑,DOM-free 可单测)。
//
// 背景(B21 真机 3 次复现):document 级 click listener 以 e.target.closest(".a-pop") 判内外;
// Solid 委托事件下,点击处理器**同步重渲染**会把被点按钮从 DOM detach → 事件冒泡到 document 时
// target 已脱离文档树 → closest 返回 null → 误判「外部点击」→ 整层弹窗误关(改键表单入口不可达)。
// `.a-pop` 内部的 stopPropagation 拦不住 document 上的另一个 listener。
//
// 修法:e.composedPath() 在事件 dispatch 时**快照**整条路径,对后续 detach 免疫 —— 路径中任一
// 节点命中弹层类(.a-pop / .a-pop-wrap)即视为内部点击,不关层。

/** 结构性最小接口:任何带 classList.contains 的节点(真 DOM Element 天然满足;测试可用假对象)。 */
type ClassLike = { classList?: { contains(cls: string): boolean } }

export const POP_CLASSES = ["a-pop", "a-pop-wrap"] as const

/** composedPath 快照中是否含弹层节点(内部点击 → 不关层)。window/document 等无 classList 的
 *  路径节点直接跳过。 */
export function pathHitsPopover(path: readonly unknown[]): boolean {
  for (const node of path) {
    const cl = (node as ClassLike)?.classList
    if (!cl || typeof cl.contains !== "function") continue
    if (POP_CLASSES.some((c) => cl.contains(c))) return true
  }
  return false
}
