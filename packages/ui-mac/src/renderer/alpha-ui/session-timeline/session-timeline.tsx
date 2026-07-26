// REQ-125 C5/C6/#568 — 数据绑定层:SDK typed 通道 → 行模型 → 视图。
//
// 只消费公开 typed hooks(useServerSync;I1 白名单),不触碰上游 session 叶/DOM。
// I8:一切读取以 live context 的 serverKey+directory+sessionID 三元组为键——store 本身按
// sessionID 分片,行投影只读当前三元组对应的分片;历史翻页的滚动补偿在视图侧以 epoch
// (三元组合成键)拒绝滞后结果。
// intents:openSession(子任务卡跳子会话)用 route-manifest 构 href 后导航——导航即换
// epoch,天然满足 I8;focusArtifact/openFile 接 C4 SessionRailApi(#568 真接线),rail
// 缺席时两者 undefined → 行/pill 降级纯展示(fail-closed)。rail api 内部以 live 身份
// 铸造 target 并在会话切换时作废(I8 归 shell)。
// continueTurn(中断态续钮)接 composer 同一条会话发送入口(v2 durable 输入队列
// session.prompt),不另建通道;写入面因此需要 typed SDK 客户端(useServerSDK)。
import { useServerSDK, useServerSync } from "@opencode-ai/app"
import { useNavigate } from "@solidjs/router"
import { createEffect, createMemo, on } from "solid-js"
import { hrefFor } from "../../../shared/route-manifest"
import { t } from "../../i18n"
import { useAlphaSessionLiveContext } from "../session-workspace/alpha-session-workspace"
import type { SessionRailApi } from "../session-workspace/session-workspace-shell"
import type { TimelineIntents } from "./cards/timeline-intents"
import { SessionTimelineView } from "./session-timeline-view"
import {
  projectTimelineRows,
  reuseTimelineRows,
  reviewPathOf,
  type SessionSlashOriginsFor,
  type TimelineRow,
} from "./timeline-model"

export interface AlphaSessionTimelineProps {
  /** C4 右栏联动 api(#568 接线);缺席 = pill/媒体/产物行降级纯展示。 */
  rail?: Pick<SessionRailApi, "jumpToReview" | "focusArtifact">
  /** #545 C7 的斜杠命令来源供给;缺席 = chip 零渲染(fail-closed)。 */
  slashOriginsFor?: SessionSlashOriginsFor
}

export function AlphaSessionTimeline(props: AlphaSessionTimelineProps = {}) {
  const live = useAlphaSessionLiveContext()
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()

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
  // 斜杠命令来源(C7 可选供给):供给方异常不拖垮时间线(fail-closed → 无 chip)。
  const slashOrigins = createMemo(() => {
    const provider = props.slashOriginsFor
    const identity = live.current()?.identity
    if (!provider || !identity) return undefined
    try {
      return provider(identity)
    } catch {
      return undefined
    }
  })
  const rows = createMemo<TimelineRow[]>((previous) => {
    const id = sessionID()
    if (!id) return []
    const data = session().data
    const status = data.session_status[id]
    return reuseTimelineRows(
      previous,
      projectTimelineRows({
        messages: data.message[id] ?? [],
        partsOf: (messageID) => data.part[messageID] ?? [],
        status: status?.type ?? "idle",
        retry:
          status?.type === "retry"
            ? { attempt: status.attempt, message: typeof status.message === "string" ? status.message : "" }
            : undefined,
        slashOrigins: slashOrigins(),
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

  const navigate = useNavigate()
  const intents: TimelineIntents = {
    // 子任务卡「打开子会话」:route-manifest 构 href 失败即放弃(fail-closed,不裸拼路径)。
    openSession: (childSessionID) => {
      const identity = live.current()?.identity
      if (!identity || !childSessionID) return
      try {
        navigate(hrefFor.session(identity.serverKey, childSessionID))
      } catch {
        // 非法参数 → 不导航。
      }
    },
    // 媒体/产物行 → 右栏产物面板。id 货币 = 产物名(manifest artifact id 的名字级
    // 回落);对不上时面板打开但不改选中(artifacts-core 的 fail-closed 合同)。
    get focusArtifact() {
      const rail = props.rail
      if (!rail) return undefined
      return (intent: { name: string }) => rail.focusArtifact(intent.name)
    },
    // write/edit pill 与 diffsum 行 → 右栏审查面板的文件卡。路径必须先被证明为
    // 安全 workspace-relative(reviewPathOf,审计 Major-2):证明不了 → 零动作,
    // 不打面板、不递路径。未知但合法的文件由 review 面板静默不聚焦。
    get openFile() {
      const rail = props.rail
      if (!rail) return undefined
      return (intent: { path: string }) => {
        const identity = live.current()?.identity
        if (!identity) return
        const relative = reviewPathOf(intent.path, identity.directory)
        if (relative === undefined) return
        rail.jumpToReview(relative)
      }
    },
    // 中断态「继续生成」:走 composer 同一条 v2 durable 发送入口。会话不空闲(还在跑/重试)
    // 时零动作 —— 续写只对已经停下的回合成立,不往在跑的回合里塞输入(fail-closed)。
    continueTurn: () => {
      const id = sessionID()
      if (!id) return
      if ((session().data.session_status[id]?.type ?? "idle") !== "idle") return
      try {
        void serverSDK()
          .client.v2.session.prompt({ sessionID: id, prompt: { text: t("alpha.timeline.continuePrompt") } })
          .catch(() => {
            // 发送失败(网络/引擎拒绝)→ 静默;会话状态仍由 typed 通道如实呈现。
          })
      } catch {
        // SDK 客户端不可得(服务端未就绪)→ 零动作。
      }
    },
  }

  return (
    <SessionTimelineView
      rows={rows()}
      ready={ready()}
      epoch={epoch()}
      emptyTitle={live.current()?.title ?? t("alpha.session.session")}
      history={history()}
      onLoadOlder={loadOlder}
      intents={intents}
    />
  )
}
