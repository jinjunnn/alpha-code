// C24 renderer 安全策略的纯逻辑半边(electron-free,可单测):CORS 放宽范围判定 + CSP 文本。
// 注入时机(app.isPackaged / 平台闸 / ALPHA_CSP_DISABLE)在 windows.ts。
//
// 背景:此前对**所有**响应强注 `ACAO:*` → renderer 可读任意跨域响应,构成 token/会话数据 exfil
// 通道(册 §7b);收敛为「回环(sidecar HTTP/SSE/PTY)才放宽,win32 保持旧行为(WSL 远端)」。

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"])

export function isLoopbackUrl(value: string): boolean {
  if (!URL.canParse(value)) return false
  return LOOPBACK_HOSTS.has(new URL(value).hostname)
}

export function corsRelaxAllowed(url: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" || isLoopbackUrl(url)
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
  "connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:* http://[::1]:* ws://[::1]:*",
  "worker-src 'self' blob:",
  "media-src 'self' data: blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ")
