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
let saveResult: { ok: boolean; dir?: string; files?: string[]; warnings?: string[]; reason?: string } = { ok: true }

mock.module("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => windows,
    fromWebContents: () => undefined,
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    },
  },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}))
mock.module("./logging", () => ({
  getLogger: () => ({ log: () => {}, warn: () => {}, error: () => {} }),
}))
mock.module("./artifact-service", () => ({
  finalizeArtifactWithQuota: () => ({ ok: false, reason: "unused in this harness" }),
  registerDownloadedArtifact: () => ({ ok: false, reason: "unused in this harness" }),
}))
mock.module("./alpha-cloud-jobs", () => ({
  dispatchCloudJob: async () => ({ error: "unused" }),
  dispatchExplicitCloudUpload: async () => ({ error: "unused" }),
  getCloudJobStatus: async () => ({ error: "unused" }),
  cancelCloudJob: async () => ({ error: "unused" }),
  listCloudArtifacts: async () => ({ error: "unused" }),
  downloadCloudArtifactTo: async () => ({ ok: false, error: "unused" }),
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

beforeEach(() => {
  order.length = 0
  sent.length = 0
  saveResult = { ok: true, dir: "/proj/.alpha/runs/job_abc", files: ["artifacts/a.md"], warnings: [] }
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
