// REQ-159 (`#1321`) —— 引擎进程围栏的可写集:**唯一权威**。
//
// 引擎 sidecar 在 import 引擎之前把自己关进 seatbelt(sidecar.ts → process-fence-apply.ts),之后它
// 派生的一切(shell 工具 / MCP stdio / LSP / PTY / formatter …)自动继承(勘破 §6.2 五条原语实测)。
// 围栏装上之后**不能加宽**(勘破 §6.5),所以可写集必须在 apply 之前一次定好 —— 就是本文件渲染的这份。
//
// ── 行的来源:勘破 §8.2 的 19 行,逐字照抄,不照 §7.6 ──────────────────────────────
// §8.2 是「跑通过的 profile」(装了 ext 的引擎在围栏里跑完五步工作负载),§7.6 是「写入面枚举」;
// 两者差两条,其中 zsh 存历史走 `.zsh_history.new` 再改名 —— 照 §7.6 原文立闸,用户每开一次终端
// 看一条 `failed to write history file`。逐行消融结论(§8.2 表):W2/W3/W4/W5/W6/W15 去掉引擎/注入/
// 终端直接死,W7 去掉 **静默**(provider 装不上而 health 仍 200),W8 去掉每开终端一条报错;
// W11–W14 / W16–W18 本轮**未证伪 ≠ 可删**,删减各自要实测(基线 I1)。本文件不做那个判定。
//
// ── 与 REQ-138 那层的关系:替换,不叠加 ─────────────────────────────────────────────
// 嵌套 seatbelt 只在编译后策略完全相同时放行,否则 `sandbox_apply: Operation not permitted`、exit 71、
// 零执行(§6.5;§8.4 经真引擎 → 真工具 → 真 wrapper 量到:HTTP 200 而零执行)。所以 ext 的
// `wrapEngineShell`(cfg.shell → sandbox-exec wrapper)与本围栏**同一次变更**拆装(基线 I2)。
// ext 不再碰 cfg.shell 的判据在 packages/ext/src/alpha-ext-no-shell-layer.test.ts。
//
// ── 本文件只渲染字符串,不落盘、不读 store、不跑 sandbox-exec ──────────────────────────
// 工作区并集的来源 / 试编译 / 落盘在 process-fence-plan.ts;试编译本体在 process-fence-compile.ts;
// 加载原生模块与 apply 在 process-fence-apply.ts。分层是为了让每一层各自可测:这里的判据是
// 「渲染出的 profile 逐 token 等于 §8.2 的形状」(process-fence-profile.test.ts)。
//
// ── 不要手写 `(subpath …)` 的 TypeScript 替身 ────────────────────────────────────────
// U2 裁决 §5.2 实测 seatbelt 的 subpath 按路径分段、解析软链、随卷的大小写策略匹配,字符串
// 谓词在三处说谎。本文件里凡是「这个目录在不在可写集里」的问题都不回答;唯一例外是并集的
// **排除**规则(HOME / 根 / HOME 的祖先),那是「拒绝该输入」而不是「解释它的文法」。

import { isAbsolute, join, relative, resolve, sep } from "node:path"

/**
 * 可写集的行 id(勘破 §8.2 的编号,W9 在那一轮就不存在)。process-fence-write-sites.tsv 的每一条
 * 写盘登记都要点名它落在哪一行之下;点不出来的写入点 = 新的写入根 = 要么加行(带实测)要么改代码。
 */
