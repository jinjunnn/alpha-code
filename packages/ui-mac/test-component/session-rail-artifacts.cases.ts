import { transformAsync } from "@babel/core"
import presetTypescript from "@babel/preset-typescript"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import presetSolid from "babel-preset-solid"

GlobalRegistrator.register()
const solid = await import("solid-js/dist/solid.js")
mock.module("solid-js", () => solid)
const solidWeb = await import("solid-js/web/dist/web.js")
mock.module("solid-js/web", () => solidWeb)
const solidStore = await import("solid-js/store/dist/store.js")
mock.module("solid-js/store", () => solidStore)

Bun.plugin({
  name: "session-rail-artifacts-component-test",
  setup(builder) {
    builder.onLoad({ filter: /packages\/ui-mac\/src\/.*\.tsx$/ }, async (args) => {
      const transformed = await transformAsync(await Bun.file(args.path).text(), {
        filename: args.path,
        presets: [
          [presetSolid, { generate: "dom", hydratable: false }],
          [presetTypescript, { allExtensions: true, isTSX: true, onlyRemoveTypeImports: true }],
        ],
        sourceMaps: "inline",
      })
      return { contents: transformed?.code ?? "", loader: "js" }
    })
  },
})

const runtime = await import("../src/renderer/alpha-ui/session-rail/artifacts/artifacts-test-runtime")
const disposers: Array<() => void> = []

afterEach(() => {
  disposers
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose())
  document.body.replaceChildren()
  delete (window as never as Record<string, unknown>).api
})

afterAll(() => GlobalRegistrator.unregister())

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
}

async function flushTimers() {
  await new Promise((resolve) => setTimeout(resolve, 1))
  await flush()
}

function mount(component: () => unknown) {
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(solidWeb.render(component as never, host))
  return host
}

function manifestEntry(id: string, name: string) {
  return {
    descriptor: {
      id,
      name,
      size: 5,
      claimedMime: "text/markdown",
      sha256: "0".repeat(64),
      trust: "trusted",
      role: "artifact",
      provenance: { producer: "test", jobId: "job_1" },
      verification: { status: "verified" },
    },
    local: {
      savedPath: `artifacts/${name}`,
      downloadedAt: "2026-07-24T00:00:00Z",
      bytesOnDisk: 5,
      state: "verified",
      warnings: [],
    },
  }
}

function runUsage(runId: string) {
  return {
    runId,
    artifactCount: 1,
    recordedBytes: 5,
    diskBytes: 5,
    legacyBytes: 0,
    missingCount: 0,
    readOnly: false,
  }
}

function installFakeRunArtifacts(
  entriesByRun: Record<string, unknown[]>,
  options?: { verify?: (run: string, artifactId: string) => Promise<unknown> },
) {
  const calls = { projectUsage: 0, list: [] as string[], verify: [] as string[], read: 0 }
  ;(window as never as Record<string, unknown>).api = {
    runArtifacts: {
      projectUsage: async () => {
        calls.projectUsage += 1
        return {
          ok: true,
          usage: {
            runs: Object.keys(entriesByRun).map(runUsage),
            totalDiskBytes: 5,
            limits: { projectMaxBytes: 1024, runMaxBytes: 1024 },
          },
        }
      },
      list: async (_dir: string, run: string) => {
        calls.list.push(run)
        return { ok: true, entries: entriesByRun[run] ?? [], legacyFiles: [], warnings: [] }
      },
      verify: async (_dir: string, run: string, artifactId: string) => {
        calls.verify.push(`${run}:${artifactId}`)
        if (options?.verify) return options.verify(run, artifactId)
        // Honest default: the re-check returns the (verified) manifest entry, like main does.
        const entry = (entriesByRun[run] ?? []).find(
          (candidate) => (candidate as { descriptor?: { id?: string } }).descriptor?.id === artifactId,
        )
        return entry ? { ok: true, entry } : { ok: false, reason: "artifact not found" }
      },
      read: async () => {
        calls.read += 1
        return { ok: false, reason: "harness" }
      },
    },
  }
  return calls
}

function unmountAll() {
  disposers
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose())
  document.body.replaceChildren()
}

