// AlphaBoundary — C28 crash boundary moved down to the Alpha-owned surface.
// 上游 AppBaseProviders 的 ErrorBoundary(冻结 app.tsx:274)包住全部 children:alpha 注入件任一 render
// throw 会把整屏顶成上游 ErrorPage(册 §7h 已证伪「alpha 顶层边界」——永远更外层,永不命中)。本组件
// 逐个紧裹 alpha 注入件(比上游更内层 → 先命中):崩溃 = 右下角紧凑浮条(局部降级 + 重载此区域),
// app 其余照常;上游组件崩溃仍走上游边界(其子树,合理归属)。TimelineInject(B22 疑源)自此有降落伞。
//
// 复验探针(dev/打包同在,零成本常驻):window.__alphaCrashProbe("<name>") 使对应边界的子树响应式
// throw;__alphaCrashProbe(null) 复位后点「重载此区域」恢复 —— CDP / 真机批均可用。
import { createSignal, ErrorBoundary, type JSX } from "solid-js"
import { t } from "../i18n"
import "./alpha-boundary.css"

const [probeTarget, setProbeTarget] = createSignal<string | null>(null)

declare global {
  interface Window {
    __alphaCrashProbe?: (name: string | null) => void
  }
}
if (typeof window !== "undefined") window.__alphaCrashProbe = (name) => setProbeTarget(name)

function CrashProbe(props: { name: string }) {
  return (
    <>
      {(() => {
        if (probeTarget() === props.name) throw new Error(`alpha crash probe: ${props.name}`)
        return null
      })()}
    </>
  )
}

export function AlphaBoundary(props: { name: string; children: JSX.Element }) {
  return (
    <ErrorBoundary
      fallback={(error, reset) => {
        console.error(`[alpha-boundary] ${props.name} crashed`, error)
        return (
          <div class="a-boundary" data-alpha-boundary={props.name}>
            <span class="a-boundary-name">{t("alpha.error.regionStopped", { name: props.name })}</span>
            <span class="a-boundary-msg">{String((error as Error)?.message ?? error)}</span>
            <button class="a-boundary-btn" onClick={reset}>
              {t("alpha.error.reloadRegion")}
            </button>
          </div>
        )
      }}
    >
      <CrashProbe name={props.name} />
      {props.children}
    </ErrorBoundary>
  )
}
