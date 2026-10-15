// REQ-235 C1 渲染半场:按 `cloud@1` 描述画表单并派发。
// 描述取自宿主发布的 decoder 语料 `cloud-v1`(就是 artifact 里那一份),只在单条用例里做最小变体。
// 钉住:字段顺序与控件种类、I4(标签/帮助只作文本,永不作标记,永不出境)、I5(fixed 不渲染、
// 从签名载荷并入)、门控、逐字信封(无 budget、键集 = fields ∪ fixed)、共用生命周期,以及
// 两个注册表漂移码与 REQ-232 资金码的人话。
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import appPlugin from "@opencode-ai/app/vite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import type { createComponent } from "solid-js"
import type { render } from "solid-js/web"
import type { CloudFormBox } from "./cloud-form-box"
import type { CloudJobEnvelope, CloudJobEvent } from "../../preload/types"
import type { CloudBehaviorV1, CloudPayloadV1 } from "../../shared/host-extension-package-contract/decoder"
import { HOST_EXTENSION_PACKAGE_CORPUS } from "../../shared/host-extension-package-contract/generate-artifact"
import { dict as zh } from "../i18n/zh"

const directory = mkdtempSync(join(tmpdir(), "alpha-cloud-form-render-"))
await build({
  configFile: false,
  logLevel: "silent",
  plugins: [appPlugin.at(-1)!],
  build: {
    outDir: directory,
    lib: {
      entry: join(import.meta.dir, "upload-consent-test-runtime.ts"),
      formats: ["es"],
      fileName: () => "runtime.js",
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
})
GlobalRegistrator.register()
const runtime = (await import(pathToFileURL(join(directory, "runtime.js")).href)) as {
  createComponent: typeof createComponent
  render: typeof render
  CloudFormBox: typeof CloudFormBox
}
const disposers: (() => void)[] = []
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
  rmSync(directory, { recursive: true, force: true })
})

const corpus = (await Bun.file(
  resolve(import.meta.dir, "../../shared/host-extension-package-contract", HOST_EXTENSION_PACKAGE_CORPUS),
).json()) as { cases: Array<{ name: string; components: Array<{ payload: unknown }> }> }
const described = () =>
  structuredClone((corpus.cases.find((item) => item.name === "cloud-v1")!.components[0]!.payload as CloudPayloadV1).behavior)

// Server shapes come from the pinned producer corpus, not a handwritten HTTP payload.
const producer = join(import.meta.dir, "../../../../alpha-contracts-consumer/vendor/alpha-platform/contracts/v1/fixtures/producer")
const accepted = (await Bun.file(join(producer, "cloud-job-accepted.json")).json()).value
const status = (await Bun.file(join(producer, "cloud-job-status.json")).json()).value

function mount(options: {
  cloud?: CloudBehaviorV1
  ready?: boolean
  recovering?: boolean
  picked?: string[]
  error?: string
  result?: unknown
}) {
  const envelopes: CloudJobEnvelope[] = []
  const saves: unknown[][] = []
  const statusCalls: string[] = []
  const actions: string[] = []
  let event: ((payload: { jobId: string } & CloudJobEvent) => void) | undefined
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      openDirectoryPicker: async () => options.picked ?? ["/synthetic/results"],
      openPath: async () => {},
      auth: { start: async () => actions.push("login") },
      cloud: {
        dispatch: async (envelope: CloudJobEnvelope) => {
          envelopes.push(envelope)
          return options.error ? { error: options.error } : { ...accepted, kind: envelope.kind }
        },
        status: async (id: string) => {
          statusCalls.push(id)
          return { ...status, status: "completed", result: options.result ?? {} }
        },
        saveRun: async (...args: unknown[]) => {
          saves.push(args)
          return { ok: true, dir: "/synthetic/results/run", files: ["artifacts/output.html", "contract.json"], warnings: [] }
        },
        cancel: async () => ({ schema_version: 1, job_id: accepted.job_id, status: "cancelling", accepted: true }),
        subscribe: async () => ({ ok: true }),
        unsubscribe: async () => ({ ok: true }),
        onEvent: (handler: typeof event) => {
          event = handler
          return () => {}
        },
        openBillingPage: async (page: string) => actions.push(page),
      },
    },
  })
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(
    runtime.render(
      () =>
        runtime.createComponent(runtime.CloudFormBox, {
          cloud: options.cloud ?? described(),
          ready: options.ready ?? true,
          ...(options.recovering ? { recovering: true } : {}),
        }),
      host,
    ),
  )
  return {
    envelopes,
    saves,
    statusCalls,
    actions,
    send: (name: string) => event?.({ jobId: accepted.job_id, event: name, data: {}, id: "3" }),
  }
}
async function flush() {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
}
const submit = () => document.querySelector<HTMLButtonElement>("[data-cloud-form-submit]")!
const control = <T extends HTMLElement>(name: string, tag: string) =>
  document.querySelector<T>(`[data-cloud-field="${name}"] ${tag}`)