describe("REQ-125 C4 artifacts view real Solid mount", () => {
  test("cards render the approved workbench language verbatim and selection works", async () => {
    const harness = runtime.createArtifactsViewHarness()
    harness.setCards([
      runtime.fakeCard({ key: "art-1", name: "季度经营分析.docx", bytes: 1258291 }),
      runtime.fakeCard({ key: "art-2", name: "架构说明.md", state: "unverified", bytes: 12288 }),
    ])
    harness.setSelectedKey("art-1")
    const host = mount(harness.View)
    await flush()

    expect(host.querySelector("[data-alpha-session-artifacts]")!.getAttribute("data-artifacts-phase")).toBe("cards")
    const cards = host.querySelectorAll(".alpha-wb-cardlist .alpha-wb-card")
    expect(cards).toHaveLength(2)
    expect(cards[0]!.hasAttribute("data-active")).toBe(true)
    expect(cards[0]!.querySelector(".a-wb-chip")!.getAttribute("data-state")).toBe("verified")
    expect(cards[1]!.querySelector(".a-wb-chip")!.getAttribute("data-state")).toBe("unverified")
    expect(cards[0]!.querySelector(".alpha-wb-card-size")!.textContent).toBe("1.2 MiB")

    host.querySelector<HTMLButtonElement>("[data-artifact-card='art-2']")!.click()
    await flush()
    expect(harness.calls.select).toEqual(["art-2"])
    expect(host.querySelector("[data-artifact-card='art-2']")!.closest(".alpha-wb-card")!.hasAttribute("data-active")).toBe(
      true,
    )
  })

  test("loading, error (with retry), and quiet empty phases render honestly", async () => {
    const harness = runtime.createArtifactsViewHarness()
    harness.setPhase("loading")
    const host = mount(harness.View)
    await flush()
    const phase = () => host.querySelector("[data-alpha-session-artifacts]")!.getAttribute("data-artifacts-phase")
    expect(phase()).toBe("loading")

    harness.setPhase("error")
    harness.setErrorReason("boom")
    await flush()
    expect(phase()).toBe("error")
    expect(host.querySelector(".a-wb-notice[data-kind='error']")!.textContent).toContain("boom")
    host.querySelector<HTMLButtonElement>(".a-rart-status .a-wb-btn")!.click()
    expect(harness.calls.retry).toBe(1)

    harness.setPhase("empty")
    await flush()
    expect(phase()).toBe("empty")
    expect(host.querySelector("[data-artifacts-empty]")).not.toBeNull()
  })

  test("preview mode tabs switch and reset to preview when the selection changes", async () => {
    const harness = runtime.createArtifactsViewHarness()
    harness.setCards([
      runtime.fakeCard({ key: "art-1", name: "a.md" }),
      runtime.fakeCard({ key: "art-2", name: "b.md" }),
    ])
    harness.setSelectedKey("art-1")
    const host = mount(harness.View)
    await flush()

    const tabs = host.querySelectorAll<HTMLButtonElement>(".alpha-wb-tabs [role='tab']")
    expect(tabs).toHaveLength(3)
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true")

    tabs[1]!.click()
    await flush()
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true")

    harness.setSelectedKey("art-2")
    await flush()
    expect(host.querySelectorAll<HTMLButtonElement>(".alpha-wb-tabs [role='tab']")[0]!.getAttribute("aria-selected")).toBe(
      "true",
    )
  })

  test("focus mount point: focusSeq moves DOM focus to the selected card and Esc reports out", async () => {
    const harness = runtime.createArtifactsViewHarness()
    harness.setCards([runtime.fakeCard({ key: "art-1", name: "a.md" })])
    harness.setSelectedKey("art-1")
    const host = mount(harness.View)
    await flush()

    harness.setFocusSeq(1)
    await flush()
    const card = host.querySelector<HTMLButtonElement>("[data-artifact-card='art-1']")!
    expect(document.activeElement).toBe(card)

    card.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
    await flush()
    expect(harness.calls.escape).toBe(1)
  })
})

