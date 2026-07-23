import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import appPlugin from "@opencode-ai/app/vite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import type { createComponent } from "solid-js"
import type { render } from "solid-js/web"
import type { ArtifactCard } from "../workbench-core"
import type { PreviewContext, OfficeArtifactView } from "./renderer-views"

type TestRuntime = {
  createComponent: typeof createComponent
  render: typeof render
  OfficeArtifactView: typeof OfficeArtifactView
}

const runtimeDirectory = mkdtempSync(join(tmpdir(), "alpha-office-preview-render-"))
await build({
  configFile: false,
  logLevel: "silent",
  plugins: [appPlugin.at(-1)!],
  build: {
    emptyOutDir: true,
    outDir: runtimeDirectory,
    lib: {
      entry: join(import.meta.dir, "office-preview-test-runtime.ts"),
      formats: ["es"],
      fileName: () => "office-preview-test-runtime.js",
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
})

const disposers: Array<() => void> = []
let quickLookCalls = 0
let quickLookOk = true
let externalOpenCalls = 0
let revealCalls = 0
let quickLookIdentity: unknown

GlobalRegistrator.register()
const runtime = (await import(
  pathToFileURL(join(runtimeDirectory, "office-preview-test-runtime.js")).href
)) as TestRuntime

beforeEach(() => {
  document.body.replaceChildren()
  quickLookCalls = 0
  quickLookOk = true
  externalOpenCalls = 0
  revealCalls = 0
  quickLookIdentity = undefined
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      runArtifacts: {
        quickLook: async (identity: unknown) => {
          quickLookCalls++
          quickLookIdentity = identity
          return quickLookOk
            ? { ok: true }
            : { ok: false, code: "PREVIEW_UNAVAILABLE", reason: "PREVIEW_UNAVAILABLE" }
        },
        openExternal: async () => {
          externalOpenCalls++
          return { ok: false, code: "OOXML_REJECTED", reason: "OOXML_REJECTED" }
        },
      },
      openPath: async () => {
        revealCalls++
      },
      writeClipboard: async () => {},
    },
  })
})

afterEach(async () => {
  disposers.splice(0).reverse().forEach((dispose) => dispose())
  await flush()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
  rmSync(runtimeDirectory, { recursive: true, force: true })
})

describe("Office preview production component", () => {
  test("PASS shows the button and Spacebar invokes Quick Look with identity", async () => {
    mount({ status: "pass", quickLook: true, subtype: "docx" })

    const quickLook = document.querySelector<HTMLButtonElement>('[data-office-action="quick-look"]')
    expect(quickLook).not.toBeNull()
    const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })
    document.body.dispatchEvent(event)
    await flush()

    expect(event.defaultPrevented).toBe(true)
    expect(quickLookCalls).toBe(1)
    expect(quickLookIdentity).toEqual({
      directory: "/workspace",
      runId: "job_1",
      artifactId: "art_job_1_0",
    })
    expect(document.activeElement).toBe(quickLook)

    const selectedCard = document.createElement("button")
    selectedCard.className = "alpha-wb-card-main"
    document.body.append(selectedCard)
    selectedCard.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }))
    await flush()
    expect(quickLookCalls).toBe(2)
  })

  test("checking and rejected states expose no Quick Look entry or Spacebar side effect", async () => {
    mount({ status: "checking", quickLook: false })
    expect(document.querySelector('[data-office-action="quick-look"]')).toBeNull()
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }))
    await flush()
    expect(quickLookCalls).toBe(0)

    disposeAll()
    mount({
      status: "rejected",
      quickLook: false,
      category: "encrypted",
      code: "ZIP_ENCRYPTED",
    })
    expect(document.querySelector('[data-office-action="quick-look"]')).toBeNull()
    expect(document.querySelector('[data-rejection-category="encrypted"]')).not.toBeNull()
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }))
    await flush()
    expect(quickLookCalls).toBe(0)
  })

  test("structure failure keeps external-open and saved-file folder actions reachable", async () => {
    mount({
      status: "rejected",
      quickLook: false,
      category: "incomplete-structure",
      code: "CONTENT_TYPES_MISSING",
    })

    const external = document.querySelector<HTMLButtonElement>('[data-office-action="external-open"]')
    const reveal = document.querySelector<HTMLButtonElement>('[data-office-action="reveal-run"]')
    expect(external?.disabled).toBe(false)
    expect(reveal?.disabled).toBe(false)
    external?.click()
    reveal?.click()
    await flush()

    expect(externalOpenCalls).toBe(1)
    expect(revealCalls).toBe(1)
    expect(document.querySelector('[data-office-action="quick-look"]')).toBeNull()
  })

  test("Quick Look failure degrades only the system-preview channel and remains retryable", async () => {
    quickLookOk = false
    mount({ status: "pass", quickLook: true, subtype: "docx" })

    document.querySelector<HTMLButtonElement>('[data-office-action="quick-look"]')?.click()
    await flush()

    expect(document.querySelector('[data-office-status="pass"]')).not.toBeNull()
    expect(document.querySelector(".a-wb-office-placeholder")).not.toBeNull()
    expect(document.querySelector(".a-wb-office-channel-notice code")?.textContent).toBe("PREVIEW_UNAVAILABLE")
    expect(document.querySelector<HTMLButtonElement>('[data-office-action="quick-look"]')?.disabled).toBe(false)
  })
})

function mount(officeStructure: PreviewContext["officeStructure"]) {
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(
    runtime.render(
      () =>
        runtime.createComponent(runtime.OfficeArtifactView, {
          ctx: context(officeStructure),
        }),
      host,
    ),
  )
}

function disposeAll() {
  disposers.splice(0).reverse().forEach((dispose) => dispose())
  document.body.replaceChildren()
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function context(officeStructure: PreviewContext["officeStructure"]): PreviewContext {
  const card: ArtifactCard = {
    key: "art_job_1_0",
    name: "report.docx",
    state: "verified",
    bytes: 100,
    savedPath: "artifacts/report.docx",
    descriptor: {
      schemaVersion: 1,
      id: "art_job_1_0",
      source: "cloud",
      name: "report.docx",
      size: 100,
      trust: "sandboxed",
      role: "primary",
      contentRef: { kind: "http-stream", url: "/v1/cloud/artifacts/art_job_1_0/content", auth: "bearer" },
      verification: { status: "verified" },
      provenance: { producer: "pipeline", jobId: "job_1" },
    },
    warnings: [],
    downloadable: false,
  }
  return {
    directory: "/workspace",
    runId: "job_1",
    readRef: { artifactId: card.descriptor!.id },
    name: card.name,
    decision: {
      rendererId: "fallback",
      effectiveMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      source: "detected",
      reason: "test",
      warnings: [],
      externalOpen: officeStructure?.status === "pass" ? "allowed" : "blocked",
      ...(officeStructure?.status === "pass" ? { ooxmlSubtype: officeStructure.subtype } : {}),
    },
    card,
    officeStructure,
  }
}
