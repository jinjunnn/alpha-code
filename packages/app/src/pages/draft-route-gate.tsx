// alpha-code #903 —— `/new-session?draftId=…` 的两个用户可见态。
//
// 上游把这条路由的两个非happy-path都做成了「什么都不显示」:
//   · `<Show when={tabs.ready()}>` 无 fallback ⇒ 水合完成前是**空白页**;
//   · 找不到 draft 时 `fallback={<Navigate href="/" />}` ⇒ **静默弹回首页**,零提示 ——
//     用户分不清是自己点错了、草稿被删了、还是应用坏了。
// REQ-085(#201)AC2 点名禁止的正是这两项。
//
// 为什么闸门能真的挂载它:本模块**零上下文依赖** —— 不 `useLanguage()`、不 `useNavigate()`、
// 不碰 `@/*` 别名,文案与恢复动作都由调用方(app.tsx 的 `createDraftRoute`)注入。于是
// packages/ui-mac 的真组件 lane 可以直接 import 它、真挂载、真断言 DOM,而不需要先立起
// LanguageProvider / Router / TabsProvider 一整套 provider 栈。判据因此断的是**渲染结果**,
// 不是源码文本(ADR-037 决策 4 的口径)。
//
// draft 用泛型而不是 `import type { DraftTab }`:类型导入要走 `@/context/tabs` 别名,
// 而别名在 ui-mac 的 cwd 下解析不到 —— 泛型让本模块对任何 cwd 都可加载。
import { type JSX, Show } from "solid-js"

/** 本模块用到的全部 i18n 键。列成联合类型 = 调用方少传一条就 typecheck 红。 */
export type DraftRouteGateKey =
  | "session.draft.pending"
  | "session.draft.missing.title"
  | "session.draft.missing.description"
  | "session.draft.missing.action"

export interface DraftRouteGateProps<Draft> {
  /** tab store 是否已水合完成(`tabs.ready()`)。false = 还不知道 draft 在不在。 */
  ready: boolean
  /** 命中的 draft;`undefined` = 缺失 / 已删除 / 非法 draftId。 */
  draft: Draft | undefined
  t: (key: DraftRouteGateKey) => string
  /** 恢复动作:回首页。由调用方接 router,本模块不碰导航。 */
  onRecover: () => void
  children: (draft: Draft) => JSX.Element
}

/** 水合中的骨架 —— 占位而不是空白,并带无障碍的加载语义。 */
export function DraftRoutePending(props: { label: string }) {
  return (
    <div
      data-component="draft-route-pending"
      role="status"
      aria-busy="true"
      aria-label={props.label}
      class="flex h-full w-full flex-col items-center justify-center gap-3 p-8"
    >
      <div class="h-6 w-48 rounded-md bg-surface-raised-base opacity-60 animate-pulse" />
      <div class="h-4 w-64 rounded-md bg-surface-raised-base opacity-40 animate-pulse" />
      <div class="h-4 w-40 rounded-md bg-surface-raised-base opacity-40 animate-pulse" />
    </div>
  )
}

/** 具名错误态 + 一个恢复动作。刻意不自动跳转:静默跳转正是本票要修掉的行为。 */
export function DraftRouteMissing(props: { title: string; description: string; action: string; onRecover: () => void }) {
  return (
    <div
      data-component="draft-route-missing"
      role="alert"
      class="flex h-full w-full flex-col items-center justify-center gap-3 p-8 text-center"
    >
      <h1 class="text-base font-medium">{props.title}</h1>
      <p class="max-w-md text-sm opacity-70">{props.description}</p>
      <button
        type="button"
        data-component="draft-route-missing-action"
        class="mt-2 rounded-md bg-surface-raised-base px-3 py-1.5 text-sm"
        onClick={() => props.onRecover()}
      >
        {props.action}
      </button>
    </div>
  )
}

/**
 * draft 路由的守卫。两个 fallback 都必须在:摘掉任何一个,ui-mac 的
 * `draft-route-gate.cases.ts` 当场红(那正是 #903 的退出条件)。
 */
export function DraftRouteGate<Draft>(props: DraftRouteGateProps<Draft>) {
  return (
    <Show when={props.ready} fallback={<DraftRoutePending label={props.t("session.draft.pending")} />}>
      <Show
        when={props.draft}
        keyed
        fallback={
          <DraftRouteMissing
            title={props.t("session.draft.missing.title")}
            description={props.t("session.draft.missing.description")}
            action={props.t("session.draft.missing.action")}
            onRecover={() => props.onRecover()}
          />
        }
      >
        {(draft) => props.children(draft)}
      </Show>
    </Show>
  )
}
