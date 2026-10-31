import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import appPlugin from "@opencode-ai/app/vite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import { decodeContract } from "@alpha-code/contracts-consumer"
import type { createComponent } from "solid-js"
import type { render } from "solid-js/web"
import type { CloudJobEnvelope, CloudUploadResult, UploadPreview } from "../../preload/types"
import type { UploadConsentDialog } from "./upload-consent-dialog"
import type { CloudDispatchBox } from "./cloud-dispatch-box"
import type { ExtensionDetail } from "./extension-detail"
import type { CatalogEntry, CloudPipelineSpec } from "./catalog-types"
import bundledCatalog from "./alpha-catalog.json"
import { dict as zh } from "../i18n/zh"

type Runtime = {
  createComponent: typeof createComponent
  render: typeof render
  UploadConsentDialog: typeof UploadConsentDialog
  CloudDispatchBox: typeof CloudDispatchBox
  ExtensionDetail: typeof ExtensionDetail
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
    expect(dialog?.textContent).toContain("2 个文件，共 1.5 KB")
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

// ---- #400(REQ-109 AC4 桌面半场):取消要拿到服务端可判定结果才改显示,cancelling ≠ cancelled ----

type CancelResult =
  | { schema_version: 1; job_id: string; status: string; accepted: boolean }
  | { error: string }

function mountRunningJob(options: { cancel: () => Promise<CancelResult> }) {
  let pushEvent: ((payload: { jobId: string; event: string; data: unknown }) => void) | undefined
  const cancelCalls: string[] = []
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      cloud: {
        upload: async () => ({
          status: "sent",
          privacy: "clear",
          directory: "/project",
          job: {
            schema_version: 1,
            job_id: "job_cancelme",
            status: "queued",
            autonomy: "pipeline",
            kind: "code-review",
            urls: { status: "/status", events: "/events", result: "/result" },
          },
        }),
        confirmUpload: async () => ({ status: "cancelled" }),
        cancelUpload: async () => ({ status: "cancelled" }),
        status: async () => ({ ...statusFixture, status: "cancelled" }),
        cancel: async (jobId: string) => {
          cancelCalls.push(jobId)
          return options.cancel()
        },
        subscribe: async () => ({ ok: true }),
        unsubscribe: async () => ({ ok: true }),
        onEvent: (handler: (payload: { jobId: string; event: string; data: unknown }) => void) => {
          pushEvent = handler
          return () => {}
        },
        saveRun: async () => ({ ok: true, dir: "/project/.alpha/runs/job_cancelme", files: [], warnings: [], failures: [] }),
      },
    },
  })
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(
    runtime.render(() => runtime.createComponent(runtime.CloudDispatchBox, { spec, ready: true }), host),
  )
  return { cancelCalls, sse: (event: string) => pushEvent?.({ jobId: "job_cancelme", event, data: {} }) }
}

const cancelButton = () => document.querySelector<HTMLButtonElement>("button[data-cancel-job]")

