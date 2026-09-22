// `#1394`(REQ-159 `#1390` 第二步)—— 围栏可写集的**工作区清单**:真源在围栏写不到的地方,只有 main 写。
//
// ── 为什么要搬 ────────────────────────────────────────────────────────────────────
// 围栏在每次 fork 前按「用户最近打开过哪些项目」算 W1(process-fence-profile.ts selectWorkspaceUnion)。
// 那份清单此前直接来自 `<userData>/opencode.global.dat`(electron-store,无 schema)的三个 tab 键 —— 而 `<userData>`
// 整棵是可写根 W3,**被围栏的引擎树自己写得了**。往里塞一条 `{type:"draft", server:"sidecar", directory:"~/Library/LaunchAgents"}`,
// 下次启动那个目录就可写(放个 plist 进去 = 开机自启)。`#1390` 第一步只把「与应用状态根相关」的候选排除掉,护住了我们自己的目录;
// 主目录下别的目录仍能被同一手法点名。本文件关掉这条:**围栏的输入不再是围栏可写的文件**。
//
// ── 真源在哪、长什么样 ──────────────────────────────────────────────────────────
// `<appData>/alpha-code-state/fence-workspaces/<env>.json`。父目录 `<appData>/alpha-code-state` 是 alpha-environment.ts 冻结快照的
// `casBaseRoot`,三个 env 根与 `cas/` 的父目录:W2 只放行它之下的 `env/<env>`,W3 是 `<userData>`(另一棵树),其余 17 行都不覆盖它
// (`#1383` 基线 §1.1/§1.2 逐行核过;W1 那一行由 `#1390` 的规则 5b 兜住:与状态根相关的候选一律不进可写集)。`cas/` 已经是
// 「main 写、引擎只读」的先例,这里是同一形状。按 env 分文件:prod / beta / dev 的 tab store 本来就各在各的 `<userData>`。
// 内容:`{ "v": 1, "workspaces": ["<绝对路径>", …] }`,顺序 = recent → tab 栏 → info(与 workspaceCandidatesFromStore 同序,试编译撞墙从尾丢)。
// 写:先写临时文件再 rename(原子)。读:**严格** —— 不是这个形状(版本不对 / 不是数组 / 有相对路径 / 非字符串)整份拒,不猜、不修;
// planner 拿不到清单退到只有 `~/code-puppy`(process-fence-plan.ts 既有的 fail-closed 语义),并出声。
//
// ── 谁写、什么时候写 ───────────────────────────────────────────────────────────────
// ① 首次启动(文件不存在):从 electron store 播种一次 —— 那一刻的可写集与今天(`#1390` 之后)逐字等价,不引入新风险;日志一行可见。
// ② 之后:只经 renderer → `store-set` / `store-delete` / `store-clear` IPC → main(ipc.ts → 本文件的 tracker)。围栏内的进程到不了 IPC;
//    它能改的只有 `<userData>` 里那份 store 文件,而那份**从此不再喂给围栏**(server.ts 的 planner 只读本真源)。
//
// ── 检疫:为什么不能只做「IPC 来什么写什么」 ────────────────────────────────────────
// renderer 启动时从 store 恢复 tab(app/src/utils/persist.ts),伪造的那条也会被恢复成一个 tab;用户随后开/关任何 tab,renderer 把
// **整个** `tabs` 数组经 IPC 写回 —— 伪造条目就顺着合法通路进了真源,洞只是晚一次重启。所以 boot 时把「store 里有、真源里没有」的目录
// 记成本会话的**检疫名单**:它们永远不进真源,哪怕 renderer 原样写回;真源只按 renderer 报上来的状态增减**检疫名单之外**的目录。
// 代价如实:用户若真想打开一个恰好被检疫的目录,得先关掉那个(伪造的)tab、重启、再打开 —— 本机零租户,接受;日志点名被检疫的是哪几条。
//
// ── 真源解析失败(不是缺失)怎么办 ───────────────────────────────────────────────────
// 不改写、不重新播种,记一行原因;这一代 planner 退到默认工作区(fail-closed);renderer 下一次 tab 变更按当时状态把它重写好(检疫名单为空)。
// 理由:围栏内的进程写不到这个文件,「坏掉」不是攻击可达的状态,从 renderer 状态重建与首次播种同一信任;而永远锁在默认工作区会让用户
// 手动删文件才能恢复。
//
// electron-free:fs / 日志由 index.ts 与 server.ts 注入;本文件不 import electron,也不进 sidecar 的 import 闭包
// (process-fence-write-sites.test.ts 的集合自证会点名)。

