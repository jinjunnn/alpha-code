// Composition ratchet for deep-link ingress (REQ-089 AC4). The queue's behaviour AND the renderer
// lifecycle wiring are now both EXECUTED for real in deep-link-queue.test.ts (the production
// `trackRendererLifecycle` driven through a fake webContents). What remains here is only what
// `bun test` cannot execute: Electron's own `app`-level events (`second-instance`, `open-url`),
// the first process's argv, and the fact that ownership is attached inside the window factory
// rather than at one call site.
//
// This is a source-shape assertion and therefore the weaker kind of gate: it proves the wire is
// present, not that Electron delivers on it. Packaged verification stays the judge of that.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const index = readFileSync(join(import.meta.dir, "index.ts"), "utf8")
const windows = readFileSync(join(import.meta.dir, "windows.ts"), "utf8")
const adapter = readFileSync(join(import.meta.dir, "deep-links.ts"), "utf8")

describe("REQ-089 deep-link ingress wiring ratchet", () => {
  test("every OS entry point feeds the one queue", () => {
    // Windows/Linux cold start: the first process holds the single-instance lock, so this is the
    // ONLY chance to see the link (no second-instance, no macOS open-url).
    expect(index).toContain("deepLinks.ingest(process.argv)")
    expect(index).toContain('app.on("second-instance"')
    expect(index).toContain("deepLinks.ingest(argv)")
    expect(index).toContain('app.on("open-url"')
    expect(index).toContain("deepLinks.ingest([url])")
  })

  test("the queue is the only thing that reaches the renderer transport", () => {
    // One call site, inside the queue's `deliver` dependency — anything else would be a second
    // path that the exactly-once arbitration cannot see.
    expect(adapter.match(/\.send\(\s*"deep-link"/g)).toHaveLength(1)
    expect(index).not.toContain('"deep-link"')
  })

  test("both halves of the retained-copy protocol are wired to the one queue", () => {
    // The renderer's acknowledgement is what retires main's copy; without this wire every batch
    // would sit in flight forever and every reload would replay it.
    expect(index).toContain("deepLinks.consumeInitial(rendererId)")
    expect(index).toContain("deepLinks.acknowledge(rendererId, batchId)")
  })

  test("ownership is attached by the window factory, so no window can exist unwired", () => {
    // `window.new` (desktop-menu-actions) creates windows through this same factory; wiring at the
    // boot call site instead would leave those renderers able to drain the queue but never able to
    // release it — the hole this gate exists to keep closed.
    expect(windows).toContain("trackDeepLinkRenderer(win.webContents)")
    expect(index).not.toContain("trackDeepLinkRenderer")
  })
})
