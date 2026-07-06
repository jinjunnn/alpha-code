// REQ-040:「具体端口的本地 sidecar URL」判定。内嵌 sidecar 每次 listen(0) 随机新端口,故任何存下的
// 127.0.0.1/localhost/[::1]:PORT 默认服务器都必然陈旧 —— 冷启动会连死端口卡「无法连接到 Local Server」。
// REQ-042:谓词落 shared —— main(getDefaultServerUrl 丢弃+留痕+删键)与 renderer(getDefaultServer
// 纵深兜底)两个运行时世界都要用(ADR-006);纯函数零依赖。
export function isEphemeralLocalServerUrl(url: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+/i.test(url)
}