export const WRITABLE_ROOT_IDS = {
  W1: "工作区(启动时并集,每个工作区一条 subpath)",
  W2: "<alphaGlobalRoot> = <appData>/alpha-code-state/env/<env>",
  W3: "<userDataPath>(含 alpha-engine-config/**、opencode/locks/**、engine-scratch-cwd)",
  W4: "<XDG_DATA_HOME>/opencode:上游引擎 log / *.db / -wal / -shm / repos",
  W5: "<XDG_CACHE_HOME>/opencode:bin / models.json / packages",
  W6: "<XDG_CONFIG_HOME>/opencode:第二份 provider 安装(勘破 §7.4 坑一)",
  W7: "<HOME>/.npm:@npmcli/arborist 的 cacache,不随 XDG",
  W8: "<HOME>/.zsh_history*(regex):登录 shell 存历史含 .zsh_history.new(§8.5 坑一)",
  W10: "<HOME>/.zsh_sessions:生产接线到不了(§8.6),留着无害",
  W11: "/private/tmp",
  W12: "/private/var/folders($TMPDIR)",
  W13: "/dev/null /dev/stdout /dev/stderr",
  W14: "/dev/tty ^/dev/fd/",
  W15: "/dev/ptmx ^/dev/ttys:PTY 靠它(§6.4)",
  W16: "<HOME>/.opencode:§7.6 B 段的桥",
  W17: "<HOME>/Library/Caches/bun(dev-only)",
  W18: "<HOME>/.cache/bun(dev-only)",
  W19: "<HOME>/.zcompdump*(regex):加了也不生效(§8.5 坑二),留着如实",
} as const
export type WritableRootId = keyof typeof WRITABLE_ROOT_IDS

/** 引擎自己解析出的四个根 —— 与 packages/core/src/global.ts 经 xdg-basedir 的取法逐字同形。 */
export type EngineRoots = {
  home: string
  dataHome: string
  cacheHome: string
  configHome: string
}

/**
 * xdg-basedir@5.1.0 的取法(packages/core/src/global.ts:3 就是从它 import 的):
 * `env.XDG_*_HOME || join(homedir, …)`。这里镜像它而不是 import 它,因为 main 进程不带 core 的
 * effect 图;等价性由 process-fence-profile.test.ts 对着 node_modules 里**那份** xdg-basedir 逐输入交叉验证。
 * `env` 必须是 **sidecar 将拿到的 env**(createSidecarEnv 的输出),不是 main 自己的 process.env ——
 * 白名单放行 XDG_ 前缀,所以两者对这几个键相同,但判据要键在被消费的那一份上。
 */
export function resolveEngineRoots(env: Record<string, string | undefined>, homeDir: string): EngineRoots {
  const pick = (key: string, fallback: string[]) => {
    const raw = env[key]
    return raw && raw.length > 0 ? raw : join(homeDir, ...fallback)
  }
  return {
    home: homeDir,
    dataHome: pick("XDG_DATA_HOME", [".local", "share"]),
    cacheHome: pick("XDG_CACHE_HOME", [".cache"]),
    configHome: pick("XDG_CONFIG_HOME", [".config"]),
  }
}

export type ProcessFenceProfileInput = {
  /** W1:启动时并集,顺序即优先级(裁剪从尾部丢)。 */
  workspaces: readonly string[]
  alphaGlobalRoot: string
  userDataPath: string
  /**
   * 引擎的 state 根 —— sidecar.ts 把 XDG_STATE_HOME 设成 `process.env.XDG_STATE_HOME ?? userDataPath`,
   * 这里消费同一个决定:等于 userDataPath 时已在 W3 之下,不另出一行;用户显式导出别处时多一行 W3。
   */
  stateHome: string
  roots: EngineRoots
}