const fill = (name: string, value: string) => {
  const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[data-cloud-field="${name}"] textarea, [data-cloud-field="${name}"] input`,
  )!
  element.value = value
  element.dispatchEvent(new Event("input", { bubbles: true }))
}
const choose = (name: string, value: string) => {
  const select = control<HTMLSelectElement>(name, "select")!
  select.value = value
  select.dispatchEvent(new Event("change", { bubbles: true }))
}

describe("REQ-235 cloud form rendered from the catalog description", () => {
  test("fields render in order as inert text; fixed inputs never become controls (I4, I5)", () => {
    const cloud = described()
    cloud.fields[0]!.label = "<img src=x onerror=alert(1)>"
    mount({ cloud })
    expect(Array.from(document.querySelectorAll("[data-cloud-field]"), (node) => node.getAttribute("data-cloud-field"))).toEqual([
      "prompt",
      "title",
      "style",
    ])
    expect(Array.from(document.querySelectorAll("[data-cloud-field-label]"), (node) => node.textContent)).toEqual([
      "<img src=x onerror=alert(1)> *",
      "Title",
      "Style *",
    ])
    expect(document.querySelector("img")).toBeNull()
    expect(document.querySelector("[data-cloud-field-help]")?.textContent).toBe("What to generate.")
    expect(control<HTMLTextAreaElement>("prompt", "textarea")!.maxLength).toBe(4000)
    expect(control<HTMLInputElement>("title", "input")!.maxLength).toBe(120)
    const select = control<HTMLSelectElement>("style", "select")!
    expect(Array.from(select.options, (option) => option.value)).toEqual(["plain", "rich"])
    expect(select.value).toBe("plain")
    // fixed:没有对应的控件,也没有任何控件带着它的值。
    expect(document.querySelector('[data-cloud-field="format"]')).toBeNull()
    expect(Array.from(document.querySelectorAll<HTMLInputElement>("input, textarea"), (node) => node.value)).not.toContain("html")
    expect(document.querySelector("[data-cloud-upstream]")?.textContent).toBe("Sends the request, title and style you enter.")
    expect(document.querySelector("[data-cloud-hold]")?.textContent).toBe(zh["alpha.ext.cloudHold"].replace("{{usd}}", "1.00"))
  })

  test("gating follows required, trimmed minChars, a required select without default, and readiness", () => {
    const cloud = described()
    cloud.fields[0] = { ...cloud.fields[0]!, control: "textarea", minChars: 3, maxChars: 10 } as CloudBehaviorV1["fields"][number]
    cloud.fields[2] = { name: "style", control: "select", required: true, options: [{ value: "plain", label: "Plain" }], label: "Style" }
    mount({ cloud })
    expect(submit().disabled).toBe(true)
    fill("prompt", "  ab  ")
    expect(submit().disabled).toBe(true)
    fill("prompt", " abc ")
    expect(submit().disabled).toBe(true)
    expect(control<HTMLSelectElement>("style", "select")!.value).toBe("")
    choose("style", "plain")
    expect(submit().disabled).toBe(false)
    fill("title", "   ")
    expect(submit().disabled).toBe(false)

    document.body.replaceChildren()
    mount({ ready: false })
    fill("prompt", "Make a page")
    expect(submit().disabled).toBe(true)
    expect(document.body.textContent).toContain(zh["alpha.ext.cloudNeedPlatformNote"])
    document.body.replaceChildren()
    mount({ ready: false, recovering: true })
    expect(document.body.textContent).toContain(zh["alpha.ext.cloudRecoveringNote"])
  })

  test("dispatch sends the exact envelope: fixed merged, no budget, keys = fields ∪ fixed, no presentation text", async () => {
    const harness = mount({})
    fill("prompt", "  Make a landing page  ")
    submit().click()
    await flush()
    expect(harness.envelopes).toEqual([
      {
        autonomy: "pipeline",
        kind: "example-generate",
        input: { format: "html", prompt: "Make a landing page", style: "plain" },
        constraints: { network: "restricted" },
      },
    ])
    const wire = JSON.stringify(harness.envelopes[0])
    for (const presentation of ["Request", "What to generate.", "Title", "Plain", "Sends the request"])
      expect(wire).not.toContain(presentation)

    document.body.replaceChildren()
    const second = mount({})
    fill("prompt", "Page")
    fill("title", " Launch ")
    choose("style", "rich")
    submit().click()
    await flush()
    expect(second.envelopes[0]!.input).toEqual({ format: "html", prompt: "Page", title: "Launch", style: "rich" })
    expect(Object.keys(second.envelopes[0]!.input!).sort()).toEqual(["format", "prompt", "style", "title"])
  })

  test("a cancelled results-folder pick sends nothing and returns to idle", async () => {
    const harness = mount({ picked: [] })
    fill("prompt", "Page")
    submit().click()
    await flush()
    expect(harness.envelopes).toEqual([])
    expect(submit().disabled).toBe(false)
    expect(submit().textContent).toBe(zh["alpha.ext.cloudStart"])
  })

  test("the shared lifecycle reads the result, saves the exact envelope, lists artifacts and offers cancel", async () => {
    const harness = mount({ result: { finalAnswer: "Generated summary" } })
    fill("prompt", "Page")
    submit().click()
    await flush()
    expect(document.querySelector("[data-cancel-job]")).not.toBeNull()
    expect(document.body.textContent).toContain(zh["alpha.ext.cloudRunning"])
    harness.send("job.completed")
    await flush()
    expect(harness.statusCalls).toEqual([accepted.job_id])
    expect(harness.saves).toEqual([["/synthetic/results", accepted.job_id, harness.envelopes[0]]])
    expect(document.querySelector("[data-cloud-result]")?.textContent).toBe("Generated summary")
    expect(Array.from(document.querySelectorAll("[data-cloud-file]"), (node) => node.textContent)).toEqual(["artifacts/output.html"])
    expect(document.body.textContent).toContain(zh["alpha.ext.cloudDone"])
  })

  test.each([
    ["pipeline_input_invalid", zh["alpha.ext.cloudErrRequirementsChanged"], null],
    ["unknown_pipeline_kind", zh["alpha.ext.cloudErrRequirementsChanged"], null],
    ["account_wallet_insufficient", zh["alpha.ext.cloudErrWallet"], "recharge"],
    ["account_allowance_exhausted", zh["alpha.ext.cloudErrAllowance"], "overflow"],
  ] as const)("dispatch refusal %s reaches the user in plain words", async (code, message, action) => {
    const harness = mount({ error: code })
    fill("prompt", "Page")
    submit().click()
    await flush()
    expect(document.querySelector(".alpha-ext-card-err")?.textContent).toBe(message)
    expect(document.body.textContent).not.toContain(code)
    const button = document.querySelector<HTMLButtonElement>("[data-cloud-error-action]")
    if (!action) {
      expect(button).toBeNull()
      return
    }
    button!.click()
    await flush()
    expect(harness.actions).toEqual([action])
  })
})
