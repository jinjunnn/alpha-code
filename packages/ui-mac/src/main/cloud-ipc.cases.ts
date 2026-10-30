// #660 裁决 A1 —— cloud-save-run 的「run 已落盘」广播接线闸门(子进程跑,mock.module 不污染主进程)。
//
// 断言的是可观察调用序,不是源码文本:
//   · saved.ok 且 Outputs 镜像跑完之后,「全部存活窗口」的 webContents.send 都收到
//     ("cloud-run-saved", { directory, runId }) —— 不是只有发起窗口(cloud-artifact-progress
//     的单窗口 wc.send 范式在这里是错的,CloudRunWatcher 与产物面板可能在不同窗口);
//   · 广播严格发生在 mirrorRunArtifacts 之后(收到事件时盘上已 settle);
//   · saved.ok=false 不广播;已销毁窗口跳过不炸。
//
// 这层 stub 掉了网络与磁盘,证明的是接线不是端到端 —— 端到端归 #660 的 L1 核验清单。

import { beforeEach, describe, expect, mock, test } from "bun:test"

type SentRecord = { window: string; channel: string; payload: unknown }
const order: string[] = []
const sent: SentRecord[] = []
const opened: string[] = []

function fakeWindow(name: string, destroyed = false) {
  return {
    webContents: {
      id: name,
      isDestroyed: () => destroyed,
      send: (channel: string, payload: unknown) => {
        order.push(`send:${name}`)
        sent.push({ window: name, channel, payload })
      },
      once: () => {},
      removeListener: () => {},
    },
  }
}

let windows: ReturnType<typeof fakeWindow>[] = []
const handlers = new Map<string, (...args: unknown[]) => unknown>()
let saveResult: { ok: boolean; dir?: string; files?: string[]; warnings?: string[]; failures?: unknown[]; reason?: string } = {
  ok: true,
}
/** #1551:tracker 经由的状态 / 列表 / 现盘复核 / 登记(逐条用例改写)。 */
let statusImpl: () => Promise<unknown> = async () => ({ error: "unused" })
let listResult: unknown = { error: "unused" }
let verifyResult: unknown = { ok: false, reason: "artifact not found" }
let registerResult: unknown = { ok: false, reason: "unused in this harness" }
let downloadCalls = 0
/** `#970`:cloud-artifact-download handler 这一跳要转发的下载结局(逐条用例改写)。 */
let downloadOutcome: unknown = { ok: false, error: "unused" }
/** #1112:handler 每次预约名字的实参捕获(含账本占用谓词)。 */
const reserveCalls: { desiredName: string; disambiguator: string; claimedByOther?: (candidateName: string) => boolean }[] = []