describe("#400 cancel semantics: server-decidable result, never optimistic", () => {
  test("accepted cancel shows CANCELLING (not cancelled) until the SSE terminal closes it", async () => {
    const harness = mountRunningJob({
      cancel: async () => ({ schema_version: 1, job_id: "job_cancelme", status: "cancelling", accepted: true }),
    })
    document.querySelector<HTMLButtonElement>('.alpha-ext-add[data-variant="primary"]')!.click()
    await flush()

    // running:取消入口在,任何取消 UI 未出现。
    expect(cancelButton()).not.toBeNull()
    cancelButton()!.click()
    await flush()

    // 服务端受理 → 显示「正在取消」;绝不显示已完成/已取消的终态文案,也不显示任务失败。
    expect(harness.cancelCalls).toEqual(["job_cancelme"])
    expect(document.querySelector("[data-cancelling]")?.textContent).toBe(zh["alpha.ext.cloudCancelling"])
    expect(cancelButton()).toBeNull()
    expect(document.body.textContent).not.toContain(zh["alpha.ext.cloudDone"])
    expect(document.body.textContent).not.toContain(zh["alpha.ext.cloudRunFailed"])

    // 终态只能由服务端事实(SSE job.cancelled)驱动。
    harness.sse("job.cancelled")
    await flush()
    expect(document.body.textContent).toContain(zh["alpha.ext.cloudRunFailed"])
    expect(document.querySelector("[data-cancelling]")).toBeNull()
  })

  test("a rejected cancel (already terminal) says so and does NOT pretend the job stopped", async () => {
    mountRunningJob({
      cancel: async () => ({ schema_version: 1, job_id: "job_cancelme", status: "completed", accepted: false }),
    })
    document.querySelector<HTMLButtonElement>('.alpha-ext-add[data-variant="primary"]')!.click()
    await flush()
    cancelButton()!.click()
    await flush()

    expect(document.body.textContent).toContain(zh["alpha.ext.cloudCancelRejected"])
    expect(document.querySelector("[data-cancelling]")).toBeNull()
    // 运行显示保持由服务端事实驱动 —— 没有任何本地编造的 cancelled。
    expect(document.body.textContent).toContain(zh["alpha.ext.cloudRunning"])
  })

  test("a transport failure keeps the cancel entry available instead of faking any cancel state", async () => {
    mountRunningJob({ cancel: async () => ({ error: "network" }) })
    document.querySelector<HTMLButtonElement>('.alpha-ext-add[data-variant="primary"]')!.click()
    await flush()
    cancelButton()!.click()
    await flush()

    expect(document.body.textContent).toContain(zh["alpha.ext.cloudErrNetwork"])
    expect(document.querySelector("[data-cancelling]")).toBeNull()
    expect(cancelButton()).not.toBeNull()
    expect(cancelButton()!.disabled).toBe(false)
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

  // #1508: unknown platform outcomes stay distinct from local refusal (nothing sent).
  test("unknown platform send result asks the user to check task status", async () => {
    mountDispatch({ status: "failed", error: "upload_reserved_input" })
    document.querySelector<HTMLButtonElement>('.alpha-ext-add[data-variant="primary"]')!.click()
    await flush()
    const err = document.querySelector(".alpha-ext-card-err")?.textContent ?? ""
    expect(err).toBe(zh["alpha.ext.cloudUnknownUpload"])
    expect(err).not.toContain("upload_reserved_input")
    expect(err).not.toContain(zh["alpha.cloud.consent.errScope"])
  })

  test("another unknown platform result never claims nothing was sent", async () => {
    mountDispatch({ status: "failed", error: "upload_consent_replayed" })
    document.querySelector<HTMLButtonElement>('.alpha-ext-add[data-variant="primary"]')!.click()
    await flush()
    const err = document.querySelector(".alpha-ext-card-err")?.textContent ?? ""
    expect(err).toBe(zh["alpha.ext.cloudUnknownUpload"])
    expect(err).not.toContain("upload_consent_replayed")
    expect(err).not.toContain(zh["alpha.cloud.consent.errScope"])
  })

  // [#940] 反向判据:本地准入码(`upload-` 前缀 kebab)仍然给人话「范围」文案、裸码不上屏 ——
  // 一个「什么都原样透出」的恒显实现能过上面两条正向,但过不了这条。
  test("a local admission code still renders the scope message, never the raw code", async () => {
    mountDispatch({ status: "failed", error: "upload-main-gate-required" })
    document.querySelector<HTMLButtonElement>('.alpha-ext-add[data-variant="primary"]')!.click()
    await flush()
    const err = document.querySelector(".alpha-ext-card-err")?.textContent ?? ""
    expect(err).toContain(zh["alpha.cloud.consent.errScope"])
    expect(err).not.toContain("upload-main-gate-required")
  })
})

// Server shapes come from the pinned producer corpus, not a handwritten HTTP payload.
// Input/result contents below are synthetic; fields match gateway/src/pipelines.ts researchRun/docsRun.
const producer = join(import.meta.dir, "../../../../alpha-contracts-consumer/vendor/alpha-platform/contracts/v1/fixtures/producer")
const requestFixture = (await Bun.file(join(producer, "cloud-job-request.json")).json()).value
const acceptedFixture = (await Bun.file(join(producer, "cloud-job-accepted.json")).json()).value
const statusFixture = (await Bun.file(join(producer, "cloud-job-status.json")).json()).value

function mountCloudEntry(id: string, kind: CloudPipelineSpec["pipelineKind"], result: unknown) {
  const entry = {
    ...bundledCatalog.entries.find((entry) => entry.id === (kind === "office-report" ? "cloud:docs" : id))!,
    id,
    displayName: id,
    installSpec: { ...spec, pipelineKind: kind },
  } as CatalogEntry
  const envelopes: CloudJobEnvelope[] = []
  const saves: unknown[][] = []
  const opened: string[] = []
  let event: ((payload: { jobId: string; event: string; data: unknown }) => void) | undefined
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      openDirectoryPicker: async () => ["/results"],
      openPath: async (path: string) => { opened.push(path) },
      cloud: {
        dispatch: async (envelope: CloudJobEnvelope) => {
          envelopes.push(envelope)
          return { ...acceptedFixture, kind }
        },
        gitDiff: async () => ({ ok: true, diff: requestFixture.input.diff, source: "worktree" }),
        status: async () => ({ ...statusFixture, job_id: acceptedFixture.job_id, kind, result }),
        subscribe: async () => ({ ok: true }),
        unsubscribe: async () => ({ ok: true }),
        onEvent: (handler: typeof event) => { event = handler; return () => {} },
        saveRun: async (...args: unknown[]) => {
          saves.push(args)
          return { ok: true, dir: "/results/.code-puppy/runs/job", files: kind === "office-report" ? [`artifacts/output.${id === "cloud:word" ? "docx" : id === "cloud:excel" ? "xlsx" : "pptx"}`] : [], warnings: [], failures: [] }
        },
      },
    },
  })
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(runtime.render(() => runtime.createComponent(runtime.ExtensionDetail, {
    target: { kind: "entry", entry },
    ext: { store: { mcp: {}, receipts: [] }, isInstalled: () => false } as unknown as Parameters<typeof ExtensionDetail>[0]["ext"],
    catalogVersion: bundledCatalog.version, byId: () => undefined, busy: () => null, crumb: "Cloud",
    onBack: () => {}, onInstall: () => {}, onUninstall: () => {}, onOpenEntry: () => {},
    onPackageAction: async () => undefined, cloudReady: () => true,
    curationStatus: () => ({ kind: "uncurated" }), nowIso: () => "2026-10-12T00:00:00Z",
    onToggleState: async () => {}, sessionViewFor: () => ({ on: false, textKey: "alpha.ext.sessionOffRow", tone: "muted" }),
    sessionAvailable: () => false, sessionBusyFor: () => false, onSessionToggle: async () => {},
  }), host))
  return {
    envelopes, saves, opened,
    sse: (name: string) => event?.({ jobId: acceptedFixture.job_id, event: name, data: {} }),
  }
}

