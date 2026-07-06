import type { WslServersState } from "@opencode-ai/app/wsl/types"

export function readyWslConnections(state?: WslServersState) {
  return (state?.servers ?? []).flatMap((item) => {
    if (item.runtime.kind !== "ready") return []
    return [
      {
        displayName: item.config.distro,
        label: "WSL",
        type: "sidecar" as const,
        variant: "wsl" as const,
        distro: item.config.distro,
        http: {
          url: item.runtime.url,
          username: item.runtime.username ?? undefined,
          password: item.runtime.password ?? undefined,
        },
      },
    ]
  })
}

// REQ-040:「具体端口的本地 sidecar URL」判定。内嵌 sidecar 每次 listen(0) 随机新端口,故任何存下的
// 127.0.0.1/localhost/[::1]:PORT 默认服务器都必然陈旧 —— 冷启动会连死端口卡「无法连接到 Local Server」。
// getDefaultServer 用它把陈旧默认丢弃、回退符号性 "sidecar"(始终指向当次 live sidecar)。
export function isEphemeralLocalServerUrl(url: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+/i.test(url)
}

export function availableStartupServer(defaultServer: string | null | undefined, state?: WslServersState) {
  const key = defaultServer ?? "sidecar"
  if (!key.startsWith("wsl:")) return key
  if (state?.servers.some((item) => item.config.id === key && item.runtime.kind === "ready")) return key
  return "sidecar"
}