import { dirname, isAbsolute, resolve } from "node:path"
import type { AppEnvironment } from "./alpha-environment"
import { workspaceCandidatesFromStore, type WorkspaceUnionSources } from "./process-fence-profile"
import { GLOBAL_RENDERER_STORE, TABS_INFO_KEY, TABS_KEY, TABS_RECENT_KEY } from "./tabs-preclean"

export const FENCE_WORKSPACES_DIRNAME = "fence-workspaces"
export const FENCE_WORKSPACE_TRUTH_VERSION = 1

/** `<casBaseRoot>/fence-workspaces/<env>.json` —— 与 `env/`、`cas/` 同级(见文件头)。 */
export function fenceWorkspaceTruthPath(casBaseRoot: string, environment: AppEnvironment): string {
  return resolve(casBaseRoot, FENCE_WORKSPACES_DIRNAME, `${environment}.json`)
}

export type WorkspaceTruthReadFs = { readFileSync: (path: string, encoding: "utf8") => string }
export type WorkspaceTruthWriteFs = {
  mkdirSync: (path: string, options: { recursive: true }) => unknown
  writeFileSync: (path: string, data: string) => void
  renameSync: (from: string, to: string) => void
  rmSync: (path: string, options: { force: true }) => void
}

export type WorkspaceTruthRead = { ok: true; workspaces: string[] } | { ok: false; absent: boolean; reason: string }

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? (error as { code: unknown }).code : undefined
}

/** 严格读:形状不对整份拒(原因可读),缺失单独标出来(播种只对缺失做)。 */
export function readWorkspaceTruth(path: string, fs: WorkspaceTruthReadFs): WorkspaceTruthRead {
  let text: string
  try {
    text = fs.readFileSync(path, "utf8")
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { ok: false, absent: true, reason: `absent: ${path}` }
    return { ok: false, absent: false, reason: `read failed: ${errorMessage(error)}` }
  }
  const unreadable = (reason: string): WorkspaceTruthRead => ({ ok: false, absent: false, reason: `${path}: ${reason}` })
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return unreadable(`not JSON (${errorMessage(error)})`)
  }
  if (!isRecord(parsed)) return unreadable("not a JSON object")
  if (parsed.v !== FENCE_WORKSPACE_TRUTH_VERSION) return unreadable(`unsupported version ${JSON.stringify(parsed.v)} (expected ${FENCE_WORKSPACE_TRUTH_VERSION})`)
  if (!Array.isArray(parsed.workspaces)) return unreadable("`workspaces` is not an array")
  const workspaces: string[] = []
  for (const [i, entry] of parsed.workspaces.entries()) {
    if (typeof entry !== "string" || !isAbsolute(entry)) return unreadable(`workspaces[${i}] is not an absolute path: ${JSON.stringify(entry)}`)
    workspaces.push(entry)
  }
  return { ok: true, workspaces }
}

/** planner 的依赖形态(process-fence-plan.ts readWorkspaces):拿不到就抛,planner 捕获后退到默认工作区并把原因写进日志。 */
export function readWorkspaceTruthOrThrow(path: string, fs: WorkspaceTruthReadFs): string[] {
  const read = readWorkspaceTruth(path, fs)
  if (!read.ok) throw new Error(`workspace truth ${read.reason}`)
  return read.workspaces
}

let tmpSeq = 0

/** 原子写:临时文件 + rename;父目录不在就建(`fence-workspaces/` 本身不在 alpha-environment 的拓扑预检里)。 */
export function writeWorkspaceTruth(path: string, workspaces: readonly string[], fs: WorkspaceTruthWriteFs): void {
  fs.mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify({ v: FENCE_WORKSPACE_TRUTH_VERSION, workspaces: [...workspaces] }) + "\n")
    fs.renameSync(tmp, path)
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      // 临时文件留着无害;真正要报的是下面那个错
    }
    throw error
  }
}

/** renderer tab 状态 → 清单:与 planner 此前直接吃 store 时同一顺序(recent → tab 栏 → info),只留绝对路径,resolve 后去重。 */
export function workspacesFromRendererTabs(sources: WorkspaceUnionSources): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of workspaceCandidatesFromStore(sources)) {
    if (typeof raw !== "string" || !isAbsolute(raw)) continue
    const dir = resolve(raw)
    if (seen.has(dir)) continue
    seen.add(dir)
    out.push(dir)
  }
  return out
}

