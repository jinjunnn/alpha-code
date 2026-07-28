// C14 / ADR-016 待办①:上游内部 provider/hook 借用的**唯一**汇聚点(薄 re-export)。
//
// 规则:alpha 组件(alpha-ui/* · sidebar/* · extensions/*)不得直接 `import ... from
// "@opencode-ai/app"` —— 一律经本文件转口。上游重命名/移动内部 hook 时只断这里一处(loud:
// typecheck 即红),不再散落各组件静默失效。shell 入口(renderer/index.tsx)例外:它挂的是
// AppInterface/Platform 官方接缝(ADR-003/016),属 sanctioned 借用,不收进来。
//
// 当前借用面(新增须附上游落点注释):
// - useCommand — packages/app/src/context/command.tsx(命令面板触发,冻结树 ADR-020)
// - useTabs    — packages/app/src/context/tabs.tsx(draft/tab authority;REQ-126 CODE-C 建 draft)
// - useServer / ServerConnection — packages/app/src/context/server.tsx(当前 server 身份 + 该
//                server 的项目列表;REQ-126 不变量 4 的同源判定用 `ServerConnection.key` 派生
//                内嵌 sidecar 的稳定 key,而不是硬编码字符串)

import type { ContractFailure } from "@alpha-code/contracts-consumer"
import { createComponent, createContext, createSignal, onCleanup, onMount, useContext, type JSX } from "solid-js"

export { ServerConnection, useCommand, useServer, useTabs } from "@opencode-ai/app"
export type { PermissionSurfaceProps } from "@opencode-ai/app"

const ContractHealthContext = createContext<() => ContractFailure | null>(() => null)

export function ContractHealthProvider(props: { children: JSX.Element }) {
  const [failure, setFailure] = createSignal<ContractFailure | null>(null)
  onMount(() => {
    void window.api.contracts.health().then(setFailure)
    const unsubscribe = window.api.contracts.subscribe(setFailure)
    onCleanup(unsubscribe)
  })
  return createComponent(ContractHealthContext.Provider, { value: failure, get children() { return props.children } })
}

export function useContractHealth() {
  return useContext(ContractHealthContext)
}
