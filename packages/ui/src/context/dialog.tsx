import {
  createContext,
  createEffect,
  createRoot,
  createSignal,
  getOwner,
  onCleanup,
  type Owner,
  type ParentProps,
  type Component,
  runWithOwner,
  useContext,
  type JSX,
  startTransition,
  For,
} from "solid-js"
import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { makeEventListener } from "@solid-primitives/event-listener"

type DialogElement = () => JSX.Element

type Active = {
  id: string
  node: JSX.Element
  dispose: () => void
  owner: Owner
  onClose?: () => void
  setClosing: (closing: boolean) => void
  hosted: boolean
}

export type DialogHostProps = {
  open: boolean
  onClose: () => void
  title?: JSX.Element
  description?: JSX.Element
  action?: JSX.Element
  size?: "normal" | "large" | "x-large"
  class?: string
  classList?: Record<string, boolean | undefined>
  fit?: boolean
  transition?: boolean
  children?: JSX.Element
}

export type DialogHost = Component<DialogHostProps>
export type DialogMountOptions = { host?: boolean }

const HostContext = createContext<{
  component: DialogHost
  open: () => boolean
  close: () => void
}>()

const Context = createContext<ReturnType<typeof init>>()

function init(host: () => DialogHost | undefined = () => undefined) {
  const [stack, setStack] = createSignal<Active[]>([])
  const timer = { current: undefined as ReturnType<typeof setTimeout> | undefined }
  const lock = { value: false }

  onCleanup(() => {
    if (timer.current === undefined) return
    clearTimeout(timer.current)
    timer.current = undefined
  })

  const close = (id?: string) => {
    const items = stack()
    const current = id ? items.find((item) => item.id === id) : items.at(-1)
    if (!current || lock.value) return
    lock.value = true
    current.onClose?.()
    current.setClosing(true)

    const closed = current.id
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }

    timer.current = setTimeout(() => {
      timer.current = undefined
      current.dispose()
      setStack((items) => items.filter((item) => item.id !== closed))
      lock.value = false
    }, 100)
  }

  createEffect(() => {
    const current = stack().at(-1)
    if (!current || current.hosted) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      close()
      event.preventDefault()
      event.stopPropagation()
    }

    makeEventListener(window, "keydown", onKeyDown, { capture: true })
  })

  const mount = (
    element: DialogElement,
    owner: Owner,
    onClose: (() => void) | undefined,
    layer: number,
    host: DialogHost | undefined,
  ) => {
    const id = Math.random().toString(36).slice(2)
    const zIndex = 50 + layer * 10
    let dispose: (() => void) | undefined
    let setClosing: ((closing: boolean) => void) | undefined

    const node = runWithOwner(owner, () =>
      createRoot((d: () => void) => {
        dispose = d
        const [closing, setClosingSignal] = createSignal(false)
        setClosing = setClosingSignal
        if (host) {
          return (
            <HostContext.Provider value={{ component: host, open: () => !closing(), close: () => close(id) }}>
              {element()}
            </HostContext.Provider>
          )
        }
        return (
          <Kobalte
            modal
            open={!closing()}
            onOpenChange={(open: boolean) => {
              if (open) return
              close(id)
            }}
          >
            <Kobalte.Portal>
              <Kobalte.Overlay
                data-component="dialog-overlay"
                style={{ "z-index": String(zIndex) }}
                onClick={() => close(id)}
              />
              <div
                data-dialog-layer={layer}
                style={{
                  position: "fixed",
                  inset: "0",
                  "z-index": String(zIndex),
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "center",
                  "pointer-events": "none",
                }}
              >
                {element()}
              </div>
            </Kobalte.Portal>
          </Kobalte>
        )
      }),
    )

    if (!dispose || !setClosing) return

    const active: Active = { id, node, dispose, owner, onClose, setClosing, hosted: !!host }
    setStack((items) => [...items, active])
  }

  const push = (element: DialogElement, owner: Owner, onClose?: () => void, host?: DialogHost) => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }
    lock.value = false
    mount(element, owner, onClose, stack().length, host)
  }

  const show = (element: DialogElement, owner: Owner, onClose?: () => void, host?: DialogHost) => {
    for (const item of stack()) item.dispose()
    setStack([])
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }
    lock.value = false
    mount(element, owner, onClose, 0, host)
  }

  return {
    stack,
    close,
    show,
    push,
    host,
  }
}

export function DialogProvider(props: ParentProps<{ host?: DialogHost }>) {
  const ctx = init(() => props.host)
  return (
    <Context.Provider value={ctx}>
      {props.children}
      <div data-component="dialog-stack">
        <For each={ctx.stack()}>{(item) => item.node}</For>
      </div>
    </Context.Provider>
  )
}

export function useDialog() {
  const ctx = useContext(Context)
  const owner = getOwner()

  if (!owner) {
    throw new Error("useDialog must be used within a DialogProvider")
  }
  if (!ctx) {
    throw new Error("useDialog must be used within a DialogProvider")
  }

  return {
    get active() {
      return ctx.stack().at(-1)
    },
    show(element: DialogElement, onClose?: () => void, options?: DialogMountOptions) {
      const base = ctx.stack().at(-1)?.owner ?? owner
      return startTransition(() => ctx.show(element, base, onClose, options?.host ? ctx.host() : undefined))
    },
    push(element: DialogElement, onClose?: () => void, options?: DialogMountOptions) {
      const base = ctx.stack().at(-1)?.owner ?? owner
      return startTransition(() => ctx.push(element, base, onClose, options?.host ? ctx.host() : undefined))
    },
    close() {
      ctx.close()
    },
  }
}

export function useDialogHost() {
  return useContext(HostContext)
}
