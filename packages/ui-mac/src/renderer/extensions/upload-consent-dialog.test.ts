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
import type { CloudUploadResult, UploadPreview } from "../../preload/types"
import type { UploadConsentDialog } from "./upload-consent-dialog"
import type { CloudDispatchBox } from "./cloud-dispatch-box"
import type { CloudPipelineSpec } from "./catalog-types"
import { dict as zh } from "../i18n/zh"

type Runtime = {
  createComponent: typeof createComponent
  render: typeof render
  UploadConsentDialog: typeof UploadConsentDialog
  CloudDispatchBox: typeof CloudDispatchBox
}

const runtimeDirectory = mkdtempSync(join(tmpdir(), "alpha-upload-consent-render-"))
await build({
  configFile: false,
  logLevel: "silent",
  plugins: [appPlugin.at(-1)!],
  build: {
    emptyOutDir: true,
    outDir: runtimeDirectory,
    lib: {
      entry: join(import.meta.dir, "upload-consent-test-runtime.ts"),
      formats: ["es"],
      fileName: () => "upload-consent-test-runtime.js",
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
})

const disposers: Array<() => void> = []
GlobalRegistrator.register()
const runtime = (await import(pathToFileURL(join(runtimeDirectory, "upload-consent-test-runtime.js")).href)) as Runtime

const preview: UploadPreview = {
  pipeline: "code-review",
  fileCount: 2,
  totalBytes: 1550,
  files: [
    { path: "src/contact.ts", sizeBytes: 1500, sensitive: true },
    { path: "src/clean.ts", sizeBytes: 50, sensitive: false },
  ],
  findings: [
    { kind: "contact", fileCount: 1 },
    { kind: "credential", fileCount: 1 },
  ],
  purpose: "artifact.upload",
  retentionClass: "standard",
}

beforeEach(() => document.body.replaceChildren())
afterEach(() => disposers.splice(0).reverse().forEach((dispose) => dispose()))
afterAll(async () => {
  await GlobalRegistrator.unregister()
  rmSync(runtimeDirectory, { recursive: true, force: true })
})

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function mount(options: { busy?: boolean; onCancel?: () => void; onConfirm?: () => void } = {}) {
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(
    runtime.render(
      () =>
        runtime.createComponent(runtime.UploadConsentDialog, {
          state: { requestId: "request-1", preview },
          busy: options.busy ?? false,
          onCancel: options.onCancel ?? (() => {}),
          onConfirm: options.onConfirm ?? (() => {}),
        }),
      host,
    ),
  )
}

const spec: CloudPipelineSpec = {
  kind: "cloud",
  pipelineKind: "code-review",
  inputContract: [],
  budgetDefaults: { max_iter: 5, max_tokens: 10_000, max_wall_clock_sec: 60 },
  budgetLimits: { max_iter: 10, max_tokens: 20_000, max_wall_clock_sec: 120 },
  tier: "pipeline",
  upstreamData: [],
}

function mountDispatch(result: CloudUploadResult) {
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      cloud: {
        upload: async () => result,
        confirmUpload: async () => result,
        cancelUpload: async () => ({ status: "cancelled" }),
        subscribe: async () => ({ ok: true }),
        unsubscribe: async () => ({ ok: true }),
        onEvent: () => () => {},
        saveRun: async () => ({ ok: false, reason: "not reached" }),
      },
    },
  })
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(
    runtime.render(
      () => runtime.createComponent(runtime.CloudDispatchBox, { spec, ready: true }),
      host,
    ),
  )
}

describe("approved explicit-upload consent dialog harness", () => {
  test("renders protected findings bounded scope purpose retention and expandable file preview", async () => {
    mount()
    await flush()

    const dialog = document.querySelector("[role=dialog]")
    expect(dialog?.textContent).toContain(zh["alpha.cloud.consent.title"])
    expect(dialog?.textContent).toContain("2 个文件 · 1.5 KB")
    expect(dialog?.textContent).toContain(zh["alpha.cloud.consent.purposeLabel"])
    expect(dialog?.textContent).toContain(zh["alpha.cloud.consent.retentionLabel"])
    expect(document.querySelectorAll(".alpha-upl-file")).toHaveLength(0)

    document.querySelector<HTMLButtonElement>(".alpha-upl-more")!.click()
    await flush()
    expect(document.querySelectorAll(".alpha-upl-file")).toHaveLength(2)
    expect(document.querySelector(".alpha-upl-file[data-flag]")?.textContent).toContain("src/contact.ts")
    expect(document.querySelectorAll(".alpha-upl-file .chip")).toHaveLength(1)
  })

  test("cancel is the safe autofocus action and Escape backdrop and button all cancel", async () => {
    let cancellations = 0
    mount({ onCancel: () => cancellations++ })
    await flush()

    const cancel = document.querySelector<HTMLButtonElement>('.a-btn[data-variant="ghost"]')!
    expect(document.activeElement).toBe(cancel)
    cancel.click()
    document.querySelector<HTMLElement>(".a-dialog-backdrop")!.click()
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
    expect(cancellations).toBe(3)
  })

  test("busy confirmation is loading and cannot dismiss or double-submit", async () => {
    let cancellations = 0
    let confirmations = 0
    mount({ busy: true, onCancel: () => cancellations++, onConfirm: () => confirmations++ })
    await flush()

    const primary = document.querySelector<HTMLButtonElement>('.a-btn[data-variant="primary"]')!
    expect(primary.disabled).toBe(true)
    expect(primary.getAttribute("aria-busy")).toBe("true")
    primary.click()
    document.querySelector<HTMLElement>(".a-dialog-backdrop")!.click()
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
    expect(confirmations).toBe(0)
    expect(cancellations).toBe(0)
  })
})

describe("four approved upload UI outcomes", () => {
  test("sensitive opens the preview dialog", async () => {
    mountDispatch({ status: "consent-required", requestId: "request-1", preview })
    document.querySelector<HTMLButtonElement>('.alpha-ext-add[data-variant="primary"]')!.click()
    await flush()
    expect(document.querySelector("[role=dialog]")).not.toBeNull()
  })

  test("non-sensitive is silent and shows the non-blocking transparency line", async () => {
    mountDispatch({
      status: "sent",
      privacy: "clear",
      directory: "/project",
      job: {
        schema_version: 1,
        job_id: "job_clear",
        status: "queued",
        autonomy: "pipeline",
        kind: "code-review",
        urls: { status: "/status", events: "/events", result: "/result" },
      },
    })
    document.querySelector<HTMLButtonElement>('.alpha-ext-add[data-variant="primary"]')!.click()
    await flush()
    expect(document.querySelector("[role=dialog]")).toBeNull()
    expect(document.body.textContent).toContain(zh["alpha.cloud.consent.silentPass"])
  })

  test("cancelled returns to neutral without dialog or inline error", async () => {
    mountDispatch({ status: "cancelled" })
    document.querySelector<HTMLButtonElement>('.alpha-ext-add[data-variant="primary"]')!.click()
    await flush()
    expect(document.querySelector("[role=dialog]")).toBeNull()
    expect(document.querySelector(".alpha-ext-card-err")).toBeNull()
  })

  test("failure closes the dialog surface and renders an inline error", async () => {
    mountDispatch({ status: "failed", error: "upload-consent-issuance-failed" })
    document.querySelector<HTMLButtonElement>('.alpha-ext-add[data-variant="primary"]')!.click()
    await flush()
    expect(document.querySelector("[role=dialog]")).toBeNull()
    expect(document.querySelector(".alpha-ext-card-err")?.textContent).toContain(zh["alpha.cloud.consent.errToken"])
  })
})
