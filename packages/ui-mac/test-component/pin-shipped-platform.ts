// `#777` —— 「这道门需要跑在本产品发布的平台上」的**显式声明**。
//
// 谁需要它:任何会走到生产平台闸的用例。生产侧 `ext-install-planner.ts` 有四处
//   `if (!manifest.compatibility.platforms.includes(deps.platform())) return { ok:false, … }`
// 而 `synthesizeManifest` 把 `platforms` 写死成 `["darwin","win32"]`(ADR-026 桌面双平台)。
// alpha-ci 跑 ubuntu ⇒ 这些用例在 CI 上量到的是「runner 不是发布平台」,不是它们要验的行为
// (实测报错原文:`platform linux not supported by this entry — refusing before any disk write`)。
//
// 为什么是 opt-in 而不是在 preload 里全局钉:**实测过全局钉,代价更大**。alpha-ci 上
// 全局 `process.platform = "darwin"` 让 14 个 renderer 文件整片挂在
// `Cannot find module @rollup/rollup-darwin-x64`(vite/rollup 按 process.platform 选原生
// 可选依赖,linux runner 上装的是 linux 那份),3752 pass 掉到 3625。
// 为了修 2 条而弄坏 14 个文件 = 把一处假红换成一片真红。
//
// **这是模拟,不是覆盖**:在 linux 内核上跑 darwin 分支,凡真正依赖 host 内核行为的东西
// 这一轮没有验到。所以它会把这句话打出来 —— 一道门可以降级,不许静默降级。
//
// 只钉 darwin、不钉 win32:`node:path` 在加载时按 `process.platform` 选分支,
// darwin 与 linux 同为 posix;钉 win32 会把路径语义整个改坏。

const SHIPPED_PLATFORMS = ["darwin", "win32"] as const

/**
 * host 不是发布平台时把 `process.platform` 钉到 `darwin`,并自陈本次是模拟。
 * host 本来就是发布平台时什么都不做(返回 false),调用方据此可以说清
 * 「平台这一半本次到底跑没跑到」。
 */
export function pinShippedPlatform(): boolean {
  if ((SHIPPED_PLATFORMS as readonly string[]).includes(process.platform)) return false
  const host = process.platform
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true, enumerable: true })
  console.log(
    `[alpha-test-env] host platform "${host}" is not one this product ships on (${SHIPPED_PLATFORMS.join("/")}); ` +
      `process.platform pinned to "darwin" for THIS FILE so the production install gate exercises a supported platform. ` +
      `PLATFORM SIMULATED this run; genuinely ${host}-specific behaviour is NOT covered.`,
  )
  return true
}

export { SHIPPED_PLATFORMS }