export type FenceWorkspaceTracker = {
  readonly truthPath: string
  /** 本会话的检疫名单(见文件头):store 里有、boot 时真源里没有的目录。 */
  readonly quarantined: readonly string[]
  /** ipc.ts `store-set`:写完 electron store 之后调用;不是 opencode.global.dat 的三个 tab 键一律忽略。 */
  noteRendererStoreSet(name: string, key: string, value: unknown): void
  /** ipc.ts `store-delete`。 */
  noteRendererStoreDelete(name: string, key: string): void
  /** ipc.ts `store-clear`。 */
  noteRendererStoreClear(name: string): void
}

export type BootFenceWorkspaceTruthInput = {
  truthPath: string
  /** electron store 里的三个 tab 键,由 index.ts 在 tier-1 预清之后读一次(之后本模块不再碰 store —— 它在 W3 之下)。 */
  store: WorkspaceUnionSources
  fs: WorkspaceTruthReadFs & WorkspaceTruthWriteFs
  log: (line: string) => void
}

const TAB_KEYS: Record<string, keyof WorkspaceUnionSources> = { [TABS_KEY]: "tabs", [TABS_RECENT_KEY]: "recent", [TABS_INFO_KEY]: "info" }

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/**
 * boot 一次:缺失 ⇒ 播种(日志一行);在 ⇒ 装载 + 算检疫名单;坏 ⇒ 不动它、出声。返回的 tracker 交给 ipc.ts。
 * 不抛:真源写不出去只影响下一代的可写集(planner fail-closed),不许炸 boot。
 */
export function bootFenceWorkspaceTruth(input: BootFenceWorkspaceTruthInput): FenceWorkspaceTracker {
  const { truthPath, fs, log } = input
  const state: WorkspaceUnionSources = { tabs: input.store.tabs, recent: input.store.recent, info: input.store.info }
  const fromStore = workspacesFromRendererTabs(state)
  const existing = readWorkspaceTruth(truthPath, fs)
  let current: string[]
  let quarantined: string[] = []
  if (existing.ok) {
    current = existing.workspaces
    quarantined = fromStore.filter((d) => !current.includes(d))
    log(`process fence: workspace truth loaded — ${current.length} workspace(s) from ${truthPath}`)
    if (quarantined.length)
      log(
        `process fence: ${quarantined.length} workspace(s) are in the renderer tab store but not in the workspace truth — quarantined for this session, they never enter the truth even if the renderer persists them back (#1394): ${quarantined.join(", ")}`,
      )
  } else if (existing.absent) {
    try {
      writeWorkspaceTruth(truthPath, fromStore, fs)
      current = fromStore
      log(
        `process fence: workspace truth seeded from the renderer tab store (first launch with #1394) — ${fromStore.length} workspace(s) written to ${truthPath}` +
          (fromStore.length ? `: ${fromStore.join(", ")}` : ""),
      )
    } catch (error) {
      current = []
      log(`process fence: FAILED to seed the workspace truth at ${truthPath} — the planner falls back to the default workspace only until the renderer's next tab change writes it: ${errorMessage(error)}`)
    }
  } else {
    current = []
    log(
      `process fence: workspace truth is unreadable — ${existing.reason}; leaving it untouched, the planner falls back to the default workspace only until the renderer's next tab change rewrites it`,
    )
  }
  const quarantine = new Set(quarantined)

  const recompute = () => {
    const next = workspacesFromRendererTabs(state).filter((d) => !quarantine.has(d))
    if (sameList(next, current)) return
    const added = next.filter((d) => !current.includes(d))
    const removed = current.filter((d) => !next.includes(d))
    try {
      writeWorkspaceTruth(truthPath, next, fs)
      current = next
      log(
        `process fence: workspace truth updated from the renderer tab store — ${next.length} workspace(s)` +
          (added.length ? `; added: ${added.join(", ")}` : "") +
          (removed.length ? `; removed: ${removed.join(", ")}` : "") +
          " (takes effect at the next engine generation)",
      )
    } catch (error) {
      log(`process fence: FAILED to write the workspace truth at ${truthPath} — the next engine generation keeps the previous list: ${errorMessage(error)}`)
    }
  }

  const tabKey = (name: string, key: string): keyof WorkspaceUnionSources | undefined =>
    name === GLOBAL_RENDERER_STORE ? TAB_KEYS[key] : undefined

  return {
    truthPath,
    quarantined,
    noteRendererStoreSet(name, key, value) {
      const field = tabKey(name, key)
      if (!field) return
      state[field] = value
      recompute()
    },
    noteRendererStoreDelete(name, key) {
      const field = tabKey(name, key)
      if (!field) return
      state[field] = undefined
      recompute()
    },
    noteRendererStoreClear(name) {
      if (name !== GLOBAL_RENDERER_STORE) return
      state.tabs = undefined
      state.recent = undefined
      state.info = undefined
      recompute()
    },
  }
}