describe("#1509 customization center cloud entries", () => {
  test.each([
    ["research", "question", { finalAnswer: "Research result\nSources: https://example.com" }],
    ["docs", "code", { docs: "# Generated README\nUsage example" }],
  ] as const)("AC1 %s detail dispatches producer-shaped input and displays/copies the final text", async (kind, field, result) => {
    const harness = mountCloudEntry(`cloud:${kind}`, kind, result)
    const input = document.querySelector<HTMLTextAreaElement>("textarea")
    expect(input).not.toBeNull()
    const button = document.querySelector<HTMLButtonElement>("[data-cloud-input]")!
    expect(button.disabled).toBe(true)
    input!.value = "  Input for the cloud task  "
    input!.dispatchEvent(new Event("input", { bubbles: true }))
    button.click()
    await flush()
    expect(harness.envelopes).toHaveLength(1)
    expect(harness.envelopes[0]).toMatchObject({ autonomy: requestFixture.autonomy, kind, input: { [field]: "Input for the cloud task" } })
    expect(decodeContract("CloudJobRequestV1", { ...requestFixture, ...harness.envelopes[0] }, "cloud-http").kind).toBe(kind)
    harness.sse("workflow.step.completed")
    await flush()
    expect(document.querySelector("[data-live]")?.textContent).toContain(zh["alpha.ext.cloudProgress"])
    harness.sse("job.completed")
    await flush()
    const text = "finalAnswer" in result ? result.finalAnswer : result.docs
    expect(document.querySelector("[data-cloud-result]")?.textContent).toBe(text)
    document.querySelector<HTMLButtonElement>("[data-copy-cloud-result]")!.click()
    await flush()
    expect(await navigator.clipboard.readText()).toBe(text)
    expect(harness.saves[0]).toEqual(["/results", acceptedFixture.job_id, harness.envelopes[0]])
    expect(document.body.textContent).toContain(zh["alpha.ext.cloudDone"])
    expect(document.body.textContent).not.toContain(zh["alpha.cloud.consent.legacyDiff"])
  })

  test.each([
    ["word", "docx"], ["excel", "xlsx"], ["powerpoint", "pptx"],
  ])("AC2 %s detail sends explicit %s and opens the downloaded file", async (name, format) => {
    const harness = mountCloudEntry(`cloud:${name}`, "office-report", {})
    const input = document.querySelector<HTMLTextAreaElement>("textarea")!
    expect(input).not.toBeNull()
    input.value = "Quarterly report"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    document.querySelector<HTMLButtonElement>("[data-cloud-input]")!.click()
    await flush()
    expect(harness.envelopes[0]).toMatchObject({ kind: "office-report", input: { topic: "Quarterly report", format } })
    expect(decodeContract("CloudJobRequestV1", { ...requestFixture, ...harness.envelopes[0] }, "cloud-http").input).toEqual({ topic: "Quarterly report", format })
    harness.sse("job.completed")
    await flush()
    expect(harness.saves[0]).toEqual(["/results", acceptedFixture.job_id, harness.envelopes[0]])
    const file = document.querySelector<HTMLButtonElement>("[data-cloud-file]")!
    expect(file.textContent).toBe(`artifacts/output.${format}`)
    file.click()
    await flush()
    expect(harness.opened).toEqual([`/results/.code-puppy/runs/job/artifacts/output.${format}`])
  })

  test("AC3 code-review retains its diff dispatch and completed run display", async () => {
    const harness = mountCloudEntry("cloud:code-review", "code-review", statusFixture.result)
    expect(document.querySelector("textarea")).toBeNull()
    Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === zh["alpha.cloud.consent.legacyDiff"])!.click()
    await flush()
    expect(harness.envelopes[0]).toMatchObject({ kind: requestFixture.kind, input: requestFixture.input })
    harness.sse("job.completed")
    await flush()
    expect(harness.saves).toHaveLength(1)
    expect(document.body.textContent).toContain(zh["alpha.ext.cloudDone"])
    expect(document.querySelector("[data-cloud-result]")).toBeNull()
  })
})

