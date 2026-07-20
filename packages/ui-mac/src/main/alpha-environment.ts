// REQ-098 唯一环境映射(issue #190/#428)—— main 进程持有,renderer 零输入。
//
// App 运行环境(prod/beta/dev)只由两个构建事实推导:app.isPackaged + 构建渠道(OPENCODE_CHANNEL,
// 打包时冻结,ADR-012)。由环境单向派生三件事,任何消费方不得自行再推:
//   ① Registry 通道:prod → stable、beta → preview、dev → dev(preview 维持 ADR-012 休眠语义,
//      #232 拍板 B:机制对齐、不承诺发布);
//   ② updater feed channel:prod → latest(stable feed)、beta → beta(preview feed)、dev → 禁用;
//   ③ 环境 mutable root(可变状态分域):<appData>/alpha-code-state/env/{prod,beta,dev};
//      三根恒为兄弟,共享 CAS 落 <appData>/alpha-code-state/cas。
//
// initAlphaEnvironment 在任何根消费方之前校验三根的词法与 canonical 身份,创建新拓扑后复验
// endpoint 非 symlink 且 realpath 未漂移,最后才冻结快照并派生 ALPHA_GLOBAL_DIR。旧全局根不迁移、
// 不 dual-read；ALPHA_GLOBAL_DIR 不再接受外部预置。unpackaged 可用 ALPHA_ENV_BASE_DIR 做 base 级
// 隔离；packaged onboarding 只接受 composition root 传入的内部临时 base。
//
// electron-free:isPackaged/channel/appData 由 index.ts 注入,单测零 mock。

import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path"
import type { AlphaEnvironmentInfo } from "../preload/types"

export type AppEnvironment = "prod" | "beta" | "dev"
export type RegistryChannel = "stable" | "preview" | "dev"
export type BuildChannel = "dev" | "beta" | "prod"

export type { AlphaEnvironmentInfo }

// updater feed 只允许指向自有发布仓(B9:错 owner = 会把上游 OpenCode 当更新装回来)。
export const UPDATE_FEED_OWNER = "jinjunnn"
export const UPDATE_FEED_REPO = "alpha-code"

/** 环境判定:打包 + 渠道 → 环境;未打包一律 dev(开发运行)。 */
export function resolveAppEnvironment(input: { isPackaged: boolean; channel: BuildChannel }): AppEnvironment {
  if (!input.isPackaged) return "dev"
  if (input.channel === "prod") return "prod"
  if (input.channel === "beta") return "beta"
  return "dev"
}

/** prod → stable、beta → preview、dev → dev(REQ-098 交付①)。 */
export function registryChannelFor(env: AppEnvironment): RegistryChannel {
  if (env === "prod") return "stable"
  if (env === "beta") return "preview"
  return "dev"
}

/** electron-updater channel:prod → latest(stable feed)、beta → beta(preview feed)、dev → null(禁用)。 */
export function updaterFeedChannelFor(env: AppEnvironment): "latest" | "beta" | null {
  if (env === "prod") return "latest"
  if (env === "beta") return "beta"
  return null
}

/** 新共享基根；appDataDir 由 Electron composition root 注入。 */
export function defaultAlphaBaseRoot(appDataDir: string): string {
  return join(appDataDir, "alpha-code-state")
}

/** 三环境 mutable root 恒为兄弟。 */
export function environmentMutableRoot(env: AppEnvironment, baseRoot: string): string {
  return join(baseRoot, "env", env)
}

let current: AlphaEnvironmentInfo | undefined

export type InitEnvironmentInput = {
  isPackaged: boolean
  channel: BuildChannel
  /** Electron `app.getPath("appData")`；本模块不自行推导。 */
  appDataDir: string
  /** 默认 process.env；注入以便单测。 */
  env?: NodeJS.ProcessEnv
  /** 仅 composition root 内部生成的 base（packaged onboarding）；不读取环境变量。 */
  baseRoot?: string
  /** 仅用于退休根 denial；默认真实 home。 */
  homeDir?: string
}

/**
 * 启动早期调用一次；先完整校验并创建/复验新拓扑，随后才写派生 env 与冻结快照。
 */
