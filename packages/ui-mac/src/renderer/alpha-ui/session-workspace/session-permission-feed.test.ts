// REQ-125 C7:审批 dock PermissionV2 feed 的 fail-closed / stale 拒收契约。

import { describe, expect, test } from "bun:test"
import type {
  PermissionV2DecisionCommand,
  PermissionV2DecisionReceipt,
  PermissionV2Request,
} from "@opencode-ai/sdk/v2/client"
import { createPermissionV2Feed, reconcilePermissionRequests } from "./session-permission-feed"

const request = (id: string): PermissionV2Request =>
  ({
    id,
    sessionID: "ses_1",
    fingerprint: `fp-${id}`,
    subject: { kind: "agent", id: "build" },
    action: "tool.execute",
    resources: ["bash:bun run typecheck"],
    scope: { kind: "session", sessionID: "ses_1" },
    expiresAt: null,
    save: ["bash:bun run typecheck"],
  }) as unknown as PermissionV2Request

const receipt = (requestID: string, resolved: string[] = []): PermissionV2DecisionReceipt =>
  ({
    requestID,
    resolvedRequestIDs: resolved,
    decisionID: `pdec_${requestID}`,
    decision: "once",
  }) as unknown as PermissionV2DecisionReceipt

const command: PermissionV2DecisionCommand = {
  requestFingerprint: "fp-a",
  decisionID: "pdec_test",
  decision: "once",
} as PermissionV2DecisionCommand

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("fail-closed:PermissionV2 读不到 = 不放行", () => {
  test("list 失败时 ready 恒为 false,任何回复都被拒绝且不发网络请求", async () => {
    let replies = 0
    const feed = createPermissionV2Feed({
      list: () => Promise.reject(new Error("channel down")),
      reply: () => {
        replies++
        return Promise.resolve(receipt("req-a"))
      },
    })
    feed.load()
    await flush()

    expect(feed.state.ready).toBe(false)
    // 事件增量在快照失败期间也不能把 feed 变成可信来源。
    feed.apply({ type: "asked", request: request("req-a") })
    expect(feed.state.ready).toBe(false)
    await expect(feed.reply("req-a", command)).rejects.toThrow("not ready")
    expect(replies).toBe(0)
    feed.dispose()
  })

  test("list 成功后 ready = true,挂起请求可见并可回复", async () => {
    const feed = createPermissionV2Feed({
      list: () => Promise.resolve([request("req-a")]),
      reply: (requestID) => Promise.resolve(receipt(requestID)),
    })
    feed.load()
    await flush()

    expect(feed.state.ready).toBe(true)
    expect(feed.state.requests.map((item) => item.id)).toEqual(["req-a"])
    await feed.reply("req-a", command)
    expect(feed.state.requests).toEqual([])
    feed.dispose()
  })
})

describe("I8:回复绑 request ID,stale/重复回复拒收", () => {
  test("未知 request ID 直接拒绝,不发网络请求", async () => {
    let replies = 0
    const feed = createPermissionV2Feed({
      list: () => Promise.resolve([request("req-a")]),
      reply: () => {
        replies++
        return Promise.resolve(receipt("req-a"))
      },
    })
    feed.load()
    await flush()

    await expect(feed.reply("req-ghost", command)).rejects.toThrow("stale permission reply")
    expect(replies).toBe(0)
    feed.dispose()
  })

  test("已决请求(事件先到)再回复 = stale 拒收;同请求的迟到 asked 也不复活", async () => {
    let replies = 0
    const feed = createPermissionV2Feed({
      list: () => Promise.resolve([request("req-a"), request("req-b")]),
      reply: (requestID) => {
        replies++
        return Promise.resolve(receipt(requestID))
      },
    })
    feed.load()
    await flush()

    feed.apply({ type: "replied", receipt: receipt("req-a") })
    expect(feed.state.requests.map((item) => item.id)).toEqual(["req-b"])
    await expect(feed.reply("req-a", command)).rejects.toThrow("stale permission reply")
    expect(replies).toBe(0)

    feed.apply({ type: "asked", request: request("req-a") })
    expect(feed.state.requests.map((item) => item.id)).toEqual(["req-b"])
    feed.dispose()
  })

  test("list 在途时的事件增量按序合并(buffered),receipt 的 resolvedRequestIDs 一并落决", async () => {
    let release: (value: PermissionV2Request[]) => void = () => {}
    const feed = createPermissionV2Feed({
      list: () => new Promise<PermissionV2Request[]>((resolve) => (release = resolve)),
      reply: (requestID) => Promise.resolve(receipt(requestID)),
    })
    feed.load()
    feed.apply({ type: "asked", request: request("req-c") })
    feed.apply({ type: "replied", receipt: receipt("req-a", ["req-b"]) })
    expect(feed.state.ready).toBe(false)

    release([request("req-a"), request("req-b")])
    await flush()

    expect(feed.state.ready).toBe(true)
    expect(feed.state.requests.map((item) => item.id)).toEqual(["req-c"])
    feed.dispose()
  })
})

describe("reconcile 纯函数(watcher 与 dock 单一同源)", () => {
  test("快照 + 增量 + 已决集合并出当前挂起列表", () => {
    const resolved = new Set<string>(["req-done"])
    const merged = reconcilePermissionRequests(
      [request("req-a"), request("req-done")],
      [
        { type: "asked", request: request("req-b") },
        { type: "asked", request: request("req-a") },
        { type: "replied", receipt: receipt("req-b") },
      ],
      resolved,
    )
    expect(merged.map((item) => item.id)).toEqual(["req-a"])
  })
})
