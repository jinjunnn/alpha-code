// [#969] 云档定时任务被拒绝时,**用户读到的那一行**。
//
// 保证(删掉本文件会失去什么):面板那一行可以整段回退成 `setFErr(r.reason)` —— 用户重新读到
// 「云端注册失败:schedule_limit_reached」这种给开发者看的标识符 —— 而全仓不会有任何东西变红。
// `#955` 只修 main 侧、票被关掉而症状仍在,就是这个形状。
//
// 判据挂在**生产 AutomationPanel** 上(harness 见同目录的 -test-runtime.tsx),动作是真实 DOM
// 点击,断言是 `.alpha-auto-err` 的 textContent。刻意不断言信号值、更不断言源码文本。
//
// 每格自带前提自检:点保存**之前**先确认表单真在云端档、错误行不在场;点完确认 save 真被调用
// 过一次且入参 `execution === "cloud"`。少了这一步,「保存按钮 disabled / 表单校验先行早返」
// 会让后面的断言**空绿**(名字/提示词/目录任一为空都会早返)。
//
// 边界(诚实声明):main → IPC 那一跳不在本文件里 —— renderer 结构上加载不到 main 模块,
// 这里的 `window.api.automations.save` 是 preload 边界上的桩。那一跳由 src/main 下走真实
// `ipcMain.handle` 的用例守着(automation-ipc-delete.cases.ts 的 [#969] 两条)。

import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import appPlugin from "@opencode-ai/app/vite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import type * as Runtime from "./automation-refusal-test-runtime"
import { dict as en } from "../i18n/en"
import { dict as zh } from "../i18n/zh"

