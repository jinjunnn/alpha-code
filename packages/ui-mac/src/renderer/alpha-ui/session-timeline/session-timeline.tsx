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
import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js"
import { hrefFor } from "../../../shared/route-manifest"
import { t } from "../../i18n"
import { setSettingsOpen } from "../settings-state"
import { useAlphaSessionLiveContext } from "../session-workspace/alpha-session-workspace"
import type { SessionRailApi } from "../session-workspace/session-workspace-shell"
import type { StagedAttachmentMeta } from "../../../shared/attachment-path"
import { bindFocusArtifact, type TimelineEditUserMessageIntent, type TimelineIntents } from "./cards/timeline-intents"
import { SessionTimelineView, type TimelineDisplayNames } from "./session-timeline-view"
import {
  projectTimelineRows,
  reuseTimelineRows,
  reviewPathOf,
  type SessionSlashOriginsFor,
  type TimelineRow,
  type TimelineTurnWait,
} from "./timeline-model"

export interface AlphaSessionTimelineProps {
  /** C4 右栏联动 api(#568 接线);缺席 = pill/媒体/产物行降级纯展示。 */
  rail?: Pick<SessionRailApi, "jumpToReview" | "focusArtifact" | "openFileViewer">
  /** #545 C7 的斜杠命令来源供给;缺席 = chip 零渲染(fail-closed)。 */
  slashOriginsFor?: SessionSlashOriginsFor
  /** 用户消息编辑重发接线；缺席时按钮零渲染。 */
  onEditUserMessage?: (intent: TimelineEditUserMessageIntent) => void | Promise<void>
  /**
   * `#1399`:活跃回合在等你(审批 / 提问)—— dock 的挂起投影经 workspace 的 signal 供给;
   * 缺席 = 回合脚行只有运行面(fail-closed)。审批卡本身仍不进时间线(2026-07-26 裁决)。
   */
  turnWait?: Accessor<TimelineTurnWait | undefined>
  /** `#1318` AC3:把焦点放回会话输入框(workspace 焦点通道);缺席 = 空回合行只陈述事实。 */
  onFocusPrompt?: () => void
  /** REQ-236 `#1553` AC4:附件卡「重新读取」—— 在输入框里以同一个暂存附件预填读取请求;缺席 = 不出按钮。 */
  onReadAttachment?: (attachment: StagedAttachmentMeta) => void
  /** `#1588` AC3:回合错误卡「新对话」—— 侧栏「新对话」同一条命令;缺席 = 不出按钮。 */
  onNewSession?: () => void
  /** `#1588` AC1 读取期限(测试注入用;缺省 READ_DEADLINE_MS)。 */
  readDeadlineMs?: number
}

/** `#1588` AC1:消息页未就绪超过这么久才显示「正在读取对话…」(快的读取不闪一下)。 */
const READ_SLOW_MS = 300
/** `#1588` AC1:读取期限。读取请求本身没有期限(Q2:会一直挂着),到期仍未就绪即判失败。 */
const READ_DEADLINE_MS = 20_000

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

  const session = () => serverSync().session
  const ready = createMemo(() => {
    const id = sessionID()
    if (!id) return false
    return session().data.message[id] !== undefined
  })

  // `#1588` AC1:读取的三态 —— 刚发出(什么都不显示)/ 超过 READ_SLOW_MS 仍未就绪(读取行)/ 被拒或到期限仍未就绪(失败行)。
  // 「重试」带 restart:同一会话的读取在 store 里按 sessionID 复用挂着的 promise,不带它重试就只是再等那一个。
  const [read, setRead] = createSignal<"pending" | "slow" | "failed">("pending")
  let readAttempt = 0
  let readTimers: ReturnType<typeof setTimeout>[] = []
  const clearReadTimers = () => {
    readTimers.forEach(clearTimeout)
    readTimers = []
  }
  const startRead = (restart: boolean) => {
    clearReadTimers()
    setRead("pending")
    const id = sessionID()
    if (!id) return
    const attempt = ++readAttempt
    const current = () => attempt === readAttempt
    const fail = () => {
      if (current() && !ready()) setRead("failed")
    }
    readTimers = [
      setTimeout(() => current() && !ready() && setRead((phase) => (phase === "pending" ? "slow" : phase)), READ_SLOW_MS),
      setTimeout(fail, props.readDeadlineMs ?? READ_DEADLINE_MS),
    ]
    void serverSync()
      .session.sync(id, restart ? { restart: true } : undefined)
      .then(() => current() && clearReadTimers(), fail)
  }

  const readShown = () => {
    const phase = read()
    return phase === "pending" ? undefined : phase
  }

  // 进入/切换会话:拉起该会话的消息页(store 幂等;retry 由通道内部承担)。换代即作废上一代的计时与结果。
  createEffect(
    on(epoch, () => {
      startRead(false)
      onCleanup(() => {
        readAttempt += 1
        clearReadTimers()
      })
    }),
  )
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
        // REQ-236 `#1553`:附件读取结果的输入 —— 会话目录 + 本机读取工具的逐服务状态(引擎 mcp.status,事件驱动刷新)。
        // getter:只有真有暂存附件的消息才会读它,其余会话不为此拉起 MCP 状态查询。
        attachments: {
          directory: live.current()?.identity.directory,
          get services() {
            const directory = live.current()?.identity.directory
            if (!directory) return undefined
            // 状态还没取到(mcp_ready 假)时 `mcp` 是空表 —— 那不是「没装」,不下结论。
            const [store] = serverSync().child(directory, { mcp: true })
            return store.mcp_ready ? store.mcp : undefined
          },
        },
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
    // `#1588` AC5:第一方模式由视图映射成档名;其余(用户自建的助手)照写原名。
    agent: (agent) => agent,
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
    // descriptor 保留 run + id;无 descriptor 的内联图片直接送既有文件查看器。
    get focusArtifact() {
      const rail = props.rail
      if (!rail) return undefined
      return bindFocusArtifact(
        (artifactId, runId) => rail.focusArtifact(artifactId, runId),
        (media) => {
          if (media.url.startsWith("data:")) {
            if (media.mime.startsWith("image/")) rail.openFileViewer(media)
            return
          }
          const identity = live.current()?.identity
          if (!identity) return
          const relative = reviewPathOf(media.url, identity.directory)
          if (relative !== undefined) rail.openFileViewer(relative)
        },
      )
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
    get readAttachment() {
      return props.onReadAttachment
    },
    // `#1588` AC3:回合错误卡的出路,各接一个既有入口(生图卡同一个充值页 / 登录 / 设置 / 侧栏新对话命令)。
    recharge: () => void window.api.cloud.openBillingPage("recharge"),
    signIn: () => void window.api.auth.start(),
    openSettings: () => setSettingsOpen(true),
    get newSession() {
      return props.onNewSession
    },
    // REQ-236 `#1552`:生图卡跟住的 run 所在目录 = 会话身份的 directory(右栏产物面板同一货币)。
    get cloudDirectory() {
      return live.current()?.identity.directory
    },
    // 空回合行「修改后再试」:只把焦点交回 composer,不代发任何东西(`#1318` AC3)。
    get focusPrompt() {
      return props.onFocusPrompt
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
      read={readShown()}
      onRetryRead={() => startRead(true)}
      epoch={epoch()}
      emptyTitle={live.current()?.title || t("alpha.session.session")}
      history={history()}
      onLoadOlder={loadOlder}
      intents={intents}
      displayNames={displayNames}
      turnWait={props.turnWait?.()}
    />
  )
}
