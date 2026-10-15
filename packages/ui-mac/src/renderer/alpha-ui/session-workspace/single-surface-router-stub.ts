// @solidjs/router 在单一审批面运行时闸门 bundle 里的替身(#619 R1 Blocker 复审)。
// 生产 SessionComposerDock 只消费 useNavigate(子会话条跳转);闸门场景不导航,
// 真实 Router 上下文与被测行为无关。

export function useNavigate() {
  return (..._args: unknown[]) => {}
}

// REQ-234 `#1531`:审批面现在会挂定制中心安装确认框的守望者(只对 metadata.alphaHub 请求渲染),它读当前路由的项目目录;
// 闸门场景不发这类请求,给一个无项目的路由即可。
export function useLocation() {
  return { pathname: "/" }
}
