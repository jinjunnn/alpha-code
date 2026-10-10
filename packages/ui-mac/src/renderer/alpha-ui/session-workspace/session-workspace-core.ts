import type { Route } from "../../../shared/route-manifest"
import { projectLabel } from "../../sidebar/route"

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
    title: input.session?.title.trim() || input.route.id,
    activity: input.status?.type && input.status.type !== "idle" ? "running" : "idle",
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
