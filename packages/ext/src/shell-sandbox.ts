// REQ-138 / #1075 — 用 sandbox-exec wrapper 把「引擎为工具派生的 shell」围进工作区。
//
// 基线:docs/architecture/2026-08-23-shell-sandbox-seam.md（PR #1072）。选定接缝 = C1:
// 在 @alpha-code/ext 的 config(cfg) hook 里把 `cfg.shell` **包住**(不是替换)成一个 Alpha
// wrapper,wrapper 内 `exec sandbox-exec -f <profile>` 再 exec 用户的真 shell。收编上游 0 行。
//
// ── 咽喉点(全称否定式落成有限判据)──────────────────────────────────────────────
// 「没有任何进程能写到工作区外」没有有限证据集。本模块把它改写成一条**有限**判据:
//   到达「工具派生子进程真正落盘」的唯一通路是 —— cfg.shell → 本 wrapper → sandbox-exec
//   加载 profile → 真 shell;profile 的 `(deny file-write*)` 之后只再放行一个**闭集**前缀
//   (WORKDIR 参数 + profile 内登记的固定前缀)。其余写入在内核层响亮失败(EPERM)。
// 于是判据 = ①cfg.shell 恒指向 wrapper(seam 测试)②闭集之外的写入落不了盘、闭集移除后
//   落得了盘(escape 测试正反两跑,真 sandbox-exec)。一次变异(改 profile / 拆 wrapper /
//   让 cfg.shell 指向别处)判得完。
//
// ── 不变量(基线 §3 + 父票 #1074)───────────────────────────────────────────────
// I1  wrapper 是 cfg.shell 唯一能解析到的 shell。装不上时**不回落裸 shell**:改指一个
//     deny stub(响亮拒绝、exit≠0、零执行),会话因此启动即失败可读,而不是静默无围栏执行。
// I2  可写前缀集合是**闭集**,唯一权威 = 本文件的 SEATBELT_PROFILE 常量。新增前缀必须改这里
//     (可 diff / 可 review),运行时不做字符串拼接产生新前缀。
// I3  判据永远是「文件是否落盘」,不是子进程 exit code(基线 §2.5:nohup 那条 exit 0 而未落盘)。
// I4  wrapper 对 argv **完全透传**(`"$@"`),不解析、不重写。基线 §2.2 已证 shell 工具的 argv
//     恒为 ["-c", cmd]、prompt 的为 ["-l","-c",script,"opencode",cwd];wrapper 一旦解释命令就是
//     在手写别人文法的替身。
//
// 平台:仅 darwin(sandbox-exec)。其余平台本接缝结构上不适用(基线 §4),wrapEngineShell
// 在非 darwin 上不动 cfg.shell。网络轴不在本票(见 #1077)。

import { basename, isAbsolute, join } from "node:path"

/**
 * seatbelt profile —— **可写集合的唯一权威(I2)**。
 *
 * ground truth(基线 §2.5 + #1075 本机 spike):`(allow default)` 保留读/exec/网络,
 * `(deny file-write*)` 关掉全部写,随后**只**放行闭集:
 *   - WORKDIR(运行时 `-D WORKDIR="$(pwd)"` 注入,= 引擎为该次调用设的 cwd = 工作区)
 *   - /private/tmp、/private/var/folders(系统临时目录;正常开发写入,基线 §2.8 误伤检查过)
 *   - /dev 的若干安全节点(null/stdout/stderr/tty/fd,否则重定向到 /dev/null 都会 EPERM)
 *
 * 实测(#1075):fence ON —— 写 ~ / 经 /bin/sh / 经 python3 / 经 node / 经 symlink 指向工作区外
 * / `echo >> ~` 追加,全部 EPERM 且**文件不落盘**;fence OFF(同语料换裸 zsh)—— 全部落盘。
 */
export const SEATBELT_PROFILE = `(version 1)
(allow default)
(deny file-write*)
(allow file-write*
  (subpath (param "WORKDIR"))
  (subpath "/private/tmp")
  (subpath "/private/var/folders")
  (literal "/dev/null")
  (literal "/dev/stdout")
  (literal "/dev/stderr")
  (literal "/dev/tty")
  (regex #"^/dev/fd/")
)
`

