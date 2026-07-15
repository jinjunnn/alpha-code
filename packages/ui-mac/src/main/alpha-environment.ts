// REQ-098 唯一环境映射(issue #190)—— main 进程持有,renderer 零输入。
//
// App 运行环境(prod/beta/dev)只由两个构建事实推导:app.isPackaged + 构建渠道(OPENCODE_CHANNEL,
// 打包时冻结,ADR-012)。由环境单向派生三件事,任何消费方不得自行再推:
//   ① Registry 通道:prod → stable、beta → preview、dev → dev(preview 维持 ADR-012 休眠语义,
//      #232 拍板 B:机制对齐、不承诺发布);
//   ② updater feed channel:prod → latest(stable feed)、beta → beta(preview feed)、dev → 禁用;
//   ③ 环境 mutable root(可变状态分域):prod → <base>/env/prod、beta → <base>/env/beta、
//      dev → <base>(= 旧单根 ~/.alpha 原样 —— 开发者人体工学:dev 构建/单测直接看到既有全局目录,
//      不迁移;测试隔离照旧走 ALPHA_GLOBAL_DIR 预置)。base = ~/.alpha(ADR-019 全局层)。
//
// 落地机制:initAlphaEnvironment 在启动早期(任何 alphaGlobalRoot() 消费方之前)把环境 root 写进
// process.env.ALPHA_GLOBAL_DIR —— 全部既有消费方(alpha-installs / engine-config-truth / ext-config /
// sidecar 注入 / @alpha-code/ext)按现有惯例读同一变量,零重接线。预置的 ALPHA_GLOBAL_DIR(测试
// 隔离 / 开发者显式 export,shell-env 缓存已把它列为会话级控制键)= 终态覆盖,本模块不改写、只记账。
//
// 内容寻址不可变 blob(REQ-102)未来落 <base> 共享层,不在本 REQ;当前所有可变状态一律分域。
// electron-free:isPackaged/channel 由 index.ts 注入,单测零 mock。

import * as os from "node:os"
import * as path from "node:path"
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

/** `~/.alpha` 基根(homeDir 可注入,单测用)。 */
export function defaultAlphaBaseRoot(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".alpha")
}

/** 环境 mutable root:prod/beta 分域进 <base>/env/<env>;dev = 旧单根原样(见文件头拍板)。 */
export function environmentMutableRoot(env: AppEnvironment, baseRoot: string): string {
  if (env === "dev") return baseRoot
  return path.join(baseRoot, "env", env)
}

let current: AlphaEnvironmentInfo | undefined

export type InitEnvironmentInput = {
  isPackaged: boolean
  channel: BuildChannel
  /** 默认 process.env;注入以便单测。ALPHA_GLOBAL_DIR 预置 = 覆盖,只读不改写。 */
  env?: NodeJS.ProcessEnv
  /** 默认 os.homedir();注入以便单测。 */
  homeDir?: string
}

/**
 * 启动早期调用一次;此后环境快照冻结,任何运行期输入(含 renderer)都改变不了它(AC#6)。
 * 副作用:未被覆盖时把环境 root 写入 env.ALPHA_GLOBAL_DIR(消费方 + sidecar fork 继承同一根)。
 */
export function initAlphaEnvironment(input: InitEnvironmentInput): AlphaEnvironmentInfo {
  if (current) return current
  const env = input.env ?? process.env
  const environment = resolveAppEnvironment(input)
  const baseRoot = defaultAlphaBaseRoot(input.homeDir)
  const override = env.ALPHA_GLOBAL_DIR?.trim()
  const mutableRoot = override || environmentMutableRoot(environment, baseRoot)
  // 兼容读源(迁移 source)= 旧单根布局。覆盖态下一切都在覆盖根里(测试隔离语义:无旧布局可导)。
  const legacyRoot = override || baseRoot
  if (!override) env.ALPHA_GLOBAL_DIR = mutableRoot
  current = Object.freeze({
    environment,
    registryChannel: registryChannelFor(environment),
    buildChannel: input.channel,
    packaged: input.isPackaged,
    mutableRoot,
    legacyRoot,
    // 共享 CAS 基根(REQ-102 #317):CAS 落 <casBaseRoot>/cas,prod/beta/dev 共享去重(blob 不可变、
    // 按 digest 寻址,跨环境共享无污染面);语义独立于 legacyRoot(迁移只读 source)——当前同值是
    // 布局事实,不是耦合契约。覆盖态(测试隔离)一切进覆盖根。
    casBaseRoot: override || baseRoot,
    rootOverridden: Boolean(override),
    updaterFeedChannel: updaterFeedChannelFor(environment),
  })
  return current
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
