// REQ-125 C4(integration audit Major-2, round-3 rework)—— 终端「任一实例在跑」的
// 跨组件投影,按发布者注册表聚合。
//
// 生产状态通路:每个 TerminalRailPanel 实例注册一个唯一发布者条目,持续发布自己的
// anyTerminalRunning(instances 已过 acceptedEngineChannel 身份闸,I8);卸载 = 删除
// 自身条目(而非无条件写 false)。any = 注册表中任意条目为 true —— 多面板并存、
// 重挂、卸载次序交错都不会互踩。shell 的 rr-tabs 终端呼吸点消费聚合值;
// railMeta.terminalRunning 仍是显式覆盖通道。
import { createSignal } from "solid-js"

const [publishers, setPublishers] = createSignal<ReadonlyMap<symbol, boolean>>(new Map())

/** Shell 消费面:任一注册发布者报告 running(无发布者 = false,fail-closed)。 */
export function terminalRailAnyRunning(): boolean {
  for (const running of publishers().values()) if (running) return true
  return false
}

export interface TerminalRunningPublisher {
  /** 发布本面板实例的 any-running 状态(幂等;同值重发不抖动聚合)。 */
  publish(running: boolean): void
  /** 注销:仅删除自身条目,其他发布者的状态不受影响。幂等。 */
  unregister(): void
}

/** 仅供 TerminalRailPanel(及测试)使用;每次挂载注册一个唯一条目。 */
export function registerTerminalRunningPublisher(): TerminalRunningPublisher {
  const key = Symbol("terminal-rail-publisher")
  let active = true
  setPublishers((current) => new Map(current).set(key, false))
  return {
    publish: (running) => {
      if (!active) return
      setPublishers((current) => {
        if (current.get(key) === running) return current
        return new Map(current).set(key, running)
      })
    },
    unregister: () => {
      if (!active) return
      active = false
      setPublishers((current) => {
        const next = new Map(current)
        next.delete(key)
        return next
      })
    },
  }
}
