// REQ-125 C5 — 数据绑定层:SDK typed 通道 → 行模型 → 视图。
//
// 只消费公开 typed hooks(useServerSync;I1 白名单),不触碰上游 session 叶/DOM。
// I8:一切读取以 live context 的 serverKey+directory+sessionID 三元组为键——store 本身按
// sessionID 分片,行投影只读当前三元组对应的分片;历史翻页的滚动补偿在视图侧以 epoch
// (三元组合成键)拒绝滞后结果。
import { useServerSync } from "@opencode-ai/app"
import { createEffect, createMemo, on } from "solid-js"
import { t } from "../../i18n"
import { useAlphaSessionLiveContext } from "../session-workspace/alpha-session-workspace"
import { SessionTimelineView } from "./session-timeline-view"
import { projectTimelineRows, reuseTimelineRows, type TimelineRow } from "./timeline-model"

export function AlphaSessionTimeline() {
  const live = useAlphaSessionLiveContext()
  const serverSync = useServerSync()

  const epoch = createMemo(() => {
    const identity = live.current()?.identity
    if (!identity) return ""
    return `${identity.serverKey} ${identity.directory} ${identity.sessionID}`
  })
  const sessionID = () => live.current()?.identity.sessionID

  // 进入/切换会话:拉起该会话的消息页(store 幂等;retry 由通道内部承担)。
  createEffect(
    on(epoch, () => {
      const id = sessionID()
      if (!id) return
      void serverSync()
        .session.sync(id)
        .catch(() => {})
    }),
  )

  const session = () => serverSync().session
  const ready = createMemo(() => {
    const id = sessionID()
    if (!id) return false
    return session().data.message[id] !== undefined
  })
  const rows = createMemo<TimelineRow[]>((previous) => {
    const id = sessionID()
    if (!id) return []
    const data = session().data
    return reuseTimelineRows(
      previous,
      projectTimelineRows({
        messages: data.message[id] ?? [],
        partsOf: (messageID) => data.part[messageID] ?? [],
        status: data.session_status[id]?.type ?? "idle",
      }),
    )
  })
  const history = () => {
    const id = sessionID()
    if (!id) return { more: false, loading: false }
    return { more: session().history.more(id), loading: session().history.loading(id) }
  }

  const loadOlder = async () => {
    const id = sessionID()
    const startedEpoch = epoch()
    if (!id || !startedEpoch) return
    await session().history.loadMore(id)
    // I8:切换会话后的滞后完成不再驱动任何 UI 副作用(视图侧同样以 epoch 拒绝补偿)。
    if (epoch() !== startedEpoch) return
  }

  return (
    <SessionTimelineView
      rows={rows()}
      ready={ready()}
      epoch={epoch()}
      emptyTitle={live.current()?.title ?? t("alpha.session.session")}
      history={history()}
      onLoadOlder={loadOlder}
    />
  )
}
