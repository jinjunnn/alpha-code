export function materializeCloudMcpConfig(url: string, secretRef: string) {
  return {
    type: "remote" as const,
    url,
    enabled: true,
    headers: { Authorization: `Bearer ${secretRef}` },
    oauth: false,
  }
}