export function initAlphaEnvironment(input: InitEnvironmentInput): AlphaEnvironmentInfo {
  if (current) return current
  const env = input.env ?? process.env
  if (env.ALPHA_GLOBAL_DIR !== undefined) throw new Error("external ALPHA_GLOBAL_DIR override is retired")
  if (input.isPackaged && env.ALPHA_ENV_BASE_DIR !== undefined)
    throw new Error("packaged builds refuse external alpha base overrides")
  if (input.baseRoot !== undefined && env.ALPHA_ENV_BASE_DIR !== undefined)
    throw new Error("multiple alpha base inputs are not allowed")

  const environment = resolveAppEnvironment(input)
  const externalBase = input.isPackaged ? undefined : env.ALPHA_ENV_BASE_DIR
  const requestedBase = input.baseRoot ?? externalBase ?? defaultAlphaBaseRoot(input.appDataDir)
  if (!requestedBase.trim() || !isAbsolute(requestedBase)) throw new Error("alpha base must be a non-empty absolute path")

  const lexicalBase = normalize(requestedBase)
  rejectTerminalSymlink(lexicalBase, "alpha base")
  const lexicalRoots = environmentRoots(lexicalBase)
  assertSiblingRoots(Object.values(lexicalRoots), "lexical")
  assertOutsideRetiredRoot([lexicalBase, ...Object.values(lexicalRoots)], input.homeDir ?? homedir(), false)

  const baseRoot = prospectiveCanonical(lexicalBase)
  const roots = environmentRoots(baseRoot)
  const canonicalRoots = {
    dev: prospectiveCanonical(roots.dev),
    prod: prospectiveCanonical(roots.prod),
    beta: prospectiveCanonical(roots.beta),
  }
  assertSiblingRoots(Object.values(canonicalRoots), "canonical")
  assertOutsideRetiredRoot([baseRoot, ...Object.values(canonicalRoots)], input.homeDir ?? homedir(), true)

  const directories = [baseRoot, join(baseRoot, "env"), ...Object.values(canonicalRoots), join(baseRoot, "cas")]
  directories.forEach((directory) => mkdirSync(directory, { recursive: true }))
  directories.forEach((directory) => assertCanonicalDirectory(directory, directory))

  const mutableRoot = canonicalRoots[environment]
  env.ALPHA_GLOBAL_DIR = mutableRoot
  current = Object.freeze({
    environment,
    registryChannel: registryChannelFor(environment),
    buildChannel: input.channel,
    packaged: input.isPackaged,
    mutableRoot,
    casBaseRoot: baseRoot,
    rootOverridden: input.baseRoot !== undefined || externalBase !== undefined,
    updaterFeedChannel: updaterFeedChannelFor(environment),
  })
  return current
}

/** main 消费方的唯一根解析：快照优先；无快照只接受显式、绝对且不指向退休根的派生输出。 */
export function resolveAlphaGlobalRoot(env: NodeJS.ProcessEnv = process.env, homeDir: string = homedir()): string {
  if (current) return current.mutableRoot
  const raw = env.ALPHA_GLOBAL_DIR?.trim()
  if (!raw || !isAbsolute(raw)) throw new Error("ALPHA_GLOBAL_DIR requires an absolute initialized root")
  assertOutsideRetiredRoot([normalize(raw)], homeDir, false)
  const canonical = prospectiveCanonical(raw)
  assertOutsideRetiredRoot([canonical], homeDir, true)
  return canonical
}

/** 高风险批次入口调用：冻结的 base、三环境根与 CAS endpoint 身份必须仍然完全一致。 */
export function assertAlphaEnvironmentIdentity(): void {
  const info = getAlphaEnvironment()
  const roots = environmentRoots(info.casBaseRoot)
  ;[info.casBaseRoot, ...Object.values(roots), join(info.casBaseRoot, "cas")].forEach((root) =>
    assertCanonicalDirectory(root, root),
  )
  if (roots[info.environment] !== info.mutableRoot) throw new Error("frozen alpha root mapping changed")
}

function environmentRoots(baseRoot: string): Record<AppEnvironment, string> {
  return {
    dev: environmentMutableRoot("dev", baseRoot),
    prod: environmentMutableRoot("prod", baseRoot),
    beta: environmentMutableRoot("beta", baseRoot),
  }
}

function assertCanonicalDirectory(directory: string, expected: string): void {
  try {
    const stat = lstatSync(directory)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("endpoint is not a real directory")
    if (normalize(realpathSync(directory)) !== normalize(expected)) throw new Error("canonical identity drifted")
  } catch {
    throw new Error("alpha root identity cannot be confirmed")
  }
}

function prospectiveCanonical(input: string): string {
  const suffix: string[] = []
  let cursor = normalize(input)
  while (true) {
    try {
      lstatSync(cursor)
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw new Error("alpha root identity cannot be confirmed", { cause: error })
      const parent = dirname(cursor)
      if (parent === cursor) throw new Error("alpha root identity cannot be confirmed", { cause: error })
      suffix.push(basename(cursor))
      cursor = parent
      continue
    }
    try {
      if (suffix.length > 0 && !statSync(cursor).isDirectory()) throw new Error("existing ancestor is not a directory")
      return resolve(realpathSync(cursor), ...suffix.reverse())
    } catch {
      throw new Error("alpha root identity cannot be confirmed")
    }
  }
}

function rejectTerminalSymlink(directory: string, label: string): void {
  try {
    if (lstatSync(directory).isSymbolicLink()) throw new Error(`${label} cannot be a symlink`)
  } catch (error) {
    if (errorCode(error) === "ENOENT") return
    throw error
  }
}

function errorCode(error: unknown): unknown {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined
  return error.code
}