/**
 * wrapper —— 一行透传(I4)。它在**运行时**从环境读 profile 路径与真 shell:
 * 引擎 spawn 每个 shell 时把 `{ ...process.env }` 传下去,config hook 已把这两个变量写进
 * 引擎的 process.env,于是被 wrapper 继承。
 *
 * 失败方向全部安全(#1075 spike 实测):两个变量任一缺失 / profile 文件不存在 / 真 shell 为空,
 * sandbox-exec 直接 exit 64/65/71 且**零执行**(fail-closed at exec time)。
 */
export const WRAPPER_SCRIPT = `#!/bin/sh
exec /usr/bin/sandbox-exec -f "$ALPHA_SB_PROFILE" -D WORKDIR="$(pwd)" "$ALPHA_REAL_SHELL" "$@"
`

/**
 * deny stub —— **仅**在围栏装不上时(I1 的 fail-closed 分支)顶到 cfg.shell 上。
 * 它拒绝运行任何命令、打印可读错误、exit 78。绝不让会话落回裸 shell。
 */
export const DENY_SHELL_SCRIPT = `#!/bin/sh
echo "alpha-code: shell sandbox unavailable — refusing to run an unfenced shell (see engine logs)" >&2
exit 78
`

/** deny stub 的固定文件名(不取真 shell basename —— 它本就不该被当 shell 用)。 */
export const DENY_SHELL_BASENAME = "alpha-shell-denied"

/** profile 落点(相对 alpha global root)。 */
export const SANDBOX_DIRNAME = "sandbox"
export const PROFILE_BASENAME = "alpha-shell.sb"
/** wrapper / deny stub 落点目录(相对 alpha global root)。 */
export const BIN_DIRNAME = "bin"

/** darwin 默认 shell —— 与 `@opencode-ai/core` 的 `Shell.fallback()` 一致(基线 §2.1 实测)。 */
const DARWIN_FALLBACK_SHELL = "/bin/zsh"

/**
 * `@opencode-ai/core` META 里 `deny:true` 的名字 —— fish / nu。`Shell.ok()` 对它们返回 false,
 * `Shell.acceptable()` 于是回落到默认 shell。这里必须与之一致,否则 wrapper 命名会与
 * `Shell.args()` 的分支错位(基线 §2.4:命名错 ⇒ 丢 rc-sourcing 与 `cd -- "$1"`)。
 * 等价性由 shell-sandbox.test.ts 对着**真** core Shell 逐输入交叉验证。
 */
const DENIED_SHELL_NAMES = new Set(["fish", "nu"])

export type ShellResolveSeams = {
  /** 该绝对路径是否为一个存在的普通文件(= core `stat(file)?.isFile()`)。 */
  statIsFile: (path: string) => boolean
  /** 解析裸名字(= core `which`);解析不到返回 undefined。 */
  which: (name: string) => string | undefined
  /** `process.env.SHELL`(config hook 未设 shell 时的次选,= core `acceptable()` 的默认取值)。 */
  envShell: string | undefined
}

export type ResolvedRealShell = { path: string; basename: string }

function shellName(path: string): string {
  return basename(path).toLowerCase()
}

function isDenied(path: string): boolean {
  return DENIED_SHELL_NAMES.has(shellName(path))
}

/** darwin 版 `Shell.resolve`:绝对路径 ⇒ 是文件才用;裸名字 ⇒ which。 */
function resolveShellPath(file: string, seams: ShellResolveSeams): string | undefined {
  if (isAbsolute(file)) return seams.statIsFile(file) ? file : undefined
  return seams.which(file) ?? undefined
}

/**
 * 复刻 darwin 下 `Shell.acceptable(configShell)` 的选择,返回真 shell 的绝对路径与 basename。
 * shell **工具**(REQ-138 保护的主路径)用的正是 `Shell.acceptable`;prompt `!command` 用
 * `Shell.preferred`,二者仅在 config 指向 denied shell(fish/nu)时分叉,那种情况两者都回落默认。
 *
 * 为什么不直接 import core 的 Shell:它在模块顶层 import `FSUtil`(→ @effect/platform-node)与
 * `Flag`(→ effect),会把 ~1.7MB effect 图拉进本插件的自包含 bundle(ADR-006)。这里只需要
 * 「哪个真 shell + 它的 basename」这一小片纯逻辑,故窄复刻 + 对真 Shell 的等价性测试锚定。
 *
 * @param binDir 本 wrapper 的落点目录;真 shell 若解析进这里(config 被填了 wrapper 路径,
 *   或上一轮的内存残留)则丢弃、回落默认 —— 否则 wrapper 会 exec wrapper 自己造成无限自嵌套。
 */
