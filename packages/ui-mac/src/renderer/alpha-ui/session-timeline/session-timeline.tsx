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
// continueTurn(中断态续钮)接 composer 同一条会话发送入口(#652 起 = v1
// session.promptAsync),不另建通道;写入面因此需要 typed SDK 客户端(useServerSDK)。
import { useServerSDK, useServerSync } from "@opencode-ai/app"
import { useNavigate } from "@solidjs/router"
import { createEffect, createMemo, on } from "solid-js"
import { hrefFor } from "../../../shared/route-manifest"
import { t } from "../../i18n"
import { useAlphaSessionLiveContext } from "../session-workspace/alpha-session-workspace"
import type { SessionRailApi } from "../session-workspace/session-workspace-shell"
import type { TimelineEditUserMessageIntent, TimelineIntents } from "./cards/timeline-intents"
import { SessionTimelineView, type TimelineDisplayNames } from "./session-timeline-view"
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
  /** 用户消息编辑重发接线；缺席时按钮零渲染。 */
  onEditUserMessage?: (intent: TimelineEditUserMessageIntent) => void | Promise<void>
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
  const displayNames: TimelineDisplayNames = {
    // 与上游会话消息脚注一致:agent 没有独立目录显示名,只把首字母转为可读形式。
    agent: (agent) => agent.slice(0, 1).toUpperCase() + agent.slice(1),
    model: (providerID, modelID) => serverSync().data.provider.all.get(providerID)?.models?.[modelID]?.name ?? modelID,
  }
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
    get editUserMessage() {
      return props.onEditUserMessage
    },
    // 中断态「继续生成」:走 composer 同一条发送入口。#652 起那条入口是 v1 session.promptAsync
    // (与首页 startChat 同一条),不再是 v2 durable 队列 —— 理由见 alpha-composer 的送出段。
    // 会话不空闲(还在跑/重试)时零动作 —— 续写只对已经停下的回合成立,不往在跑的回合里塞输入
    // (fail-closed)。
    // 发送失败(SDK 不可得/网络断开/admission 前被拒)不产生任何 session_status 事件,
    // typed 通道呈现不了 —— rejection 原样交给视图,由中断行就地给出失败提示,不静默
    // 吞掉(审计 R1 Major;async 函数把同步抛错一并折算成 rejection)。v1 SDK 把 HTTP 失败
    // 装进 `{ error }` 信封而不是 reject,所以信封必须显式翻译成 rejection —— 否则「引擎拒了」
    // 会被当成成功,又是一次静默。
    // #620:续写的输入是**系统替用户按下的**,不是用户说的话 —— 用 v1 wire 契约本来就有的
    // `synthetic`(schema/src/v1/session.ts 的 TextPartInput)标记它:引擎落库原样带着
    // (opencode/src/session/prompt.ts 的默认分支 `{ ...part }`)、组模型消息时照样发给模型
    // (message-v2.ts 只过滤 `ignored`),而 alpha 的行投影按 `!part.synthetic` 取正文,
    // 于是时间线里不再多出一条用户自己「说」的「继续」。上游自动压缩后的续写用的就是这条
    // (opencode/src/session/compaction.ts)。typed 客户端的 TextPartInput 已含该字段,
    // 因此这里不需要 `as never`。
    continueTurn: async () => {
      const id = sessionID()
      if (!id) return
      if ((session().data.session_status[id]?.type ?? "idle") !== "idle") return
      const result = await serverSDK().client.session.promptAsync({
        sessionID: id,
        parts: [{ type: "text", text: t("alpha.timeline.continuePrompt"), synthetic: true }],
      })
      if ((result as { error?: unknown } | undefined)?.error !== undefined)
        throw new Error("continue turn was rejected by the engine")
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
      displayNames={displayNames}
    />
  )
}
