import { base64Encode } from "@opencode-ai/core/util/encode"

export function acceptKey(sessionID: string, directory?: string) {
  if (!directory) return sessionID
  return `${base64Encode(directory)}/${sessionID}`
}

export function directoryAcceptKey(directory: string) {
  return `${base64Encode(directory)}/*`
}

function accepted(autoAccept: Record<string, boolean>, sessionID: string, directory?: string) {
  const key = acceptKey(sessionID, directory)
  return autoAccept[key] ?? autoAccept[sessionID]
}

export function isDirectoryAutoAccepting(autoAccept: Record<string, boolean>, directory: string) {
  const key = directoryAcceptKey(directory)
  return autoAccept[key] ?? false
}

function sessionLineage(session: { id: string; parentID?: string }[], sessionID: string) {
  const parent = session.reduce((acc, item) => {
    if (item.parentID) acc.set(item.id, item.parentID)
    return acc
  }, new Map<string, string>())
  const seen = new Set([sessionID])
  const ids = [sessionID]

  for (const id of ids) {
    const parentID = parent.get(id)
    if (!parentID || seen.has(parentID)) continue
    seen.add(parentID)
    ids.push(parentID)
  }

  return ids
}

/**
 * 自动放行的总闸(#668)。
 *
 * `permissions.autoApprove` 在此之前是一个**死开关** —— 全仓只有定义、settings UI 绑定、main
 * 侧透传三处引用,切换不改变任何行为。它叫"自动批准权限"并默认关闭,于是用户会以为自己关掉了
 * 某种自动放行;而真正活着的自动应答器(`context/permission.tsx`)照旧会在 `permission.asked`
 * 上以 `"once"` 批准 —— 而且 alpha 已经删掉了 v1 的审批呈现面,所以那是**零 UI 放行**。
 *
 * owner 2026-07-28 裁决"要么接线要么删",此处选择接线,形态是**单向 kill switch**:
 *   - 关(默认)⇒ 无论 autoAccept 里写了什么、会话谱系与目录怎么配,一律不自动放行;
 *   - 开       ⇒ 保持上游既有语义,一字未改。
 * 它**不新增**任何自动放行能力(那正是 owner 否决候选 D 的理由),只是把唯一存在的那条自动
 * 放行路径交到用户手上,并让开关的名字变成真的。
 *
 * `options` 刻意**必填**:新增调用点忘了传 = 类型错误,而不是悄悄绕过总闸。
 */
export type AutoRespondOptions = { autoApprove: boolean }

export function autoRespondsPermission(
  autoAccept: Record<string, boolean>,
  session: { id: string; parentID?: string }[],
  permission: { sessionID: string },
  directory: string | undefined,
  options: AutoRespondOptions,
) {
  if (!options.autoApprove) return false
  const value = sessionAutoAccept(autoAccept, session, permission, directory, options)
  if (value !== undefined) return value
  return directory ? isDirectoryAutoAccepting(autoAccept, directory) : false
}

export function sessionAutoAccept(
  autoAccept: Record<string, boolean>,
  session: { id: string; parentID?: string }[],
  permission: { sessionID: string },
  directory: string | undefined,
  options: AutoRespondOptions,
) {
  // 显式 false(而不是 undefined):调用方把"未配置"当作"继续往下查",总闸关闭时必须是一个
  // 确定的"不放行",不能让它落回目录级 fallback。
  if (!options.autoApprove) return false
  return sessionLineage(session, permission.sessionID)
    .map((id) => accepted(autoAccept, id, directory))
    .find((item): item is boolean => item !== undefined)
}
