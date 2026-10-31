import { createSignal } from "solid-js"
import type { Route } from "../../../shared/route-manifest"
import { projectLabel } from "../../sidebar/route"
import { sessionDisplayTitle } from "../session-title"

export interface AlphaSessionIdentity {
  serverKey: string
  directory: string
  sessionID: string
}

export interface AlphaSessionLiveSnapshot {
  identity: AlphaSessionIdentity
  project: string
  title: string
  activity: "idle" | "running"
  /** `#1588` AC4:运行中的那一种是自动重试(session_status=retry);顶栏据此写「正在重试」。 */
  retrying?: true
}

export interface AlphaSessionRecord {
  id: string
  directory: string
  title: string
  parentID?: string
}

export function sessionLiveSnapshotOf(input: {
  route: Route
  providerServerKey: string
  session?: AlphaSessionRecord
  status?: { type: string }
}): AlphaSessionLiveSnapshot | undefined {
  if (input.route.kind !== "session" || !input.route.id) return undefined
  if (input.route.serverKey && input.route.serverKey !== input.providerServerKey) return undefined
  if (input.session?.id !== undefined && input.session.id !== input.route.id) return undefined

  const directory = input.route.directory ?? input.session?.directory
  if (!directory) return undefined
  if (input.session && input.session.directory !== directory) return undefined
  if (input.route.identity.routeId === "session" && !input.session) return undefined

  return {
    identity: {
      serverKey: input.route.serverKey ?? input.providerServerKey,
      directory,
      sessionID: input.route.id,
    },
    project: projectLabel(directory),
    // #1589 AC1:与侧栏同一份显示规则;会话记录未读到时留空,由界面显示「对话」—— 不显示会话编号。
    title: input.session ? sessionDisplayTitle(input.session.title.trim()) : "",
    activity: input.status?.type && input.status.type !== "idle" ? "running" : "idle",
    ...(input.status?.type === "retry" ? { retrying: true as const } : {}),
  }
}

export function sameSessionIdentity(
  left: AlphaSessionIdentity | undefined,
  right: AlphaSessionIdentity | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.serverKey === right.serverKey &&
    left.directory === right.directory &&
    left.sessionID === right.sessionID
  )
}

/** 会话身份三元组 → 稳定字符串 key(NUL 分隔,避免段间歧义);无身份 = undefined。 */
export function identityKey(identity: AlphaSessionIdentity | undefined): string | undefined {
  return identity ? `${identity.serverKey}\u0000${identity.directory}\u0000${identity.sessionID}` : undefined
}

/**
 * `#1318` AC3:会话页「把焦点放回输入框」的小通道。workspace 持有;会话 composer 挂载时登记
 * 「聚焦我的 textarea」、卸载时注销;时间线拿 `focus` 当空回合行「修改后再试」的动作。
 * 没人登记(子会话卡顶替了 composer / 身份未解析)时 `focus` 是 no-op —— 不去 DOM 里找输入框。
 * 注销只撤自己那一份:按身份 keyed 重挂时新实例可能先登记、旧实例后清理,不能把新的也清掉。
 */
export function createComposerFocusChannel() {
  let current: (() => void) | undefined
  return {
    register(focus: () => void): () => void {
      current = focus
      return () => {
        if (current === focus) current = undefined
      }
    },
    focus(): void {
      current?.()
    },
  }
}

/**
 * `#1588` AC3:会话页「打开输入框的模型选择器」的通道。与焦点通道同形,但登记状态是反应式的:
 * 回合错误卡的「换模型」只在有人登记时才出现(输入框没挂载 = 不出按钮,不改用别的动作)。
 * 注销只撤自己那一份(按身份 keyed 重挂时新实例可能先登记)。
 */
export function createComposerModelPickerChannel() {
  const [current, setCurrent] = createSignal<(() => void) | undefined>(undefined)
  return {
    register(open: () => void): () => void {
      setCurrent(() => open)
      return () => {
        if (current() === open) setCurrent(undefined)
      }
    },
    current,
  }
}