/** seatbelt 字符串字面量里我们**不解释**转义:含引号 / 反斜杠 / 控制字符的路径直接拒绝(fail-closed)。 */
export function assertSeatbeltSafePath(p: string, what: string): string {
  if (!isAbsolute(p)) throw new Error(`process fence: ${what} must be absolute, got ${JSON.stringify(p)}`)
  if (/["\\\u0000-\u001f\u007f]/.test(p)) throw new Error(`process fence: ${what} contains characters seatbelt literals cannot carry: ${JSON.stringify(p)}`)
  return p
}

/** 只有 HOME 会进 regex 行。把正则元字符转义掉,免得 `/Users/j.doe` 的 `.` 变成「任意一个字符」。 */
function regexLiteral(p: string): string {
  return p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * 渲染 profile —— 勘破 §8.2 的 19 行,参数已代入(不用 `(param …)`:sidecar 里 `sandbox_init` 不带
 * 参数表,而且把根写死进文本才能让「试编译的」与「apply 的」是同一串字节)。
 * 顺序、注释 id 与 §8.2 一致,便于对照;注释在编译期被剥离,不影响策略(§6.5 第 9 行实测)。
 */
export function renderProcessFenceProfile(input: ProcessFenceProfileInput): string {
  const ws = input.workspaces.map((w, i) => assertSeatbeltSafePath(w, `workspace[${i}]`))
  const alphaGlobalRoot = assertSeatbeltSafePath(input.alphaGlobalRoot, "alphaGlobalRoot")
  const userDataPath = assertSeatbeltSafePath(input.userDataPath, "userDataPath")
  const home = assertSeatbeltSafePath(input.roots.home, "HOME")
  const dataHome = assertSeatbeltSafePath(input.roots.dataHome, "XDG_DATA_HOME")
  const cacheHome = assertSeatbeltSafePath(input.roots.cacheHome, "XDG_CACHE_HOME")
  const configHome = assertSeatbeltSafePath(input.roots.configHome, "XDG_CONFIG_HOME")
  const stateHome = assertSeatbeltSafePath(input.stateHome, "XDG_STATE_HOME")
  const homeRe = regexLiteral(home)

  const lines: string[] = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    "(allow file-write*",
    ...ws.map((w) => `  (subpath "${w}")                                  ; W1`),
    `  (subpath "${alphaGlobalRoot}")                          ; W2`,
    `  (subpath "${userDataPath}")                             ; W3`,
    ...(stateHome === userDataPath ? [] : [`  (subpath "${join(stateHome, "opencode")}")               ; W3 (XDG_STATE_HOME)`]),
    `  (subpath "${join(dataHome, "opencode")}")               ; W4`,
    `  (subpath "${join(cacheHome, "opencode")}")               ; W5`,
    `  (subpath "${join(configHome, "opencode")}")               ; W6`,
    `  (subpath "${join(home, ".npm")}")                                ; W7`,
    `  (regex #"^${homeRe}/\\.zsh_history")                       ; W8`,
    `  (subpath "${join(home, ".zsh_sessions")}")                       ; W10`,
    `  (regex #"^${homeRe}/\\.zcompdump")                         ; W19`,
    `  (subpath "/private/tmp")                               ; W11`,
    `  (subpath "/private/var/folders")                       ; W12`,
    `  (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr")   ; W13`,
    `  (literal "/dev/tty") (regex #"^/dev/fd/")              ; W14`,
    `  (literal "/dev/ptmx") (regex #"^/dev/ttys")            ; W15`,
    `  (subpath "${join(home, ".opencode")}")                           ; W16`,
    `  (subpath "${join(home, "Library", "Caches", "bun")}")                  ; W17`,
    `  (subpath "${join(home, ".cache", "bun")}")                       ; W18`,
    ")",
  ]
  return lines.join("\n") + "\n"
}

// ── W1:启动时并集 ────────────────────────────────────────────────────────────────
//
// U2 裁决(`#1317`)定了「取并集、封顶、按最近使用序」,把 K 与排序留给了本票。这里定的规则:
//
//   1. `~/code-puppy` 恒在集合首位(ADR-025 默认对话目录;renderer 重载后的启动草稿恒落在它上面,
//      不在集合里 = 每次重启后落地即不可写)。
//   2. 其后按 `tabs.recent.key` 指向的那个目录 → `tabs` 数组顺序(draft tab 的裸 directory)→
//      `tabs.info` 的插入顺序(session tab 的 directory)。`tabs.recent` 是 store 里唯一的「最近」
//      信号(tabs.tsx:67),数组顺序是 tab 栏顺序 —— 没有更细的 LRU,本票不造一个。
//   3. 只认本地引擎的 tab(`server === "sidecar"`,与 catalog-liveness.ts 同一判据):wsl:/ssh:/URL
//      的目录属于别的引擎,本围栏罩不到它们。
//   4. 只收**绝对路径且盘上存在的目录**。不存在的路径编译得过(U2 §2.2 pad 臂),但它们是历史垃圾
//      (本机真实读数里就有一条 `$TMPDIR` 下的旧测试目录),白占字节;不代建(ADR-025「绝不代建」)。
//   5. 排除 `/`、HOME、HOME 的任何祖先。放行 HOME = 没有围栏(U2 §4 表「不定价」的那一行)。
//      用户若真把家目录当项目打开,走披露面(基线 §五 子票 4),不靠放宽。
//   6. 去重后取前 K = MAX_WORKSPACES(32)。本机真实读数 99 个 tab 收敛成 5 个目录(U2 §2.3),
//      32 是 6 倍余量;它不是字节上限(那道墙在 65 535 字节且单位没有精确刻画),只是让试编译的
//      循环有界、日志可读。字节上限由 trimUntilCompiles 用真编译器判(process-fence-compile.ts)。
export const MAX_WORKSPACES = 32

export const LOCAL_SIDECAR_SERVER_KEY = "sidecar"

export type WorkspaceUnionSources = {
  /** `opencode.global.dat` 的 `tabs`(JSON 字符串或裸数组)。 */
  tabs: unknown
  /** `opencode.global.dat` 的 `tabs.recent`。 */
  recent: unknown
  /** `opencode.global.dat` 的 `tabs.info`。 */
  info: unknown
}

export type WorkspaceUnionInput = {
  sources: WorkspaceUnionSources
  /** `~/code-puppy`(alphaUserWorkspaceDir());调用方负责 ensureUserWorkspaceDir。 */
  defaultWorkspace: string
  homeDir: string
  /** 盘上是否为目录(fs.statSync(p).isDirectory());调用方注入,便于测试。 */
  isDirectory: (p: string) => boolean
  maxWorkspaces?: number
}

export type WorkspaceExclusion = { directory: string; reason: string }
/** `candidates` = 去重后的绝对路径候选数(含被排除的),给日志用。 */
export type WorkspaceUnion = { selected: string[]; excluded: WorkspaceExclusion[]; candidates: number }

function parseStoreValue(raw: unknown): unknown {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw)
    } catch {
      return undefined
    }
  }
  if (raw !== null && typeof raw === "object") return raw
  return undefined
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

