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
const i18n = await import("../src/renderer/i18n")
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

const DIR = "/tmp/workspace" // the shell harness identity's directory

type FakeOptions = {
  verify?: (run: string, artifactId: string) => Promise<unknown>
  /** #660 B1: manifest updatedAt per run (missing key = null → id-order fallback). */
  updatedAtByRun?: Record<string, string | null>
  /** #660: cloud.artifacts answer; default is an honest {error} envelope (offline). */
  cloudArtifacts?: (run: string) => unknown
  /** #660: cloud.downloadArtifact answer; default fails with a network error. */
  download?: (run: string, artifact: { id?: string }) => Promise<unknown>
}

function installFakeRunArtifacts(entriesByRun: Record<string, unknown[]>, options?: FakeOptions) {
  const calls = {
    projectUsage: 0,
    list: [] as string[],
    verify: [] as string[],
    read: 0,
    cloudList: [] as string[],
    download: [] as string[],
    cancel: [] as string[],
  }
  const runSavedListeners = new Set<(e: { directory: string; runId: string }) => void>()
  const progressListeners = new Set<(p: unknown) => void>()
  const runUsage = (runId: string) => ({
    runId,
    artifactCount: 1,
    recordedBytes: 5,
    diskBytes: 5,
    legacyBytes: 0,
    missingCount: 0,
    readOnly: false,
    updatedAt: options?.updatedAtByRun?.[runId] ?? null,
  })
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
    cloud: {
      artifacts: async (run: string) => {
        calls.cloudList.push(run)
        return options?.cloudArtifacts ? options.cloudArtifacts(run) : { error: "no-cloud-endpoint" }
      },
      downloadArtifact: async (_dir: string, run: string, artifact: { id?: string }) => {
        calls.download.push(`${run}:${artifact?.id}`)
        if (options?.download) return options.download(run, artifact)
        return { ok: false, error: "network" }
      },
      cancelArtifactDownload: async (artifactId: string) => {
        calls.cancel.push(artifactId)
        return { ok: true }
      },
      onArtifactProgress: (cb: (p: unknown) => void) => {
        progressListeners.add(cb)
        return () => progressListeners.delete(cb)
      },
      onRunSaved: (cb: (e: { directory: string; runId: string }) => void) => {
        runSavedListeners.add(cb)
        return () => runSavedListeners.delete(cb)
      },
    },
  }
  return {
    calls,
    emitRunSaved: (e: { directory: string; runId: string }) => runSavedListeners.forEach((listener) => listener(e)),
    emitProgress: (p: unknown) => progressListeners.forEach((listener) => listener(p)),
  }
}

function unmountAll() {
  disposers
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose())
  document.body.replaceChildren()
}

