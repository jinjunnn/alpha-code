// REQ-126 AC2(#655)「覆盖层随导航关闭」闸门的**生产组合体**。
//
// 这里刻意不放任何替身:AlphaSidebar / ExtensionHub / AutomationPanel 三者都是生产组件,
// 路由是真的 `@solidjs/router`(MemoryRouter + createMemoryHistory)。于是闸门的断言可以落在
// 「覆盖层宿主的 DOM 还在不在 document 里」这个**可观察结果**上,而不是模块信号的值、
// 更不是源码文本 —— 后两者修前就能绿(信号可以被别处顺手置位、文本可以等义改写)。
//
// 真实判据在 packages/ui-mac/test-component/overlay-close.cases.ts(参数化矩阵),
// 由 packages/ui-mac/src/renderer/sidebar/overlay-close.test.ts 起子进程执行。

import type { JSX } from "solid-js"
import { MemoryRouter, Route, createMemoryHistory, type MemoryHistory } from "@solidjs/router"
import { AlphaSidebar } from "./alpha-sidebar"
import { ExtensionHub } from "../extensions/extension-hub"
import { AutomationPanel } from "../automations/automation-panel"
import { extHubOpen, setExtHubOpen } from "../extensions/ext-hub-state"
import type { AlphaProjectsApi, ServerInfo } from "./use-projects"

export { createMemoryHistory }
export type { MemoryHistory }

export function OverlayCloseHarness(props: { history: MemoryHistory; projects: AlphaProjectsApi }): JSX.Element {
  const server = (): ServerInfo | undefined => ({ baseUrl: "http://127.0.0.1:65535" })
  // 侧栏与两个覆盖层在生产里是 AppInterface 下的兄弟(renderer/index.tsx:500-508),这里同构。
  const Shell = (p: { children?: JSX.Element }) => (
    <>
      <AlphaSidebar projects={props.projects} />
      <ExtensionHub server={server} open={extHubOpen} onClose={() => setExtHubOpen(false)} />
      <AutomationPanel />
      {p.children}
    </>
  )
  return (
    <MemoryRouter history={props.history} root={Shell}>
      <Route path="*" component={() => <main data-alpha-test-content />} />
    </MemoryRouter>
  )
}
