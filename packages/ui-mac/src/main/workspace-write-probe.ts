// REQ-159 `#1322`(AC2/AC3)—— 「这个工作区现在写得进去吗」的唯一判据:**由被围栏的引擎进程真写一次再删**。
//
// 为什么不能在 main 里判、也不能拿路径字符串比(`#1317` 实测,四种形状字符串判据必错):
//   · main **没有被围栏**(process-fence.md §1),在 main 里 `fs.writeFile` 探测恒答「可写」—— 那是假探针;
//   · `ws1extra`(前缀同但非路径分段)/ 软链出集合 / 软链进集合 / APFS 大小写 —— 字符串比较四种形状各错一边。
// 所以本模块分两半,与 sidecar-stop.ts 同一形制(一份合同,两侧共用,免得形状在两个包里各写一遍然后漂移):
//   · **合同**:main 用 `buildWriteProbeCommand` 写、sidecar 用 `parseWriteProbeCommand` 读;sidecar 用
//     `buildWriteProbeReply` 写、main 用 `parseWriteProbeReply` 读;`createWriteProbeRequester` 是 main 侧的
//     请求/应答簿记(超时与子进程退出都答「无法判断」,不猜)。
//   · **执行**:`runWorkspaceWriteProbe` 只在 sidecar 进程里被调(sidecar.ts 收到 write-probe 命令那一拍)。
//     它在目标目录写一个唯一名的临时文件再删掉。三种回答:
//       writable —— 写入并删除成功;
//       denied   —— 写被内核以 EPERM 拒绝(seatbelt 的拒绝就是这个码:process-fence-apply.test.ts B2 实测
//                   `outside: "error:EPERM"`,shell 里是 zsh 报的 `operation not permitted`);
//       unknown  —— 其它任何失败(目录不存在 / ENOTDIR / EACCES = 文件系统自己的权限位,不是围栏 / …)。
//     EACCES 刻意**不**算 denied:披露文案把原因归给沙箱并承诺「重启后即可」,对一个 mode 位不可写的目录
//     那两句都是假话 —— 拿不准就答 unknown,呈现层 unknown = 无标记(设计 §3.2「未知 ≠ 只读」)。
//
// AC3 的两条判据(workspace-write-probe.test.ts):
//   · 恒答「不可写」的替身在**集合内**臂被拒(它会把每个项目都标成只读);
//   · 恒答「可写」的替身(= 在 main 里跑的探针,bare 臂实测就是它)在**集合外**臂被拒。
//   真探针在真围栏下两臂都过。判据不写在生产代码里 —— 它是测试里的一段纯函数。
//
// 写盘登记(AC3 登记簿):本模块的 writeFileSync / rmSync 登记为 W1(工作区)—— 这是它**该**落的根;
// 「落不进」正是它要报告的事实,不是登记簿要掩盖的事实。

import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export type WorkspaceWriteProbeOutcome = "writable" | "denied" | "unknown"

export type WorkspaceWriteProbeResult = {
  outcome: WorkspaceWriteProbeOutcome
  /** 人读的原因(errno 码 / 超时 / 子进程状态)。呈现层不解析它,只进日志。 */
  detail?: string
}

/** main → sidecar。`id` 由 main 的请求簿分配,应答按它对号。 */
export type WorkspaceWriteProbeCommand = { type: "write-probe"; id: number; directory: string }

/** sidecar → main。 */
export type WorkspaceWriteProbeReply = { type: "write-probe-result"; id: number } & WorkspaceWriteProbeResult

const OUTCOMES: ReadonlySet<string> = new Set<WorkspaceWriteProbeOutcome>(["writable", "denied", "unknown"])

export function buildWriteProbeCommand(id: number, directory: string): WorkspaceWriteProbeCommand {
  return { type: "write-probe", id, directory }
}

/** fail-closed:形状不对就当没有(sidecar 不回、main 侧超时答 unknown),不带着半个命令去写。 */
export function parseWriteProbeCommand(value: unknown): WorkspaceWriteProbeCommand | undefined {
  if (!value || typeof value !== "object") return
  const command = value as Partial<WorkspaceWriteProbeCommand>
  if (command.type !== "write-probe") return
  if (typeof command.id !== "number" || !Number.isSafeInteger(command.id)) return
  if (typeof command.directory !== "string" || command.directory.length === 0) return
  return { type: "write-probe", id: command.id, directory: command.directory }
}

export function buildWriteProbeReply(id: number, result: WorkspaceWriteProbeResult): WorkspaceWriteProbeReply {
  return { type: "write-probe-result", id, outcome: result.outcome, ...(result.detail ? { detail: result.detail } : {}) }
}

