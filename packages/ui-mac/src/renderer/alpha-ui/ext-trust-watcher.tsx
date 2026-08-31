// ExtTrustWatcher — REQ-060 信任门 UI 驱动端(headless AppInterface child,仿 CloudRunWatcher)。
//
// 时机:进入某项目的会话路由(/:b64dir/session/:id)首次见到该 directory → main `ext-trust-check`:
// 项目 `.code-puppy` 含可执行扩展(mcp / plugins)且未决策 → main 弹 per-project 原生确认(B16 模式)→
// 决策写 `.code-puppy/prefs.json`;granted → 本组件调 `POST /global/dispose` 使引擎实例重建,
// @alpha-code/ext 信任门重读 consent,项目扩展当前会话下一条消息即生效(免重启,
// 链路真机证据 audits/2026-07-07-req060-fanout-realmachine)。
//
// 去重:per-renderer 生命周期一个 directory 只查一次(main 侧有决策落盘,重复查也幂等;去重只省 IPC)。

import { createEffect, type Accessor } from "solid-js"
import { useLocation } from "@solidjs/router"
// CLIENT subpath only — the v2 barrel pulls Node-only deps that break the renderer (see ADR-008).
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { parseRoute } from "../../shared/route-manifest"
import type { ServerInfo } from "../sidebar/use-projects"
import { pushToast } from "./Toast"
import { t } from "../i18n"
import { extIpc } from "../extensions/ext-ipc"

function authHeaders(info: ServerInfo): Record<string, string> | undefined {
  if (!info.username && !info.password) return undefined
  return { Authorization: `Basic ${btoa(`${info.username ?? ""}:${info.password ?? ""}`)}` }
}

function routeDirectory(pathname: string): string | null {
  // 只认带 id 的会话路由(旧正则要求 "/session/" 后有内容;/:dir/session 无 id 的 draft 页不触发)。
  const r = parseRoute(pathname)
  return r.kind === "session" && r.id && r.directory ? r.directory : null
}

export function ExtTrustWatcher(props: { server: Accessor<ServerInfo | undefined> }) {
  const loc = useLocation()
  const checked = new Set<string>()

  createEffect(() => {
    const dir = routeDirectory(loc.pathname)
    const info = props.server()
    if (!dir || !info || checked.has(dir)) return
    checked.add(dir)
    void (async () => {
      try {
        const r = await extIpc.trustCheck(dir)
        if (r.persistError) {
          pushToast({ kind: "error", title: t("alpha.ext.trustPersistFailed"), detail: r.persistError })
          checked.delete(dir) // 未留痕 = 未决,允许本会话稍后重试
          return
        }
        if (r.prompted && r.granted) {
          // dispose → 实例惰性重建 → ext 信任门重读 consent → 项目扩展下一条消息可用
          const c = createOpencodeClient({ baseUrl: info.baseUrl, headers: authHeaders(info) })
          await (c as unknown as { global: { dispose(): Promise<unknown> } }).global.dispose().catch(() => {})
          pushToast({ kind: "success", title: t("alpha.ext.trustGranted") })
        }
        // REQ-063:外部生态导入门(.claude/.agents skills + CLAUDE.md)——信任门之后串行,
        // 避免两个原生对话框叠弹;导入成功同走 dispose 免重启链。
        const ext = await extIpc.externalCheck(dir)
        if (ext.persistError) pushToast({ kind: "error", title: t("alpha.ext.trustPersistFailed"), detail: ext.persistError })
        if (ext.prompted && ext.imported) {
          const c = createOpencodeClient({ baseUrl: info.baseUrl, headers: authHeaders(info) })
          await (c as unknown as { global: { dispose(): Promise<unknown> } }).global.dispose().catch(() => {})
          pushToast({
            kind: "success",
            title: t("alpha.ext.externalImported"),
            detail: ext.importedSkills.length ? ext.importedSkills.map((s) => `/${s}`).join(" · ") : undefined,
          })
          if (ext.claudeMd === "agents-md-exists") pushToast({ kind: "error", title: t("alpha.ext.externalClaudeMdConflict") })
          for (const s of ext.skipped) pushToast({ kind: "error", title: t("alpha.ext.externalSkipped"), detail: `${s.name}: ${s.reason}` })
        }
      } catch {
        checked.delete(dir) // IPC 瞬时失败允许重查
      }
    })()
  })

  return null
}
