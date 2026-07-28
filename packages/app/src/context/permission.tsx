import { createEffect, createMemo, createRoot, getOwner, onCleanup } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import type { PermissionRequest } from "@opencode-ai/sdk/v2/client"
import { Persist, persisted } from "@/utils/persist"
import type { ServerSDK } from "@/context/server-sdk"
import type { ServerSync } from "./server-sync"
import { useParams, useSearchParams } from "@solidjs/router"
import { decode64 } from "@/utils/base64"
import { useGlobal } from "./global"
import { ServerConnection, useServer } from "./server"
import { type DraftTab, useTabs } from "./tabs"
import { useSettings } from "./settings"
import { requireServerKey } from "@/utils/session-route"
import type { ServerScope } from "@/utils/server-scope"
import {
  acceptKey,
  directoryAcceptKey,
  isDirectoryAutoAccepting,
  autoRespondsPermission,
  sessionAutoAccept,
} from "./permission-auto-respond"

type PermissionRespondFn = (input: {
  sessionID: string
  permissionID: string
  response: "once" | "always" | "reject"
  directory?: string
}) => void

function isNonAllowRule(rule: unknown) {
  if (!rule) return false
  if (typeof rule === "string") return rule !== "allow"
  if (typeof rule !== "object") return false
  if (Array.isArray(rule)) return false

  for (const action of Object.values(rule)) {
    if (action !== "allow") return true
  }

  return false
}

function hasPermissionPromptRules(permission: unknown) {
  if (!permission) return false
  if (typeof permission === "string") return permission !== "allow"
  if (typeof permission !== "object") return false
  if (Array.isArray(permission)) return false

  const config = permission as Record<string, unknown>
  return Object.values(config).some(isNonAllowRule)
}

export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  gate: false,
  init: () => {
    const params = useParams<{ serverKey?: string; dir?: string; id?: string }>()
    const [search] = useSearchParams<{ draftId?: string }>()
    const global = useGlobal()
    const server = useServer()
    const tabs = useTabs()
    const settings = useSettings()
    const owner = getOwner()
    const states = new Map<ServerScope, { key: ServerConnection.Key; dispose: () => void; state: PermissionState }>()

    const activeDraft = createMemo(() => {
      if (!search.draftId) return
      return tabs.store.find((tab): tab is DraftTab => tab.type === "draft" && tab.draftID === search.draftId)
    })

    const activeServer = createMemo(() => {
      if (params.serverKey && settings.general.newLayoutDesigns()) return requireServerKey(params.serverKey)
      return activeDraft()?.server ?? server.key
    })

    const ensure = (key: ServerConnection.Key) => {
      const conn = global.servers.list().find((item) => ServerConnection.key(item) === key)
      if (!conn) throw new Error(`Permission server not found: ${key}`)
      const ctx = global.ensureServerCtx(conn)
      const existing = states.get(ctx.sdk.scope)
      if (existing && global.servers.list().some((item) => ServerConnection.key(item) === existing.key)) {
        return existing.state
      }
      if (existing) {
        existing.dispose()
        states.delete(ctx.sdk.scope)
      }
      const root = createRoot(
        (dispose) => ({
          key,
          dispose,
          state: createServerPermissionState({ sdk: ctx.sdk, sync: ctx.sync }),
        }),
        owner ?? undefined,
      )
      states.set(ctx.sdk.scope, root)
      return root.state
    }

    createEffect(() => {
      global.servers.list().forEach((conn) => ensure(ServerConnection.key(conn)))
    })

    createEffect(() => {
      const list = global.servers.list()
      const keys = new Set(list.map(ServerConnection.key))
      states.forEach((value, scope) => {
        if (keys.has(value.key)) return
        value.dispose()
        states.delete(scope)
        const replacement = list.find((conn) => server.scope(ServerConnection.key(conn)) === scope)
        if (replacement) ensure(ServerConnection.key(replacement))
      })
    })

    onCleanup(() => states.forEach((value) => value.dispose()))

    let lastSelected: PermissionState | undefined
    const selected = () => {
      const key = activeServer()
      if (global.servers.list().some((conn) => ServerConnection.key(conn) === key)) {
        lastSelected = ensure(key)
      }
      if (lastSelected) return lastSelected
      return ensure(server.key)
    }
    const activeDirectory = createMemo(() => {
      const directory = decode64(params.dir)
      if (directory) return directory
      const draft = activeDraft()
      if (draft) return draft.directory
      if (!params.id) return
      if (!global.servers.list().some((conn) => ServerConnection.key(conn) === activeServer())) return
      return selected().sync.session.lineage.peek(params.id)?.session.directory
    })

    createEffect(() => {
      const directory = activeDirectory()
      if (!directory) return
      selected().enableConfiguredDirectory(directory)
    })

    const permissionsEnabled = createMemo(() => {
      const directory = activeDirectory()
      if (!directory) return false
      return selected().permissionsEnabled(directory)
    })

    return {
      ready: () => selected().ready(),
      ensureServerState: (key: ServerConnection.Key) => ensure(key).api,
      currentServerState: () => selected().api,
      respond(input: Parameters<PermissionRespondFn>[0]) {
        selected().respond(input)
      },
      autoResponds(permission: PermissionRequest, directory?: string) {
        return selected().autoResponds(permission, directory)
      },
      isAutoAccepting(sessionID: string, directory?: string) {
        return selected().isAutoAccepting(sessionID, directory)
      },
      isAutoAcceptingDirectory(directory: string) {
        return selected().isAutoAcceptingDirectory(directory)
      },
      toggleAutoAccept(sessionID: string, directory: string) {
        selected().toggleAutoAccept(sessionID, directory)
      },
      toggleAutoAcceptDirectory(directory: string) {
        selected().toggleAutoAcceptDirectory(directory)
      },
      enableAutoAccept(sessionID: string, directory: string) {
        selected().enableAutoAccept(sessionID, directory)
      },
      disableAutoAccept(sessionID: string, directory?: string) {
        selected().disableAutoAccept(sessionID, directory)
      },
      permissionsEnabled,
      isPermissionAllowAll(directory: string) {
        return selected().isPermissionAllowAll(directory)
      },
    }
  },
})