const runtimeDirectory = mkdtempSync(join(tmpdir(), "alpha-969-refusal-"))
await build({
  configFile: false,
  logLevel: "silent",
  plugins: [appPlugin.at(-1)!],
  resolve: { dedupe: ["solid-js", "solid-js/web", "@solidjs/router"] },
  build: {
    emptyOutDir: true,
    outDir: runtimeDirectory,
    lib: {
      entry: join(import.meta.dir, "automation-refusal-test-runtime.tsx"),
      formats: ["es"],
      fileName: () => "automation-refusal-test-runtime.js",
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
})

GlobalRegistrator.register()
const runtime = (await import(
  pathToFileURL(join(runtimeDirectory, "automation-refusal-test-runtime.js")).href
)) as typeof Runtime

const disposers: Array<() => void> = []

// ── 独立字面量锚点 ────────────────────────────────────────────────────────────
// 这三张表是**手写**的,刻意不从 schedule-refusal-copy.ts import、也不从它派生:期望值取自被测
// 对象自己 = 自指等价链,一起改错就一起自洽(`ap#188` / `ap#197` 实测两次)。
// 平台侧的登记在 alpha-platform `packages/gateway/src/lib/schedules.ts` 的 SCHEDULE_REFUSAL_CODES
// 与 `docs/contracts/cloud-jobs-v1.md`;桌面自铸的 kebab 码在 alpha-cloud-schedules.ts。

/** 桌面**到得了**、因而必须给人话的码。 */
const MAPPED_CODES = [
  "schedule_limit_reached",
  "schedule_name_invalid",
  "schedule_cron_invalid",
  "schedule_interval_too_tight",
  "control_envelope_too_large",
  "rate_limited",
  "account_admission_rate_exceeded",
  "not-authenticated",
  "unauthorized",
  "no-cloud-endpoint",
  "network",
  "cloud-schedule-form-unsupported",
] as const

/**
 * 平台真实登记、但桌面注册信封**结构上发不出**的码 —— 刻意不映射(给它们写文案 = 写永不
 * 执行的死分支)。它们必须走回落、原样带着码上屏。
 */
const DELIBERATELY_UNMAPPED_CODES = [
  "schedule_autonomy_unsupported",
  "schedule_upload_unsupported",
  "schedule_budget_cap_exceeded",
  "denied_paths_unenforceable_for_execution_form",
] as const

/** 这些 i18n 键的文案质量由本文件守;与上表的映射码一一对应(顺序无关)。 */
const COPY_KEYS = [
  "alpha.auto.cloudErrLimitReached",
  "alpha.auto.cloudErrNameInvalid",
  "alpha.auto.cloudErrCronInvalid",
  "alpha.auto.cloudErrIntervalTooTight",
  "alpha.auto.cloudErrEnvelopeTooLarge",
  "alpha.auto.cloudErrRateLimited",
  "alpha.auto.cloudErrTenantRateLimited",
  "alpha.auto.cloudErrFormUnsupported",
  "alpha.ext.cloudErrAuth",
  "alpha.ext.cloudErrEndpoint",
  "alpha.ext.cloudErrNetwork",
] as const

beforeEach(() => {
  document.body.replaceChildren()
  runtime.installRootHost()
  runtime.installPreloadStub()
  runtime.resetHarness()
})

afterEach(() => disposers.splice(0).reverse().forEach((dispose) => dispose()))

afterAll(async () => {
  await GlobalRegistrator.unregister()
  rmSync(runtimeDirectory, { recursive: true, force: true })
})

async function flush() {
  for (let i = 0; i < 6; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function query<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector)
  if (!el) throw new Error(`未找到元素:${selector}`)
  return el
}

function click(el: Element) {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
}

/** 按可见文字找按钮(执行档的两个 seg 按钮没有别的标识)。 */
function buttonByText(text: string): HTMLButtonElement {
  for (const el of document.querySelectorAll<HTMLButtonElement>(".alpha-auto-seg button")) {
    if ((el.textContent ?? "").trim() === text) return el
  }
  throw new Error(`未找到按钮:${text}`)
}

const errorLine = () => document.querySelector(".alpha-auto-err")?.textContent ?? null

/**
 * 走一遍真实用户路径:开面板 → 一句话新建 → 切到云端档 → 点保存。
 * 中间三条前提自检,任何一条不成立就抛(不让后面的断言空绿)。
 */
async function saveAsCloudTask(): Promise<void> {
  const host = query<HTMLElement>("#root")
  disposers.push(runtime.render(() => runtime.AutomationRefusalHarness(), host))
  runtime.openPanel()
  await flush()

  const nl = query<HTMLInputElement>(".alpha-auto-nl")
  nl.value = "每天 9 点检查本项目未处理的 TODO 并生成清单"
  nl.dispatchEvent(new Event("input", { bubbles: true }))
  click(query(".alpha-auto-new .alpha-ext-add[data-variant='primary']"))
  await flush()

  click(buttonByText(zh["alpha.auto.execCloud"]))
  await flush()

  // 前提自检 ①:表单真在云端档(data-on 落在「云端」那个按钮上)。
  expect(buttonByText(zh["alpha.auto.execCloud"]).getAttribute("data-on"), "执行档没切到云端").toBe("")
  // 前提自检 ②:点保存之前错误行不在场(否则「错误行不含裸码」可能测的是上一格的残留)。
  expect(errorLine(), "点保存之前错误行就已经在了").toBeNull()

  click(query(".alpha-auto-actions .alpha-ext-add[data-variant='primary']"))
  await flush()

  // 前提自检 ③:保存真的被调用过一次,且入参确实是云档(表单早返会让它一次都不调)。
  const calls = runtime.saveCalls()
  expect(calls.length, "automations.save 没有被调用(表单在保存前就早返了)").toBe(1)
  expect(calls[0]!.execution).toBe("cloud")
}

describe("[#969] 云档拒绝到达用户的那一跳", () => {
  test("前提自检:走通用户路径后,一个**成功**的保存不会留下任何错误行", async () => {
    runtime.queueSaveResult({ ok: true })
    await saveAsCloudTask()
    expect(errorLine()).toBeNull()
  })

  test("两个不同的可达码,各自渲染出各自的人话(不是同一句万能抱歉,也不是裸码)", async () => {
    runtime.queueSaveResult({ ok: false, reason: "云端注册失败:schedule_limit_reached", code: "schedule_limit_reached" })
    await saveAsCloudTask()
    const first = errorLine()

    document.body.replaceChildren()
    disposers.splice(0).reverse().forEach((dispose) => dispose())
    runtime.installRootHost()
    runtime.resetHarness()
    runtime.queueSaveResult({ ok: false, reason: "云端注册失败:schedule_cron_invalid", code: "schedule_cron_invalid" })
    await saveAsCloudTask()
    const second = errorLine()

    expect(first).toBe(zh["alpha.auto.cloudErrLimitReached"])
    expect(second).toBe(zh["alpha.auto.cloudErrCronInvalid"])
    // 两段必须不等 —— 只断一个码杀不掉「所有码返回同一句」的实现。
    expect(first).not.toBe(second)
    for (const text of [first, second]) {
      expect(text).not.toContain("schedule_")
      expect(text).not.toContain("云端注册失败")
    }
  })

  test("刻意未映射的真码,原样出现在错误行上(不假装认识,也不是空行)", async () => {
    const code = "schedule_autonomy_unsupported"
    runtime.queueSaveResult({ ok: false, reason: `云端注册失败:${code}`, code })
    await saveAsCloudTask()

    const text = errorLine() ?? ""
    expect(text).toContain(code)
    // 走的是回落模板,不是任何一条人话文案。
    expect(text).toBe(zh["alpha.auto.cloudErrUnknown"].replace("{{code}}", code))
    for (const key of COPY_KEYS) expect(text).not.toBe(zh[key])
  })

  test("传输腿的伪码(未登录)也换成人话,不是一个英文 token", async () => {
    runtime.queueSaveResult({ ok: false, reason: "云端注册失败:not-authenticated", code: "not-authenticated" })
    await saveAsCloudTask()

    expect(errorLine()).toBe(zh["alpha.ext.cloudErrAuth"])
    expect(errorLine()).not.toContain("not-authenticated")
  })

  // 码取删除腿**真到得了**的那一个:DELETE /v1/cloud/schedules/:id 走的是
  // `schedAuth(c, "cloud.dispatch")`(rateLimit 默认 false)⇒ 两个 429 桶在这条腿上结构上发不出,
  // 拿 `rate_limited` 当夹具就是锚在到不了的形状上。`network` 由桌面自己的 authed() 铸,
  // 任何一条腿都到得了,且是有映射文案的码(不落回落模板 ⇒ 这条仍然断的是「给人话」)。
  test("云档改本地时云端删除被拒 ⇒ 同一行也给人话(main 走的是另一条腿,呈现必须一致)", async () => {
    runtime.queueSaveResult({ ok: false, reason: "云端删除失败:network", code: "network" })
    await saveAsCloudTask()

    expect(errorLine()).toBe(zh["alpha.ext.cloudErrNetwork"])
    expect(errorLine()).not.toContain("云端删除失败")
  })

  test("没有 code 的失败(本地落盘一类)仍然原样显示 main 给的 reason", async () => {
    runtime.queueSaveResult({ ok: false, reason: "invalid name" })
    await saveAsCloudTask()

    expect(errorLine()).toBe("invalid name")
  })
})

describe("[#969] 映射表的边界与文案质量", () => {
  test("该给人话的码逐个都不落到回落模板上", () => {
    const fallbackOf = (code: string) => zh["alpha.auto.cloudErrUnknown"].replace("{{code}}", code)
    for (const code of MAPPED_CODES) {
      const copy = runtime.scheduleRefusalCopy(code)
      expect(copy, `${code} 没有人话文案`).not.toBe(fallbackOf(code))
      expect(copy, `${code} 的文案里出现了码本身`).not.toContain(code)
    }
    // 杀「复制粘贴同一句给多个码」:12 个映射码只允许收敛出 11 段文案 —— 唯一合并的是
    // not-authenticated / unauthorized 这对(同一件事,与 dispatch 面共用一句)。
    expect(new Set(MAPPED_CODES.map((c) => runtime.scheduleRefusalCopy(c))).size).toBe(COPY_KEYS.length)
  })

  test("结构上发不出的四个码逐个走回落、原样带码(顺手映射上去就红)", () => {
    for (const code of DELIBERATELY_UNMAPPED_CODES) {
      const copy = runtime.scheduleRefusalCopy(code)
      expect(copy, `${code} 被映射了 —— 桌面信封结构上发不出它,那是死分支`).toBe(
        zh["alpha.auto.cloudErrUnknown"].replace("{{code}}", code),
      )
      expect(copy).toContain(code)
    }
  })

  test("en 与 zh 的每条文案都真的解析出人话,且组内两两互异", () => {
    for (const [locale, dict] of [
      ["en", en],
      ["zh", zh],
    ] as const) {
      runtime.setLocale(locale)
      const seen = new Set<string>()
      for (const key of COPY_KEYS) {
        const copy = runtime.t(key)
        // t() 对缺失的键把 key 原样吐回 —— 那正是本票要消灭的「用户读到开发者标识符」。
        expect(copy, `${locale}/${key} 没有文案`).not.toBe(key)
        expect(copy, `${locale}/${key} 与字典不一致`).toBe(dict[key])
        // 只是个粗下界(真正钉死内容的是上面那条与字典逐字相等);zh 的「网络错误」本来就短。
        expect(copy.length, `${locale}/${key} 的文案太短,说不清发生了什么`).toBeGreaterThan(10)
        for (const code of [...MAPPED_CODES, ...DELIBERATELY_UNMAPPED_CODES]) {
          expect(copy, `${locale}/${key} 的文案里混进了分类码`).not.toContain(code)
        }
        seen.add(copy)
      }
      expect(seen.size, `${locale} 有重复文案`).toBe(COPY_KEYS.length)
    }
    runtime.setLocale("zh")
  })
})
