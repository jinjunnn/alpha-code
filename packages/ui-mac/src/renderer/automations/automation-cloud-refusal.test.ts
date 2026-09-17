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

    // 先拆再清:harness 里的 toast 视口是挂在 body 上的 Portal,先清 body 会让它的拆除找不到节点。
    disposers.splice(0).reverse().forEach((dispose) => dispose())
    document.body.replaceChildren()
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

// ── [#778] 云端停用理由:列表行上那一句 ─────────────────────────────────────────────
//
// 理由值以 alpha-platform 主干 `packages/gateway/src/routes/cloud-schedules.ts` 的**写入点**为准
// (手写字面量,不从被测模块取):授权校验失败处写 execution_grant_missing / execution_grant_expired,
// 连续 overlap 熔断处写 stuck_job,连败熔断处写 consecutive_failures。四个值,平台今天只写这四个。
// 值 → 期望文案键的对应也是手写的独立锚点。

const DISABLED_REASON_COPY_KEYS = {
  consecutive_failures: "alpha.auto.cloudDisabledFailures",
  stuck_job: "alpha.auto.cloudDisabledStuck",
  execution_grant_missing: "alpha.auto.cloudDisabledGrantMissing",
  execution_grant_expired: "alpha.auto.cloudDisabledGrantExpired",
} as const

/** 平台今天不写、但设计稿里提过的一个值 —— 拿它当「面板不认识的理由」最贴近真实。 */
const UNKNOWN_DISABLED_REASON = "quota"

function cloudTask(id: string, cloudScheduleId: string): Runtime.ListedTask {
  return {
    id,
    name: `云端任务 ${id}`,
    nlText: "",
    schedule: { kind: "cron", expr: "0 9 * * *" },
    target: { projectDir: runtime.DEFAULT_DIR, agent: "alpha-automation" },
    prompt: "检查 TODO",
    execution: "cloud",
    cloudScheduleId,
    permissionProfile: "readonly",
    budget: { maxDurationMin: 15 },
    overlapPolicy: "skip",
    catchUpPolicy: "skip",
    notify: { system: true },
    enabled: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    nextFireAt: null,
    running: false,
  }
}

/** 渲染列表,返回那一行的状态文字。前提自检:行在场、云端回读真被调用过。 */
async function rowStatusFor(disabledReason: string): Promise<string> {
  disposers.splice(0).reverse().forEach((dispose) => dispose())
  document.body.replaceChildren()
  runtime.installRootHost()
  runtime.resetHarness()
  runtime.queueListedTasks([cloudTask("auto-778", "sched_778")])
  runtime.queueCloudSchedules([{ id: "sched_778", enabled: false, disabled_reason: disabledReason }])
  disposers.push(runtime.render(() => runtime.AutomationRefusalHarness(), query<HTMLElement>("#root")))
  runtime.openPanel()
  await flush()

  expect(document.querySelectorAll(".alpha-auto-row").length, "列表行没渲染出来").toBe(1)
  expect(runtime.cloudSyncCalls(), "云端回读一次都没被调用 —— 后面的断言会空绿").toBeGreaterThan(0)
  return query(".alpha-auto-row-st").textContent ?? ""
}