mock.module("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => windows,
    fromWebContents: () => undefined,
  },
  // #420:cloud-ipc 现在静态 import cloud-job-notify(它 import electron.Notification);本 harness 里
  // isTerminalCloudEvent 恒 false、saveCloudRun 被桩掉 ⇒ 永远走不到 new Notification,这里只需让 import 解析。
  // 通知本身的接线判据在 cloud-job-notify.cases.ts。
  Notification: class {
    on() {
      return this
    }
    show() {}
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    },
  },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openExternal: async (url: string) => { opened.push(url) } },
}))
mock.module("./logging", () => ({
  getLogger: () => ({ log: () => {}, warn: () => {}, error: () => {} }),
}))
/** #1112:账本归属 stub(name → owner artifactId);接线用例逐条改写。 */
const ledgerOwners = new Map<string, string>()
mock.module("./artifact-service", () => ({
  finalizeArtifactWithQuota: () => ({ ok: false, reason: "unused in this harness" }),
  registerDownloadedArtifact: () => registerResult,
  registeredArtifactNameOwner: (_dir: string, _run: string, name: string) => ledgerOwners.get(name),
  recordRunOrigin: () => ({ ok: true }),
  verifyArtifact: async () => verifyResult,
}))
mock.module("./alpha-cloud-jobs", () => ({
  dispatchCloudJob: async () => ({ error: "unused" }),
  dispatchExplicitCloudUpload: async () => ({ error: "unused" }),
  getCloudJobStatus: () => statusImpl(),
  cancelCloudJob: async () => ({ error: "unused" }),
  listCloudArtifacts: async () => listResult,
  downloadCloudArtifactTo: async () => {
    downloadCalls++
    return downloadOutcome
  },
}))
mock.module("./alpha-cloud-events", () => ({
  isTerminalCloudEvent: () => false,
  subscribeCloudJobEvents: () => () => {},
}))
mock.module("./alpha-workdir", () => ({
  ensureAlphaScaffold: () => true,
  isSafeRunId: (id: unknown) => typeof id === "string" && /^job_[a-z0-9]+$/.test(id),
  safeResolveInAlpha: () => "/tmp/unused",
  sanitizeArtifactName: (name?: string) => name ?? "artifact",
  reserveArtifactSavedName: (
    _artifactsDir: string,
    desiredName: string,
    disambiguator: string,
    taken?: Set<string>,
    claimedByOther?: (candidateName: string) => boolean,
  ) => {
    reserveCalls.push({ desiredName, disambiguator, claimedByOther })
    return desiredName
  },
  saveCloudRun: async () => {
    order.push("save")
    return saveResult
  },
}))
mock.module("./alpha-user-workspace", () => ({
  mirrorRunArtifacts: () => {
    order.push("mirror")
    return { ok: true, mirroredFiles: [] }
  },
}))
mock.module("./alpha-auth", () => ({
  getAccessTokenIdentity: async () => ({ error: "unused" }),
  getAuthIdentityEpoch: () => 1,
  getAuthIdentityTag: () => "acct",
}))
mock.module("./alpha-web-upload-consent", () => ({
  requestUploadConsent: async () => ({ error: "unused" }),
}))
mock.module("./alpha-upload", () => ({
  assertSafeUploadResult: (value: unknown) => value,
  createMainUploadService: () => ({
    prepare: async () => ({ status: "cancelled" }),
    confirm: async () => ({ status: "cancelled" }),
    cancel: () => ({ status: "cancelled" }),
    clear: () => {},
  }),
}))

const { registerCloudIpcHandlers } = await import("./cloud-ipc")
registerCloudIpcHandlers()
const saveRun = handlers.get("cloud-save-run")!
const artifactDownload = handlers.get("cloud-artifact-download")!

test("REQ-232 AC5 billing actions use the resolved web endpoint and frozen portal paths", async () => {
  const previous = process.env.ALPHA_WEB_URL
  process.env.ALPHA_WEB_URL = "https://portal.invalid"
  try {
    await handlers.get("cloud-open-billing-page")!({}, "recharge")
    await handlers.get("cloud-open-billing-page")!({}, "overflow")
    expect(opened).toEqual(["https://portal.invalid/wallet?tab=recharge", "https://portal.invalid/account"])
  } finally {
    if (previous === undefined) delete process.env.ALPHA_WEB_URL
    if (previous !== undefined) process.env.ALPHA_WEB_URL = previous
  }
})

beforeEach(() => {
  order.length = 0
  sent.length = 0
  reserveCalls.length = 0
  ledgerOwners.clear()
  saveResult = { ok: true, dir: "/proj/.alpha/runs/job_abc", files: ["artifacts/a.md"], warnings: [], failures: [] }
  downloadOutcome = { ok: false, error: "unused" }
  downloadCalls = 0
  windows = [fakeWindow("A"), fakeWindow("B")]
})