/** 按 store 形状取出候选目录,保持「最近 → tab 栏顺序 → info 顺序」。 */
export function workspaceCandidatesFromStore(sources: WorkspaceUnionSources): string[] {
  const out: string[] = []
  const tabs = parseStoreValue(sources.tabs)
  const info = parseStoreValue(sources.info)
  const recent = parseStoreValue(sources.recent)
  const infoDir = (key: string): string | undefined => {
    if (!isRecord(info)) return undefined
    const entry = info[key]
    return isRecord(entry) && typeof entry.directory === "string" ? entry.directory : undefined
  }
  const draftDir = (draftID: string): string | undefined => {
    if (!Array.isArray(tabs)) return undefined
    const draft = tabs.find((t) => isRecord(t) && t.type === "draft" && t.draftID === draftID)
    return isRecord(draft) && draft.server === LOCAL_SIDECAR_SERVER_KEY && typeof draft.directory === "string" ? draft.directory : undefined
  }
  // ① 最近的那个 tab
  if (isRecord(recent) && typeof recent.key === "string" && recent.key.length) {
    const key = recent.key
    if (key.startsWith("draft:")) {
      const d = draftDir(key.slice("draft:".length))
      if (d) out.push(d)
    } else if (key.startsWith(`${LOCAL_SIDECAR_SERVER_KEY}\n`)) {
      const d = infoDir(key)
      if (d) out.push(d)
    }
  }
  // ② tab 栏顺序:draft tab 带裸 directory;session tab 经 info 查
  if (Array.isArray(tabs)) {
    for (const t of tabs) {
      if (!isRecord(t)) continue
      if (t.type === "draft") {
        if (t.server === LOCAL_SIDECAR_SERVER_KEY && typeof t.directory === "string") out.push(t.directory)
        continue
      }
      if (typeof t.server === "string" && t.server === LOCAL_SIDECAR_SERVER_KEY && typeof t.sessionID === "string") {
        // session tabKey = `${server}\n${sessionHref}`(app/src/context/tabs.tsx);这里不重算 href,
        // 而是让 ③ 按 info 的插入顺序兜住 —— 少一条 LRU 精度,不手写别人的 key 文法。
        continue
      }
    }
  }
  // ③ info 里全部本地引擎的 session tab
  if (isRecord(info)) {
    for (const [key, entry] of Object.entries(info)) {
      if (!key.startsWith(`${LOCAL_SIDECAR_SERVER_KEY}\n`)) continue
      if (isRecord(entry) && typeof entry.directory === "string") out.push(entry.directory)
    }
  }
  return out
}

