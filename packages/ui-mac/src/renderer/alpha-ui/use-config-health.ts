// B11/B23:全局配置健康信号。opencode 对语法错/未知顶键会把整份全局配置静默清零(上游行为,
// 不可改);main 侧 configHealth 用同一份文件前置探测,这里在挂载时取一次并轮询低频刷新
// (5min —— 配置文件只在用户手编或定制中心写入时变化,写入路径各自会再触发一次)。

import { createSignal, onCleanup, onMount, type Accessor } from "solid-js"
import { extIpc } from "../extensions/ext-ipc"

export type ConfigHealth = { broken: boolean; reason?: string; path?: string }

const [health, setHealth] = createSignal<ConfigHealth>({ broken: false })
// 按订阅计数:首页与新对话页都挂这条提示,第一个挂载的开始轮询,最后一个卸载才停 ——
// 「谁先挂载谁清理」会在先挂的那页卸载时把还在显示的另一页的刷新一起停掉。
let subscribers = 0
let timer: ReturnType<typeof setInterval> | undefined

export async function refreshConfigHealth(): Promise<void> {
  try {
    setHealth(await extIpc.configHealth())
  } catch {
    /* IPC 不可用时保持上次值,不误报 */
  }
}

export function useConfigHealth(): Accessor<ConfigHealth> {
  onMount(() => {
    subscribers += 1
    if (subscribers === 1) {
      void refreshConfigHealth()
      timer = setInterval(() => void refreshConfigHealth(), 5 * 60_000)
    }
    onCleanup(() => {
      subscribers -= 1
      if (subscribers > 0) return
      clearInterval(timer)
      timer = undefined
    })
  })
  return health
}
