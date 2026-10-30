import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import appPlugin from "@opencode-ai/app/vite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import type { createComponent } from "solid-js"
import type { render } from "solid-js/web"
import type { CloudDispatchBox } from "./cloud-dispatch-box"
import type { CloudJobEnvelope, CloudJobEvent } from "../../preload/types"
import type { CloudPipelineSpec } from "./catalog-types"
import bundledCatalog from "./alpha-catalog.json"
import { dict as zh } from "../i18n/zh"

const directory = mkdtempSync(join(tmpdir(), "alpha-cloud-failure-render-"))
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
  CloudDispatchBox: typeof CloudDispatchBox
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
// Shape sources: rev2 §1.2/§8, gateway routes/cloud-jobs.ts:228-232,261,288,300.
// Live and replay serialize the same event record; synthesized frames serialize a status view.
const producer = join(
  import.meta.dir,
  "../../../../alpha-contracts-consumer/vendor/alpha-platform/contracts/v1/fixtures/producer",
)
const accepted = (await Bun.file(join(producer, "cloud-job-accepted.json")).json()).value
const status = { ...(await Bun.file(join(producer, "cloud-job-status.json")).json()).value, status: "failed" }
const live = (code?: string) => ({
  seq: 7,
  ts: "2026-10-14T00:00:00Z",
  type: "job.failed",
  data: { kind: "research", ...(code ? { code } : {}) },
})
const allowance =
  "会员额度已用完。默认不会自动扣钱包余额,充值也不能恢复;可以等额度窗口重置,或到网站账户页打开「额度用完后用余额付」。"
const wallet = "钱包余额不够这次任务要预留的金额。请先充值,或等在途任务结算后再试。"

async function mount(error?: string, failureCode?: string, netLayer?: string) {
  const actions: string[] = []
  const statusCalls: string[] = []
  let event: ((payload: { jobId: string } & CloudJobEvent) => void) | undefined
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      openDirectoryPicker: async () => ["/synthetic/results"],
      auth: {
        start: async () => {
          actions.push("login")
        },
      },
      cloud: {
        dispatch: async () => (error ? (netLayer ? { error, netLayer } : { error }) : accepted),
        status: async (id: string) => {
          statusCalls.push(id)
          return { ...status, result: failureCode ? { failure_code: failureCode } : {} }
        },
        saveRun: async () => ({ ok: true, dir: "/synthetic/results/run", files: [], warnings: [], failures: [] }),
        subscribe: async () => ({ ok: true }),
        unsubscribe: async () => ({ ok: true }),
        onEvent: (handler: typeof event) => {
          event = handler
          return () => {}
        },
        openBillingPage: async (page: string) => {
          actions.push(page)
        },
      },
    },
  })
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(
    runtime.render(
      () =>
        runtime.createComponent(runtime.CloudDispatchBox, {
          spec: { type: "cloud-pipeline", pipelineKind: "research" },
          ready: true,
        }),
      host,
    ),
  )
  const input = document.querySelector<HTMLTextAreaElement>("textarea")!
  input.value = "Synthetic research question"
  input.dispatchEvent(new Event("input", { bubbles: true }))
  document.querySelector<HTMLButtonElement>("[data-cloud-input]")!.click()
  await flush()
  return {
    actions,
    statusCalls,
    send: (data: unknown, name = "job.failed") => event?.({ jobId: accepted.job_id, event: name, data, id: "7" }),
  }
}
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
const action = () => document.querySelector<HTMLButtonElement>("[data-cloud-error-action]")
const text = () => document.querySelector(".alpha-ext-card-err")?.textContent

// `#1572` AC5:旧式云卡片(extension-detail 仍在用)与 cloud-form-box 同一分层文案 —— main 认出层就说那一层,
// 认不出的 network 逐字仍是原来那句。期望值是独立字面量(界面拿不到云服务主机名,代入「对方服务器」)。
describe("`#1572` dispatch network failure says which step failed", () => {
  test("network + netLayer:dns ⇒ 「解析不了」那一句;没有层 ⇒ 原文案逐字不变", async () => {
    await mount("network", undefined, "dns")
    expect(text()).toBe("解析不了 对方服务器,检查网络或代理软件后重试")
    disposers.splice(0).forEach((dispose) => dispose())
    document.body.replaceChildren()
    await mount("network")
    expect(text()).toBe("暂时连不上云端服务,稍后重试")
  })
})

