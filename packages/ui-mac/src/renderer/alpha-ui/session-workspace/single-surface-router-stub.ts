// @solidjs/router 在单一审批面运行时闸门 bundle 里的替身(#619 R1 Blocker 复审)。
// 生产 SessionComposerDock 只消费 useNavigate(子会话条跳转);闸门场景不导航,
// 真实 Router 上下文与被测行为无关。

export function useNavigate() {
  return (..._args: unknown[]) => {}
}