describe("[#778] 云端停用理由逐个说清「发生了什么、该做什么」", () => {
  test("四个已知理由各自渲染出自己那一句,两两不同,都不是兜底", async () => {
    const seen = new Map<string, string>()
    for (const [reason, key] of Object.entries(DISABLED_REASON_COPY_KEYS)) {
      const text = await rowStatusFor(reason)
      expect(zh[key], `zh 缺 ${key}`).toBeTruthy()
      expect(text, `${reason} 没有渲染成它自己那一句`).toContain(zh[key])
      expect(text, `${reason} 落进了兜底`).not.toContain(zh["alpha.auto.cloudDisabledUnknown"].split("{{")[0]!)
      // 理由的原始标识符不上屏(用户读到的是人话,不是 execution_grant_expired)。
      expect(text).not.toContain(reason)
      seen.set(reason, zh[key])
    }
    expect(new Set(seen.values()).size, "有两个理由共用了同一句").toBe(4)
  })

  test("不认识的理由走明确的兜底,带出原始理由,且不与任何已知理由的文案混淆", async () => {
    const text = await rowStatusFor(UNKNOWN_DISABLED_REASON)
    expect(text).toContain(zh["alpha.auto.cloudDisabledUnknown"].replace("{{reason}}", UNKNOWN_DISABLED_REASON))
    for (const key of Object.values(DISABLED_REASON_COPY_KEYS)) expect(text).not.toContain(zh[key])
  })

  test("文案质量:en/zh 都有、互不相同、没有开发标识符;两种授权失效都提示关掉再打开开关", () => {
    const keys = [...Object.values(DISABLED_REASON_COPY_KEYS), "alpha.auto.cloudDisabledUnknown"] as const
    for (const [locale, dict, reenable] of [
      ["en", en, "off and on again"],
      ["zh", zh, "关掉再打开开关"],
    ] as const) {
      runtime.setLocale(locale)
      const seen = new Set<string>()
      for (const key of keys) {
        const copy = runtime.t(key)
        expect(copy, `${locale}/${key} 没有文案`).not.toBe(key)
        expect(copy, `${locale}/${key} 与字典不一致`).toBe(dict[key])
        for (const reason of Object.keys(DISABLED_REASON_COPY_KEYS)) expect(copy).not.toContain(reason)
        expect(copy, `${locale}/${key} 里混进了开发术语`).not.toMatch(/grant|stuck job|REQ-|#\d/i)
        seen.add(copy)
      }
      expect(seen.size, `${locale} 有重复文案`).toBe(keys.length)
      expect(runtime.t("alpha.auto.cloudDisabledGrantMissing")).toContain(reenable)
      expect(runtime.t("alpha.auto.cloudDisabledGrantExpired")).toContain(reenable)
    }
    runtime.setLocale("zh")
  })
})

// ── [#994] 删除 / 开关在云端失败时不再静默 ────────────────────────────────────────────
//
// 码取各自那条腿**真到得了**的:删除腿 `network`(桌面 authed() 铸,任何腿都到得了);开关腿
// `not-authenticated`(同上)。两者都有映射文案 ⇒ 断的是「给人话」,不是回落模板。

/** 渲染列表(一条云档任务),清掉之前测试残留的 toast,并自检前提。 */
async function renderListWith(task: Runtime.ListedTask): Promise<void> {
  runtime.queueListedTasks([task])
  disposers.push(runtime.render(() => runtime.AutomationRefusalHarness(), query<HTMLElement>("#root")))
  runtime.openPanel()
  await flush()
  // toast 是模块级单例,上一格弹出的会被这一格的视口重新渲染出来 —— 先逐个关掉。
  for (const x of document.querySelectorAll(".a-toast-x")) click(x)
  await flush()
  expect(document.querySelectorAll(".a-toast").length, "动作之前就已经有 toast 了").toBe(0)
  expect(document.querySelectorAll(".alpha-auto-row").length, "列表行没渲染出来").toBe(1)
}

const errorToasts = () =>
  [...document.querySelectorAll(".a-toast[data-kind='error']")].map((el) => ({
    title: el.querySelector("b")?.textContent ?? "",
    detail: el.querySelector("small")?.textContent ?? "",
  }))

describe("[#994] 删除 / 开关在云端失败时给出说明", () => {
  test("删除被云端拒绝 ⇒ 弹出说明原因的错误提示,那条自动化仍在列表里", async () => {
    runtime.queueRemoveResult({ ok: false, reason: "云端删除失败:network", code: "network" })
    await renderListWith(cloudTask("auto-994-del", "sched_994_del"))

    click(query(".alpha-auto-row"))
    await flush()
    click(query(".alpha-auto-actions .alpha-ext-add[data-variant='danger']"))
    await flush()

    // 前提自检:删除真的发出去了(否则「没有 toast」与「有 toast」都可能是空测)。
    expect(runtime.removeCalls()).toEqual(["auto-994-del"])
    expect(errorToasts()).toEqual([{ title: zh["alpha.auto.removeFailed"], detail: zh["alpha.ext.cloudErrNetwork"] }])
    expect(document.body.textContent).not.toContain("云端删除失败")
    // 回到列表,那一条还在。
    expect(document.querySelectorAll(".alpha-auto-row").length).toBe(1)
    expect(query(".alpha-auto-row").textContent).toContain("云端任务 auto-994-del")
  })

  test("开关被云端拒绝 ⇒ 弹出说明原因的错误提示,开关保持原状态", async () => {
    runtime.queueToggleResult({ ok: false, reason: "云端状态更新失败:not-authenticated", code: "not-authenticated" })
    await renderListWith(cloudTask("auto-994-sw", "sched_994_sw"))
    expect(query(".alpha-auto-row .alpha-ext-sw").getAttribute("data-on"), "开关起始不是开").toBe("")

    click(query(".alpha-auto-row .alpha-ext-sw"))
    await flush()

    expect(runtime.toggleCalls()).toEqual([["auto-994-sw", false]])
    expect(errorToasts()).toEqual([{ title: zh["alpha.auto.toggleFailed"], detail: zh["alpha.ext.cloudErrAuth"] }])
    expect(document.body.textContent).not.toContain("not-authenticated")
    expect(query(".alpha-auto-row .alpha-ext-sw").getAttribute("data-on")).toBe("")
  })

  test("对照:删除与开关都成功时不弹错误提示(证明上面两格的 toast 不是恒在)", async () => {
    await renderListWith(cloudTask("auto-994-ok", "sched_994_ok"))
    click(query(".alpha-auto-row .alpha-ext-sw"))
    await flush()
    click(query(".alpha-auto-row"))
    await flush()
    click(query(".alpha-auto-actions .alpha-ext-add[data-variant='danger']"))
    await flush()

    expect(runtime.toggleCalls().length).toBe(1)
    expect(runtime.removeCalls().length).toBe(1)
    expect(errorToasts()).toEqual([])
  })

  test("开关失败提示的标题 en/zh 都有、不等于键名", () => {
    for (const [locale, dict] of [
      ["en", en],
      ["zh", zh],
    ] as const) {
      runtime.setLocale(locale)
      expect(runtime.t("alpha.auto.toggleFailed")).not.toBe("alpha.auto.toggleFailed")
      expect(runtime.t("alpha.auto.toggleFailed")).toBe(dict["alpha.auto.toggleFailed"])
    }
    runtime.setLocale("zh")
  })
})
