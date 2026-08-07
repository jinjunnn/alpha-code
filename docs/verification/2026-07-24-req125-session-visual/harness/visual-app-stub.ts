// #547 visual-only typed context stub. It feeds the real SessionComposerDock without
// Electron, network, credentials, or production state. The selected fixture is fixed by
// the URL before Solid mounts, so no mutable test channel ships with the application.
export { createPermissionChannelSource } from "../../../../packages/app/src/context/permission-v1-adapter"

const state = new URLSearchParams(location.search).get("state")?.toUpperCase() ?? "A1"
const sessionID = "ses_visual"

const never = () => new Promise<never>(() => {})
const inertClient = new Proxy(() => undefined, {
  get(_target, property) {
    if (typeof property === "symbol" || property === "then") return undefined
    return inertClient
  },
  apply() {
    return never()
  },
})

const todo =
  state === "J2"
    ? {
        [sessionID]: [
          { content: "核对视觉矩阵", status: "completed", priority: "high" },
          { content: "补齐明暗证据", status: "in_progress", priority: "high" },
          { content: "登记偏差与票号", status: "pending", priority: "medium" },
        ],
      }
    : {}

const question =
  state === "J3"
    ? {
        [sessionID]: [
          {
            id: "que_visual",
            sessionID,
            questions: [
              {
                header: "发布",
                question: "现在就发布吗?",
                options: [
                  { label: "是", description: "继续当前交付链" },
                  { label: "否", description: "保留为草稿" },
                ],
              },
            ],
          },
        ],
      }
    : {}

const info: Record<string, unknown> = {}
const message: Record<string, unknown> = {}
if (state === "J5") {
  info[sessionID] = { id: sessionID, title: "整理架构说明", revert: { messageID: "msg_001" } }
  message[sessionID] = [
    { id: "msg_001", role: "user" },
    { id: "msg_002", role: "assistant" },
    { id: "msg_003", role: "user" },
  ]
}
if (state === "J6") {
  info[sessionID] = { id: sessionID, title: "验证子会话", parentID: "ses_parent" }
  info.ses_parent = { id: "ses_parent", title: "REQ-125 视觉验收" }
}

const serverSyncState = {
  session: {
    data: { todo, question, info, message },
  },
}

const dirSdkContext = {
  client: inertClient,
  event: { on: () => () => {} },
}
const serverSdk = {
  client: inertClient,
  ensureDirSdkContext: () => dirSdkContext,
}

export function useServerSDK() {
  return () => serverSdk
}

export function useServerSync() {
  return () => serverSyncState
}

export function useCommand() {
  return { options: [], trigger() {} }
}