export function parseWriteProbeReply(value: unknown): WorkspaceWriteProbeReply | undefined {
  if (!value || typeof value !== "object") return
  const reply = value as Partial<WorkspaceWriteProbeReply>
  if (reply.type !== "write-probe-result") return
  if (typeof reply.id !== "number" || !Number.isSafeInteger(reply.id)) return
  if (typeof reply.outcome !== "string" || !OUTCOMES.has(reply.outcome)) return
  return {
    type: "write-probe-result",
    id: reply.id,
    outcome: reply.outcome as WorkspaceWriteProbeOutcome,
    ...(typeof reply.detail === "string" ? { detail: reply.detail } : {}),
  }
}

/** errno 码 → 三种回答。只有 EPERM 是围栏的拒绝;别的都不替围栏背书。 */
export function classifyWriteProbeError(code: string | undefined): WorkspaceWriteProbeOutcome {
  return code === "EPERM" ? "denied" : "unknown"
}

export type RunWorkspaceWriteProbeDeps = {
  writeFile?: (file: string, data: string) => void
  remove?: (file: string) => void
  stamp?: () => string
}

/**
 * 在 `directory` 下写一个唯一名的探针文件再删。**只许在 sidecar 进程里调** —— 在 main 里调恒答 writable,
 * 那不是探针,是假探针(AC3 判据会把它当场拒掉)。
 * `wx`:文件已存在算失败而不是覆盖 —— 探针永远不碰用户自己的文件。
 */
export function runWorkspaceWriteProbe(directory: string, deps: RunWorkspaceWriteProbeDeps = {}): WorkspaceWriteProbeResult {
  const stamp = deps.stamp ?? (() => `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const file = join(directory, `.alpha-write-probe-${stamp()}`)
  const writeFile = deps.writeFile ?? ((p, data) => writeFileSync(p, data, { flag: "wx" }))
  const remove = deps.remove ?? ((p) => rmSync(p, { force: true }))
  try {
    writeFile(file, "probe")
  } catch (error) {
    const code = errnoCode(error)
    return { outcome: classifyWriteProbeError(code), detail: `write ${code ?? "failed"}: ${messageOf(error)}` }
  }
  try {
    remove(file)
  } catch (error) {
    // 写得进但删不掉:对「这个项目写得进去吗」的回答仍是 writable;把残留说清楚,不吞。
    return { outcome: "writable", detail: `probe file left behind (${file}): ${messageOf(error)}` }
  }
  return { outcome: "writable" }
}

function errnoCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code
  return typeof code === "string" ? code : undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ── main 侧:请求/应答簿记 ───────────────────────────────────────────────────────────────

export const WRITE_PROBE_TIMEOUT_MS = 5_000

export type WriteProbeRequester = {
  /** 发一条探针请求;超时 / 子进程已退出 / 形状不对的应答 ⇒ 都答 unknown,并说清原因。 */
  request(directory: string): Promise<WorkspaceWriteProbeResult>
  /** 喂进 sidecar 的每一条 message;不是探针应答就原样忽略(返回 false)。 */
  receive(message: unknown): boolean
  /** 子进程退出:所有在途请求立刻答 unknown。之后的 request 不再发,直接答 unknown。 */
  close(reason: string): void
}

export function createWriteProbeRequester(
  post: (command: WorkspaceWriteProbeCommand) => void,
  options: { timeoutMs?: number } = {},
): WriteProbeRequester {
  const timeoutMs = options.timeoutMs ?? WRITE_PROBE_TIMEOUT_MS
  const pending = new Map<number, { settle: (result: WorkspaceWriteProbeResult) => void; timer: ReturnType<typeof setTimeout> }>()
  let seq = 0
  let closed: string | undefined
  const settle = (id: number, result: WorkspaceWriteProbeResult) => {
    const entry = pending.get(id)
    if (!entry) return false
    pending.delete(id)
    clearTimeout(entry.timer)
    entry.settle(result)
    return true
  }
  return {
    request(directory) {
      if (closed) return Promise.resolve({ outcome: "unknown", detail: closed })
      const id = ++seq
      return new Promise<WorkspaceWriteProbeResult>((resolve) => {
        const timer = setTimeout(() => settle(id, { outcome: "unknown", detail: `no reply from the engine within ${timeoutMs}ms` }), timeoutMs)
        pending.set(id, { settle: resolve, timer })
        try {
          post(buildWriteProbeCommand(id, directory))
        } catch (error) {
          settle(id, { outcome: "unknown", detail: `could not reach the engine: ${messageOf(error)}` })
        }
      })
    },
    receive(message) {
      const reply = parseWriteProbeReply(message)
      if (!reply) return false
      return settle(reply.id, { outcome: reply.outcome, ...(reply.detail ? { detail: reply.detail } : {}) })
    },
    close(reason) {
      closed = reason
      for (const id of [...pending.keys()]) settle(id, { outcome: "unknown", detail: reason })
    },
  }
}
