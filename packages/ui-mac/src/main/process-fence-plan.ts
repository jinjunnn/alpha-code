// REQ-159 (`#1321`) —— main 侧:在 fork sidecar 之前把这一代的围栏**计划**做出来。
//
// 计划 = { profile(已试编译通过的全文), addonPath(原生模块绝对路径), 并集/丢弃/排除的账 }。
// 它经 StartCommand 交给 sidecar,sidecar 在 import 引擎之前原样 apply(process-fence-apply.ts)。
// 为什么在 main 做而不在 sidecar 做:并集来源是 main 独占的东西 —— `#1394` 起是围栏写不到的真源文件
// (process-fence-workspaces.ts;此前是 main 自己的 electron store,U2 §2.3 —— 那份在 W3 之下、被围栏的引擎写得了,
// `#1390` / `#1394` 关掉了这条);试编译失败要在 fork **之前** fail-closed(拒绝这一代,原因可读),而不是让 sidecar 起来再死。
//
// electron-free:清单读取、根解析、fs 都由 server.ts 注入,
// 于是本模块可以在 bun 里对着假清单 / 假 fs / 假编译器跑判据(process-fence-plan.test.ts),
// 而真编译器与真 profile 的判据各自在 process-fence-compile.test.ts / process-fence-profile.test.ts。
//
// ── 父目录必须由未被围栏的一方预先建好(勘破 §6.3.1 第 3 条)────────────────────────
// `(subpath "<X>/.local/share/opencode")` 放行的是该目录**之下**;`<X>/.local/share` 不存在时,
// 被围栏的引擎 `mkdir -p` 会在父层 EPERM —— 而 packages/core/src/global.ts 在**模块装载时**就
// mkdir 四个根(data/config/state/tmp/log/bin/repos)。所以 main 在这里把 W4/W5/W6/W7 建好;
// W2/W3 由 main 的 boot 序早已建好;`~/code-puppy` 走 ensureUserWorkspaceDir(唯一的 lazy 供给点)。
// **刻意不建** W16(`~/.opencode`:engine-config-truth 对它有 junk-only 判定,凭空建一个会改行为)、
// W10/W17/W18(生产到不了 / dev-only)。

import { join } from "node:path"
import { resolveFenceAddonPath, type FenceAddonResolveInput } from "./process-fence-apply"
import {
  resolveEngineRoots,
  selectWorkspaceUnion,
  trimUntilCompiles,
  type EngineRoots,
  type TrialCompile,
  type WorkspaceExclusion,
} from "./process-fence-profile"

export type ProcessFencePlan = {
  profile: string
  addonPath: string
  workspaces: string[]
  dropped: string[]
  excluded: WorkspaceExclusion[]
  attempts: number
  profileBytes: number
  roots: EngineRoots & { alphaGlobalRoot: string; userDataPath: string; stateHome: string }
}

export type PlanProcessFenceInput = {
  userDataPath: string
  /** createSidecarEnv() 的输出 —— XDG_* / HOME 从**这一份**取,它才是引擎将看到的 env。 */
  sidecarEnv: Record<string, string | undefined>
  addon: FenceAddonResolveInput
  /**
   * REQ-137 `#1337`:main 进程内策略代理**已经在听**的 loopback 端口(server.ts 在调用本函数之前起好)。
   * 渲染进 profile 的 N4 行;没有它就没有计划(fail-closed)。
   */
  egressProxyPort: number
}

export type PlanProcessFenceDeps = {
  homeDir: () => string
  alphaGlobalRoot: () => string
  /** `#1390`:应用状态根 `<appData>/alpha-code-state`(冻结环境快照的 casBaseRoot);来自 store 的候选与它相关即排除。 */
  appStateRoot: () => string
  /** `#1390`:路径归一,生产必须是 `fs.realpathSync.native`(理由见 process-fence-profile.ts WorkspaceUnionInput.realpath)。 */
  realpath: (p: string) => string
  /** `~/code-puppy`,已 ensure(ensureUserWorkspaceDir 返回 null 时给 alphaUserWorkspaceDir 让并集判它不存在)。 */
  defaultWorkspace: () => string
  /**
   * `#1394`:工作区清单(绝对路径,顺序即优先级),来自围栏写不到的真源(process-fence-workspaces.ts),不再是 electron store。
   * 拿不到(缺失 / 解析失败)就抛,原因可读;planner 捕获后退到只有默认工作区并出声 —— 拿不到清单 ≠ 什么都可写。
   */
  readWorkspaces: () => readonly string[]
  isDirectory: (p: string) => boolean
  mkdirp: (p: string) => void
  compile: TrialCompile
  log: (line: string) => void
}