// ── #1595 定制中心详情页说人话(批准稿 docs/design/2026-10-30-req236-ux-config-pages #cloud-task / #cloud-connector)──

function mountDetail(target: Parameters<typeof ExtensionDetail>[0]["target"], options: { cloudReady?: boolean; onLogin?: () => void } = {}) {
  Object.defineProperty(window, "api", { configurable: true, value: { openDirectoryPicker: async () => [], cloud: {} } })
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(runtime.render(() => runtime.createComponent(runtime.ExtensionDetail, {
    target,
    ext: { store: { mcp: {}, receipts: [] }, isInstalled: () => false } as unknown as Parameters<typeof ExtensionDetail>[0]["ext"],
    catalogVersion: bundledCatalog.version, byId: () => undefined, busy: () => null, crumb: "Cloud",
    onBack: () => {}, onInstall: () => {}, onUninstall: () => {}, onOpenEntry: () => {},
    onPackageAction: async () => undefined, cloudReady: () => options.cloudReady ?? true, onLogin: options.onLogin,
    curationStatus: () => ({ kind: "uncurated" }), nowIso: () => "2026-10-30T00:00:00Z",
    onToggleState: async () => {}, sessionViewFor: () => ({ on: false, textKey: "alpha.ext.sessionOffRow", tone: "muted" }),
    sessionAvailable: () => false, sessionBusyFor: () => false, onSessionToggle: async () => {},
  }), host))
}

describe("#1595 AC2 云端任务详情首屏:最长运行 / 发送内容 / 结果 / 费用,技术参数进开发者详情", () => {
  const research = () => bundledCatalog.entries.find((entry) => entry.id === "cloud:research")! as unknown as CatalogEntry

  test("首屏是人话,不渲染 iter / tokens / Tier / 任务类型;这些只在「开发者详情」里", async () => {
    mountDetail({ kind: "entry", entry: research() })
    await flush()

    const facts = document.querySelector("[data-alpha-cloud-task-facts]")?.textContent ?? ""
    // 「做什么」取条目自身的描述;页头简介不再重复同一段。
    expect(facts).toContain(zh["alpha.ext.cloudWhat"])
    expect(facts).toContain(research().description)
    expect(document.querySelector(".alpha-ext-dabout") === null).toBe(true)
    for (const label of [zh["alpha.ext.cloudMaxRun"], zh["alpha.ext.cloudSends"], zh["alpha.ext.cloudResult"], zh["alpha.ext.cloudCost"]]) {
      expect(facts).toContain(label)
    }
    expect(facts).toContain("约 10 分钟")
    expect(facts).toContain("存到所选文件夹")
    expect(facts).toContain("按用量结算")
    expect(facts).not.toMatch(/iter|tokens|Tier|research/)

    const dev = document.querySelector<HTMLDetailsElement>("details[data-alpha-cloud-task-dev]")
    expect(dev !== null).toBe(true)
    expect(dev!.open).toBe(false)
    expect(dev!.querySelector("summary")?.textContent).toBe(zh["alpha.timeline.devDetails"])
    expect(dev!.textContent).toContain("research")
    expect(dev!.textContent).toContain("tokens")
    expect(dev!.textContent).toContain("input.question")
  })

  test("最长运行由目录里的秒数换算(1800 秒 ⇒ 约 30 分钟),不是写死的数", async () => {
    const entry = research()
    const spec = entry.installSpec as CloudPipelineSpec
    mountDetail({
      kind: "entry",
      entry: { ...entry, installSpec: { ...spec, budgetDefaults: { ...spec.budgetDefaults, max_wall_clock_sec: 1800 } } } as CatalogEntry,
    })
    await flush()
    expect(document.querySelector("[data-alpha-cloud-task-facts]")?.textContent).toContain("约 30 分钟")
  })
})