type PermissionState = ReturnType<typeof createServerPermissionState>
type PermissionEvent = Parameters<Parameters<ServerSDK["event"]["listen"]>[0]>[0]

function createServerPermissionState(input: { sdk: ServerSDK; sync: ServerSync }) {
  // #668:自动放行总闸的读点。本函数在 `createRoot(..., owner)` 下建立,owner 链上有
  // SettingsProvider,因此这里读得到设置。
  const settings = useSettings()
  const [store, setStore, _, ready] = persisted(
    {
      ...Persist.serverGlobal(input.sdk.scope, "permission", ["permission.v3"]),
      migrate(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return value

        const data = value as Record<string, unknown>
        if (data.autoAccept) return value

        return {
          ...data,
          autoAccept:
            typeof data.autoAcceptEdits === "object" && data.autoAcceptEdits && !Array.isArray(data.autoAcceptEdits)
              ? data.autoAcceptEdits
              : {},
        }
      },
    },
    createStore({
      autoAccept: {} as Record<string, boolean>,
    }),
  )

  function enableConfiguredDirectory(directory: string) {
    if (meta.disposed || !ready()) return
    const [childStore] = input.sync.child(directory)
    if (childStore.config.permission !== "allow") return
    const key = directoryAcceptKey(directory)
    if (store.autoAccept[key] !== undefined) return
    setStore(
      produce((draft) => {
        draft.autoAccept[key] = true
      }),
    )
  }

  const MAX_RESPONDED = 1000
  const RESPONDED_TTL_MS = 60 * 60 * 1000
  const responded = new Map<string, number>()
  const enableVersion = new Map<string, number>()
  const meta = { disposed: false }

  function pruneResponded(now: number) {
    for (const [id, ts] of responded) {
      if (now - ts < RESPONDED_TTL_MS) break
      responded.delete(id)
    }

    for (const id of responded.keys()) {
      if (responded.size <= MAX_RESPONDED) break
      responded.delete(id)
    }
  }

  const respond: PermissionRespondFn = (request) => {
    if (meta.disposed) return
    input.sdk.client.permission.respond(request).catch(() => {
      responded.delete(request.permissionID)
    })
  }

  function respondOnce(permission: PermissionRequest, directory?: string) {
    const now = Date.now()
    const hit = responded.has(permission.id)
    responded.delete(permission.id)
    responded.set(permission.id, now)
    pruneResponded(now)
    if (hit) return
    respond({
      sessionID: permission.sessionID,
      permissionID: permission.id,
      response: "once",
      directory,
    })
  }

  function sessions(directory?: string) {
    const info = Object.values(input.sync.session.data.info).filter((session) => !!session)
    if (!directory) return info
    return [...info, ...input.sync.child(directory, { bootstrap: false })[0].session]
  }

  function isAutoAccepting(sessionID: string, directory?: string) {
    return autoRespondsPermission(store.autoAccept, sessions(directory), { sessionID }, directory, autoRespondOptions())
  }

  function isAutoAcceptingDirectory(directory: string) {
    return isDirectoryAutoAccepting(store.autoAccept, directory)
  }

  function shouldAutoRespond(permission: PermissionRequest, directory?: string) {
    return autoRespondsPermission(store.autoAccept, sessions(directory), permission, directory, autoRespondOptions())
  }

  function isPending(permission: PermissionRequest) {
    const pending = input.sync.session.data.permission[permission.sessionID]
    return pending === undefined || pending.some((item) => item.id === permission.id)
  }

  async function shouldAutoRespondResolved(permission: PermissionRequest, directory?: string) {
    const override = sessionAutoAccept(store.autoAccept, sessions(directory), permission, directory, autoRespondOptions())
    if (override !== undefined) return override
    if (input.sync.session.lineage.peek(permission.sessionID)) return shouldAutoRespond(permission, directory)
    const lineage = await input.sync.session.lineage.resolve(permission.sessionID).catch(() => undefined)
    if (meta.disposed || !lineage) return false
    return shouldAutoRespond(permission, directory)
  }

  /**
   * #668:`permissions.autoApprove` 的接线点 —— 在此之前它是一个**死开关**(全仓只有定义、
   * UI 绑定、main 侧透传三处引用,切换不改变任何行为)。它显示为"自动批准权限"并默认关闭,
   * 于是用户会以为自己已经关掉了某种自动放行;而真正活着的自动应答器就是本文件 —— 它在
   * `permission.asked` 上以 `"once"` 自动批准,且 alpha 已经删掉了 v1 的审批呈现面
   * (`session-permission-dock.tsx`,由 permission-mount-ratchet 钉死),所以它一旦被 enable
   * 就是**零 UI 放行**。
   *
   * 处置(owner 2026-07-28 "要么接线要么删"):接线成**单向 kill switch**。
   * - 关(默认)= 真的没有任何自动放行,与开关名字承诺的一致;
   * - 开 = 保持上游既有语义(按目录/会话的 autoAccept 自动应答)。
   * 它**不新增**任何自动放行能力(那正是 owner 否决候选 D 的理由),只是把唯一存在的那条
   * 自动放行路径交到用户手上。
   */
  function autoApproveAllowed() {
    return settings.permissions.autoApprove()
  }

  /** 传给纯判定函数的总闸(参数必填 ⇒ 新增调用点忘了传是类型错误,不是静默绕过)。 */
  function autoRespondOptions() {
    return { autoApprove: autoApproveAllowed() }
  }

  async function respondPending(
    permission: PermissionRequest,
    directory?: string,
    current: () => boolean = () => true,
  ) {
    if (!autoApproveAllowed()) return
    if (!current() || !isPending(permission)) return
    if (!(await shouldAutoRespondResolved(permission, directory))) return
    if (meta.disposed || !current() || !isPending(permission)) return
    if (!autoApproveAllowed()) return
    respondOnce(permission, directory)
  }

  function bumpEnableVersion(sessionID: string, directory?: string) {
    const key = acceptKey(sessionID, directory)
    const next = (enableVersion.get(key) ?? 0) + 1
    enableVersion.set(key, next)
    return next
  }

  const handlePermission = (e: PermissionEvent) => {
    const event = e.details
    if (event?.type !== "permission.asked") return
    void respondPending(event.properties, e.name)
  }

  const unsubscribe = input.sdk.event.listen((event) => {
    if (ready()) {
      handlePermission(event)
      return
    }
    void ready.promise?.then(() => {
      if (meta.disposed) return
      handlePermission(event)
    })
  })
  onCleanup(() => {
    meta.disposed = true
    unsubscribe()
  })

  function enableDirectory(directory: string) {
    if (meta.disposed) return
    const key = directoryAcceptKey(directory)
    setStore(
      produce((draft) => {
        draft.autoAccept[key] = true
      }),
    )

    input.sdk.client.permission
      .list({ directory })
      .then((x) => {
        if (meta.disposed) return
        if (!isAutoAcceptingDirectory(directory)) return
        for (const perm of x.data ?? []) {
          if (!perm?.id) continue
          void respondPending(perm, directory, () => isAutoAcceptingDirectory(directory))
        }
      })
      .catch(() => undefined)
  }

  function disableDirectory(directory: string) {
    if (meta.disposed) return
    const key = directoryAcceptKey(directory)
    setStore(
      produce((draft) => {
        draft.autoAccept[key] = false
      }),
    )
  }

  function enable(sessionID: string, directory: string) {
    if (meta.disposed) return
    const key = acceptKey(sessionID, directory)
    const version = bumpEnableVersion(sessionID, directory)
    setStore(
      produce((draft) => {
        draft.autoAccept[key] = true
        delete draft.autoAccept[sessionID]
      }),
    )

    input.sdk.client.permission
      .list({ directory })
      .then((x) => {
        if (meta.disposed) return
        if (enableVersion.get(key) !== version) return
        if (!isAutoAccepting(sessionID, directory)) return
        for (const perm of x.data ?? []) {
          if (!perm?.id) continue
          void respondPending(
            perm,
            directory,
            () => enableVersion.get(key) === version && isAutoAccepting(sessionID, directory),
          )
        }
      })
      .catch(() => undefined)
  }

  function disable(sessionID: string, directory?: string) {
    if (meta.disposed) return
    bumpEnableVersion(sessionID, directory)
    const key = directory ? acceptKey(sessionID, directory) : sessionID
    setStore(
      produce((draft) => {
        draft.autoAccept[key] = false
        if (!directory) return
        delete draft.autoAccept[sessionID]
      }),
    )
  }

  const api = {
    ready: () => !meta.disposed && ready(),
    respond,
    autoResponds(permission: PermissionRequest, directory?: string) {
      if (meta.disposed) return false
      return shouldAutoRespond(permission, directory)
    },
    isAutoAccepting(sessionID: string, directory?: string) {
      if (meta.disposed) return false
      return isAutoAccepting(sessionID, directory)
    },
    isAutoAcceptingDirectory(directory: string) {
      if (meta.disposed) return false
      return isAutoAcceptingDirectory(directory)
    },
    toggleAutoAccept(sessionID: string, directory: string) {
      if (meta.disposed) return
      if (isAutoAccepting(sessionID, directory)) {
        disable(sessionID, directory)
        return
      }

      enable(sessionID, directory)
    },
    toggleAutoAcceptDirectory(directory: string) {
      if (meta.disposed) return
      if (isAutoAcceptingDirectory(directory)) {
        disableDirectory(directory)
        return
      }
      enableDirectory(directory)
    },
    enableAutoAccept(sessionID: string, directory: string) {
      if (meta.disposed) return
      if (isAutoAccepting(sessionID, directory)) return
      enable(sessionID, directory)
    },
    disableAutoAccept(sessionID: string, directory?: string) {
      if (meta.disposed) return
      disable(sessionID, directory)
    },
    isPermissionAllowAll(directory: string) {
      if (meta.disposed) return false
      const [childStore] = input.sync.child(directory)
      return childStore.config.permission === "allow"
    },
  }

  return {
    ...api,
    api,
    sync: input.sync,
    enableConfiguredDirectory,
    permissionsEnabled(directory: string) {
      if (meta.disposed) return false
      const [childStore] = input.sync.child(directory)
      return hasPermissionPromptRules(childStore.config.permission)
    },
  }
}