export function planProcessFence(input: PlanProcessFenceInput, deps: PlanProcessFenceDeps): ProcessFencePlan {
  if (process.platform !== "darwin") throw new Error("process fence plan is darwin-only")
  const home = deps.homeDir()
  const roots = resolveEngineRoots(input.sidecarEnv, home)
  // sidecar.ts:prepareSidecarEnv 把 XDG_STATE_HOME 设成 `process.env.XDG_STATE_HOME ?? userDataPath`。
  // 这里消费同一个决定:用户显式导出的 state 根跟着走,否则 locks 就在 W3 之下。
  const stateHome = input.sidecarEnv.XDG_STATE_HOME && input.sidecarEnv.XDG_STATE_HOME.length > 0 ? input.sidecarEnv.XDG_STATE_HOME : input.userDataPath
  const alphaGlobalRoot = deps.alphaGlobalRoot()

  // 父目录预建(见文件头)。
  for (const dir of [
    join(roots.dataHome, "opencode"),
    join(roots.cacheHome, "opencode"),
    join(roots.configHome, "opencode"),
    join(home, ".npm"),
    ...(stateHome === input.userDataPath ? [] : [join(stateHome, "opencode")]),
  ]) {
    deps.mkdirp(dir)
  }

  let candidates: readonly string[]
  try {
    candidates = deps.readWorkspaces()
  } catch (error) {
    // 真源缺失 / 坏了不许炸 boot;并集退到只有 `~/code-puppy`(收紧方向,fail-closed),但必须出声。
    deps.log(`process fence: workspace truth unavailable — workspace union falls back to the default workspace only: ${error instanceof Error ? error.message : String(error)}`)
    candidates = []
  }
  const union = selectWorkspaceUnion({
    candidates,
    defaultWorkspace: deps.defaultWorkspace(),
    homeDir: home,
    appStateRoot: deps.appStateRoot(),
    realpath: deps.realpath,
    isDirectory: deps.isDirectory,
  })
  if (union.selected.length === 0)
    throw new Error("process fence: the default workspace is not a directory on disk — refusing to fork an engine that could not write anywhere a user expects")

  const trimmed = trimUntilCompiles(
    { workspaces: union.selected, alphaGlobalRoot, userDataPath: input.userDataPath, roots, stateHome, egressProxyPort: input.egressProxyPort },
    deps.compile,
  )
  const addonPath = resolveFenceAddonPath(input.addon)
  const plan: ProcessFencePlan = {
    profile: trimmed.profile,
    addonPath,
    workspaces: trimmed.workspaces,
    dropped: trimmed.dropped,
    excluded: union.excluded,
    attempts: trimmed.attempts,
    profileBytes: Buffer.byteLength(trimmed.profile),
    roots: { ...roots, alphaGlobalRoot, userDataPath: input.userDataPath, stateHome },
  }
  deps.log(
    `process fence planned: workspaces=${plan.workspaces.length} (candidates=${union.candidates}, excluded=${plan.excluded.length}, dropped=${plan.dropped.length}), egressProxyPort=${input.egressProxyPort}, profile=${plan.profileBytes}B, compile attempts=${plan.attempts}` +
      (plan.dropped.length ? ` — dropped (oldest first): ${[...plan.dropped].reverse().join(", ")}; last compiler error: ${trimmed.lastFailure}` : "") +
      (plan.excluded.length ? ` — excluded: ${plan.excluded.map((e) => `${e.directory} (${e.reason})`).join("; ")}` : ""),
  )
  return plan
}