describe("REQ-232 AC5 cloud refusal reasons and actions", () => {
  test.each(["live", "replay"])(
    "%s event record reads nested allowance code and opens balance payment",
    async () => {
      const harness = await mount()
      harness.send(live("account_allowance_exhausted"))
      await flush()
      expect(text()).toBe(allowance)
      expect(harness.statusCalls).toEqual([])
      expect(action()?.textContent).toBe("打开余额支付")
      action()!.click()
      await flush()
      expect(harness.actions).toEqual(["overflow"])
    },
  )
  test("synthesized terminal reads result.failure_code and opens recharge", async () => {
    const harness = await mount()
    harness.send({ ...status, result: { failure_code: "account_wallet_insufficient" } })
    await flush()
    expect(text()).toBe(wallet)
    expect(harness.statusCalls).toEqual([])
    expect(action()?.textContent).toBe("去充值")
    action()!.click()
    await flush()
    expect(harness.actions).toEqual(["recharge"])
  })
  test("a terminal without a code explicitly queries status for the reason", async () => {
    const harness = await mount(undefined, "account_wallet_insufficient")
    harness.send(live())
    await flush()
    expect(harness.statusCalls).toEqual([accepted.job_id])
    expect(text()).toBe(wallet)
  })
  test.each([
    ["account_wallet_insufficient", wallet, "recharge"],
    ["account_allowance_exhausted", allowance, "overflow"],
    ["not-authenticated", zh["alpha.ext.cloudErrAuth"], "login"],
    ["unauthorized", zh["alpha.ext.cloudErrAuth"], "login"],
  ])("dispatch refusal %s shows its reason and working action", async (code, message, target) => {
    const harness = await mount(code)
    expect(text()).toBe(message)
    expect(action()).not.toBeNull()
    action()!.click()
    await flush()
    expect(harness.actions).toEqual([target])
  })
  test("a suspended account gives contact copy without a payment action", async () => {
    await mount("account_suspended")
    expect(text()).toBe("账户已被停用,请联系我们。")
    expect(action()).toBeNull()
  })
  test("unknown and absent terminal codes keep the existing failure fallback", async () => {
    const harness = await mount()
    harness.send(live("provider_failed"))
    await flush()
    expect(text()).toBe(zh["alpha.ext.cloudRunFailed"])
    expect(action()).toBeNull()
    harness.send(live())
    await flush()
    expect(text()).toBe(zh["alpha.ext.cloudRunFailed"])
    expect(harness.statusCalls).toEqual([accepted.job_id])
  })
})

// REQ-235 AC2(基线 §2.4 / §7 R1-7):legacy 四个 kind 分支的**行为冻结**。
// 写在把任务生命周期提到 cloud-job-lifecycle.ts **之前**,提取后必须原样通过 —— 兼容性证明
// 不靠「文件零 diff」,靠这些断言:逐字信封、按钮门控、落盘调用、结果/产物呈现。
// Spec 取自随包目录(真实条目),office-report 无随包条目 → 照 #1509 用例同法以 docs 条目改 kind。
const legacySpecOf = (id: string) => {
  const entry = bundledCatalog.entries.find((candidate) => candidate.id === id)!
  return entry.installSpec as CloudPipelineSpec
}
const legacyDiff = (await Bun.file(join(producer, "cloud-job-request.json")).json()).value.input.diff as string