export function resolveRealShell(
  configShell: string | undefined,
  binDir: string,
  seams: ShellResolveSeams,
): ResolvedRealShell {
  const candidate = configShell && configShell.trim() ? configShell : seams.envShell
  let real = DARWIN_FALLBACK_SHELL
  if (candidate && candidate.trim() && !isDenied(candidate)) {
    const resolved = resolveShellPath(candidate, seams)
    // 双重包裹防线:真 shell 落进本 wrapper 目录 ⇒ 用默认,绝不 exec 自己。
    if (resolved && !isInside(resolved, binDir)) real = resolved
  }
  return { path: real, basename: shellName(real) }
}

function isInside(path: string, dir: string): boolean {
  const d = dir.endsWith("/") ? dir : dir + "/"
  return path === dir || path.startsWith(d)
}

export type WrapEngineShellSeams = ShellResolveSeams & {
  mkdirSync: (path: string) => void
  writeFileSync: (path: string, data: string) => void
  chmodSync: (path: string, mode: number) => void
  platform: NodeJS.Platform
}

export type WrapEngineShellResult =
  | { fenced: true; shell: string; profile: string; realShell: string }
  | { fenced: false; shell: string; reason: string }

/**
 * config hook 的执行端:把 profile + wrapper 落到 alpha global root 下,把 wrapper 读的两个
 * 环境变量写进引擎 process.env,再把 `cfg.shell` **改指 wrapper**。每次配置加载都调一次
 * (幂等:同一份 profile / wrapper 反复写),因此用户手改 config 后下一次加载仍被重新包裹(AC3)。
 *
 * fail-closed(I1):任一步抛错 ⇒ 落一个 deny stub 并把 cfg.shell 指向它;deny stub 也落不下时
 * 退到 `/usr/bin/false`(darwin 恒有,当 shell 用时 `-c cmd` 被忽略、exit 1、零执行)。
 * **任何情况下 cfg.shell 都不会保留用户/裸 shell。**
 */
export function wrapEngineShell(
  cfg: { shell?: string },
  globalRoot: string,
  env: NodeJS.ProcessEnv,
  seams: WrapEngineShellSeams,
): WrapEngineShellResult {
  if (seams.platform !== "darwin") {
    // 本接缝仅 darwin 适用(基线 §4)。其余平台不动 cfg.shell —— 那里没有 sandbox-exec,
    // 装了反而是「前提为假的闸门」(拒载真实配置)。网络/Windows/进程内 FS 都是别的轴。
    return { fenced: false, shell: cfg.shell ?? "", reason: "sandbox-exec seam is darwin-only" }
  }
  const binDir = join(globalRoot, BIN_DIRNAME)
  const sandboxDir = join(globalRoot, SANDBOX_DIRNAME)
  const profilePath = join(sandboxDir, PROFILE_BASENAME)
  try {
    const real = resolveRealShell(cfg.shell, binDir, seams)
    const wrapperPath = join(binDir, real.basename)
    seams.mkdirSync(sandboxDir)
    seams.writeFileSync(profilePath, SEATBELT_PROFILE)
    seams.mkdirSync(binDir)
    seams.writeFileSync(wrapperPath, WRAPPER_SCRIPT)
    seams.chmodSync(wrapperPath, 0o755)
    // wrapper 在 exec 时读这两个变量;它们随 { ...process.env } 继承进每个被 spawn 的 shell。
    env.ALPHA_SB_PROFILE = profilePath
    env.ALPHA_REAL_SHELL = real.path
    cfg.shell = wrapperPath
    return { fenced: true, shell: wrapperPath, profile: profilePath, realShell: real.path }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const denyPath = join(binDir, DENY_SHELL_BASENAME)
    try {
      seams.mkdirSync(binDir)
      seams.writeFileSync(denyPath, DENY_SHELL_SCRIPT)
      seams.chmodSync(denyPath, 0o755)
      cfg.shell = denyPath
    } catch {
      // 连 deny stub 都落不下:退到系统恒有的 /usr/bin/false(name "false" ⇒ args ["-c",cmd]
      // ⇒ false 忽略参数、exit 1、零执行)。仍然 fail-closed,只是错误不如 deny stub 可读。
      cfg.shell = "/usr/bin/false"
    }
    return { fenced: false, shell: cfg.shell, reason }
  }
}
