// B11/B23:全局配置健康信号。opencode 对语法错/未知顶键会把整份全局配置静默清零(上游行为,
// 不可改);main 侧 configHealth 用同一份文件前置探测,这里在挂载时取一次并轮询低频刷新
// (5min —— 配置文件只在用户手编或定制中心写入时变化,写入路径各自会再触发一次)。

import { createSignal, onCleanup, onMount, type Accessor } from "solid-js"
import { extIpc } from "../extensions/ext-ipc"

export type ConfigHealth = { broken: boolean; reason?: string; path?: string }

const [health, setHealth] = createSignal<ConfigHealth>({ broken: false })
let started = false

export async function refreshConfigHealth(): Promise<void> {
  try {
    setHealth(await extIpc.configHealth())
  } catch {
    /* IPC 不可用时保持上次值,不误报 */
  }
}

export function useConfigHealth(): Accessor<ConfigHealth> {
  onMount(() => {
    if (started) return
    started = true
    void refreshConfigHealth()
    const timer = setInterval(() => void refreshConfigHealth(), 5 * 60_000)
    onCleanup(() => {
      clearInterval(timer)
      started = false
    })
  })
  return health
}
