// 组件测试共享的 `window.api` 最小桩(`#1374`)。
//
// ── 为什么有这个文件 ──────────────────────────────────────────────────────────────
// 挂 composer 的四个 cases 文件(alpha-composer-model / new-session-workspace /
// session-second-send / use-projects)此前各写各的 `window.api` 桩。给 preload 面加一个
// 新能力就要手工找齐四处,漏一处**只有那一个文件红**,而红法长得像自己刚把代码改坏了
// (`#1353` 加 `moderation.check` 时漏掉 use-projects.cases.ts,实测就是这个形态)。
// 这里收成一份:**键集合(形状)由本文件单点权威**,而每个 cases 文件的**数据**
// (catalog / account / keys / auth)仍归它自己 —— 那些各文件本来就不同,合并它们是另一件事。
//
// ── 判据在哪 ─────────────────────────────────────────────────────────────────────
// `../src/preload/component-stub-parity.typecheck.ts`:`keyof ElectronAPI` 必须被本文件
// 的 `ProvidedKey`(编译器从下面那个对象**推出来**的,不是手抄的列表)与 `AbsentOnPurposeKey`
// 两者**恰好**覆盖。新增 preload 能力而这里没表态 ⇒ typecheck 红,并逐字点名那个键。
//
// ── 一条反直觉的纪律:缺席是语义,不是遗漏 ────────────────────────────────────────
// 生产 renderer 有若干处**用缺席做能力探测**:
//   · runtime-recovery.ts:29  `Boolean(window.api?.sidecarGeneration)`
//   · composer-autocomplete.tsx:141 `window.api?.ext`
//   · workspace-writable.ts:17 `window.api?.workspaceWriteProbe`
//   · startup-timeline.ts:25  `window.api?.startupTimeline`
// 所以本桩**不能**给未夹具化的键塞占位值、也不能用 Proxy 把未知键变成抛错 —— 那会把
// 上面几处的分支从「没有这个能力」翻成「有」,悄悄改掉四个文件里已经绿着的用例。
// 未提供的键一律保持 `undefined`;需要它在场的 cases 文件自己经 `extras` 注入。
import type { AccountSummary, AuthState, ElectronAPI } from "../src/preload/types"
import type { EffectiveCatalog, ProviderKeyStatus } from "../src/shared/alpha-model-types"

/** 只约束**顶层键名**属于真面,不约束各成员形状 —— 桩在成员一级本来就是残缺的。 */
type PreloadSurfaceShape = { [Key in keyof ElectronAPI]?: unknown }

/** 各 cases 文件自带的数据夹具(它们彼此不同,故不进本文件)。 */
export type PreloadStubData = {
  catalog: EffectiveCatalog
  account: AccountSummary | { error: string }
  providerKeys: ProviderKeyStatus
  auth: AuthState
}

/** 逐条覆盖桩的行为;不传 = 用下面的默认值。 */
export type PreloadStubOverrides = {
  catalog?: () => Promise<EffectiveCatalog>
  authGetState?: () => Promise<AuthState>
  authSubscribe?: (listener: (state: AuthState) => void) => () => void
  authStart?: () => Promise<void>
  accountSummary?: () => Promise<AccountSummary | { error: string }>
  keyStatus?: () => Promise<ProviderKeyStatus>
  providerAdd?: (input: unknown) => Promise<{ ok: true } | { ok: false; reason: string }>
  /** `#1397`:目录内供应商填 Key 的落点 —— 用例要能看见「保存究竟落在哪条 IPC 上」。 */
  providerSetKey?: (id: string, key: string) => Promise<{ ok: true } | { ok: false; reason: string }>
  /** REQ-160 AC2(`#1353`):composer 发送前问 main「这句话要不要拦」。默认不拦。 */
  moderationCheck?: (text: string) => Promise<boolean>
}

function createBaseStub(data: PreloadStubData, overrides: PreloadStubOverrides) {
  return {
    endpoints: async () => null,
    openLink: () => {},
    moderation: { check: overrides.moderationCheck ?? (async () => false) },
    models: { catalog: overrides.catalog ?? (async () => data.catalog) },
    auth: {
      getState: overrides.authGetState ?? (async () => data.auth),
      subscribe: overrides.authSubscribe ?? (() => () => {}),
      start: overrides.authStart ?? (async () => {}),
    },
    account: { summary: overrides.accountSummary ?? (async () => data.account) },
    providers: {
      keyStatus: overrides.keyStatus ?? (async () => data.providerKeys),
      add: overrides.providerAdd ?? (async () => ({ ok: true as const })),
      test: async () => ({ ok: true as const, ms: 1 }),
      setKey: overrides.providerSetKey ?? (async () => ({ ok: true as const })),
      remove: async () => ({ ok: true as const }),
      removeKey: async () => ({ ok: true as const }),
    },
  } satisfies PreloadSurfaceShape
}