function isAncestorOrSelf(ancestor: string, p: string): boolean {
  const rel = relative(ancestor, p)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/** 并集选择(规则见上)。返回值里 `excluded` 逐条给理由,给 main 日志用。 */
export function selectWorkspaceUnion(input: WorkspaceUnionInput): WorkspaceUnion {
  const max = input.maxWorkspaces ?? MAX_WORKSPACES
  const home = resolve(input.homeDir)
  const root = resolve(sep)
  const selected: string[] = []
  const excluded: WorkspaceExclusion[] = []
  const seen = new Set<string>()
  const candidates = [input.defaultWorkspace, ...workspaceCandidatesFromStore(input.sources)]
  for (const raw of candidates) {
    if (typeof raw !== "string" || !isAbsolute(raw)) {
      excluded.push({ directory: String(raw), reason: "not an absolute path" })
      continue
    }
    const dir = resolve(raw)
    if (seen.has(dir)) continue
    seen.add(dir)
    if (dir === root || isAncestorOrSelf(dir, home)) {
      // `/`、HOME、HOME 的祖先:放行它等于没有围栏。
      excluded.push({ directory: dir, reason: "would put HOME inside the writable set (fence would be void)" })
      continue
    }
    if (!input.isDirectory(dir)) {
      excluded.push({ directory: dir, reason: "not a directory on disk" })
      continue
    }
    if (selected.length >= max) {
      excluded.push({ directory: dir, reason: `beyond MAX_WORKSPACES=${max}` })
      continue
    }
    selected.push(dir)
  }
  return { selected, excluded, candidates: seen.size }
}

// ── 试编译封顶 ───────────────────────────────────────────────────────────────────
//
// seatbelt 编译有一道硬墙:`data object length … exceeds maximum (65535)`,单位是编译后数据对象的
// 字节,**没有精确刻画**(220 字符 × 340 条 = 74 513 B 仍通过而工具报 76 413;U2 §6)。所以不许靠算:
// 用**真编译器**试一次,失败就从并集尾部丢一个工作区再试,直到通过;丢到只剩 `~/code-puppy`(并集首位,
// 不可丢)仍失败 ⇒ 抛出 —— 这是 fail-closed 到「引擎不起」的那一档,而不是「少放几个工作区」:
// 到这一步说明失败原因不是并集大小,是别的(profile 语法 / 根路径异常),放行会是「前提为假的闸门」。

export type TrialCompile = (profile: string) => { ok: true } | { ok: false; reason: string }

export type TrimResult = {
  profile: string
  workspaces: string[]
  /** 因编译失败被丢掉的工作区(尾部起),按丢弃顺序。 */
  dropped: string[]
  /** 试编译次数(≥ 1)。 */
  attempts: number
  /** 最后一次失败原因(仅当 dropped 非空时有意义)。 */
  lastFailure?: string
}

export function trimUntilCompiles(
  input: Omit<ProcessFenceProfileInput, "workspaces"> & { workspaces: readonly string[] },
  compile: TrialCompile,
): TrimResult {
  const workspaces = [...input.workspaces]
  const dropped: string[] = []
  let attempts = 0
  let lastFailure: string | undefined
  for (;;) {
    const profile = renderProcessFenceProfile({ ...input, workspaces })
    attempts++
    const result = compile(profile)
    if (result.ok) return { profile, workspaces, dropped, attempts, lastFailure }
    lastFailure = result.reason
    if (workspaces.length <= 1) {
      throw new Error(
        `process fence profile does not compile even with the minimum writable set (${workspaces.length} workspace, ${dropped.length} dropped, ${attempts} attempts): ${result.reason}`,
      )
    }
    dropped.push(workspaces.pop()!)
  }
}