describe("#660 A1 cloud-run-saved broadcast wiring", () => {
  test("落盘成功 → 全部窗口(不只发起者)收到最小载荷,且严格在镜像之后", async () => {
    const event = { sender: windows[0]!.webContents } // 发起窗口 = A;B 也必须收到
    const result = await saveRun(event, "/proj", "job_abc")
    expect((result as { ok: boolean }).ok).toBe(true)

    const saved = sent.filter((s) => s.channel === "cloud-run-saved")
    expect(saved.map((s) => s.window).sort()).toEqual(["A", "B"])
    for (const record of saved) expect(record.payload).toEqual({ directory: "/proj", runId: "job_abc" })

    // 调用序:save → mirror → send…(镜像 settle 之前不许广播)
    expect(order[0]).toBe("save")
    expect(order[1]).toBe("mirror")
    expect(order.slice(2).sort()).toEqual(["send:A", "send:B"])
  })

  test("落盘失败 → 零广播", async () => {
    saveResult = { ok: false, reason: "network" }
    await saveRun({ sender: windows[0]!.webContents }, "/proj", "job_abc")
    expect(sent.filter((s) => s.channel === "cloud-run-saved")).toEqual([])
  })

  test("已销毁的窗口被跳过,其余照常收到", async () => {
    windows = [fakeWindow("A"), fakeWindow("gone", true), fakeWindow("C")]
    await saveRun({ sender: windows[0]!.webContents }, "/proj", "job_abc")
    const saved = sent.filter((s) => s.channel === "cloud-run-saved")
    expect(saved.map((s) => s.window).sort()).toEqual(["A", "C"])
  })
})

// `#970`:main → renderer 之间隔着**两跳有逻辑的转发**,这里钉的是靠上的那一跳
// (cloud-artifact-download 的真 handler);低一层的 downloadCloudArtifactTo 由
// src/main/alpha-cloud-jobs.cases.ts 钉同样两个方向。
// 判据不能在两端各自绿而中间没人跑 —— 今天这一跳是原样直传,但它正是最容易长出
// 「规整返回形状 / 只挑白名单字段」的地方(同文件上方已经在自己铸造 invalid-request /
// invalid-artifact / unsafe-path 信封)。哪天有人加个 normalizer 把结构槽挑掉,用户可观察的
// 缺陷(服务端拒绝显示成「你取消了」)就静默回来,而两端的判据全绿。
// 更下游的 preload 那一跳是无逻辑的 ipcRenderer.invoke 直传,不另设判据(见 PR 正文)。
describe("#970 cloud-artifact-download 这一跳既不吞掉、也不凭空造出结构槽", () => {
  const invoke = () =>
    artifactDownload({ sender: windows[0]!.webContents }, "/proj", "job_abc", { id: "art_1", name: "a.md" })

  test("本地取消的结构槽原样穿过 handler", async () => {
    downloadOutcome = { ok: false, error: "cancelled", cancelled: true }
    expect(await invoke()).toEqual({ ok: false, error: "cancelled", cancelled: true })
  })

  test("平台伪造的 cancelled 分类码穿过 handler 之后仍然没有结构槽", async () => {
    downloadOutcome = { ok: false, error: "cancelled" }
    const result = (await invoke()) as Record<string, unknown>
    expect(result).toEqual({ ok: false, error: "cancelled" })
    expect("cancelled" in result).toBe(false)
  })

  // #1112:handler 必须把「账本占用 + 自身 id」组合成占用谓词交给预约 ——
  // 归他人的名字算占用、归自己的与无主的名字不算(同件重下的原地覆盖因此保留)。
  // 谓词语义的机械正确性在 alpha-workdir/artifact-service 各自的真测试里;这里钉的是
  // 这一跳真的把两者接上了(漏传谓词 = 预约退回只读目录,C5.5 静默覆盖原样回来)。
  test("#1112 预约收到账本占用谓词:他人名字 → 占用;自己/无主 → 放行", async () => {
    ledgerOwners.set("owned-by-other.md", "art_someone_else")
    ledgerOwners.set("owned-by-self.md", "art_1")
    downloadOutcome = { ok: false, error: "network" }
    await invoke() // artifact id = art_1
    expect(reserveCalls.length).toBe(1)
    const { disambiguator, claimedByOther } = reserveCalls[0]!
    expect(disambiguator).toBe("art_1")
    expect(claimedByOther).toBeDefined()
    expect(claimedByOther!("owned-by-other.md")).toBe(true)
    expect(claimedByOther!("owned-by-self.md")).toBe(false)
    expect(claimedByOther!("unowned.md")).toBe(false)
  })
})

// ---- REQ-236 #1551:cloud-save-run 不吞失败;tracker 与面板单件下载共用一个协调者 ----