describe("#1595 AC3 云连接器详情:人话标题、状态、登录入口与自动连接;函数名只在开发者详情", () => {
  test("未登录 ⇒「未连接 · 需登录」+「登录」;工具行首是自然语言名,可读标识 codepuppy:<动作> 只出现在开发者详情", async () => {
    let logins = 0
    mountDetail({ kind: "cloud-connector" }, { cloudReady: false, onLogin: () => logins++ })
    await flush()

    expect(document.body.textContent).toContain("云连接器")
    expect(document.body.textContent).not.toContain("云连接器(cloud)")
    expect(document.body.textContent).toContain("未连接 · 需登录")
    expect(document.body.textContent).toContain(zh["alpha.ext.cloudInjectTitle"])
    const login = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === zh["alpha.auth.signIn"])
    expect(login !== undefined).toBe(true)
    login!.click()
    expect(logins).toBe(1)

    const tools = document.querySelector("[data-alpha-cloud-tools]")!
    const heads = [...tools.querySelectorAll(".alpha-ext-dtool b")].map((el) => el.textContent)
    expect(heads).toEqual([
      zh["alpha.timeline.cloud.dispatch"],
      zh["alpha.timeline.cloud.status"],
      zh["alpha.timeline.cloud.await"],
      zh["alpha.timeline.cloud.artifacts"],
    ])
    expect(tools.textContent).not.toContain("codepuppy")
    // alpha-code#1568 AC5:开发者详情里是可读标识 `<服务器键>:<远端名>`,不是模型函数名。
    const dev = document.querySelector("details[data-alpha-cloud-tools-dev]")!
    expect(dev.textContent).toContain("codepuppy:dispatch")
    expect(dev.textContent).toContain("codepuppy:artifacts")
    expect(dev.textContent).not.toContain("cloud_")
  })
})

describe("#1595 AC4 发送框、结果、生效状态与云端错误的文字按批准稿对照表", () => {
  test("zh 文案逐条对照,且不写 .code-puppy/runs 一类目录名", () => {
    const expected: Partial<Record<keyof typeof zh, string>> = {
      "alpha.ext.hubStatePending": "待生效",
      "alpha.ext.hubReasonWaiting": "对话空闲后自动生效",
      "alpha.ext.hubReasonFailed": "上次未能生效",
      "alpha.ext.hubReloadNow": "立即生效",
      "alpha.ext.hubReloadNowHint": "会打断正在输出的回答",
      "alpha.ext.hubReloadNowRefused": "未能生效,请重启应用",
      "alpha.cloud.runSaved": "结果已存到本机",
      "alpha.ext.cloudConnRecovering": "正在恢复登录",
      "alpha.ext.cloudConnectorTitle": "云连接器",
      "alpha.ext.cloudConnNeedLogin": "未连接 · 需登录",
      "alpha.ext.cloudInjectTitle": "自动连接",
      "alpha.ext.cloudInputHint": "离开本页后不再自动保存",
      "alpha.ext.cloudDiffSource": "审查范围",
      "alpha.ext.cloudDiffWorktree": "未提交的改动",
      "alpha.ext.cloudDiffLastCommit": "最近一次提交",
      "alpha.ext.cloudDone": "已完成",
      "alpha.ext.cloudSaved": "已保存",
      "alpha.ext.cloudErrConsentDeclined": "未同意上传,未发送",
      "alpha.ext.cloudErrNetwork": "暂时连不上云端服务,稍后重试",
    }
    for (const [key, value] of Object.entries(expected)) expect(zh[key as keyof typeof zh], key).toBe(value)
    for (const key of ["alpha.cloud.runSaved", "alpha.ext.cloudSub", "alpha.ext.cloudInputHint"] as const) {
      expect(zh[key]).not.toContain(".code-puppy")
    }
  })
})
