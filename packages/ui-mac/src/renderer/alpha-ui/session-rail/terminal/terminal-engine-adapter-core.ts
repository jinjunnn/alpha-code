// REQ-125 #554 —— 终端引擎 channel 适配器的纯投影半场(零上游 import,可直测)。
//
// 引擎 import(`@opencode-ai/app/surface/terminal`,ADR-027 修订 2026-07-24 的窄导出)
// 只允许出现在 `terminal-engine-adapter.tsx`(I1 白名单通道,静态断言钉死唯一消费点);
// 本文件只做形状收敛:把引擎最小面 + 会话三元身份铸成 `AlphaTerminalEngineChannel`。
//
// I8:身份在铸造时盖死(serverKey+directory+sessionID),消费侧经 `live.accepts` 校验
// (`acceptedEngineChannel`);引擎或身份任一缺席 → undefined,面板 fail-closed 空态。
import type { Component } from "solid-js"
import { sameSessionIdentity, type AlphaSessionIdentity } from "../../session-workspace/session-workspace-core"
import type { AlphaTerminalEngineChannel, AlphaTerminalFootStatus } from "./terminal-rail-core"

/** 引擎侧 PTY 记录的最小结构投影(上游 LocalPTY 的窄子集;多余字段结构兼容即忽略)。 */
export interface TerminalEnginePTY {
  id: string
  title: string
  titleNumber: number
  cols?: number
  rows?: number
}

/** 适配器消费的引擎最小面(useTerminal() 返回值的窄结构投影;真引擎在适配器文件绑定)。 */
export interface TerminalEngineSurface {
  ready(): boolean
  all(): TerminalEnginePTY[]
  active(): string | undefined
  open(id: string): void
  close(id: string): Promise<void>
  // 引号避免被解析成构造签名:这是上游 useTerminal() 返回值上名为 `new` 的方法。
  "new"(options?: { focus?: boolean }): void
  requestFocus(id?: string): void
  cancelFocus(): void
}

/** 已绑定引擎输出组件的引擎句柄(适配器文件铸造;引擎缺席时整个句柄缺席)。 */
export interface TerminalEngineHandle {
  surface: TerminalEngineSurface
  EngineOutput: Component<{ instanceID: string }>
}

export interface TerminalTabLabels {
  numbered(number: number): string
  untitled: string
}

/**
 * 页签标题:引擎标题优先(不改写引擎数据,即便它是上游英文默认名);空标题回落编号
 * 标签,连编号都没有才回落通用标签 —— 不伪造引擎没有的信息。
 */
export function terminalInstanceTitle(
  pty: Pick<TerminalEnginePTY, "title" | "titleNumber">,
  labels: TerminalTabLabels,
): string {
  const title = pty.title.trim()
  if (title) return title
  if (Number.isSafeInteger(pty.titleNumber) && pty.titleNumber > 0) return labels.numbered(pty.titleNumber)
  return labels.untitled
}

/**
 * 脚条投影(与 instances 同一存活语义):上游生命周期真相是 `pty.exited` 事件即从
 * store 移除 —— 在列 = 存活;引擎不暴露更细的任务级活动信号。诚实映射:存活即
 * running,实例缺席 = false;尺寸透传持久 cols×rows,任一维缺失即整段省略。
 * 环境(shell)段本票不投影:真值是服务端 `Pty.Info.command`/`cwd`,而客户端 `LocalPTY`
 * 只同步 title、丢弃 command/cwd —— 需客户端窄改经 patch 通道供给,已拆独立票(见 #576
 * 评论)。今日缺数据,故不伪造环境段。
 */
export function terminalFootStatus(pty: TerminalEnginePTY | undefined): AlphaTerminalFootStatus {
  return { running: pty !== undefined, cols: pty?.cols, rows: pty?.rows }
}

/**
 * 铸造引擎 channel:I8 三元身份铸造时盖章。引擎句柄或身份任一缺席 → undefined
 * (面板 fail-closed 空态);身份变更必须重铸,旧投影被 `acceptedEngineChannel` 拒收。
 */
export function mintTerminalEngineChannel(input: {
  engine: TerminalEngineHandle | undefined
  identity: AlphaSessionIdentity | undefined
  labels: TerminalTabLabels
}): AlphaTerminalEngineChannel | undefined {
  const handle = input.engine
  const identity = input.identity
  if (!handle || !identity) return undefined
  const engine = handle.surface
  return {
    identity,
    ready: () => engine.ready(),
    instances: () =>
      engine.all().map((pty) => ({
        id: pty.id,
        title: terminalInstanceTitle(pty, input.labels),
        // 上游生命周期真相(勘破 2026-07-24):`pty.exited` 事件即把 PTY 从 store 移除,
        // 在列 = 存活;引擎不暴露更细的任务级活动信号。诚实映射 = 存活即 running
        // (呼吸点语义:有存活终端;exited → 移除 → 灭),不硬编码 false 伪造空闲。
        running: true,
      })),
    activeID: () => engine.active(),
    // 对齐上游页签点击语义(session-sortable-terminal-tab-v2):先发聚焦请求再切激活,
    // 请求在 keyed 引擎输出重挂前就位,上游 Terminal 挂载时一次性消费(autoFocus)。
    open: (id) => {
      engine.requestFocus(id)
      engine.open(id)
    },
    close: (id) => void engine.close(id),
    // 对齐上游 terminal-panel 新建按钮语义:创建即请求聚焦新终端。
    create: () => engine.new({ focus: true }),
    requestFocus: (id) => engine.requestFocus(id),
    cancelFocus: () => engine.cancelFocus(),
    footStatus: (id) => terminalFootStatus(engine.all().find((pty) => pty.id === id)),
    EngineOutput: handle.EngineOutput,
  }
}

/**
 * 身份 memo 的 equals:两侧同缺席或三元组全等 → 视为未变,不重铸 channel。
 * 面板对 channel 是 keyed 消费(重铸 = 引擎输出重挂/重连),快照级抖动(标题、
 * running 状态)不得触发重铸;只有真实身份切换才重挂。
 */
export function sameIdentityProjection(
  left: AlphaSessionIdentity | undefined,
  right: AlphaSessionIdentity | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right
  return sameSessionIdentity(left, right)
}