const producer = new URL("../../../alpha-contracts-consumer/vendor/alpha-platform/contracts/v1/fixtures/producer/", import.meta.url)
const DESCRIPTOR = (await Bun.file(new URL("artifact-list.json", producer)).json()).value.artifacts[0]
const COMPLETED = { ...(await Bun.file(new URL("cloud-job-status.json", producer)).json()).value, job_id: "job_abc" }
const runStates = () => sent.filter((s) => s.channel === "cloud-run-state").map((s) => s.payload as { delivery: { status: string } })

describe("#1551 AC2/AC5 cloud IPC wiring", () => {
  test("cloud-save-run 把 failures 原样交给调用方(不折成成功)", async () => {
    saveResult = { ...saveResult, failures: [{ scope: "download", artifactId: "art_1", code: "network" }] }
    const result = (await saveRun({ sender: windows[0]!.webContents }, "/proj", "job_abc")) as { failures: unknown[] }
    expect(result.failures).toEqual([{ scope: "download", artifactId: "art_1", code: "network" }])
  })

  test("tracker 交付在途时,面板单件下载返回 already-downloading,不发下载", async () => {
    statusImpl = () => new Promise(() => {}) // 状态回包永不到:交付一直在途
    expect(await handlers.get("cloud-run-track")!({}, "/proj-inflight", "job_abc")).toEqual({ ok: true })
    const result = await artifactDownload({ sender: windows[0]!.webContents }, "/proj-inflight", "job_abc", DESCRIPTOR)
    expect(result).toEqual({ ok: false, error: "already-downloading" })
    expect(downloadCalls).toBe(0)
  })

  test("单件下载成功登记后,宿主重新核验并向全部窗口广播 cloud-run-state saved", async () => {
    statusImpl = async () => COMPLETED
    listResult = { schema_version: 1, job_id: "job_abc", status: "completed", artifacts: [DESCRIPTOR], artifact_ids: [DESCRIPTOR.id], result: null }
    verifyResult = { ok: false, reason: "artifact not found" }
    saveResult = { ...saveResult, failures: [{ scope: "download", artifactId: DESCRIPTOR.id, code: "not-found" }] }
    await handlers.get("cloud-run-track")!({}, "/proj-manual", "job_abc")
    for (let i = 0; i < 200 && runStates().at(-1)?.delivery.status !== "failed"; i++) await Bun.sleep(2)
    expect(runStates().at(-1)?.delivery.status).toBe("failed")

    // 用户在面板手动补下:下载成功、登记成功、现盘复核此刻通过。
    downloadOutcome = { ok: true, path: "/tmp/unused", bytes: 12, sha256: DESCRIPTOR.sha256, verification: "verified", via: "stream" }
    registerResult = { ok: true, entry: {} }
    verifyResult = { ok: true, entry: { descriptor: DESCRIPTOR, local: { state: "verified" } } }
    sent.length = 0
    await artifactDownload({ sender: windows[0]!.webContents }, "/proj-manual", "job_abc", DESCRIPTOR)
    for (let i = 0; i < 200 && runStates().length < 2; i++) await Bun.sleep(2)
    const saved = sent.filter((s) => s.channel === "cloud-run-state")
    expect(saved.map((s) => s.window).sort()).toEqual(["A", "B"])
    expect(saved[0]!.payload).toMatchObject({ directory: "/proj-manual", runId: "job_abc", delivery: { status: "saved" } })
    expect(await handlers.get("cloud-run-state-get")!({}, "/proj-manual", "job_abc")).toMatchObject({ delivery: { status: "saved" } })
  })

  test("trackRun 拒绝形状不对的 origin(归属只收会话 id 等字符串)", async () => {
    statusImpl = () => new Promise(() => {})
    expect(await handlers.get("cloud-run-track")!({}, "/proj-origin", "job_abc", { sessionID: 7 })).toEqual({ ok: false })
    expect(await handlers.get("cloud-run-track")!({}, "/proj-origin", "../evil")).toEqual({ ok: false })
    expect(await handlers.get("cloud-run-track")!({}, "/proj-origin", "job_abc", { sessionID: "ses_a", partID: "prt_1" })).toEqual({ ok: true })
  })
})