/** 共享桩**提供**的 preload 能力 —— 由上面那个对象推出,抄不错也不会漂。 */
export type ProvidedKey = keyof ReturnType<typeof createBaseStub>

/**
 * 共享桩**刻意不提供**的 preload 能力。分三类,每一类的理由不同:
 *
 *  ① 组件用「缺席」做能力探测 —— 补上就改分支(见文件抬头那四处)。
 *  ② 按需由消费方经 `extras` 注入 —— 只有需要它的那个 cases 文件才该有它,
 *     因为它们的返回值就是那个文件的判据本体(workspace 那几条尤其)。
 *  ③ 挂 composer 的这四个文件根本到不了的面(设置页、扩展、云、终端、更新器……)。
 *
 * 新增 preload 能力时:要么写进上面的桩,要么加进这里并说明属于哪一类。
 * 两样都不做 ⇒ `component-stub-parity.typecheck.ts` 红并点名它。
 */
export type AbsentOnPurposeKey =
  // ① 缺席即语义:组件按「有没有这个键」分支
  | "sidecarGeneration"
  | "ext"
  | "workspaceWriteProbe"
  | "startupTimeline"
  // ② 按需由消费方经 extras 注入(返回值就是该文件的判据)
  | "workspaceDefaultDir"
  | "workspaceEnsureDefault"
  | "openDirectoryPicker"
  | "openPath"
  | "contracts"
  // ③ 这四个文件到不了的面
  | "killSidecar"
  | "recovery"
  | "installCli"
  | "awaitInitialization"
  | "wslServers"
  | "updater"
  | "consumeInitialDeepLinks"
  | "getDefaultServerUrl"
  | "setDefaultServerUrl"
  | "getDisplayBackend"
  | "setDisplayBackend"
  | "parseMarkdownCommand"
  | "checkAppExists"
  | "resolveAppPath"
  | "storeGet"
  | "storeSet"
  | "storeDelete"
  | "storeClear"
  | "storeKeys"
  | "storeLength"
  | "settings"
  | "extensionStorage"
  | "toolPolicy"
  | "getWindowCount"
  | "onMenuCommand"
  | "onDeepLink"
  | "acknowledgeDeepLinks"
  | "openFilePicker"
  | "readPickedFile"
  | "releasePickedFiles"
  | "saveFilePicker"
  | "popupAppMenu"
  | "readClipboardImage"
  | "writeClipboard"
  | "showNotification"
  | "getWindowFocused"
  | "setWindowFocus"
  | "showWindow"
  | "relaunch"
  | "appVersion"
  | "environment"
  | "surfaces"
  | "getZoomFactor"
  | "setZoomFactor"
  | "getPinchZoomEnabled"
  | "setPinchZoomEnabled"
  | "onPinchZoomEnabledChanged"
  | "onZoomFactorChanged"
  | "setTitlebar"
  | "runDesktopMenuAction"
  | "setBackgroundColor"
  | "exportDebugLogs"
  | "recordFatalRendererError"
  | "cloud"
  | "runArtifacts"
  | "htmlPreview"
  | "workspaceFile"
  | "railPreview"
  | "automations"

/** 造出桩对象;`extras` 是本 cases 文件独有的那几个键(类 ② / 文件自己的记录点)。 */
export function createPreloadStub(
  data: PreloadStubData,
  overrides: PreloadStubOverrides = {},
  extras: PreloadSurfaceShape = {},
): Record<string, unknown> {
  return { ...createBaseStub(data, overrides), ...extras }
}

/**
 * 装到 `window.api` 上。
 *
 * `configurable: true` 是四份旧桩共有的一条:整包跑时先跑的文件可能已经把 `window.api`
 * 定义过一次,不可配置的属性会让第二次 defineProperty 抛(单跑绿、整包红的那类假象)。
 */
export function installPreloadStub(
  data: PreloadStubData,
  overrides: PreloadStubOverrides = {},
  extras: PreloadSurfaceShape = {},
): void {
  Object.defineProperty(window, "api", {
    configurable: true,
    value: createPreloadStub(data, overrides, extras),
  })
}
