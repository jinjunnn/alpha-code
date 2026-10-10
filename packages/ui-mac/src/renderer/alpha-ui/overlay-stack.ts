// #1476(REQ-230 AC1)—— 输入框一带的菜单「同时只开一个」的唯一登记处。
//
// 芯片浮层(模型 / 运行权限 / 思考强度,alpha-composer.tsx)与「+ / @ /」列表
// (composer-autocomplete.tsx)此前是两套互不知情的开合状态:开着芯片菜单再按「+」,两个浮层叠在一起。
// 现在任何一方打开前都来这里登记;登记会先关掉上一个持有者。两边都不 import 对方(避免循环依赖),
// 只认这个模块。

type Holder = { owner: object; close: () => void }
let current: Holder | undefined

/** 声明 `owner` 即将打开一个菜单:若别的持有者开着,先关掉它。 */
export function claimOverlay(owner: object, close: () => void): void {
  const previous = current
  current = { owner, close }
  if (previous && previous.owner !== owner) previous.close()
}

/** `owner` 已关闭(仅当它仍是当前持有者时清空,避免误清别人的登记)。 */
export function releaseOverlay(owner: object): void {
  if (current?.owner === owner) current = undefined
}

/** 测试 / 重置用:当前是否有人持有。 */
export function overlayOwner(): object | undefined {
  return current?.owner
}