function assertSiblingRoots(roots: string[], kind: string): void {
  for (const root of roots)
    for (const other of roots)
      if (root !== other && related(root, other)) throw new Error(`${kind} environment roots overlap`)
  if (new Set(roots).size !== roots.length) throw new Error(`${kind} environment roots alias`)
}

function assertOutsideRetiredRoot(candidates: string[], homeDir: string, canonical: boolean): void {
  const retiredLexical = normalize(join(homeDir, ".alpha"))
  const retired = canonical ? retiredCanonical(retiredLexical, homeDir) : retiredLexical
  if (candidates.some((candidate) => related(normalize(candidate), retired)))
    throw new Error("alpha root is related to the retired global root")
}

function retiredCanonical(retiredRoot: string, homeDir: string): string {
  try {
    return normalize(realpathSync(retiredRoot))
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw new Error("retired alpha root identity cannot be confirmed", { cause: error })
    return join(prospectiveCanonical(homeDir), ".alpha")
  }
}

function related(left: string, right: string): boolean {
  return sameOrInside(left, right) || sameOrInside(right, left)
}

function sameOrInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

export function getAlphaEnvironment(): AlphaEnvironmentInfo {
  if (!current) throw new Error("alpha environment not initialized (initAlphaEnvironment must run at boot)")
  return current
}

/** 非抛出变体:main 进程消费者用它读取冻结根;未初始化(纯单测 / sidecar 进程)返回 undefined,
 *  调用方退回 process.env(REQ-098 #301:冻结快照是 main 的单一真源)。 */
export function tryGetAlphaEnvironment(): AlphaEnvironmentInfo | undefined {
  return current
}

/** catalog 拉取通道的**唯一权威取值点**(REQ-098 #302,review #364 接线缝):恒等于冻结快照的
 *  registryChannel。composition root 必须经此取值传给 refreshRemoteCatalog —— 不得另行推导或
 *  写死字面量;未初始化即抛(fail-fast,catalog 拉取不允许发生在环境解析之前)。 */
export function catalogRegistryChannel(): RegistryChannel {
  return getAlphaEnvironment().registryChannel
}

/** 仅测试:重置单例。生产代码不得调用 —— 环境一经解析在进程生命周期内不可变。 */
export function __resetAlphaEnvironmentForTests(): void {
  current = undefined
}

// ── T4:updater feed 对齐校验(AC#2 loud-fail 判定核)─────────────────────────────────────────
// 三侧一致:构建发布 channel(app-update.yml,electron-builder publish 配置落盘)/ 运行时检查
// channel(autoUpdater.channel)/ 环境映射(updaterFeedChannelFor)。任何不一致 = 错误 feed 映射,
// 调用方必须 loud-fail(禁用 updater + 显式报错),绝不带错 feed 去 update-check。

export type PackagedFeed = { provider?: string; owner?: string; repo?: string; channel?: string }

export type FeedVerdict = { ok: true } | { ok: false; reason: string }

export function verifyUpdaterFeed(input: {
  environment: AppEnvironment
  /** 运行时将要请求的 channel(autoUpdater.channel)。 */
  runtimeChannel: string
  /** 打包内 app-update.yml 解析结果;null = 无发布元数据可核(本地 dir 构建)→ 只核运行时映射。 */
  packaged: PackagedFeed | null
}): FeedVerdict {
  const expected = updaterFeedChannelFor(input.environment)
  if (expected === null) {
    return { ok: false, reason: `dev environment must not update-check (runtime channel: ${input.runtimeChannel})` }
  }
  if (input.runtimeChannel !== expected) {
    return {
      ok: false,
      reason: `runtime channel "${input.runtimeChannel}" != "${expected}" required by environment "${input.environment}"`,
    }
  }
  const packaged = input.packaged
  if (packaged) {
    if (packaged.owner !== undefined && packaged.owner !== UPDATE_FEED_OWNER) {
      return { ok: false, reason: `packaged feed owner "${packaged.owner}" != "${UPDATE_FEED_OWNER}" (wrong-owner feed, B9)` }
    }
    if (packaged.repo !== undefined && packaged.repo !== UPDATE_FEED_REPO) {
      return { ok: false, reason: `packaged feed repo "${packaged.repo}" != "${UPDATE_FEED_REPO}"` }
    }
    // electron-builder 对 channel=latest 可能省略该键 —— 缺省 = latest 语义,只在显式声明时比对。
    if (packaged.channel !== undefined && packaged.channel !== expected) {
      return {
        ok: false,
        reason: `packaged feed channel "${packaged.channel}" != "${expected}" required by environment "${input.environment}"`,
      }
    }
  }
  return { ok: true }
}

/** app-update.yml 的极简行解析(只取 provider/owner/repo/channel 四个标量键,不引 yaml 依赖)。 */
export function parseAppUpdateYml(text: string): PackagedFeed {
  const out: PackagedFeed = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^(provider|owner|repo|channel):\s*(.+?)\s*$/.exec(line)
    if (!m) continue
    const value = m[2].replace(/^['"]|['"]$/g, "")
    out[m[1] as keyof PackagedFeed] = value
  }
  return out
}
