// Composition ratchet for deep-link ingress (REQ-089 AC4). The queue's behaviour is proved in
// deep-link-queue.test.ts; what cannot be executed under `bun test` is Electron's own wiring —
// `app.on("second-instance")`, `app.on("open-url")`, the first process's argv, and the reload
// that drops renderer ownership. This asserts those four wires exist and that nothing else may
// reach the renderer transport, so deleting one is loud instead of silent.
//
// This is a source-shape assertion and therefore the weaker kind of gate: it proves the wire is
// present, not that Electron delivers on it. Packaged verification stays the judge of that.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const index = readFileSync(join(import.meta.dir, "index.ts"), "utf8")

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
    expect(index.match(/\bsendDeepLinks\(/g)).toHaveLength(1)
  })

  test("a reloading renderer drops ownership of the stream", () => {
    expect(index).toContain('webContents.on("did-start-loading", () => deepLinks.rendererGone())')
  })
})
