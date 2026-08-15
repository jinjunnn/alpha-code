// [#969] 「云档拒绝在用户那一行长什么样」闸门的 harness。
//
// 挂的是**生产 AutomationPanel** 本体(零替身)+ 真 `@solidjs/router`。替身只剩最外围的
// preload 桥 `window.api` —— renderer 侧一切 IPC 都从那里过,而 main 进程不在这个闸门里。
// 于是判据能落在「`.alpha-auto-err` 里那串字符」这个**用户可观察结果**上,而不是某个信号的值
// 或源码文本(后两者修前就能绿)。
//
// 形制沿用同目录之外的既有 harness(upload-consent / shell-commands):由测试文件用生产
// vite 插件编译本文件 —— bun 原生 TSX 变换是 React 形状的,会静默丢掉 Solid 的响应式表达式。
//
// 边界:main→IPC 那一跳**不在本闸门内**(renderer 结构上加载不到 main 模块)。那一跳由
// src/main 里走真实 `ipcMain.handle` 的用例守着;两端合起来才是完整链条。

import { MemoryRouter, Route } from "@solidjs/router"
import { createSignal, type JSX } from "solid-js"
import { render } from "solid-js/web"
import { AutomationPanel } from "./automation-panel"
import { setAutomationOpen } from "./automation-state"
import { scheduleRefusalCopy } from "./schedule-refusal-copy"
import { setLocale, t } from "../i18n"
import type { AutomationTask } from "../../shared/automation-types"

export { render, scheduleRefusalCopy, setLocale, t }

/** `workspaceDefaultDir` 回给面板的目录 —— 表单的「项目」字段靠它填上,否则保存会早返。 */
export const DEFAULT_DIR = "/Users/tester/proj-a"

type SaveResult = { ok: true } | { ok: false; reason: string; code?: string }

const [saveResult, setSaveResult] = createSignal<SaveResult>({ ok: true })
const [saveCalls, setSaveCalls] = createSignal<AutomationTask[]>([])

export { saveCalls }

/** 排下一次(以及之后每一次)`automations.save` 的返回值 —— 模拟 main 交回来的那个对象。 */
export function queueSaveResult(result: SaveResult): void {
  setSaveResult(() => result)
}

/** 面板把自己的 Portal 挂到 `#root`;没有它,面板 DOM 不会进 document。 */
export function installRootHost(): void {
  if (document.getElementById("root")) return
  const root = document.createElement("div")
  root.id = "root"
  document.body.append(root)
}

export function installPreloadStub(): void {
  const unsubscribe = () => () => {}
  const api = {
    auth: {
      subscribe: unsubscribe,
      onError: unsubscribe,
      getState: async () => ({ status: "logged-out", mode: "byok" }),
    },
    automations: {
      list: async () => ({ tasks: [], state: { pausedAll: false }, loginItem: false }),
      onEvent: unsubscribe,
      cloudSync: async () => ({ schedules: null, pulled: { pulled: 0 } }),
      loginItem: async () => ({ openAtLogin: false }),
      pauseAll: async () => ({ ok: true }),
      save: async (task: AutomationTask) => {
        setSaveCalls((seen) => [...seen, task])
        return saveResult()
      },
    },
    workspaceDefaultDir: async () => DEFAULT_DIR,
    openDirectoryPicker: async () => DEFAULT_DIR,
  }
  // defineProperty 而不是裸赋值:整包跑时先跑的测试可能已把它定义成只读属性。
  Object.defineProperty(window, "api", { configurable: true, writable: true, value: api })
}

export function resetHarness(): void {
  setAutomationOpen(false)
  setSaveCalls([])
  setSaveResult(() => ({ ok: true }))
  setLocale("zh")
}

/** 面板的开合是模块级信号(生产里由侧栏按钮翻);本闸门不测开合,直接置位。 */
export function openPanel(): void {
  setAutomationOpen(true)
}

export function AutomationRefusalHarness(): JSX.Element {
  const Shell = (p: { children?: JSX.Element }) => (
    <>
      <AutomationPanel serverKey={() => "sidecar"} />
      {p.children}
    </>
  )
  return (
    <MemoryRouter root={Shell}>
      <Route path="*" component={() => <main data-alpha-test-content />} />
    </MemoryRouter>
  )
}
