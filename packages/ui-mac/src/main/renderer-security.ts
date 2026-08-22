// C24 renderer 安全策略的纯逻辑半边(electron-free,可单测):CORS 放宽范围判定 + CSP 文本。
// 注入时机(app.isPackaged / 平台闸 / ALPHA_CSP_DISABLE)在 windows.ts。
//
// 背景:此前对**所有**响应强注 `ACAO:*` → renderer 可读任意跨域响应,构成 token/会话数据 exfil
// 通道(册 §7b);收敛为「回环(sidecar HTTP/SSE/PTY)才放宽」。
//
// #898(SEC):win32 此前额外短路成 `platform === "win32" || isLoopbackUrl(url)` —— 短路项在前,
// 意味着 win32 上**任何** URL(含恶意页面/被顶替扩展代码指向的任意跨域站点)都会拿到
// `Access-Control-Allow-Origin: *`,loopback 判据形同虚设。收窄为:main 进程持有的内存态
// registered-origin 集合(见 AlphaOriginRegistry)——只有 main 真正启动并验证过的确切 Alpha
// 服务 origin(按 generation 登记)才在有效期内命中;未注册的 origin 一律默认拒绝。registry
// 实例只存活在 main 进程模块闭包内,从不经 preload/contextBridge/IPC 暴露写入口,renderer 与
// 扩展代码结构上无法自行注册。darwin 分支的回环判据逐字节不变。

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"])

export function isLoopbackUrl(value: string): boolean {
  if (!URL.canParse(value)) return false
  return LOOPBACK_HOSTS.has(new URL(value).hostname)
}

/**
 * main-owned、generation 绑定的 registered-origin 集合(#898)。`register`/`revoke` 只应由
 * main 进程内已经真正启动并做过健康检查的服务生命周期代码调用(例如内嵌 sidecar / WSL 远端
 * sidecar 的启动与退出路径)——本模块本身不做任何 IPC/preload 暴露,调用方是否暴露它是调用方
 * 的责任,但当前仓库内没有任何 preload/ipc 通道引用它。
 *
 * generation 由调用方提供(不是内部自增时钟):`revoke(origin, generation)` 只在传入的
 * generation 与登记时一致才会真正删除条目。这样「服务已退出、收尾 revoke 姗姗来迟」不会误删
 * 「同一 origin(端口复用)已被新一代服务重新 register 过」的条目 —— 新 register 直接覆盖 Map
 * 条目为新 generation,旧 generation 的迟到 revoke 天然比对不上而失效。
 */
export type AlphaOriginRegistry = {
  register(origin: string, generation: number): void
  revoke(origin: string, generation: number): void
  isRegistered(origin: string): boolean
}

export function createAlphaOriginRegistry(): AlphaOriginRegistry {
  const origins = new Map<string, number>()
  return {
    register(origin, generation) {
      origins.set(origin, generation)
    },
    revoke(origin, generation) {
      if (origins.get(origin) === generation) origins.delete(origin)
    },
    isRegistered(origin) {
      return origins.has(origin)
    },
  }
}

export function corsRelaxAllowed(
  url: string,
  platform: NodeJS.Platform = process.platform,
  registry?: Pick<AlphaOriginRegistry, "isRegistered">,
): boolean {
  if (isLoopbackUrl(url)) return true
  // #898:win32 不再对任意 URL 短路放行 —— 只有 main 登记过的确切 origin(非回环)才放宽。
  // 没有传 registry(默认参数)或 origin 未登记 ⇒ 默认拒绝,与 darwin 的「只回环」一样保守。
  if (platform !== "win32") return false
  if (!URL.canParse(url)) return false
  return registry?.isRegistered(new URL(url).origin) ?? false
}

// connect-src 收敛到 self + 回环;img-src 放行 https(会话 markdown 远程图,GET-only 面已知且
// 接受);script-src self + wasm-unsafe-eval(ghostty-web 终端是 WASM,缺它打包态终端无法编译;
// index.html 无内联脚本);object/frame 全禁。
export const RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  // data: 必须放行:ghostty 终端的 WASM 经 fetch("data:application/wasm;base64,…") 加载,拦掉
  // 即「连接已丢失/Failed to fetch WASM」(2026-07-04 打包走查实抓);data: 是内联内容,无外传面。
  "connect-src 'self' data: http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:* http://[::1]:* ws://[::1]:*",
  "worker-src 'self' blob:",
  "media-src 'self' data: blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ")