describe("REQ-125 C4 artifacts container in the real shell (fake preload channel)", () => {
  test("latest run loads, first card auto-selects, verify-before-open runs, focusArtifact links in, identity switch resets (I8)", async () => {
    const calls = installFakeRunArtifacts({
      job_1: [manifestEntry("art-old", "旧报告.md")],
      job_2: [manifestEntry("art-1", "架构说明.md"), manifestEntry("art-2", "季度分析.md")],
    })
    const shell = runtime.createArtifactsShellHarness()
    const host = mount(shell.Shell)
    await flushTimers()

    // Open the artifacts tab (review is the default panel).
    host.querySelector<HTMLButtonElement>("[data-alpha-session-rail-tab='artifacts']")!.click()
    await flushTimers()
    await flushTimers()

    // Latest run (job_2, descending runId sort) — not the older one.
    expect(calls.projectUsage).toBe(1)
    expect(calls.list[0]).toBe("job_2")
    const cards = host.querySelectorAll(".alpha-wb-card")
    expect(cards).toHaveLength(2)
    // Auto-selected first card triggered verify-before-open (REQ-093 AC#4).
    expect(cards[0]!.hasAttribute("data-active")).toBe(true)
    expect(calls.verify).toContain("job_2:art-1")

    // Timeline linkage mount point: origin focus → focusArtifact → tab + selection + DOM focus.
    const origin = host.querySelector<HTMLButtonElement>("[data-fake-origin]")!
    origin.focus()
    shell.rail().focusArtifact("art-2")
    await flushTimers()
    expect(
      host.querySelector("[data-alpha-session-rail-host]")!.getAttribute("data-alpha-session-rail-panel"),
    ).toBe("artifacts")
    const target = host.querySelector<HTMLButtonElement>("[data-artifact-card='art-2']")!
    expect(target.closest(".alpha-wb-card")!.hasAttribute("data-active")).toBe(true)
    expect(document.activeElement).toBe(target)

    // Esc returns focus to the originating element (approved linkage contract).
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
    await flush()
    expect(document.activeElement).toBe(origin)

    // I8: a session switch remounts the panel (fresh loads) and drops the stale focus target.
    shell.switchSession("ses_b")
    await flushTimers()
    expect(calls.projectUsage).toBe(2)
    expect(shell.rail().artifactTarget()).toBeUndefined()
  })

  test("verify-before-open is a real barrier: no byte read until the re-check passes", async () => {
    let resolveVerify!: (value: unknown) => void
    const gate = new Promise((resolve) => (resolveVerify = resolve))
    const calls = installFakeRunArtifacts({ job_1: [manifestEntry("art-1", "架构说明.md")] }, { verify: () => gate })
    const shell = runtime.createArtifactsShellHarness()
    const host = mount(shell.Shell)
    await flushTimers()
    host.querySelector<HTMLButtonElement>("[data-alpha-session-rail-tab='artifacts']")!.click()
    await flushTimers()

    // Selection started the re-check; while it is pending nothing may read bytes and
    // no preview routing exists — only the honest checking placeholder.
    expect(calls.verify).toEqual(["job_1:art-1"])
    expect(host.querySelector("[data-artifacts-verifying]")).not.toBeNull()
    expect(calls.read).toBe(0)

    resolveVerify({ ok: true, entry: manifestEntry("art-1", "架构说明.md") })
    await flushTimers()
    await flushTimers()
    expect(host.querySelector("[data-artifacts-verifying]")).toBeNull()
    // Barrier open: the markdown renderer now reads through the bounded channel.
    expect(calls.read).toBeGreaterThan(0)
  })

  test("a failed re-check renders honestly, keeps bytes closed, and is retryable", async () => {
    let attempts = 0
    const calls = installFakeRunArtifacts({ job_1: [manifestEntry("art-1", "架构说明.md")] }, {
      verify: () => {
        attempts += 1
        return attempts === 1
          ? Promise.reject(new Error("digest failed: read error"))
          : Promise.resolve({ ok: true, entry: manifestEntry("art-1", "架构说明.md") })
      },
    })
    const shell = runtime.createArtifactsShellHarness()
    const host = mount(shell.Shell)
    await flushTimers()
    host.querySelector<HTMLButtonElement>("[data-alpha-session-rail-tab='artifacts']")!.click()
    await flushTimers()
    await flushTimers()

    // Failure is never stamped as done: honest notice, zero reads, no preview.
    const failed = host.querySelector("[data-artifacts-verify-failed]")
    expect(failed).not.toBeNull()
    expect(failed!.textContent).toContain("digest failed")
    expect(calls.read).toBe(0)

    failed!.querySelector<HTMLButtonElement>(".a-wb-btn")!.click()
    await flushTimers()
    await flushTimers()
    await flushTimers()
    expect(calls.verify.length).toBe(2)
    expect(host.querySelector("[data-artifacts-verify-failed]")).toBeNull()
    expect(calls.read).toBeGreaterThan(0)
    unmountAll()
  })

  test("a real digest mismatch (ok:true, state=mismatch) is a first-class failure: zero reads, honest notice", async () => {
    const mismatchEntry = manifestEntry("art-1", "架构说明.md")
    ;(mismatchEntry.local as { state: string }).state = "mismatch"
    const calls = installFakeRunArtifacts(
      { job_1: [manifestEntry("art-1", "架构说明.md")] },
      { verify: () => Promise.resolve({ ok: true, entry: mismatchEntry }) },
    )
    const shell = runtime.createArtifactsShellHarness()
    const host = mount(shell.Shell)
    await flushTimers()
    host.querySelector<HTMLButtonElement>("[data-alpha-session-rail-tab='artifacts']")!.click()
    await flushTimers()
    await flushTimers()

    // The re-check completed but did NOT come back "verified" — the barrier stays shut:
    // failure notice on screen, not a preview, and not a single byte read.
    const failed = host.querySelector("[data-artifacts-verify-failed]")
    expect(failed).not.toBeNull()
    expect(failed!.textContent).toContain("mismatch")
    expect(host.querySelector("[data-artifacts-verifying]")).toBeNull()
    expect(calls.read).toBe(0)
    expect(calls.verify).toEqual(["job_1:art-1"])
  })
})
