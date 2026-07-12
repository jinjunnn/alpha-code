// REQ-087 spike 探针核心(纯逻辑,bun:test 可测)。DOM 采样在 session-spike-host.tsx,
// 这里只做计数口径与判定,用于验收:
//   AC3 单挂载:同一时刻可见 session composer ≤1、terminal panel ===1(session 路由上);
//   AC4 不累积:快速切换 session/往返路由后,命令注册数与 panel 数不随切换次数线性增长。
//
// 口径说明(与上游冻结 DOM 锚点对齐,见 req087-characterization.test.ts):
//   - composer:`[data-component=session-composer]`(app/src/components/prompt-input.tsx:1517)。
//     keep-alive 的隐藏 timeline 各有一个 composer(composer-takeover.tsx 已实证),故 total
//     可以 >1,但「可见」的必须 ≤1 —— 这才是双挂载信号。
//   - terminal panel:`#terminal-panel`(app/src/pages/session/terminal-panel.tsx:198)。session
//     页每次挂载恰好一个;>1 = 双挂载。
//   - 命令:useCommand().options(@opencode-ai/app 公开导出)。上游按 key 注册
//     (context/command.tsx register("session"/"layout")),remount 是替换不是追加 —— 探针在
//     运行时证实这一点。

export interface SpikeSample {
  at: number
  pathname: string
  sessionID?: string
  /** DOM 中全部 session composer(含 keep-alive 隐藏者)。 */
  composersTotal: number
  /** offsetParent 可见的 session composer。 */
  composersVisible: number
  /** `#terminal-panel` 元素数。 */
  terminalPanels: number
  /** `[data-component=session-prompt-dock]` 元素数(composer dock 容器)。 */
  promptDocks: number
  /** 注册命令总数(command.options)。 */
  commandOptions: number
  /** session 作用域命令数(下方前缀口径)。 */
  sessionScopedCommands: number
}

/** use-session-commands.tsx 各分类的命令 id 前缀(register("session") 注册面)。 */
export const SESSION_SCOPED_COMMAND_PREFIXES = [
  "session.",
  "terminal.",
  "message.",
  "file.",
  "tab.",
  "context.",
  "review.",
  "input.",
  "fileTree.",
  "model.",
  "mcp.",
  "agent.",
  "permissions.",
] as const

export function countSessionScopedCommands(ids: readonly string[]): number {
  return ids.filter((id) => SESSION_SCOPED_COMMAND_PREFIXES.some((p) => id.startsWith(p))).length
}

/** AC3 单挂载判定(仅对 session 路由的采样有意义)。 */
export function isSingleMount(sample: Pick<SpikeSample, "composersVisible" | "terminalPanels">): boolean {
  return sample.composersVisible <= 1 && sample.terminalPanels === 1
}

/**
 * AC4 线性累积判定:序列单调不减、样本 ≥ minSamples 且净增长超过 jitter 视为累积。
 * jitter 容忍合法波动(如 share/closableTab 命令按会话状态增减 ±1~2)。
 */
export function detectMonotonicGrowth(
  series: readonly number[],
  opts: { minSamples?: number; jitter?: number } = {},
): boolean {
  const minSamples = opts.minSamples ?? 3
  const jitter = opts.jitter ?? 0
  if (series.length < minSamples) return false
  for (let i = 1; i < series.length; i++) {
    if (series[i] < series[i - 1]) return false
  }
  return series[series.length - 1] - series[0] > jitter
}

export interface SpikeSummary {
  samples: number
  sessionRouteSamples: number
  singleMountViolations: number
  commandAccumulation: boolean
  terminalPanelAccumulation: boolean
}

/** 对(按时间序的)采样序列出结论 —— window.__req087Spike.summary() 的实现。 */
export function summarizeSamples(samples: readonly SpikeSample[]): SpikeSummary {
  const onSession = samples.filter((s) => s.sessionID !== undefined)
  return {
    samples: samples.length,
    sessionRouteSamples: onSession.length,
    singleMountViolations: onSession.filter((s) => !isSingleMount(s)).length,
    // 命令数在会话间合法波动 ±2(share/closableTab 等条件命令);超出且单调升 = 累积。
    commandAccumulation: detectMonotonicGrowth(
      onSession.map((s) => s.commandOptions),
      { minSamples: 3, jitter: 2 },
    ),
    terminalPanelAccumulation: detectMonotonicGrowth(
      onSession.map((s) => s.terminalPanels),
      { minSamples: 3, jitter: 0 },
    ),
  }
}

export function formatSample(s: SpikeSample): string {
  const sid = s.sessionID ? s.sessionID.slice(-8) : "-"
  return (
    `[req087-spike] path=${s.pathname} session=${sid} ` +
    `composer=${s.composersVisible}/${s.composersTotal} terminal=${s.terminalPanels} ` +
    `dock=${s.promptDocks} cmd=${s.commandOptions} sessionCmd=${s.sessionScopedCommands}`
  )
}
