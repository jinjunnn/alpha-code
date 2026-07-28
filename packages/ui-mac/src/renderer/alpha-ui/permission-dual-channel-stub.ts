// #668 双通道审批闸门的**最小宿主替身**(只替换 solid 上下文与传输,不替换被测逻辑)。
//
// 被测的是生产三件套原样组合:
//   packages/app/src/context/permission-surface.tsx(接线点:list/subscribe/reply 路由)
// × packages/app/src/context/permission-v1-adapter.ts(v1↔审批面形状适配)
// × packages/ui-mac/.../permission-watcher.tsx + PermissionDialog.tsx(呈现与决定)
// 这里只把 `useParams` / `useSDK` / `useSync` 换成可驱动的替身,并把 SDK 出口录音 —— 于是
// "点了按钮之后到底有没有一个真的请求发出去、发到哪条通道"是可观测的,而不是"函数被调用了"。

export type RecordedCall = { path: string; args: unknown[] }

export const sdkCalls: RecordedCall[] = []

export const HARNESS = {
  sessionID: "ses_dual_channel_1",
  projectID: "prj_alpha",
  agent: "build",
  messageID: "msg_dual_1",
}

type AnyRequest = Record<string, unknown>

let pendingV1: AnyRequest[] = []
let pendingV2: AnyRequest[] = []
let v1ListFails = false
let v2ListFails = false
let v1ReplyFails = false
let messages: Array<{ id: string; role: string; agent?: string }> = []

const handlers = new Map<string, Set<(event: unknown) => void>>()

function listeners(type: string) {
  let set = handlers.get(type)
  if (!set) {
    set = new Set()
    handlers.set(type, set)
  }
  return set
}

export function resetDualChannelHarness() {
  sdkCalls.splice(0)
  pendingV1 = []
  pendingV2 = []
  v1ListFails = false
  v2ListFails = false
  v1ReplyFails = false
  handlers.clear()
  messages = [{ id: HARNESS.messageID, role: "assistant", agent: HARNESS.agent }]
}

resetDualChannelHarness()

export function seedPendingV1(requests: AnyRequest[]) {
  pendingV1 = requests
}

export function seedPendingV2(requests: AnyRequest[]) {
  pendingV2 = requests
}

export function failV1List(value = true) {
  v1ListFails = value
}

export function failV2List(value = true) {
  v2ListFails = value
}

export function failV1Reply(value = true) {
  v1ReplyFails = value
}

export function dropMessages() {
  messages = []
}

export function emit(type: string, properties: unknown) {
  for (const handler of [...listeners(type)]) handler({ type, properties })
}

function record(path: string, args: unknown[]) {
  sdkCalls.push({ path, args })
}

/** 审批类流量的路径集合(判"决定发到了哪条通道"用)。 */
export function permissionTraffic() {
  return sdkCalls.map((call) => call.path).filter((path) => path.toLowerCase().includes("permission"))
}

const client = {
  permission: {
    list: (...args: unknown[]) => {
      record("permission.list", args)
      if (v1ListFails) return Promise.reject(new Error("v1 permission list failed"))
      return Promise.resolve({ data: pendingV1 })
    },
    reply: (...args: unknown[]) => {
      record("permission.reply", args)
      if (v1ReplyFails) return Promise.reject(new Error("v1 permission reply failed"))
      return Promise.resolve({ data: true })
    },
  },
  v2: {
    session: {
      permission: {
        list: (...args: unknown[]) => {
          record("v2.session.permission.list", args)
          if (v2ListFails) return Promise.reject(new Error("v2 permission list failed"))
          return Promise.resolve({ data: { data: pendingV2 } })
        },
        reply: (...args: unknown[]) => {
          record("v2.session.permission.reply", args)
          const input = args[0] as {
            requestID: string
            permissionV2DecisionCommand: { decision: string; decisionID: string; requestFingerprint: string }
          }
          return Promise.resolve({
            data: {
              data: {
                requestID: input.requestID,
                sessionID: HARNESS.sessionID,
                requestFingerprint: input.permissionV2DecisionCommand.requestFingerprint,
                decisionID: input.permissionV2DecisionCommand.decisionID,
                decision: input.permissionV2DecisionCommand.decision,
                committedAt: 1_893_456_000_001,
                resolvedRequestIDs: [input.requestID],
              },
            },
          })
        },
      },
    },
  },
}

const dirSdk = {
  directory: "/tmp/workspace",
  client,
  event: {
    on(type: string, handler: (event: unknown) => void) {
      listeners(type).add(handler)
      return () => listeners(type).delete(handler)
    },
  },
}

// ── 被 alias 替换掉的三个宿主入口 ─────────────────────────────────────────────
export function useSDK() {
  return () => dirSdk
}

export function useSync() {
  return () => ({
    project: { id: HARNESS.projectID },
    // 目录作用域 store 刻意留空 —— 生产接线点在这一份取不到消息时必须回落到 server 作用域
    // 的那一份(#668 的 agent 还原双源),这条回落路径因此被闸门真的执行到。
    data: { message: {} as Record<string, typeof messages> },
  })
}

export function useServerSync() {
  return () => ({ session: { data: { message: { [HARNESS.sessionID]: messages } } } })
}

export function useParams() {
  return { id: HARNESS.sessionID }
}