async function openArtifactsTab(host: HTMLElement) {
  await flushTimers()
  host.querySelector<HTMLButtonElement>("[data-alpha-session-rail-tab='artifacts']")!.click()
  await flushTimers()
  await flushTimers()
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

describe("#660 retrieval and empty states (view harness)", () => {
  test("取回四态渲染诚实:下载 / 进度+取消 / 已取回(同一张卡,不可再点)/ 失败+重试", async () => {
    const harness = runtime.createArtifactsViewHarness()
    const cloudCard = runtime.fakeCard({
      key: "art-cloud",
      name: "数据附录.xlsx",
      state: "cloud-only",
      downloadable: true,
      downloadPayload: { id: "art-cloud", name: "数据附录.xlsx", size: 7 } as never,
    })
    harness.setCards([cloudCard, runtime.fakeCard({ key: "art-ok", name: "竞品扫描.docx" })])
    harness.setRuns([runtime.fakeRunRow({ runId: "job_r1", ordinal: "latest" })])
    harness.setSelectedRunId("job_r1")
    // 选中同一张云卡:详情区(尚未落盘 fallback)的下载入口也要逐态核对(审计 Major-3)。
    harness.setSelectedKey("art-cloud")
    const host = mount(harness.View)
    await flush()

    // ① 未取回:主按钮「下载」,无进度、无错误痕迹;详情区也有「下载」;已验证卡片无动作区。
    const actions = () => host.querySelector("[data-artifact-card='art-cloud']")!.closest(".alpha-wb-card")!
    const detailBtn = () => host.querySelector<HTMLButtonElement>(".alpha-wb-empty .a-wb-btn")
    expect(actions().querySelector(".alpha-wb-card-actions .a-wb-btn")!.textContent).toBe(i18n.t("alpha.wb.download"))
    expect(actions().querySelector(".alpha-wb-progress")).toBeNull()
    expect(detailBtn()).not.toBeNull()
    expect(host.querySelector("[data-artifact-card='art-ok']")!.closest(".alpha-wb-card")!.querySelector(".alpha-wb-card-actions")).toBeNull()

    actions().querySelector<HTMLButtonElement>(".alpha-wb-card-actions .a-wb-btn")!.click()
    expect(harness.calls.download).toEqual(["art-cloud"])

    // ② 取回中:百分比 + 取消,aria-live 播报,不打断;详情区下载入口消失。
    harness.setDownloadPhases({ "art-cloud": { status: "downloading", bytes: 43, total: 100, percent: 43 } })
    await flush()
    expect(actions().querySelector(".alpha-wb-progress")!.textContent).toBe("43%")
    const cancelBtn = actions().querySelector<HTMLButtonElement>(".alpha-wb-card-actions .a-wb-btn")!
    expect(cancelBtn.textContent).toBe(i18n.t("alpha.wb.cancel"))
    expect(host.querySelector(".alpha-wb-live")!.textContent).toContain("43%")
    expect(detailBtn()).toBeNull()
    cancelBtn.click()
    expect(harness.calls.cancelDownload).toEqual(["art-cloud"])

    // ③ 已取回(审计 Major-3:必须是**同一张卡**置 done,不许拿旁边的本地卡冒充):
    //    动作区只剩不可点的「已验证」chip,行上与详情区都没有任何再下载入口。
    harness.setDownloadPhases({ "art-cloud": { status: "done" } })
    await flush()
    const doneChip = actions().querySelector("[data-download-done]")
    expect(doneChip).not.toBeNull()
    expect(doneChip!.textContent).toBe(i18n.t("alpha.wb.state.verified"))
    expect(doneChip!.tagName).not.toBe("BUTTON")
    expect(actions().querySelector(".alpha-wb-card-actions .a-wb-btn")).toBeNull()
    expect(detailBtn()).toBeNull()
    const downloadsBefore = harness.calls.download.length

    // ④ 失败:行内红 chip + 「重试」+ 列表下方详情通知 —— 不弹框;详情区入口恢复。
    harness.setDownloadPhases({ "art-cloud": { status: "error", message: "network(offline)" } })
    await flush()
    expect(actions().querySelector("[data-download-error]")).not.toBeNull()
    expect(actions().querySelector(".alpha-wb-card-actions .a-wb-btn")!.textContent).toBe(i18n.t("alpha.wb.retry"))
    expect(host.querySelector("[data-download-failure]")!.textContent).toContain("network(offline)")
    expect(detailBtn()).not.toBeNull()
    expect(harness.calls.download.length).toBe(downloadsBefore) // done 期间没有任何再触发
  })

  test("取消不留错误痕迹:cancelled 回到「下载」,无错误 chip、无失败通知", async () => {
    const harness = runtime.createArtifactsViewHarness()
    harness.setCards([
      runtime.fakeCard({
        key: "art-cloud",
        name: "数据附录.xlsx",
        state: "cloud-only",
        downloadable: true,
        downloadPayload: { id: "art-cloud", name: "数据附录.xlsx", size: 7 } as never,
      }),
    ])
    harness.setDownloadPhases({ "art-cloud": { status: "cancelled" } })
    const host = mount(harness.View)
    await flush()
    expect(host.querySelector("[data-download-error]")).toBeNull()
    expect(host.querySelector("[data-download-failure]")).toBeNull()
    expect(host.querySelector(".alpha-wb-card-actions .a-wb-btn")!.textContent).toBe(i18n.t("alpha.wb.download"))
  })

  test("两种空态可分辨:零 run 不渲染云任务条;某次零产物条留着 + 专属文案;时刻缺失回落编号", async () => {
    const harness = runtime.createArtifactsViewHarness()
    harness.setPhase("empty")
    const host = mount(harness.View)
    await flush()
    expect(host.querySelector("[data-artifacts-runbar]")).toBeNull()
    expect(host.querySelector("[data-artifacts-empty]")).not.toBeNull()
    expect(host.querySelector("[data-artifacts-empty-run]")).toBeNull()

    // 这一次没有产物:条必须留着(用户得能换走),文案与项目级空态不同。
    harness.setPhase("empty-run")
    harness.setRuns([runtime.fakeRunRow({ runId: "job_r9d2c4c21e77", moment: null, readOnly: true })])
    harness.setSelectedRunId("job_r9d2c4c21e77")
    await flush()
    expect(host.querySelector("[data-artifacts-runbar]")).not.toBeNull()
    expect(host.querySelector("[data-artifacts-empty-run]")!.textContent).toContain(
      i18n.t("alpha.session.artifactsRunEmptyTitle"),
    )
    expect(host.querySelector("[data-artifacts-empty]")).toBeNull()
    // B1 失败关闭:时刻拿不到 → 条上渲染编号(中段截断),绝不渲染一个编出来的时间。
    expect(host.querySelector(".a-rart-runhead-tm")!.textContent).toBe("job_r9d2…1e77")
  })

  test("界面文案不含内部词:挂载后渲染文本无 manifest(en 与 zh 都扫)", async () => {
    const mountJargonSurface = async () => {
      const harness = runtime.createArtifactsViewHarness()
      harness.setPhase("cards")
      harness.setCards([runtime.fakeCard({ key: "art-1", name: "a.md" })])
      // 记录不可读的 run 行 + 展开列表,让 C 裁决的 chip 真的渲染出来。
      harness.setRuns([
        runtime.fakeRunRow({ runId: "job_good0000001", ordinal: "latest" }),
        runtime.fakeRunRow({ runId: "job_corrupt0001", moment: null, readOnly: true }),
      ])
      harness.setSelectedRunId("job_good0000001")
      harness.setQuota({ usedBytes: 5, maxBytes: 1024 })
      const host = mount(harness.View)
      await flush()
      host.querySelector<HTMLButtonElement>(".a-rart-runhead")!.click()
      await flush()
      expect(host.textContent).toContain(i18n.t("alpha.wb.runReadOnly")) // chip 真的在
      return host
    }

    const hostEn = await mountJargonSurface()
    expect(hostEn.textContent!.toLowerCase()).not.toContain("manifest")
    unmountAll()

    i18n.setLocale("zh")
    try {
      const hostZh = await mountJargonSurface()
      expect(hostZh.textContent!.toLowerCase()).not.toContain("manifest")
      expect(hostZh.textContent).toContain("记录不可读")
    } finally {
      i18n.setLocale("en")
      unmountAll()
    }
  })
})

describe("REQ-125 C4 artifacts container in the real shell (fake preload channel)", () => {
  test("latest run loads, first card auto-selects, verify-before-open runs, focusArtifact links in, identity switch resets (I8)", async () => {
    const { calls } = installFakeRunArtifacts({
      job_1: [manifestEntry("art-old", "旧报告.md")],
      job_2: [manifestEntry("art-1", "架构说明.md"), manifestEntry("art-2", "季度分析.md")],
    })
    const shell = runtime.createArtifactsShellHarness()
    const host = mount(shell.Shell)
    // Open the artifacts tab (review is the default panel).
    await openArtifactsTab(host)

    // No updatedAt anywhere → deterministic id-order fallback still puts job_2 first.
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
    const { calls } = installFakeRunArtifacts({ job_1: [manifestEntry("art-1", "架构说明.md")] }, { verify: () => gate })
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
    const { calls } = installFakeRunArtifacts({ job_1: [manifestEntry("art-1", "架构说明.md")] }, {
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
    const { calls } = installFakeRunArtifacts(
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

describe("#660 cross-run browsing and the run-saved push (real shell)", () => {
  test("初始选中按时间最新(编号序矛盾 fixture),切到别的一次真的换了内容", async () => {
    // 编号最大的 job_c 时间最旧,编号最小的 job_a 时间最新 —— 字典序会先取 job_c。
    const { calls } = installFakeRunArtifacts(
      {
        job_a: [manifestEntry("art-a", "最新一次.md")],
        job_b: [manifestEntry("art-b", "中间一次.md")],
        job_c: [manifestEntry("art-c", "最旧一次.md")],
      },
      {
        updatedAtByRun: {
          job_a: "2026-07-28T15:02:00.000Z",
          job_b: "2026-07-27T09:41:00.000Z",
          job_c: "2026-07-26T11:05:00.000Z",
        },
      },
    )
    const shell = runtime.createArtifactsShellHarness()
    const host = mount(shell.Shell)
    await openArtifactsTab(host)

    expect(calls.list[0]).toBe("job_a") // time-latest, NOT the id-descending job_c
    expect(host.querySelector(".alpha-wb-card-name")!.textContent).toBe("最新一次.md")

    // Expand the run sheet: rows in true chronological order, then pick job_b.
    host.querySelector<HTMLButtonElement>(".a-rart-runhead")!.click()
    await flush()
    const rows = [...host.querySelectorAll<HTMLButtonElement>("[data-run-row]")].map((row) =>
      row.getAttribute("data-run-row"),
    )
    expect(rows).toEqual(["job_a", "job_b", "job_c"])
    host.querySelector<HTMLButtonElement>("[data-run-row='job_b']")!.click()
    await flushTimers()
    await flushTimers()

    expect(calls.list).toContain("job_b")
    expect(host.querySelector(".alpha-wb-card-name")!.textContent).toBe("中间一次.md")
    // The sheet closed after the pick; the bar now states the picked run.
    expect(host.querySelector("[data-run-row]")).toBeNull()
    expect(host.querySelector(".a-rart-runhead")!.getAttribute("aria-expanded")).toBe("false")
  })

  test("推送事件触发重读:本目录 +1,别的目录不动(A1 过滤)", async () => {
    const { calls, emitRunSaved } = installFakeRunArtifacts({ job_1: [manifestEntry("art-1", "架构说明.md")] })
    const shell = runtime.createArtifactsShellHarness()
    const host = mount(shell.Shell)
    await openArtifactsTab(host)
    const usageBefore = calls.projectUsage
    const listBefore = calls.list.length

    // 事件指向当前正看的这一次 → 静默重读(无提示条)。
    emitRunSaved({ directory: DIR, runId: "job_1" })
    await flushTimers()
    expect(calls.projectUsage).toBe(usageBefore + 1)
    expect(calls.list.length).toBe(listBefore + 1)
    expect(host.querySelector("[data-artifacts-newrun]")).toBeNull()

    // 别的目录的事件 → 完全忽略。
    emitRunSaved({ directory: "/somewhere/else", runId: "job_9" })
    await flushTimers()
    expect(calls.projectUsage).toBe(usageBefore + 1)
    expect(host.querySelector("[data-artifacts-newrun]")).toBeNull()
  })

  test("提示条只为「别的那一次」出现,不抢焦点、不自动切换;点「查看」跳过去并收起", async () => {
    const entriesByRun: Record<string, unknown[]> = { job_1: [manifestEntry("art-1", "架构说明.md")] }
    const { calls, emitRunSaved } = installFakeRunArtifacts(entriesByRun, {
      updatedAtByRun: { job_1: "2026-07-27T09:41:00.000Z", job_new: "2026-07-28T15:02:00.000Z" },
    })
    const shell = runtime.createArtifactsShellHarness()
    const host = mount(shell.Shell)
    await openArtifactsTab(host)

    // The user is reading a card.
    const card = host.querySelector<HTMLButtonElement>("[data-artifact-card='art-1']")!
    card.focus()

    // A DIFFERENT run lands (it also becomes the time-latest in the refreshed usage).
    entriesByRun["job_new"] = [manifestEntry("art-new", "新结果.md")]
    emitRunSaved({ directory: DIR, runId: "job_new" })
    await flushTimers()
    await flushTimers()

    // Prompt + dot are on screen; focus did NOT move; content did NOT switch.
    expect(host.querySelector("[data-artifacts-newrun]")).not.toBeNull()
    expect(host.querySelector(".a-rart-iconbtn[data-alert]")).not.toBeNull()
    expect(document.activeElement).toBe(card)
    expect(host.querySelector(".alpha-wb-card-name")!.textContent).toBe("架构说明.md")

    // 「查看」= switch to the landed run and retire the prompt.
    host.querySelector<HTMLButtonElement>(".a-rart-newrun-lk")!.click()
    await flushTimers()
    await flushTimers()
    expect(calls.list).toContain("job_new")
    expect(host.querySelector(".alpha-wb-card-name")!.textContent).toBe("新结果.md")
    expect(host.querySelector("[data-artifacts-newrun]")).toBeNull()
    expect(host.querySelector(".a-rart-iconbtn[data-alert]")).toBeNull()
  })

  test("云端列表取不到时降级而非隐藏本地;取得到时未下载卡片合并进来", async () => {
    // ① 取不到({error} 信封):本地卡片仍渲染 + 降级通知同时渲染。
    installFakeRunArtifacts({ job_1: [manifestEntry("art-1", "架构说明.md")] })
    let shell = runtime.createArtifactsShellHarness()
    let host = mount(shell.Shell)
    await openArtifactsTab(host)
    await flushTimers()
    expect(host.querySelector(".alpha-wb-card-name")!.textContent).toBe("架构说明.md")
    expect(host.querySelector("[data-cloud-unavailable]")).not.toBeNull()
    unmountAll()
    delete (window as never as Record<string, unknown>).api

    // ② 取得到:平台多出的一件 = cloud-only 卡片,行尾给「下载」。
    installFakeRunArtifacts(
      { job_1: [manifestEntry("art-1", "架构说明.md")] },
      {
        cloudArtifacts: () => ({
          schema_version: 1,
          job_id: "job_1",
          status: "completed",
          artifacts: [{ id: "art_cloud_9", name: "云端附录.pdf", size: 9 }],
          artifact_ids: ["art_cloud_9"],
          result: null,
        }),
      },
    )
    shell = runtime.createArtifactsShellHarness()
    host = mount(shell.Shell)
    await openArtifactsTab(host)
    await flushTimers()
    expect(host.querySelector("[data-cloud-unavailable]")).toBeNull()
    const cloudCard = host.querySelector("[data-artifact-card='art_cloud_9']")!.closest(".alpha-wb-card")!
    expect(cloudCard.getAttribute("data-state")).toBe("cloud-only")
    expect(cloudCard.querySelector(".alpha-wb-card-actions .a-wb-btn")!.textContent).toBe(i18n.t("alpha.wb.download"))
  })

  test("本地为空+云端未答:不宣称空(loading);本地为空+云端失败:只说平台不可用(Major-2)", async () => {
    // ① 云端 pending:phase 停在 loading,绝无「这次没有产生文件」。
    let resolveCloud!: (value: unknown) => void
    const pendingCloud = new Promise((resolve) => (resolveCloud = resolve))
    installFakeRunArtifacts({ job_1: [] }, { cloudArtifacts: () => pendingCloud })
    let shell = runtime.createArtifactsShellHarness()
    let host = mount(shell.Shell)
    await openArtifactsTab(host)
    await flushTimers()
    const phaseAttr = () => host.querySelector("[data-alpha-session-artifacts]")!.getAttribute("data-artifacts-phase")
    expect(phaseAttr()).toBe("loading")
    expect(host.querySelector("[data-artifacts-empty-run]")).toBeNull()
    // 平台答复「确实没有」之后,才允许 empty-run 的断言出现。
    resolveCloud({ schema_version: 1, job_id: "job_1", status: "completed", artifacts: [], artifact_ids: [], result: null })
    await flushTimers()
    expect(phaseAttr()).toBe("empty-run")
    expect(host.querySelector("[data-artifacts-empty-run]")).not.toBeNull()
    unmountAll()
    delete (window as never as Record<string, unknown>).api

    // ② 云端失败:只渲染「平台列表不可用」,不渲染任何空态断言;条留着可换走。
    installFakeRunArtifacts({ job_1: [] }) // 默认 cloud.artifacts = {error}
    shell = runtime.createArtifactsShellHarness()
    host = mount(shell.Shell)
    await openArtifactsTab(host)
    await flushTimers()
    expect(phaseAttr()).toBe("empty-unknown")
    expect(host.querySelector("[data-cloud-unavailable]")).not.toBeNull()
    expect(host.querySelector("[data-artifacts-empty-run]")).toBeNull()
    expect(host.querySelector("[data-artifacts-empty]")).toBeNull()
    expect(host.querySelector("[data-artifacts-runbar]")).not.toBeNull()
  })

  test("换次之后复核闸门仍在字节之前:新 run 的 verify 未过,一个字节都不读", async () => {
    let resolveB!: (value: unknown) => void
    const gateB = new Promise((resolve) => (resolveB = resolve))
    const entryB = manifestEntry("art-b", "另一次.md")
    const { calls } = installFakeRunArtifacts(
      { job_a: [manifestEntry("art-a", "这一次.md")], job_b: [entryB] },
      {
        updatedAtByRun: { job_a: "2026-07-28T15:02:00.000Z", job_b: "2026-07-27T09:41:00.000Z" },
        verify: (run, artifactId) => {
          if (run === "job_b") return gateB
          const entry = manifestEntry(artifactId, "这一次.md")
          return Promise.resolve({ ok: true, entry })
        },
      },
    )
    const shell = runtime.createArtifactsShellHarness()
    const host = mount(shell.Shell)
    await openArtifactsTab(host)
    await flushTimers()
    const readsBefore = calls.read

    host.querySelector<HTMLButtonElement>(".a-rart-runhead")!.click()
    await flush()
    host.querySelector<HTMLButtonElement>("[data-run-row='job_b']")!.click()
    await flushTimers()
    await flushTimers()

    // The new run's cards are on screen, its verify is pending — bytes stay closed.
    expect(calls.list).toContain("job_b")
    expect(calls.verify).toContain("job_b:art-b")
    expect(host.querySelector("[data-artifacts-verifying]")).not.toBeNull()
    expect(calls.read).toBe(readsBefore)

    resolveB({ ok: true, entry: entryB })
    await flushTimers()
    await flushTimers()
    expect(calls.read).toBeGreaterThan(readsBefore)
  })

  test("容器下载接线:取消寻址原始 artifact id;落盘成功后重读清单(非乐观更新)", async () => {
    let resolveDownload!: (value: unknown) => void
    const pending = new Promise((resolve) => (resolveDownload = resolve))
    const entriesByRun: Record<string, unknown[]> = { job_1: [manifestEntry("art-1", "架构说明.md")] }
    const { calls, emitProgress, emitRunSaved } = installFakeRunArtifacts(entriesByRun, {
      cloudArtifacts: () => ({
        schema_version: 1,
        job_id: "job_1",
        status: "completed",
        artifacts: [{ id: "art_cloud_9", name: "云端附录.pdf", size: 9 }],
        artifact_ids: ["art_cloud_9"],
        result: null,
      }),
      download: () => pending,
    })
    const shell = runtime.createArtifactsShellHarness()
    const host = mount(shell.Shell)
    await openArtifactsTab(host)
    await flushTimers()

    const cloudCard = () => host.querySelector("[data-artifact-card='art_cloud_9']")!.closest(".alpha-wb-card")!
    cloudCard().querySelector<HTMLButtonElement>(".alpha-wb-card-actions .a-wb-btn")!.click()
    await flush()
    expect(calls.download).toEqual(["job_1:art_cloud_9"])

    // A progress frame addressed by the ORIGINAL artifact id reaches this card's reducer.
    emitProgress({ runId: "job_1", artifactId: "art_cloud_9", bytes: 43, total: 100, percent: 43 })
    await flush()
    expect(cloudCard().querySelector(".alpha-wb-progress")!.textContent).toBe("43%")

    // Cancel addresses main's in-flight ledger by the original id — never card.key variants.
    cloudCard().querySelector<HTMLButtonElement>(".alpha-wb-card-actions .a-wb-btn:last-of-type")!.click()
    await flush()
    expect(calls.cancel).toEqual(["art_cloud_9"])

    // The download settles ok while the reread still returns the OLD list (entries unchanged):
    // Major-3 window — the SAME card holds {status:"done"}: a non-clickable 已验证 chip,
    // no 「下载」 anywhere on it, and no way to fire a second downloadArtifact.
    const listBefore = calls.list.length
    resolveDownload({ ok: true, path: "x", bytes: 9, sha256: "0".repeat(64), verification: "verified", via: "stream" })
    await flushTimers()
    await flushTimers()
    expect(calls.list.length).toBeGreaterThan(listBefore) // re-read happened (not an optimistic flip)
    expect(cloudCard().querySelector("[data-download-done]")).not.toBeNull()
    expect(cloudCard().querySelector(".alpha-wb-card-actions .a-wb-btn")).toBeNull()
    expect(calls.download).toEqual(["job_1:art_cloud_9"]) // exactly one download, ever

    // The manifest reread finally lands the verified local card → the cloud-only card is
    // replaced, the transient done phase is cleared with it.
    entriesByRun["job_1"] = [manifestEntry("art-1", "架构说明.md"), manifestEntry("art_cloud_9", "云端附录.pdf")]
    emitRunSaved({ directory: DIR, runId: "job_1" })
    await flushTimers()
    await flushTimers()
    const landed = host.querySelector("[data-artifact-card='art_cloud_9']")!.closest(".alpha-wb-card")!
    expect(landed.getAttribute("data-state")).toBe("verified")
    expect(landed.querySelector("[data-download-done]")).toBeNull()
    expect(landed.querySelector(".alpha-wb-card-actions")).toBeNull()
  })
})