function mountLegacy(options: {
  spec: CloudPipelineSpec
  entryId?: string
  ready?: boolean
  recovering?: boolean
  picked?: string[]
  result?: unknown
  savedFiles?: string[]
  saveFailures?: unknown[]
  gitDiff?: { ok: true; diff: string; source: "worktree" | "last-commit" } | { ok: false; reason: string }
  upload?: unknown
  confirm?: unknown
}) {
  const envelopes: CloudJobEnvelope[] = []
  const saves: unknown[][] = []
  const statusCalls: string[] = []
  const pickerCalls: unknown[] = []
  const uploads: unknown[] = []
  let event: ((payload: { jobId: string } & CloudJobEvent) => void) | undefined
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      openDirectoryPicker: async (input: unknown) => {
        pickerCalls.push(input)
        return options.picked ?? ["/synthetic/results"]
      },
      openPath: async () => {},
      auth: { start: async () => {} },
      cloud: {
        dispatch: async (envelope: CloudJobEnvelope) => {
          envelopes.push(envelope)
          return accepted
        },
        gitDiff: async () => options.gitDiff ?? { ok: true, diff: legacyDiff, source: "worktree" },
        upload: async (input: unknown) => {
          uploads.push(input)
          return options.upload
        },
        confirmUpload: async () => options.confirm,
        cancelUpload: async () => ({ status: "cancelled" }),
        status: async (id: string) => {
          statusCalls.push(id)
          return { ...status, status: "completed", result: options.result ?? {} }
        },
        saveRun: async (...args: unknown[]) => {
          saves.push(args)
          return { ok: true, dir: "/synthetic/results/run", files: options.savedFiles ?? [], warnings: [], failures: options.saveFailures ?? [] }
        },
        subscribe: async () => ({ ok: true }),
        unsubscribe: async () => ({ ok: true }),
        onEvent: (handler: typeof event) => {
          event = handler
          return () => {}
        },
        openBillingPage: async () => {},
      },
    },
  })
  const host = document.createElement("div")
  document.body.append(host)
  disposers.push(
    runtime.render(
      () =>
        runtime.createComponent(runtime.CloudDispatchBox, {
          ...(options.entryId ? { entryId: options.entryId } : {}),
          spec: options.spec,
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
    pickerCalls,
    uploads,
    send: (name: string, jobId = accepted.job_id) => event?.({ jobId, event: name, data: {}, id: "9" }),
  }
}
const inputButton = () => document.querySelector<HTMLButtonElement>("[data-cloud-input]")
const typeInto = (value: string) => {
  const input = document.querySelector<HTMLTextAreaElement>("textarea")!
  input.value = value
  input.dispatchEvent(new Event("input", { bubbles: true }))
}
const buttonByText = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === label)

describe("REQ-235 AC2 legacy cloud branches are frozen before the lifecycle extraction", () => {
  test.each([
    ["research", "cloud:research", "research", { question: "Synthetic input" }, { finalAnswer: "Research answer" }, "Research answer"],
    ["docs", "cloud:docs", "docs", { code: "Synthetic input" }, { docs: "# Docs answer" }, "# Docs answer"],
    ["word", "cloud:word", "office-report", { topic: "Synthetic input", format: "docx" }, {}, ""],
    ["excel", "cloud:excel", "office-report", { topic: "Synthetic input", format: "xlsx" }, {}, ""],
    ["powerpoint", "cloud:powerpoint", "office-report", { topic: "Synthetic input", format: "pptx" }, {}, ""],
  ] as const)("%s: exact envelope, input gating, one save, result and artifacts", async (_name, entryId, kind, input, result, text) => {
    const spec = { ...legacySpecOf(kind === "office-report" ? "cloud:docs" : entryId), pipelineKind: kind } as CloudPipelineSpec
    const harness = mountLegacy({ spec, entryId, result, savedFiles: ["artifacts/output.bin", "contract.json"] })
    expect(inputButton()!.disabled).toBe(true)
    typeInto("   ")
    expect(inputButton()!.disabled).toBe(true)
    typeInto("  Synthetic input  ")
    expect(inputButton()!.disabled).toBe(false)
    inputButton()!.click()
    await flush()
    await flush()
    expect(harness.pickerCalls).toEqual([{ title: zh["alpha.ext.cloudPickResults"] }])
    expect(harness.envelopes).toEqual([
      { autonomy: "pipeline", kind, input, budget: spec.budgetDefaults, constraints: { network: "restricted" } },
    ])
    expect(inputButton()!.disabled).toBe(true)
    harness.send("job.completed")
    await flush()
    await flush()
    expect(harness.statusCalls).toEqual([accepted.job_id])
    expect(harness.saves).toEqual([["/synthetic/results", accepted.job_id, harness.envelopes[0]]])
    expect(document.querySelector("[data-cloud-result]")?.textContent ?? "").toBe(text)
    expect(Array.from(document.querySelectorAll("[data-cloud-file]")).map((node) => node.textContent)).toEqual(["artifacts/output.bin"])
    expect(document.body.textContent).toContain(zh["alpha.ext.cloudDone"])
  })

  test("office-report without one of the three Office identities stays disabled", async () => {
    const spec = { ...legacySpecOf("cloud:docs"), pipelineKind: "office-report" } as CloudPipelineSpec
    const harness = mountLegacy({ spec, entryId: "cloud:office-unknown" })
    typeInto("Quarterly report")
    expect(inputButton()!.disabled).toBe(true)
    inputButton()!.click()
    await flush()
    expect(harness.envelopes).toEqual([])
  })

  test("a cancelled results-folder pick sends nothing and returns to idle", async () => {
    const harness = mountLegacy({ spec: legacySpecOf("cloud:research"), entryId: "cloud:research", picked: [] })
    typeInto("Synthetic input")
    inputButton()!.click()
    await flush()
    expect(harness.envelopes).toEqual([])
    expect(inputButton()!.disabled).toBe(false)
    expect(inputButton()!.textContent).toBe(zh["alpha.ext.cloudStart"])
  })

  test("a failed terminal still saves the run and points at the saved folder", async () => {
    const harness = mountLegacy({ spec: legacySpecOf("cloud:research"), entryId: "cloud:research" })
    typeInto("Synthetic input")
    inputButton()!.click()
    await flush()
    await flush()
    harness.send("job.failed")
    await flush()
    await flush()
    expect(harness.saves).toEqual([["/synthetic/results", accepted.job_id, harness.envelopes[0]]])
    expect(document.body.textContent).toContain(zh["alpha.ext.cloudSaved"])
    expect(document.querySelector(".alpha-ext-card-err")?.textContent).toBe(zh["alpha.ext.cloudRunFailed"])
  })

  // REQ-236 #1551 AC2:saveCloudRun 的第三个生产消费者(定制中心表单经 cloud-save-run)—— 产物没齐不报「完成」。
  test("#1551 a completed job whose artifacts did not all land is not reported as done", async () => {
    const harness = mountLegacy({
      spec: legacySpecOf("cloud:research"),
      entryId: "cloud:research",
      savedFiles: [],
      saveFailures: [{ scope: "download", artifactId: "art_1", code: "network" }],
    })
    typeInto("Synthetic input")
    inputButton()!.click()
    await flush()
    await flush()
    harness.send("job.completed")
    await flush()
    await flush()
    expect(harness.saves).toHaveLength(1)
    expect(document.body.textContent).not.toContain(zh["alpha.ext.cloudDone"])
    expect(document.querySelector(".alpha-ext-card-err")?.textContent).toBe(zh["alpha.ext.cloudSaveFailed"])
  })

  test("events for another job id are ignored", async () => {
    const harness = mountLegacy({ spec: legacySpecOf("cloud:research"), entryId: "cloud:research" })
    typeInto("Synthetic input")
    inputButton()!.click()
    await flush()
    await flush()
    harness.send("job.completed", "job_someone_else")
    await flush()
    expect(harness.saves).toEqual([])
    expect(document.body.textContent).toContain(zh["alpha.ext.cloudRunning"])
  })

  test("code-review legacy diff: exact envelope, no result read, no artifact list", async () => {
    const spec = legacySpecOf("cloud:code-review")
    const harness = mountLegacy({ spec, entryId: "cloud:code-review", savedFiles: ["artifacts/review.md"] })
    expect(document.querySelector("textarea")).toBeNull()
    buttonByText(zh["alpha.cloud.consent.legacyDiff"])!.click()
    await flush()
    await flush()
    expect(harness.envelopes).toEqual([
      {
        autonomy: "pipeline",
        kind: "code-review",
        input: { diff: legacyDiff },
        budget: spec.budgetDefaults,
        constraints: { network: "restricted" },
      },
    ])
    expect(document.body.textContent).toContain(zh["alpha.ext.cloudDiffWorktree"])
    harness.send("job.completed")
    await flush()
    await flush()
    expect(harness.statusCalls).toEqual([])
    expect(harness.saves).toEqual([["/synthetic/results", accepted.job_id, harness.envelopes[0]]])
    expect(document.querySelectorAll("[data-cloud-file]").length).toBe(0)
    expect(document.querySelector("[data-cloud-result]")).toBeNull()
    expect(document.body.textContent).toContain(zh["alpha.ext.cloudDone"])
  })

  test("code-review legacy diff with no changes sends nothing", async () => {
    const harness = mountLegacy({
      spec: legacySpecOf("cloud:code-review"),
      entryId: "cloud:code-review",
      gitDiff: { ok: false, reason: "no-diff" },
    })
    buttonByText(zh["alpha.cloud.consent.legacyDiff"])!.click()
    await flush()
    await flush()
    expect(harness.envelopes).toEqual([])
    expect(document.querySelector(".alpha-ext-card-err")?.textContent).toBe(zh["alpha.ext.cloudNoDiff"])
  })

  test("code-review upload: confirmed send closes the dialog and saves under the upload contract", async () => {
    const harness = mountLegacy({
      spec: legacySpecOf("cloud:code-review"),
      entryId: "cloud:code-review",
      upload: {
        status: "consent-required",
        requestId: "request-legacy",
        preview: {
          pipeline: "code-review",
          fileCount: 1,
          totalBytes: 10,
          files: [{ path: "src/a.ts", sizeBytes: 10, sensitive: true }],
          findings: [{ kind: "contact", fileCount: 1 }],
          purpose: "artifact.upload",
          retentionClass: "standard",
        },
      },
      confirm: { status: "sent", privacy: "sensitive", directory: "/project", job: accepted },
    })
    buttonByText(zh["alpha.cloud.consent.uploadPick"])!.click()
    await flush()
    expect(harness.uploads).toEqual([{ kind: "code-review" }])
    expect(document.querySelector("[role=dialog]")).not.toBeNull()
    const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>("[role=dialog] button")).at(-1)!
    confirm.click()
    await flush()
    await flush()
    expect(document.querySelector("[role=dialog]")).toBeNull()
    expect(document.body.textContent).toContain(zh["alpha.ext.cloudRunning"])
    expect(document.body.textContent).not.toContain(zh["alpha.cloud.consent.silentPass"])
    harness.send("job.completed")
    await flush()
    await flush()
    expect(harness.saves).toEqual([["/project", accepted.job_id, { autonomy: "pipeline", kind: "code-review", input: {} }]])
    expect(harness.envelopes).toEqual([])
  })

  test.each([
    [false, "alpha.ext.cloudNeedPlatformNote"],
    [true, "alpha.ext.cloudRecoveringNote"],
  ] as const)("not ready (recovering=%s) disables every dispatch control and says why", (recovering, note) => {
    mountLegacy({ spec: legacySpecOf("cloud:code-review"), entryId: "cloud:code-review", ready: false, recovering })
    expect(buttonByText(zh["alpha.cloud.consent.uploadPick"])!.disabled).toBe(true)
    expect(buttonByText(zh["alpha.cloud.consent.legacyDiff"])!.disabled).toBe(true)
    expect(document.body.textContent).toContain(zh[note])
    document.body.replaceChildren()
    mountLegacy({ spec: legacySpecOf("cloud:research"), entryId: "cloud:research", ready: false, recovering })
    typeInto("Synthetic input")
    expect(inputButton()!.disabled).toBe(true)
  })
})
