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
import type { CloudJobEvent } from "../../preload/types"
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

async function mount(error?: string, failureCode?: string) {
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
        dispatch: async () => (error ? { error } : accepted),
        status: async (id: string) => {
          statusCalls.push(id)
          return { ...status, result: failureCode ? { failure_code: failureCode } : {} }
        },
        saveRun: async () => ({ ok: true, dir: "/synthetic/results/run", files: [], warnings: [] }),
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
