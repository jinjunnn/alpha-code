// Electron adapter for the deep-link queue (REQ-089 AC4).
//
// The arbitration itself is pure and unit-tested in `deep-link-queue.ts`. This file is the only
// place it touches Electron, and it exists as its own module for one reason: ownership tracking
// must be attached at EVERY window creation path, and `windows.ts` (which owns them all, boot and
// the `window.new` menu action alike) cannot import `index.ts`.

import { webContents, type WebContents } from "electron"
import { createDeepLinkQueue, trackRendererLifecycle } from "./deep-link-queue"
import { handleAuthDeepLink } from "./alpha-auth"

export const deepLinks = createDeepLinkQueue({
  consumeAuth: (url) => handleAuthDeepLink(url),
  deliver: (rendererId, batch) => {
    const contents = webContents.fromId(rendererId)
    // isCrashed() is the one that matters: sending to a dead render process neither throws nor
    // arrives, so without this the queue would believe a lost link was delivered.
    if (!contents || contents.isDestroyed() || contents.isCrashed()) return false
    // `send` is fire-and-forget — it returns before the renderer has run a line of code. So `true`
    // here claims only that the transport took the batch; the queue keeps its copy until the
    // renderer acknowledges the batch id, and re-queues it if that renderer dies first.
    contents.send("deep-link", batch)
    return true
  },
  // Ends a park (see RENDERER_RETENTION_MS). `unref` because a pending retention timer must never
  // be the reason the app is still alive at quit.
  schedule: (delayMs, expire) => void setTimeout(expire, delayMs).unref(),
})

/** Attach one renderer's lifecycle to the queue. Called from `createMainWindow` — every window. */
export function trackDeepLinkRenderer(contents: WebContents): void {
  trackRendererLifecycle(
    {
      id: contents.id,
      // Electron types `on` as per-event overloads, so a union event name needs the EventEmitter
      // face it already extends. The event LIST stays in the tested module, not here.
      on: (event, listener) => (contents as NodeJS.EventEmitter).on(event, listener),
    },
    deepLinks,
  )
}
