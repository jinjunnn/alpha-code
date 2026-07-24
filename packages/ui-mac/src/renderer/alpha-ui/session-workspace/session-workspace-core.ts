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
